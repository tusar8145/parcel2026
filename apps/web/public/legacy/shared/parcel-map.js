/*
 * "Where is it now?": a small map in the parcel drawers (Courier Operations bridge-parcel.js, both
 * merchant panels merchant-parcel.js) from GET /parcels/:id/position — the server decides what the
 * viewer may see (rider only under the "Live rider location" rules for merchants; hub; vehicle; last
 * known point). Leaflet (/vendor/leaflet, OpenStreetMap tiles) loads only when a drawer first shows a
 * position with coordinates.
 *
 *   DFParcelMap.slot(key)                 markup for the section's placeholder (key: "ops" | "merchant")
 *   DFParcelMap.attach(key, trackingId, { status, force })   after the drawer painted: moves the kept map
 *                                         into the placeholder (no tile reload on repaints) and loads the
 *                                         position (cached 20 s per parcel and status; `force` when the
 *                                         drawer is opened, e.g. from the search)
 *   DFParcelMap.refresh(key)              reloads the position shown in that drawer
 *   DFParcelMap.shown(key)                { trackingId, position } on screen
 *
 * The card: label ("With rider R-2101 · 3 min ago", "At Gulshan Hub", "In vehicle DHK-… (Dhaka →
 * Chattogram) · 6 min ago"), detail line, "last known" tag when stale; [data-df-position-kind],
 * [data-df-position-label] for tests.
 */
