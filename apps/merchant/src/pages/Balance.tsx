/**
 * Balance (shared/merchant-balance.js): the merchant's account (modules/money).
 * E-commerce (COD account): ready to pay you, with riders, at hubs, being paid, last payment; Parcels (COD, charges,
 * net, where the cash is), Being paid / Paid history (settlements with PDF and receipt photo), Statement.
 * Banking & Financial (Financial account): delivery charges, bills and payments:
 *   Cards     due now (spelled out), not billed yet, unpaid bills, last payment, adjustments
 *   Parcels   delivered / returned parcels with their charge and bill (GET /accounts/:id/parcels)
 *   Bills     unpaid (default) or all in dates (GET /bills), PDF
 *   Payments  what was paid in dates (GET /payments), receipts
 *   Statement opening, lines, closing (GET /accounts/:id/statement); Statement PDF
 *   I've paid POST /accounts/:id/payments (waiting until Delivery Fast confirms it)
 * Owners only (staff see a note). Live: account.updated.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiRaw, describe } from "@panel/lib/api";
import { useLive } from "@panel/lib/events";
import { useDebounced } from "@panel/ui/kit";
import { openDocument } from "@panel/lib/print";
import { openCustom } from "@panel/ui/dialogs";
import { Icon } from "@panel/ui/Icon";
import { PageHeading } from "@panel/ui/kit";
import { Select } from "@panel/ui/Select";
import { toast } from "@panel/ui/toast";
import { useMerchant } from "@/lib/merchant";

const tk = (n: unknown) => `৳${Number(n || 0).toLocaleString("en-BD", { maximumFractionDigits: 2 })}`;
const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dhaka" }) : "—");
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Dhaka" }) : "—");
const today = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;
const METHODS: [string, string][] = [
  ["BANK", "Bank transfer"],
  ["BKASH", "bKash"],
  ["NAGAD", "Nagad"],
  ["ROCKET", "Rocket"],
  ["CASH", "Cash"],
  ["OTHER", "Other"],
];
const methodLabel = (m: string) => (METHODS.find(x => x[0] === m) || [m, m])[1];
const PAYOUT: Record<string, [string, string]> = { UNPAID: ["Being paid", "warn"], PAID: ["Paid", "good"], CANCELLED: ["Cancelled", ""] };
const BILL: Record<string, [string, string]> = { ISSUED: ["Unpaid", "warn"], PARTLY_PAID: ["Partly paid", "info"], PAID: ["Paid", "good"], VOID: ["Void", ""] };
const PAYMENT: Record<string, [string, string]> = { PENDING: ["Waiting for confirmation", "warn"], CONFIRMED: ["Confirmed", "good"], REJECTED: ["Not confirmed", "bad"] };
const pill = (map: Record<string, [string, string]>, s: string) => <span className={`pill ${(map[s] || [])[1] || ""}`}>{(map[s] || [s])[0]}</span>;
const qs = (o: Record<string, unknown>) =>
  Object.entries(o)
    .filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

interface Account {
  id: string;
  kind: "FINANCIAL" | "ECOMMERCE" | string;
  payTo?: { method: string; accountName?: string; accountNumber?: string } | null;
  cod: {
    ready: number;
    withRider: number;
    atHubs: number;
    inSettlement: number;
    unpaidSettlements: number;
    lastPayout: { amount: number; paidAt: string; number: string } | null;
    paidThisMonth: number;
  };
  financial: {
    due: number;
    notBilled: number;
    billedDue: number;
    openAdjustments: number;
    credit: number;
    unpaidBills: { amount: number; count: number };
    pending: { count: number };
    lastPayment: { amount: number; paidOn: string; number: string } | null;
    paidThisMonth: number;
  };
}

/** "Due now" = not billed + unpaid bills − adjustment credit − advance credit, spelled out. */
const dueParts = (f: Account["financial"]) =>
  [`not billed ${tk(f.notBilled)}`, f.billedDue ? `+ unpaid bills ${tk(f.billedDue)}` : "", f.openAdjustments ? `${f.openAdjustments > 0 ? "−" : "+"} adjustments ${tk(Math.abs(f.openAdjustments))}` : "", f.credit ? `− credit ${tk(f.credit)}` : ""].filter(Boolean).join(" ");

