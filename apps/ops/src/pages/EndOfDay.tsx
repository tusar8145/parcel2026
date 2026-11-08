/**
 * Hub desk › End of day (bridge-desk.js): arrivals expected vs received, dispatches, held now, ready for collection,
 * and cash on delivery (collected, handed over, still with riders) for a hub and a day (Dhaka time), with its PDF.
 */
import { Select } from "@panel/ui/Select";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { useLive } from "@panel/lib/events";
import { num } from "@panel/lib/format";
import { useOps } from "@/lib/ops";
import { Button, Metric, Panel } from "@panel/ui/kit";
import { openDocument } from "@/features/parcels/actions";

const dhakaToday = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
const taka = (v: unknown) => `৳${Number(v || 0).toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const kept = { hubId: "", date: "" };

interface Recon {
  date: string;
  isToday: boolean;
  parcels: { expected: number; received: number; stillExpected: number; expectedParts: { inboundBags: number; dropOffs: number; pickedUpByRiders: number }; dispatched: number; outForDelivery: number; transferred: number; transferBags: number; heldNow: number; delivered: number; readyForCollection: number };
  cash: {
    collections: number;
    collected: number;
    counterCollections: number;
    collectedAtCounter: number;
    handovers: number;
    handedOver: number;
    outstandingFromDayCollections: number;
    outstandingFromDay: number;
    outstandingCollections: number;
    outstanding: number;
    perRider: { rider: { code: string; name: string }; collected: number; collections: number; handedOver: number; withRider: number }[];
  } | null;
}

export default function EndOfDay() {
  const ops = useOps();
  const qc = useQueryClient();
  const hubs = ops.myHubs || ops.hubs.filter(h => h.active !== false);
  const [hubId, setHubId] = useState(kept.hubId && hubs.some(h => h.id === kept.hubId) ? kept.hubId : hubs[0]?.id || "");
  const [date, setDate] = useState(kept.date || dhakaToday());
  const chosenHub = hubId || hubs[0]?.id || "";
  Object.assign(kept, { hubId: chosenHub, date });
  const q = useQuery({ queryKey: ["hub-reconciliation", chosenHub, date], queryFn: () => api<Recon>(`/ops/hub-reconciliation?hubId=${encodeURIComponent(chosenHub)}&date=${date}`), enabled: !!chosenHub });
  useLive(["parcel.updated", "cod.handover_request"], () => date === dhakaToday() && void qc.invalidateQueries({ queryKey: ["hub-reconciliation"] }), { debounceMs: 2500 });
  const hub = hubs.find(h => h.id === chosenHub);
  const r = q.data;
  const p = r?.parcels;
  const now = r?.isToday ? "now" : "at the time of viewing";
  const c = r?.cash;
  const balance = c ? Number(c.collected) - Number(c.handedOver) : 0;
  return (
    <>
      <Panel
        title={`End of day${hub ? ` · ${hub.name}` : ""}`}
        subtitle="Arrivals, dispatches and cash for the day (Dhaka time) · held and ready-for-collection counts are as of now"
        tools={
          <>
            {hubs.length > 1 ? (
              <Select className="select sm" aria-label="Hub" value={chosenHub} onChange={e => setHubId(e.target.value)}>
                {hubs.map(h => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </Select>
            ) : null}
            <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
              Day
              <input className="input sm" type="date" value={date} max={dhakaToday()} onChange={e => e.target.value && setDate(e.target.value > dhakaToday() ? dhakaToday() : e.target.value)} />
            </label>
            <Button size="sm" icon="refresh" onClick={() => q.refetch()}>
              Refresh
            </Button>
            <Button size="sm" icon="print" disabled={!chosenHub} onClick={() => openDocument(`/documents/hub-reconciliation?hubId=${encodeURIComponent(chosenHub)}&date=${date}`, { title: "Preparing the end-of-day reconciliation…" })}>
              Print (PDF)
            </Button>
          </>
        }
      >
        <div className="panel-body">
          {!p ? (
            <p className="muted" style={{ margin: 0 }}>
              {q.isError ? describe(q.error) : q.isLoading ? "Loading the day's figures…" : "Choose a hub and a day."}
            </p>
          ) : (
            <div className="metrics" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 0 }}>
              <Metric label="Arrivals expected" value={num(p.expected)} icon="box" foot={`${num(p.received)} received`} note={`+ ${num(p.stillExpected)} still expected`} />
              <Metric label="Received" value={num(p.received)} icon="check" foot="arrived at the hub" note={r!.date} />
              <Metric label="Still expected" value={num(p.stillExpected)} icon="clock" foot={`${num(p.expectedParts.inboundBags)} in bags · ${num(p.expectedParts.dropOffs)} drop-offs`} note={`${num(p.expectedParts.pickedUpByRiders)} with pickup riders`} />
              <Metric label="Dispatched out" value={num(p.dispatched)} icon="truck" foot={`${num(p.outForDelivery)} out for delivery`} note={`${num(p.transferred)} transferred (${num(p.transferBags)} bags)`} />
              <Metric label="Held at the hub" value={num(p.heldNow)} icon="pin" foot={now} note={`${num(p.delivered)} delivered today`} />
              <Metric label="Ready for collection" value={num(p.readyForCollection)} icon="users" foot={now} note="waiting on Collect from hub" />
            </div>
          )}
        </div>
      </Panel>
      {c ? (
        <div className="grid-2" style={{ marginTop: 16, alignItems: "start" }}>
          <Panel title="Cash on delivery" subtitle={`${r!.date} · ${balance > 0.004 ? `${taka(balance)} more collected than handed over` : balance < -0.004 ? `${taka(-balance)} handed over from earlier days` : "collected and handed over match"}`}>
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Count</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["COD collected (riders + counter)", c.collections, c.collected],
                    ["of which at the hub counter", c.counterCollections, c.collectedAtCounter],
                    ["Cash handovers received", c.handovers, c.handedOver],
                    ["Collected that day, not handed over", c.outstandingFromDayCollections, c.outstandingFromDay],
                    ["Still with riders (any day)", c.outstandingCollections, c.outstanding],
                  ] as [string, number, number][]
                ).map(([label, n, amount]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td className="num">{num(n)}</td>
                    <td className="num strong">{taka(amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="Cash by rider" subtitle="Collected and handed over that day; still with the rider from any day">
            <table className="table">
              <thead>
                <tr>
                  <th>Rider</th>
                  <th className="num">Collected</th>
                  <th className="num">Handed over</th>
                  <th className="num">Still with rider</th>
                </tr>
              </thead>
              <tbody>
                {c.perRider.length ? (
                  c.perRider.map(x => (
                    <tr key={x.rider.code}>
                      <td>
                        {x.rider.code} · {x.rider.name}
                      </td>
                      <td className="num">
                        {taka(x.collected)}
                        <span className="sub">{`${num(x.collections)} collection${x.collections === 1 ? "" : "s"}`}</span>
                      </td>
                      <td className="num">{taka(x.handedOver)}</td>
                      <td className="num" style={Number(x.withRider) > 0 ? { color: "var(--bad)", fontWeight: 600 } : undefined}>
                        {taka(x.withRider)}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="empty">
                      No rider cash for this hub.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Panel>
        </div>
      ) : null}
    </>
  );
}
