/**
 * Monitoring › Live map (GET /live-map, /live-map/riders/:id, /live-map/staff/:userId): hubs, franchises, riders,
 * operations managers, Hub Managers and franchise accounts on one map, each shown by a tick box; or one hub / one
 * franchise with its riders. Click a rider: where they are, online / offline, last active, today's path, what they
 * carry and the parcels they went out with (delivered / failed / return, minutes each). Click a staff member: their
 * path. Riders move live ("rider.location"); the rest reloads every minute.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api, describe } from "@panel/lib/api";
import { events } from "@panel/lib/events";
import { ago, localPhone } from "@panel/lib/format";
import { Loading, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { Select } from "@panel/ui/Select";

interface Pos {
  lat: number;
  lng: number;
  accuracy?: number;
  at: string;
}
interface Hub {
  id: string;
  code: string;
  name: string;
  type: string;
  district: string;
  lat: number | null;
  lng: number | null;
  franchise: { id: string; name: string } | null;
}
interface Rider {
  id: string;
  code: string;
  name: string;
  phone: string;
  status: string;
  online: boolean;
  hubId: string | null;
  hubIds: string[];
  franchiseId: string | null;
  location: Pos | null;
  lastActiveAt: string | null;
  openDeliveries: number;
}
interface Staff {
  userId: string;
  name: string;
  phone: string;
  email: string | null;
  roles: string[];
  hubIds: string[];
  franchiseId: string | null;
  location: Pos | null;
  online: boolean;
  lastActiveAt: string | null;
}
interface Overview {
  generatedAt: string;
  hubs: Hub[];
  franchises: { id: string; code: string; name: string; status: string; hubId: string; ownerId: string }[];
  riders: Rider[];
  staff: Staff[];
}
interface DayParcel {
  trackingId: string;
  recipient: string;
  address: string;
  cod: number;
  status: string;
  result: "DELIVERED" | "FAILED" | "RETURN" | "OUT";
  reason: string | null;
  outAt: string | null;
  doneAt: string | null;
  minutes: number | null;
}
interface RiderDay {
  rider: { id: string; code: string; name: string; phone: string; status: string; online: boolean; vehicle: string; zone: string | null; hub: { id: string; name: string; code: string; type: string } | null };
  location: Pos | null;
  lastActiveAt: string | null;
  path: { lat: number; lng: number; at: string }[];
  carrying: { trackingId: string; status: string; recipient: string; phone: string; address: string; cod: number }[];
  openPickups: number;
  day: DayParcel[];
  summary: { out: number; delivered: number; failed: number; returned: number; stillOut: number; averageMinutes: number | null };
}

type Layer = "riders" | "hubs" | "ops" | "hubManagers" | "franchises";
const LAYERS: [Layer, string, string][] = [
  ["riders", "Riders", "#0a7a3c"],
  ["hubs", "Hubs", "#101828"],
  ["ops", "Operations Managers", "#2453d3"],
  ["hubManagers", "Hub Managers", "#0e7490"],
  ["franchises", "Franchises", "#7c3aed"],
];
const COLOR = Object.fromEntries(LAYERS.map(([k, , c]) => [k, c])) as Record<Layer, string>;
const OFFLINE = "#98a2ae";
const DHAKA: L.LatLngExpression = [23.7808, 90.4093];
const RESULT: Record<DayParcel["result"], [string, "good" | "bad" | "warn" | "info"]> = { DELIVERED: ["Delivered", "good"], FAILED: ["Failed", "bad"], RETURN: ["Return", "warn"], OUT: ["Out", "info"] };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const time = (v: string | null) => (v ? new Date(v).toLocaleTimeString("en-GB", { timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit" }) : "—");
const today = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
const pin = (text: string, color: string, square = false, size = 24) =>
  L.divIcon({
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<span style="display:grid;place-items:center;width:${size}px;height:${size}px;border-radius:${square ? "6px" : "50%"};background:${color};color:#fff;font:700 11px/1 system-ui;border:2px solid #fff;box-shadow:0 2px 6px #10182855">${text}</span>`,
  });

type Selected = { kind: "rider"; id: string } | { kind: "staff"; id: string } | null;

export default function LiveMap() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "live-map"], queryFn: () => api<Overview>("/live-map"), refetchInterval: 60_000 });
  const [on, setOn] = useState<Record<Layer, boolean>>({ riders: true, hubs: true, ops: true, hubManagers: true, franchises: true });
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [focus, setFocus] = useState(""); // "" | hub:<id> | franchise:<id>
  const [selected, setSelected] = useState<Selected>(null);
  const [date, setDate] = useState(today());

  // Riders move live.
  useEffect(
    () =>
      events.on("rider.location", d => {
        const id = String(d.riderId || "");
        qc.setQueryData<Overview>(["admin", "live-map"], o =>
          o && id ? { ...o, riders: o.riders.map(r => (r.id === id ? { ...r, location: { lat: Number(d.lat), lng: Number(d.lng), at: String(d.at) }, lastActiveAt: String(d.at), status: String(d.status || r.status), online: d.status ? d.status !== "OFFLINE" : r.online } : r)) } : o,
        );
      }),
    [qc],
  );

  const o = q.data;
  const shown = useMemo(() => {
    if (!o) return { hubs: [], riders: [], staff: [] as (Staff & { layer: Layer })[] };
    const [kind, id] = focus.split(":");
    const franchise = kind === "franchise" ? o.franchises.find(f => f.id === id) : undefined;
    const hubId = kind === "hub" ? id : franchise?.hubId;
    const layerOf = (s: Staff): Layer => (s.roles.includes("FRANCHISE") ? "franchises" : s.roles.includes("OPS_MANAGER") ? "ops" : "hubManagers");
    const hubs = o.hubs.filter(h => (hubId ? h.id === hubId : on[h.type === "FRANCHISE" ? "franchises" : "hubs"]));
    const riders = !on.riders ? [] : o.riders.filter(r => (!hubId || r.hubIds.includes(hubId)) && (!onlineOnly || r.online));
    const staff = o.staff
      .map(s => ({ ...s, layer: layerOf(s) }))
      .filter(s => on[s.layer] && (!onlineOnly || s.online))
      .filter(s => (franchise ? s.userId === franchise.ownerId : hubId ? s.layer === "hubManagers" && s.hubIds.includes(hubId) : true));
    return { hubs, riders, staff };
  }, [o, on, onlineOnly, focus]);

  // ── the map ──
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<{ map: L.Map; marks: L.LayerGroup; path: L.LayerGroup; fittedFor: string | null } | null>(null);
  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current).setView(DHAKA, 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(m);
    map.current = { map: m, marks: L.layerGroup().addTo(m), path: L.layerGroup().addTo(m), fittedFor: null };
    return () => {
      m.remove();
      map.current = null;
    };
  }, [o === undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const l = map.current;
    if (!l) return;
    l.marks.clearLayers();
    const bounds: L.LatLngExpression[] = [];
    for (const h of shown.hubs) {
      if (h.lat == null || h.lng == null) continue;
      const fr = h.type === "FRANCHISE";
      L.marker([h.lat, h.lng], { icon: pin(fr ? "F" : "H", fr ? COLOR.franchises : COLOR.hubs, true, 26), zIndexOffset: 500 })
        .bindTooltip(`${esc(h.name)} (${esc(h.code)})${h.franchise ? ` · franchise ${esc(h.franchise.name)}` : ""}`)
        .addTo(l.marks);
      bounds.push([h.lat, h.lng]);
    }
    for (const s of shown.staff) {
      if (!s.location) continue;
      const letter = s.layer === "ops" ? "O" : s.layer === "franchises" ? "F" : "M";
      L.marker([s.location.lat, s.location.lng], { icon: pin(letter, s.online ? COLOR[s.layer] : OFFLINE), zIndexOffset: 800 })
        .bindTooltip(`${esc(s.name)} · ${s.online ? "online" : `offline, last seen ${esc(ago(s.location.at))}`}`)
        .on("click", () => setSelected({ kind: "staff", id: s.userId }))
        .addTo(l.marks);
      bounds.push([s.location.lat, s.location.lng]);
    }
    for (const r of shown.riders) {
      if (!r.location) continue;
      L.marker([r.location.lat, r.location.lng], { icon: pin("R", r.online ? (r.status === "ON_BREAK" ? "#8a5300" : COLOR.riders) : OFFLINE), zIndexOffset: 1000 })
        .bindTooltip(`${esc(r.code)} · ${esc(r.name)} · ${r.online ? (r.status === "ON_BREAK" ? "on break" : "online") : "offline"} · ${esc(ago(r.location.at))}${r.openDeliveries ? ` · ${r.openDeliveries} to deliver` : ""}`)
        .on("click", () => setSelected({ kind: "rider", id: r.id }))
        .addTo(l.marks);
      bounds.push([r.location.lat, r.location.lng]);
    }
    // Fit once per filter choice, not on every live move.
    const key = `${focus}|${Object.values(on).join()}|${onlineOnly}`;
    if (bounds.length && l.fittedFor !== key) {
      l.map.fitBounds(L.latLngBounds(bounds), { padding: [30, 30], maxZoom: 15 });
      l.fittedFor = key;
    }
  }, [shown, focus, on, onlineOnly]);

  // ── the selected person ──
  const rider = useQuery({
    queryKey: ["admin", "live-map", "rider", selected?.kind === "rider" ? selected.id : "", date],
    queryFn: () => api<RiderDay>(`/live-map/riders/${selected!.id}?date=${date}`),
    enabled: selected?.kind === "rider",
    refetchInterval: 60_000,
  });
  const staffPath = useQuery({
    queryKey: ["admin", "live-map", "staff", selected?.kind === "staff" ? selected.id : "", date],
    queryFn: () => api<{ path: { lat: number; lng: number; at: string }[] }>(`/live-map/staff/${selected!.id}?date=${date}`),
    enabled: selected?.kind === "staff",
  });
  const path = selected?.kind === "rider" ? rider.data?.path : selected?.kind === "staff" ? staffPath.data?.path : undefined;
  useEffect(() => {
    const l = map.current;
    if (!l) return;
    l.path.clearLayers();
    if (!path?.length) return;
    const line = L.polyline(
      path.map(p => [p.lat, p.lng] as L.LatLngTuple),
      { color: "#2453d3", weight: 4, opacity: 0.75 },
    ).addTo(l.path);
    L.circleMarker([path[0].lat, path[0].lng], { radius: 6, color: "#fff", weight: 2, fillColor: "#0a7a3c", fillOpacity: 1 }).bindTooltip(`Start · ${time(path[0].at)}`).addTo(l.path);
    l.map.fitBounds(line.getBounds(), { padding: [40, 40], maxZoom: 16 });
  }, [path]);

  if (!o) return q.error ? <div className="callout bad">{describe(q.error)}</div> : <Loading rows={8} />;
  const count = (layer: Layer) =>
    layer === "riders" ? o.riders.length : layer === "hubs" ? o.hubs.filter(h => h.type !== "FRANCHISE").length : layer === "franchises" ? o.franchises.length : o.staff.filter(s => (layer === "ops" ? s.roles.includes("OPS_MANAGER") : s.roles.includes("HUB_OPERATOR") && !s.roles.includes("OPS_MANAGER"))).length;
  const noPos = shown.riders.filter(r => !r.location).length + shown.staff.filter(s => !s.location).length;
  const selStaff = selected?.kind === "staff" ? o.staff.find(s => s.userId === selected.id) : undefined;
  return (
    <>
      <PageHeading eyebrow="Monitoring" title="Live map" subtitle="Where riders, hubs, operations managers, Hub Managers and franchises are. Click a rider or a staff member for their day." />
      <div style={{ display: "grid", gridTemplateColumns: selected ? "230px minmax(0,1fr) 380px" : "230px minmax(0,1fr)", gap: 12, alignItems: "start" }}>
        <Panel title="Show">
          <div className="panel-body" style={{ display: "grid", gap: 8 }}>
            {LAYERS.map(([k, label, color]) => (
              <label key={k} className="check" style={{ fontWeight: 500 }}>
                <input type="checkbox" checked={on[k]} onChange={e => setOn({ ...on, [k]: e.target.checked })} />{" "}
                <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: k === "hubs" ? 2 : 10, background: color, marginRight: 4 }} />
                {`${label} (${count(k)})`}
              </label>
            ))}
            <label className="check" style={{ fontWeight: 500, marginTop: 4 }}>
              <input type="checkbox" checked={onlineOnly} onChange={e => setOnlineOnly(e.target.checked)} /> Online only
            </label>
            <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "4px 0" }} />
            <label className="field">
              <span>One hub or franchise</span>
              <Select className="select sm" value={focus} onChange={e => setFocus(e.target.value)}>
                <option value="">Everything</option>
                <optgroup label="Hub and its riders">
                  {o.hubs
                    .filter(h => h.type !== "FRANCHISE")
                    .map(h => (
                      <option key={h.id} value={`hub:${h.id}`}>
                        {h.name}
                      </option>
                    ))}
                </optgroup>
                <optgroup label="Franchise and its riders">
                  {o.franchises.map(f => (
                    <option key={f.id} value={`franchise:${f.id}`}>
                      {f.name}
                    </option>
                  ))}
                </optgroup>
              </Select>
            </label>
            <small className="faint">
              {`${shown.riders.length} riders · ${shown.staff.length} staff · ${shown.hubs.length} hubs`}
              {noPos ? ` · ${noPos} without a position yet` : ""}
            </small>
            <small className="faint">{`Updated ${time(o.generatedAt)}; riders move live.`}</small>
          </div>
        </Panel>
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <div ref={el} style={{ height: "calc(100vh - 210px)", minHeight: 480 }} />
        </div>
        {selected ? (
          <Panel
            title={selected.kind === "rider" ? (rider.data ? `${rider.data.rider.code} · ${rider.data.rider.name}` : "Rider") : (selStaff?.name ?? "Staff")}
            tools={
              <button type="button" className="button sm" onClick={() => setSelected(null)}>
                Close
              </button>
            }
          >
            <div className="panel-body" style={{ display: "grid", gap: 10, maxHeight: "calc(100vh - 260px)", overflowY: "auto" }}>
              <label className="field">
                <span>Day</span>
                <input className="input sm" type="date" value={date} max={today()} onChange={e => setDate(e.target.value || today())} />
              </label>
              {selected.kind === "rider" ? <RiderPanel q={rider} /> : selStaff ? <StaffPanel s={selStaff} points={staffPath.data?.path.length ?? 0} /> : null}
            </div>
          </Panel>
        ) : null}
      </div>
    </>
  );
}

function RiderPanel({ q }: { q: { data?: RiderDay; isLoading: boolean; error: unknown } }) {
  const [show, setShow] = useState<"ALL" | DayParcel["result"]>("ALL");
  if (q.isLoading) return <Loading rows={4} />;
  if (!q.data) return <div className="callout bad">{describe(q.error)}</div>;
  const d = q.data;
  const s = d.summary;
  const list = d.day.filter(p => show === "ALL" || p.result === show);
  return (
    <>
      <div>
        <Pill tone={d.rider.online ? (d.rider.status === "ON_BREAK" ? "warn" : "good") : undefined}>{d.rider.online ? (d.rider.status === "ON_BREAK" ? "On break" : "Online") : "Offline"}</Pill>{" "}
        <span className="faint">{`${localPhone(d.rider.phone)} · ${d.rider.hub?.name ?? "No hub"}`}</span>
        <div className="faint" style={{ fontSize: 12.5, marginTop: 4 }}>
          {`Last active ${d.lastActiveAt ? ago(d.lastActiveAt) : "—"} · position ${d.location ? ago(d.location.at) : "not shared yet"} · ${d.path.length} points today`}
        </div>
      </div>
      <div className="metrics" style={{ gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
        <div className="panel" style={{ padding: 10 }}>
          <strong>{`${s.delivered} / ${s.out}`}</strong>
          <div className="faint" style={{ fontSize: 12 }}>delivered of went out</div>
        </div>
        <div className="panel" style={{ padding: 10 }}>
          <strong>{s.averageMinutes != null ? `${s.averageMinutes} min` : "—"}</strong>
          <div className="faint" style={{ fontSize: 12 }}>average per delivery</div>
        </div>
      </div>
      <div>
        <strong>{`Carrying now (${d.carrying.length})`}</strong>
        {d.openPickups ? <span className="faint">{` · ${d.openPickups} pickups open`}</span> : null}
        {d.carrying.map(p => (
          <div key={p.trackingId} style={{ padding: "6px 0", borderBottom: "1px solid var(--line)", fontSize: 13 }}>
            <span className="mono strong">{p.trackingId}</span> <span className="faint">{p.status.replace(/_/g, " ").toLowerCase()}</span>
            <div className="faint">{`${p.recipient} · ${p.address}${p.cod ? ` · COD ৳${p.cod}` : ""}`}</div>
          </div>
        ))}
        {!d.carrying.length ? <div className="faint">Nothing right now.</div> : null}
      </div>
      <div>
        <strong>Went out with today</strong>
        <div className="seg-tabs" role="tablist" style={{ margin: "6px 0" }}>
          {(
            [
              ["ALL", `All ${s.out}`],
              ["DELIVERED", `Delivered ${s.delivered}`],
              ["FAILED", `Failed ${s.failed}`],
              ["RETURN", `Return ${s.returned}`],
              ["OUT", `Out ${s.stillOut}`],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={show === k} className={show === k ? "on" : ""} onClick={() => setShow(k)}>
              {label}
            </button>
          ))}
        </div>
        {list.map(p => (
          <div key={p.trackingId} style={{ padding: "6px 0", borderBottom: "1px solid var(--line)", fontSize: 13 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
              <span className="mono strong">{p.trackingId}</span>
              <Pill tone={RESULT[p.result][1]}>{RESULT[p.result][0]}</Pill>
            </div>
            <div className="faint">{`${p.recipient} · ${p.address}`}</div>
            <div className="faint">
              {`Out ${time(p.outAt)}${p.doneAt ? ` · ${p.result === "DELIVERED" ? "delivered" : "recorded"} ${time(p.doneAt)}` : ""}${p.minutes != null ? ` · ${p.minutes} min` : ""}${p.reason ? ` · ${p.reason}` : ""}`}
            </div>
          </div>
        ))}
        {!list.length ? <div className="faint">None.</div> : null}
      </div>
    </>
  );
}

function StaffPanel({ s, points }: { s: Staff; points: number }) {
  const role = s.roles.includes("FRANCHISE") ? "Franchise" : s.roles.includes("OPS_MANAGER") ? "Operations Manager" : "Hub Manager";
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div>
        <Pill tone={s.online ? "good" : undefined}>{s.online ? "Online" : "Offline"}</Pill> <span className="faint">{role}</span>
      </div>
      <div className="faint">{[localPhone(s.phone), s.email].filter(Boolean).join(" · ")}</div>
      <div className="faint">{`Last active ${s.lastActiveAt ? ago(s.lastActiveAt) : "—"} · position ${s.location ? ago(s.location.at) : "not shared yet (Operations app 1.5 or later, while open)"}`}</div>
      <div className="faint">{`${points} points on the chosen day (the line on the map).`}</div>
    </div>
  );
}
