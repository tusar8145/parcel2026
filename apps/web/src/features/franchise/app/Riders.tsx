"use client";

import { useState } from "react";
import { Dialog, Empty, Field, Pill, api, tk, useAction, useApi, when, type Me, type Rider } from "./ui";

interface Earnings {
  rider: { id: string; code: string; name: string };
  unpaid: number;
  lines: { type: string; amount: number; trackingId: string | null; description: string; earnedAt: string }[];
  payments: { number: string; amount: number; method: string | null; reference: string | null; paidAt: string | null }[];
}

const VEHICLES = [
  ["MOTORBIKE", "Motorbike"],
  ["BICYCLE", "Bicycle"],
  ["VAN", "Van"],
  ["ON_FOOT", "On foot"],
] as const;

/** The franchise's own riders: add them, set what it pays them, see and pay their earnings. */
export default function Riders({ me, onRatesSaved }: { me: Me; onRatesSaved: () => void }) {
  const list = useApi<Rider[]>("/franchise/riders", ["parcel.updated"]);
  const { busy, run } = useAction();
  const [adding, setAdding] = useState(false);
  const [earningsFor, setEarningsFor] = useState<Rider | null>(null);
  const [rates, setRates] = useState({ pickup: String(me.riderRates.pickup), delivery: String(me.riderRates.delivery), return: String(me.riderRates.return) });

  const saveRates = (e: React.FormEvent) => {
    e.preventDefault();
    void run("rates", () => api("/franchise/rider-rates", { method: "PUT", body: { pickup: Number(rates.pickup) || 0, delivery: Number(rates.delivery) || 0, return: Number(rates.return) || 0 } }), "Rider pay saved.").then(r => r !== undefined && onRatesSaved());
  };
  const toggle = (r: Rider) =>
    void run(r.id, () => api(`/franchise/riders/${r.id}`, { method: "PATCH", body: { active: !r.active } }), r.active ? `${r.name} can't take new work now.` : `${r.name} is active again.`).then(x => {
      if (x !== undefined) void list.reload();
    });

  const riders = list.data ?? [];
  return (
    <>
      <div className="fr-heading">
        <div>
          <p className="fr-eyebrow">{me.hub.name}</p>
          <h1>Riders</h1>
          <p>Your own riders. They work only for your hub and sign in to the Paira Express rider app.</p>
        </div>
        <button type="button" className="fr-btn primary" id="frAddRider" onClick={() => setAdding(true)}>
          Add rider
        </button>
      </div>

      <section className="fr-card">
        <div className="fr-card-head">
          <div>
            <h2>What you pay your riders</h2>
            <p>Per task, for every rider of your hub. You pay them yourself; Paira Express shows what each one has earned.</p>
          </div>
        </div>
        <form className="fr-form" onSubmit={saveRates} id="frRatesForm">
          <Field label="Per pickup (৳)" htmlFor="frRatePickup">
            <input id="frRatePickup" type="number" min="0" step="1" value={rates.pickup} onChange={e => setRates(r => ({ ...r, pickup: e.target.value }))} />
          </Field>
          <Field label="Per delivery (৳)" htmlFor="frRateDelivery">
            <input id="frRateDelivery" type="number" min="0" step="1" value={rates.delivery} onChange={e => setRates(r => ({ ...r, delivery: e.target.value }))} />
          </Field>
          <Field label="Per return (৳)" htmlFor="frRateReturn">
            <input id="frRateReturn" type="number" min="0" step="1" value={rates.return} onChange={e => setRates(r => ({ ...r, return: e.target.value }))} />
          </Field>
          <div>
            <button type="submit" className="fr-btn primary" disabled={busy === "rates"}>
              Save rider pay
            </button>
          </div>
        </form>
      </section>

      <section className="fr-card">
        <div className="fr-card-head">
          <div>
            <h2>{`${riders.length} rider${riders.length === 1 ? "" : "s"}`}</h2>
          </div>
        </div>
        <div className="fr-table-wrap">
          <table className="fr-table" id="frRiders">
            <thead>
              <tr>
                <th>Rider</th>
                <th>Vehicle</th>
                <th>Status</th>
                <th className="num">Out now</th>
                <th className="num">Cash with rider</th>
                <th className="num">Unpaid earnings</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {riders.map(r => (
                <tr key={r.id} data-rider={r.code}>
                  <td>
                    <strong>{`${r.code} · ${r.name}`}</strong>
                    <small>{`${r.phone} · ${r.lastLoginAt ? `last sign-in ${when(r.lastLoginAt)}` : "not signed in yet"}`}</small>
                  </td>
                  <td>{VEHICLES.find(v => v[0] === r.vehicle)?.[1] ?? r.vehicle}</td>
                  <td>{r.active ? <Pill tone="green">{r.status === "ONLINE" ? "Online" : "Active"}</Pill> : <Pill>Inactive</Pill>}</td>
                  <td className="num">{r.outForDelivery}</td>
                  <td className="num">{tk(r.cashWithRider)}</td>
                  <td className="num">{tk(r.unpaid)}</td>
                  <td className="actions">
                    <button type="button" className="fr-btn sm" data-earnings onClick={() => setEarningsFor(r)}>
                      Earnings
                    </button>{" "}
                    <button type="button" className={`fr-btn sm${r.active ? " danger" : ""}`} disabled={busy === r.id} onClick={() => toggle(r)}>
                      {r.active ? "Deactivate" : "Activate"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.loading && !riders.length ? <Empty>No riders yet. Add your first rider to start pickups and deliveries.</Empty> : null}
        </div>
      </section>

      {adding ? (
        <AddRider
          me={me}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void list.reload();
          }}
        />
      ) : null}
      {earningsFor ? (
        <EarningsDialog
          rider={earningsFor}
          onClose={() => setEarningsFor(null)}
          onPaid={() => {
            void list.reload();
          }}
        />
      ) : null}
    </>
  );
}

function AddRider({ me, onClose, onDone }: { me: Me; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [f, setF] = useState({ name: "", phone: "", email: "", vehicle: "MOTORBIKE", zone: "" });
  const [errors, setErrors] = useState<{ name?: string; phone?: string }>({});
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const err: typeof errors = {};
    if (f.name.trim().length < 2) err.name = "Enter the rider's name";
    if (!/^(?:\+?880|0)?1[3-9]\d{8}$/.test(f.phone.replace(/[\s-]/g, ""))) err.phone = "Enter a valid mobile number";
    setErrors(err);
    if (Object.keys(err).length) return;
    void run(
      "add",
      () => api("/franchise/riders", { method: "POST", body: { name: f.name.trim(), phone: f.phone.trim(), email: f.email.trim() || undefined, vehicle: f.vehicle, zone: f.zone.trim() || undefined } }),
      `${f.name.trim()} added. They get an SMS to sign in to the rider app.`,
    ).then(r => r !== undefined && onDone());
  };
  return (
    <Dialog title="Add a rider" subtitle={`They work only for ${me.hub.name} and sign in to the rider app with an SMS code.`} onClose={onClose}>
      <form className="fr-form" onSubmit={submit} noValidate id="frAddRiderForm">
        <Field label="Name" htmlFor="arName" error={errors.name} full>
          <input id="arName" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} autoComplete="off" />
        </Field>
        <Field label="Mobile" htmlFor="arPhone" error={errors.phone}>
          <input id="arPhone" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} inputMode="tel" placeholder="01XXXXXXXXX" autoComplete="off" />
        </Field>
        <Field label="Email (optional)" htmlFor="arEmail">
          <input id="arEmail" type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} autoComplete="off" />
        </Field>
        <Field label="Vehicle" htmlFor="arVehicle">
          <select id="arVehicle" value={f.vehicle} onChange={e => setF({ ...f, vehicle: e.target.value })}>
            {VEHICLES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Usual area (optional)" htmlFor="arZone">
          <input id="arZone" value={f.zone} onChange={e => setF({ ...f, zone: e.target.value })} autoComplete="off" />
        </Field>
        <div className="fr-dialog-actions full" style={{ gridColumn: "1 / -1" }}>
          <button type="button" className="fr-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="fr-btn primary" disabled={busy === "add"}>
            Add rider
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function EarningsDialog({ rider, onClose, onPaid }: { rider: Rider; onClose: () => void; onPaid: () => void }) {
  const data = useApi<Earnings>(`/franchise/riders/${rider.id}/earnings`);
  const { busy, run } = useAction();
  const [method, setMethod] = useState("CASH");
  const [reference, setReference] = useState("");
  const e = data.data;
  const pay = () =>
    void run("pay", () => api(`/franchise/riders/${rider.id}/payments`, { method: "POST", body: { method, reference: reference.trim() || undefined } }), p => `Paid ${tk((p as { amount: number }).amount)} to ${rider.name}.`).then(r => {
      if (r === undefined) return;
      void data.reload();
      onPaid();
    });
  return (
    <Dialog title={`Earnings · ${rider.code} ${rider.name}`} subtitle="Work done for your hub at your rider pay." onClose={onClose}>
      {!e ? (
        <div className="fr-loading">Loading…</div>
      ) : (
        <>
          <div className="fr-rows">
            <div className="fr-row">
              <span>Unpaid</span>
              <b id="frUnpaid">{tk(e.unpaid)}</b>
            </div>
          </div>
          {e.lines.length ? (
            <div className="fr-table-wrap" style={{ maxHeight: 220, overflow: "auto", marginTop: 8 }}>
              <table className="fr-table">
                <tbody>
                  {e.lines.map((l, i) => (
                    <tr key={i}>
                      <td>
                        {l.description}
                        <small>{when(l.earnedAt)}</small>
                      </td>
                      <td className="num">{tk(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {e.unpaid > 0 ? (
            <div className="fr-form" style={{ marginTop: 12 }}>
              <Field label="Paid by" htmlFor="payMethod">
                <select id="payMethod" value={method} onChange={x => setMethod(x.target.value)}>
                  <option value="CASH">Cash</option>
                  <option value="BKASH">bKash</option>
                  <option value="NAGAD">Nagad</option>
                  <option value="ROCKET">Rocket</option>
                  <option value="BANK_TRANSFER">Bank transfer</option>
                </select>
              </Field>
              <Field label="Reference (optional)" htmlFor="payRef">
                <input id="payRef" value={reference} onChange={x => setReference(x.target.value)} autoComplete="off" />
              </Field>
            </div>
          ) : null}
          {e.payments.length ? (
            <>
              <p className="fr-section-title" style={{ marginTop: 14 }}>
                Payments
              </p>
              <div className="fr-rows">
                {e.payments.map(p => (
                  <div className="fr-row" key={p.number}>
                    <span>{`${p.number} · ${when(p.paidAt)}${p.method ? ` · ${p.method}` : ""}`}</span>
                    <b>{tk(p.amount)}</b>
                  </div>
                ))}
              </div>
            </>
          ) : null}
          <div className="fr-dialog-actions">
            <button type="button" className="fr-btn" onClick={onClose}>
              Close
            </button>
            {e.unpaid > 0 ? (
              <button type="button" className="fr-btn primary" id="frPayRider" disabled={busy === "pay"} onClick={pay}>
                {`Mark ${tk(e.unpaid)} as paid`}
              </button>
            ) : null}
          </div>
        </>
      )}
    </Dialog>
  );
}
