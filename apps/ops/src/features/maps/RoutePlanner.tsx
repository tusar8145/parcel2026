/**
 * Delivery › Route planner (bridge-maps.js): the best stop order for a rider's open pickups and deliveries
 * (POST /routing/optimize, OSRM with a straight-line fallback), drawn on the dispatch map; "Find missing pins"
 * geocodes addresses (POST /routing/geocode).
 */
import { Select } from "@panel/ui/Select";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import L from "leaflet";
import { api } from "@panel/lib/api";
import { useOps } from "@/lib/ops";
import { Button, Panel } from "@panel/ui/kit";
import { toast } from "@panel/ui/toast";
import type { MapHandle } from "./NetworkMap";

interface Stop {
  seq: number;
  trackingId: string;
  kind: "pickup" | "delivery";
  label: string;
  lat: number;
  lng: number;
  etaSeconds: number;
  approximate?: boolean;
}
interface PlanResult {
  plan?: { engine: string; distanceMeters: number; durationSeconds: number; startSource: string; start?: { lat: number; lng: number }; stops: Stop[]; geometry?: [number, number][] };
  unlocated: string[];
  message?: string;
}

const pin = (text: string, color: string) =>
  L.divIcon({
    className: "",
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    html: `<span style="display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:${color};color:#fff;font:700 11px/1 system-ui;border:2px solid #fff;box-shadow:0 2px 6px #10182855">${text}</span>`,
  });

export default function RoutePlanner({ handle }: { handle?: MapHandle | null }) {
  const ops = useOps();
  const qc = useQueryClient();
  const mine = ops.me?.hubIds;
  const riders = ops.riders.filter(r => !mine || mine.includes(r.hub?.id ?? ""));
  const [riderId, setRiderId] = useState("");
  const [result, setResult] = useState<PlanResult | null>(null);
  useEffect(() => {
    if (!riderId && riders.length) setRiderId(riders[0].id);
  }, [riders, riderId]);

  useEffect(() => {
    if (!handle) return;
    handle.route.clearLayers();
    const p = result?.plan;
    if (!p) return;
    const line = (p.geometry || []).filter(pt => Array.isArray(pt) && pt.length === 2);
    if (line.length > 1) L.polyline(line, { color: "#2453d3", weight: 4, opacity: 0.8 }).addTo(handle.route);
    if (p.start) L.marker([p.start.lat, p.start.lng], { icon: pin("S", "#101828") }).bindTooltip("Start").addTo(handle.route);
    for (const s of p.stops) L.marker([s.lat, s.lng], { icon: pin(String(s.seq), s.kind === "pickup" ? "#8a5300" : "#2453d3"), zIndexOffset: 800 }).bindTooltip(`${s.seq}. ${s.trackingId}`).addTo(handle.route);
    const bounds: L.LatLngExpression[] = [...(p.start ? [[p.start.lat, p.start.lng] as L.LatLngExpression] : []), ...p.stops.map(s => [s.lat, s.lng] as L.LatLngExpression)];
    if (bounds.length) handle.map.fitBounds(L.latLngBounds(bounds), { padding: [24, 24], maxZoom: 15 });
  }, [handle, result]);

  if (!ops.can("readRiders")) return null;
  const p = result?.plan;
  const summary = p
    ? `${p.engine === "OSRM" ? "Road route (OSRM)" : "Estimated route (straight-line fallback)"} · ${(p.distanceMeters / 1000).toFixed(1)} km · about ${Math.round(p.durationSeconds / 60)} min including stops · starts at the ${p.startSource}${result!.unlocated.length ? ` · ${result!.unlocated.length} stop(s) without a pin: ${result!.unlocated.slice(0, 4).join(", ")}` : ""}`
    : result?.message || "Choose a rider to plan the best stop order for their open pickups and deliveries.";
  return (
    <Panel
      title="Route planner"
      subtitle={summary}
      tools={
        <>
          <Select className="select sm" aria-label="Rider" value={riderId} onChange={e => setRiderId(e.target.value)} style={{ maxWidth: 260 }}>
            {riders.length ? riders.map(r => <option key={r.id} value={r.id}>{`${r.code} · ${r.name}${r.openTasks ? ` · ${r.openTasks} open` : ""}`}</option>) : <option value="">No riders</option>}
          </Select>
          <Button
            size="sm"
            variant="primary"
            disabled={!riders.length || !ops.can("dispatch")}
            onClick={async () => {
              if (!ops.require("dispatch", "plan routes") || !riderId) return;
              setResult(await api<PlanResult>("/routing/optimize", { method: "POST", body: { riderId } }));
            }}
          >
            Optimise route
          </Button>
          <Button
            size="sm"
            disabled={!ops.can("dispatch")}
            onClick={async () => {
              if (!ops.require("dispatch", "plan routes")) return;
              const hubId = ops.myHubs?.[0]?.id;
              const r = await api<{ located: number; approximate: number; remaining: number }>("/routing/geocode", { method: "POST", body: { limit: 10, ...(hubId ? { hubId } : {}) } });
              toast(`${r.located} address(es) found on the map${r.approximate ? `, ${r.approximate} placed at the zone centre` : ""}; ${r.remaining} still without a pin.`, "good");
              await qc.invalidateQueries({ queryKey: ["map", "parcels"] });
            }}
          >
            Find missing pins
          </Button>
        </>
      }
    >
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Stop</th>
              <th>Address</th>
              <th className="num">ETA</th>
            </tr>
          </thead>
          <tbody>
            {p?.stops.length ? (
              p.stops.map(s => (
                <tr key={`${s.seq}-${s.trackingId}`}>
                  <td>{s.seq}</td>
                  <td>
                    <span className="strong">{s.trackingId}</span>
                    <span className="sub">
                      {s.kind === "pickup" ? "Pickup" : "Delivery"}
                      {s.approximate ? " · zone centre" : ""}
                    </span>
                  </td>
                  <td>{s.label}</td>
                  <td className="num">{Math.round(s.etaSeconds / 60)} min</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="empty">
                  No route planned yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
