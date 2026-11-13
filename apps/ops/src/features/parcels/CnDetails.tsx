/**
 * Parcel details: the CN_Scan photos (Ops / Rider apps) with what the AI read and what differed from the parcel, and the
 * map of where the rider recorded the delivery (phone GPS at the delivery entry).
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api, apiRaw } from "@panel/lib/api";
import { when } from "@panel/lib/format";
import { Pill } from "@panel/ui/kit";

interface Capture {
  id: string;
  status: "READING" | "READ" | "FAILED" | "SKIPPED";
  source: string;
  cells: Record<string, string>;
  conflicts: { field: string; parcel: string; read: string }[];
  createdAt: string;
}
const STATUS: Record<Capture["status"], [string, "good" | "warn" | "bad" | undefined]> = {
  READING: ["Reading…", undefined],
  READ: ["Read", "good"],
  FAILED: ["Couldn't be read", "bad"],
  SKIPPED: ["Not read (AI off)", "warn"],
};
const FIELD: Record<string, string> = { recipient_name: "Recipient", recipient_phone: "Phone", address: "Address", district: "District", zone: "Zone", area: "Area", cod_amount: "COD", instructions: "Note" };

function Photo({ id }: { id: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let live = true;
    void apiRaw(`/cn/captures/${id}/photo`)
      .then(r => r.blob())
      .then(b => {
        url = URL.createObjectURL(b);
        if (live) setSrc(url);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  return src ? (
    <a href={src} target="_blank" rel="noreferrer">
      <img src={src} alt="CN photo" style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 8, border: "1px solid var(--line)" }} />
    </a>
  ) : (
    <div style={{ width: 96, height: 96, borderRadius: 8, background: "var(--surface-2)" }} />
  );
}

export function CnPhotos({ trackingId }: { trackingId: string }) {
  const q = useQuery({ queryKey: ["cn-captures", trackingId], queryFn: () => api<{ items: Capture[] }>(`/cn/parcels/${encodeURIComponent(trackingId)}/captures`), refetchInterval: d => (d.state.data?.items.some(i => i.status === "READING") ? 4000 : false) });
  const items = q.data?.items ?? [];
  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (!items.length) return <p className="muted" style={{ margin: 0 }}>No CN_Scan photo yet.</p>;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {items.map(c => {
        const [label, tone] = STATUS[c.status] ?? [c.status, undefined];
        const read = Object.entries(c.cells || {}).filter(([k, v]) => FIELD[k] && v);
        return (
          <div key={c.id} className="row" style={{ gap: 10, alignItems: "flex-start" }}>
            <Photo id={c.id} />
            <div style={{ minWidth: 0, display: "grid", gap: 3, fontSize: 13 }}>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                <Pill tone={tone}>{label}</Pill>
                <small className="faint">{`${c.source === "RIDER_APP" ? "Rider app" : "Ops app"} · ${when(c.createdAt)}`}</small>
              </div>
              {read.length ? <span>{read.map(([k, v]) => `${FIELD[k]}: ${v}`).join(" · ")}</span> : null}
              {c.conflicts?.length ? (
                <span style={{ color: "#b42318" }}>
                  {"Different from the parcel (kept the parcel's): "}
                  {c.conflicts.map(x => `${x.field} "${x.read}" (parcel: "${x.parcel}")`).join("; ")}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Where the rider recorded the delivery. */
export function DeliveredMap({ at }: { at: { lat: number; lng: number; accuracy?: number | null } }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current) return;
    const map = L.map(el.current, { scrollWheelZoom: false, attributionControl: true }).setView([at.lat, at.lng], 16);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
    L.circleMarker([at.lat, at.lng], { radius: 8, color: "#067647", fillColor: "#12b76a", fillOpacity: 0.9, weight: 2 }).addTo(map).bindTooltip("Delivered here");
    if (at.accuracy && at.accuracy > 15) L.circle([at.lat, at.lng], { radius: at.accuracy, color: "#12b76a", weight: 1, fillOpacity: 0.08 }).addTo(map);
    return () => void map.remove();
  }, [at.lat, at.lng, at.accuracy]);
  return (
    <div>
      <div ref={el} style={{ height: 200, borderRadius: 10, border: "1px solid var(--line)", overflow: "hidden" }} />
      <small className="faint" style={{ display: "block", marginTop: 4 }}>
        {`${at.lat.toFixed(5)}, ${at.lng.toFixed(5)}${at.accuracy ? ` · within about ${Math.round(at.accuracy)} m` : ""} · `}
        <a href={`https://www.google.com/maps?q=${at.lat},${at.lng}`} target="_blank" rel="noreferrer">
          Open in Google Maps
        </a>
      </small>
    </div>
  );
}
