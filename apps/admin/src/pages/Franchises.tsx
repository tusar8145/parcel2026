/**
 * Franchises (bridge-franchise.js + bridge-status-tabs.js): partner-run hubs, each a hub tagged Franchise with one
 * account. Add a franchise (or create one from an approved franchise application), commission rates (percent of the
 * delivery charge with a minimum, for pickup, delivery and return), suspend / reactivate, and the settlement settings
 * (DEDUCT or BILL, billing period). API: /franchises, /franchises/config, /franchises/applications.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { localPhone } from "@panel/lib/format";
import { confirm, openForm, type FormField } from "@panel/ui/dialogs";
import { Button, Loading, Metric, PageHeading, Panel, Pill, Tabs } from "@panel/ui/kit";
import { toast, toastError } from "@panel/ui/toast";
import { useCatalog, type Catalog } from "@/lib/admin";
import { accountFields, generatePassword, passwordProblem } from "@panel/ui/AccountFields";

interface Rates {
  pickupPercent: number;
  pickupMin: number;
  deliveryPercent: number;
  deliveryMin: number;
  returnPercent: number;
  returnMin: number;
}
interface Franchise {
  id: string;
  code: string;
  name: string;
  contactName: string;
  contactPhone: string;
  contactEmail?: string | null;
  /** The franchise's sign-in account. */
  owner?: { id: string; name: string; phone: string; email: string | null; status: string; lastLoginAt: string | null } | null;
  status: "ACTIVE" | "SUSPENDED";
  riders: number;
  unsettledCommission: number;
  rates: Rates;
  hub: { id: string; name: string; code: string; district: string };
}
interface Application {
  id: string;
  number: string;
  applicant?: { name?: string; phone?: string; email?: string } | null;
  details?: { location?: string; territory?: string } | null;
}
interface Config {
  settlementMode: "DEDUCT" | "BILL";
  billingPeriodDays: number;
}
const tk = (n: unknown) => `৳${(Math.round(Number(n || 0) * 100) / 100).toLocaleString("en-US")}`;
const rateText = (p: number, m: number) => `${p}%${m ? ` · min ${tk(m)}` : ""}`;
type Tab = "active" | "suspended" | "all";

