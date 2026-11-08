/**
 * The live network map (bridge-maps.js): hubs, open parcels with pins (GET /routing/map), live rider positions
 * (GET /ops/rider-locations + "rider.location") and linehaul vehicles sharing their location (GET /vehicle-locations
 * + "vehicle.location"). Riders and vehicles move as events arrive; parcel pins reload a little after parcel changes.
 * `children` can draw extra layers (the Delivery route planner) through the map handle.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api } from "@/lib/api";
import { events, useLive } from "@/lib/events";
import { ago, num } from "@/lib/format";
import { useOps } from "@/lib/ops";

const DHAKA: L.LatLngExpression = [23.7808, 90.4093];
const PARCEL_COLOR: Record<string, string> = { BREACHED: "#c0292b", AT_RISK: "#8a5300", ON_TRACK: "#2453d3" };

interface MapParcel {
  trackingId: string;
  status: string;
  statusLabel: string;
  zone: string;
  lat: number;
  lng: number;
  kind: "pickup" | "delivery";
  sla?: string;
  approximate?: boolean;
}
interface RiderPos {
  riderId: string;
  label: string;
  lat: number;
  lng: number;
  at: string;
  status?: string;
  stale?: boolean;
}
interface VehiclePos {
  tripId: string;
  number: string;
  vehicleRegNo: string;
  route: string;
  lat: number;
  lng: number;
  at: string;
  sharing?: boolean;
  stale?: boolean;
}

const pin = (text: string, color: string, size = 22) =>
  L.divIcon({
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<span style="display:grid;place-items:center;width:${size}px;height:${size}px;border-radius:${text === "H" ? "6px" : "50%"};background:${color};color:#fff;font:700 11px/1 system-ui;border:2px solid #fff;box-shadow:0 2px 6px #10182855">${text}</span>`,
  });
const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface MapHandle {
  map: L.Map;
  route: L.LayerGroup;
}

export default function NetworkMap({ height = 420, onParcel, onReady, showParcels = true, vehiclesOnly = false, footer = true }: { height?: number; onParcel?: (trackingId: string) => void; onReady?: (handle: MapHandle) => void; showParcels?: boolean; vehiclesOnly?: boolean; footer?: boolean }) {
  if (vehiclesOnly) showParcels = false;
  const ops = useOps();
  const qc = useQueryClient();
  const canVehicles = ops.can("dispatch") || ops.can("manageHubs");
  const pins = useQuery({ queryKey: ["map", "parcels"], queryFn: () => api<{ parcels: MapParcel[]; unlocated?: number }>("/routing/map?layer=all&limit=1500"), staleTime: 60_000, retry: false, enabled: showParcels });
  const riders = useQuery({ queryKey: ["map", "riders"], queryFn: async () => (await api<{ items: RiderPos[] }>("/ops/rider-locations")).items, staleTime: 60_000, enabled: ops.can("readRiders") && !vehiclesOnly, retry: false });
  const vehicles = useQuery({ queryKey: ["map", "vehicles"], queryFn: async () => (await api<{ items: VehiclePos[] }>("/vehicle-locations")).items, staleTime: 60_000, enabled: canVehicles, retry: false });
  useLive(["parcel.updated", "parcel.created"], () => void qc.invalidateQueries({ queryKey: ["map", "parcels"] }), { debounceMs: 5000 });
  useLive(["vehicle.share", "linehaul.updated"], () => void qc.invalidateQueries({ queryKey: ["map", "vehicles"] }), { debounceMs: 1500 });

  // Live positions patch the cached lists.
  useEffect(() => {
    const offRider = events.on("rider.location", d => {
      const id = String(d.riderId || "");
      if (!id) return;
      qc.setQueryData<RiderPos[]>(["map", "riders"], list => {
        if (!list) return list;
        const known = list.find(r => r.riderId === id);
        const rider = ops.riders.find(r => r.id === id);
        const next: RiderPos = { ...(known || { riderId: id, label: rider ? `${rider.code} · ${rider.name}` : String(d.code || "") }), lat: Number(d.lat), lng: Number(d.lng), at: String(d.at), status: d.status as string, stale: false };
        return known ? list.map(r => (r.riderId === id ? next : r)) : [...list, next];
      });
    });
    const offVehicle = events.on("vehicle.location", d => {
      const id = String(d.tripId || "");
      if (!id) return;
      qc.setQueryData<VehiclePos[]>(["map", "vehicles"], list => {
        if (!list) return list;
        const known = list.find(v => v.tripId === id);
        const next: VehiclePos = { ...(known || { tripId: id, number: String(d.number || ""), vehicleRegNo: String(d.vehicleRegNo || ""), route: String(d.route || "") }), lat: Number(d.lat), lng: Number(d.lng), at: String(d.at), sharing: true, stale: false };
        return known ? list.map(v => (v.tripId === id ? next : v)) : [...list, next];
      });
    });
    return () => (offRider(), offVehicle());
  }, [qc, ops.riders]);

  const el = useRef<HTMLDivElement>(null);
  const layers = useRef<{ map: L.Map; hubs: L.LayerGroup; parcels: L.LayerGroup; riders: L.LayerGroup; vehicles: L.LayerGroup; route: L.LayerGroup; fitted: boolean } | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!el.current || layers.current) return;
    const map = L.map(el.current, { scrollWheelZoom: false }).setView(DHAKA, 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
    layers.current = { map, hubs: L.layerGroup().addTo(map), parcels: L.layerGroup().addTo(map), riders: L.layerGroup().addTo(map), vehicles: L.layerGroup().addTo(map), route: L.layerGroup().addTo(map), fitted: false };
    setReady(true);
    onReady?.({ map, route: layers.current.route });
    return () => {
      map.remove();
      layers.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const l = layers.current;
    if (!l) return;
    l.hubs.clearLayers();
    l.parcels.clearLayers();
    l.riders.clearLayers();
    l.vehicles.clearLayers();
    const bounds: L.LatLngExpression[] = [];
    const mine = ops.me?.hubIds;
    for (const h of ops.hubs.filter(h => h.lat != null && h.lng != null)) {
      L.marker([h.lat!, h.lng!], { icon: pin("H", "#101828", 24), zIndexOffset: 500 }).bindTooltip(esc(h.name)).addTo(l.hubs);
      if (!mine || mine.includes(h.id)) bounds.push([h.lat!, h.lng!]);
    }
    for (const p of showParcels ? pins.data?.parcels || [] : []) {
      const color = p.status === "EXCEPTION" ? "#c0292b" : PARCEL_COLOR[p.sla || ""] || "#2453d3";
      L.circleMarker([p.lat, p.lng], { radius: p.kind === "pickup" ? 5 : 6, color: p.kind === "pickup" ? "#8a5300" : color, weight: 2, fillColor: color, fillOpacity: p.approximate ? 0.25 : 0.7 })
        .bindTooltip(`${esc(p.trackingId)} · ${esc(p.statusLabel)} · ${esc(p.zone)}${p.approximate ? " (zone centre)" : ""}`)
        .on("click", () => onParcel?.(p.trackingId))
        .addTo(l.parcels);
      bounds.push([p.lat, p.lng]);
    }
    for (const r of vehiclesOnly ? [] : riders.data || []) {
      L.marker([r.lat, r.lng], { icon: pin("R", r.stale ? "#98a2ae" : r.status === "ON_BREAK" ? "#8a5300" : "#0a7a3c"), zIndexOffset: 1000 })
        .bindTooltip(`${esc(r.label)} · ${r.stale ? `last seen ${esc(ago(r.at))}` : "live"}`)
        .addTo(l.riders);
      bounds.push([r.lat, r.lng]);
    }
    for (const v of vehicles.data || []) {
      L.marker([v.lat, v.lng], { icon: pin("V", v.stale ? "#98a2ae" : "#2453d3", 24), zIndexOffset: 1100 })
        .bindTooltip(`${esc(v.vehicleRegNo)} · ${esc(v.route)} · ${esc(v.number)} · ${v.stale ? `last seen ${esc(ago(v.at))}${v.sharing ? "" : " (sharing stopped)"}` : `live · ${esc(ago(v.at))}`}`)
        .addTo(l.vehicles);
      bounds.push([v.lat, v.lng]);
    }
    if (!l.fitted && bounds.length) {
      l.map.fitBounds(L.latLngBounds(bounds), { padding: [24, 24], maxZoom: 14 });
      l.fitted = true;
    }
  }, [ready, ops.hubs, ops.me, pins.data, riders.data, vehicles.data, showParcels, onParcel, vehiclesOnly]);

  const liveRiders = (riders.data || []).filter(r => !r.stale).length;
  const liveVehicles = (vehicles.data || []).filter(v => !v.stale).length;
  const parcels = pins.data?.parcels.length ?? 0;
  return (
    <div>
      <div ref={el} role="region" aria-label="Live network map" style={{ height, background: "#eef2f5", isolation: "isolate", zIndex: 0 }} />
      {footer ? <div className="panel-foot">
        <span>
          {num(liveRiders)} riders live
          {liveVehicles ? ` · ${num(liveVehicles)} vehicle${liveVehicles === 1 ? "" : "s"} on the road` : ""}
          {showParcels ? ` · ${num(parcels)} parcels on the map${pins.data?.unlocated ? ` · ${num(pins.data.unlocated)} without a pin` : ""}` : ""}
        </span>
        <span className="row" style={{ gap: 12, fontSize: 12 }}>
          <Legend color="#0a7a3c" text="Riders" />
          <Legend color="#101828" text="Hubs" square />
          <Legend color="#2453d3" text="Parcels / vehicles" />
          <Legend color="#c0292b" text="Exception · late" />
        </span>
      </div> : null}
    </div>
  );
}

function Legend({ color, text, square }: { color: string; text: string; square?: boolean }) {
  return (
    <span className="row" style={{ gap: 5 }}>
      <i style={{ width: 9, height: 9, borderRadius: square ? 2 : "50%", background: color, display: "inline-block" }} />
      {text}
    </span>
  );
}
