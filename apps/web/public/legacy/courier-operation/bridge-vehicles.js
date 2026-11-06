/*
 * Courier Operations › Transfers: "Vehicles on the road" and "I'm travelling in this vehicle".
 *
 *   Vehicles on the road   a map (hubs and vehicles only, bridge-maps.js Ops.maps.mount(page, "vehicles")) and a
 *                          list of trips whose vehicle position someone on board shares (GET /vehicle-locations,
 *                          live on "vehicle.location"): vehicle, route, manifest, last update, who shares it.
 *   From this device       hub staff travelling with a truck choose the trip (GET /vehicle-shares/trips) and
 *                          "Start sharing vehicle location" (shared/vehicle-share.js): this browser then sends its
 *                          position as the trip's vehicle position until the trip arrives or "Stop sharing".
 *                          Riders do the same in the rider app ("Travelling with a vehicle").
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  const V = window.DFVehicleShare;
  if (!DF || !Ops) return;
  const $ = id => document.getElementById(id);
  const esc = Ops.esc;
  const PAGE = "Linehaul";
  const onPage = () => Ops.page() === PAGE;
  const canSee = () => Ops.can("dispatch") || Ops.can("manageHubs");
  const share = { trips: null, loading: false, busy: false };

  function listMarkup() {
    const items = Ops.maps?.vehicles?.() || [];
    if (!items.length) return `<p class="panel-subtitle" style="padding:0 16px 14px" data-vehicles-empty>No vehicle is sharing its location right now. Someone on board starts it from the rider app ("Travelling with a vehicle") or here.</p>`;
    const rows = items
      .map(
        v =>
          `<tr data-vehicle-trip="${esc(v.number)}"><td><strong>${esc(v.vehicleRegNo)}</strong><span class="subcell">${esc(v.number)}</span></td><td>${esc(v.route)}</td><td>${esc(Ops.ago(v.at))}${v.stale ? `<span class="subcell">${v.sharing ? "no recent update" : "sharing stopped"}</span>` : ""}</td><td>${esc(v.sharedBy || "—")}</td><td>${Ops.ui.pill(v.stale ? "Pending" : "In transit")}</td></tr>`,
      )
      .join("");
    return Ops.ui.table(["Vehicle", "Route", "Last update", "Shared by", "Status"], rows, "");
  }

  function shareMarkup() {
    if (!V || !Ops.can("dispatch")) return "";
    const s = V.state;
    if (s.share)
      return `<div id="vhShare" data-vehicle-state="sharing" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin:0 16px 14px;padding:9px 12px;border-radius:9px;background:var(--green-soft,#ecfdf3);color:var(--green,#05603a);font-size:13px;font-weight:600"><span id="vhShareText">${esc(V.describe())}</span><span style="display:flex;gap:6px"><button type="button" class="button button-sm" data-vh="now">Send now</button><button type="button" class="button button-sm" data-vh="stop">Stop sharing</button></span></div>`;
    const trips = share.trips || [];
    const options = trips.map(t => `<option value="${esc(t.id)}">${esc(`${t.number} · ${t.vehicleRegNo} · ${t.route} · ${t.status === "DEPARTED" ? "on the road" : "planned"}${t.sharing ? ` · shared by ${t.sharing.name}` : ""}`)}</option>`).join("");
    return `<div id="vhShare" data-vehicle-state="off" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 16px 14px"><span style="font-size:13px;color:#647184;font-weight:600">Travelling with a truck?</span>${
      share.trips == null ? `<span class="panel-subtitle">Loading trips…</span>` : trips.length ? `<select class="select-small" id="vhTrip" aria-label="Trip to share">${options}</select>` : `<span class="panel-subtitle">No planned or departed trips through your hub.</span>`
    }<input class="table-search" id="vhCode" placeholder="or scan MF-…" aria-label="Manifest number" style="max-width:180px"><button type="button" class="button button-sm button-primary" data-vh="start" ${share.busy ? "disabled" : ""}>Start sharing vehicle location</button><small style="flex-basis:100%;color:#98a2ae">This browser sends its position while this page stays open (phones: screen on, app in front).</small></div>`;
  }

  function panelMarkup() {
    return `<section class="panel table-panel" id="vhPanel"><div class="panel-heading"><div><h2 class="panel-title">Vehicles on the road</h2><p class="panel-subtitle">Linehaul trucks whose location someone on board shares · parcels on these trips show the vehicle on their map</p></div></div><div class="map" style="height:260px;margin:0 16px 12px;border-radius:10px"></div><div id="vhList">${listMarkup()}</div>${shareMarkup()}</section>`;
  }

  async function loadTrips() {
    if (!V || share.loading || !Ops.can("dispatch")) return;
    share.loading = true;
    try {
      share.trips = await V.trips();
    } catch {
      share.trips = [];
    } finally {
      share.loading = false;
      paintShare();
    }
  }

  function paintList() {
    const el = $("vhList");
    if (el) el.innerHTML = listMarkup();
  }
  function paintShare() {
    const el = $("vhShare");
    if (el) el.outerHTML = shareMarkup();
    else if ($("vhPanel")) $("vhPanel").insertAdjacentHTML("beforeend", shareMarkup());
    const code = $("vhCode");
    if (code && !code.dataset.scanner && DF.scanner?.attach) {
      code.dataset.scanner = "1";
      DF.scanner.attach(code, { title: "Scan the manifest barcode", onScan: () => void start() });
    }
  }

  function mount() {
    if (!onPage() || !canSee() || $("vhPanel")) return;
    const anchor = $("lhMetrics");
    if (!anchor) return;
    anchor.insertAdjacentHTML("afterend", panelMarkup());
    paintShare();
    void Ops.maps?.mount(PAGE, "vehicles");
    // This device's own share (resumes sending after a reload of the console).
    if (V && Ops.can("dispatch") && !V.state.loaded) void V.load();
    if (V && !V.state.share) void loadTrips();
  }

  const base = Ops.enhance[PAGE];
  Ops.enhance[PAGE] = p => {
    base?.(p);
    try {
      mount();
    } catch (error) {
      console.error("Delivery Fast: vehicles panel failed", error);
    }
  };

  // The map module redraws: refresh the list beside it.
  const previous = Ops.maps?.onDraw;
  if (Ops.maps)
    Ops.maps.onDraw = page => {
      previous?.(page);
      if (page === PAGE && onPage()) paintList();
    };

  async function start() {
    const typed = ($("vhCode")?.value || "").trim();
    const trip = typed ? (DF.scanner?.normalize ? DF.scanner.normalize(typed) : typed.toUpperCase()) : $("vhTrip")?.value;
    if (!trip) return void showToast("Choose a trip or scan the manifest's MF-… barcode.");
    share.busy = true;
    paintShare();
    try {
      const s = await V.start(trip);
      showToast(`Sharing the location of ${s.trip.vehicleRegNo} (${s.trip.number}) from this device.`);
      Ops.maps?.reloadVehicles?.();
    } catch (error) {
      showToast(DF.describe(error));
    } finally {
      share.busy = false;
      paintShare();
    }
  }

  window.addEventListener(
    "click",
    async event => {
      const el = event.target.closest?.("[data-vh]");
      if (!el || !V) return;
      event.stopImmediatePropagation();
      if (el.dataset.vh === "start") return void start();
      if (el.dataset.vh === "now") return void V.sendNow();
      if (el.dataset.vh === "stop") {
        const ok = await (Ops.confirm || DF.confirm)({ title: "Stop sharing the vehicle's location?", message: "Operations and merchants will see its last known position until someone shares it again.", confirm: "Stop sharing" });
        if (!ok) return;
        try {
          await V.stop();
          share.trips = null;
          void loadTrips();
          Ops.maps?.reloadVehicles?.();
        } catch (error) {
          showToast(DF.describe(error));
        }
        paintShare();
      }
    },
    true,
  );

  if (V) {
    V.onChange(() => onPage() && paintShare());
  }
  setInterval(() => {
    if (V?.state.share && $("vhShareText")) $("vhShareText").textContent = V.describe();
    if (onPage()) paintList();
  }, 30_000);
})();