export default function Franchises() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["admin", "franchises"],
    queryFn: async () => {
      const [franchises, config, applications] = await Promise.all([api<Franchise[]>("/franchises"), api<Config>("/franchises/config"), api<Application[]>("/franchises/applications").catch(() => [])]);
      return { franchises, config, applications };
    },
  });
  const catalog = useCatalog();
  const [tab, setTab] = useState<Tab>("active");
  const reload = () => qc.invalidateQueries({ queryKey: ["admin", "franchises"] });
  if (!q.data) return <>{heading}{q.error ? <div className="callout bad">{describe(q.error)}</div> : <Loading rows={6} />}</>;
  const { franchises, config: c, applications } = q.data;
  const shown = franchises.filter(f => (tab === "active" ? f.status === "ACTIVE" : tab === "suspended" ? f.status !== "ACTIVE" : true));

  async function toggleStatus(f: Franchise) {
    const suspend = f.status === "ACTIVE";
    const ok = await confirm({
      title: suspend ? `Suspend ${f.name}?` : `Reactivate ${f.name}?`,
      message: suspend ? "The franchise panel closes, its riders are signed out and can't sign in, and the hub takes no new work." : "The franchise and its riders can sign in again and the hub takes work again.",
      ok: suspend ? "Suspend" : "Reactivate",
      danger: suspend,
    });
    if (!ok) return;
    try {
      await api(`/franchises/${f.id}/status`, { method: "POST", body: { status: suspend ? "SUSPENDED" : "ACTIVE" } });
      toast(suspend ? `${f.name} is suspended.` : `${f.name} is active again.`, "good");
      await reload();
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="Hub settings · Franchise hubs"
        title="Franchises"
        subtitle="Partner-run hubs: each is a hub of the network (tagged Franchise) with its own riders and one account. Commission is a percent of the delivery charge, with a minimum."
        actions={
          <Button variant="primary" onClick={() => void openCreate(null, catalog.data, reload)}>
            Add franchise
          </Button>
        }
      />
      <div className="metrics">
        <Metric label="Franchises" icon="box" value={String(franchises.length)} foot={`${franchises.filter(f => f.status === "ACTIVE").length} active`} note="partner hubs" />
        <Metric label="Franchise riders" icon="users" value={String(franchises.reduce((a, f) => a + f.riders, 0))} foot="own riders" note="work only for their hub" />
        <Metric label="Commission not settled" icon="wallet" value={tk(franchises.reduce((a, f) => a + f.unsettledCommission, 0))} foot={c.settlementMode === "DEDUCT" ? "kept from deposits" : "billed by finance"} note="all franchises" />
      </div>
      <Settlement config={c} onSaved={next => qc.setQueryData(["admin", "franchises"], { ...q.data, config: next })} />
      {applications.length ? (
        <Panel title="Approved applications" subtitle="Franchise applications approved in Support: create their franchise (the applicant's account becomes the franchise account).">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Applicant</th>
                  <th>Location</th>
                  <th>Territory</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {applications.map(a => (
                  <tr key={a.id}>
                    <td>
                      <span className="strong">{a.applicant?.name || "Applicant"}</span>
                      <span className="sub">
                        {a.number} · {a.applicant?.phone || ""}
                      </span>
                    </td>
                    <td>{a.details?.location || "—"}</td>
                    <td>{a.details?.territory || "—"}</td>
                    <td>
                      <Button size="sm" variant="primary" onClick={() => void openCreate(a, catalog.data, reload)}>
                        Create franchise
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
      <div style={{ height: 16 }} />
      <Panel title="Franchise hubs" subtitle={`${franchises.length} franchise${franchises.length === 1 ? "" : "s"}`}>
        <div style={{ padding: "12px 16px 10px" }}>
          <Tabs
            label="Franchises"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "active", label: "Active", count: franchises.filter(f => f.status === "ACTIVE").length },
              { id: "suspended", label: "Suspended", count: franchises.filter(f => f.status !== "ACTIVE").length },
              { id: "all", label: "All", count: franchises.length },
            ]}
          />
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Franchise / hub</th>
                <th>Contact</th>
                <th>Commission (pickup)</th>
                <th className="num">Riders</th>
                <th className="num">Not settled</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map(f => (
                <tr key={f.id}>
                  <td>
                    <span className="strong">{f.name}</span>
                    <span className="sub">
                      {f.code} · {f.hub.name} ({f.hub.code}) · {f.hub.district}
                    </span>
                  </td>
                  <td>
                    {f.contactName}
                    <span className="sub">{[localPhone(f.owner?.phone || f.contactPhone), f.owner?.email || f.contactEmail || ""].filter(Boolean).join(" · ")}</span>
                  </td>
                  <td>
                    {rateText(f.rates.pickupPercent, f.rates.pickupMin)}
                    <span className="sub">{`Delivery ${rateText(f.rates.deliveryPercent, f.rates.deliveryMin)} · Return ${rateText(f.rates.returnPercent, f.rates.returnMin)}`}</span>
                  </td>
                  <td className="num">{f.riders}</td>
                  <td className="num">{tk(f.unsettledCommission)}</td>
                  <td>
                    <Pill tone={f.status === "ACTIVE" ? "good" : "bad"}>{f.status === "ACTIVE" ? "Active" : "Suspended"}</Pill>
                  </td>
                  <td className="nowrap">
                    <Button size="sm" onClick={() => void openRiders(f)}>
                      {`Riders (${f.riders})`}
                    </Button>
                    <Button size="sm" onClick={() => void openEdit(f, reload)}>
                      Rates
                    </Button>{" "}
                    <Button size="sm" title="The franchise's sign-in: name, mobile, email, a new password" onClick={() => void openAccount(f, reload)}>
                      Account
                    </Button>{" "}
                    <Button size="sm" onClick={() => void toggleStatus(f)}>
                      {f.status === "ACTIVE" ? "Suspend" : "Reactivate"}
                    </Button>
                  </td>
                </tr>
              ))}
              {!shown.length ? (
                <tr>
                  <td colSpan={7} className="faint" style={{ textAlign: "center" }}>
                    {franchises.length ? "No franchises here." : "No franchises yet. Add one, or create one from an approved application."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

const heading = <PageHeading eyebrow="Hub settings · Franchise hubs" title="Franchises" subtitle="Loading…" />;

function Settlement({ config, onSaved }: { config: Config; onSaved: (c: Config) => void }) {
  const [mode, setMode] = useState(config.settlementMode);
  const [period, setPeriod] = useState(String(config.billingPeriodDays));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setMode(config.settlementMode);
    setPeriod(String(config.billingPeriodDays));
  }, [config]);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const c = await api<Config>("/franchises/config", { method: "PUT", body: { settlementMode: mode, billingPeriodDays: Number(period) || 30 } });
      onSaved(c);
      toast(mode === "DEDUCT" ? "Franchises now keep their commission when they deposit." : `Finance now bills franchise commission every ${c.billingPeriodDays} days.`, "good");
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ marginBottom: 16 }}>
      <Panel title="Settlement" subtitle="How franchises get their commission.">
        <form className="panel-body" onSubmit={e => void save(e)} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, alignItems: "end" }}>
          <label className="check" style={{ alignItems: "flex-start" }}>
            <input type="radio" name="frMode" value="DEDUCT" checked={mode === "DEDUCT"} onChange={() => setMode("DEDUCT")} />
            <span>
              <b>Deduct when depositing</b>
              <br />
              <small className="faint">A franchise keeps its commission from the cash it deposits at a hub.</small>
            </span>
          </label>
          <label className="check" style={{ alignItems: "flex-start" }}>
            <input type="radio" name="frMode" value="BILL" checked={mode === "BILL"} onChange={() => setMode("BILL")} />
            <span>
              <b>Bill and pay</b>
              <br />
              <small className="faint">Franchises deposit everything; finance invoices the commission and pays it.</small>
            </span>
          </label>
          <label className="field">
            <span>Billing period (days)</span>
            <input id="frPeriod" className="input" type="number" min={1} max={92} value={period} onChange={e => setPeriod(e.target.value)} />
          </label>
          <div>
            <Button type="submit" variant="primary" disabled={busy}>
              Save settlement
            </Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}