(() => {
  const DF = window.DF;
  if (!DF || window.DFParcelMap) return;
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
  const CACHE_MS = 20_000;

  let leaflet = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    leaflet ??= new Promise((resolve, reject) => {
      if (!document.querySelector('link[href="/vendor/leaflet/leaflet.css"]')) {
        const css = document.createElement("link");
        css.rel = "stylesheet";
        css.href = "/vendor/leaflet/leaflet.css";
        document.head.append(css);
      }
      const script = document.createElement("script");
      script.src = "/vendor/leaflet/leaflet.js";
      script.onload = () => (window.L ? resolve(window.L) : reject(new Error("Leaflet did not load")));
      script.onerror = () => {
        leaflet = null;
        reject(new Error("The map could not be loaded"));
      };
      document.head.append(script);
    });
    return leaflet;
  }

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="dfParcelMapStyles">
.df-pos{display:grid;gap:8px}
.df-pos-text{font-size:13px;color:#455265;line-height:1.45}
.df-pos-text strong{color:var(--ink,#172033)}
.df-pos-text small{display:block;color:#8792a2}
.df-pos-tag{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;background:#f2f4f7;color:#667085;font-size:11px;font-weight:600;vertical-align:1px}
.df-pos-map{height:190px;border:1px solid var(--line,#e4e7ec);border-radius:8px;background:#eef2f5;isolation:isolate;z-index:0}
.df-pos-map[hidden]{display:none}
</style>`,
  );

  const COLORS = { rider: "#16845b", hub: "#182230", vehicle: "#3766e8", last: "#667085", none: "#98a2ae" };
  const LETTER = { rider: "R", hub: "H", vehicle: "V", last: "✓", none: "?" };
  const icon = (L, kind, stale) =>
    L.divIcon({
      className: "",
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      html: `<span style="display:grid;place-items:center;width:26px;height:26px;border-radius:${kind === "hub" ? "6px" : "50%"};background:${stale ? "#98a2ae" : COLORS[kind] || "#3766e8"};color:#fff;font:700 12px/1 Arial,sans-serif;border:2px solid #fff;box-shadow:0 2px 6px #10182855">${LETTER[kind] || "•"}</span>`,
    });

  const ago = iso => {
    if (!iso) return "";
    const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours} h ago` : new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };

  /** "With rider R-2101 · 3 min ago" (time only for moving things). */
  const labelOf = pos => (pos.updatedAt && (pos.kind === "rider" || pos.kind === "vehicle") ? `${pos.label} · ${ago(pos.updatedAt)}` : pos.label);

  /** key → { host, text, mapEl, map, marker, circle, id, status, position, loadedAt, seq } */
  const views = {};
  const cache = new Map();

  function view(key) {
    let v = views[key];
    if (v) return v;
    const host = document.createElement("div");
    host.className = "df-pos";
    host.dataset.dfPosition = key;
    host.innerHTML = `<div class="df-pos-text" data-df-position-text role="status" aria-live="polite"><span class="panel-subtitle" style="margin:0">Finding the parcel…</span></div><div class="df-pos-map" data-df-position-map role="region" aria-label="Parcel position map" hidden></div>`;
    v = views[key] = { host, text: host.querySelector("[data-df-position-text]"), mapEl: host.querySelector("[data-df-position-map]"), map: null, marker: null, id: null, status: null, position: null, seq: 0 };
    return v;
  }

  function paintText(v) {
    const pos = v.position;
    if (!pos) return;
    if (pos.error) {
      v.text.innerHTML = `<span class="panel-subtitle" style="margin:0">${esc(pos.error)}</span>`;
      v.host.dataset.dfPositionKind = "error";
      return;
    }
    v.host.dataset.dfPositionKind = pos.kind;
    const stale = pos.stale ? `<span class="df-pos-tag" data-df-position-stale>last known</span>` : "";
    const approx = pos.approximate && pos.lat != null && pos.kind !== "last" ? `<small>Shown at the hub's location</small>` : "";
    v.text.innerHTML = `<strong data-df-position-label>${esc(labelOf(pos))}</strong>${stale}${pos.detail ? `<small data-df-position-detail>${esc(pos.detail)}</small>` : ""}${approx}`;
  }

  async function paintMap(v) {
    const pos = v.position;
    if (!pos || pos.error || pos.lat == null || pos.lng == null) {
      v.mapEl.hidden = true;
      return;
    }
    v.mapEl.hidden = false;
    let L;
    try {
      L = await loadLeaflet();
    } catch {
      v.mapEl.hidden = true;
      return;
    }
    if (v.position !== pos) return;
    if (!v.map) {
      v.map = L.map(v.mapEl, { zoomControl: true, attributionControl: true, scrollWheelZoom: false }).setView([pos.lat, pos.lng], 14);
      L.tileLayer(TILE_URL, { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(v.map);
    }
    const at = [pos.lat, pos.lng];
    if (v.marker) v.marker.setLatLng(at).setIcon(icon(L, pos.kind, pos.stale)).setTooltipContent(esc(pos.label));
    else v.marker = L.marker(at, { icon: icon(L, pos.kind, pos.stale) }).bindTooltip(esc(pos.label)).addTo(v.map);
    v.map.setView(at, pos.approximate ? 13 : 15);
    setTimeout(() => v.map?.invalidateSize(), 0);
  }

  async function load(key, force = false) {
    const v = view(key);
    const id = v.id;
    if (!id) return;
    const cached = cache.get(id);
    if (!force && cached && cached.status === v.status && Date.now() - cached.at < CACHE_MS) {
      if (v.position !== cached.position) {
        v.position = cached.position;
        paintText(v);
        void paintMap(v);
      }
      return;
    }
    const seq = ++v.seq;
    try {
      const position = await DF.api(`/parcels/${encodeURIComponent(id)}/position`);
      cache.set(id, { position, status: v.status, at: Date.now() });
      if (seq !== v.seq || v.id !== id) return;
      v.position = position;
    } catch (error) {
      if (seq !== v.seq || v.id !== id) return;
      if (v.position && !v.position.error) return; // keep what is shown on a failed refresh
      v.position = { error: error?.status === 404 ? "No position for this parcel." : `Position unavailable: ${DF.describe(error)}` };
    }
    paintText(v);
    void paintMap(v);
  }

  window.DFParcelMap = {
    slot: key => `<div data-df-position-slot="${esc(key)}"></div>`,
    attach(key, trackingId, { status, force = false } = {}) {
      const v = view(key);
      const slot = document.querySelector(`[data-df-position-slot="${CSS.escape(key)}"]`);
      if (!slot) return;
      const changed = v.id !== trackingId;
      if (changed) {
        v.id = trackingId;
        v.position = null;
        v.seq++;
        v.text.innerHTML = `<span class="panel-subtitle" style="margin:0">Finding the parcel…</span>`;
        v.mapEl.hidden = true;
        delete v.host.dataset.dfPositionKind;
      }
      v.status = status ?? v.status;
      slot.replaceWith(v.host);
      if (v.map && !v.mapEl.hidden) setTimeout(() => v.map?.invalidateSize(), 0);
      else if (v.position) paintText(v);
      void load(key, force);
    },
    refresh(key) {
      if (views[key]?.id && views[key].host.isConnected) void load(key, true);
    },
    shown: key => ({ trackingId: views[key]?.id || null, position: views[key]?.position || null }),
    labelOf,
    loadLeaflet,
  };

  // Ages in the label stay current while a drawer is open.
  setInterval(() => {
    for (const v of Object.values(views)) if (v.host.isConnected && v.position && !v.position.error) paintText(v);
  }, 30_000);
})();
