/*
 * Rider app: "Travelling with a vehicle" (shared/vehicle-share.js). A rider riding in a linehaul vehicle
 * (or a driver with a rider account at their hub) chooses today's trip from their hub, or scans / types the
 * manifest's MF-… barcode, and taps "Start sharing vehicle location": the phone's position becomes the
 * trip's vehicle position (operations maps, parcel drawers) on the super admin's location interval, until
 * the trip arrives or "Stop sharing". Shown on Overview and Settings (#dfVehiclePanel); deep link
 * /rider?page=Overview. Works whether or not the rider's own shift is started.
 */
(() => {
  const DF = window.DF;
  const V = window.DFVehicleShare;
  if (!DF || !V) return;
  const $ = id => document.getElementById(id);
  const page = () => $("breadcrumbPage")?.textContent;
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const toast = message => (DF.toast ? DF.toast(message) : window.showToast?.(message));
  const PAGES = ["Overview", "Settings"];
  const ui = { trips: null, loading: false, error: "", busy: false };

  async function loadTrips() {
    if (ui.loading) return;
    ui.loading = true;
    try {
      ui.trips = await V.trips();
      ui.error = "";
    } catch (error) {
      ui.trips = [];
      ui.error = error?.status === 403 ? "" : DF.describe(error);
    } finally {
      ui.loading = false;
      paint();
    }
  }

  const tripText = t => `${t.number} · ${t.vehicleRegNo} · ${t.route} · ${t.status === "DEPARTED" ? "on the road" : "planned"}${t.sharing && !t.sharing.byMe ? ` · shared by ${t.sharing.name}` : ""}`;

  function markup() {
    const s = V.state;
    const help = `<p class="panel-subtitle" style="margin:10px 0 0">Positions are sent every ${esc(s.settings?.intervalMinutes || 5)} minutes and after a move of ${esc(s.settings?.movementMeters || 50)} m, only while this app is open on the screen. Keep it open on the dashboard mount; a locked phone or another app pauses it until you come back.</p>`;
    if (s.share) {
      const blocked = s.status === "denied";
      return `<section class="panel" id="dfVehiclePanel" data-vehicle-state="${blocked ? "blocked" : "sharing"}" style="margin-bottom:14px"><div class="panel-heading"><div><h2 class="panel-title">Travelling with a vehicle</h2><p class="panel-subtitle" id="dfVehicleStatus">${esc(V.describe())}</p></div></div>
        <div class="earnings-row" style="margin-top:12px"><span>Vehicle</span><strong>${esc(s.share.trip.vehicleRegNo)}</strong></div>
        <div class="earnings-row"><span>Trip</span><strong>${esc(`${s.share.trip.number} · ${s.share.trip.route}`)}</strong></div>
        ${blocked ? `<p class="panel-subtitle" style="margin:10px 0 0;color:var(--red)">Location is blocked for this site. Allow location in the browser settings, then reload the app.</p>` : ""}
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px"><button type="button" class="button button-sm" data-df-vehicle-now>Send location now</button><button type="button" class="button button-sm" data-df-vehicle-stop>Stop sharing</button></div>${help}</section>`;
    }
    const trips = ui.trips || [];
    const options = trips.map(t => `<option value="${esc(t.id)}">${esc(tripText(t))}</option>`).join("");
    const list = ui.trips == null ? `<p class="panel-subtitle" style="margin:0">Loading today's trips…</p>` : trips.length ? `<select id="dfVehicleTrip" aria-label="Trip">${options}</select>` : `<p class="panel-subtitle" style="margin:0">No planned or departed trips from your hub right now. Scan the manifest instead.</p>`;
    return `<section class="panel" id="dfVehiclePanel" data-vehicle-state="off" style="margin-bottom:14px"><div class="panel-heading"><div><h2 class="panel-title">Travelling with a vehicle</h2><p class="panel-subtitle">Riding in a linehaul vehicle? Share its location so operations and merchants see the parcels on board moving.</p></div></div>
      <div class="field" style="margin-top:12px"><label for="dfVehicleTrip">Today's trip</label>${list}</div>
      <div class="field" style="margin-top:10px"><label for="dfVehicleCode">Or the manifest number (MF-…)</label><input id="dfVehicleCode" autocomplete="off" placeholder="Scan or type MF-261018-0001"></div>
      ${ui.error ? `<p class="panel-subtitle" style="margin:8px 0 0;color:var(--red)">${esc(ui.error)}</p>` : ""}
      <button type="button" class="button button-primary" style="width:100%;margin-top:12px" data-df-vehicle-start ${ui.busy ? "disabled" : ""}>Start sharing vehicle location</button>${help}</section>`;
  }

  function paint() {
    if (!PAGES.includes(page())) return;
    const main = $("mainContent");
    if (!main) return;
    const html = markup();
    const existing = $("dfVehiclePanel");
    const typed = $("dfVehicleCode")?.value || "";
    if (existing) existing.outerHTML = html;
    else {
      const anchor = $("dfLocationLine") || main.querySelector(":scope > .page-heading");
      if (anchor) anchor.insertAdjacentHTML("afterend", html);
      else main.insertAdjacentHTML("afterbegin", html);
    }
    const code = $("dfVehicleCode");
    if (code) {
      code.value = typed;
      if (!code.dataset.scanner && DF.scanner?.attach) {
        code.dataset.scanner = "1";
        DF.scanner.attach(code, { title: "Scan the manifest barcode", onScan: () => void start() });
      }
      code.addEventListener("keydown", event => event.key === "Enter" && (event.preventDefault(), void start()));
    }
    if (!V.state.share && ui.trips == null) void loadTrips();
  }

  async function start() {
    const typed = ($("dfVehicleCode")?.value || "").trim();
    const trip = typed ? (DF.scanner?.normalize ? DF.scanner.normalize(typed) : typed.toUpperCase()) : $("dfVehicleTrip")?.value;
    if (!trip) return void toast("Choose a trip or scan the manifest's MF-… barcode.");
    if (!navigator.geolocation) return void toast("This phone or browser can't share a location.");
    ui.busy = true;
    paint();
    try {
      const share = await V.start(trip);
      toast(`Sharing the location of ${share.trip.vehicleRegNo} (${share.trip.number}).`);
    } catch (error) {
      ui.error = DF.describe(error);
      toast(ui.error);
    } finally {
      ui.busy = false;
      paint();
    }
  }

  window.addEventListener(
    "click",
    async event => {
      const t = event.target;
      if (!(t instanceof Element)) return;
      if (t.closest("[data-df-vehicle-start]")) {
        event.stopImmediatePropagation();
        return void start();
      }
      if (t.closest("[data-df-vehicle-now]")) {
        event.stopImmediatePropagation();
        return void V.sendNow();
      }
      if (t.closest("[data-df-vehicle-stop]")) {
        event.stopImmediatePropagation();
        const ok = DF.confirm ? await DF.confirm({ title: "Stop sharing the vehicle's location?", message: "Operations and merchants will see its last known position until someone shares it again.", confirm: "Stop sharing" }) : true;
        if (!ok) return;
        try {
          await V.stop();
          ui.trips = null;
        } catch (error) {
          toast(DF.describe(error));
        }
        paint();
      }
    },
    true,
  );

  V.onChange(() => paint());
  setInterval(() => {
    if (V.state.share && $("dfVehicleStatus")) $("dfVehicleStatus").textContent = V.describe();
  }, 30_000);

  const baseRender = window.render;
  if (typeof baseRender === "function") {
    window.render = function (name) {
      baseRender(name);
      try {
        if (PAGES.includes(name)) {
          if (!V.state.share) ui.trips = null;
          paint();
        }
      } catch (error) {
        console.error("Paira Express: vehicle panel failed", error);
      }
    };
  }

  Promise.resolve(DF.bridgeReady)
    .catch(() => undefined)
    .then(() => V.load())
    .then(() => paint());
})();
