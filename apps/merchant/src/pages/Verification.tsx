/**
 * "Account verification" (shared/merchant-verification.js): the whole panel while the merchant account isn't active
 * (under review, information requested, not approved, suspended). No menu, search or bell: this screen is the panel.
 *   - The status stated plainly, the steps to activation
 *   - Business verification: each document with its status, Upload / Replace / View, "Submit for review"
 *     (GET/POST /merchants/me/kyc…; owners only)
 *   - Messages from Delivery Fast and the reply form when information was requested (/merchants/me/review…)
 *   - The business profile, read-only
 * Approval (merchant.updated, or a reload) opens the full panel.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { useAuth } from "@panel/lib/auth";
import { useLive } from "@panel/lib/events";
import { confirm } from "@panel/ui/dialogs";
import { Icon } from "@panel/ui/Icon";
import { Button } from "@panel/ui/kit";
import { toast } from "@panel/ui/toast";
import { useMerchant } from "@/lib/merchant";
import { phoneText, placeText } from "@/lib/text";

const MAX_MB = 3.5;
const TIMES: Record<string, string> = { MORNING: "Morning (9am–12pm)", MIDDAY: "Midday (12pm–3pm)", AFTERNOON: "Afternoon (3pm–6pm)" };
const HANDOVER: Record<string, string> = { RIDER_PICKUP: "Rider pickup", HUB_DROP: "Drop at hub" };
const dateOnly = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
const dateTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

interface Kyc {
  status: "NOT_SUBMITTED" | "PENDING" | "APPROVED" | "REJECTED" | string;
  rejectionReason?: string | null;
  submittedAt?: string | null;
  canUpload: boolean;
  canSubmit: boolean;
  missing: string[];
  policy: { documentTypes: { type: string; label: string; required: boolean }[] };
  documents: { id: string; type: string; filename: string; uploadedAt: string }[];
}
interface Review {
  canRespond: boolean;
  messages: { kind: string; author?: string | null; at: string; body: string }[];
}
type M = Record<string, unknown> & { id: string; name: string; code: string; status: string; type: string; myRole?: string; createdAt?: string; rejectionReason?: string | null };

export default function Verification() {
  const mctx = useMerchant();
  const { logout, user } = useAuth();
  const qc = useQueryClient();
  const q = mctx.q();
  const data = useQuery({
    queryKey: ["m", "verification"],
    queryFn: async () => {
      const [merchant, kyc, review] = await Promise.all([api<M>(`/merchants/me${q}`), api<Kyc>(`/merchants/me/kyc${q}`).catch(() => null), api<Review>(`/merchants/me/review${q}`).catch(() => null)]);
      return { merchant, kyc, review };
    },
  });
  useLive(["merchant.updated"], () => void qc.invalidateQueries({ queryKey: ["m", "verification"] }), { fallbackMs: 120_000 });
  const [busy, setBusy] = useState("");
  const [reply, setReply] = useState("");
  const m = data.data?.merchant;
  useEffect(() => {
    if (m?.status === "ACTIVE") {
      toast("Your merchant account is verified. Opening your panel…", "good");
      const t = setTimeout(() => location.reload(), 1000);
      return () => clearTimeout(t);
    }
  }, [m?.status]);
  const signOut = async () => {
    if (await confirm({ title: "Sign out?", message: `Sign out ${user?.name ?? "this account"} on this device?`, ok: "Sign out" })) await logout();
  };
  const heading = (
    <div className="page-heading">
      <div>
        <p className="eyebrow">Merchant account</p>
        <h1>Account verification</h1>
        <p className="subtitle">{m ? `${m.name} · ${m.code}` : "Your merchant account"}</p>
      </div>
      <div className="heading-actions">
        <Button onClick={signOut}>Sign out</Button>
      </div>
    </div>
  );
  if (!m)
    return (
      <div className="verify-page">
        <div className="dfv">
          {heading}
          <section className="dfv-card">
            <p className="faint">{data.isError ? describe(data.error) : "Loading your account…"}</p>
            {data.isError ? (
              <Button onClick={() => data.refetch()} style={{ marginTop: 10 }}>
                Try again
              </Button>
            ) : null}
          </section>
        </div>
      </div>
    );
  const kyc = data.data!.kyc;
  const review = data.data!.review;
  const owner = m.myRole === "MERCHANT_OWNER";
  const reload = () => qc.invalidateQueries({ queryKey: ["m", "verification"] });

  async function upload(type: string, file?: File | null) {
    if (!file) return;
    if (file.size > MAX_MB * 1024 * 1024) return toast(`That file is larger than ${MAX_MB} MB. Use a smaller scan or photo.`, "bad");
    if (!/^(image\/(png|jpeg|webp)|application\/pdf)$/.test(file.type)) return toast("Use a PNG, JPEG, WebP or PDF file.", "bad");
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("The file couldn't be read."));
      reader.readAsDataURL(file);
    }).catch(e => (toast(describe(e), "bad"), ""));
    if (!dataUrl) return;
    setBusy(type);
    try {
      await api(`/merchants/me/kyc/documents${q}`, { method: "POST", body: { type, filename: file.name.slice(0, 120), file: dataUrl } });
      toast(`${file.name} uploaded.`, "good");
    } catch (e) {
      toast(describe(e), "bad");
    } finally {
      setBusy("");
      void reload();
    }
  }
  async function submit() {
    setBusy("submit");
    try {
      await api(`/merchants/me/kyc/submit${q}`, { method: "POST" });
      toast("Thanks — your documents are with Delivery Fast for review.", "good");
    } catch (e) {
      toast(describe(e), "bad");
    } finally {
      setBusy("");
      void reload();
    }
  }
  async function view(id: string) {
    const tab = window.open("", "_blank");
    try {
      const doc = await api<{ filename?: string; dataUrl: string }>(`/merchants/me/kyc/documents/${encodeURIComponent(id)}${q}`);
      if (!tab) return toast("Allow pop-ups to view the document.");
      tab.document.title = doc.filename || "Document";
      tab.document.body.style.margin = "0";
      tab.document.body.innerHTML = /^data:application\/pdf/.test(doc.dataUrl) ? `<iframe src="${doc.dataUrl}" style="border:0;width:100vw;height:100vh"></iframe>` : `<img src="${doc.dataUrl}" alt="" style="max-width:100%;display:block;margin:auto">`;
    } catch (e) {
      tab?.close();
      toast(describe(e), "bad");
    }
  }
  async function sendReply(e: React.FormEvent) {
    e.preventDefault();
    const message = reply.trim();
    if (message.length < 2) return toast("Write your reply first.");
    setBusy("reply");
    try {
      await api(`/merchants/me/review/respond${q}`, { method: "POST", body: { message } });
      setReply("");
      toast("Thanks — your application is back with Delivery Fast.", "good");
    } catch (err) {
      toast(describe(err), "bad");
    } finally {
      setBusy("");
      void reload();
    }
  }

  // ───────────── what the screen says ─────────────
  const missing = kyc?.missing?.length || 0;
  const h: { tone: "red" | "amber" | "blue"; icon: Parameters<typeof Icon>[0]["name"]; badge: ["red" | "amber", string]; title: string; text: string } =
    m.status === "SUSPENDED"
      ? { tone: "red", icon: "lock", badge: ["red", "Suspended"], title: "Your merchant account is suspended", text: "You can't book parcels or use the panel while the account is suspended. Contact Delivery Fast support to resolve it." }
      : m.status === "REJECTED"
        ? { tone: "red", icon: "alert", badge: ["red", "Not approved"], title: "Your application wasn't approved", text: `${m.rejectionReason ? `Reason: ${m.rejectionReason}. ` : ""}Your account isn't verified, so the panel stays closed. You can apply again with corrected details from the website.` }
        : m.status === "INFO_REQUESTED"
          ? { tone: "amber", icon: "alert", badge: ["amber", "Not verified yet"], title: "Action needed: Delivery Fast needs more information", text: "Your account isn't verified yet. Read the message below, upload anything that's asked for and send your reply. Your application goes back to review straight away." }
          : kyc?.status === "REJECTED"
            ? { tone: "amber", icon: "alert", badge: ["amber", "Not verified yet"], title: "Your documents need another look", text: `${kyc.rejectionReason ? `${kyc.rejectionReason}. ` : ""}Replace the documents below and submit them again.` }
            : kyc?.status === "PENDING"
              ? { tone: "blue", icon: "clock", badge: ["amber", "Not verified yet"], title: "Your account isn't verified yet — review in progress", text: `We're reviewing your business documents. We'll text ${phoneText(m.contactPhone as string)} as soon as it's done. Nothing else is needed from you right now.` }
              : {
                  tone: "amber",
                  icon: "lock",
                  badge: ["amber", "Not verified yet"],
                  title: "Your account isn't verified yet",
                  text: missing ? "Upload your business documents below and submit them for review. The panel — booking, shipments and payments — opens once Delivery Fast verifies your business." : "All required documents are uploaded. Submit them for review to continue.",
                };
  const docsDone = !!kyc && (kyc.status === "PENDING" || kyc.status === "APPROVED");
  const rejected = m.status === "REJECTED" || m.status === "SUSPENDED";
  const required = kyc ? kyc.policy.documentTypes.filter(t => t.required).length : 0;
  const steps = [
    { title: "Application received", note: dateOnly(m.createdAt), state: "done" },
    { title: "Business documents", note: docsDone ? `Submitted ${dateOnly(kyc!.submittedAt)}` : kyc ? `${required - kyc.missing.length} of ${required} required uploaded` : "", state: docsDone ? "done" : kyc?.status === "REJECTED" ? "failed" : "current" },
    {
      title: "Review by Delivery Fast",
      note: m.status === "INFO_REQUESTED" ? "Waiting for your reply" : rejected ? (m.status === "SUSPENDED" ? "Account suspended" : "Not approved") : docsDone ? "In progress" : "After you submit",
      state: rejected ? "failed" : docsDone && m.status !== "INFO_REQUESTED" ? "current" : "todo",
    },
    { title: "Account active", note: "Booking, shipments, payments", state: "todo" },
  ];
  const canUpload = !!kyc && owner && kyc.canUpload && m.status !== "SUSPENDED" && m.status !== "REJECTED";
  const kycBadge = kyc ? ({ NOT_SUBMITTED: ["amber", "Not submitted"], PENDING: ["blue", "Under review"], APPROVED: ["green", "Verified"], REJECTED: ["red", "Needs changes"] } as Record<string, [string, string]>)[kyc.status] || ["grey", kyc.status] : null;
  const banking = m.type === "BANKING_FINANCIAL";
  const biz = m.business as Record<string, string> | null | undefined;
  const pickup = m.pickup as Record<string, string> | null | undefined;
  const hub = m.pickupHub as { name: string; code: string } | null | undefined;
  const profile: [string, ReactNode, boolean?][] = (
    [
      [banking ? "Institution name" : "Business name", m.name],
      ["Merchant ID", m.code],
      ["Account type", banking ? "Banking & Financial merchant" : "E-commerce merchant"],
      ["Business category", m.businessCategory as string],
      ["Contact person", m.contactName as string],
      ["Phone", phoneText(m.contactPhone as string)],
      ["Email", m.contactEmail as string],
      ["Website", m.websiteUrl as string],
      ["Business address", placeText(biz), true],
      ["Pickup address", m.pickupSameAsBusiness ? "Same as the business address" : placeText(pickup), true],
      ["Pickup contact", [m.pickupContactName as string, phoneText(m.pickupContactPhone as string)].filter(Boolean).join(" · ")],
      ["Pickup time", TIMES[m.pickupTime as string] || (m.pickupTime as string)],
      ["Parcel handover", HANDOVER[m.handover as string] || (m.handover as string)],
      ["Serving hub", hub ? `${hub.name} (${hub.code})` : ""],
    ] as [string, ReactNode, boolean?][]
  ).filter(([, v]) => v);

  return (
    <div className="verify-page">
      <div className="dfv">
        {heading}
        <section className={`dfv-hero ${h.tone}`} role="status">
          <span className="dfv-hero-icon">
            <Icon name={h.icon} size={26} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ marginBottom: 8 }}>
              <span className={`dfv-badge ${h.badge[0]}`}>
                <Icon name={h.badge[0] === "red" ? "lock" : "alert"} size={13} /> {h.badge[1]}
              </span>
            </div>
            <h2>{h.title}</h2>
            <p>{h.text}</p>
          </div>
        </section>
        {m.status === "SUSPENDED" ? null : (
          <section className="dfv-card" aria-label="Steps">
            <div className="dfv-card-head" style={{ marginBottom: 12 }}>
              <h2>Steps to activation</h2>
            </div>
            <ol className="dfv-steps" aria-label="Steps to activation">
              {steps.map((s, i) => (
                <li key={s.title} className={`dfv-step ${s.state}`}>
                  <span className="dfv-step-dot">{s.state === "done" ? <Icon name="check" size={15} /> : i + 1}</span>
                  <div>
                    <strong>{s.title}</strong>
                    {s.note ? <small>{s.note}</small> : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}
        {review && (review.messages.length || review.canRespond) ? (
          <section className="dfv-card">
            <div className="dfv-card-head">
              <div>
                <h2>Messages from Delivery Fast</h2>
                <p>About your application.</p>
              </div>
              {review.canRespond ? <span className="dfv-badge amber">Reply needed</span> : null}
            </div>
            <div className="dfv-thread">
              {review.messages.length ? (
                review.messages.map((x, i) => (
                  <div key={i} className={`dfv-msg${x.kind === "APPLICANT_RESPONSE" ? " mine" : ""}`}>
                    <small>
                      {x.kind === "APPLICANT_RESPONSE" ? "You" : x.author || "Delivery Fast"} · {dateTime(x.at)}
                    </small>
                    {x.body}
                  </div>
                ))
              ) : (
                <p className="faint">No messages yet.</p>
              )}
            </div>
            {review.canRespond && owner ? (
              <form className="dfv-reply" onSubmit={sendReply}>
                <label htmlFor="dfvReply" style={{ fontSize: 13, fontWeight: 600 }}>
                  Your reply
                </label>
                <textarea id="dfvReply" className="input" maxLength={2000} rows={4} placeholder="Answer the question or explain what you uploaded" value={reply} onChange={e => setReply(e.target.value)} />
                <div className="row" style={{ justifyContent: "flex-end" }}>
                  <button type="submit" className="button primary" disabled={busy === "reply"}>
                    {busy === "reply" ? "Sending…" : "Send reply"}
                  </button>
                </div>
              </form>
            ) : null}
          </section>
        ) : null}
        {m.status !== "SUSPENDED" ? (
          <section className="dfv-card">
            {!kyc ? (
              <>
                <h2>Business verification</h2>
                <p className="faint" style={{ marginTop: 8 }}>
                  Loading your documents…
                </p>
              </>
            ) : (
              <>
                <div className="dfv-card-head">
                  <div>
                    <h2>Business verification</h2>
                    <p>Documents that prove your business. Only Delivery Fast reviewers can see them.</p>
                  </div>
                  {kycBadge ? <span className={`dfv-badge ${kycBadge[0]}`}>{kycBadge[1]}</span> : null}
                </div>
                {kyc.status === "REJECTED" && kyc.rejectionReason ? (
                  <div className="callout bad">
                    <span>
                      <b>Not approved:</b> {kyc.rejectionReason}. Replace the documents and submit again.
                    </span>
                  </div>
                ) : null}
                {kyc.status === "PENDING" ? <div className="callout">Submitted {dateTime(kyc.submittedAt)}. Your documents are being reviewed.</div> : null}
                <div className="dfv-docs">
                  {kyc.policy.documentTypes.map(t => {
                    const d = kyc.documents.find(x => x.type === t.type);
                    const isBusy = busy === t.type;
                    return (
                      <div key={t.type} className={`dfv-doc${d ? " ok" : ""}`}>
                        <span className="dfv-doc-icon">
                          <Icon name={d ? "check" : "file"} size={18} />
                        </span>
                        <div className="dfv-doc-body">
                          <strong>{t.label}</strong>
                          {t.required ? null : <small style={{ display: "inline" }}> (optional)</small>}
                          <small>{d ? `${d.filename} · uploaded ${dateOnly(d.uploadedAt)}` : "Not uploaded yet"}</small>
                        </div>
                        <div className="dfv-doc-actions">
                          {d ? <span className="dfv-badge green">Uploaded</span> : t.required ? <span className="dfv-badge amber">Required</span> : <span className="dfv-badge grey">Optional</span>}
                          {canUpload ? (
                            <label className={`button sm${isBusy ? " is-busy" : ""}`} style={{ cursor: "pointer" }}>
                              {isBusy ? "Uploading…" : d ? "Replace" : "Upload"}
                              <input type="file" hidden accept="image/png,image/jpeg,image/webp,application/pdf" disabled={isBusy} onChange={e => (void upload(t.type, e.target.files?.[0]), (e.target.value = ""))} />
                            </label>
                          ) : null}
                          {d && owner ? (
                            <button type="button" className="button sm" onClick={() => void view(d.id)}>
                              View
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {owner && kyc.canSubmit && canUpload ? (
                  <div className="dfv-submit">
                    <p>All required documents are uploaded. Submit them so Delivery Fast can verify your business.</p>
                    <button type="button" className="button primary" disabled={busy === "submit"} onClick={() => void submit()}>
                      {busy === "submit" ? "Submitting…" : "Submit for review"}
                    </button>
                  </div>
                ) : kyc.status === "NOT_SUBMITTED" && kyc.missing.length && canUpload ? (
                  <div className="dfv-submit">
                    <p>Upload {kyc.missing.length === 1 ? "the last required document" : `the ${kyc.missing.length} required documents`} to submit for review.</p>
                    <button type="button" className="button primary" disabled>
                      Submit for review
                    </button>
                  </div>
                ) : null}
                <p className="dfv-note">
                  PNG, JPEG, WebP or PDF, up to {MAX_MB} MB each.{owner ? "" : " Only the account owner can upload documents."}
                </p>
              </>
            )}
          </section>
        ) : null}
        <section className="dfv-card">
          <div className="dfv-card-head">
            <div>
              <h2>Business profile</h2>
              <p>
                {m.status === "INFO_REQUESTED"
                  ? "Something to correct? Say so in your reply above and Delivery Fast will update it."
                  : m.status === "SUSPENDED"
                    ? "Your business details on file. They can't be changed while the account is suspended."
                    : "Shown as submitted in your application. It can't be changed until your account is verified."}
              </p>
            </div>
            <span className="dfv-readonly">
              <Icon name="lock" size={13} /> Read-only
            </span>
          </div>
          <dl className="dfv-profile">
            {profile.map(([k, v, full]) => (
              <div key={k} className={full ? "full" : undefined}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </div>
  );
}
