"use client";

import { Metric, commissionText, tk, useApi, type Me } from "./ui";

interface OverviewData {
  today: { pickups: number; delivered: number; failed: number; returned: number; commission: number };
  now: { atHub: number; incoming: number; pickups: number; outForDelivery: number; riders: number };
  cash: { onHand: number; withRiders: number; pendingHandovers: number; unsettledCommission: number };
  commissionThisMonth: number;
}

export default function Overview({ me, go }: { me: Me; go: (slug: "parcels" | "walk-in" | "riders" | "money") => void }) {
  const { data, error } = useApi<OverviewData>("/franchise/overview", ["parcel.updated", "parcel.created", "franchise.cash"]);
  return (
    <>
      <div className="fr-heading">
        <div>
          <p className="fr-eyebrow">{me.hub.name}</p>
          <h1>{`Good to see you, ${me.contactName.split(" ")[0]}`}</h1>
          <p>Today at your hub, the cash you hold and what you earn.</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="fr-btn" onClick={() => go("parcels")}>
            Receive parcels
          </button>
          <button type="button" className="fr-btn primary" onClick={() => go("walk-in")}>
            New walk-in booking
          </button>
        </div>
      </div>
      {error ? <div className="fr-notice amber">{error}</div> : null}
      {!data ? (
        <div className="fr-loading">Loading…</div>
      ) : (
        <>
          <section aria-label="Today" className="fr-metrics" id="frToday">
            <Metric label="Picked up today" value={String(data.today.pickups)} foot="Rider pickups and drop-offs" />
            <Metric label="Delivered today" value={String(data.today.delivered)} />
            <Metric label="Failed attempts today" value={String(data.today.failed)} />
            <Metric label="Returned today" value={String(data.today.returned)} />
            <Metric label="Commission today" value={tk(data.today.commission)} tone="accent" />
          </section>
          <div className="fr-grid">
            <section className="fr-card">
              <div className="fr-card-head">
                <div>
                  <h2>Right now</h2>
                  <p>Work waiting at your hub.</p>
                </div>
              </div>
              <div className="fr-rows">
                <div className="fr-row">
                  <span>Parcels at your hub</span>
                  <b>{data.now.atHub}</b>
                </div>
                <div className="fr-row">
                  <span>On the way to you (to receive)</span>
                  <b>{data.now.incoming}</b>
                </div>
                <div className="fr-row">
                  <span>Pickups to do</span>
                  <b>{data.now.pickups}</b>
                </div>
                <div className="fr-row">
                  <span>Out for delivery</span>
                  <b>{data.now.outForDelivery}</b>
                </div>
                <div className="fr-row">
                  <span>Riders</span>
                  <b>{data.now.riders}</b>
                </div>
              </div>
            </section>
            <section className="fr-card">
              <div className="fr-card-head">
                <div>
                  <h2>Cash</h2>
                  <p>{me.settlementMode === "DEDUCT" ? "You keep your commission when you deposit." : "Deposit everything; Delivery Fast pays your commission."}</p>
                </div>
                <button type="button" className="fr-btn sm" onClick={() => go("money")}>
                  Deposit
                </button>
              </div>
              <div className="fr-rows">
                <div className="fr-row">
                  <span>Cash you hold</span>
                  <b>{tk(data.cash.onHand)}</b>
                </div>
                <div className="fr-row">
                  <span>Cash with your riders</span>
                  <b>{tk(data.cash.withRiders)}</b>
                </div>
                <div className="fr-row">
                  <span>Riders waiting to hand over</span>
                  <b>{data.cash.pendingHandovers}</b>
                </div>
              </div>
            </section>
            <section className="fr-card">
              <div className="fr-card-head">
                <div>
                  <h2>Commission</h2>
                  <p>On the delivery charge of each parcel.</p>
                </div>
              </div>
              <div className="fr-rows">
                <div className="fr-row">
                  <span>This month</span>
                  <b>{tk(data.commissionThisMonth)}</b>
                </div>
                <div className="fr-row">
                  <span>Not settled yet</span>
                  <b>{tk(data.cash.unsettledCommission)}</b>
                </div>
                <div className="fr-row">
                  <span>Pickup</span>
                  <b>{commissionText(me.rates.pickupPercent, me.rates.pickupMin)}</b>
                </div>
                <div className="fr-row">
                  <span>Delivery</span>
                  <b>{commissionText(me.rates.deliveryPercent, me.rates.deliveryMin)}</b>
                </div>
                <div className="fr-row">
                  <span>Return</span>
                  <b>{commissionText(me.rates.returnPercent, me.rates.returnMin)}</b>
                </div>
              </div>
            </section>
          </div>
        </>
      )}
    </>
  );
}
