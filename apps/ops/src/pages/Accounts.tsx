/**
 * Accounts (bridge-accounts.js, bridge-accounts-badges.js, bridge-rider-pay.js, bridge-franchise.js):
 *   Overview       where the cash is, settlements to pay, payments to confirm (money staff)
 *   E-commerce / Customer   accounts → open one: Settle (ST-, PDF, mark paid with a receipt), adjustments, parcels,
 *                  being paid, paid history, statement (+ PDF)
 *   Financial      merchants → Generate bill (INV-), record / confirm / reject payments (PAY-), void bills, adjustments
 *   Rider cash     scan a rider's slip (HS-), count and receive; make a slip for a rider without a phone; slips waiting,
 *                  received, dues
 *   Hub transfers  cash on hand per hub → send to the central hub (HT-, proof); in transit → receive / cancel
 *   Rider pay      prepare payouts, approve (someone else), mark paid
 *   Franchise      franchise deposits to receive; commission invoices to approve and pay; bill due franchises
 * Each tab shows what waits there (GET /accounts/tab-counts). Live: account.updated, cash.slip, cash.transfer.
 */
import { Select } from "@panel/ui/Select";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiRaw, describe } from "@panel/lib/api";
import { useAuth } from "@panel/lib/auth";
import { useLive } from "@panel/lib/events";
import { localPhone } from "@panel/lib/format";
import { useOps } from "@/lib/ops";
import { Button, Empty, PageHeading, Pill, useDebounced } from "@panel/ui/kit";
import { confirm, openForm, prompt } from "@panel/ui/dialogs";
import { toast } from "@panel/ui/toast";
import ViewTabs from "@/app/ViewTabs";
import { moneyStaff } from "@/app/nav";
import { openDocument } from "@/features/parcels/actions";
import { ScanInput, type ScanInputHandle } from "@/features/scan/scanner";
import ReceiptPicker, { type ReceiptValue } from "@/features/accounts/ReceiptPicker";

