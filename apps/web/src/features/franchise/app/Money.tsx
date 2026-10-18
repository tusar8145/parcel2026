"use client";

import { useEffect, useState } from "react";
import { Dialog, Empty, Field, Metric, Pill, api, day, tk, useAction, useApi, when, type Me, type Rider } from "./ui";

interface Deposit {
  id: string;
  number: string;
  status: "PENDING" | "RECEIVED" | "CANCELLED";
  hub: { id: string; name: string };
  gross: number;
  commissionDeducted: number;
  net: number;
  requestedAt: string;
  receivedAt: string | null;
}
interface Cash {
  codOnHand: number;
  counterOnHand: number;
  onHand: number;
  withRiders: number;
  pendingHandovers: number;
  unsettledCommission: number;
  settlementMode: "DEDUCT" | "BILL";
  depositNow: { gross: number; commissionDeducted: number; net: number };
  riders: { riderId: string; amount: number; collectionIds: string[]; parcels: string[] }[];
  handoverRequests: { id: string; rider: { id: string; code: string; user: { name: string } }; amount: number }[];
  remittances: Deposit[];
}
interface Commissions {
  items: { type: string; trackingId: string; base: number; percent: number; minimum: number; amount: number; earnedAt: string; state: string }[];
  invoices: { id: string; number: string; status: string; settlement: string; periodFrom: string; periodTo: string; amount: number; createdAt: string; paidAt: string | null }[];
}

const TYPE: Record<string, string> = { PICKUP: "Pickup", DELIVERY: "Delivery", RETURN: "Return" };
const DEPOSIT_TONE = { PENDING: "amber", RECEIVED: "green", CANCELLED: "" } as const;
const INVOICE_TONE: Record<string, "" | "green" | "blue" | "amber"> = { ISSUED: "amber", APPROVED: "blue", PAID: "green", VOID: "" };

