/**
 * Pickup › Assign pickup rider and Delivery › Assign delivery rider (the Dispatch page in its two modes,
 * bridge-nav.js dispatchMode + bridge-pages.js Ops.enhance.Dispatch): the stage's own numbers, rider capacity
 * (GET /ops/dispatch), the two stage tables; Delivery adds the live map and the route roster.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { num } from "@panel/lib/format";
import { useOps } from "@/lib/ops";
import { Button, Metric, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { viewById } from "@/app/nav";
import ViewTabs from "@/app/ViewTabs";
import NetworkMap, { type MapHandle } from "@/features/maps/NetworkMap";
import { useParcelActions } from "@/features/parcels/useParcelActions";
import { StageTable } from "./ParcelPages";
import RoutePlanner from "@/features/maps/RoutePlanner";
import { BulkUpdateButton } from "@/features/imports/ImportButtons";
import { suggestRiders } from "@/features/parcels/SuggestRiders";

interface DispatchData {
  riders: { available: number; onShift: number; total: number };
  avgStopsPerRoute: number;
  routesActive: number;
  routesNeedReview: number;
  roster: { rider: { id: string; label: string; zone?: string | null; hub?: { name: string } | null }; assignedToday: number; completed: number; remaining: number; health: string }[];
}

export default function Dispatch({ mode, tab }: { mode: "pickup" | "delivery"; tab?: string }) {
  const pickup = mode === "pickup";
  const ops = useOps();
  const qc = useQueryClient();
  const actions = useParcelActions();
  const [handle, setHandle] = useState<MapHandle | null>(null);
  const view = viewById(pickup ? "Pickup" : "Delivery")!;
  const d = useQuery({ queryKey: ["ops", "dispatch"], queryFn: () => api<DispatchData>("/ops/dispatch"), enabled: ops.can("readRiders"), staleTime: 20_000 });
  const detail = (ops.stageCounts?.detail || {}) as Record<string, number>;
  const count = (key: string) => (detail[key] == null ? "—" : num(detail[key]));
  return (
    <>
      <PageHeading
        eyebrow="Network operations"
        title={view.label}
        subtitle={view.subtitle}
        actions={
          <>
            {ops.can("dispatch") ? (
              <Button icon="route" onClick={() => void suggestRiders({ hubs: ops.hubs.filter(h => h.active !== false), myHubs: ops.myHubs, kind: mode, done: () => (ops.refreshAll(), void qc.invalidateQueries({ queryKey: ["ops", "dispatch"] })) })}>
                Suggest riders
              </Button>
            ) : null}
            <BulkUpdateButton kind={pickup ? "pickup" : "delivery"} />
            <BulkUpdateButton kind={pickup ? "pickup" : "delivery"} history />
            <Button icon="refresh" onClick={async () => (ops.refreshAll(), await qc.invalidateQueries({ queryKey: ["ops", "dispatch"] }))}>
              Refresh
            </Button>
          </>
        }
      />
      {pickup ? <ViewTabs view="Pickup" tab={tab ?? "Assign pickup rider"} /> : null}
      <div className="metrics">
        {pickup ? (
          <>
            <Metric label="Waiting for a pickup rider" value={count("pickupWaiting")} icon="box" foot="accepted orders" note="need a rider" />
            <Metric label="Being picked up" value={count("pickingUp")} icon="truck" foot="with pickup riders" note="on the way to the hub" />
          </>
        ) : (
          <>
            <Metric label="Waiting for a delivery rider" value={count("deliveryWaiting")} icon="box" foot="at the hub" note={ops.scope.hubIds ? "your hub" : "network wide"} />
            <Metric label="Out with delivery riders" value={count("delivery")} icon="truck" foot="assigned or out" note="for delivery" />
          </>
        )}
        {d.data ? (
          <>
            <Metric label="Riders available" value={num(d.data.riders.available)} icon="users" foot={`${num(d.data.riders.onShift)} on shift`} note={`of ${num(d.data.riders.total)} riders`} />
            {pickup ? (
              <Metric label="Avg. stops / rider" value={String(d.data.avgStopsPerRoute)} icon="route" foot="assigned today" note="per active route" />
            ) : (
              <Metric label="Routes active" value={num(d.data.routesActive)} icon="route" foot={`${num(d.data.routesNeedReview)} need review`} note={ops.me?.hubIds ? "your hub" : "network wide"} />
            )}
          </>
        ) : null}
      </div>
      {!pickup ? (
        <>
          <Panel title="Live dispatch map" subtitle="Rider coverage and shipment assignments">
            <NetworkMap height={380} onParcel={id => actions.openParcel(id)} onReady={setHandle} />
          </Panel>
          <RoutePlanner handle={handle} />
        </>
      ) : null}
      {pickup ? (
        <>
          <StageTable id="pickup-waiting" stage="pickup_waiting" title="Waiting for a pickup rider" subtitle="Accepted orders without a pickup rider (new orders are accepted with a rider in New orders)" empty="Every accepted order has a pickup rider." />
          <StageTable id="pickup-active" stage="pickup" title="Being picked up" subtitle="Pickup assigned, confirmed or picked up · on the way to the hub" empty="No pickups in progress." />
        </>
      ) : (
        <>
          <StageTable id="delivery-waiting" stage="delivery_waiting" title="Waiting for a delivery rider" subtitle="At the hub · assign a rider, or add to a transfer when another hub delivers there" empty="No parcels are waiting at a hub for a delivery rider." failedFilter />
          <StageTable id="delivery-active" stage="delivery" title="Out with delivery riders" subtitle="Assigned to a delivery rider or out for delivery" empty="No parcels are out with delivery riders." />
          <Panel title="Active route roster" subtitle="Rider workloads and route health">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Rider</th>
                    <th>Service zone</th>
                    <th className="num">Assigned stops</th>
                    <th className="num">Completed</th>
                    <th className="num">Remaining</th>
                    <th>Route health</th>
                  </tr>
                </thead>
                <tbody>
                  {!ops.can("readRiders") ? (
                    <tr>
                      <td colSpan={6} className="empty">
                        Rider workloads are available to dispatch staff.
                      </td>
                    </tr>
                  ) : !d.data ? (
                    <tr>
                      <td colSpan={6} className="empty">
                        {d.isError ? describe(d.error) : "Loading rider workloads…"}
                      </td>
                    </tr>
                  ) : !d.data.roster.length ? (
                    <tr>
                      <td colSpan={6} className="empty">
                        No riders at your hub yet.
                      </td>
                    </tr>
                  ) : (
                    d.data.roster.map(r => (
                      <tr key={r.rider.id}>
                        <td className="strong">{r.rider.label}</td>
                        <td>{r.rider.zone || r.rider.hub?.name || "—"}</td>
                        <td className="num">{r.assignedToday}</td>
                        <td className="num">{r.completed}</td>
                        <td className="num">{r.remaining}</td>
                        <td>
                          <Pill>{r.health}</Pill>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </>
  );
}