const tk = (n: unknown) => `৳${Number(n || 0).toLocaleString("en-BD", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dhaka" }) : "—");
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Dhaka" }) : "—");
const today = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;
const METHODS: [string, string][] = [
  ["BKASH", "bKash"],
  ["NAGAD", "Nagad"],
  ["ROCKET", "Rocket"],
  ["BANK", "Bank transfer"],
  ["CASH", "Cash"],
  ["OTHER", "Other"],
];
const methodLabel = (m?: string) => (METHODS.find(x => x[0] === m) || [m, m])[1];
const qs = (o: Record<string, unknown>) =>
  Object.entries(o)
    .filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
type Kind = "ECOMMERCE" | "FINANCIAL" | "CUSTOMER";
const KIND_OF_TAB: Record<string, Kind> = { "E-commerce": "ECOMMERCE", Financial: "FINANCIAL", Customer: "CUSTOMER" };
const KIND_LABEL: Record<Kind, string> = { ECOMMERCE: "E-commerce", FINANCIAL: "Financial", CUSTOMER: "Customer" };
const PAYOUT_PILL: Record<string, [string, "warn" | "good" | "neutral"]> = { UNPAID: ["To pay", "warn"], PAID: ["Paid", "good"], CANCELLED: ["Cancelled", "neutral"] };
const BILL_PILL: Record<string, [string, "warn" | "info" | "good" | "neutral"]> = { ISSUED: ["Unpaid", "warn"], PARTLY_PAID: ["Partly paid", "info"], PAID: ["Paid", "good"], VOID: ["Void", "neutral"] };
const PAYMENT_PILL: Record<string, [string, "warn" | "good" | "bad"]> = { PENDING: ["To confirm", "warn"], CONFIRMED: ["Confirmed", "good"], REJECTED: ["Rejected", "bad"] };
const pill = (map: Record<string, [string, string]>, s: string) => {
  const [text, tone] = map[s] || [s, "neutral"];
  return <Pill tone={tone as "good"}>{text}</Pill>;
};
interface PayTo {
  method: string;
  accountName?: string;
  accountNumber?: string;
  bankName?: string;
}
const payToText = (p?: PayTo | null) => (p ? `${methodLabel(p.method)} · ${p.accountName || ""} · ${p.accountNumber || ""}${p.bankName ? ` · ${p.bankName}` : ""}` : "No payout account on file");
/** ৳850 · ৳12.4k · ৳3.2L (lakh) · ৳1.1Cr for tab badges. */
const short = (n: number) => {
  const v = Math.abs(Number(n) || 0);
  const f = (x: number, s: string) => `৳${(Math.round(x * 10) / 10).toLocaleString("en-US")}${s}`;
  return v >= 1e7 ? f(v / 1e7, "Cr") : v >= 1e5 ? f(v / 1e5, "L") : v >= 1e3 ? f(v / 1e3, "k") : `৳${Math.round(v).toLocaleString("en-US")}`;
};

function useMoneyInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ["acc"] });
}

export default function Accounts({ tab }: { tab: string }) {
  const qc = useQueryClient();
  useLive(["account.updated", "cash.slip", "cash.transfer"], () => void qc.invalidateQueries({ queryKey: ["acc"] }));
  useLive(["rider.payout"], () => void qc.invalidateQueries({ queryKey: ["acc", "rider-payouts"] }));
  useLive(["franchise.cash"], () => void qc.invalidateQueries({ queryKey: ["acc", "franchise"] }));
  const counts = useQuery({ queryKey: ["acc", "tab-counts"], queryFn: () => api<Record<string, { count?: number; amount?: number; hint?: string }>>("/accounts/tab-counts"), staleTime: 15_000, retry: false });
  useLive(["parcel.updated"], () => void counts.refetch(), { debounceMs: 3000, fallbackMs: 120_000 });
  const badges = Object.fromEntries(
    ["Financial", "E-commerce", "Customer", "Rider cash", "Hub transfers", "Rider pay", "Franchise"].map(t => {
      const c = counts.data?.[t];
      return [
        t,
        c && (c.count || c.amount)
          ? {
              title: c.hint || "",
              badge: (
                <span style={{ display: "inline-flex", gap: 4, alignItems: "center", marginLeft: 6 }}>
                  {c.count ? <span style={{ minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999, background: "#f04438", color: "#fff", fontSize: 11, fontWeight: 700, lineHeight: "18px", textAlign: "center" }}>{c.count > 99 ? "99+" : c.count}</span> : null}
                  {c.amount ? <span style={{ fontSize: 11.5, fontWeight: 650, color: "var(--muted)" }}>{short(c.amount)}</span> : null}
                </span>
              ),
            }
          : { title: c?.hint },
      ];
    }),
  );
  const tabs = <ViewTabs view="Accounts" tab={tab} badges={badges} />;
  const kind = KIND_OF_TAB[tab];
  return (
    <>
      {tab === "Overview" ? <Overview tabs={tabs} /> : kind ? <AccountList kind={kind} tabs={tabs} /> : tab === "Rider cash" ? <RiderCash tabs={tabs} /> : tab === "Hub transfers" ? <HubTransfers tabs={tabs} /> : tab === "Rider pay" ? <RiderPay tabs={tabs} /> : <Franchise tabs={tabs} />}
    </>
  );
}

function useMoney() {
  const ops = useOps();
  const config = useQuery({ queryKey: ["accounts", "config"], queryFn: () => api<{ centralHub?: { id: string; name: string } | null }>("/accounts/config"), staleTime: 120_000, retry: false });
  const central = config.data?.centralHub ?? null;
  const staff = moneyStaff({ ...ops.menu, centralHubId: central?.id ?? null });
  const noCentral = config.data && !central ? (
    <div className="callout warn">
      <span>
        <strong>No central hub yet.</strong> A super admin chooses it in Super admin › Global notifications › Accounts. Until then cash can be received at hubs but not sent on or settled.
      </span>
    </div>
  ) : null;
  return { central, staff, noCentral, cashStaff: ops.can("receiveCash") };
}

const Card = ({ label, value, foot, tone }: { label: string; value: ReactNode; foot?: ReactNode; tone?: "key" | "due" | "good" }) => (
  <div className="metric" style={tone === "key" ? { borderColor: "var(--primary-line)", background: "linear-gradient(180deg, #f5f8ff, #fff)" } : undefined}>
    <div className="metric-head">
      <span>{label}</span>
    </div>
    <div className="metric-value" style={{ color: tone === "key" ? "var(--primary)" : tone === "due" ? "var(--bad)" : tone === "good" ? "var(--good)" : undefined }}>
      {value}
    </div>
    {foot ? <div className="metric-foot"><span>{foot}</span></div> : null}
  </div>
);

function Box({ title, sub, tools, children }: { title: string; sub?: ReactNode; tools?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2 className="panel-title">{title}</h2>
          {sub ? <p className="panel-subtitle">{sub}</p> : null}
        </div>
        {tools ? <div className="tools">{tools}</div> : null}
      </div>
      <div className="table-wrap" style={{ maxHeight: 560 }}>
        {children}
      </div>
    </section>
  );
}
const EmptyRow = ({ cols, text }: { cols: number; text: string }) => (
  <tr>
    <td colSpan={cols} className="empty">
      {text}
    </td>
  </tr>
);
const loadingText = (q: { isLoading: boolean; isError: boolean; error: unknown }, text: string) => (q.isError ? describe(q.error) : q.isLoading ? "Loading…" : text);

// ───────────── Overview ─────────────

interface Payout {
  id: string;
  number: string;
  parcels: number;
  account: { id: string; name: string; kind: Kind };
  amount: number;
  codTotal: number;
  chargesTotal: number;
  payTo?: PayTo | null;
  createdAt: string;
  status: string;
  paidAt?: string | null;
  method?: string;
  reference?: string | null;
  receipt?: { fileId: string } | null;
}
interface Payment {
  id: string;
  number: string;
  bills: { number: string; amount: number }[];
  account: { id: string; name: string };
  amount: number;
  credit: number;
  method: string;
  reference?: string | null;
  paidOn: string;
  status: string;
  rejectReason?: string | null;
  receipt?: { fileId: string } | null;
}

function Overview({ tabs }: { tabs: ReactNode }) {
  const m = useMoney();
  const o = useQuery({ queryKey: ["acc", "overview"], queryFn: () => api<{ cash: Record<string, { amount: number; count: number }>; unpaidPayouts: { amount: number; count: number }; financialDue: number }>("/accounts/overview"), enabled: m.staff });
  const unpaid = useQuery({ queryKey: ["acc", "unpaid"], queryFn: async () => (await api<{ items: Payout[] }>("/payouts?status=UNPAID")).items, enabled: m.staff });
  const pending = useQuery({ queryKey: ["acc", "pending"], queryFn: async () => (await api<{ items: Payment[] }>("/payments?status=PENDING")).items, enabled: m.staff });
  if (!m.staff)
    return (
      <>
        <PageHeading eyebrow="Money" title="Accounts" subtitle="Rider cash and hub transfers." />
        {tabs}
        <div className="callout warn">Open Rider cash or Hub transfers.</div>
      </>
    );
  const c = o.data?.cash || {};
  const v = (s: string) => (c[s] ? tk(c[s].amount) : "—");
  const n = (s: string) => (c[s] ? `${c[s].count} parcel${c[s].count === 1 ? "" : "s"}` : "");
  return (
    <>
      <PageHeading eyebrow="Money" title="Accounts" subtitle={`Where the money is now. Central hub: ${m.central?.name || "not set"}.`} />
      {tabs}
      <div className="stack-lg">
        {m.noCentral}
        <div className="metrics" style={{ marginBottom: 0 }}>
          <Card label="With riders" value={v("WITH_RIDER")} foot={n("WITH_RIDER")} />
          <Card label="At hubs" value={v("AT_HUB")} foot={`${n("AT_HUB")} · to send on`} />
          <Card label="In transit" value={v("IN_TRANSIT")} foot={n("IN_TRANSIT")} />
          <Card label="At central hub" value={v("AT_CENTRAL")} foot={`${n("AT_CENTRAL")} · ready to settle`} tone="key" />
          <Card label="Settlements to pay" value={o.data ? tk(o.data.unpaidPayouts.amount) : "—"} foot={o.data ? `${o.data.unpaidPayouts.count} settlement(s)` : ""} tone={o.data?.unpaidPayouts.count ? "due" : undefined} />
          <Card label="Financial merchants owe" value={o.data ? tk(o.data.financialDue) : "—"} foot="billed and not billed" />
        </div>
        <Box title="Settlements to pay" sub="Created and waiting for the money to be sent. Mark paid with the reference and a receipt photo.">
          <table className="table">
            <thead>
              <tr>
                <th>Settlement</th>
                <th>Account</th>
                <th className="num">Net</th>
                <th>Pay to</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {unpaid.data?.length ? (
                unpaid.data.map(p => (
                  <tr key={p.id}>
                    <td>
                      <span className="strong">{p.number}</span>
                      <span className="sub">{p.parcels} parcel(s)</span>
                    </td>
                    <td>
                      {p.account.name}
                      <span className="sub">{KIND_LABEL[p.account.kind] || ""}</span>
                    </td>
                    <td className="num strong">{tk(p.amount)}</td>
                    <td>{payToText(p.payTo)}</td>
                    <td className="nowrap">{when(p.createdAt)}</td>
                    <td>
                      <div className="row-actions">
                        <Button size="sm" onClick={() => openDocument(`/documents/payout/${p.id}`, { title: "Preparing the settlement…" })}>
                          PDF
                        </Button>
                        <PayPayoutButton id={p.id} />
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <EmptyRow cols={6} text={loadingText(unpaid, "Nothing waiting to be paid.")} />
              )}
            </tbody>
          </table>
        </Box>
        <Box title="Payments to confirm" sub="Financial merchants said they paid. Check your bank / wallet, then confirm or reject.">
          <table className="table">
            <thead>
              <tr>
                <th>Payment</th>
                <th>Merchant</th>
                <th className="num">Amount</th>
                <th>How</th>
                <th>Paid on</th>
                <th />
              </tr>
            </thead>
            <tbody>{pending.data?.length ? pending.data.map(p => <PaymentRow key={p.id} p={p} withAccount staff />) : <EmptyRow cols={6} text={loadingText(pending, "No payments to confirm.")} />}</tbody>
          </table>
        </Box>
      </div>
    </>
  );
}

function openFile(id: string) {
  const tab = window.open("", "_blank");
  apiRaw(`/files/${encodeURIComponent(id)}`)
    .then(r => r.blob())
    .then(blob => {
      const url = URL.createObjectURL(blob);
      if (tab) tab.location.href = url;
      else window.open(url, "_blank");
    })
    .catch(e => (tab?.close(), toast(describe(e), "bad")));
}

function PayPayoutButton({ id }: { id: string }) {
  const invalidate = useMoneyInvalidate();
  return (
    <Button size="sm" variant="primary" onClick={() => payPayout(id, invalidate)}>
      Mark paid
    </Button>
  );
}

async function payPayout(id: string, invalidate: () => void) {
  const p = await api<Payout>(`/payouts/${id}`);
  const receipt: ReceiptValue = { dataUrl: null };
  await openForm({
    title: `Mark ${p.number} paid`,
    description: `${tk(p.amount)} to ${p.account.name} · ${payToText(p.payTo)}`,
    submit: "Mark paid",
    wide: true,
    fields: [
      { id: "method", label: "Paid by", type: "select", required: true, value: p.payTo?.method === "BANK" ? "BANK" : p.payTo?.method || "BKASH", options: METHODS.map(([value, label]) => ({ value, label })) },
      { id: "reference", label: "Transaction ID / reference", maxLength: 120, placeholder: "e.g. 9KX2…" },
      { id: "proof", label: "Receipt photo", type: "static", render: <ReceiptPicker title={`Payment receipt · ${p.number}`} value={receipt} /> },
    ],
    onSubmit: async v => {
      const done = await api<Payout>(`/payouts/${id}/pay`, { method: "POST", body: { method: v.method, reference: v.reference || undefined, proof: receipt.dataUrl || undefined } });
      invalidate();
      return `${done.number} paid. The ${done.account.kind === "CUSTOMER" ? "customer" : "merchant"} sees it with the receipt.`;
    },
  });
}

function PaymentRow({ p, withAccount = false, staff }: { p: Payment; withAccount?: boolean; staff: boolean }) {
  const invalidate = useMoneyInvalidate();
  return (
    <tr>
      <td>
        <span className="strong">{p.number}</span>
        {p.bills.length ? <span className="sub">{p.bills.map(b => `${b.number} ${tk(b.amount)}`).join(", ")}</span> : null}
      </td>
      {withAccount ? <td>{p.account.name}</td> : null}
      <td className="num">
        <strong>{tk(p.amount)}</strong>
        {p.credit > 0 ? <span className="sub">credit {tk(p.credit)}</span> : null}
      </td>
      <td>
        {methodLabel(p.method)}
        {p.reference ? <span className="sub">{p.reference}</span> : null}
      </td>
      <td className="nowrap">{p.paidOn}</td>
      {withAccount ? null : (
        <td>
          {pill(PAYMENT_PILL, p.status)}
          {p.rejectReason ? <span className="sub">{p.rejectReason}</span> : null}
        </td>
      )}
      <td>
        <div className="row-actions">
          {p.receipt ? (
            <Button size="sm" onClick={() => openFile(p.receipt!.fileId)}>
              Receipt
            </Button>
          ) : null}
          {staff && p.status === "PENDING" ? (
            <>
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  const reason = await prompt({ title: `Reject ${p.number}?`, message: "The merchant is told why.", label: "Reason", multiline: true, ok: "Reject" });
                  if (!reason) return;
                  const done = await api<Payment>(`/payments/${p.id}/reject`, { method: "POST", body: { reason } });
                  toast(`${done.number} rejected.`);
                  invalidate();
                }}
              >
                Reject
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={async () => {
                  const done = await api<Payment>(`/payments/${p.id}/confirm`, { method: "POST" });
                  toast(`${done.number} confirmed: ${tk(done.amount)}.`, "good");
                  invalidate();
                }}
              >
                Confirm
              </Button>
            </>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

// ───────────── account lists and one account ─────────────

interface AccountRow {
  id: string;
  name: string;
  code?: string | null;
  phone?: string | null;
  ready: number;
  balance: number;
  notBilled: number;
  due: number;
  parcels: number;
  lastActivity?: string | null;
}
const opened: Record<Kind, string | null> = { ECOMMERCE: null, FINANCIAL: null, CUSTOMER: null };

function AccountList({ kind, tabs }: { kind: Kind; tabs: ReactNode }) {
  const m = useMoney();
  const [open, setOpen] = useState<string | null>(opened[kind]);
  useEffect(() => void (opened[kind] = open), [open, kind]);
  const [q, setQ] = useState("");
  const list = useQuery({ queryKey: ["acc", "list", kind], queryFn: () => api<{ items: AccountRow[]; totals?: { due?: number; ready?: number; accounts?: number } }>(`/accounts?${qs({ kind })}`), enabled: m.staff && !open });
  const subtitle = {
    ECOMMERCE: "Merchants' COD less charges. Open a merchant to settle what's ready (cash at the central hub).",
    FINANCIAL: "Banking & financial merchants: their delivery and return charges. Open one to bill parcels and record payments.",
    CUSTOMER: "Senders of COD parcels from the website. Open one to settle what's ready.",
  }[kind];
  if (!m.staff)
    return (
      <>
        <PageHeading eyebrow="Money" title={`${KIND_LABEL[kind]} accounts`} subtitle={subtitle} />
        {tabs}
        <div className="callout warn">Only finance, operations managers and central hub staff see merchants' accounts.</div>
      </>
    );
  if (open) return <AccountPage kind={kind} id={open} back={() => setOpen(null)} tabs={tabs} />;
  const fin = kind === "FINANCIAL";
  const t = q.toLowerCase();
  const items = (list.data?.items || []).filter(a => !t || `${a.name} ${a.code || ""} ${a.phone || ""}`.toLowerCase().includes(t));
  const totals = list.data?.totals;
  return (
    <>
      <PageHeading eyebrow="Money" title={`${KIND_LABEL[kind]} accounts`} subtitle={subtitle} />
      {tabs}
      <div className="stack-lg">
        {m.noCentral}
        <div className="metrics" style={{ marginBottom: 0 }}>
          {fin ? (
            <>
              <Card label="Merchants owe" value={totals ? tk(totals.due) : "—"} foot={`${totals?.accounts ?? "—"} merchant(s)`} tone="due" />
              <Card label="Not billed yet" value={tk(items.reduce((s, a) => s + a.notBilled, 0))} foot="charges waiting for a bill" />
            </>
          ) : (
            <>
              <Card label="Ready to pay" value={totals ? tk(totals.ready) : "—"} foot={`${items.filter(a => a.ready > 0).length} account(s) ready`} tone="key" />
              <Card label="Accounts" value={String(totals?.accounts ?? "—")} foot="with parcels" />
            </>
          )}
        </div>
        <Box
          title={`${KIND_LABEL[kind]} accounts`}
          sub={fin ? "Largest due first. Click a merchant to open it." : 'Largest ready amount first. "Owed in all" includes cash still with riders or on its way.'}
          tools={<input className="input sm" type="search" placeholder="Search name, code or phone" aria-label="Search accounts" value={q} onChange={e => setQ(e.target.value)} style={{ width: 230 }} />}
        >
          <table className="table">
            <thead>
              {fin ? (
                <tr>
                  <th>Merchant</th>
                  <th className="num">Not billed</th>
                  <th className="num">Due</th>
                  <th className="num">Parcels</th>
                  <th>Last activity</th>
                </tr>
              ) : (
                <tr>
                  <th>{kind === "CUSTOMER" ? "Customer" : "Merchant"}</th>
                  <th className="num">Ready to pay</th>
                  <th className="num">Owed in all</th>
                  <th className="num">Parcels</th>
                  <th>Last activity</th>
                </tr>
              )}
            </thead>
            <tbody>
              {items.length ? (
                items.map(a => (
                  <tr key={a.id} style={{ cursor: "pointer" }} onClick={() => setOpen(a.id)} tabIndex={0} onKeyDown={e => e.key === "Enter" && setOpen(a.id)}>
                    <td>
                      <span className="strong">{a.name}</span>
                      <span className="sub">{a.code || localPhone(a.phone) || ""}</span>
                    </td>
                    {fin ? (
                      <>
                        <td className="num">{tk(a.notBilled)}</td>
                        <td className="num strong" style={{ color: a.due > 0 ? "var(--bad)" : undefined }}>
                          {tk(a.due)}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="num strong" style={{ color: a.ready > 0 ? "var(--primary)" : undefined }}>
                          {tk(a.ready)}
                        </td>
                        <td className="num">{tk(a.balance)}</td>
                      </>
                    )}
                    <td className="num">{a.parcels}</td>
                    <td className="nowrap">{when(a.lastActivity)}</td>
                  </tr>
                ))
              ) : (
                <EmptyRow cols={5} text={loadingText(list, list.data ? "No accounts yet: they appear when parcels are delivered." : "Loading…")} />
              )}
            </tbody>
          </table>
        </Box>
      </div>
    </>
  );
}

interface Account {
  id: string;
  kind: Kind;
  name: string;
  code?: string | null;
  phone?: string | null;
  payTo?: PayTo | null;
  financial: { due: number; notBilled: number; billedDue: number; openAdjustments: number; credit: number; unpaidBills: { amount: number; count: number }; pending: { count: number }; lastPayment?: { amount: number; paidOn: string; number: string } | null; paidThisMonth: number };
  cod: { ready: number; withRider: number; atHubs: number; inSettlement: number; unpaidSettlements: number; lastPayout?: { amount: number; paidAt: string; number: string } | null; paidThisMonth: number };
}
const dueParts = (f: Account["financial"]) =>
  [`not billed ${tk(f.notBilled)}`, f.billedDue ? `+ unpaid bills ${tk(f.billedDue)}` : "", f.openAdjustments ? `${f.openAdjustments > 0 ? "−" : "+"} adjustments ${tk(Math.abs(f.openAdjustments))}` : "", f.credit ? `− credit ${tk(f.credit)}` : ""].filter(Boolean).join(" ");

function AccountPage({ kind, id, back, tabs }: { kind: Kind; id: string; back: () => void; tabs: ReactNode }) {
  const m = useMoney();
  const invalidate = useMoneyInvalidate();
  const q = useQuery({ queryKey: ["acc", "account", id], queryFn: () => api<Account>(`/accounts/${id}`) });
  const fin = kind === "FINANCIAL";
  const subs: [string, string][] = fin
    ? [
        ["parcels", "Parcels"],
        ["documents", "Bills"],
        ["payments", "Payments"],
        ["statement", "Statement"],
      ]
    : [
        ["parcels", "Parcels"],
        ["documents", "Being paid"],
        ["history", "Paid history"],
        ["statement", "Statement"],
      ];
  const [sub, setSub] = useState("parcels");
  const [stmt, setStmt] = useState({ from: monthStart(), to: today() });
  const a = q.data;
  const backButton = (
    <button type="button" className="link-button" onClick={back}>
      ← All {KIND_LABEL[kind]} accounts
    </button>
  );
  if (!a)
    return (
      <>
        <PageHeading eyebrow="Money" title={`${KIND_LABEL[kind]} account`} />
        {tabs}
        {backButton}
        <Empty>{q.isError ? describe(q.error) : "Loading…"}</Empty>
      </>
    );
  const f = a.financial;
  const c = a.cod;
  return (
    <>
      <PageHeading eyebrow="Money" title={`${KIND_LABEL[kind]} account`} subtitle={`${a.name}${a.code ? ` · ${a.code}` : a.phone ? ` · ${localPhone(a.phone)}` : ""}`} />
      {tabs}
      <div className="stack-lg">
        {backButton}
        <div className="page-heading" style={{ marginBottom: 0 }}>
          <div>
            <h2 style={{ fontSize: 20 }}>{a.name}</h2>
            <p className="subtitle">{fin ? "Financial merchant · billed for delivery and return charges" : `Pays to: ${payToText(a.payTo)}`}</p>
          </div>
          <div className="heading-actions">
            {m.staff ? (
              fin ? (
                <>
                  <Button variant="primary" onClick={() => newBill(a, invalidate, () => setSub("documents"))}>
                    Generate bill
                  </Button>
                  <Button onClick={() => newPayment(a, invalidate)}>Record payment</Button>
                  <Button onClick={() => adjust(a, invalidate)}>Adjustment</Button>
                </>
              ) : (
                <>
                  <Button variant="primary" onClick={() => settle(a, invalidate, () => setSub("documents"))}>
                    Settle
                  </Button>
                  <Button onClick={() => adjust(a, invalidate)}>Adjustment</Button>
                </>
              )
            ) : null}
            <Button icon="print" onClick={() => openDocument(`/documents/account-statement/${a.id}?${qs(stmt)}`, { title: "Preparing the statement…" })}>
              Statement PDF
            </Button>
          </div>
        </div>
        <div className="metrics" style={{ marginBottom: 0 }}>
          {fin ? (
            <>
              <Card label="Due now" value={tk(f.due)} foot={dueParts(f)} tone={f.due > 0 ? "due" : "good"} />
              <Card label="Not billed" value={tk(f.notBilled)} foot="charges waiting for a bill" />
              <Card label="Unpaid bills" value={tk(f.unpaidBills.amount)} foot={`${f.unpaidBills.count} bill(s)${f.pending.count ? ` · ${f.pending.count} payment(s) to confirm` : ""}`} />
              <Card label="Last payment" value={f.lastPayment ? tk(f.lastPayment.amount) : "—"} foot={f.lastPayment ? `${day(f.lastPayment.paidOn)} · ${f.lastPayment.number} · this month ${tk(f.paidThisMonth)}` : "no payment yet"} />
              {f.openAdjustments ? <Card label="Adjustments" value={`${f.openAdjustments > 0 ? "−" : "+"}${tk(Math.abs(f.openAdjustments))}`} foot={f.openAdjustments > 0 ? "credit, on the next bill" : "extra charge, on the next bill"} /> : null}
            </>
          ) : (
            <>
              <Card label="Ready to pay" value={tk(c.ready)} foot="cash at the central hub, less charges" tone="key" />
              <Card label="With riders" value={tk(c.withRider)} foot="collected, not handed over" />
              <Card label="At hubs / on the way" value={tk(c.atHubs)} />
              <Card label="To pay" value={tk(c.inSettlement)} foot={c.unpaidSettlements ? `${c.unpaidSettlements} settlement(s) created, not paid` : "nothing waiting"} />
              <Card label="Last settlement" value={c.lastPayout ? tk(c.lastPayout.amount) : "—"} foot={c.lastPayout ? `${day(c.lastPayout.paidAt)} · ${c.lastPayout.number} · this month ${tk(c.paidThisMonth)}` : "nothing paid yet"} />
            </>
          )}
        </div>
        <div className="tabs" role="tablist" style={{ marginBottom: 0 }}>
          {subs.map(([k, l]) => (
            <button key={k} type="button" role="tab" className="tab" aria-selected={sub === k} onClick={() => setSub(k)}>
              {l}
            </button>
          ))}
        </div>
        {sub === "parcels" ? (
          <ParcelsBox a={a} />
        ) : sub === "documents" ? (
          fin ? (
            <BillsBox a={a} />
          ) : (
            <PayoutsBox a={a} view="open" />
          )
        ) : sub === "history" ? (
          <PayoutsBox a={a} view="history" />
        ) : sub === "payments" ? (
          <PaymentsBox a={a} />
        ) : (
          <StatementBox a={a} range={stmt} setRange={setStmt} />
        )}
      </div>
    </>
  );
}

interface AccParcel {
  parcelId: string;
  trackingId: string;
  orderRef?: string;
  recipient?: string;
  outcome: string;
  date: string;
  destination?: string;
  charge: number;
  returnCharge: number;
  cod: number;
  net: number;
  ready?: boolean;
  bill?: { number: string; status: string } | null;
  payout?: { number: string; status: string } | null;
  cash?: { label: string } | null;
}

function ParcelsBox({ a }: { a: Account }) {
  const fin = a.kind === "FINANCIAL";
  const [fl, setFl] = useState({ from: monthStart(), to: today(), q: "", status: "all" });
  const [typed, setTyped] = useState("");
  const dq = useDebounced(typed, 350);
  useEffect(() => setFl(f => ({ ...f, q: dq })), [dq]);
  const page = useQuery({ queryKey: ["acc", "parcels", a.id, fl], queryFn: () => api<{ items: AccParcel[]; truncated?: boolean }>(`/accounts/${a.id}/parcels?${qs(fl)}`) });
  const items = page.data?.items || [];
  const options: [string, string][] = fin
    ? [
        ["all", "All"],
        ["not_billed", "Not billed"],
        ["billed", "Billed, unpaid"],
        ["paid", "Paid"],
      ]
    : [
        ["all", "All"],
        ["ready", "Ready to pay"],
        ["open", "Not settled"],
        ["settled", "Settled"],
      ];
  const sum = items.reduce((t, p) => t + (fin ? p.charge + p.returnCharge : p.net), 0);
  return (
    <Box
      title="Parcels"
      sub={`${items.length} parcel(s) delivered or returned in these dates · ${fin ? "charges" : "net"} ${tk(sum)}${page.data?.truncated ? " · showing the first 2000: narrow the dates" : ""}`}
      tools={
        <>
          <input className="input sm" type="date" aria-label="From" value={fl.from} onChange={e => setFl(f => ({ ...f, from: e.target.value }))} />
          <input className="input sm" type="date" aria-label="To" value={fl.to} onChange={e => setFl(f => ({ ...f, to: e.target.value }))} />
          <Select className="select sm" aria-label="Status" value={fl.status} onChange={e => setFl(f => ({ ...f, status: e.target.value }))}>
            {options.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
          <input className="input sm" type="search" placeholder="Tracking ID" aria-label="Search tracking ID" value={typed} onChange={e => setTyped(e.target.value)} style={{ width: 150 }} />
        </>
      }
    >
      <table className="table">
        <thead>
          {fin ? (
            <tr>
              <th>Parcel</th>
              <th>Outcome</th>
              <th>Destination</th>
              <th className="num">Charge</th>
              <th>Bill</th>
            </tr>
          ) : (
            <tr>
              <th>Parcel</th>
              <th>Outcome</th>
              <th className="num">COD</th>
              <th className="num">Charges</th>
              <th className="num">Net</th>
              <th>Where / settlement</th>
            </tr>
          )}
        </thead>
        <tbody>
          {items.length ? (
            items.map(p => {
              const state = fin ? (
                p.bill ? (
                  <>
                    {pill(BILL_PILL, p.bill.status)}
                    <span className="sub">{p.bill.number}</span>
                  </>
                ) : (
                  <Pill tone="neutral">Not billed</Pill>
                )
              ) : p.payout ? (
                <>
                  {pill(PAYOUT_PILL, p.payout.status === "PAID" ? "PAID" : "UNPAID")}
                  <span className="sub">{p.payout.number}</span>
                </>
              ) : p.ready ? (
                <Pill>Ready</Pill>
              ) : (
                <Pill tone="neutral">{p.cash?.label || "Waiting"}</Pill>
              );
              return (
                <tr key={p.parcelId}>
                  <td>
                    <span className="strong">{p.trackingId}</span>
                    <span className="sub">{[p.orderRef, p.recipient].filter(Boolean).join(" · ")}</span>
                  </td>
                  <td>
                    {p.outcome}
                    <span className="sub">{day(p.date)}</span>
                  </td>
                  {fin ? (
                    <>
                      <td>{p.destination}</td>
                      <td className="num">{tk(p.charge + p.returnCharge)}</td>
                    </>
                  ) : (
                    <>
                      <td className="num">{tk(p.cod)}</td>
                      <td className="num">−{tk(p.charge + p.returnCharge)}</td>
                      <td className="num strong">{tk(p.net)}</td>
                    </>
                  )}
                  <td>{state}</td>
                </tr>
              );
            })
          ) : (
            <EmptyRow cols={fin ? 5 : 6} text={loadingText(page, "No parcels in these dates.")} />
          )}
        </tbody>
      </table>
    </Box>
  );
}

function PayoutsBox({ a, view }: { a: Account; view: "open" | "history" }) {
  const m = useMoney();
  const invalidate = useMoneyInvalidate();
  const [range, setRange] = useState({ from: monthStart(), to: today() });
  const query = view === "open" ? qs({ accountId: a.id, status: "UNPAID" }) : qs({ accountId: a.id, status: "PAID", ...range });
  const list = useQuery({ queryKey: ["acc", "payouts", a.id, query], queryFn: async () => (await api<{ items: Payout[] }>(`/payouts?${query}`)).items });
  return (
    <Box
      title={view === "open" ? "Being paid" : "Paid history"}
      sub={view === "open" ? "Settlements created and waiting for the money to be sent. Mark paid with the reference and a receipt photo." : "Settlements paid in these dates, with their receipts."}
      tools={
        view === "history" ? (
          <>
            <input className="input sm" type="date" aria-label="From" value={range.from} onChange={e => setRange(r => ({ ...r, from: e.target.value }))} />
            <input className="input sm" type="date" aria-label="To" value={range.to} onChange={e => setRange(r => ({ ...r, to: e.target.value }))} />
          </>
        ) : null
      }
    >
      <table className="table">
        <thead>
          <tr>
            <th>Settlement</th>
            <th>Created</th>
            <th className="num">COD</th>
            <th className="num">Charges</th>
            <th className="num">Net</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.data?.length ? (
            list.data.map(p => (
              <tr key={p.id}>
                <td>
                  <span className="strong">{p.number}</span>
                  <span className="sub">{p.parcels} parcel(s)</span>
                </td>
                <td className="nowrap">{when(p.createdAt)}</td>
                <td className="num">{tk(p.codTotal)}</td>
                <td className="num">−{tk(p.chargesTotal)}</td>
                <td className="num strong">{tk(p.amount)}</td>
                <td>
                  {pill(PAYOUT_PILL, p.status)}
                  {p.paidAt ? <span className="sub">{`${methodLabel(p.method)}${p.reference ? ` · ${p.reference}` : ""} · ${day(p.paidAt)}`}</span> : null}
                </td>
                <td>
                  <div className="row-actions">
                    <Button size="sm" onClick={() => openDocument(`/documents/payout/${p.id}`, { title: "Preparing the settlement…" })}>
                      PDF
                    </Button>
                    {p.receipt ? (
                      <Button size="sm" onClick={() => openFile(p.receipt!.fileId)}>
                        Receipt
                      </Button>
                    ) : null}
                    {m.staff && p.status === "UNPAID" ? (
                      <>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={async () => {
                            if (!(await confirm({ title: `Cancel ${p.number}?`, message: "Its parcels are ready to settle again.", ok: "Cancel settlement", cancel: "Keep it", danger: true }))) return;
                            const done = await api<Payout>(`/payouts/${p.id}/cancel`, { method: "POST" });
                            toast(`${done.number} cancelled.`);
                            invalidate();
                          }}
                        >
                          Cancel
                        </Button>
                        <PayPayoutButton id={p.id} />
                      </>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))
          ) : (
            <EmptyRow cols={7} text={loadingText(list, view === "open" ? "Nothing waiting to be paid." : "No settlements paid in these dates.")} />
          )}
        </tbody>
      </table>
    </Box>
  );
}

interface Bill {
  id: string;
  number: string;
  parcels: number;
  from: string;
  to: string;
  issuedAt: string;
  total: number;
  paid: number;
  due: number;
  status: string;
  voidReason?: string | null;
  account: { id: string };
}

function BillsBox({ a }: { a: Account }) {
  const m = useMoney();
  const invalidate = useMoneyInvalidate();
  const [view, setView] = useState("open");
  const [range, setRange] = useState({ from: monthStart(), to: today() });
  const query = view === "open" ? qs({ accountId: a.id, status: "UNPAID" }) : qs({ accountId: a.id, ...range });
  const list = useQuery({ queryKey: ["acc", "bills", a.id, query], queryFn: async () => (await api<{ items: Bill[] }>(`/bills?${query}`)).items });
  return (
    <Box
      title="Bills"
      sub={view === "open" ? "Unpaid and part-paid bills. Paid bills are history: choose All." : "Every bill issued in these dates."}
      tools={
        <>
          <Select className="select sm" aria-label="Show" value={view} onChange={e => setView(e.target.value)}>
            <option value="open">Unpaid</option>
            <option value="history">All (history)</option>
          </Select>
          {view === "history" ? (
            <>
              <input className="input sm" type="date" aria-label="From" value={range.from} onChange={e => setRange(r => ({ ...r, from: e.target.value }))} />
              <input className="input sm" type="date" aria-label="To" value={range.to} onChange={e => setRange(r => ({ ...r, to: e.target.value }))} />
            </>
          ) : null}
        </>
      }
    >
      <table className="table">
        <thead>
          <tr>
            <th>Bill</th>
            <th>Parcels delivered</th>
            <th className="num">Total</th>
            <th className="num">Paid</th>
            <th className="num">Due</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.data?.length ? (
            list.data.map(b => (
              <tr key={b.id}>
                <td>
                  <span className="strong">{b.number}</span>
                  <span className="sub">{b.parcels} parcel(s)</span>
                </td>
                <td>
                  {`${b.from} – ${b.to}`}
                  <span className="sub">issued {day(b.issuedAt)}</span>
                </td>
                <td className="num">{tk(b.total)}</td>
                <td className="num">{tk(b.paid)}</td>
                <td className="num strong">{tk(b.due)}</td>
                <td>
                  {pill(BILL_PILL, b.status)}
                  {b.voidReason ? <span className="sub">{b.voidReason}</span> : null}
                </td>
                <td>
                  <div className="row-actions">
                    <Button size="sm" onClick={() => openDocument(`/documents/bill/${b.id}`, { title: "Preparing the bill…" })}>
                      PDF
                    </Button>
                    {m.staff && b.status !== "VOID" && b.status !== "PAID" ? (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                          const reason = await prompt({ title: `Void ${b.number}?`, message: "Its parcels can be billed again; payments on it go back to credit.", label: "Why?", multiline: true, ok: "Void bill" });
                          if (!reason) return;
                          const done = await api<Bill>(`/bills/${b.id}/void`, { method: "POST", body: { reason } });
                          toast(`${done.number} voided.`);
                          invalidate();
                        }}
                      >
                        Void
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))
          ) : (
            <EmptyRow cols={7} text={loadingText(list, view === "open" ? "No unpaid bills." : "No bills in these dates.")} />
          )}
        </tbody>
      </table>
    </Box>
  );
}

function PaymentsBox({ a }: { a: Account }) {
  const m = useMoney();
  const [range, setRange] = useState({ from: monthStart(), to: today() });
  const query = qs({ accountId: a.id, ...range });
  const list = useQuery({ queryKey: ["acc", "payments", a.id, query], queryFn: async () => (await api<{ items: Payment[] }>(`/payments?${query}`)).items });
  return (
    <Box
      title="Payments"
      sub="Money received from the merchant in these dates. Confirmed payments pay bills; what's left is advance credit."
      tools={
        <>
          <input className="input sm" type="date" aria-label="From" value={range.from} onChange={e => setRange(r => ({ ...r, from: e.target.value }))} />
          <input className="input sm" type="date" aria-label="To" value={range.to} onChange={e => setRange(r => ({ ...r, to: e.target.value }))} />
        </>
      }
    >
      <table className="table">
        <thead>
          <tr>
            <th>Payment</th>
            <th className="num">Amount</th>
            <th>How</th>
            <th>Paid on</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>{list.data?.length ? list.data.map(p => <PaymentRow key={p.id} p={p} staff={m.staff} />) : <EmptyRow cols={6} text={loadingText(list, "No payments in these dates.")} />}</tbody>
      </table>
    </Box>
  );
}

function StatementBox({ a, range, setRange }: { a: Account; range: { from: string; to: string }; setRange: (r: { from: string; to: string }) => void }) {
  const st = useQuery({
    queryKey: ["acc", "statement", a.id, range],
    queryFn: () => api<{ opening: number; closing: number; lines: { date: string; trackingId?: string; description: string; reference?: string; amount: number; balance: number }[] }>(`/accounts/${a.id}/statement?${qs(range)}`),
  });
  return (
    <Box
      title="Statement"
      sub={a.kind === "FINANCIAL" ? "Charges are minus, payments plus. A minus balance is what the merchant owes." : "COD is plus, charges and payouts minus. The balance is what is still owed to the account."}
      tools={
        <>
          <input className="input sm" type="date" aria-label="From" value={range.from} onChange={e => setRange({ ...range, from: e.target.value })} />
          <input className="input sm" type="date" aria-label="To" value={range.to} onChange={e => setRange({ ...range, to: e.target.value })} />
          <Button size="sm" icon="print" onClick={() => openDocument(`/documents/account-statement/${a.id}?${qs(range)}`, { title: "Preparing the statement…" })}>
            PDF
          </Button>
        </>
      }
    >
      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Parcel</th>
            <th>Description</th>
            <th className="num">Amount</th>
            <th className="num">Balance</th>
          </tr>
        </thead>
        <tbody>
          {st.data ? (
            <>
              <tr>
                <td colSpan={4} className="strong">
                  Opening balance
                </td>
                <td className="num strong">{tk(st.data.opening)}</td>
              </tr>
              {st.data.lines.map((l, i) => (
                <tr key={i}>
                  <td className="nowrap">{when(l.date)}</td>
                  <td>{l.trackingId || ""}</td>
                  <td>
                    {l.description}
                    {l.reference ? <span className="sub">{l.reference}</span> : null}
                  </td>
                  <td className="num" style={{ color: l.amount < 0 ? "var(--bad)" : "var(--good)" }}>
                    {`${l.amount < 0 ? "−" : "+"}${tk(Math.abs(l.amount))}`}
                  </td>
                  <td className="num strong">{tk(l.balance)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={4} className="strong">
                  Closing balance
                </td>
                <td className="num strong">{tk(st.data.closing)}</td>
              </tr>
            </>
          ) : (
            <EmptyRow cols={5} text={loadingText(st, "Loading…")} />
          )}
        </tbody>
      </table>
    </Box>
  );
}

// ── account actions ──

function Picker<T extends { parcelId: string }>({ rows, state, columns, footer }: { rows: T[]; state: { chosen: Set<string> }; columns: { head: ReactNode; cell: (r: T) => ReactNode; num?: boolean }[]; footer: (chosen: T[]) => ReactNode }) {
  const [, force] = useState(0);
  const redraw = () => force(n => n + 1);
  const chosen = rows.filter(r => state.chosen.has(r.parcelId));
  return (
    <div className="stack" style={{ gap: 8 }}>
      <label className="check" style={{ fontWeight: 600 }}>
        <input type="checkbox" checked={chosen.length === rows.length} onChange={e => ((state.chosen = e.target.checked ? new Set(rows.map(r => r.parcelId)) : new Set()), redraw())} /> Select all ({rows.length})
      </label>
      <div className="table-wrap" style={{ maxHeight: 320, border: "1px solid var(--line)", borderRadius: 10 }}>
        <table className="table">
          <thead>
            <tr>
              <th className="check-cell" />
              {columns.map((c, i) => (
                <th key={i} className={c.num ? "num" : undefined}>
                  {c.head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.parcelId}>
                <td className="check-cell">
                  <input
                    type="checkbox"
                    checked={state.chosen.has(r.parcelId)}
                    onChange={e => {
                      if (e.target.checked) state.chosen.add(r.parcelId);
                      else state.chosen.delete(r.parcelId);
                      redraw();
                    }}
                  />
                </td>
                {columns.map((c, i) => (
                  <td key={i} className={c.num ? "num" : undefined}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer(chosen)}
    </div>
  );
}

async function settle(a: Account, invalidate: () => void, showDocuments: () => void) {
  const rows = (await api<{ items: AccParcel[] }>(`/accounts/${a.id}/parcels?status=ready`)).items;
  const delivered = rows.filter(r => r.cod > 0 || r.outcome !== "Returned");
  const other = Math.round((a.cod.ready - delivered.reduce((t, r) => t + r.net, 0)) * 100) / 100;
  const state = { chosen: new Set(delivered.map(r => r.parcelId)) };
  let created: Payout | null = null;
  await openForm({
    title: `Settle ${a.name}`,
    description: `Pays to: ${payToText(a.payTo)}. After creating it, send the money and mark it paid.`,
    submit: "Create settlement",
    wide: true,
    fields: [
      {
        id: "parcels",
        label: "Ready parcels",
        type: "static",
        render: delivered.length ? (
          <Picker
            rows={delivered}
            state={state}
            columns={[
              {
                head: "Parcel",
                cell: r => (
                  <>
                    <span className="strong">{r.trackingId}</span>
                    <span className="sub">{day(r.date)}</span>
                  </>
                ),
              },
              { head: "COD", cell: r => tk(r.cod), num: true },
              { head: "Charges", cell: r => `−${tk(r.charge + r.returnCharge)}`, num: true },
              { head: "Net", cell: r => tk(r.net), num: true },
            ]}
            footer={chosen => {
              const net = Math.round((chosen.reduce((t, r) => t + r.net, 0) + other) * 100) / 100;
              return (
                <div className="mini-stats" style={{ margin: 0 }}>
                  <div className="mini">
                    <span>Chosen parcels</span>
                    <strong>{tk(chosen.reduce((t, r) => t + r.net, 0))}</strong>
                  </div>
                  <div className="mini">
                    <span>Returns & adjustments (always)</span>
                    <strong>{tk(other)}</strong>
                  </div>
                  <div className="mini">
                    <span>Net to pay</span>
                    <strong style={{ color: net > 0 ? "var(--good)" : "var(--bad)" }}>{tk(net)}</strong>
                  </div>
                </div>
              );
            }}
          />
        ) : (
          <p className="muted" style={{ margin: 0 }}>{`No delivered parcel is ready (their cash hasn't reached the central hub). Returns & adjustments: ${tk(other)}.`}</p>
        ),
      },
    ],
    onSubmit: async () => {
      if (delivered.length && !state.chosen.size && other <= 0) throw new Error("Choose at least one parcel.");
      const body = delivered.length && state.chosen.size !== delivered.length ? { parcelIds: [...state.chosen] } : {};
      created = await api<Payout>(`/accounts/${a.id}/payouts`, { method: "POST", body });
      invalidate();
      showDocuments();
      return `${created.number} created: ${tk(created.amount)} to pay.`;
    },
  });
  if (created) setTimeout(() => void payPayout((created as Payout).id, invalidate).catch(e => toast(describe(e), "bad")), 300);
}

