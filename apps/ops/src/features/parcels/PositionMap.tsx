/**
 * "Where is it now": GET /parcels/:id/position (rider, hub, vehicle or last known point; the server decides what
 * staff may see) as a line of text and a small OpenStreetMap map. Follows the rider / vehicle live (throttled).
 */
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api, ApiError, describe } from "@/lib/api";
import { events } from "@/lib/events";
import { ago } from "@/lib/format";

interface Position {
  kind: "rider" | "hub" | "vehicle" | "last" | "none";
  label: string;
  detail?: string | null;
  lat?: number | null;
  lng?: number | null;
  stale?: boolean;
  approximate?: boolean;
  updatedAt?: string | null;
  rider?: { code: string } | null;
  trip?: { id: string } | null;
}

const COLORS: Record<string, string> = { rider: "#0a7a3c", hub: "#101828", vehicle: "#2453d3", last: "#667085", none: "#98a2ae" };
const LETTER: Record<string, string> = { rider: "R", hub: "H", vehicle: "V", last: "✓", none: "?" };
const icon = (kind: string, stale?: boolean) =>
  L.divIcon({
    className: "",
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    html: `<span style="display:grid;place-items:center;width:26px;height:26px;border-radius:${kind === "hub" ? "6px" : "50%"};background:${stale ? "#98a2ae" : COLORS[kind] || "#2453d3"};color:#fff;font:700 12px/1 system-ui;border:2px solid #fff;box-shadow:0 2px 6px #10182855">${LETTER[kind] || "•"}</span>`,
  });

export default function PositionMap({ trackingId, status }: { trackingId: string; status: string }) {
  const q = useQuery({
    queryKey: ["parcel", trackingId, "position", status],
    queryFn: () => api<Position>(`/parcels/${encodeURIComponent(trackingId)}/position`),
    staleTime: 20_000,
    retry: false,
  });
  const lastRefresh = useRef(0);
  useEffect(() => {
    const follow = (match: (pos: Position, d: Record<string, unknown>) => boolean) => (d: Record<string, unknown>) => {
      const pos = q.data;
      if (!pos || !match(pos, d) || Date.now() - lastRefresh.current < 15_000) return;
      lastRefresh.current = Date.now();
      void q.refetch();
    };
    const onTrip = (pos: Position, d: Record<string, unknown>) => (pos.trip ? pos.trip.id === d.tripId : status.startsWith("IN_TRANSIT"));
    const offs = [
      events.on("rider.location", follow((pos, d) => pos.kind === "rider" && !!pos.rider && pos.rider.code === d.code)),
      events.on("vehicle.location", follow(onTrip)),
      events.on("vehicle.share", follow(onTrip)),
    ];
    return () => offs.forEach(off => off());
  }, [q, status]);

  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);
  const pos = q.data;
  const hasPoint = pos && pos.lat != null && pos.lng != null;
  useEffect(() => {
    if (!hasPoint || !el.current) return;
    const at: L.LatLngExpression = [pos!.lat!, pos!.lng!];
    if (!map.current) {
      map.current = L.map(el.current, { scrollWheelZoom: false }).setView(at, 14);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map.current);
    }
    if (marker.current) marker.current.setLatLng(at).setIcon(icon(pos!.kind, pos!.stale)).setTooltipContent(pos!.label);
    else marker.current = L.marker(at, { icon: icon(pos!.kind, pos!.stale) }).bindTooltip(pos!.label).addTo(map.current);
    map.current.setView(at, pos!.approximate ? 13 : 15);
    setTimeout(() => map.current?.invalidateSize(), 0);
  }, [hasPoint, pos]);
  useEffect(
    () => () => {
      map.current?.remove();
      map.current = null;
      marker.current = null;
    },
    [],
  );

  if (q.isLoading) return <span className="muted">Finding the parcel…</span>;
  if (q.isError) return <span className="muted">{q.error instanceof ApiError && q.error.status === 404 ? "No position for this parcel." : `Position unavailable: ${describe(q.error)}`}</span>;
  const label = pos!.updatedAt && (pos!.kind === "rider" || pos!.kind === "vehicle") ? `${pos!.label} · ${ago(pos!.updatedAt)}` : pos!.label;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div>
        <strong style={{ color: "var(--ink)" }}>{label}</strong>
        {pos!.stale ? <span className="pill neutral" style={{ marginLeft: 6 }}>last known</span> : null}
        {pos!.detail ? <small className="faint" style={{ display: "block" }}>{pos!.detail}</small> : null}
        {pos!.approximate && hasPoint && pos!.kind !== "last" ? <small className="faint" style={{ display: "block" }}>Shown at the hub's location</small> : null}
      </div>
      <div ref={el} hidden={!hasPoint} role="region" aria-label="Parcel position map" style={{ height: 190, border: "1px solid var(--line)", borderRadius: 8, background: "#eef2f5", isolation: "isolate" }} />
    </div>
  );
}