/** A file (receipt) opened from the API with the access token. */
function openFile(id: string) {
  const tab = window.open("", "_blank");
  apiRaw(`/files/${encodeURIComponent(id)}`)
    .then(r => r.blob())
    .then(blob => {
      const url = URL.createObjectURL(blob);
      if (tab) tab.location.href = url;
      else window.open(url, "_blank");
    })
    .catch(error => (tab?.close(), toast(describe(error), "bad")));
}

type Sub = "parcels" | "documents" | "history" | "payments" | "statement";

export default function Balance() {
  const m = useMerchant();
  const qc = useQueryClient();
  const account = useQuery({ queryKey: ["m", "account"], queryFn: () => api<Account[]>("/my-accounts").then(rows => rows[0] || null), enabled: m.isOwner });
  useLive(["account.updated"], () => void qc.invalidateQueries({ queryKey: ["m", "account"] }), { enabled: m.isOwner });
  const [sub, setSub] = useState<Sub>("parcels");
  const [stmt, setStmt] = useState({ from: monthStart(), to: today() });
  const a = account.data;

  const heading = <PageHeading eyebrow="Money" title="Balance" subtitle={(account.data?.kind ?? (m.doc ? "FINANCIAL" : "ECOMMERCE")) === "FINANCIAL" ? "Your delivery charges, bills and payments." : "Your COD: where it is, what's ready and what's been paid to you."} />;
  if (!m.isOwner)
    return (
      <>
        {heading}
        <div className="callout">Your workspace owner sees the balance, settlements and bills.</div>
      </>
    );
  if (account.isLoading || account.isError || !a)
    return (
      <>
        {heading}
        {account.isLoading ? <div className="panel empty-cell">Loading your balance…</div> : account.isError ? <div className="panel empty-cell">{describe(account.error)}</div> : <div className="callout">Your balance appears here after your first delivery.</div>}
      </>
    );
  const fin = a.kind === "FINANCIAL";
  const f = a.financial;
  const c = a.cod;
  const card = (label: string, value: string, foot: string, cls = "") => (
    <div className={`mb-card ${cls}`}>
      <small>{label}</small>
      <strong>{value}</strong>
      {foot ? <span>{foot}</span> : null}
    </div>
  );
  const subs: [Sub, string][] = fin
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
  const shown: Sub = subs.some(x => x[0] === sub) ? sub : "parcels";
  return (
    <>
      {heading}
      <div className="mb">
        {fin ? null : <div className="callout">Paid to: {a.payTo ? `${methodLabel(a.payTo.method)} · ${a.payTo.accountName || ""} · ${a.payTo.accountNumber || ""}` : "no payout account yet: add it in Settings › Payout account"}.</div>}
        <div className="mb-cards">
          {fin ? (
            <>
              {card("Due now", tk(f.due), dueParts(f), f.due > 0 ? "due" : "good")}
              {card("Not billed yet", tk(f.notBilled), "delivered, waiting for a bill")}
              {card("Unpaid bills", tk(f.unpaidBills.amount), `${f.unpaidBills.count} bill(s)${f.pending.count ? ` · ${f.pending.count} payment(s) waiting for confirmation` : ""}`)}
              {card("Last payment", f.lastPayment ? tk(f.lastPayment.amount) : "—", f.lastPayment ? `${day(f.lastPayment.paidOn)} · ${f.lastPayment.number} · this month ${tk(f.paidThisMonth)}` : "no payment yet")}
              {f.openAdjustments ? card("Adjustments", `${f.openAdjustments > 0 ? "−" : "+"}${tk(Math.abs(f.openAdjustments))}`, f.openAdjustments > 0 ? "credit, on your next bill" : "extra charge, on your next bill") : null}
            </>
          ) : (
            <>
              {card("Ready to pay you", tk(c.ready), "cash at our central hub, less charges", "key")}
              {card("With riders", tk(c.withRider), "collected from your customers")}
              {card("At hubs / on the way", tk(c.atHubs), "")}
              {card("Being paid", tk(c.inSettlement), c.unpaidSettlements ? `${c.unpaidSettlements} settlement(s) on the way` : "nothing waiting")}
              {card("Last payment to you", c.lastPayout ? tk(c.lastPayout.amount) : "—", c.lastPayout ? `${day(c.lastPayout.paidAt)} · ${c.lastPayout.number} · this month ${tk(c.paidThisMonth)}` : "nothing paid yet")}
            </>
          )}
        </div>
        <div className="mb-bar">
          <div className="seg-tabs" role="tablist">
            {subs.map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={shown === k} className={shown === k ? "on" : ""} onClick={() => setSub(k)}>
                {l}
              </button>
            ))}
          </div>
          <div className="row" style={{ gap: 8 }}>
            {fin ? (
            <button type="button" className="button sm primary" onClick={() => void paidDialog(a, () => (setSub("payments"), void qc.invalidateQueries({ queryKey: ["m"] })))}>
              I've paid
            </button>
            ) : null}
            <button type="button" className="button sm" onClick={() => void openDocument(`/documents/account-statement/${a.id}?${qs(stmt)}`, { title: "Preparing your statement…" })}>
              Statement PDF
            </button>
          </div>
        </div>
        <section className="panel">
          {shown === "parcels" ? <Parcels a={a} /> : shown === "documents" ? fin ? <Bills a={a} /> : <Payouts a={a} view="open" /> : shown === "history" ? <Payouts a={a} view="history" /> : shown === "payments" ? <Payments a={a} /> : <Statement a={a} stmt={stmt} setStmt={setStmt} />}
        </section>
      </div>
    </>
  );
}