async function newBill(a: Account, invalidate: () => void, showDocuments: () => void) {
  const state = { chosen: new Set<string>() };
  await openForm({
    title: `Generate bill · ${a.name}`,
    description: "Choose the delivery dates, tick the parcels. The bill is a PDF the merchant sees in their panel; part payments are welcome.",
    submit: "Generate bill",
    wide: true,
    fields: [{ id: "picker", label: "Parcels to bill", type: "static", render: <BillPicker accountId={a.id} state={state} /> }],
    onSubmit: async () => {
      const s = state as unknown as { chosen: Set<string>; from: string; to: string };
      if (!s.chosen.size) throw new Error("Tick at least one parcel.");
      const b = await api<{ id: string; number: string; total: number; paid: number }>(`/accounts/${a.id}/bills`, { method: "POST", body: { from: s.from, to: s.to, parcelIds: [...s.chosen] } });
      invalidate();
      showDocuments();
      void openDocument(`/documents/bill/${b.id}`, { title: "Preparing the bill…" });
      return `${b.number} issued: ${tk(b.total)}${b.paid ? `, ${tk(b.paid)} already paid from credit` : ""}.`;
    },
  });
}

function BillPicker({ accountId, state }: { accountId: string; state: { chosen: Set<string>; from?: string; to?: string } }) {
  const [range, setRange] = useState({ from: monthStart(), to: today() });
  Object.assign(state, range);
  const q = useQuery({ queryKey: ["acc", "bill-pick", accountId, range], queryFn: async () => (await api<{ items: AccParcel[] }>(`/accounts/${accountId}/parcels?${qs({ status: "not_billed", ...range })}`)).items });
  const seen = useRef<string>("");
  if (q.data && seen.current !== JSON.stringify(range)) {
    seen.current = JSON.stringify(range);
    state.chosen = new Set(q.data.map(r => r.parcelId));
  }
  return (
    <div className="stack">
      <div className="form-grid">
        <label className="field">
          <span>Delivered from</span>
          <input className="input" type="date" value={range.from} onChange={e => setRange(r => ({ ...r, from: e.target.value }))} />
        </label>
        <label className="field">
          <span>Delivered to (inclusive)</span>
          <input className="input" type="date" value={range.to} onChange={e => setRange(r => ({ ...r, to: e.target.value }))} />
        </label>
      </div>
      {q.isError ? <p className="form-error">{describe(q.error)}</p> : !q.data ? <p className="muted">Loading…</p> : !q.data.length ? <p className="muted">No parcels waiting for a bill in these dates.</p> : (
        <Picker
          rows={q.data}
          state={state}
          columns={[
            {
              head: "Parcel",
              cell: r => (
                <>
                  <span className="strong">{r.trackingId}</span>
                  <span className="sub">{[r.orderRef, r.recipient].filter(Boolean).join(" · ")}</span>
                </>
              ),
            },
            {
              head: "Outcome",
              cell: r => (
                <>
                  {r.outcome}
                  <span className="sub">{day(r.date)}</span>
                </>
              ),
            },
            { head: "Destination", cell: r => r.destination },
            { head: "Charge", cell: r => tk(r.charge + r.returnCharge), num: true },
          ]}
          footer={chosen => (
            <div className="mini-stats" style={{ margin: 0 }}>
              <div className="mini">
                <span>Chosen</span>
                <strong>{`${chosen.length} of ${q.data!.length}`}</strong>
              </div>
              <div className="mini">
                <span>Bill total</span>
                <strong style={{ color: "var(--primary)" }}>{tk(chosen.reduce((t, r) => t + r.charge + r.returnCharge, 0))}</strong>
              </div>
              <div className="mini">
                <span>Open adjustments</span>
                <strong>added to the bill</strong>
              </div>
            </div>
          )}
        />
      )}
    </div>
  );
}

