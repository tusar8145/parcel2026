/**
 * Today: a card per journey stage with its live count, "Live now", the period's figures (GET /ops/stage-counts
 * ?from&to `metrics`), the live network map, the newest parcels and the priority alerts (GET /ops/overview).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api } from "@/lib/api";
import { useLive } from "@/lib/events";
import { ago, money, num, when } from "@/lib/format";
import { useOps } from "@/lib/ops";
import { PeriodSelect, usePeriod } from "@/lib/period";
import { Icon, type IconName } from "@/ui/Icon";
import { Button, Metric, PageHeading, Panel } from "@/ui/kit";
import { allowedViews, JOURNEY, pathFor } from "@/app/nav";
import NetworkMap from "@/features/maps/NetworkMap";
import ParcelTable from "@/features/parcels/ParcelTable";
import { useParcelList } from "@/features/parcels/useParcelList";
import { useParcelActions } from "@/features/parcels/useParcelActions";
import { resolveException } from "@/features/parcels/actions";
import type { Parcel } from "@/features/parcels/model";

interface PeriodMetrics {
  booked: number;
  pickedUp: number;
  delivered: number;
  returned: number;
  codCollected: number;
  codCollections: number;
  successRate: number | null;
  slaMetRate: number | null;
  slaSample: number;
  previous: { booked: number; pickedUp: number; slaMetRate: number | null };
}

const pct = (v: number | null | undefined) => (v == null ? "—" : `${v}%`);
const change = (now: number, before: number) => (before ? `${now >= before ? "↑" : "↓"} ${Math.abs(Math.round(((now - before) / before) * 1000) / 10)}%` : now ? "new" : "—");
const points = (now: number | null, before: number | null) => (now == null || before == null ? null : `${now >= before ? "↑" : "↓"} ${Math.abs(Math.round((now - before) * 10) / 10)} pts`);
const longDate = () => new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

export default function Today() {
  const ops = useOps();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const period = usePeriod("ops-today");
  const actions = useParcelActions();
  const hubs = ops.scope.hubIds?.join(",") ?? "";
  const figures = useQuery({
    queryKey: ["ops", "period-today", hubs, period.query],
    queryFn: () => api<{ metrics: PeriodMetrics }>(`/ops/stage-counts?${period.query}${hubs ? `&forHubIds=${hubs}` : ""}`),
    enabled: !!ops.me,
    staleTime: 20_000,
  });
  useLive(["parcel.updated", "parcel.created"], () => void qc.invalidateQueries({ queryKey: ["ops", "period-today"] }), { debounceMs: 3000, fallbackMs: 180_000 });
  const feed = useParcelList({ id: "today-feed", limit: 6, paged: false, noun: "recent parcel", empty: "No parcels yet." });

  const o = ops.overview;
  const s = o?.shipments;
  const m = figures.data?.metrics;
  const allowed = allowedViews(ops.menu);
  const stages = ops.stageCounts?.stages;

  return (
    <>
      <PageHeading
        eyebrow={`${longDate()} · Network operations`}
        title="Today"
        subtitle={`${period.text} · the figures follow the period; stage cards and “Live now” are right now`}
        actions={
          <>
            <PeriodSelect period={period} />
            <Button icon="refresh" onClick={async () => (ops.refreshAll(), await qc.invalidateQueries({ queryKey: ["map"] }))}>
              Refresh
            </Button>
          </>
        }
      />
      <p className="faint" style={{ margin: "0 0 6px", fontSize: 12.5 }}>
        Now · parcels in each stage right now (not affected by the period)
      </p>
      <div className="stage-grid" aria-label="Parcel journey">
        {JOURNEY.filter(j => allowed.has(j.view)).map(j => (
          <Metric key={j.view} label={j.view} value={stages ? num(stages[j.stage]) : "—"} icon={j.icon} foot={j.hint} note="Open ›" onClick={() => navigate(pathFor(j.view))} />
        ))}
      </div>
      {o && s ? (
        <p className="muted" style={{ margin: "-4px 0 14px", fontSize: 13 }} aria-live="polite">
          Live now · {num(s.unassigned)} waiting for a rider · {num(s.outForDelivery)} out for delivery · {num(o.riders.online)} of {num(o.riders.total)} riders on shift · {num(s.exceptions)} open exception
          {s.exceptions === 1 ? "" : "s"} · {num(s.atRisk)} SLA at risk{o.cash ? ` · ${money(o.cash.withRiders)} COD with riders` : ""}
        </p>
      ) : null}
      <p className="faint" style={{ margin: "0 0 6px", fontSize: 12.5 }}>
        {period.text}
        {ops.scope.hubIds ? " · your hub" : ""}
      </p>
      <div className="metrics" aria-label={`Figures for ${period.text}`}>
        {figures.isError ? <div className="callout bad" style={{ gridColumn: "1 / -1" }}>Figures could not be loaded.</div> : null}
        <Metric label="Booked" value={m ? num(m.booked) : "—"} icon="box" foot={m ? change(m.booked, m.previous.booked) : ""} note={m ? period.versus : period.words} />
        <Metric label="Picked up" value={m ? num(m.pickedUp) : "—"} icon="truck" foot={m ? change(m.pickedUp, m.previous.pickedUp) : ""} note={m ? period.versus : period.words} />
        <Metric label="Delivered" value={m ? num(m.delivered) : "—"} icon="check" foot={m ? `${num(m.returned)} returned` : ""} note={period.words} />
        <Metric label="COD collected" value={m ? money(m.codCollected) : "—"} icon="wallet" foot={m ? `${num(m.codCollections)} collection${m.codCollections === 1 ? "" : "s"}` : ""} note={period.words} />
        <Metric label="Success · SLA met" value={m ? `${pct(m.successRate)} · ${pct(m.slaMetRate)}` : "—"} icon="clock" foot={m ? points(m.slaMetRate, m.previous.slaMetRate) || `${num(m.slaSample)} with a promise` : ""} note="delivered vs returned · on time" />
      </div>
      <Panel title="Live network map" subtitle="Rider positions, hubs, open parcels and vehicles on the road">
        <NetworkMap height={440} onParcel={id => actions.openParcel(id)} />
      </Panel>
      <div className="grid-main" style={{ marginTop: 16 }}>
        <ParcelTable
          list={feed}
          options={{
            title: "Live shipment feed",
            subtitle: "The newest parcels · search finds any parcel",
            selectable: false,
            extraTools: (
              <Button size="sm" onClick={() => navigate(pathFor("All parcels", "All"))}>
                All shipments
              </Button>
            ),
          }}
        />
        <Alerts onException={(id: string) => openException(id)} />
      </div>
    </>
  );

  async function openException(id: string) {
    const p = await api<Parcel>(`/parcels/${encodeURIComponent(id)}`);
    await resolveException(p, actions.ctx);
  }
}

const ALERT_PAGE: Record<string, [string, string?]> = { Hubs: ["Hub desk", "At my hub"], "COD & finance": ["Accounts"] };

function Alerts({ onException }: { onException: (id: string) => void }) {
  const ops = useOps();
  const navigate = useNavigate();
  const alerts = ops.overview?.alerts ?? [];
  return (
    <Panel title="Priority alerts" subtitle="Items requiring operations attention" tools={<span className="pill warn">{alerts.length} open</span>}>
      <div style={{ display: "grid" }}>
        {!alerts.length ? <div className="empty">No priority alerts right now.</div> : null}
        {alerts.map((a, i) => {
          const at = a.kind === "sla" ? `due ${when(a.at)}` : a.at ? ago(a.at) : "";
          return (
            <div key={i} className="row" style={{ padding: "12px 16px", borderBottom: i < alerts.length - 1 ? "1px solid var(--line)" : 0, alignItems: "flex-start", flexWrap: "nowrap" }}>
              <span style={{ display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: 8, background: a.tone === "red" ? "var(--bad-soft)" : "var(--warn-soft)", color: a.tone === "red" ? "var(--bad)" : "var(--warn)", flex: "none" }}>
                <Icon name={(a.icon as IconName) || "alert"} size={16} />
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <strong style={{ color: "var(--ink)", display: "block" }}>{a.title}</strong>
                <span className="muted">{a.text}</span>
                <small className="faint" style={{ display: "block" }}>
                  {[a.meta, at].filter(Boolean).join(" · ")}
                </small>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  if (a.action.exception) return onException(a.action.exception);
                  const target = ALERT_PAGE[a.action.page || ""];
                  if (target) navigate(pathFor(target[0], target[1]));
                }}
              >
                {a.action.exception ? "Resolve" : a.action.label}
              </Button>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