const rateFields = (r: Partial<Rates> = {}): FormField[] => [
  { id: "ratesHead", label: "Commission on the delivery charge", type: "static", render: null },
  ...(["pickup", "delivery", "return"] as const).flatMap(k => {
    const l = k[0].toUpperCase() + k.slice(1);
    return [
      { id: `${k}Percent`, label: `${l} %`, type: "number", min: 0, max: 100, step: 0.1, required: true, value: r[`${k}Percent`] ?? 0 },
      { id: `${k}Min`, label: `${l} minimum (৳)`, type: "number", min: 0, step: 1, required: true, value: r[`${k}Min`] ?? 0 },
    ] as FormField[];
  }),
];
const readRates = (v: Record<string, string>): Rates => Object.fromEntries((["pickup", "delivery", "return"] as const).flatMap(k => [[`${k}Percent`, Number(v[`${k}Percent`]) || 0], [`${k}Min`, Number(v[`${k}Min`]) || 0]])) as unknown as Rates;

async function openCreate(application: Application | null, catalog: Catalog | undefined, reload: () => Promise<unknown>) {
  const d = application?.details || {};
  // Any active Delivery Fast hub can be tagged as the franchise's hub (except the central hub, checked by the API).
  const hubs = (await api<{ id: string; name: string; code: string; district: string; type?: string; active?: boolean }[]>("/hubs").catch(() => [])).filter(h => h.type !== "FRANCHISE" && h.active !== false);
  const isNew = (v: Record<string, string>) => v.hubMode !== "existing";
  await openForm({
    title: application ? `Create franchise · ${application.number}` : "Add franchise",
    description: application
      ? `${application.applicant?.name || "The applicant"}'s account becomes the franchise account; they sign in as before and land in the franchise panel.`
      : "Tag an existing hub as a franchise hub, or open a new one, with its account (an existing user keeps their sign-in; a new one signs in with this mobile: a code by SMS, or the password you set).",
    submit: "Save",
    wide: true,
    fields: [
      { id: "name", label: "Franchise name", required: true, maxLength: 120, value: application ? `${application.applicant?.name || ""} franchise` : "" },
      { id: "contactName", label: "Contact person", required: true, maxLength: 120, value: application?.applicant?.name || "" },
      ...(application ? [] : [{ id: "phone", label: "Account mobile", type: "phone", required: true, placeholder: "01XXXXXXXXX" } as FormField]),
      { id: "email", label: "Email", type: "email", value: application?.applicant?.email || "" },
      { id: "hubHead", label: "The hub", type: "static", render: null },
      {
        id: "hubMode",
        label: "Hub",
        type: "select",
        required: true,
        value: "existing",
        options: [
          { value: "existing", label: "Tag an existing hub as franchise" },
          { value: "new", label: "Open a new hub" },
        ],
      },
      {
        id: "hubId",
        label: "Existing hub",
        type: "select",
        required: true,
        full: true,
        show: v => !isNew(v),
        hint: "From now on it works as a franchise hub: its riders become the franchise's riders (only for this hub), and other hubs can't assign them.",
        options: [{ value: "", label: "Choose the hub" }, ...hubs.map(h => ({ value: h.id, label: `${h.name} (${h.code}) · ${h.district}` }))],
      },
      { id: "hubName", label: "Hub name", required: true, maxLength: 120, show: isNew, value: d.location ? `${d.location} Franchise` : "" },
      { id: "district", label: "District", type: "select", required: true, show: isNew, options: [{ value: "", label: "Choose" }, ...(catalog?.districts ?? []).map(x => ({ value: x, label: x }))] },
      { id: "zone", label: "Area (thana)", type: "select", show: isNew, options: v => [{ value: "", label: "Choose" }, ...(catalog?.zonesByDistrict?.[v.district] ?? []).map(z => ({ value: z, label: z }))] },
      { id: "address", label: "Address", required: true, maxLength: 300, full: true, show: isNew, value: d.location || "" },
      ...rateFields(),
      { id: "accountHead", label: "Sign-in", type: "static", render: null },
      ...accountFields(v => ({ kind: "franchise", name: v.contactName, franchiseName: v.name, hubId: isNew(v) ? undefined : v.hubId }), {
        password: !application,
        passwordHint: "For a new account only (an existing account keeps its own). Share it yourself; it isn't sent. Empty: they sign in with a code sent to their mobile.",
      }),
    ],
    validate: { password: passwordProblem },
    onSubmit: async v => {
      const f = await api<Franchise & { messageSent?: boolean; newAccount?: boolean; passwordSet?: boolean }>("/franchises", {
        method: "POST",
        body: {
          applicationId: application?.id || undefined,
          name: v.name.trim(),
          contactName: v.contactName.trim(),
          phone: v.phone || undefined,
          email: v.email?.trim() || undefined,
          ...(isNew(v) ? { hub: { name: v.hubName.trim(), district: v.district, zone: v.zone || undefined, address: v.address.trim() } } : { hubId: v.hubId }),
          rates: readRates(v),
          sendSms: v.sendSms === "true",
          password: v.password || undefined,
        },
      });
      await reload();
      const done = isNew(v) ? `${f.name} (${f.code}) created with hub ${f.hub.name}.` : `${f.hub.name} is now the franchise hub of ${f.name} (${f.code}).`;
      const account = f.messageSent
        ? " The sign-in message was sent."
        : ` No message was sent: share the sign-in details yourself${f.passwordSet ? " (mobile and the password you set)" : v.password && !f.newAccount ? "; the existing account kept its own password" : ""}.`;
      return done + account;
    },
  });
}