async function newPayment(a: Account, invalidate: () => void) {
  const open = (await api<{ items: Bill[] }>(`/bills?accountId=${a.id}&status=UNPAID`).catch(() => ({ items: [] as Bill[] }))).items;
  const receipt: ReceiptValue = { dataUrl: null };
  await openForm({
    title: `Record payment · ${a.name}`,
    description: `Due now ${tk(a.financial.due)}. Part payments are fine: it pays the oldest bill first (or the bill you choose); anything extra stays as advance credit.`,
    submit: "Record payment",
    wide: true,
    fields: [
      { id: "amount", label: "Amount received (৳)", type: "number", min: 0.01, step: "0.01", required: true, value: a.financial.due > 0 ? String(a.financial.due) : "" },
      { id: "method", label: "Received by", type: "select", required: true, value: "BANK", options: METHODS.map(([value, label]) => ({ value, label })) },
      { id: "reference", label: "Transaction / cheque reference", maxLength: 120 },
      { id: "paidOn", label: "Paid on", type: "date", value: today(), required: true },
      { id: "billId", label: "Pay this bill first", type: "select", options: [{ value: "", label: "Oldest bills first" }, ...open.map(b => ({ value: b.id, label: `${b.number} · due ${tk(b.due)}` }))] },
      { id: "note", label: "Note", maxLength: 300 },
      { id: "proof", label: "Receipt", type: "static", render: <ReceiptPicker title={`Payment · ${a.name}`} value={receipt} /> },
    ],
    onSubmit: async v => {
      const p = await api<Payment>(`/accounts/${a.id}/payments`, { method: "POST", body: { amount: Number(v.amount), method: v.method, reference: v.reference || undefined, paidOn: v.paidOn, billId: v.billId || undefined, note: v.note || undefined, proof: receipt.dataUrl || undefined } });
      invalidate();
      return `${p.number} recorded: ${tk(p.amount)}${p.bills.length ? ` → ${p.bills.map(b => b.number).join(", ")}` : ""}${p.credit ? `, ${tk(p.credit)} advance credit` : ""}.`;
    },
  });
}

