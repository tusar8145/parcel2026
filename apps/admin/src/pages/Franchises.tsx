/**
 * The franchise options of Hubs & zones (settlement, riders, rates, users) (bridge-franchise.js + bridge-status-tabs.js): partner-run hubs, each a hub marked Franchise
 * (Hubs & zones) with one Franchise user (made here or in Admin users & roles; Replace user suspends the old one). Add a franchise (or create one from an approved franchise application), commission rates (percent of the
 * delivery charge with a minimum, for pickup, delivery and return), suspend / reactivate, and the settlement settings
 * (DEDUCT or BILL, billing period). API: /franchises, /franchises/config, /franchises/applications.
 */
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@panel/lib/api";
import { localPhone } from "@panel/lib/format";
import { confirm, openCustom, openForm, type FormField } from "@panel/ui/dialogs";
import { queryClient } from "@panel/lib/queryClient";
import { Button, Panel, Pill } from "@panel/ui/kit";
import { toast, toastError } from "@panel/ui/toast";
import { DialogFrame, useCatalog, type Catalog } from "@/lib/admin";
import { accountFields, passwordProblem } from "@panel/ui/AccountFields";

interface Rates {
  pickupPercent: number;
  pickupMin: number;
  deliveryPercent: number;
  deliveryMin: number;
  returnPercent: number;
  returnMin: number;
}
export interface Franchise {
  id: string;
  code: string;
  name: string;
  contactName: string;
  contactPhone: string;
  contactEmail?: string | null;
  /** The franchise's sign-in account. */
  owner?: { id: string; name: string; phone: string; email: string | null; status: string; lastLoginAt: string | null } | null;
  /** Every Franchise user of the hub (a hub can have several). */
  users?: { id: string; name: string; phone: string; email: string | null; status: string; lastLoginAt: string | null }[];
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

/** Suspend or reactivate a franchise (Hubs & zones › its row). */
export async function toggleFranchise(f: Franchise, reload: () => Promise<unknown>) {
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

/** Franchise applications approved in Support (Hubs & zones): create their franchise. Nothing when there are none. */
export function FranchiseApplications({ reload }: { reload: () => Promise<unknown> }) {
  const catalog = useCatalog();
  const q = useQuery({ queryKey: ["admin", "franchises", "applications"], queryFn: () => api<Application[]>("/franchises/applications").catch(() => []) });
  const applications = q.data ?? [];
  if (!applications.length) return null;
  const done = () => Promise.all([reload(), q.refetch()]);
  return (
    <div style={{ marginBottom: 16 }}>
      <Panel title="Approved franchise applications" subtitle="Approved in Support: create their franchise (the applicant's account becomes the Franchise user).">
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
                    <Button size="sm" variant="primary" onClick={() => void openCreate(a, catalog.data, done)}>
                      Create franchise
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}


/** Franchise commission settlement (Hubs & zones › Franchise hubs › Settlement settings). */
export async function openSettlement() {
  const config = await api<Config>("/franchises/config").catch(e => {
    toastError(e);
    return null;
  });
  if (!config) return;
  await openCustom(close => <Settlement config={config} close={() => close()} />);
}

function Settlement({ config, close }: { config: Config; close: () => void }) {
  const [mode, setMode] = useState(config.settlementMode);
  const [period, setPeriod] = useState(String(config.billingPeriodDays));
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const c = await api<Config>("/franchises/config", { method: "PUT", body: { settlementMode: mode, billingPeriodDays: Number(period) || 30 } });
      await queryClient.invalidateQueries({ queryKey: ["admin", "franchises"] });
      close();
      toast(mode === "DEDUCT" ? "Franchises now keep their commission when they deposit." : `Finance now bills franchise commission every ${c.billingPeriodDays} days.`, "good");
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }
  const choice = (value: "DEDUCT" | "BILL", title: string, text: string) => (
    <label className={`radio-card${mode === value ? " on" : ""}`}>
      <input type="radio" name="frMode" value={value} checked={mode === value} onChange={() => setMode(value)} />
      <span>
        <strong>{title}</strong>
        <small>{text}</small>
      </span>
    </label>
  );
  return (
    <form onSubmit={e => void save(e)}>
      <DialogFrame
        title="Franchise settlement"
        subtitle="How every franchise gets its commission."
        close={close}
        foot={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy}>
              Save settlement
            </Button>
          </>
        }
      >
        <div className="radio-cards">
          {choice("DEDUCT", "Deduct when depositing", "A franchise keeps its commission from the cash it deposits at a hub.")}
          {choice("BILL", "Bill and pay", "Franchises deposit everything; finance invoices the commission and pays it.")}
        </div>
        {mode === "BILL" ? (
          <label className="field" style={{ marginTop: 12, maxWidth: 220 }}>
            <span>Billing period (days)</span>
            <input id="frPeriod" className="input" type="number" min={1} max={92} value={period} onChange={e => setPeriod(e.target.value)} />
          </label>
        ) : null}
      </DialogFrame>
    </form>
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

export async function openCreate(application: Application | null, catalog: Catalog | undefined, reload: () => Promise<unknown>) {
  // Hubs marked as franchise hubs (Hubs & zones) that have no Franchise user yet: one user per hub.
  const hubs = (await api<{ id: string; name: string; code: string; district: string; type?: string; active?: boolean; franchiseHub?: boolean; franchise?: unknown }[]>("/hubs").catch(() => [])).filter(
    h => h.active !== false && (h.franchiseHub || h.type === "FRANCHISE") && !h.franchise,
  );
  await openForm({
    title: application ? `Create franchise · ${application.number}` : "Add franchise",
    description: application
      ? `${application.applicant?.name || "The applicant"}'s account becomes the franchise account; they sign in as before and land in the franchise panel.`
      : "The Franchise user of a franchise hub (an existing user keeps their sign-in; a new one signs in with this mobile: a code by SMS, or the password you set). Mark a hub as a franchise hub in Hub › Hubs & zones.",
    submit: "Save",
    wide: true,
    fields: [
      { id: "contactName", label: "Contact person", required: true, maxLength: 120, value: application?.applicant?.name || "" },
      ...(application ? [] : [{ id: "phone", label: "Account mobile", type: "phone", required: true, placeholder: "01XXXXXXXXX" } as FormField]),
      { id: "email", label: "Email", type: "email", value: application?.applicant?.email || "" },
      { id: "hubHead", label: "The hub", type: "static", render: null },
      ...(hubs.length
        ? []
        : [{ id: "noHub", label: "", type: "static", full: true, render: <div className="callout warn">No franchise hub is free: mark a hub as Franchise hub in Hub › Hubs & zones (Add or Edit), then come back.</div> } as FormField]),
      {
        id: "hubId",
        label: "Franchise hub",
        type: "select",
        required: true,
        full: true,
        hint: "Only franchise hubs without a Franchise user. From now on it works as a franchise hub: its riders become the franchise's riders (only for this hub).",
        options: [{ value: "", label: "Choose the hub" }, ...hubs.map(h => ({ value: h.id, label: `${h.name} (${h.code}) · ${h.district}` }))],
      },
      ...rateFields(),
      { id: "accountHead", label: "Sign-in", type: "static", render: null },
      ...accountFields(v => ({ kind: "franchise", name: v.contactName, franchiseName: v.name, hubId: v.hubId || undefined }), {
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
          contactName: v.contactName.trim(),
          phone: v.phone || undefined,
          email: v.email?.trim() || undefined,
          hubId: v.hubId,
          rates: readRates(v),
          sendSms: v.sendSms === "true",
          password: v.password || undefined,
        },
      });
      await reload();
      const done = `${f.hub.name} is now run by ${f.name} (${f.code}).`;
      const account = f.messageSent
        ? " The sign-in message was sent."
        : ` No message was sent: share the sign-in details yourself${f.passwordSet ? " (mobile and the password you set)" : v.password && !f.newAccount ? "; the existing account kept its own password" : ""}.`;
      return done + account;
    },
  });
}

/** The franchise's riders (they work only for its hub; super admin › Riders lists the company's). */
export async function openRiders(f: Franchise) {
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

export async function openEdit(f: Franchise, reload: () => Promise<unknown>) {
  await openForm({
    title: `Commission · ${f.name}`,
    description: `${f.hub.name} (${f.code}). New rates apply to parcel events from now on.`,
    submit: "Save",
    wide: true,
    fields: [{ id: "contactName", label: "Contact person", required: true, maxLength: 120, value: f.contactName }, ...rateFields(f.rates)],
    onSubmit: async v => {
      await api(`/franchises/${f.id}`, { method: "PATCH", body: { contactName: v.contactName.trim(), rates: readRates(v) } });
      await reload();
      return "Commission saved.";
    },
  });
}