function Head({ title, text, tools }: { title: string; text: string; tools?: React.ReactNode }) {
  return (
    <div className="panel-head">
      <div>
        <h2 className="panel-title">{title}</h2>
        <p className="panel-subtitle">{text}</p>
      </div>
      {tools ? <div className="tools">{tools}</div> : null}
    </div>
  );
}
function Dates({ v, set }: { v: { from: string; to: string }; set: (v: { from: string; to: string }) => void }) {
  return (
    <>
      <input className="input sm" type="date" aria-label="From" value={v.from} onChange={e => set({ ...v, from: e.target.value })} style={{ width: 140 }} />
      <input className="input sm" type="date" aria-label="To" value={v.to} onChange={e => set({ ...v, to: e.target.value })} style={{ width: 140 }} />
    </>
  );
}
function Body({ q, cols, empty, children }: { q: { isLoading: boolean; isError: boolean; error: unknown }; cols: number; empty: string; children: React.ReactNode[] | undefined }) {
  return (
    <tbody>
      {children}
      {!children?.length ? (
        <tr>
          <td colSpan={cols} className="empty-cell">
            {q.isLoading ? "Loading…" : q.isError ? describe(q.error) : empty}
          </td>
        </tr>
      ) : null}
    </tbody>
  );
}

function Parcels({ a }: { a: Account }) {
  const fin = a.kind === "FINANCIAL";
  const [f, setF] = useState({ from: monthStart(), to: today(), status: "all", q: "" });
  const q = useDebounced(f.q, 350);
  const key = qs({ ...f, q });
  const data = useQuery({
    queryKey: ["m", "account-parcels", a.id, key],
    queryFn: () =>
      api<{ items: { trackingId: string; orderRef?: string; recipient?: string; outcome: string; date: string; charge: number; returnCharge: number; cod?: number; net?: number; ready?: boolean; cash?: { label?: string } | null; payout?: { status: string; number: string } | null; bill?: { status: string; number: string } | null }[] }>(`/accounts/${a.id}/parcels?${key}`),
  });
  return (
    <>
      <Head
        title="Parcels"
        text="Delivered and returned parcels with their money"
        tools={
          <>
            <Dates v={f} set={v => setF({ ...f, ...v })} />
            <Select className="select sm" aria-label="Status" value={f.status} onChange={e => setF({ ...f, status: e.target.value })} searchable={false}>
              {(fin
                ? [
                    ["all", "All"],
                    ["not_billed", "Not billed"],
                    ["billed", "Billed, unpaid"],
                    ["paid", "Paid"],
                  ]
                : [
                    ["all", "All"],
                    ["open", "Not paid yet"],
                    ["ready", "Ready to pay"],
                    ["settled", "Paid"],
                  ]
              ).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
            <input className="input sm" type="search" placeholder="Tracking ID" aria-label="Search" value={f.q} onChange={e => setF({ ...f, q: e.target.value })} style={{ width: 160 }} />
          </>
        }
      />
      <div className="table-wrap">
        <table className="table">
          <thead>
            {fin ? (
              <tr>
                <th>Parcel</th>
                <th>Outcome</th>
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
                <th>Status</th>
              </tr>
            )}
          </thead>
          <Body q={data} cols={fin ? 4 : 6} empty="No parcels in these dates.">
            {data.data?.items.map(p => (
              <tr key={p.trackingId}>
                <td>
                  <div className="strong">{p.trackingId}</div>
                  <div className="sub">{[p.orderRef, p.recipient].filter(Boolean).join(" · ")}</div>
                </td>
                <td>
                  {p.outcome}
                  <div className="sub">{day(p.date)}</div>
                </td>
                {fin ? <td className="num">{tk(p.charge + p.returnCharge)}</td> : null}
                {fin ? null : (
                  <>
                    <td className="num">{tk(p.cod)}</td>
                    <td className="num">−{tk(p.charge + p.returnCharge)}</td>
                    <td className="num strong">{tk(p.net)}</td>
                  </>
                )}
                <td>
                  {!fin ? (
                    p.payout ? (
                      <>
                        {pill(PAYOUT, p.payout.status === "PAID" ? "PAID" : "UNPAID")}
                        <div className="sub">{p.payout.number}</div>
                      </>
                    ) : p.ready ? (
                      <span className="pill info">Ready to pay</span>
                    ) : (
                      <span className="pill">{p.cash?.label || "Waiting"}</span>
                    )
                  ) : p.bill ? (
                    <>
                      {pill(BILL, p.bill.status)}
                      <div className="sub">{p.bill.number}</div>
                    </>
                  ) : (
                    <span className="pill">Not billed</span>
                  )}
                </td>
              </tr>
            ))}
          </Body>
        </table>
      </div>
    </>
  );
}

function Bills({ a }: { a: Account }) {
  const [view, setView] = useState<"open" | "history">("open");
  const [d, setD] = useState({ from: monthStart(), to: today() });
  const key = view === "open" ? qs({ accountId: a.id, status: "UNPAID" }) : qs({ accountId: a.id, ...d });
  const data = useQuery({ queryKey: ["m", "bills", key], queryFn: () => api<{ items: { id: string; number: string; parcels: number; from: string; to: string; issuedAt: string; total: number; paid: number; due: number; status: string }[] }>(`/bills?${key}`) });
  return (
    <>
      <Head
        title="Bills"
        text={view === "open" ? "Unpaid and part-paid bills. Paid bills are history: choose All." : "Every bill in these dates."}
        tools={
          <>
            <Select className="select sm" aria-label="Show" value={view} onChange={e => setView(e.target.value as "open" | "history")} searchable={false}>
              <option value="open">Unpaid</option>
              <option value="history">All (history)</option>
            </Select>
            {view === "history" ? <Dates v={d} set={setD} /> : null}
          </>
        }
      />
      <div className="table-wrap">
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
          <Body q={data} cols={7} empty={view === "open" ? "No unpaid bills." : "No bills in these dates."}>
            {data.data?.items.map(b => (
              <tr key={b.id}>
                <td>
                  <div className="strong">{b.number}</div>
                  <div className="sub">{b.parcels} parcel(s)</div>
                </td>
                <td>
                  {b.from} – {b.to}
                  <div className="sub">issued {day(b.issuedAt)}</div>
                </td>
                <td className="num">{tk(b.total)}</td>
                <td className="num">{tk(b.paid)}</td>
                <td className="num strong">{tk(b.due)}</td>
                <td>{pill(BILL, b.status)}</td>
                <td>
                  <button type="button" className="button sm" onClick={() => void openDocument(`/documents/bill/${b.id}`, { title: "Preparing the bill…" })}>
                    PDF
                  </button>
                </td>
              </tr>
            ))}
          </Body>
        </table>
      </div>
    </>
  );
}

function Payouts({ a, view }: { a: Account; view: "open" | "history" }) {
  const [d, setD] = useState({ from: monthStart(), to: today() });
  const key = view === "open" ? qs({ accountId: a.id, status: "UNPAID" }) : qs({ accountId: a.id, status: "PAID", ...d });
  const data = useQuery({ queryKey: ["m", "payouts", key], queryFn: () => api<{ items: { id: string; number: string; parcels: number; createdAt: string; codTotal: number; chargesTotal: number; amount: number; status: string; method?: string; reference?: string; paidAt?: string | null; receipt?: { fileId: string } | null }[] }>(`/payouts?${key}`) });
  return (
    <>
      <Head title={view === "open" ? "Being paid" : "Paid history"} text={view === "open" ? "Settlements on their way to you." : "Paid to you in these dates, with the receipt."} tools={view === "open" ? undefined : <Dates v={d} set={setD} />} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Settlement</th>
              <th>Created</th>
              <th className="num">COD</th>
              <th className="num">Charges</th>
              <th className="num">Paid</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <Body q={data} cols={7} empty={view === "open" ? "Nothing being paid right now." : "Nothing paid in these dates."}>
            {data.data?.items.map(p => (
              <tr key={p.id}>
                <td>
                  <div className="strong">{p.number}</div>
                  <div className="sub">{p.parcels} parcel(s)</div>
                </td>
                <td className="nowrap">{when(p.createdAt)}</td>
                <td className="num">{tk(p.codTotal)}</td>
                <td className="num">−{tk(p.chargesTotal)}</td>
                <td className="num strong">{tk(p.amount)}</td>
                <td>
                  {pill(PAYOUT, p.status)}
                  {p.paidAt ? (
                    <div className="sub">
                      {methodLabel(p.method || "")}
                      {p.reference ? ` · ${p.reference}` : ""} · {day(p.paidAt)}
                    </div>
                  ) : null}
                </td>
                <td className="nowrap">
                  <button type="button" className="button sm" onClick={() => void openDocument(`/documents/payout/${p.id}`, { title: "Preparing the settlement…" })}>
                    PDF
                  </button>{" "}
                  {p.receipt ? (
                    <button type="button" className="button sm" onClick={() => openFile(p.receipt!.fileId)}>
                      Receipt photo
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </Body>
        </table>
      </div>
    </>
  );
}

function Payments({ a }: { a: Account }) {
  const [d, setD] = useState({ from: monthStart(), to: today() });
  const key = qs({ accountId: a.id, ...d });
  const data = useQuery({ queryKey: ["m", "payments", key], queryFn: () => api<{ items: { number: string; bills: { number: string; amount: number }[]; paidOn: string; method: string; reference?: string; amount: number; status: string; rejectReason?: string; receipt?: { fileId: string } | null }[] }>(`/payments?${key}`) });
  return (
    <>
      <Head title="Payments" text="What you paid in these dates. Delivery Fast confirms each one when it arrives." tools={<Dates v={d} set={setD} />} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Payment</th>
              <th>Paid on</th>
              <th>How</th>
              <th className="num">Amount</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <Body q={data} cols={6} empty="No payments in these dates.">
            {data.data?.items.map(p => (
              <tr key={p.number}>
                <td>
                  <div className="strong">{p.number}</div>
                  {p.bills.length ? <div className="sub">{p.bills.map(b => `${b.number} ${tk(b.amount)}`).join(", ")}</div> : null}
                </td>
                <td>{p.paidOn}</td>
                <td>
                  {methodLabel(p.method)}
                  {p.reference ? <div className="sub">{p.reference}</div> : null}
                </td>
                <td className="num strong">{tk(p.amount)}</td>
                <td>
                  {pill(PAYMENT, p.status)}
                  {p.rejectReason ? <div className="sub">{p.rejectReason}</div> : null}
                </td>
                <td>
                  {p.receipt ? (
                    <button type="button" className="button sm" onClick={() => openFile(p.receipt!.fileId)}>
                      Receipt
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </Body>
        </table>
      </div>
    </>
  );
}

function Statement({ a, stmt, setStmt }: { a: Account; stmt: { from: string; to: string }; setStmt: (v: { from: string; to: string }) => void }) {
  const key = qs(stmt);
  const data = useQuery({ queryKey: ["m", "statement", a.id, key], queryFn: () => api<{ opening: number; closing: number; lines: { date: string; trackingId?: string; description: string; reference?: string; amount: number; balance: number }[] }>(`/accounts/${a.id}/statement?${key}`) });
  const st = data.data;
  return (
    <>
      <Head title="Statement" text={a.kind === "FINANCIAL" ? "Charges minus, payments plus. A minus balance is what you owe." : "COD plus, charges and payments to you minus. The balance is what we still owe you."} tools={<Dates v={stmt} set={setStmt} />} />
      <div className="table-wrap">
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
          {!st ? (
            <Body q={data} cols={5} empty="">
              {undefined}
            </Body>
          ) : (
            <tbody>
              <tr>
                <td colSpan={4} className="strong">
                  Opening balance
                </td>
                <td className="num strong">{tk(st.opening)}</td>
              </tr>
              {st.lines.map((l, i) => (
                <tr key={i}>
                  <td className="nowrap">{when(l.date)}</td>
                  <td>{l.trackingId || ""}</td>
                  <td>
                    {l.description}
                    {l.reference ? <div className="sub">{l.reference}</div> : null}
                  </td>
                  <td className="num" style={{ color: l.amount < 0 ? "#b42318" : "#067647" }}>
                    {l.amount < 0 ? "−" : "+"}
                    {tk(Math.abs(l.amount))}
                  </td>
                  <td className="num strong">{tk(l.balance)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={4} className="strong">
                  Closing balance
                </td>
                <td className="num strong">{tk(st.closing)}</td>
              </tr>
            </tbody>
          )}
        </table>
      </div>
    </>
  );
}

/** A receipt photo made smaller (1600 px, JPEG 0.8); a PDF as it is. */
const shrinkPhoto = (file: File) =>
  new Promise<string>((resolve, reject) => {
    if (file.type === "application/pdf") {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("The file couldn't be read."));
      return reader.readAsDataURL(file);
    }
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => reject(new Error("That file isn't a photo or PDF."));
    img.src = URL.createObjectURL(file);
  });

/** "I've paid": waiting until Delivery Fast confirms it arrived; part payments welcome. */
async function paidDialog(a: Account, done: () => void) {
  const open = (await api<{ items: { id: string; number: string; due: number }[] }>(`/bills?accountId=${a.id}&status=UNPAID`).catch(() => ({ items: [] }))).items;
  await openCustom(close => <PaidForm a={a} open={open} close={close} done={done} />);
}

function PaidForm({ a, open, close, done }: { a: Account; open: { id: string; number: string; due: number }[]; close: () => void; done: () => void }) {
  const [v, setV] = useState({ amount: a.financial.due > 0 ? String(a.financial.due) : "", method: "BANK", paidOn: today(), reference: "", billId: "", note: "" });
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v, value: string) => setV(x => ({ ...x, [k]: value }));
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!(Number(v.amount) > 0)) return setError("Enter the amount you paid.");
    if (!v.paidOn) return setError("Choose the date you paid.");
    setBusy(true);
    setError("");
    try {
      const body = { amount: Number(v.amount), method: v.method, paidOn: v.paidOn, reference: v.reference.trim() || undefined, billId: v.billId || undefined, note: v.note.trim() || undefined, proof: file ? await shrinkPhoto(file) : undefined };
      const p = await api<{ number: string }>(`/accounts/${a.id}/payments`, { method: "POST", body });
      toast(`${p.number} sent: Delivery Fast confirms it when the money arrives.`, "good");
      close();
      done();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} noValidate>
      <div className="dialog-head">
        <div>
          <h2>I've paid</h2>
          <p>Tell us about your payment. It shows as waiting until Delivery Fast confirms it arrived. Part payments are welcome.</p>
        </div>
        <button type="button" className="button ghost icon dialog-close" aria-label="Close" onClick={close}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="dialog-body">
        <div className="form-grid">
          <label className="field">
            <span>Amount (৳)</span>
            <input className="input" type="number" min={0.01} step={0.01} inputMode="decimal" required value={v.amount} onChange={e => set("amount", e.target.value)} />
          </label>
          <label className="field">
            <span>Paid by</span>
            <Select className="select" searchable={false} value={v.method} onChange={e => set("method", e.target.value)}>
              {METHODS.filter(x => x[0] !== "CASH").map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </label>
          <label className="field">
            <span>Paid on</span>
            <input className="input" type="date" required value={v.paidOn} onChange={e => set("paidOn", e.target.value)} />
          </label>
          <label className="field">
            <span>Transaction / cheque reference</span>
            <input className="input" maxLength={120} value={v.reference} onChange={e => set("reference", e.target.value)} />
          </label>
          {open.length ? (
            <label className="field full">
              <span>For bill</span>
              <Select className="select" searchable={false} value={v.billId} onChange={e => set("billId", e.target.value)}>
                <option value="">Oldest bills first</option>
                {open.map(b => (
                  <option key={b.id} value={b.id}>{`${b.number} · due ${tk(b.due)}`}</option>
                ))}
              </Select>
            </label>
          ) : null}
          <label className="field full">
            <span>Receipt (photo or PDF, optional)</span>
            <input className="input" type="file" accept="image/*,application/pdf" onChange={e => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <label className="field full">
            <span>Note (optional)</span>
            <textarea className="input" rows={3} maxLength={300} value={v.note} onChange={e => set("note", e.target.value)} />
          </label>
        </div>
        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}
      </div>
      <div className="dialog-foot">
        <button type="button" className="button" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={busy} aria-busy={busy || undefined}>
          Submit payment
        </button>
      </div>
    </form>
  );
}