async function adjust(a: Account, invalidate: () => void) {
  await openForm({
    title: `Adjustment · ${a.name}`,
    description: "A correction with a reason. It shows on the statement and goes into the next settlement / bill.",
    submit: "Add adjustment",
    fields: [
      {
        id: "direction",
        label: "Type",
        type: "select",
        required: true,
        value: "charge",
        full: true,
        options: [
          { value: "charge", label: a.kind === "FINANCIAL" ? "Charge the merchant more (they owe more)" : "Deduct (we pay less)" },
          { value: "credit", label: a.kind === "FINANCIAL" ? "Give credit (they owe less)" : "Add (we pay more)" },
        ],
      },
      { id: "amount", label: "Amount (৳)", type: "number", min: 0.01, step: "0.01", required: true },
      { id: "trackingId", label: "Parcel tracking ID", maxLength: 40 },
      { id: "reason", label: "Reason", type: "textarea", required: true, maxLength: 300 },
    ],
    onSubmit: async v => {
      const amount = Number(v.amount) * (v.direction === "credit" ? 1 : -1);
      await api(`/accounts/${a.id}/adjustments`, { method: "POST", body: { amount, reason: v.reason, trackingId: v.trackingId || undefined } });
      invalidate();
      return `Adjustment of ${tk(Math.abs(amount))} added.`;
    },
  });
}

// ───────────── Rider cash ─────────────

interface Slip {
  id: string;
  number: string;
  rider?: { code: string; name: string; phone?: string };
  hub?: { name: string };
  parcels: number | { trackingId: string; recipient?: string; amount: number }[];
  cod: number;
  due?: number;
  expected: number;
  received?: number;
  short?: number;
  status: string;
  createdAt: string;
  receivedAt?: string;
  receivedBy?: string;
  transfer?: { number: string } | null;
}