/** The franchise's riders (they work only for its hub; super admin › Riders lists the company's). */
async function openRiders(f: Franchise) {
  const riders = await api<{ id: string; code: string; name: string; phone: string; vehicle: string; status: string; active: boolean; openTasks?: number }[]>(`/riders?hubId=${f.hub.id}`).catch(() => []);
  await openForm({
    title: `Riders · ${f.name}`,
    description: `${f.hub.name} (${f.hub.code}). The franchise adds and manages its riders in its own panel.`,
    submit: "Close",
    fields: [
      {
        id: "list",
        label: `${riders.length} rider${riders.length === 1 ? "" : "s"}`,
        type: "static",
        render: riders.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Rider</th>
                  <th>Mobile</th>
                  <th>Status</th>
                  <th className="num">Open tasks</th>
                </tr>
              </thead>
              <tbody>
                {riders.map(r => (
                  <tr key={r.id}>
                    <td className="strong">{`${r.code} · ${r.name}`}</td>
                    <td>{localPhone(r.phone)}</td>
                    <td>{r.active ? <Pill tone={r.status === "ONLINE" ? "good" : "info"}>{r.status === "ONLINE" ? "Online" : r.status === "ON_BREAK" ? "On break" : "Offline"}</Pill> : <Pill tone="warn">Inactive</Pill>}</td>
                    <td className="num">{r.openTasks ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <span className="faint">No riders yet.</span>
        ),
      },
    ],
  });
}

/** The franchise's sign-in account (PATCH /franchises/:id/account): name, mobile, email, a new password. */
async function openAccount(f: Franchise, reload: () => Promise<unknown>) {
  const o = f.owner;
  await openForm({
    title: `Account · ${f.name}`,
    description: `The sign-in of ${f.hub.name} (${f.code})${o?.lastLoginAt ? "" : ", not signed in yet"}. A new password or mobile number signs them out everywhere.`,
    submit: "Save",
    wide: true,
    fields: [
      { id: "name", label: "Name", required: true, maxLength: 120, value: o?.name ?? f.contactName },
      { id: "phone", label: "Mobile", type: "phone", required: true, value: localPhone(o?.phone || f.contactPhone), placeholder: "01XXXXXXXXX" },
      { id: "email", label: "Email", type: "email", value: o?.email ?? f.contactEmail ?? "" },
      { id: "password", label: "New password", maxLength: 128, placeholder: "Leave empty to keep the current one", hint: "Share it with them yourself; it isn't sent." },
      {
        id: "passwordTools",
        label: "",
        type: "static",
        live: (_v, set) => (
          <button type="button" className="button sm" onClick={() => set("password", generatePassword())}>
            Generate a password
          </button>
        ),
      },
    ],
    validate: { password: passwordProblem },
    onSubmit: async v => {
      await api(`/franchises/${f.id}/account`, {
        method: "PATCH",
        body: { name: v.name.trim(), phone: v.phone, email: v.email.trim() || null, ...(v.password ? { password: v.password } : {}) },
      });
      await reload();
      return v.password ? `Saved. Share the new password: they sign in with ${localPhone(v.phone)} and it.` : "Account saved.";
    },
  });
}

async function openEdit(f: Franchise, reload: () => Promise<unknown>) {
  await openForm({
    title: `Commission · ${f.name}`,
    description: `${f.hub.name} (${f.code}). New rates apply to parcel events from now on.`,
    submit: "Save",
    wide: true,
    fields: [{ id: "name", label: "Franchise name", required: true, maxLength: 120, value: f.name }, { id: "contactName", label: "Contact person", required: true, maxLength: 120, value: f.contactName }, ...rateFields(f.rates)],
    onSubmit: async v => {
      await api(`/franchises/${f.id}`, { method: "PATCH", body: { name: v.name.trim(), contactName: v.contactName.trim(), rates: readRates(v) } });
      await reload();
      return "Commission saved.";
    },
  });
}
