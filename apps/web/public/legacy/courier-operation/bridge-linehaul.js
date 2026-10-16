/*
 * Courier Operations on the API, part 5: Linehaul between hubs (sidebar "Linehaul").
 *
 *   Bags        POST /linehaul/bags, /bags/:bag/items (scan), /seal, /reopen, DELETE items
 *   Trips       POST /linehaul/trips, /trips/:trip/bags (load), /depart, /arrive, /close, /cancel
 *   Receiving   POST /linehaul/bags/:bag/receive (whole bag, or the parcels scanned out of it)
 *   Manifests   GET /linehaul/trips/:trip → printable A4 manifest with barcodes
 *   Issues      GET /linehaul/discrepancies, POST /discrepancies/:id/resolve
 *   Vehicles    GET/POST/PATCH /linehaul/vehicles (hub managers)
 *
 * Barcode inputs take a USB / keyboard scanner or the camera (DF.scanner, continuous).
 * Lists page with the API cursor ("Load more"); changes arrive as linehaul.updated events.
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  const ui = Ops.ui;
  const $ = id => document.getElementById(id);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = Ops.esc;
  const PAGE = "Linehaul";
  const onPage = () => Ops.page() === PAGE;

  const BAG_STATUS = { OPEN: "Open", SEALED: "Sealed", IN_TRANSIT: "In transit", RECEIVED: "Received" };
  const TRIP_STATUS = { PLANNED: "Planned", DEPARTED: "In transit", ARRIVED: "Arrived", CLOSED: "Closed", CANCELLED: "Cancelled" };
  const ITEM_STATE = { LOADED: "Loaded", RECEIVED: "Received", MISSING: "Missing" };
  const DISCREPANCY = { MISSING: "Missing parcel", EXTRA: "Extra parcel", SEAL_MISMATCH: "Seal mismatch", DAMAGED: "Damaged" };
  const pillFor = text => ui.pill(text === "Missing" || text === "Missing parcel" || text === "Seal mismatch" ? "Exception" : text === "In transit" ? "In transit" : text);

  const state = {
    bags: { items: [], next: null, direction: "", status: "", q: "", loaded: false },
    trips: { items: [], next: null, direction: "", status: "", q: "", loaded: false },
    issues: { items: [], next: null, open: "true", loaded: false },
    vehicles: null,
    metrics: null,
    bag: null, // open bag (detail)
    trip: null, // open trip (manifest)
    receive: null, // { bag, scanned: [], mode: "whole" | "scan" }
    last: "",
  };
  const hubName = h => h?.name || "—";
  const route = x => `${hubName(x.originHub)} → ${hubName(x.destHub)}`;
  const canAct = hubId => Ops.can("dispatch") && Ops.inMyHubs(hubId);

  // ───────────── loading ─────────────

  async function loadList(kind, more = false) {
    const s = state[kind];
    const params = new URLSearchParams({ limit: "25" });
    if (kind === "issues") {
      if (s.open) params.set("open", s.open);
    } else {
      if (s.direction) params.set("direction", s.direction);
      if (s.status) params.set("status", s.status);
      if (s.q) params.set("q", s.q);
    }
    if (more && s.next) params.set("cursor", s.next);
    const path = kind === "bags" ? "/linehaul/bags" : kind === "trips" ? "/linehaul/trips" : "/linehaul/discrepancies";
    try {
      const page = await DF.api(`${path}?${params}`);
      s.items = more ? [...s.items, ...page.items] : page.items;
      s.next = page.nextCursor;
      s.error = null;
    } catch (error) {
      s.error = DF.describe(error);
    }
    s.loaded = true;
    paint(kind);
  }

  async function loadMetrics() {
    const count = async path => {
      const page = await DF.api(`${path}&limit=200`).catch(() => null);
      return page ? `${page.items.length}${page.nextCursor ? "+" : ""}` : "—";
    };
    const [openBags, outbound, inbound, issues] = await Promise.all([
      count("/linehaul/bags?status=OPEN&direction=outbound"),
      count("/linehaul/trips?status=DEPARTED&direction=outbound"),
      count("/linehaul/trips?status=DEPARTED&direction=inbound"),
      count("/linehaul/discrepancies?open=true"),
    ]);
    state.metrics = { openBags, outbound, inbound, issues };
    paint("metrics");
  }

  async function loadVehicles() {
    try {
      state.vehicles = (await DF.api("/linehaul/vehicles?limit=200")).items;
    } catch {
      state.vehicles = [];
    }
    paint("vehicles");
  }

  function reloadAll() {
    void loadMetrics();
    void loadList("bags");
    void loadList("trips");
    void loadList("issues");
    if (Ops.can("manageHubs") || Ops.can("dispatch")) void loadVehicles();
    if (state.bag) void openBag(state.bag.id, true);
    if (state.trip) void openTrip(state.trip.id, true);
  }

  // ───────────── rendering ─────────────

  Ops.pages[PAGE] = {
    render: () => {
      const actions = Ops.can("dispatch")
        ? `<button class="button" data-lh="vehicles-jump">${icon("truck")} Vehicles</button><button class="button" data-lh="new-trip">${icon("route")} Plan trip</button><button class="button button-primary" data-lh="new-bag">${icon("plus")} New bag</button>`
        : "";
      return `<div class="page-heading"><div><p class="eyebrow">Hub operations · between hubs</p><h1>Linehaul</h1><p class="subtitle">Bag parcels, load trucks against a manifest, dispatch them and receive bags at the destination hub.</p></div><div class="heading-actions">${actions}</div></div>
<div class="metrics" id="lhMetrics"></div>
<div class="workflow-grid">
  <section class="panel" id="lhBagPanel"></section>
  <section class="panel" id="lhReceivePanel"></section>
</div>
<section class="panel table-panel" id="lhTripDetail" hidden></section>
<section class="panel table-panel" id="lhTrips"></section>
<section class="panel table-panel" id="lhBags"></section>
<section class="panel table-panel" id="lhIssues"></section>
<section class="panel table-panel" id="lhVehicles" hidden></section>`;
    },
  };

  Ops.enhance[PAGE] = () => {
    for (const part of ["metrics", "bag", "receive", "trip", "trips", "bags", "issues", "vehicles"]) paint(part);
    if (!state.bags.loaded) reloadAll();
  };

  function paint(part) {
    if (!onPage()) return;
    const painters = { metrics: paintMetrics, bag: paintBag, receive: paintReceive, trip: paintTrip, trips: paintTrips, bags: paintBags, issues: paintIssues, vehicles: paintVehicles };
    ui.keepFocus(() => painters[part]?.());
  }

  function paintMetrics() {
    const m = state.metrics;
    const v = key => (m ? m[key] : "…");
    $("lhMetrics").innerHTML = [
      metric("Open bags", v("openBags"), "box", "being made up", Ops.me?.hubIds ? "at your hub" : "network wide"),
      metric("Trucks out", v("outbound"), "truck", "departed", "outbound"),
      metric("Arriving", v("inbound"), "route", "in transit to you", "inbound"),
      metric("Open discrepancies", v("issues"), "alert", "missing, extra, seals", "to resolve"),
    ].join("");
  }

  function filterTools(kind, statuses) {
    const s = state[kind];
    return `<input class="table-search" id="lhSearch-${kind}" data-lh-search="${kind}" value="${esc(s.q)}" placeholder="${kind === "bags" ? "Bag, seal or tracking ID" : "Manifest, vehicle, driver or bag"}" aria-label="Search ${kind}">${ui.select(`lhDir-${kind}`, [{ value: "", label: "Both directions" }, { value: "outbound", label: "Outbound" }, { value: "inbound", label: "Inbound" }], s.direction, `class="select-small" data-lh-filter="${kind}" data-key="direction" aria-label="Direction"`)}${ui.select(`lhStatus-${kind}`, [{ value: "", label: "All statuses" }, ...Object.entries(statuses).map(([value, label]) => ({ value, label }))], s.status, `class="select-small" data-lh-filter="${kind}" data-key="status" aria-label="Status"`)}`;
  }

  function paintTrips() {
    const s = state.trips;
    const rows = s.items
      .map(t => {
        const acts = [`<button class="button button-sm" data-lh="open-trip" data-id="${t.id}">Manifest</button>`];
        if (t.status === "PLANNED" && canAct(t.originHub.id)) acts.push(`<button class="button button-sm" data-lh="depart" data-id="${t.id}">Depart</button>`);
        if (t.status === "DEPARTED" && canAct(t.destHub.id)) acts.push(`<button class="button button-sm" data-lh="arrive" data-id="${t.id}">Arrived</button>`);
        if (t.status === "ARRIVED" && canAct(t.destHub.id)) acts.push(`<button class="button button-sm" data-lh="close" data-id="${t.id}">Close</button>`);
        return `<tr><td><strong>${esc(t.number)}</strong><span class="subcell">${esc(ui.date(t.createdAt))}</span></td><td>${esc(route(t))}</td><td>${esc(t.vehicleRegNo)}<span class="subcell">${esc(t.driverName)} · ${esc(DF.localPhone(t.driverPhone))}</span></td><td>${t.bags} bags · ${t.parcels} parcels${t.bagsReceived ? `<span class="subcell">${t.bagsReceived} received</span>` : ""}</td><td>${esc(t.departedAt ? `Left ${Ops.when(t.departedAt)}` : t.plannedDepartureAt ? `Planned ${Ops.when(t.plannedDepartureAt)}` : "—")}</td><td>${pillFor(TRIP_STATUS[t.status])}${t.openDiscrepancies ? `<span class="subcell">${t.openDiscrepancies} open issue(s)</span>` : ""}</td><td><div class="form-actions" style="display:flex;gap:6px;flex-wrap:wrap">${acts.join("")}</div></td></tr>`;
      })
      .join("");
    $("lhTrips").outerHTML = ui.panel(
      "Trips & manifests",
      "Truck runs between hubs · open a manifest to load bags, dispatch, receive or print",
      ui.table(["Manifest", "Route", "Vehicle / driver", "Load", "Departure", "Status", ""], rows, s.error || (s.loaded ? "No trips match." : "Loading trips…")) + ui.footer(`Showing ${s.items.length} trip(s)`, s.next ? 'data-lh="more" data-kind="trips"' : ""),
      filterTools("trips", TRIP_STATUS),
      'id="lhTrips"',
    );
  }

  function paintBags() {
    const s = state.bags;
    const rows = s.items
      .map(b => {
        const acts = [`<button class="button button-sm" data-lh="open-bag" data-id="${b.id}">Open</button>`];
        if (b.status === "IN_TRANSIT" && canAct(b.destHub.id)) acts.push(`<button class="button button-sm" data-lh="receive-start" data-number="${esc(b.number)}">Receive</button>`);
        return `<tr><td><strong>${esc(b.number)}</strong><span class="subcell">${b.sealNo ? `Seal ${esc(b.sealNo)}` : "Not sealed"}</span></td><td>${esc(route(b))}</td><td>${b.parcels}</td><td>${esc(b.trip?.number || "—")}</td><td>${pillFor(BAG_STATUS[b.status])}</td><td><div style="display:flex;gap:6px;flex-wrap:wrap">${acts.join("")}</div></td></tr>`;
      })
      .join("");
    $("lhBags").outerHTML = ui.panel(
      "Bags",
      "Sealed bags of parcels moving between hubs",
      ui.table(["Bag", "Route", "Parcels", "Trip", "Status", ""], rows, s.error || (s.loaded ? "No bags match." : "Loading bags…")) + ui.footer(`Showing ${s.items.length} bag(s)`, s.next ? 'data-lh="more" data-kind="bags"' : ""),
      filterTools("bags", BAG_STATUS),
      'id="lhBags"',
    );
  }

  function paintIssues() {
    const s = state.issues;
    const rows = s.items
      .map(
        d =>
          `<tr><td>${pillFor(DISCREPANCY[d.kind])}</td><td>${esc(d.trackingId || "—")}</td><td>${esc(d.bag?.number || "—")}<span class="subcell">${esc(d.trip?.number || "")}</span></td><td>${esc(d.hub?.name || "—")}</td><td>${esc(d.note || "")}</td><td>${esc(Ops.when(d.createdAt))}</td><td>${d.resolvedAt ? `${esc(d.resolution)}<span class="subcell">${esc(Ops.when(d.resolvedAt))}</span>` : canAct(d.hubId) ? `<button class="button button-sm" data-lh="resolve" data-id="${d.id}">Resolve</button>` : "Open"}</td></tr>`,
      )
      .join("");
    $("lhIssues").outerHTML = ui.panel(
      "Discrepancies",
      "Missing and extra parcels, seal mismatches · recorded when bags are received or trips closed",
      ui.table(["Issue", "Tracking ID", "Bag / trip", "Hub", "Note", "Found", "Resolution"], rows, s.error || (s.loaded ? "No discrepancies." : "Loading…")) + ui.footer(`Showing ${s.items.length} discrepancy(ies)`, s.next ? 'data-lh="more" data-kind="issues"' : ""),
      ui.select("lhIssueFilter", [{ value: "true", label: "Open" }, { value: "false", label: "Resolved" }, { value: "", label: "All" }], s.open, 'class="select-small" data-lh-issues aria-label="Discrepancy filter"'),
      'id="lhIssues"',
    );
  }

  function paintVehicles() {
    const el = $("lhVehicles");
    if (!el) return;
    const list = state.vehicles || [];
    const manage = Ops.can("manageHubs");
    const rows = list
      .map(v => `<tr><td><strong>${esc(v.regNo)}</strong></td><td>${esc(v.kind)}</td><td>${v.capacityKg ? `${Ops.num(v.capacityKg)} kg` : "—"}</td><td>${esc(v.ownerName || "—")}</td><td>${ui.pill(v.active ? "Active" : "Inactive")}</td><td>${manage ? `<button class="button button-sm" data-lh="edit-vehicle" data-id="${v.id}">Edit</button>` : ""}</td></tr>`)
      .join("");
    el.outerHTML = ui.panel(
      "Vehicles",
      "Trucks and vans used for linehaul",
      ui.table(["Registration", "Type", "Capacity", "Owner / vendor", "Status", ""], rows, state.vehicles ? "No vehicles registered yet. Trips can still use a typed registration number." : "Loading…"),
      manage ? `<button class="button button-sm" type="button" data-lh="add-vehicle">${icon("plus")} Add vehicle</button>` : "",
      'id="lhVehicles"',
    );
  }

  // Bag panel: open / create a bag and scan parcels into it.
  function paintBag() {
    const b = state.bag;
    const el = $("lhBagPanel");
    if (!el) return;
    if (!b) {
      el.innerHTML = `<div class="panel-heading"><div><h2 class="panel-title">Bag up parcels</h2><p class="panel-subtitle">Open a bag by its number (or create one), then scan the parcels going into it.</p></div></div><form class="workflow-form" id="lhOpenBagForm"><label>Bag number<input id="lhOpenBag" autocomplete="off" placeholder="BG-261016-0001" required></label><div class="form-actions"><button class="button button-primary" type="submit">Open bag</button>${Ops.can("dispatch") ? `<button class="button" type="button" data-lh="new-bag">New bag</button>` : ""}</div></form>`;
      DF.scanner?.attach($("lhOpenBag"), { title: "Scan the bag label", onScan: () => $("lhOpenBagForm").requestSubmit() });
      return;
    }
    const editable = b.status === "OPEN" && canAct(b.originHub.id);
    const items = b.items
      .map(i => `<tr><td><strong>${esc(i.parcel.trackingId)}</strong><span class="subcell">${esc(i.parcel.recipient)} · ${esc(i.parcel.zone)}</span></td><td>${i.parcel.weightKg} kg</td><td>${Ops.money(i.parcel.codAmount)}</td><td>${pillFor(ITEM_STATE[i.state])}</td><td>${editable ? `<button class="button button-sm" data-lh="remove-item" data-code="${esc(i.parcel.trackingId)}">Remove</button>` : ""}</td></tr>`)
      .join("");
    const actions = [
      editable ? `<button class="button button-primary" type="button" data-lh="seal">Seal bag</button>` : "",
      b.status === "SEALED" && canAct(b.originHub.id) && (!b.trip || b.trip.status === "PLANNED") ? `<button class="button" type="button" data-lh="reopen">Reopen</button>` : "",
      `<button class="button" type="button" data-lh="print-bag">Print bag label</button>`,
      `<button class="button" type="button" data-lh="close-bag">Close</button>`,
    ].join("");
    el.innerHTML = `<div class="panel-heading"><div><h2 class="panel-title">Bag ${esc(b.number)}</h2><p class="panel-subtitle">${esc(route(b))} · ${b.totals.parcels} parcel(s) · ${b.totals.weightKg} kg · COD ${Ops.money(b.totals.codAmount)}${b.sealNo ? ` · seal ${esc(b.sealNo)}` : ""}${b.trip ? ` · on ${esc(b.trip.number)}` : ""}</p></div>${pillFor(BAG_STATUS[b.status])}</div>${
      editable
        ? `<form class="workflow-form" id="lhScanForm"><label>Scan parcel into the bag<input id="lhScanParcel" autocomplete="off" placeholder="Scan or type the tracking ID" required></label></form><p class="panel-subtitle" id="lhScanFeedback" aria-live="polite">${esc(state.last || "Each scan is checked: the parcel must be at this hub and not in another bag.")}</p>`
        : ""
    }<div class="form-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0">${actions}</div><div class="table-scroll" style="max-height:300px;overflow:auto">${ui.table(["Parcel", "Weight", "COD", "State", ""], items, "No parcels in this bag yet.").replace(/^<div class="table-scroll">|<\/div>$/g, "")}</div>`;
    const input = $("lhScanParcel");
    if (input) {
      DF.scanner?.attach(input, { title: `Scan parcels into ${b.number}`, continuous: true, onScan: code => scanIntoBag(code, "CAMERA") });
      input.focus();
    }
  }

  // Receive panel.
  function paintReceive() {
    const el = $("lhReceivePanel");
    if (!el) return;
    const r = state.receive;
    if (!r) {
      el.innerHTML = `<div class="panel-heading"><div><h2 class="panel-title">Receive at hub</h2><p class="panel-subtitle">Scan an arriving bag. Receive it whole, or scan the parcels out of it to check them against the manifest.</p></div></div><form class="workflow-form" id="lhReceiveForm"><label>Bag number<input id="lhReceiveBag" autocomplete="off" placeholder="BG-261016-0001" required></label><button class="button button-primary" type="submit">Check bag</button></form>`;
      DF.scanner?.attach($("lhReceiveBag"), { title: "Scan the arriving bag", onScan: () => $("lhReceiveForm").requestSubmit() });
      return;
    }
    const b = r.bag;
    const expected = new Set(b.items.filter(i => i.state === "LOADED").map(i => i.parcel.trackingId));
    const scanned = r.scanned.map(code => `<tr><td>${esc(code)}</td><td>${expected.has(code) ? ui.pill("Matched") : pillFor("Extra parcel")}</td><td><button class="button button-sm" data-lh="unscan" data-code="${esc(code)}">Undo</button></td></tr>`).join("");
    const missing = [...expected].filter(code => !r.scanned.includes(code));
    const canReceive = b.status === "IN_TRANSIT" && canAct(b.destHub.id);
    el.innerHTML = `<div class="panel-heading"><div><h2 class="panel-title">Receive ${esc(b.number)}</h2><p class="panel-subtitle">${esc(route(b))} · ${expected.size} parcel(s) on the manifest · sealed ${esc(b.sealNo || "—")}${b.trip ? ` · ${esc(b.trip.number)}` : ""}</p></div>${pillFor(BAG_STATUS[b.status])}</div>${
      canReceive
        ? `<form class="workflow-form" id="lhReceiveScanForm"><label>Seal number on arrival (optional)<input id="lhArrivalSeal" autocomplete="off" value="${esc(r.seal || "")}" placeholder="${esc(b.sealNo || "")}"></label><label>Scan parcels out of the bag<input id="lhReceiveParcel" autocomplete="off" placeholder="Scan or type the tracking ID"></label></form><p class="panel-subtitle">${r.scanned.length} scanned · ${missing.length} not scanned yet${missing.length && missing.length <= 6 ? `: ${esc(missing.join(", "))}` : ""}</p><div class="form-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0"><button class="button button-primary" type="button" data-lh="receive-finish" ${r.scanned.length ? "" : "disabled"}>Finish receiving (${r.scanned.length})</button><button class="button" type="button" data-lh="receive-whole">Receive whole bag</button><button class="button" type="button" data-lh="receive-cancel">Cancel</button></div>${r.scanned.length ? ui.table(["Scanned", "Check", ""], scanned, "") : ""}`
        : `<p class="panel-subtitle">${b.status === "RECEIVED" ? `Received ${esc(Ops.when(b.receivedAt))}: ${b.totals.received} received, ${b.totals.missing} missing.` : b.status === "IN_TRANSIT" ? "Only the destination hub can receive this bag." : "This bag hasn't departed yet."}</p><div class="form-actions" style="margin:10px 0"><button class="button" type="button" data-lh="receive-cancel">Back</button></div>${b.discrepancies.length ? ui.table(["Issue", "Tracking ID", "Note"], b.discrepancies.map(d => `<tr><td>${pillFor(DISCREPANCY[d.kind])}</td><td>${esc(d.trackingId || "—")}</td><td>${esc(d.note || "")}</td></tr>`).join(""), "") : ""}`
    }`;
    const input = $("lhReceiveParcel");
    if (input) {
      DF.scanner?.attach(input, { title: `Scan parcels out of ${b.number}`, continuous: true, onScan: code => scanOut(code, "CAMERA") });
      input.focus();
    }
  }

  // Trip detail (manifest).
  function paintTrip() {
    const el = $("lhTripDetail");
    if (!el) return;
    const t = state.trip;
    el.hidden = !t;
    if (!t) return void (el.innerHTML = "");
    const loading = t.status === "PLANNED" && canAct(t.originHub.id);
    const bags = t.bags
      .map(b => `<tr><td><strong>${esc(b.number)}</strong><span class="subcell">Seal ${esc(b.sealNo || "—")}</span></td><td>${b.totals.parcels}</td><td>${b.totals.weightKg} kg</td><td>${Ops.money(b.totals.codAmount)}</td><td>${pillFor(BAG_STATUS[b.status])}${b.totals.missing ? `<span class="subcell">${b.totals.missing} missing</span>` : ""}</td><td>${loading ? `<button class="button button-sm" data-lh="unload" data-bag="${b.id}">Unload</button>` : b.status === "IN_TRANSIT" && canAct(t.destHub.id) ? `<button class="button button-sm" data-lh="receive-start" data-number="${esc(b.number)}">Receive</button>` : ""}</td></tr>`)
      .join("");
    const actions = [
      loading ? `<button class="button button-primary" type="button" data-lh="depart" data-id="${t.id}">Depart</button>` : "",
      t.status === "DEPARTED" && canAct(t.destHub.id) ? `<button class="button" type="button" data-lh="arrive" data-id="${t.id}">Mark arrived</button>` : "",
      t.status === "ARRIVED" && canAct(t.destHub.id) ? `<button class="button" type="button" data-lh="close" data-id="${t.id}">Close trip</button>` : "",
      loading ? `<button class="button" type="button" data-lh="cancel-trip" data-id="${t.id}">Cancel trip</button>` : "",
      `<button class="button" type="button" data-lh="print-manifest">Print manifest</button>`,
      `<button class="button" type="button" data-lh="close-trip">Close</button>`,
    ].join("");
    el.innerHTML = `<div class="panel-heading"><div><h2 class="panel-title">Manifest ${esc(t.number)}</h2><p class="panel-subtitle">${esc(route(t))} · ${esc(t.vehicleRegNo)} · ${esc(t.driverName)} (${esc(DF.localPhone(t.driverPhone))}) · ${t.totals.bags} bags · ${t.totals.parcels} parcels · ${t.totals.weightKg} kg · COD ${Ops.money(t.totals.codAmount)}</p></div>${pillFor(TRIP_STATUS[t.status])}</div>${
      loading ? `<form class="workflow-form" id="lhLoadForm" style="padding:0 16px"><label>Load a sealed bag (scan its label)<input id="lhLoadBag" autocomplete="off" placeholder="BG-261016-0001" required></label></form>` : ""
    }<div class="form-actions" style="display:flex;gap:8px;flex-wrap:wrap;padding:10px 16px">${actions}</div>${ui.table(["Bag", "Parcels", "Weight", "COD", "Status", ""], bags, "No bags loaded yet.")}${t.discrepancies.length ? `<p class="panel-subtitle" style="padding:8px 16px">${t.totals.openDiscrepancies} open discrepancy(ies) on this trip.</p>` : ""}`;
    const input = $("lhLoadBag");
    if (input) DF.scanner?.attach(input, { title: `Load bags on ${t.number}`, continuous: true, onScan: code => loadBag(code, "CAMERA") });
  }

  // ───────────── actions ─────────────

  async function openBag(ref, quiet = false) {
    try {
      state.bag = await DF.api(`/linehaul/bags/${encodeURIComponent(ref)}`);
    } catch (error) {
      if (!quiet) showToast(DF.describe(error));
      if (quiet) state.bag = null;
    }
    paint("bag");
  }

  async function openTrip(ref, quiet = false) {
    try {
      state.trip = await DF.api(`/linehaul/trips/${encodeURIComponent(ref)}`);
    } catch (error) {
      if (!quiet) showToast(DF.describe(error));
      if (quiet) state.trip = null;
    }
    paint("trip");
    if (!quiet) $("lhTripDetail")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function scanIntoBag(code, source = "KEYBOARD") {
    const b = state.bag;
    if (!b || !code) return;
    try {
      const result = await DF.api(`/linehaul/bags/${b.id}/items`, { method: "POST", body: { code, source } });
      state.bag = result.bag;
      state.last = result.added ? `${code.toUpperCase()} added · ${result.bag.totals.parcels} parcel(s) in the bag` : `${code.toUpperCase()} is already in this bag`;
    } catch (error) {
      state.last = DF.describe(error);
      showToast(state.last);
    }
    paint("bag");
  }

  function scanOut(code, _source) {
    const r = state.receive;
    const clean = DF.scanner ? DF.scanner.normalize(code) : String(code).trim().toUpperCase();
    if (!r || !clean || r.scanned.includes(clean)) return;
    r.scanned.push(clean);
    r.seal = $("lhArrivalSeal")?.value.trim() || r.seal;
    r.source = _source || r.source || "KEYBOARD";
    paint("receive");
  }

  async function receive(whole) {
    const r = state.receive;
    if (!r) return;
    const hubId = r.bag.destHub.id;
    const sealNo = ($("lhArrivalSeal")?.value || r.seal || "").trim() || undefined;
    if (whole && !confirm(`Receive ${r.bag.number} with all ${r.bag.totals.loaded} manifested parcel(s) at ${r.bag.destHub.name}?`)) return;
    try {
      const result = await DF.api(`/linehaul/bags/${r.bag.id}/receive`, {
        method: "POST",
        body: { hubId, sealNo, source: r.source || "KEYBOARD", ...(whole ? {} : { trackingIds: r.scanned }) },
      });
      state.receive = { bag: result.bag, scanned: [] };
      showToast(`${result.bag.number}: ${result.received} received${result.missing ? `, ${result.missing} missing` : ""}${result.extra ? `, ${result.extra} extra` : ""}${result.sealMismatch ? ", seal mismatch recorded" : ""}.`);
      reloadAll();
    } catch (error) {
      showToast(DF.describe(error));
    }
    paint("receive");
  }

  async function loadBag(code, source = "KEYBOARD") {
    const t = state.trip;
    if (!t || !code) return;
    try {
      state.trip = await DF.api(`/linehaul/trips/${t.id}/bags`, { method: "POST", body: { bag: code, source } });
      showToast(`${String(code).toUpperCase()} loaded on ${t.number}.`);
      void loadList("bags");
    } catch (error) {
      showToast(DF.describe(error));
    }
    paint("trip");
  }

  async function tripAction(id, action, question) {
    if (question && !confirm(question)) return;
    try {
      const trip = await DF.api(`/linehaul/trips/${id}/${action}`, { method: "POST" });
      if (state.trip?.id === id) state.trip = trip;
      const done = { depart: "departed: parcels are in transit", arrive: "marked arrived", close: "closed", cancel: "cancelled" }[action];
      showToast(`${trip.number} ${done}.`);
      reloadAll();
      if (action === "depart") await Ops.refresh().catch(() => undefined);
    } catch (error) {
      showToast(DF.describe(error));
    }
  }

  function printManifest(t) {
    const bagRows = t.bags.map(b => `<tr><td class="barcode">${Ops.barcode(b.number)}<br>${esc(b.number)}</td><td>${esc(b.sealNo || "—")}</td><td>${b.totals.parcels}</td><td>${b.totals.weightKg} kg</td><td>${Ops.money(b.totals.codAmount)}</td></tr>`).join("");
    const parcelRows = t.bags
      .flatMap(b => b.items.map(i => `<tr><td>${esc(i.parcel.trackingId)}</td><td>${esc(b.number)}</td><td>${esc(i.parcel.recipient)}</td><td>${esc(i.parcel.zone)}, ${esc(i.parcel.district)}</td><td>${i.parcel.weightKg} kg</td><td>${i.parcel.codAmount ? Ops.money(i.parcel.codAmount) : "Prepaid"}</td><td>${esc(ITEM_STATE[i.state])}</td></tr>`))
      .join("");
    Ops.printPage(
      `Manifest ${t.number}`,
      `<div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start"><div><h1>Delivery Fast · Linehaul manifest</h1><p>${esc(route(t))}</p><p>Printed ${esc(new Date().toLocaleString("en-GB"))}</p></div><div class="barcode" style="text-align:right">${Ops.barcode(t.number)}<br><strong>${esc(t.number)}</strong></div></div>
<div class="grid"><div>Vehicle<strong>${esc(t.vehicleRegNo)}</strong>${esc(t.vehicle?.kind || "")}</div><div>Driver<strong>${esc(t.driverName)}</strong>${esc(DF.localPhone(t.driverPhone))}</div><div>Departure<strong>${esc(t.departedAt ? Ops.when(t.departedAt) : t.plannedDepartureAt ? `Planned ${Ops.when(t.plannedDepartureAt)}` : "Not departed")}</strong>${esc(TRIP_STATUS[t.status])}</div><div>Totals<strong>${t.totals.bags} bags · ${t.totals.parcels} parcels</strong>${t.totals.weightKg} kg · COD ${Ops.money(t.totals.codAmount)}</div></div>
<h2>Bags</h2><table><thead><tr><th>BAG</th><th>SEAL</th><th>PARCELS</th><th>WEIGHT</th><th>COD</th></tr></thead><tbody>${bagRows || `<tr><td colspan="5">No bags loaded</td></tr>`}</tbody></table>
<h2>Parcels</h2><table><thead><tr><th>TRACKING ID</th><th>BAG</th><th>RECIPIENT</th><th>DESTINATION</th><th>WEIGHT</th><th>COD</th><th>STATE</th></tr></thead><tbody>${parcelRows || `<tr><td colspan="7">No parcels</td></tr>`}</tbody></table>
${t.note ? `<p>Note: ${esc(t.note)}</p>` : ""}<div class="sign"><span>Dispatcher (${esc(hubName(t.originHub))})</span><span>Driver</span><span>Receiver (${esc(hubName(t.destHub))})</span></div>`,
    );
  }

  function printBagLabel(b) {
    Ops.printPage(
      `Bag ${b.number}`,
      `<div style="border:2px solid #182230;border-radius:8px;padding:16px;max-width:420px"><h1>Delivery Fast · Linehaul bag</h1><div class="barcode">${Ops.barcode(b.number)}</div><h2>${esc(b.number)}</h2><p><strong>${esc(hubName(b.originHub))} → ${esc(hubName(b.destHub))}</strong></p><p>${b.totals.parcels} parcel(s) · ${b.totals.weightKg} kg${b.sealNo ? ` · Seal ${esc(b.sealNo)}` : ""}</p></div>`,
    );
  }

  // Dialogs.
  function newBagDialog() {
    if (!Ops.require("dispatch", "make up bags")) return;
    const origins = Ops.myHubs() || DF.state.hubs;
    Ops.dialog("lhBag", {
      title: "New linehaul bag",
      description: "A bag carries parcels from one hub to another. Scan parcels into it, then seal it.",
      submit: "Create bag",
      fields: ui.field("lhOrigin", "From hub", ui.select("lhOrigin", ui.hubOptions(origins))) + ui.field("lhDest", "To hub", ui.select("lhDest", ui.hubOptions(DF.state.hubs.filter(h => h.id !== origins[0]?.id)))),
    });
    $("lhOrigin").addEventListener("change", () => ($("lhDest").innerHTML = DF.state.hubs.filter(h => h.id !== $("lhOrigin").value).map(h => `<option value="${h.id}">${esc(h.name)}</option>`).join("")));
  }
  Ops.submitters.lhBag = async () => {
    const bag = await DF.api("/linehaul/bags", { method: "POST", body: { originHubId: $("lhOrigin").value, destHubId: $("lhDest").value } });
    closeModal();
    state.bag = bag;
    state.last = "";
    showToast(`${bag.number} created. Scan parcels into it.`);
    paint("bag");
    void loadList("bags");
    void loadMetrics();
  };

  function sealDialog() {
    const b = state.bag;
    if (!b) return;
    if (!b.items.length) return void showToast("Scan at least one parcel into the bag before sealing it.");
    Ops.dialog("lhSeal", {
      title: `Seal ${b.number}`,
      description: `${b.totals.parcels} parcel(s) · ${b.totals.weightKg} kg. Enter the number printed on the seal; the receiving hub checks it on arrival.`,
      submit: "Seal bag",
      fields: ui.field("lhSealNo", "Seal number", ui.input("lhSealNo", 'required maxlength="40" autocomplete="off" placeholder="e.g. S-104233"'), true),
    });
    DF.scanner?.attach($("lhSealNo"), { title: "Scan the seal" });
  }
  Ops.submitters.lhSeal = async () => {
    const valid = DF.validate($("modalForm"), { lhSealNo: v => (v.trim().length < 2 ? "Enter the seal number" : "") });
    if (!valid()) return;
    state.bag = await DF.api(`/linehaul/bags/${state.bag.id}/seal`, { method: "POST", body: { sealNo: $("lhSealNo").value.trim() } });
    closeModal();
    showToast(`${state.bag.number} sealed. Load it on a trip from the manifest.`);
    paint("bag");
    void loadList("bags");
  };

  async function tripDialog() {
    if (!Ops.require("dispatch", "plan trips")) return;
    if (!state.vehicles) await loadVehicles();
    const origins = Ops.myHubs() || DF.state.hubs;
    const vehicles = (state.vehicles || []).filter(v => v.active);
    const now = new Date(Date.now() + 3600_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    Ops.dialog("lhTrip", {
      title: "Plan a linehaul trip",
      description: "The trip's manifest lists the sealed bags loaded on the truck. Departure moves every parcel in transit.",
      submit: "Create trip",
      fields:
        ui.field("lhTripOrigin", "From hub", ui.select("lhTripOrigin", ui.hubOptions(origins))) +
        ui.field("lhTripDest", "To hub", ui.select("lhTripDest", ui.hubOptions(DF.state.hubs.filter(h => h.id !== origins[0]?.id)))) +
        ui.field("lhVehicle", "Vehicle", ui.select("lhVehicle", [...vehicles.map(v => ({ value: v.id, label: `${v.regNo} · ${v.kind}` })), { value: "", label: "Other (type the registration)" }], vehicles[0]?.id || "")) +
        ui.field("lhRegNo", "Registration number", ui.input("lhRegNo", `maxlength="40" placeholder="DHAKA METRO-TA 11-2345" ${vehicles.length ? "disabled" : ""}`)) +
        ui.field("lhDriver", "Driver name", ui.input("lhDriver", 'required maxlength="120"')) +
        ui.field("lhDriverPhone", "Driver phone", ui.input("lhDriverPhone", 'required inputmode="tel"')) +
        ui.field("lhPlanned", "Planned departure", ui.input("lhPlanned", `type="datetime-local" value="${now}"`)) +
        ui.field("lhNote", "Note (optional)", ui.input("lhNote", 'maxlength="500"')),
    });
    DF.phoneInput($("lhDriverPhone"));
    $("lhTripOrigin").addEventListener("change", () => ($("lhTripDest").innerHTML = DF.state.hubs.filter(h => h.id !== $("lhTripOrigin").value).map(h => `<option value="${h.id}">${esc(h.name)}</option>`).join("")));
    $("lhVehicle").addEventListener("change", () => ($("lhRegNo").disabled = !!$("lhVehicle").value));
  }
  Ops.submitters.lhTrip = async () => {
    const valid = DF.validate($("modalForm"), {
      lhDriver: v => (v.trim().length < 2 ? "Enter the driver's name" : ""),
      lhDriverPhone: v => DF.phoneProblem(v),
      lhRegNo: v => (!$("lhVehicle").value && v.trim().length < 3 ? "Enter the vehicle's registration number" : ""),
    });
    if (!valid()) return;
    const planned = $("lhPlanned").value;
    const trip = await DF.api("/linehaul/trips", {
      method: "POST",
      body: {
        originHubId: $("lhTripOrigin").value,
        destHubId: $("lhTripDest").value,
        vehicleId: $("lhVehicle").value || undefined,
        vehicleRegNo: $("lhVehicle").value ? undefined : $("lhRegNo").value.trim(),
        driverName: $("lhDriver").value.trim(),
        driverPhone: $("lhDriverPhone").value,
        plannedDepartureAt: planned ? new Date(planned).toISOString() : undefined,
        note: $("lhNote").value.trim() || undefined,
      },
    });
    closeModal();
    state.trip = trip;
    showToast(`${trip.number} planned. Scan sealed bags to load them.`);
    paint("trip");
    void loadList("trips");
  };

  function resolveDialog(id) {
    const d = state.issues.items.find(x => x.id === id);
    if (!d) return;
    Ops.dialog("lhResolve", {
      title: `Resolve · ${DISCREPANCY[d.kind]}`,
      description: `${d.trackingId || d.bag?.number || ""} · ${d.note || ""}`,
      submit: "Resolve",
      context: { issueId: id },
      fields: ui.field("lhResolution", "What was done", `<textarea id="lhResolution" required maxlength="500" placeholder="e.g. Found on the next truck and received"></textarea>`, true),
    });
  }
  Ops.submitters.lhResolve = async () => {
    const valid = DF.validate($("modalForm"), { lhResolution: v => (v.trim().length < 2 ? "Describe the resolution" : "") });
    if (!valid()) return;
    await DF.api(`/linehaul/discrepancies/${modalContext.issueId}/resolve`, { method: "POST", body: { resolution: $("lhResolution").value.trim() } });
    closeModal();
    showToast("Discrepancy resolved.");
    void loadList("issues");
    void loadMetrics();
  };

  function vehicleDialog(id) {
    if (!Ops.require("manageHubs", "manage vehicles")) return;
    const v = (state.vehicles || []).find(x => x.id === id);
    Ops.dialog("lhVehicle", {
      title: v ? `Edit vehicle · ${v.regNo}` : "Add vehicle",
      submit: v ? "Save vehicle" : "Add vehicle",
      context: { vehicleId: v?.id },
      fields:
        ui.field("lvReg", "Registration number", ui.input("lvReg", `required maxlength="40" value="${esc(v?.regNo || "")}"`)) +
        ui.field("lvKind", "Type", `<input id="lvKind" list="lvKinds" required maxlength="40" value="${esc(v?.kind || "")}"><datalist id="lvKinds"><option value="Covered van"><option value="Truck"><option value="Pickup"></datalist>`) +
        ui.field("lvCap", "Capacity (kg, optional)", ui.input("lvCap", `type="number" min="1" step="1" value="${v?.capacityKg ?? ""}"`)) +
        ui.field("lvOwner", "Owner / vendor (optional)", ui.input("lvOwner", `maxlength="120" value="${esc(v?.ownerName || "")}"`)) +
        ui.field("lvActive", "Status", ui.select("lvActive", [{ value: "true", label: "Active" }, { value: "false", label: "Inactive" }], String(v?.active ?? true))),
    });
  }
  Ops.submitters.lhVehicle = async () => {
    const valid = DF.validate($("modalForm"), { lvReg: v => (v.trim().length < 3 ? "Enter the registration number" : ""), lvKind: v => (v.trim().length < 2 ? "Enter the vehicle type" : "") });
    if (!valid()) return;
    const id = modalContext.vehicleId;
    const body = {
      regNo: $("lvReg").value.trim(),
      kind: $("lvKind").value.trim(),
      capacityKg: $("lvCap").value ? Number($("lvCap").value) : id ? null : undefined,
      ownerName: $("lvOwner").value.trim() || (id ? null : undefined),
      active: $("lvActive").value === "true",
    };
    await DF.api(id ? `/linehaul/vehicles/${id}` : "/linehaul/vehicles", { method: id ? "PATCH" : "POST", body });
    closeModal();
    showToast(`${body.regNo} ${id ? "saved" : "added"}.`);
    void loadVehicles();
  };

  // ───────────── events ─────────────

  window.addEventListener(
    "click",
    event => {
      if (!onPage()) return;
      const el = event.target.closest("[data-lh]");
      if (!el) return;
      event.stopImmediatePropagation();
      const id = el.dataset.id;
      switch (el.dataset.lh) {
        case "new-bag":
          return newBagDialog();
        case "new-trip":
          return void tripDialog();
        case "vehicles-jump":
          $("lhVehicles").hidden = false;
          return $("lhVehicles").scrollIntoView({ behavior: "smooth" });
        case "add-vehicle":
          return vehicleDialog();
        case "edit-vehicle":
          return vehicleDialog(id);
        case "open-bag":
          return void openBag(id);
        case "open-trip":
          return void openTrip(id);
        case "close-bag":
          state.bag = null;
          return paint("bag");
        case "close-trip":
          state.trip = null;
          return paint("trip");
        case "seal":
          return sealDialog();
        case "reopen":
          if (!confirm(`Break the seal of ${state.bag.number} and reopen it?`)) return;
          return void DF.api(`/linehaul/bags/${state.bag.id}/reopen`, { method: "POST" })
            .then(bag => ((state.bag = bag), paint("bag"), loadList("bags")))
            .catch(error => showToast(DF.describe(error)));
        case "remove-item":
          return void DF.api(`/linehaul/bags/${state.bag.id}/items/${encodeURIComponent(el.dataset.code)}`, { method: "DELETE" })
            .then(bag => ((state.bag = bag), (state.last = `${el.dataset.code} removed`), paint("bag")))
            .catch(error => showToast(DF.describe(error)));
        case "print-bag":
          return printBagLabel(state.bag);
        case "print-manifest":
          return printManifest(state.trip);
        case "unload":
          return void DF.api(`/linehaul/trips/${state.trip.id}/bags/${el.dataset.bag}`, { method: "DELETE" })
            .then(trip => ((state.trip = trip), paint("trip"), loadList("bags")))
            .catch(error => showToast(DF.describe(error)));
        case "depart":
          return void tripAction(id, "depart", "Dispatch this truck? Every parcel on the manifest goes in transit to the destination hub.");
        case "arrive":
          return void tripAction(id, "arrive");
        case "close":
          return void tripAction(id, "close", "Close this trip? Parcels in bags that weren't received are recorded as missing.");
        case "cancel-trip":
          return void tripAction(id, "cancel", "Cancel this planned trip? Its bags stay sealed and can go on another trip.");
        case "resolve":
          return resolveDialog(id);
        case "more":
          return void loadList(el.dataset.kind, true);
        case "receive-start":
          return void startReceive(el.dataset.number);
        case "receive-cancel":
          state.receive = null;
          return paint("receive");
        case "receive-whole":
          return void receive(true);
        case "receive-finish":
          return void receive(false);
        case "unscan":
          state.receive.scanned = state.receive.scanned.filter(c => c !== el.dataset.code);
          return paint("receive");
      }
    },
    true,
  );

  async function startReceive(number) {
    try {
      const bag = await DF.api(`/linehaul/bags/${encodeURIComponent(number)}`);
      Ops.recordScan?.(bag.number, "BAG_RECEIVE", bag.destHub.id);
      state.receive = { bag, scanned: [] };
    } catch (error) {
      showToast(DF.describe(error));
    }
    paint("receive");
    $("lhReceivePanel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  window.addEventListener(
    "submit",
    event => {
      if (!onPage()) return;
      const form = event.target;
      const handlers = {
        lhOpenBagForm: () => openBag($("lhOpenBag").value.trim()),
        lhScanForm: () => {
          const input = $("lhScanParcel");
          const code = input.value.trim();
          input.value = "";
          return scanIntoBag(code, "KEYBOARD");
        },
        lhReceiveForm: () => startReceive($("lhReceiveBag").value.trim()),
        lhReceiveScanForm: () => {
          const input = $("lhReceiveParcel");
          const code = input.value.trim();
          input.value = "";
          scanOut(code, "KEYBOARD");
        },
        lhLoadForm: () => {
          const input = $("lhLoadBag");
          const code = input.value.trim();
          input.value = "";
          return loadBag(code, "KEYBOARD");
        },
      };
      if (!handlers[form.id]) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      Promise.resolve(handlers[form.id]()).catch(error => showToast(DF.describe(error)));
    },
    true,
  );

  const searchLater = ui.debounce(kind => void loadList(kind), 350);
  window.addEventListener("input", event => {
    if (!onPage()) return;
    const kind = event.target.dataset?.lhSearch;
    if (!kind) return;
    state[kind].q = event.target.value.trim();
    searchLater(kind);
  });
  window.addEventListener("change", event => {
    if (!onPage()) return;
    const kind = event.target.dataset?.lhFilter;
    if (kind) {
      state[kind][event.target.dataset.key] = event.target.value;
      return void loadList(kind);
    }
    if (event.target.dataset && "lhIssues" in event.target.dataset) {
      state.issues.open = event.target.value;
      void loadList("issues");
    }
  });

  // Live: linehaul changes anywhere on my routes; parcel changes can affect open bags.
  DF.live(["linehaul.updated"], () => {
    if (onPage()) reloadAll();
    else state.bags.loaded = false;
  });
})();
