/**
 * Merchant administration dialogs (bridge.js + bridge-merchants.js):
 * - Review an application: approve (PATCH status ACTIVE, then PUT /merchants/:id/package when another package is
 *   chosen), reject with a reason (POST /merchants/:id/reject), request more information (POST …/request-info).
 * - An account: status (PATCH /merchants/:id; suspending asks first), the service package (changed on Service plans
 *   & pricing), addresses and serving hub, KYC and the internal notes (GET/POST /merchants/:id/notes).
 * - Invite a merchant (POST /merchants/invites), the invitations (GET, DELETE /merchants/invites/:id).
 * - KYC: the review queue, a merchant's documents and the decision, the KYC policy.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { useAuth } from "@panel/lib/auth";
import { confirm, openCustom, openForm } from "@panel/ui/dialogs";
import { Button, Pill } from "@panel/ui/kit";
import { Select } from "@panel/ui/Select";
import { toast, toastError } from "@panel/ui/toast";
import { queryClient } from "@panel/lib/queryClient";
import { addressText } from "@panel/lib/format";
import { editMerchantAddress } from "./merchantAddress";
import { DialogFrame, Facts, packageLabel, phoneText, STATUS_LABEL, TYPE_LABEL, whenFull, dateOf, type Merchant, type MerchantType, type Place } from "@/lib/admin";

const reload = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["admin", "merchants"] }), queryClient.invalidateQueries({ queryKey: ["admin", "overview"] }), queryClient.invalidateQueries({ queryKey: ["admin", "audit"] })]);

function useCanManage() {
  const { user } = useAuth();
  const perms = (user as { permissions?: string[] } | null)?.permissions;
  return !!user && (perms ? perms.includes("merchant:manage") : true);
}

// ───────────── addresses (shared/merchant-address.js summaryHtml) ─────────────
const TIMES: Record<string, string> = { MORNING: "Morning (9am–12pm)", MIDDAY: "Midday (12pm–3pm)", AFTERNOON: "Afternoon (3pm–6pm)" };
const HANDOVER: Record<string, string> = { RIDER_PICKUP: "Rider pickup", HUB_DROP: "Drop at hub" };
const placeText = (p?: Place | null) => (p ? addressText(p.street, p.area, p.zone, p.district) : "");
const mapLink = (p?: Place | null) => (p && p.lat != null && p.lng != null ? `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=17/${p.lat}/${p.lng}` : "");
const places = (p?: Place | null) => (p ? [p.area && p.area !== p.zone ? p.area : "", p.zone, p.district].filter(Boolean).join(" · ") : "");

export function AddressSummary({ m }: { m: Merchant }) {
  const pin = (p?: Place | null) =>
    mapLink(p) ? (
      <>
        {" · "}
        <a href={mapLink(p)} target="_blank" rel="noopener">
          Map ↗
        </a>
      </>
    ) : null;
  const other = (p?: Place | null) => (p?.areaOther ? <small style={{ color: "#b45309" }}> (area typed: not in the list)</small> : null);
  const rows: [string, React.ReactNode][] = [];
  if (m.businessCategory || m.websiteUrl) rows.push(["Business", [m.businessCategory, m.websiteUrl].filter(Boolean).join(" · ") || "—"]);
  rows.push([
    "Business address",
    m.business ? (
      <>
        {placeText(m.business)}
        {other(m.business)}
        {pin(m.business)}
      </>
    ) : (
      <span className="faint">Not given</span>
    ),
  ]);
  if (m.business && places(m.business)) rows.push(["Business area", places(m.business)]);
  const same = m.pickupSameAsBusiness && m.business;
  rows.push([
    "Pickup address",
    same ? (
      <>Same as business address{pin(m.pickup)}</>
    ) : (
      <>
        {placeText(m.pickup)}
        {other(m.pickup)}
        {pin(m.pickup)}
        {m.addressComplete === false ? <small style={{ color: "#b45309" }}> (free text: not matched to the area list yet)</small> : null}
      </>
    ),
  ]);
  if (!same && places(m.pickup)) rows.push(["Pickup area", places(m.pickup)]);
  rows.push(["Pickup contact", [m.pickupContactName || m.contactName, phoneText(m.pickupContactPhone || m.contactPhone)].filter(Boolean).join(" · ")]);
  rows.push(["Pickup time", TIMES[m.pickupTime ?? ""] || "Not set"]);
  rows.push(["Handover", HANDOVER[m.handover ?? ""] || "Rider pickup"]);
  rows.push(["Serving hub", m.pickupHub ? `${m.pickupHub.name} (${m.pickupHub.code})${m.pickupHub.address ? ` · ${m.pickupHub.address}` : ""}${m.pickupHubFixed ? " · chosen by a super admin" : ""}` : <span style={{ color: "#b45309" }}>No hub serves this pickup zone yet</span>]);
  rows.push(["Route district", m.routeDistrict || m.pickupDistrict || "—"]);
  return <Facts rows={rows} />;
}

// ───────────── verification and account history ─────────────
interface Kyc {
  status: "NOT_SUBMITTED" | "PENDING" | "APPROVED" | "REJECTED";
  rejectionReason?: string | null;
  documents: { id: string; type: string; filename: string; uploadedAt: string; mimeType?: string }[];
  policy: { documentTypes: { type: string; label: string; required: boolean }[]; requireForApiKeys?: boolean; requireForCodPayouts?: boolean; requireForActivation?: boolean };
  history: { at: string; body: string; by?: string | null }[];
}
interface Note {
  id: string;
  author: string;
  at: string;
  kind: string;
  body: string;
}
const KYC_LABEL: Record<string, string> = { NOT_SUBMITTED: "Not submitted", PENDING: "Awaiting review", APPROVED: "Verified", REJECTED: "Rejected" };
const KYC_TONE: Record<string, "good" | "warn" | "bad" | undefined> = { APPROVED: "good", PENDING: "warn", REJECTED: "bad" };
const NOTE_KIND: Record<string, string> = { NOTE: "Internal note", INFO_REQUEST: "Information requested", APPLICANT_RESPONSE: "Applicant replied", STATUS_CHANGE: "Status", KYC: "KYC" };

function History({ m }: { m: Merchant }) {
  const q = useQuery({
    queryKey: ["admin", "merchant-history", m.id],
    queryFn: () => Promise.all([api<Kyc>(`/merchants/${m.id}/kyc`), api<{ items: Note[] }>(`/merchants/${m.id}/notes?limit=20`)]),
  });
  if (q.isLoading) return <div className="faint">Loading…</div>;
  if (q.error) return <div className="faint">{describe(q.error)}</div>;
  const [k, notes] = q.data!;
  return (
    <div style={{ fontSize: 13 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        KYC <Pill tone={KYC_TONE[k.status]}>{KYC_LABEL[k.status] || k.status}</Pill>
        <Button size="sm" onClick={() => void openKyc(m.id)}>
          Documents ({k.documents.length})
        </Button>
        {m.status === "REJECTED" && m.rejectionReason ? <span> · Rejected: {m.rejectionReason}</span> : null}
        {m.status === "INFO_REQUESTED" ? <Pill tone="warn">Waiting for the applicant</Pill> : null}
      </div>
      {notes.items.length ? (
        <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0, maxHeight: 220, overflow: "auto" }}>
          {notes.items.map(n => (
            <li key={n.id ?? n.at} style={{ margin: "6px 0" }}>
              <strong>{n.author}</strong>{" "}
              <span className="faint">
                {whenFull(n.at)} · {NOTE_KIND[n.kind] || n.kind}
              </span>
              <div>{n.body}</div>
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ margin: "8px 0 0" }}>No notes yet.</p>
      )}
    </div>
  );
}

const saveNote = async (m: Merchant, body: string) => {
  if (!body.trim()) return;
  await api(`/merchants/${m.id}/notes`, { method: "POST", body: { body: body.trim() } }).catch(toastError);
};

// ───────────── review an application ─────────────
interface Pkg {
  id: string;
  name: string;
  isDefault?: boolean;
  status?: string;
  version?: number;
}

export const reviewRegistration = (m: Merchant) => openCustom(close => <Review m={m} close={() => close()} />, "wide");

function Review({ m, close }: { m: Merchant; close: () => void }) {
  const [packageId, setPackageId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = m.status === "PENDING_REVIEW" || m.status === "INFO_REQUESTED";
  const segment = m.type === "BANKING_FINANCIAL" ? "BANKING_FINANCIAL" : "ECOMMERCE";
  const pkgs = useQuery({ queryKey: ["admin", "packages", segment], queryFn: () => api<Pkg[]>(`/packages?segment=${segment}`) });
  const def = pkgs.data?.find(p => p.isDefault);
  const field = (label: string, value: string, full = false) => (
    <label className={`field${full ? " full" : ""}`}>
      <span>{label}</span>
      <input className="input" value={value} readOnly />
    </label>
  );
  async function approve() {
    setBusy(true);
    try {
      await api(`/merchants/${m.id}`, { method: "PATCH", body: { status: "ACTIVE" } });
      let waiting = false;
      if (packageId) waiting = (await api<{ status?: string }>(`/merchants/${m.id}/package`, { method: "PUT", body: { packageId } }))?.status === "PENDING";
      await saveNote(m, note);
      await reload();
      close();
      toast(`${m.name}: approved · merchant account activated${waiting ? " · package change sent for approval" : ""}.`, "good");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <DialogFrame
      title={`Review ${m.name}`}
      subtitle={`Application ${m.code} · verify submitted details and service requirements.`}
      close={close}
      foot={
        <>
          <Button onClick={close}>Cancel</Button>
          {pending ? (
            <Button variant="primary" disabled={busy} onClick={() => void approve()}>
              Approve merchant
            </Button>
          ) : null}
        </>
      }
    >
      <div className="form-grid">
        {field("Business owner", m.contactName)}
        {field("Business type", m.type === "BANKING_FINANCIAL" ? "Banking & Financial merchant" : "E-commerce")}
        {field("Contact email", m.contactEmail || "—", true)}
        {field("Contact phone", phoneText(m.contactPhone))}
        {field("Operating city", m.pickup?.zone ? `${m.pickup.zone}, ${m.pickupDistrict}` : m.pickupDistrict || "—")}
        {pending ? (
          <label className="field full">
            <span>Service package</span>
            <Select className="select" value={packageId} onChange={e => setPackageId(e.target.value)}>
              <option value="">{def ? `${def.name} (default)` : "Default package"}</option>
              {(pkgs.data ?? [])
                .filter(p => p.status === "ACTIVE" && !p.isDefault)
                .map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </Select>
          </label>
        ) : null}
        {pending ? (
          <label className="field full">
            <span>Review note</span>
            <textarea className="textarea" value={note} onChange={e => setNote(e.target.value)} placeholder="Optional internal approval note" />
          </label>
        ) : null}
        {pending ? (
          <div className="full row" style={{ gap: 8 }}>
            <Button size="sm" variant="danger" onClick={() => void rejectApplication(m).then(done => done && close())}>
              Reject application
            </Button>
            <Button size="sm" onClick={() => void requestInfo(m).then(done => done && close())}>
              Request more information
            </Button>
          </div>
        ) : null}
        <div className="field full">
          <span className="field-label row" style={{ justifyContent: "space-between" }}>
            Addresses, pickup and serving hub
            <Button
              size="sm"
              onClick={() => {
                close();
                void editMerchantAddress(m);
              }}
            >
              Change
            </Button>
          </span>
          <AddressSummary m={m} />
        </div>
        <div className="field full">
          <span className="field-label">Verification and account history</span>
          <History m={m} />
        </div>
      </div>
    </DialogFrame>
  );
}

export async function rejectApplication(m: Merchant) {
  const r = await openForm({
    title: `Reject ${m.name}`,
    description: "The applicant is told by SMS/email with this reason. They can apply again later.",
    submit: "Reject application",
    danger: true,
    fields: [{ id: "reason", label: "Reason (shared with the applicant)", type: "textarea", required: true, maxLength: 1000, placeholder: "e.g. The trade licence could not be verified" }],
    validate: { reason: v => (v.trim().length >= 5 ? "" : "Give a reason of at least 5 characters") },
    onSubmit: async v => {
      const x = await api<Merchant>(`/merchants/${m.id}/reject`, { method: "POST", body: { reason: v.reason.trim() } });
      await reload();
      return `${x.name}: application rejected. The applicant was told why.`;
    },
  });
  return !!r;
}

export async function requestInfo(m: Merchant) {
  const r = await openForm({
    title: `Ask ${m.name} for more information`,
    description: "The applicant gets this message by SMS/email and answers in their merchant panel.",
    submit: "Send request",
    fields: [{ id: "message", label: "What do you need?", type: "textarea", required: true, maxLength: 2000, placeholder: "e.g. Please upload a clearer photo of the trade licence" }],
    validate: { message: v => (v.trim().length >= 5 ? "" : "Write at least 5 characters") },
    onSubmit: async v => {
      const x = await api<Merchant>(`/merchants/${m.id}/request-info`, { method: "POST", body: { message: v.message.trim() } });
      await reload();
      return `${x.name}: information requested. The application waits for their answer.`;
    },
  });
  return !!r;
}

// ───────────── an account ─────────────
export const manageMerchant = (m: Merchant, onPackage?: (m: Merchant) => void) => openCustom(close => <Account m={m} close={() => close()} onPackage={onPackage} />, "wide");

function Account({ m, close, onPackage }: { m: Merchant; close: () => void; onPackage?: (m: Merchant) => void }) {
  const initial = m.status === "ACTIVE" ? "Active" : m.status === "SUSPENDED" ? "Suspended" : "Under review";
  const [status, setStatus] = useState(initial);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const pkg = useQuery({ queryKey: ["admin", "merchant-package", m.id], queryFn: () => api<{ current: Pkg; scheduled: { package?: Pkg | null; effectiveFrom: string }[] }>(`/merchants/${m.id}/package`) });
  const current = pkg.data?.current;
  const next = pkg.data?.scheduled?.[0];
  async function save() {
    const value = ({ Active: "ACTIVE", "Under review": "PENDING_REVIEW", Suspended: "SUSPENDED" } as Record<string, string>)[status];
    if (status === initial) {
      await saveNote(m, note);
      close();
      return toast(note.trim() ? `${m.name}: note saved.` : `No changes to ${m.name}.`);
    }
    if (value === "SUSPENDED" && !(await confirm({ title: `Suspend ${m.name}?`, message: "Its team can't book pickups until the account is reactivated.", ok: "Suspend", danger: true }))) return;
    setBusy(true);
    try {
      await api(`/merchants/${m.id}`, { method: "PATCH", body: { status: value } });
      await saveNote(m, note);
      await reload();
      close();
      toast(`${m.name} account changes saved.`, "good");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <DialogFrame
      title={m.name}
      subtitle={`${m.code} · account status and service package.`}
      close={close}
      foot={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            Save account changes
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          <span>Account status</span>
          <Select className="select" value={status} onChange={e => setStatus(e.target.value)}>
            {["Active", "Under review", "Suspended"].map(s => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </label>
        <div className="field">
          <span className="field-label">Service package</span>
          <div className="row" style={{ gap: 8 }}>
            <input className="input" readOnly value={current ? `${current.name}${current.isDefault ? " (default)" : ""} · v${current.version}` : packageLabel(m)} style={{ flex: 1, minWidth: 0 }} />
            <Button
              size="sm"
              title="Assign another package (a second super admin approves)"
              onClick={() => {
                close();
                onPackage?.(m);
              }}
            >
              Change
            </Button>
          </div>
          {next ? <small>{`Changes to ${next.package?.name || "the default package"} on ${dateOf(next.effectiveFrom)}.`}</small> : null}
        </div>
        <label className="field full">
          <span>Primary owner · contact</span>
          <input className="input" readOnly value={`${m.contactName} · ${m.contactEmail || phoneText(m.contactPhone)}`} />
        </label>
        <label className="field full">
          <span>Enabled services</span>
          <input className="input" readOnly value={m.type === "BANKING_FINANCIAL" ? "Secure documents · OTP" : "E-commerce · COD"} />
        </label>
        <label className="field full">
          <span>Internal account note</span>
          <textarea className="textarea" value={note} onChange={e => setNote(e.target.value)} placeholder="Reason for the status change" />
        </label>
        <div className="field full">
          <span className="field-label row" style={{ justifyContent: "space-between" }}>
            Addresses, pickup and serving hub
            <Button
              size="sm"
              onClick={() => {
                close();
                void editMerchantAddress(m);
              }}
            >
              Change
            </Button>
          </span>
          <AddressSummary m={m} />
        </div>
        <div className="field full">
          <span className="field-label">Verification and account history</span>
          <History m={m} />
        </div>
      </div>
    </DialogFrame>
  );
}

// ───────────── invitations ─────────────
const INVITE_TYPES: [MerchantType, string][] = [
  ["ECOMMERCE", "E-commerce"],
  ["BANKING_FINANCIAL", "Banking & Financial"],
];
interface Invite {
  id: string;
  name: string;
  businessName?: string | null;
  phone?: string | null;
  email?: string | null;
  type: MerchantType;
  invitedBy?: string;
  createdAt: string;
  expiresAt: string;
  status: "PENDING" | "ACCEPTED" | "EXPIRED" | "REVOKED";
  link?: string;
}

export async function inviteMerchant(type: MerchantType = "ECOMMERCE") {
  let sent: Invite | null = null;
  await openForm({
    title: "Invite a merchant",
    description: "Sends a one-time sign-up link by SMS and/or email. It expires in 14 days.",
    submit: "Send invitation",
    fields: [
      { id: "businessName", label: "Business name", placeholder: "Registered business name" },
      { id: "name", label: "Primary contact", required: true, placeholder: "Contact name" },
      { id: "email", label: "Business email", type: "email", full: true, placeholder: "name@company.example (optional if a mobile number is given)" },
      { id: "phone", label: "Mobile number", type: "phone" },
      { id: "type", label: "Merchant type", type: "select", required: true, value: type, options: INVITE_TYPES.map(([value, label]) => ({ value, label })) },
      { id: "message", label: "Personal message", type: "textarea", full: true, maxLength: 500, placeholder: "Shown on the invitation" },
    ],
    validate: {
      name: v => (v.trim().length < 2 ? "Enter the primary contact's name." : /^[+\d\s()-]{7,}$/.test(v.trim()) ? "Enter the primary contact's name. The mobile number goes in its own field." : ""),
      email: (v, all) => (!v.trim() && !all.phone?.trim() ? "Enter a mobile number or an email address." : ""),
    },
    onSubmit: async v => {
      sent = await api<Invite>("/merchants/invites", {
        method: "POST",
        body: { name: v.name.trim(), businessName: v.businessName.trim() || undefined, phone: v.phone || undefined, email: v.email.trim() || undefined, type: v.type, message: v.message.trim() || undefined },
      });
    },
  });
  const invite = sent as Invite | null;
  if (!invite) return;
  void openCustom(close => (
    <DialogFrame
      title="Invitation sent"
      subtitle={`${invite.name}${invite.businessName ? ` · ${invite.businessName}` : ""} · expires ${whenFull(invite.expiresAt)}`}
      close={() => close()}
      foot={
        <>
          <Button size="sm" onClick={() => navigator.clipboard?.writeText(invite.link || "").then(() => toast("Link copied."), () => toast("Select the link and copy it."))}>
            Copy link
          </Button>
          <Button size="sm" variant="primary" onClick={() => close()}>
            Done
          </Button>
        </>
      }
    >
      <p style={{ fontSize: 13 }}>We sent the link by {[invite.phone && "SMS", invite.email && "email"].filter(Boolean).join(" and ")}. You can also share it yourself; it works once.</p>
      <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", background: "var(--surface-2)", padding: 10, borderRadius: 8, fontSize: 12 }}>{invite.link}</pre>
    </DialogFrame>
  ));
}

export const openInvites = () => openCustom(close => <Invites close={() => close()} />, "xwide");

function Invites({ close }: { close: () => void }) {
  const canManage = useCanManage();
  const q = useQuery({ queryKey: ["admin", "invites"], queryFn: () => api<{ items: Invite[] }>("/merchants/invites?limit=100") });
  const TONE = { PENDING: "warn", ACCEPTED: "good", EXPIRED: undefined, REVOKED: "bad" } as const;
  async function revoke(i: Invite) {
    if (!(await confirm({ title: "Revoke this invitation?", message: "The link stops working.", ok: "Revoke", danger: true }))) return;
    await api(`/merchants/invites/${i.id}`, { method: "DELETE" }).catch(toastError);
    void q.refetch();
  }
  return (
    <DialogFrame title="Merchant invitations" subtitle="One-time sign-up links sent to prospective merchants." close={close}>
      {q.error ? <div className="callout bad">{describe(q.error)}</div> : null}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Contact</th>
              <th>Sent to</th>
              <th>Invited by</th>
              <th>Expires</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.isLoading ? (
              <tr>
                <td colSpan={6}>Loading…</td>
              </tr>
            ) : q.data?.items.length ? (
              q.data.items.map(i => (
                <tr key={i.id}>
                  <td>
                    <strong>{i.name}</strong>
                    <span className="sub">{[i.businessName, INVITE_TYPES.find(([v]) => v === i.type)?.[1]].filter(Boolean).join(" · ")}</span>
                  </td>
                  <td>{[i.phone, i.email].filter(Boolean).join(" · ")}</td>
                  <td>
                    {i.invitedBy}
                    <span className="sub">{whenFull(i.createdAt)}</span>
                  </td>
                  <td>{whenFull(i.expiresAt)}</td>
                  <td>
                    <Pill tone={TONE[i.status]}>{i.status}</Pill>
                  </td>
                  <td>
                    {i.status === "PENDING" && canManage ? (
                      <Button size="sm" onClick={() => void revoke(i)}>
                        Revoke
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6}>No invitations yet. Use “Invite merchant”.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </DialogFrame>
  );
}

// ───────────── KYC ─────────────
export const openKycQueue = () => openCustom(close => <KycQueue close={() => close()} />, "wide");

function KycQueue({ close }: { close: () => void }) {
  const q = useQuery({ queryKey: ["admin", "kyc-queue"], queryFn: () => api<{ items: Merchant[] }>("/merchants?kycStatus=PENDING&limit=100") });
  return (
    <DialogFrame
      title="KYC reviews"
      subtitle="Business documents waiting for a decision."
      close={close}
      foot={
        <Button size="sm" onClick={() => void openPolicy()}>
          KYC policy
        </Button>
      }
    >
      {q.error ? <div className="callout bad">{describe(q.error)}</div> : null}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Merchant</th>
              <th>Submitted</th>
              <th>Account</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.isLoading ? (
              <tr>
                <td colSpan={4}>Loading…</td>
              </tr>
            ) : q.data?.items.length ? (
              q.data.items.map(m => (
                <tr key={m.id}>
                  <td>
                    <strong>{m.name}</strong>
                    <span className="sub">
                      {m.code} · {m.type === "BANKING_FINANCIAL" ? "Banking & Financial merchant" : "E-commerce"}
                    </span>
                  </td>
                  <td>{whenFull(m.kyc?.submittedAt)}</td>
                  <td>
                    <Pill tone={m.status === "ACTIVE" ? "good" : "warn"}>{m.status === "ACTIVE" ? "Active" : m.status.replace("_", " ").toLowerCase()}</Pill>
                  </td>
                  <td>
                    <Button size="sm" variant="primary" onClick={() => void openKyc(m.id).then(() => q.refetch())}>
                      Review documents
                    </Button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4}>No documents waiting for review.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </DialogFrame>
  );
}

export const openKyc = (merchantId: string) => openCustom(close => <KycReview merchantId={merchantId} close={() => close()} />, "wide");

function KycReview({ merchantId, close }: { merchantId: string; close: () => void }) {
  const canManage = useCanManage();
  const [reason, setReason] = useState("");
  const q = useQuery({ queryKey: ["admin", "kyc", merchantId], queryFn: () => Promise.all([api<Kyc>(`/merchants/${merchantId}/kyc`), api<Merchant>(`/merchants/${merchantId}`)]) });
  const [k, m] = q.data ?? [];
  async function decide(decision: "APPROVE" | "REJECT") {
    if (decision === "REJECT" && reason.trim().length < 5) return toast("Give the merchant a reason (at least 5 characters).", "bad");
    if (decision === "APPROVE" && !(await confirm({ title: "Approve these business documents?", message: "The merchant is notified.", ok: "Approve documents" }))) return;
    try {
      await api(`/merchants/${merchantId}/kyc/review`, { method: "POST", body: decision === "APPROVE" ? { decision } : { decision, reason: reason.trim() } });
      await q.refetch();
      await reload();
      void queryClient.invalidateQueries({ queryKey: ["admin", "merchant-history", merchantId] });
      toast(decision === "APPROVE" ? "KYC approved. The merchant was notified." : "KYC rejected. The merchant was notified with the reason.", "good");
    } catch (e) {
      toastError(e);
    }
  }
  async function view(documentId: string) {
    try {
      const d = await api<{ filename: string; mimeType?: string; dataUrl: string }>(`/merchants/${merchantId}/kyc/documents/${documentId}`);
      const w = window.open("", "_blank");
      if (!w) return toast("Allow pop-ups to view the document.");
      w.document.title = d.filename;
      w.document.body.style.margin = "0";
      w.document.body.innerHTML = d.mimeType === "application/pdf" ? `<iframe src="${d.dataUrl}" style="border:0;width:100%;height:100vh"></iframe>` : `<img src="${d.dataUrl}" style="max-width:100%">`;
    } catch (e) {
      toastError(e);
    }
  }
  return (
    <DialogFrame
      title={m ? `KYC · ${m.name}` : "KYC"}
      subtitle={
        m && k ? (
          <>
            {m.code} · <Pill tone={KYC_TONE[k.status]}>{KYC_LABEL[k.status] || k.status}</Pill>
            {k.rejectionReason ? ` · ${k.rejectionReason}` : ""}
          </>
        ) : null
      }
      close={close}
      foot={
        canManage && k && (k.status === "PENDING" || k.status === "APPROVED") ? (
          <>
            <Button variant="danger" onClick={() => void decide("REJECT")}>
              Reject documents
            </Button>
            {k.status === "PENDING" ? (
              <Button variant="primary" onClick={() => void decide("APPROVE")}>
                Approve KYC
              </Button>
            ) : null}
          </>
        ) : null
      }
    >
      {q.error ? <div className="callout bad">{describe(q.error)}</div> : null}
      {q.isLoading ? <div className="faint">Loading…</div> : null}
      {k ? (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>File</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {k.policy.documentTypes.map(t => {
                  const d = k.documents.find(x => x.type === t.type);
                  return (
                    <tr key={t.type}>
                      <td>
                        <strong>{t.label}</strong>
                        {t.required ? null : <small> (optional)</small>}
                      </td>
                      <td>
                        {d ? (
                          <>
                            {d.filename}
                            <span className="sub">{whenFull(d.uploadedAt)}</span>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        {d ? (
                          <Button size="sm" onClick={() => void view(d.id)}>
                            View
                          </Button>
                        ) : (
                          <Pill tone={t.required ? "bad" : undefined}>{t.required ? "Missing" : "Not provided"}</Pill>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {k.history.length ? (
            <>
              <h3 style={{ fontSize: 13, margin: "14px 0 6px" }}>History</h3>
              <ul className="faint" style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
                {k.history.map((h, i) => (
                  <li key={i}>
                    {whenFull(h.at)} · {h.body}
                    {h.by ? ` — ${h.by}` : ""}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {canManage && (k.status === "PENDING" || k.status === "APPROVED") ? (
            <label className="field" style={{ marginTop: 14 }}>
              <span>Reason if rejecting (shared with the merchant)</span>
              <textarea className="textarea" maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. The NID photo is unreadable" />
            </label>
          ) : null}
        </>
      ) : null}
    </DialogFrame>
  );
}

export async function openPolicy() {
  let p: Kyc["policy"];
  try {
    p = await api<Kyc["policy"]>("/merchants/kyc-policy");
  } catch (e) {
    return toastError(e);
  }
  await openForm({
    title: "KYC policy",
    description: "What merchants need verified business documents for.",
    submit: "Save policy",
    fields: [
      { id: "keys", label: "Creating API keys", type: "checkbox", value: !!p.requireForApiKeys, full: true },
      { id: "payouts", label: "Receiving COD payouts", type: "checkbox", value: !!p.requireForCodPayouts, full: true },
      { id: "activation", label: "Approving an application (activation)", type: "checkbox", value: !!p.requireForActivation, full: true },
      { id: "docs", label: "Required documents", type: "checks", full: true, value: p.documentTypes.filter(t => t.required).map(t => t.type).join(","), options: p.documentTypes.map(t => ({ value: t.type, label: t.label })) },
    ],
    validate: { docs: v => (v ? "" : "Require at least one document.") },
    onSubmit: async v => {
      await api("/merchants/kyc-policy", { method: "PUT", body: { requireForApiKeys: v.keys === "true", requireForCodPayouts: v.payouts === "true", requireForActivation: v.activation === "true", requiredDocuments: v.docs.split(",").filter(Boolean) } });
      return "KYC policy saved.";
    },
  });
}

export { TYPE_LABEL, STATUS_LABEL };
