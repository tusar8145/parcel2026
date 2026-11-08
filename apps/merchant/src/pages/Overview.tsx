/**
 * Overview (banking-merchant/01.js dashboard + merchant-bridge.js patchDashboard / patchPeriodDashboard), from
 * GET /merchants/me/stats with the period (This month by default, remembered; Today / week / month / custom):
 *   - eight cards for the period (booked, delivered, returned, success; charges, unbilled now, picked up, in transit now)
 *   - "Document volume & delivery charges": per hour / day / month vs. the previous period
 *   - "Document delivery overview": live now, not affected by the period
 *   - Recent delivery requests and Recent activity (the newest requests and their tracking events)
 */
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "@panel/lib/api";
import { useAuth } from "@panel/lib/auth";
import { ago, money, num } from "@panel/lib/format";
import { PeriodSelect, usePeriod } from "@panel/lib/period";
import { Icon, type IconName } from "@panel/ui/Icon";
import { Button, Metric, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { useMerchant } from "@/lib/merchant";
import { openNewRequest } from "@/features/booking/NewRequest";
import { ImportButtons } from "@/pages/Requests";
import { splitContents, type Parcel } from "@/features/parcels/model";
import { pathOf } from "@/app/nav";

interface Range {
  created: number;
  delivered: number;
  returned: number;
  cancelled: number;
  pickedUp: number;
  deliverySuccessRate: number | null;
  deliveryCharges: number;
  codValue?: number;
  /** E-commerce owners: the period's COD money. */
  money?: { codCollected: number; collections: number; payable: number; chargesOnCollected: number; paidOut: number; payouts: number } | null;
  series: Series;
  previous: { created: number; delivered: number; deliverySuccessRate: number | null; deliveryCharges: number; codValue?: number; money?: { codCollected: number } | null };
}
interface Series {
  bucket: string;
  labels: string[];
  current: number[];
  previous: number[];
}
interface Stats {
  parcels: { inTransit: number; awaitingPickup: number; awaitingDropOff?: number; needsAttention: number };
  today: { shipments: number; delivered: number; completionRate: number | null };
  money: { unbilled: { charges: number; parcels: number }; payouts?: { lastPaid?: { amount: number; paidAt: string } | null } } | null;
  range?: Range;
}

const pct = (n: number | null | undefined) => (n == null ? "—" : `${Number(n).toFixed(1)}%`);
function trend(now: number, before: number | undefined) {
  if (!before) return null;
  const change = ((now - before) / before) * 100;
  return { text: `${change >= 0 ? "↑" : "↓"} ${Math.abs(change).toFixed(1)}%`, down: change < 0 };
}
const pts = (now: number | null, before: number | null | undefined) => (now === null || before === null || before === undefined ? null : { text: `${now >= before ? "↑" : "↓"} ${Math.abs(now - before).toFixed(1)} pts`, down: now < before });

export default function Overview() {
  const m = useMerchant();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [, setParams] = useSearchParams();
  const doc = m.doc;
  const period = usePeriod("merchant-banking-overview", "this_month");
  const stats = useQuery({ queryKey: ["m", "stats", "overview", period.query], queryFn: () => api<Stats>(`/merchants/me/stats?period=7d${m.q("&")}&${period.query}`), staleTime: 20_000 });
  const recent = useQuery({ queryKey: ["m", "parcels", "recent"], queryFn: () => api<{ items: Parcel[] }>(`/parcels?limit=20${m.q("&")}`), staleTime: 20_000 });
  const st = stats.data;
  const r = st?.range;
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const openParcel = (id: string) => setParams(p => (p.set("parcel", id), p));
  const card = (label: string, value: string, icon: IconName, foot: string, t?: { text: string; down?: boolean } | null) => (
    <Metric
      key={label}
      label={label}
      value={st ? value : "—"}
      icon={icon}
      foot={t ? <span style={{ color: t.down ? "var(--bad)" : "var(--good)", fontWeight: 650 }}>{t.text}</span> : null}
      note={foot}
    />
  );

  return (
    <>
      <PageHeading
        eyebrow={now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
        title={
          <>
            {greeting}, {String(user?.name || "").split(/\s+/)[0]} <span style={{ fontSize: 20 }}>{hour < 17 ? "☀️" : "🌙"}</span>
          </>
        }
        subtitle={`${period.text} · ${doc ? "documents" : "orders"}, deliveries and COD in this period; "now" figures are live`}
        actions={
          <>
            <PeriodSelect period={period} />
            {doc ? (
              <Button icon="wallet" onClick={() => navigate("/balance")}>
                Billing
              </Button>
            ) : null}
            <ImportButtons />
            <Button variant="primary" icon="plus" onClick={() => void openNewRequest(openParcel)}>
              {doc ? "New delivery request" : "Create order"}
            </Button>
          </>
        }
      />
      <div className="metrics">
        {card(doc ? "Documents booked" : "Orders booked", num(r?.created), "box", r?.previous.created ? period.versus : period.words, r ? trend(r.created, r.previous.created) : null)}
        {card("Delivered", num(r?.delivered), "truck", r?.previous.delivered ? period.versus : period.words, r ? trend(r.delivered, r.previous.delivered) : null)}
        {card("Returned", num(r?.returned), "box", `${num(r?.cancelled)} cancelled · ${period.words}`)}
        {card("Delivery success", pct(r?.deliverySuccessRate), "chart", "delivered vs. returned", r ? pts(r.deliverySuccessRate, r.previous.deliverySuccessRate) : null)}
      </div>
      <div className="metrics">
        {doc ? (
          <>
            {card("Delivery charges", money(r?.deliveryCharges), "wallet", `documents booked ${period.words}`, r ? trend(r.deliveryCharges, r.previous.deliveryCharges) : null)}
            {card("Unbilled charges", st?.money ? money(st.money.unbilled.charges) : "—", "wallet", st?.money ? "now · ready for monthly bill" : "visible to owners", st?.money ? { text: `${st.money.unbilled.parcels} consignment${st.money.unbilled.parcels === 1 ? "" : "s"}` } : null)}
            {card("Picked up", num(r?.pickedUp), "pin", period.words)}
          </>
        ) : r?.money ? (
          <>
            {card("COD collected", money(r.money.codCollected), "wallet", `${r.money.collections} collection${r.money.collections === 1 ? "" : "s"} · ${period.words}`, trend(r.money.codCollected, r.previous.money?.codCollected))}
            {card("Payable to you", money(r.money.payable), "wallet", `COD less ${money(r.money.chargesOnCollected)} charges`)}
            {card("Paid out", money(r.money.paidOut), "check", `${r.money.payouts} payout${r.money.payouts === 1 ? "" : "s"} · ${period.words}`)}
          </>
        ) : (
          <>
            {card("Gross sales", money(r?.codValue), "wallet", `COD order value · ${period.words}`, r ? trend(r.codValue ?? 0, r.previous.codValue) : null)}
            {card("Delivery charges", money(r?.deliveryCharges), "wallet", period.words)}
            {card("Picked up", num(r?.pickedUp), "pin", period.words)}
          </>
        )}
        {card("In transit", num(st?.parcels.inTransit), "truck", "now · live")}
      </div>
      <div className="content-grid">
        <Panel title={doc ? "Document volume & delivery charges" : "Orders & sales"} subtitle={r ? `${doc ? "Documents" : "Orders"} per ${r.series.bucket} · ${period.text} vs. the previous period` : doc ? "Corporate consignments across branches" : "Track your store performance over time"}>
          <div className="panel-body">{r ? <Chart series={r.series} /> : <div className="skeleton" style={{ height: 220 }} />}</div>
        </Panel>
        <Panel title={doc ? "Document delivery overview" : "Delivery overview"} subtitle="Live now · not affected by the period">
          <div className="panel-body">
          <div className="dispatch-summary">
            <div>
              <strong>{num(st?.today.shipments)}</strong>
              <span>{doc ? "Today's documents" : "Total shipments"}</span>
            </div>
            <div>
              <strong>{num(st?.today.delivered)}</strong>
              <span>{doc ? "Delivered" : "Completed today"}</span>
            </div>
            <div>
              <strong>{num(st?.parcels.needsAttention)}</strong>
              <span>{doc ? "Exceptions" : "Need attention"}</span>
            </div>
          </div>
          <div className="progress-label">
            <span>Delivery completion</span>
            <strong>{Math.round(st?.today.completionRate ?? 0)}%</strong>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${Math.min(100, st?.today.completionRate ?? 0)}%` }} />
          </div>
          <div className="dispatch-list">
            {(
              [
                ["#1d5fd0", "In transit", st?.parcels.inTransit],
                ["#0b7a3b", "Delivered", st?.today.delivered],
                ["#d4a13b", "Pickup scheduled", st?.parcels.awaitingPickup],
                ["#c02f2f", doc ? "Signature / delivery issue" : "Delivery issue", st?.parcels.needsAttention],
                ["#7c5cc4", "Awaiting drop-off", st?.parcels.awaitingDropOff ?? 0],
              ] as [string, string, number | undefined][]
            ).map(([color, label, n]) => (
              <div className="dispatch-row" key={label}>
                <span className="dispatch-label">
                  <i style={{ background: color }} />
                  {label}
                </span>
                <strong>{num(n)}</strong>
              </div>
            ))}
          </div>
          </div>
        </Panel>
      </div>
      <div className="content-grid">
        <Panel
          title={doc ? "Recent delivery requests" : "Recent orders"}
          tools={
            <Button size="sm" onClick={() => navigate(pathOf("All requests", m.doc))}>
              {doc ? "View all requests" : "View all orders"}
            </Button>
          }
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{doc ? "Consignment" : "Order"}</th>
                  <th>{doc ? "Recipient" : "Customer"}</th>
                  <th>{doc ? "Document type" : "Item / service"}</th>
                  <th>{doc ? "Delivery fee" : "Amount"}</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {(recent.data?.items ?? []).slice(0, 5).map(p => (
                  <tr key={p.trackingId}>
                    <td>
                      <button type="button" className="link-button tracking" onClick={() => openParcel(p.trackingId)}>
                        {p.trackingId}
                      </button>
                    </td>
                    <td>{p.recipient?.name || "Recipient not set"}</td>
                    <td>{doc ? splitContents(p.contents)[0] || "Business document" : p.contents || "Domestic parcel"}</td>
                    <td>{money(doc ? p.charges?.total : Number(p.codAmount) > 0 ? p.codAmount : p.declaredValue || 0)}</td>
                    <td>
                      <Pill>{p.statusLabel}</Pill>
                    </td>
                  </tr>
                ))}
                {recent.data && !recent.data.items.length ? (
                  <tr>
                    <td colSpan={5} className="empty-cell">
                      {doc ? "No delivery requests yet." : "No orders yet."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="Recent activity">
          <div className="panel-body">
            <Activity doc={doc} paid={st?.money?.payouts?.lastPaid ?? null} parcels={recent.data?.items ?? []} openParcel={openParcel} />
          </div>
        </Panel>
      </div>
    </>
  );
}

const AWAITING = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];
const MOVING = ["PICKED_UP", "AT_HUB", "IN_TRANSIT", "ASSIGNED", "OUT_FOR_DELIVERY"];

/** The newest tracking events of the newest requests (merchant-bridge.js activityItems). */
function Activity({ doc, paid, parcels, openParcel }: { doc: boolean; paid: { amount: number; paidAt: string } | null; parcels: Parcel[]; openParcel: (id: string) => void }) {
  const items = parcels
    .flatMap(p => (p.events ?? []).map(e => ({ p, e, at: e.at || e.createdAt || "" })))
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 4);
  const payout = !doc && paid ? paid : null;
  if (!items.length && !payout) return <div className="empty-cell">No activity yet. New orders and delivery updates appear here.</div>;
  return (
    <div className="activity-list">
      {payout ? (
        <div className="activity-item">
          <span className="activity-icon">
            <Icon name="wallet" />
          </span>
          <span className="activity-copy">
            <strong>Payout completed</strong> — {money(payout.amount)}
            <small>{ago(payout.paidAt)}</small>
          </span>
        </div>
      ) : null}
      {items.map(({ p, e, at }, i) => {
        const status = e.status || "";
        const icon: IconName = status === "DELIVERED" || MOVING.includes(status) ? "truck" : AWAITING.includes(status) ? "pin" : "box";
        return (
          <button key={i} type="button" className="activity-item" onClick={() => openParcel(p.trackingId)}>
            <span className="activity-icon">
              <Icon name={icon} />
            </span>
            <span className="activity-copy">
              {status === "DELIVERED" ? (
                <>
                  <strong>{p.trackingId}</strong> was delivered to {p.recipient?.name}
                </>
              ) : status === "PENDING_CONFIRMATION" ? (
                <>
                  <strong>{doc ? "New document request" : "New order"}</strong> for {p.recipient?.name}
                </>
              ) : (
                <>
                  <strong>{p.trackingId}</strong> · {e.title}
                </>
              )}
              <small>
                {ago(at)} · {status === "PENDING_CONFIRMATION" ? money(doc ? p.charges?.total : p.codAmount || p.declaredValue || 0) : e.location || p.delivery?.zone}
              </small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Two lines: this period and the previous one (merchant-bridge.js drawChart), with the labels below. */
function Chart({ series }: { series: Series }) {
  const W = 700;
  const H = 220;
  const left = 40;
  const bottom = 26;
  const top = 12;
  const n = series.labels.length;
  const max = Math.max(1, ...series.current, ...series.previous);
  const x = (i: number) => left + (n <= 1 ? 0 : (i * (W - left - 10)) / (n - 1));
  const y = (v: number) => top + (H - top - bottom) * (1 - v / max);
  const path = (values: number[]) => values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const step = Math.max(1, Math.ceil(n / 8));
  const ticks = [0, 0.5, 1].map(f => Math.round(max * f));
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Documents this period and the previous period" style={{ width: "100%", height: "auto" }}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={left} x2={W - 10} y1={y(t)} y2={y(t)} stroke="var(--line)" />
            <text x={left - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--faint)">
              {t}
            </text>
          </g>
        ))}
        <path d={path(series.previous)} fill="none" stroke="#c5cdd8" strokeWidth="2" strokeDasharray="5 4" />
        <path d={path(series.current)} fill="none" stroke="var(--primary)" strokeWidth="2.5" />
        {series.labels.map((l, i) =>
          i % step === 0 || i === n - 1 ? (
            <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--faint)">
              {l}
            </text>
          ) : null,
        )}
      </svg>
      <div className="row" style={{ gap: 14, fontSize: 12, color: "var(--muted)" }}>
        <span className="row" style={{ gap: 6 }}>
          <i style={{ width: 14, height: 3, background: "var(--primary)", display: "inline-block" }} /> This period
        </span>
        <span className="row" style={{ gap: 6 }}>
          <i style={{ width: 14, height: 3, background: "#c5cdd8", display: "inline-block" }} /> Previous period
        </span>
      </div>
    </div>
  );
}