function RiderCash({ tabs }: { tabs: ReactNode }) {
  const m = useMoney();
  const invalidate = useMoneyInvalidate();
  const [slip, setSlip] = useState<Slip | null>(null);
  const [slipError, setSlipError] = useState("");
  const [counted, setCounted] = useState("");
  const [riderId, setRiderId] = useState("");
  const box = useRef<ScanInputHandle>(null);
  const open = useQuery({ queryKey: ["acc", "slips", "open"], queryFn: async () => (await api<{ items: Slip[] }>("/cash/slips?status=OPEN")).items });
  const recent = useQuery({ queryKey: ["acc", "slips", "received"], queryFn: async () => (await api<{ items: Slip[] }>("/cash/slips?status=RECEIVED")).items });
  const dues = useQuery({ queryKey: ["acc", "dues"], queryFn: async () => (await api<{ items: { who: string; kind: string; amount: number; source: string; createdAt: string }[] }>("/cash/dues")).items });
  const holders = useQuery({ queryKey: ["acc", "cash-riders"], queryFn: async () => (await api<{ items: { id: string; code: string; name: string; total: number; parcels: number; due?: number }[] }>("/cash/riders")).items });

  async function find(raw: string) {
    const number = raw.trim().toUpperCase();
    if (!number) return;
    try {
      const s = await api<Slip>(`/cash/slips/${encodeURIComponent(number)}`);
      setSlip(s);
      setSlipError("");
      setCounted(String(s.expected));
      box.current?.feedback(s.status === "OPEN", s.status === "OPEN" ? `${s.number}: ${tk(s.expected)} to receive` : `${s.number} is ${s.status.toLowerCase()}`);
      setTimeout(() => (document.getElementById("accReceived") as HTMLInputElement | null)?.focus(), 30);
    } catch (e) {
      setSlip(null);
      setSlipError(describe(e));
      box.current?.feedback(false, describe(e));
    }
  }
  async function receive() {
    if (!slip) return;
    const received = Number(counted);
    if (!Number.isFinite(received) || received < 0) return toast("Enter the cash counted.");
    const s = await api<Slip>(`/cash/slips/${slip.id}/receive`, { method: "POST", body: { received } });
    setSlip(s);
    toast(s.short ? `${s.number} received: ${tk(received)}, short ${tk(s.short)} (rider's due).` : `${s.number} received: ${tk(received)}.`, "good");
    invalidate();
  }

  const s = slip;
  return (
    <>
      <PageHeading eyebrow="Money" title="Rider cash" subtitle="Riders make a handover slip in their app with all the cash they hold. Scan it, count the cash, receive it." />
      {tabs}
      <div className="stack-lg">
        {m.noCentral}
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2 className="panel-title">Receive a slip</h2>
              <p className="panel-subtitle">Scan the slip's barcode (or the rider's screen), or type its number.</p>
            </div>
          </div>
          <div className="panel-body">
            <ScanInput ref={box} id="accSlipScan" label="Slip number" placeholder="HS-… slip number" cameraTitle="Scan the handover slip" onScan={code => void find(code)}>
              <Button variant="primary" onClick={() => find((document.getElementById("accSlipScan") as HTMLInputElement)?.value || "")}>
                Open slip
              </Button>
            </ScanInput>
          </div>
          {slipError ? <div className="panel-body" style={{ paddingTop: 0 }}><Pill tone="bad">{slipError}</Pill></div> : null}
          {s ? (
            <div className="grid-main" style={{ padding: 16, borderTop: "1px solid var(--line)", background: "var(--surface-2)", gridTemplateColumns: "1fr minmax(220px, 280px)" }}>
              <div>
                <dl className="kv">
                  <dt>Slip</dt>
                  <dd className="strong">{s.number}</dd>
                  <dt>Rider</dt>
                  <dd>{`${s.rider?.code || ""} · ${s.rider?.name || ""}`}</dd>
                  <dt>Parcels</dt>
                  <dd>{Array.isArray(s.parcels) ? s.parcels.length : s.parcels}</dd>
                  <dt>COD</dt>
                  <dd>{`${tk(s.cod)}${s.due ? ` + earlier due ${tk(s.due)}` : ""}`}</dd>
                  <dt>Status</dt>
                  <dd>{s.status === "OPEN" ? <Pill tone="warn">To receive</Pill> : s.status === "RECEIVED" ? <Pill tone="good">{`Received ${tk(s.received)}${s.short ? ` · short ${tk(s.short)}` : ""}`}</Pill> : <Pill tone="neutral">Cancelled</Pill>}</dd>
                </dl>
                {Array.isArray(s.parcels) && s.parcels.length ? (
                  <details style={{ marginTop: 10 }}>
                    <summary style={{ cursor: "pointer", color: "var(--primary)" }}>Parcels on the slip</summary>
                    <table className="table" style={{ marginTop: 6 }}>
                      <tbody>
                        {s.parcels.map(p => (
                          <tr key={p.trackingId}>
                            <td>{p.trackingId}</td>
                            <td>{p.recipient || ""}</td>
                            <td className="num">{tk(p.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                ) : null}
              </div>
              <div className="stack" style={{ gap: 8, alignContent: "start" }}>
                <small className="muted" style={{ fontWeight: 600 }}>
                  To receive
                </small>
                <div style={{ fontSize: 28, fontWeight: 800, color: "var(--ink)" }}>{tk(s.expected)}</div>
                {s.status === "OPEN" ? (
                  <>
                    <Button icon="print" onClick={() => openDocument(`/documents/cash-slip/${encodeURIComponent(s.number)}`, { title: "Preparing the slip…" })}>
                      Print slip
                    </Button>
                    <label className="field">
                      <span>Cash counted</span>
                      <input id="accReceived" className="input" type="number" inputMode="decimal" min={0} step="0.01" value={counted} onChange={e => setCounted(e.target.value)} onKeyDown={e => e.key === "Enter" && void receive().catch(err => toast(describe(err), "bad"))} />
                    </label>
                    <Button variant="primary" onClick={receive}>
                      Receive cash
                    </Button>
                    <small className="faint">Less than the slip? The difference is recorded as the rider's due.</small>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2 className="panel-title">Rider without a phone</h2>
              <p className="panel-subtitle">Choose the rider: the slip of all the cash they hold is made here, then count and receive it above (print it for the rider to sign).</p>
            </div>
          </div>
          <div className="panel-body row">
            <Select className="select grow" aria-label="Rider" value={riderId} onChange={e => setRiderId(e.target.value)} style={{ minWidth: 220 }}>
              <option value="">{holders.data?.length ? "— Choose the rider —" : loadingText(holders, "No rider of your hubs holds cash")}</option>
              {(holders.data || []).map(r => (
                <option key={r.id} value={r.id}>
                  {`${r.code} · ${r.name} · ${tk(r.total)} (${r.parcels} parcel${r.parcels === 1 ? "" : "s"}${r.due ? `, owes ${tk(r.due)}` : ""})`}
                </option>
              ))}
            </Select>
            <Button
              variant="primary"
              onClick={async () => {
                if (!riderId) return toast("Choose the rider first.");
                const made = await api<Slip>(`/cash/riders/${riderId}/slip`, { method: "POST" });
                invalidate();
                await find(made.number);
              }}
            >
              Make slip
            </Button>
          </div>
        </section>
        <Box title="Waiting to hand over" sub="Slips riders made that no hub has received yet.">
          <table className="table">
            <thead>
              <tr>
                <th>Slip</th>
                <th>Rider</th>
                <th>Hub</th>
                <th className="num">Parcels</th>
                <th className="num">Amount</th>
                <th>Made</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {open.data?.length ? (
                open.data.map(x => (
                  <tr key={x.id}>
                    <td className="strong">{x.number}</td>
                    <td>
                      {`${x.rider?.code || ""} · ${x.rider?.name || ""}`}
                      <span className="sub">{localPhone(x.rider?.phone)}</span>
                    </td>
                    <td>{x.hub?.name || ""}</td>
                    <td className="num">{x.parcels as number}</td>
                    <td className="num strong">{tk(x.expected)}</td>
                    <td className="nowrap">{when(x.createdAt)}</td>
                    <td>
                      <Button size="sm" variant="primary" onClick={() => find(x.number)}>
                        Receive
                      </Button>
                    </td>
                  </tr>
                ))
              ) : (
                <EmptyRow cols={7} text={loadingText(open, "No rider is waiting to hand over.")} />
              )}
            </tbody>
          </table>
        </Box>
        <Box title="Received" sub="Recent slips received at your hubs. Hubs other than the central hub send this cash on in Hub transfers.">
          <table className="table">
            <thead>
              <tr>
                <th>Slip</th>
                <th>Rider</th>
                <th>Hub</th>
                <th className="num">Received</th>
                <th>When</th>
                <th>Sent on</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {recent.data?.length ? (
                recent.data.slice(0, 40).map(x => (
                  <tr key={x.id}>
                    <td className="strong">{x.number}</td>
                    <td>{`${x.rider?.code || ""} · ${x.rider?.name || ""}`}</td>
                    <td>{x.hub?.name || ""}</td>
                    <td className="num">
                      {tk(x.received)}
                      {x.short ? <span className="sub" style={{ color: "var(--bad)" }}>short {tk(x.short)}</span> : null}
                    </td>
                    <td>
                      {when(x.receivedAt)}
                      <span className="sub">{x.receivedBy || ""}</span>
                    </td>
                    <td>{x.transfer ? x.transfer.number : "—"}</td>
                    <td>
                      <Button size="sm" onClick={() => openDocument(`/documents/cash-slip/${encodeURIComponent(x.number)}`, { title: "Preparing the slip…" })}>
                        PDF
                      </Button>
                    </td>
                  </tr>
                ))
              ) : (
                <EmptyRow cols={7} text={loadingText(recent, "Nothing received yet.")} />
              )}
            </tbody>
          </table>
        </Box>
        {dues.data?.length ? (
          <Box title="Dues" sub="Short cash a rider or hub still owes. Their next slip / transfer collects it.">
            <table className="table">
              <thead>
                <tr>
                  <th>Who</th>
                  <th className="num">Amount</th>
                  <th>From</th>
                  <th>Since</th>
                </tr>
              </thead>
              <tbody>
                {dues.data.map((d, i) => (
                  <tr key={i}>
                    <td>
                      {d.who}
                      <span className="sub">{d.kind === "rider" ? "Rider" : "Hub"}</span>
                    </td>
                    <td className="num strong">{tk(d.amount)}</td>
                    <td>{d.source}</td>
                    <td>{day(d.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Box>
        ) : null}
      </div>
    </>
  );
}

// ───────────── Hub transfers ─────────────

interface OnHand {
  hub: { id: string; name: string; code?: string };
  central?: boolean;
  toSend: number;
  slips: { id: string; number: string; rider?: { code: string; name: string }; cash: number }[];
  counter: { count: number; amount: number };
  due?: number;
  inTransit: unknown[];
}
interface Transfer {
  id: string;
  number: string;
  slips: number;
  from: { name: string };
  amount: number;
  method: string;
  reference?: string | null;
  sentAt: string;
  sentBy?: string;
  proof?: { fileId: string } | null;
  received?: number;
  short?: number;
  receivedAt?: string;
  receivedBy?: string;
}

function HubTransfers({ tabs }: { tabs: ReactNode }) {
  const m = useMoney();
  const invalidate = useMoneyInvalidate();
  const onHand = useQuery({ queryKey: ["acc", "onhand"], queryFn: () => api<{ items: OnHand[] }>("/cash/on-hand") });
  const transit = useQuery({ queryKey: ["acc", "transit"], queryFn: async () => (await api<{ items: Transfer[] }>("/cash/transfers?status=IN_TRANSIT")).items });
  const done = useQuery({ queryKey: ["acc", "transfers-done"], queryFn: async () => (await api<{ items: Transfer[] }>("/cash/transfers?status=RECEIVED")).items });
  const [found, setFound] = useState("");
  const box = useRef<ScanInputHandle>(null);
  const hubs = (onHand.data?.items || []).filter(h => !h.central);

  const receive = (t: Transfer) =>
    openForm({
      title: `Receive ${t.number}`,
      description: `Check the ${tk(t.amount)} arrived in the central hub's bank / wallet. Less than sent? Enter what arrived: the difference is the sending hub's due.`,
      submit: "Receive",
      fields: [{ id: "received", label: "Amount received (৳)", type: "number", value: String(t.amount), min: 0, step: "0.01", required: true }],
      onSubmit: async v => {
        const r = await api<Transfer & { short?: number }>(`/cash/transfers/${t.id}/receive`, { method: "POST", body: { received: Number(v.received) } });
        invalidate();
        return r.short ? `${r.number} received: ${tk(r.received)}, short ${tk(r.short)}.` : `${r.number} received: ${tk(r.received)}. The cash is ready to settle.`;
      },
    });

  const send = (h: OnHand) => {
    const chosen = { set: new Set(h.slips.map(s => s.id)) };
    const receipt: ReceiptValue = { dataUrl: null };
    void openForm({
      title: `Send ${h.hub.name}'s cash to the central hub`,
      description: `Whole slips only. Counter cash${h.due ? " and the hub's earlier due" : ""} always go with them. Total now: ${tk(h.toSend)}.`,
      submit: "Send",
      wide: true,
      fields: [
        ...(h.slips.length ? [{ id: "slips", label: "Slips", type: "static" as const, render: <SlipPick slips={h.slips} chosen={chosen} /> }] : []),
        { id: "method", label: "Sent by", type: "select", required: true, value: "BANK", options: METHODS.filter(x => x[0] !== "CASH").map(([value, label]) => ({ value, label })) },
        { id: "reference", label: "Transaction / deposit reference", maxLength: 120, placeholder: "e.g. TXN 7H3K…" },
        { id: "proof", label: "Deposit slip / screenshot", type: "static", render: <ReceiptPicker title={`Transfer proof · ${h.hub.name}`} value={receipt} /> },
      ],
      onSubmit: async v => {
        const slipIds = [...chosen.set];
        if (h.slips.length && !slipIds.length && !h.counter.count && !h.due) throw new Error("Choose at least one slip.");
        const t = await api<Transfer>("/cash/transfers", { method: "POST", body: { fromHubId: h.hub.id, ...(h.slips.length ? { slipIds } : {}), method: v.method, reference: v.reference || undefined, proof: receipt.dataUrl || undefined } });
        invalidate();
        return `${t.number} sent: ${tk(t.amount)}. The central hub receives it when the money arrives.`;
      },
    });
  };

  return (
    <>
      <PageHeading eyebrow="Money" title="Hub transfers" subtitle={`Hubs send the cash they received to the central hub (${m.central?.name || "not set"}) by bank or mobile banking, whole slips at a time.`} />
      {tabs}
      <div className="stack-lg">
        {m.noCentral}
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2 className="panel-title">Cash on hand</h2>
              <p className="panel-subtitle">Received slips and counter cash not sent yet.</p>
            </div>
          </div>
          {hubs.length ? (
            <div className="panel-body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
              {hubs.map(h => (
                <div key={h.hub.id} className="metric" style={{ gap: 8 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong style={{ color: "var(--ink)" }}>{h.hub.name}</strong>
                    <Pill tone="neutral">{h.hub.code || ""}</Pill>
                  </div>
                  <div className="metric-value">{tk(h.toSend)}</div>
                  <span className="muted" style={{ fontSize: 12.5 }}>{`${h.slips.length} slip(s)${h.counter.count ? ` · counter ${tk(h.counter.amount)}` : ""}${h.due ? ` · due ${tk(h.due)}` : ""}${h.inTransit.length ? ` · ${h.inTransit.length} in transit` : ""}`}</span>
                  <div>
                    {h.toSend > 0 ? (
                      <Button size="sm" variant="primary" onClick={() => send(h)}>
                        Send to central hub
                      </Button>
                    ) : (
                      <Pill tone="good">Nothing to send</Pill>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty>{loadingText(onHand, "No cash waiting at your hubs.")}</Empty>
          )}
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2 className="panel-title">In transit</h2>
              <p className="panel-subtitle">{m.staff ? "Check the money arrived, then receive it: it's then ready to settle." : "Sent and waiting for the central hub to receive."}</p>
            </div>
          </div>
          {m.staff ? (
            <div className="panel-body" style={{ paddingTop: 0 }}>
              <ScanInput
                ref={box}
                id="accTransferScan"
                big={false}
                autoFocus={false}
                label="Find a transfer"
                placeholder="HT-… transfer number"
                cameraTitle="Scan the transfer"
                onScan={code => {
                  setFound(code);
                  const t = transit.data?.find(x => x.number === code);
                  box.current?.feedback(!!t, t ? `${t.number}: ${tk(t.amount)} from ${t.from.name}` : `${code} isn't in transit`);
                  if (t) void receive(t);
                }}
              />
            </div>
          ) : null}
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Transfer</th>
                  <th>From</th>
                  <th className="num">Amount</th>
                  <th>How</th>
                  <th>Sent</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {transit.data?.length ? (
                  transit.data.map(t => (
                    <tr key={t.id} className={found === t.number ? "selected" : undefined}>
                      <td>
                        <span className="strong">{t.number}</span>
                        <span className="sub">{t.slips} slip(s)</span>
                      </td>
                      <td>{t.from.name}</td>
                      <td className="num strong">{tk(t.amount)}</td>
                      <td>
                        {methodLabel(t.method)}
                        {t.reference ? <span className="sub">{t.reference}</span> : null}
                      </td>
                      <td>
                        {when(t.sentAt)}
                        <span className="sub">{t.sentBy || ""}</span>
                      </td>
                      <td>
                        <div className="row-actions">
                          <Button size="sm" onClick={() => openDocument(`/documents/hub-transfer/${encodeURIComponent(t.number)}`, { title: "Preparing the transfer…" })}>
                            PDF
                          </Button>
                          {t.proof ? (
                            <Button size="sm" onClick={() => openFile(t.proof!.fileId)}>
                              Proof
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={async () => {
                              if (!(await confirm({ title: `Cancel ${t.number}?`, message: "The cash counts as on hand at the hub again.", ok: "Cancel transfer", cancel: "Keep it", danger: true }))) return;
                              const r = await api<Transfer>(`/cash/transfers/${t.id}/cancel`, { method: "POST" });
                              toast(`${r.number} cancelled.`);
                              invalidate();
                            }}
                          >
                            Cancel
                          </Button>
                          {m.staff ? (
                            <Button size="sm" variant="primary" onClick={() => receive(t)}>
                              Receive
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <EmptyRow cols={6} text={loadingText(transit, "Nothing in transit.")} />
                )}
              </tbody>
            </table>
          </div>
        </section>
        <Box title="Received">
          <table className="table">
            <thead>
              <tr>
                <th>Transfer</th>
                <th>From</th>
                <th className="num">Received</th>
                <th>When</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {done.data?.length ? (
                done.data.slice(0, 40).map(t => (
                  <tr key={t.id}>
                    <td className="strong">{t.number}</td>
                    <td>{t.from.name}</td>
                    <td className="num">
                      {tk(t.received)}
                      {t.short ? <span className="sub" style={{ color: "var(--bad)" }}>short {tk(t.short)}</span> : null}
                    </td>
                    <td>
                      {when(t.receivedAt)}
                      <span className="sub">{t.receivedBy || ""}</span>
                    </td>
                    <td>
                      <Button size="sm" onClick={() => openDocument(`/documents/hub-transfer/${encodeURIComponent(t.number)}`, { title: "Preparing the transfer…" })}>
                        PDF
                      </Button>
                    </td>
                  </tr>
                ))
              ) : (
                <EmptyRow cols={5} text={loadingText(done, "Nothing received yet.")} />
              )}
            </tbody>
          </table>
        </Box>
      </div>
    </>
  );
}

function SlipPick({ slips, chosen }: { slips: OnHand["slips"]; chosen: { set: Set<string> } }) {
  const [, force] = useState(0);
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 10, maxHeight: 300, overflow: "auto" }}>
      {slips.map(s => (
        <label key={s.id} className="check" style={{ display: "flex", padding: "6px 10px", borderBottom: "1px solid var(--line)" }}>
          <input
            type="checkbox"
            checked={chosen.set.has(s.id)}
            onChange={e => {
              if (e.target.checked) chosen.set.add(s.id);
              else chosen.set.delete(s.id);
              force(n => n + 1);
            }}
          />
          <strong>{s.number}</strong> {`${s.rider?.code || ""} · ${s.rider?.name || ""}`}
          <span style={{ marginLeft: "auto" }}>{tk(s.cash)}</span>
        </label>
      ))}
    </div>
  );
}

// ───────────── Rider pay ─────────────

interface RiderPayout {
  id: string;
  number: string;
  earnings: number;
  rider: { code: string; name: string };
  periodStart: string;
  periodEnd: string;
  amount: number;
  status: string;
  paymentMethod?: string;
  paymentReference?: string | null;
  createdById?: string;
}
const RIDER_PAYOUT: Record<string, [string, "warn" | "info" | "good" | "bad"]> = { DRAFT: ["To approve", "warn"], APPROVED: ["Ready to pay", "info"], PAID: ["Paid", "good"], CANCELLED: ["Cancelled", "bad"] };
const RIDER_METHODS: Record<string, string> = { BKASH: "bKash", NAGAD: "Nagad", ROCKET: "Rocket", BANK_TRANSFER: "Bank transfer", CASH: "Cash" };

function RiderPay({ tabs }: { tabs: ReactNode }) {
  const ops = useOps();
  const { user } = useAuth();
  const qc = useQueryClient();
  const canPay = ops.can("manageFinance") || ops.can("manageRiders");
  const list = useQuery({ queryKey: ["acc", "rider-payouts"], queryFn: async () => (await api<{ items: RiderPayout[] }>("/rider-payouts?limit=30")).items, enabled: canPay });
  const reload = () => void qc.invalidateQueries({ queryKey: ["acc", "rider-payouts"] });
  const dhakaDay = (d: Date) => new Date(d.getTime() + 6 * 3600_000).toISOString().slice(0, 10);
  const fromDhaka = (text: string, end: boolean) => new Date(new Date(`${text}T00:00:00+06:00`).getTime() + (end ? 86_400_000 : 0));
  const prepare = () => {
    const now = new Date();
    const dhaka = new Date(now.getTime() + 6 * 3600_000);
    const start = new Date(Date.UTC(dhaka.getUTCFullYear(), dhaka.getUTCMonth(), 1) - 6 * 3600_000);
    const DAY = /^\d{4}-\d{2}-\d{2}$/;
    void openForm({
      title: "Prepare rider payouts",
      description: "Creates one payout per rider from their unpaid earnings in the period (Dhaka calendar days). Another person approves them.",
      submit: "Review",
      fields: [
        { id: "from", label: "Pay period start", type: "date", value: dhakaDay(start), required: true },
        { id: "to", label: "Pay period end (inclusive)", type: "date", value: dhakaDay(new Date(now.getTime() - 1)), required: true, max: dhakaDay(new Date()) },
      ],
      validate: { from: v => (DAY.test(v) ? "" : "Choose a date"), to: (v, all) => (!DAY.test(v) ? "Choose a date" : all.from && v < all.from ? "The end can't be before the start" : "") },
      review: v => [
        ["Period", `${v.from} – ${v.to}`],
        ["Riders", "Everyone with unpaid earnings in the period"],
        ["Note", "Payouts are drafted now; money moves only when finance marks each one paid."],
      ],
      confirm: "Prepare payouts",
      onSubmit: async v => {
        let to = fromDhaka(v.to, true);
        if (to.getTime() > Date.now()) to = new Date();
        const r = await api<{ created: unknown[]; skipped: unknown[]; total: number }>("/rider-payouts/runs", { method: "POST", body: { periodStart: fromDhaka(v.from, false).toISOString(), periodEnd: to.toISOString() } });
        reload();
        return `${r.created.length} payout${r.created.length === 1 ? "" : "s"} prepared (${tk(r.total)})${r.skipped.length ? ` · ${r.skipped.length} rider${r.skipped.length === 1 ? "" : "s"} skipped` : ""}. Another person approves them.`;
      },
    });
  };
  return (
    <>
      <PageHeading eyebrow="Money" title="Rider pay" subtitle="Riders' earnings: prepare payouts, approve, pay." />
      {tabs}
      {!canPay ? (
        <div className="callout warn">Nothing here for you.</div>
      ) : (
        <Box
          title="Rider payouts"
          sub="Riders' earnings ledger · prepared, approved by someone else, then paid by finance"
          tools={
            <Button size="sm" onClick={prepare}>
              Prepare payouts
            </Button>
          }
        >
          <table className="table">
            <thead>
              <tr>
                <th>Payout</th>
                <th>Rider</th>
                <th>Period</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data?.length ? (
                list.data.map(p => {
                  const rider = `${p.rider.code} · ${p.rider.name}`;
                  const period = `${new Date(p.periodStart).toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${new Date(new Date(p.periodEnd).getTime() - 1).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
                  return (
                    <tr key={p.id}>
                      <td>
                        <span className="strong">{p.number}</span>
                        <span className="sub">{p.earnings} lines</span>
                      </td>
                      <td>{rider}</td>
                      <td>{period}</td>
                      <td className="num">{tk(p.amount)}</td>
                      <td>
                        {pill(RIDER_PAYOUT, p.status)}
                        {p.paymentReference ? <span className="sub">{`${p.paymentMethod} · ${p.paymentReference}`}</span> : null}
                      </td>
                      <td>
                        <div className="row-actions">
                          {p.status === "DRAFT" && p.createdById !== user?.id ? (
                            <Button
                              size="sm"
                              onClick={async () => {
                                if (!(await confirm({ title: `Approve ${p.number}?`, message: `${rider} · ${tk(p.amount)}. Finance can pay it once approved.`, ok: "Approve payout" }))) return;
                                const r = await api<RiderPayout>(`/rider-payouts/${p.id}/approve`, { method: "POST" });
                                reload();
                                toast(`${r.number} approved.`, "good");
                              }}
                            >
                              Approve
                            </Button>
                          ) : null}
                          {p.status === "APPROVED" && ops.can("manageFinance") ? (
                            <Button
                              size="sm"
                              onClick={() =>
                                openForm({
                                  title: `Mark ${p.number} paid`,
                                  description: `${rider} · ${tk(p.amount)}. The rider gets an SMS.`,
                                  submit: "Review payment",
                                  fields: [
                                    { id: "paymentMethod", label: "Payment method", type: "select", value: "BKASH", required: true, options: Object.entries(RIDER_METHODS).map(([value, label]) => ({ value, label })) },
                                    { id: "paymentReference", label: "Transaction or reference number", required: true, maxLength: 120 },
                                  ],
                                  validate: { paymentReference: v => (v.length < 3 ? "At least 3 characters" : "") },
                                  review: v => [
                                    ["Payout", p.number],
                                    ["Rider", rider],
                                    ["Amount", tk(p.amount)],
                                    ["Method", RIDER_METHODS[v.paymentMethod]],
                                    ["Reference", v.paymentReference],
                                  ],
                                  confirm: "Confirm payment",
                                  onSubmit: async v => {
                                    const r = await api<RiderPayout>(`/rider-payouts/${p.id}/pay`, { method: "POST", body: { paymentMethod: v.paymentMethod, paymentReference: v.paymentReference } });
                                    reload();
                                    return `${r.number} paid. The rider has been notified.`;
                                  },
                                })
                              }
                            >
                              Mark paid
                            </Button>
                          ) : null}
                          {p.status === "DRAFT" || p.status === "APPROVED" ? (
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={async () => {
                                if (!(await confirm({ title: `Cancel ${p.number}?`, message: "Its earnings become unpaid again.", ok: "Cancel payout", cancel: "Keep it", danger: true }))) return;
                                const r = await api<RiderPayout>(`/rider-payouts/${p.id}/cancel`, { method: "POST", body: {} });
                                reload();
                                toast(`${r.number} cancelled.`);
                              }}
                            >
                              Cancel
                            </Button>
                          ) : null}
                          {p.status === "DRAFT" && p.createdById === user?.id ? <span className="faint">Another person approves</span> : null}
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <EmptyRow cols={6} text={loadingText(list, "No rider payouts yet.")} />
              )}
            </tbody>
          </table>
        </Box>
      )}
    </>
  );
}

// ───────────── Franchise ─────────────

const FRANCHISE_TAG = <span className="pill warn" style={{ marginLeft: 6, fontSize: 10.5 }}>Franchise</span>;
function Franchise({ tabs }: { tabs: ReactNode }) {
  const ops = useOps();
  const qc = useQueryClient();
  const deposits = useQuery({
    queryKey: ["acc", "franchise", "deposits"],
    queryFn: () => api<{ id: string; number: string; requestedAt: string; franchise: { name: string; hub: string }; hub: { name: string }; gross: number; commissionDeducted?: number; net: number }[]>("/franchise-deposits?status=PENDING"),
    enabled: ops.can("receiveCash") || ops.can("financeStaff"),
  });
  const invoices = useQuery({
    queryKey: ["acc", "franchise", "invoices"],
    queryFn: () => api<{ id: string; number: string; createdAt: string; franchise: { name: string; hub: string }; periodFrom: string; periodTo: string; amount: number; status: string }[]>("/franchise-invoices"),
    enabled: ops.can("financeStaff"),
  });
  const reload = () => void qc.invalidateQueries({ queryKey: ["acc", "franchise"] });
  const showDeposits = ops.can("receiveCash") || ops.can("financeStaff");
  const open = (invoices.data || []).filter(i => i.status === "ISSUED" || i.status === "APPROVED");
  return (
    <>
      <PageHeading eyebrow="Money" title="Franchise" subtitle="Franchise hubs' cash deposits and commission invoices." />
      {tabs}
      <div className="stack-lg">
        {!showDeposits && !ops.can("financeStaff") ? <div className="callout warn">Nothing here for you.</div> : null}
        {showDeposits ? (
          <Box title="Franchise deposits" sub={`Cash franchise hubs bring to ${ops.me?.hubIds ? "your hub" : "Delivery Fast hubs"}: count it and confirm the exact amount.`}>
            <table className="table">
              <thead>
                <tr>
                  <th>Deposit</th>
                  <th>Franchise</th>
                  <th>To hub</th>
                  <th className="num">Cash</th>
                  <th className="num">Commission kept</th>
                  <th className="num">To receive</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {deposits.data?.length ? (
                  deposits.data.map(d => (
                    <tr key={d.id}>
                      <td>
                        <span className="strong">{d.number}</span>
                        <span className="sub">{when(d.requestedAt)}</span>
                      </td>
                      <td>
                        {d.franchise.name}
                        {FRANCHISE_TAG}
                        <span className="sub">{d.franchise.hub}</span>
                      </td>
                      <td>{d.hub.name}</td>
                      <td className="num">{tk(d.gross)}</td>
                      <td className="num">{d.commissionDeducted ? tk(d.commissionDeducted) : "—"}</td>
                      <td className="num strong">{tk(d.net)}</td>
                      <td>
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={async () => {
                            if (!(await confirm({ title: "Receive the franchise deposit?", message: `Confirm you counted ${tk(d.net)} in cash.`, ok: `Received ${tk(d.net)}` }))) return;
                            const r = await api<{ number: string; net: number; franchise: { name: string } }>(`/franchise-deposits/${d.id}/receive`, { method: "POST", body: { amountReceived: d.net } });
                            toast(`${r.number}: ${tk(r.net)} received from ${r.franchise.name}.`, "good");
                            reload();
                          }}
                        >
                          {`Receive ${tk(d.net)}`}
                        </Button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <EmptyRow cols={7} text={loadingText(deposits, "No franchise deposit waiting.")} />
                )}
              </tbody>
            </table>
          </Box>
        ) : null}
        {ops.can("financeStaff") ? (
          <Box
            title="Franchise commission invoices"
            sub="Approve (a second finance user than the maker) and pay franchise commission billed in BILL mode."
            tools={
              <Button
                size="sm"
                onClick={async () => {
                  const r = await api<{ created: string[] }>("/franchise-invoices/run", { method: "POST" });
                  toast(r.created.length ? `Invoiced: ${r.created.join(", ")}` : "No franchise is due for an invoice (or the settlement mode is Deduct).");
                  reload();
                }}
              >
                Bill due franchises now
              </Button>
            }
          >
            <table className="table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Franchise</th>
                  <th>Period</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {open.length ? (
                  open.map(i => (
                    <tr key={i.id}>
                      <td>
                        <span className="strong">{i.number}</span>
                        <span className="sub">{when(i.createdAt)}</span>
                      </td>
                      <td>
                        {i.franchise.name}
                        {FRANCHISE_TAG}
                        <span className="sub">{i.franchise.hub}</span>
                      </td>
                      <td>{`${new Date(i.periodFrom).toLocaleDateString("en-GB")} – ${new Date(i.periodTo).toLocaleDateString("en-GB")}`}</td>
                      <td className="num">{tk(i.amount)}</td>
                      <td>
                        <Pill tone={i.status === "ISSUED" ? "warn" : "info"}>{i.status === "ISSUED" ? "To approve" : "Approved · to pay"}</Pill>
                      </td>
                      <td>
                        <div className="row-actions">
                          <Button size="sm" onClick={() => openDocument(`/franchise-invoices/${i.id}/pdf`, { title: "Preparing the invoice…" })}>
                            PDF
                          </Button>
                          {i.status === "ISSUED" ? (
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={async () => {
                                const r = await api<{ number: string }>(`/franchise-invoices/${i.id}/approve`, { method: "POST" });
                                toast(`${r.number} approved.`, "good");
                                reload();
                              }}
                            >
                              Approve
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={async () => {
                                const reference = await prompt({ title: "Pay the franchise commission", message: `${tk(i.amount)} by bank transfer. Enter the payment reference.`, label: "Payment reference", ok: "Mark as paid" });
                                if (!reference) return;
                                const r = await api<{ number: string }>(`/franchise-invoices/${i.id}/pay`, { method: "POST", body: { method: "BANK", reference } });
                                toast(`${r.number} paid.`, "good");
                                reload();
                              }}
                            >
                              Pay
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <EmptyRow cols={6} text={loadingText(invoices, "No franchise invoice to approve or pay.")} />
                )}
              </tbody>
            </table>
          </Box>
        ) : null}
      </div>
    </>
  );
}