/** Cash the franchise holds, rider cash to receive, deposits at a company hub, commission and invoices. */
export default function Money({ me }: { me: Me }) {
  const cash = useApi<Cash>("/franchise/cash", ["franchise.cash", "parcel.updated"]);
  const comm = useApi<Commissions>("/franchise/commissions", ["franchise.cash", "parcel.updated"]);
  const riders = useApi<Rider[]>("/franchise/riders");
  const { busy, run } = useAction();
  const [depositing, setDepositing] = useState(false);
  const c = cash.data;
  const riderName = (id: string) => {
    const r = riders.data?.find(x => x.id === id);
    return r ? `${r.code} · ${r.name}` : "Rider";
  };
  const reloadAll = () => {
    void cash.reload();
    void comm.reload();
  };

  return (
    <>
      <div className="fr-heading">
        <div>
          <p className="fr-eyebrow">{me.hub.name}</p>
          <h1>Money & invoices</h1>
          <p>{me.settlementMode === "DEDUCT" ? "Deposit the cash you hold at a Delivery Fast hub; you keep your commission from it." : `Deposit all the cash you hold; Delivery Fast pays your commission every ${me.billingPeriodDays} days.`}</p>
        </div>
        <button type="button" className="fr-btn primary" id="frDeposit" disabled={!c || !(c.onHand > 0) || c.remittances.some(r => r.status === "PENDING")} onClick={() => setDepositing(true)}>
          Deposit cash
        </button>
      </div>
      {cash.error ? <div className="fr-notice amber">{cash.error}</div> : null}
      {c ? (
        <>
          <section className="fr-metrics" id="frCash" aria-label="Cash">
            <Metric label="Cash you hold" value={tk(c.onHand)} foot={`COD ${tk(c.codOnHand)} · counter ${tk(c.counterOnHand)}`} tone="warn" />
            <Metric label="Cash with your riders" value={tk(c.withRiders)} foot={c.pendingHandovers ? `${c.pendingHandovers} waiting to hand over` : "Nothing waiting"} />
            <Metric label="Commission not settled" value={tk(c.unsettledCommission)} foot={c.settlementMode === "DEDUCT" ? "Kept from your next deposit" : "Paid by Delivery Fast"} tone="accent" />
          </section>

          <section className="fr-card" aria-label="Rider cash">
            <div className="fr-card-head">
              <div>
                <h2>Rider cash to receive</h2>
                <p>COD your riders collected. Count it and receive it when they hand it over.</p>
              </div>
            </div>
            {c.riders.length ? (
              <div className="fr-table-wrap">
                <table className="fr-table" id="frRiderCash">
                  <thead>
                    <tr>
                      <th>Rider</th>
                      <th>Parcels</th>
                      <th className="num">Cash</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {c.riders.map(r => (
                      <tr key={r.riderId} data-rider-cash={r.riderId}>
                        <td>
                          <strong>{riderName(r.riderId)}</strong>
                          {c.handoverRequests.some(h => h.rider.id === r.riderId) ? <small>Asked to hand over</small> : null}
                        </td>
                        <td>{r.parcels.join(", ")}</td>
                        <td className="num">{tk(r.amount)}</td>
                        <td className="actions">
                          <button
                            type="button"
                            className="fr-btn sm primary"
                            disabled={busy === r.riderId}
                            onClick={() =>
                              void run(r.riderId, () => api("/franchise/cash/handovers", { method: "POST", body: { riderId: r.riderId, collectionIds: r.collectionIds, amountReceived: r.amount } }), `${tk(r.amount)} received from ${riderName(r.riderId)}.`).then(x => x !== undefined && reloadAll())
                            }
                          >
                            {`Receive ${tk(r.amount)}`}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>No rider cash to receive.</Empty>
            )}
          </section>

          <section className="fr-card" aria-label="Deposits">
            <div className="fr-card-head">
              <div>
                <h2>Deposits</h2>
                <p>Cash you took to a Delivery Fast hub. The hub confirms it when it counts the cash.</p>
              </div>
            </div>
            {c.remittances.length ? (
              <div className="fr-table-wrap">
                <table className="fr-table" id="frDeposits">
                  <thead>
                    <tr>
                      <th>Deposit</th>
                      <th>Hub</th>
                      <th className="num">Cash</th>
                      <th className="num">Commission kept</th>
                      <th className="num">Deposited</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {c.remittances.map(r => (
                      <tr key={r.id} data-deposit={r.number}>
                        <td>
                          <strong>{r.number}</strong>
                          <small>{when(r.requestedAt)}</small>
                        </td>
                        <td>{r.hub.name}</td>
                        <td className="num">{tk(r.gross)}</td>
                        <td className="num">{r.commissionDeducted ? tk(r.commissionDeducted) : "—"}</td>
                        <td className="num">{tk(r.net)}</td>
                        <td>
                          <Pill tone={DEPOSIT_TONE[r.status]}>{r.status === "PENDING" ? "Waiting for the hub" : r.status === "RECEIVED" ? `Received ${when(r.receivedAt)}` : "Cancelled"}</Pill>
                        </td>
                        <td className="actions">
                          {r.status === "PENDING" ? (
                            <button type="button" className="fr-btn sm danger" disabled={busy === r.id} onClick={() => void run(r.id, () => api(`/franchise/deposits/${r.id}/cancel`, { method: "POST" }), `${r.number} cancelled.`).then(x => x !== undefined && reloadAll())}>
                              Cancel
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>No deposits yet.</Empty>
            )}
          </section>
        </>
      ) : (
        <div className="fr-loading">Loading…</div>
      )}

      <section className="fr-card" aria-label="Commission">
        <div className="fr-card-head">
          <div>
            <h2>Commission</h2>
            <p>{`Pickup ${me.rates.pickupPercent}% · delivery ${me.rates.deliveryPercent}% · return ${me.rates.returnPercent}% of the delivery charge (each with its minimum).`}</p>
          </div>
          <button
            type="button"
            className="fr-btn"
            id="frCreateInvoice"
            disabled={busy === "invoice"}
            onClick={() => void run("invoice", () => api<{ number: string }>("/franchise/invoices", { method: "POST" }), i => `Invoice ${i.number} created.`).then(x => x !== undefined && reloadAll())}
          >
            Create invoice
          </button>
        </div>
        {comm.data?.invoices.length ? (
          <div className="fr-table-wrap" style={{ marginBottom: 14 }}>
            <table className="fr-table" id="frInvoices">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Period</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {comm.data.invoices.map(i => (
                  <tr key={i.id} data-invoice={i.number}>
                    <td>
                      <strong>{i.number}</strong>
                      <small>{i.settlement === "DEDUCTED" ? "Kept from deposits" : "Paid by Delivery Fast"}</small>
                    </td>
                    <td>{`${day(i.periodFrom)} – ${day(i.periodTo)}`}</td>
                    <td className="num">{tk(i.amount)}</td>
                    <td>
                      <Pill tone={INVOICE_TONE[i.status] ?? ""}>{i.status === "ISSUED" ? "Waiting for approval" : i.status === "APPROVED" ? "Approved" : i.status === "PAID" ? "Paid" : "Void"}</Pill>
                    </td>
                    <td className="actions">
                      <button type="button" className="fr-btn sm" onClick={() => void window.DFPrint?.open(`/franchise/invoices/${i.id}/pdf`, { title: "Preparing the invoice…" })}>
                        PDF
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {comm.data?.items.length ? (
          <div className="fr-table-wrap">
            <table className="fr-table" id="frCommissions">
              <thead>
                <tr>
                  <th>Parcel</th>
                  <th>For</th>
                  <th className="num">Delivery charge</th>
                  <th className="num">Rate</th>
                  <th className="num">Commission</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {comm.data.items.map(x => (
                  <tr key={`${x.type}:${x.trackingId}`}>
                    <td>
                      <strong>{x.trackingId}</strong>
                      <small>{when(x.earnedAt)}</small>
                    </td>
                    <td>{TYPE[x.type] ?? x.type}</td>
                    <td className="num">{tk(x.base)}</td>
                    <td className="num">{`${x.percent}%${x.minimum ? ` · min ${tk(x.minimum)}` : ""}`}</td>
                    <td className="num">{tk(x.amount)}</td>
                    <td>
                      <Pill tone={x.state === "invoiced" ? "green" : x.state === "deducted" ? "blue" : "amber"}>{x.state === "invoiced" ? "Invoiced" : x.state === "deducted" ? "Kept from deposit" : "Not settled"}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No commission yet. You earn it on every pickup, delivery and return by your hub.</Empty>
        )}
      </section>

      {depositing && c ? (
        <DepositDialog
          me={me}
          cash={c}
          onClose={() => setDepositing(false)}
          onDone={() => {
            setDepositing(false);
            reloadAll();
          }}
        />
      ) : null}
    </>
  );
}

function DepositDialog({ me, cash, onClose, onDone }: { me: Me; cash: Cash; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [hubId, setHubId] = useState(me.depositHubs[0]?.id ?? "");
  useEffect(() => setHubId(h => h || me.depositHubs[0]?.id || ""), [me.depositHubs]);
  const d = cash.depositNow;
  return (
    <Dialog title="Deposit cash" subtitle="Take the cash to the hub you choose; the hub counts it and confirms." onClose={onClose}>
      <Field label="Delivery Fast hub" htmlFor="frDepositHub">
        <select id="frDepositHub" value={hubId} onChange={e => setHubId(e.target.value)}>
          {me.depositHubs.map(h => (
            <option key={h.id} value={h.id}>{`${h.name} (${h.district})`}</option>
          ))}
        </select>
      </Field>
      <div className="fr-quote" style={{ marginTop: 12 }}>
        <div className="line">
          <span>Cash you hold</span>
          <span>{tk(d.gross)}</span>
        </div>
        {d.commissionDeducted ? (
          <div className="line">
            <span>Your commission, kept</span>
            <span>{`− ${tk(d.commissionDeducted)}`}</span>
          </div>
        ) : null}
        <div className="total">
          <span>Hand over at the hub</span>
          <span id="frDepositNet">{tk(d.net)}</span>
        </div>
      </div>
      <div className="fr-dialog-actions">
        <button type="button" className="fr-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="fr-btn primary"
          id="frDepositSubmit"
          disabled={!hubId || busy === "deposit"}
          onClick={() => void run("deposit", () => api<{ number: string }>("/franchise/deposits", { method: "POST", body: { hubId } }), r => `${r.number}: take ${tk(d.net)} to the hub.`).then(x => x !== undefined && onDone())}
        >
          Request deposit
        </button>
      </div>
    </Dialog>
  );
}
