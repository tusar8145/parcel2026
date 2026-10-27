/*
 * Courier Operations on the API, part 4: real maps and route planning.
 *
 * The illustrated maps on the overview and dispatch pages become Leaflet maps
 * (/vendor/leaflet, OpenStreetMap tiles): hubs, open parcels with pins (GET /routing/map) and
 * live rider positions (GET /ops/rider-locations + "rider.location" events) and linehaul vehicles
 * whose location is shared (GET /vehicle-locations + "vehicle.location" events). The map element
 * survives page re-renders, so tiles don't reload on every data refresh.
 *
 * Dispatch page: Route planner (POST /routing/optimize, OSRM with a nearest-neighbour fallback)
 * draws the rider's optimised stop order; "Find missing pins" geocodes addresses
 * (POST /routing/geocode).
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  const $ = id => document.getElementById(id);
  const q = (selector, root = document) => root.querySelector(selector);
  const esc = Ops.esc;
  const DHAKA = [23.7808, 90.4093];
  const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

  // ───────────── Leaflet loading ─────────────

  let leaflet = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    leaflet ??= new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "/vendor/leaflet/leaflet.css";
      document.head.append(css);
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

  // ───────────── data ─────────────

  const data = { map: null, riders: null, vehicles: null, loadedAt: 0, ridersAt: 0, vehiclesAt: 0, loading: null };
  const canSeeVehicles = () => Ops.can("dispatch") || Ops.can("manageHubs");

  async function loadData(force = false) {
    if (data.loading) return data.loading;
    const now = Date.now();
    const jobs = [];
    if (force || now - data.loadedAt > 60_000)
      jobs.push(
        DF.api("/routing/map?layer=all&limit=1500")
          .then(m => ((data.map = m), (data.loadedAt = Date.now())))
          .catch(error => error?.status !== 403 && console.warn("Paira Express: map data", error)),
      );
    if (Ops.can("readRiders") && (force || now - data.ridersAt > 60_000))
      jobs.push(
        DF.api("/ops/rider-locations")
          .then(r => ((data.riders = new Map(r.items.map(x => [x.riderId, x]))), (data.ridersAt = Date.now())))
          .catch(() => (data.riders ??= new Map())),
      );
    // Linehaul vehicles whose location someone on board shares ("I'm travelling in this vehicle").
    if (canSeeVehicles() && (force || now - data.vehiclesAt > 60_000))
      jobs.push(
        DF.api("/vehicle-locations")
          .then(r => ((data.vehicles = new Map(r.items.map(x => [x.tripId, x]))), (data.vehiclesAt = Date.now())))
          .catch(() => (data.vehicles ??= new Map())),
      );
    data.loading = Promise.all(jobs).finally(() => (data.loading = null));
    return data.loading;
  }

  // ───────────── maps ─────────────

  /** One Leaflet map per page, kept across renders. */
  const maps = {};

  const pinIcon = (L, text, color, size = 22) =>
    L.divIcon({
      className: "",
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      html: `<span style="display:grid;place-items:center;width:${size}px;height:${size}px;border-radius:${text === "H" ? "6px" : "50%"};background:${color};color:#fff;font:700 11px/1 Arial,sans-serif;border:2px solid #fff;box-shadow:0 2px 6px #10182855">${esc(text)}</span>`,
    });
  const PARCEL_COLOR = { BREACHED: "#c34d4d", AT_RISK: "#b87913", ON_TRACK: "#3766e8" };

  function ensureMap(page, container, only) {
    const L = window.L;
    let entry = maps[page];
    if (!entry) {
      const host = document.createElement("div");
      host.className = "map";
      // Which page's map (Today's "Overview" map is taller: bridge-nav.js styles).
      host.dataset.mapPage = page;
      host.style.background = "#eef2f5";
      // Leaflet's panes use z-index 400–1000; keep them inside the map so dialogs (z-index 50) stay on top.
      host.style.isolation = "isolate";
      host.style.zIndex = "0";
      host.setAttribute("role", "region");
      host.setAttribute("aria-label", "Live network map");
      const map = L.map(host, { zoomControl: true, attributionControl: true, scrollWheelZoom: false }).setView(DHAKA, 12);
      L.tileLayer(TILE_URL, { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
      entry = maps[page] = {
        host,
        map,
        hubs: L.layerGroup().addTo(map),
        parcels: L.layerGroup().addTo(map),
        riders: L.layerGroup().addTo(map),
        route: L.layerGroup().addTo(map),
        vehicles: L.layerGroup().addTo(map),
        riderMarkers: new Map(),
        vehicleMarkers: new Map(),
        only,
        fitted: false,
      };
    }
    container.replaceWith(entry.host);
    setTimeout(() => entry.map.invalidateSize(), 0);
    return entry;
  }

  function drawLayers(entry) {
    const L = window.L;
    const mine = Ops.me?.hubIds;
    entry.hubs.clearLayers();
    entry.parcels.clearLayers();
    const bounds = [];
    for (const h of DF.state.hubs.filter(h => h.lat != null && h.lng != null)) {
      L.marker([h.lat, h.lng], { icon: pinIcon(L, "H", "#182230", 24), zIndexOffset: 500 }).bindTooltip(esc(h.name)).addTo(entry.hubs);
      if (!mine || mine.includes(h.id)) bounds.push([h.lat, h.lng]);
    }
    for (const p of entry.only === "vehicles" ? [] : data.map?.parcels || []) {
      const color = p.status === "EXCEPTION" ? "#c34d4d" : PARCEL_COLOR[p.sla] || "#3766e8";
      L.circleMarker([p.lat, p.lng], { radius: p.kind === "pickup" ? 5 : 6, color: p.kind === "pickup" ? "#b87913" : color, weight: 2, fillColor: color, fillOpacity: p.approximate ? 0.25 : 0.7 })
        .bindTooltip(`${esc(p.trackingId)} · ${esc(p.statusLabel)} · ${esc(p.zone)}${p.approximate ? " (zone centre)" : ""}`)
        .on("click", () => courierTrackingHistory(p.trackingId))
        .addTo(entry.parcels);
      bounds.push([p.lat, p.lng]);
    }
    if (entry.only !== "vehicles") drawRiders(entry);
    drawVehicles(entry);
    for (const r of entry.riderMarkers.values()) bounds.push(r.getLatLng());
    for (const v of entry.vehicleMarkers.values()) bounds.push(v.getLatLng());
    if (!entry.fitted && bounds.length) {
      entry.map.fitBounds(bounds, { padding: [24, 24], maxZoom: 14 });
      entry.fitted = true;
    }
  }

  function riderIcon(r) {
    return pinIcon(window.L, "R", r.stale ? "#98a2ae" : r.status === "ON_BREAK" ? "#b87913" : "#16845b");
  }
  function drawRiders(entry) {
    const L = window.L;
    const seen = new Set();
    for (const r of data.riders?.values() || []) {
      seen.add(r.riderId);
      const tip = `${esc(r.label)} · ${r.stale ? `last seen ${esc(Ops.ago(r.at))}` : "live"}`;
      const marker = entry.riderMarkers.get(r.riderId);
      if (marker) marker.setLatLng([r.lat, r.lng]).setIcon(riderIcon(r)).setTooltipContent(tip);
      else entry.riderMarkers.set(r.riderId, L.marker([r.lat, r.lng], { icon: riderIcon(r), zIndexOffset: 1000 }).bindTooltip(tip).addTo(entry.riders));
    }
    for (const [id, marker] of entry.riderMarkers) if (!seen.has(id)) (entry.riders.removeLayer(marker), entry.riderMarkers.delete(id));
  }

  const vehicleIcon = v => pinIcon(window.L, "V", v.stale ? "#98a2ae" : "#3766e8", 24);
  const vehicleTip = v => `${esc(v.vehicleRegNo)} · ${esc(v.route)} · ${esc(v.number)} · ${v.stale ? `last seen ${esc(Ops.ago(v.at))}${v.sharing ? "" : " (sharing stopped)"}` : `live · ${esc(Ops.ago(v.at))}`}`;
  function drawVehicles(entry) {
    const L = window.L;
    const seen = new Set();
    for (const v of data.vehicles?.values() || []) {
      seen.add(v.tripId);
      const marker = entry.vehicleMarkers.get(v.tripId);
      if (marker) marker.setLatLng([v.lat, v.lng]).setIcon(vehicleIcon(v)).setTooltipContent(vehicleTip(v));
      else entry.vehicleMarkers.set(v.tripId, L.marker([v.lat, v.lng], { icon: vehicleIcon(v), zIndexOffset: 1100 }).bindTooltip(vehicleTip(v)).addTo(entry.vehicles));
    }
    for (const [id, marker] of entry.vehicleMarkers) if (!seen.has(id)) (entry.vehicles.removeLayer(marker), entry.vehicleMarkers.delete(id));
  }

  function caption() {
    const tag = q("#mainContent .map-tag.tag-zone");
    const parcels = data.map?.parcels.length ?? 0;
    const riders = [...(data.riders?.values() || [])].filter(r => !r.stale).length;
    const vehicles = [...(data.vehicles?.values() || [])].filter(v => !v.stale).length;
    const text = `${Ops.num(riders)} riders live${vehicles ? ` · ${Ops.num(vehicles)} vehicle${vehicles === 1 ? "" : "s"} on the road` : ""} · ${Ops.num(parcels)} parcels on the map${data.map?.unlocated ? ` · ${Ops.num(data.map.unlocated)} without a pin` : ""}`;
    const span = q("#mainContent .map-caption > span:first-child");
    if (span) span.textContent = text;
    if (tag) tag.textContent = text;
  }

  async function mountMap(page, only) {
    const container = q("#mainContent .map");
    if (!container || container === maps[page]?.host) return;
    try {
      await loadLeaflet();
    } catch (error) {
      return void console.warn(error);
    }
    const current = q("#mainContent .map");
    if (!current || Ops.page() !== page) return;
    const entry = ensureMap(page, current, only);
    drawLayers(entry);
    if (!only) caption();
    await loadData();
    if (Ops.page() !== page) return;
    drawLayers(entry);
    if (!only) caption();
    Ops.maps.onDraw?.(page);
  }

  for (const page of ["Overview", "Dispatch"]) {
    const base = Ops.enhance[page];
    Ops.enhance[page] = p => {
      base?.(p);
      // Pickup (bridge-nav.js) shows neither the map nor the route planner.
      if (page === "Dispatch" && Ops.tabMode === "pickup") return;
      void mountMap(page);
      if (page === "Dispatch") routePlanner();
    };
  }

  // Live: riders move as their positions arrive; parcel changes reload the pins (debounced).
  DF.events.on("rider.location", d => {
    if (!d?.riderId || !data.riders) return;
    const known = data.riders.get(d.riderId);
    const rider = DF.state.riders?.find(r => r.id === d.riderId);
    data.riders.set(d.riderId, { ...(known || { riderId: d.riderId, label: rider ? `${rider.code} · ${rider.name}` : d.code }), lat: d.lat, lng: d.lng, at: d.at, status: d.status, stale: false });
    const entry = maps[Ops.page()];
    if (entry && document.body.contains(entry.host)) {
      drawRiders(entry);
      caption();
    }
  });
  DF.events.on("vehicle.location", d => {
    if (!d?.tripId || !data.vehicles) return;
    const known = data.vehicles.get(d.tripId);
    data.vehicles.set(d.tripId, { ...(known || { tripId: d.tripId, number: d.number, vehicleRegNo: d.vehicleRegNo, route: d.route }), lat: d.lat, lng: d.lng, at: d.at, sharing: true, stale: false });
    const entry = maps[Ops.page()];
    if (entry && document.body.contains(entry.host)) {
      drawVehicles(entry);
      if (!entry.only) caption();
    }
    Ops.maps.onDraw?.(Ops.page());
  });
  // Sharing started / stopped, or a trip arrived: reload the vehicles.
  let vehicleTimer = null;
  const reloadVehicles = () => {
    clearTimeout(vehicleTimer);
    vehicleTimer = setTimeout(async () => {
      data.vehiclesAt = 0;
      const entry = maps[Ops.page()];
      if (!entry || !document.body.contains(entry.host)) return;
      await loadData();
      drawLayers(entry);
      if (!entry.only) caption();
      Ops.maps.onDraw?.(Ops.page());
    }, 1500);
  };
  DF.events.on("vehicle.share", reloadVehicles);
  DF.events.on("linehaul.updated", reloadVehicles);

  let pinTimer = null;
  const reloadPins = () => {
    clearTimeout(pinTimer);
    pinTimer = setTimeout(async () => {
      const entry = maps[Ops.page()];
      if (!entry || !document.body.contains(entry.host)) return void (data.loadedAt = 0);
      await loadData(true);
      drawLayers(entry);
      caption();
    }, 5000);
  };
  DF.events.on("parcel.updated", reloadPins);
  DF.events.on("parcel.created", reloadPins);
  DF.events.on("reconnect", reloadPins);

  // ───────────── route planner (Dispatch) ─────────────

  let plan = null;

  function plannerMarkup() {
    const mine = Ops.me?.hubIds;
    const riders = (DF.state.riders || []).filter(r => !mine || mine.includes(r.hub?.id));
    const options = riders.map(r => `<option value="${r.id}" ${plan?.riderId === r.id ? "selected" : ""}>${esc(`${r.code} · ${r.name}${r.openTasks ? ` · ${r.openTasks} open` : ""}`)}</option>`).join("");
    const stops = plan?.result?.plan?.stops || [];
    const rows = stops
      .map(
        s =>
          `<tr><td>${s.seq}</td><td><strong>${esc(s.trackingId)}</strong><span class="subcell">${esc(s.kind === "pickup" ? "Pickup" : "Delivery")}${s.approximate ? " · zone centre" : ""}</span></td><td>${esc(s.label)}</td><td>${Math.round(s.etaSeconds / 60)} min</td></tr>`,
      )
      .join("");
    const p = plan?.result?.plan;
    const summary = p
      ? `${p.engine === "OSRM" ? "Road route (OSRM)" : "Estimated route (straight-line fallback)"} · ${(p.distanceMeters / 1000).toFixed(1)} km · about ${Math.round(p.durationSeconds / 60)} min including stops · starts at the ${esc(p.startSource)}${plan.result.unlocated.length ? ` · ${plan.result.unlocated.length} stop(s) without a pin: ${esc(plan.result.unlocated.slice(0, 4).join(", "))}` : ""}`
      : plan?.result?.message
        ? esc(plan.result.message)
        : "Choose a rider to plan the best stop order for their open pickups and deliveries.";
    return `<section class="panel table-panel" id="routePlanner"><div class="panel-heading"><div><h2 class="panel-title">Route planner</h2><p class="panel-subtitle">${summary}</p></div><div class="table-tools"><select class="select-small" id="plannerRider" aria-label="Rider">${options || `<option value="">No riders</option>`}</select><button class="button button-sm button-primary" type="button" data-plan-route ${riders.length && Ops.can("dispatch") ? "" : "disabled"}>${plan?.loading ? "Planning…" : "Optimise route"}</button><button class="button button-sm" type="button" data-geocode ${Ops.can("dispatch") ? "" : "disabled"}>Find missing pins</button></div></div>${Ops.ui.table(["#", "Stop", "Address", "ETA"], rows, "No route planned yet.")}</section>`;
  }

  function routePlanner() {
    $("routePlanner")?.remove();
    if (!Ops.can("readRiders")) return;
    const anchor = q("#mainContent .table-panel") || q("#mainContent .dashboard-grid");
    if (anchor) anchor.insertAdjacentHTML("beforebegin", plannerMarkup());
    drawRoute();
  }

  function drawRoute() {
    const entry = maps.Dispatch;
    if (!entry || !window.L) return;
    entry.route.clearLayers();
    const p = plan?.result?.plan;
    if (!p) return;
    const L = window.L;
    const line = (p.geometry || []).filter(pt => Array.isArray(pt) && pt.length === 2);
    if (line.length > 1) L.polyline(line, { color: "#3766e8", weight: 4, opacity: 0.8 }).addTo(entry.route);
    if (p.start) L.marker([p.start.lat, p.start.lng], { icon: pinIcon(L, "S", "#182230") }).bindTooltip("Start").addTo(entry.route);
    for (const s of p.stops) L.marker([s.lat, s.lng], { icon: pinIcon(L, String(s.seq), s.kind === "pickup" ? "#b87913" : "#3766e8", 22), zIndexOffset: 800 }).bindTooltip(`${s.seq}. ${esc(s.trackingId)}`).addTo(entry.route);
    const bounds = [...(p.start ? [[p.start.lat, p.start.lng]] : []), ...p.stops.map(s => [s.lat, s.lng])];
    if (bounds.length) entry.map.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 });
  }

  window.addEventListener(
    "click",
    async event => {
      const optimise = event.target.closest("[data-plan-route]");
      const geocode = event.target.closest("[data-geocode]");
      if (!optimise && !geocode) return;
      event.stopImmediatePropagation();
      if (!Ops.require("dispatch", "plan routes")) return;
      if (optimise) {
        const riderId = $("plannerRider")?.value;
        if (!riderId) return;
        plan = { riderId, loading: true };
        routePlanner();
        try {
          plan = { riderId, result: await DF.api("/routing/optimize", { method: "POST", body: { riderId } }) };
        } catch (error) {
          plan = null;
          showToast(DF.describe(error));
        }
        routePlanner();
        return;
      }
      geocode.disabled = true;
      try {
        const hubId = Ops.myHubs()?.[0]?.id;
        const result = await DF.api("/routing/geocode", { method: "POST", body: { limit: 10, ...(hubId ? { hubId } : {}) } });
        showToast(`${result.located} address(es) found on the map${result.approximate ? `, ${result.approximate} placed at the zone centre` : ""}; ${result.remaining} still without a pin.`);
        await loadData(true);
        if (maps.Dispatch) drawLayers(maps.Dispatch);
        caption();
      } catch (error) {
        showToast(DF.describe(error));
      } finally {
        geocode.disabled = false;
      }
    },
    true,
  );

  Ops.maps = {
    loadLeaflet,
    pinIcon,
    /** Mounts the kept Leaflet map into the page's `.map` element; only "vehicles" = hubs and vehicles (Transfers). */
    mount: (page, only) => mountMap(page, only),
    vehicles: () => [...(data.vehicles?.values() || [])],
    reloadVehicles,
    onDraw: null,
  };
})();
