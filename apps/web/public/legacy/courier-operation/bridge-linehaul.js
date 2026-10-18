/*
 * Courier Operations on the API, part 5: Linehaul between hubs (sidebar "Linehaul").
 *
 *   Bags        POST /linehaul/bags, /bags/:bag/items (scan), /seal, /reopen, DELETE items
 *   Trips       POST /linehaul/trips, /trips/:trip/bags (load), /depart, /arrive, /close, /cancel
 *   Receiving   POST /linehaul/receive-scan (bag label = whole bag, parcel = one by one, manifest = the trip to
 *               check; missing / extra recorded), POST /linehaul/bags/:bag/receive { trackingIds: [] } (finish a bag)
 *   Inbound     GET /linehaul/inbound (trips and bags coming to my hub, expected / received / missing)
 *   Excel       "Bulk transfer by Excel": the "transfer" bulk action (DFImport.bulk, kind transfers) with apply
 *               options (seal the bags, load them on a planned or new trip) and the bags / trips in the result
 *   Manifests   GET /linehaul/trips/:trip; print: GET /documents/manifest/:trip (PDF) and /documents/bag-label/:bag
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
    recv: { hubId: "", trip: null, bag: null, log: [], seal: "", last: null }, // receive desk (scan)
    inbound: { items: [], totals: null, hubId: "", loaded: false, error: null },
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
    void loadInbound();
    if (Ops.can("manageHubs") || Ops.can("dispatch")) void loadVehicles();
    if (state.bag) void openBag(state.bag.id, true);
    if (state.trip) void openTrip(state.trip.id, true);
  }

  // ───────────── rendering ─────────────

  Ops.pages[PAGE] = {
    render: () => {
      const actions = Ops.can("dispatch")
        ? `<button class="button" id="lhBulkTransfer" data-lh="bulk-transfer" title="Download the parcels at your hub that go to other hubs, choose destination and bag, upload, preview and apply">${icon("box")} Bulk transfer by Excel</button><button class="button" id="lhTransferHistory" data-lh="transfer-history">Transfer history</button><button class="button" data-lh="vehicles-jump">${icon("truck")} Vehicles</button><button class="button" data-lh="new-trip">${icon("route")} Plan trip</button><button class="button button-primary" data-lh="new-bag">${icon("plus")} New bag</button>`
        : "";
      return `<div class="page-heading"><div><p class="eyebrow">Hub operations · between hubs</p><h1>Linehaul</h1><p class="subtitle">Bag parcels, load trucks against a manifest, dispatch them and receive bags at the destination hub.</p></div><div class="heading-actions">${actions}</div></div>
<div class="metrics" id="lhMetrics"></div>
<div class="workflow-grid">
  <section class="panel" id="lhBagPanel"></section>
  <section class="panel" id="lhReceivePanel"></section>
</div>
<section class="panel table-panel" id="lhInbound"></section>
<section class="panel table-panel" id="lhTripDetail" hidden></section>
<section class="panel table-panel" id="lhTrips"></section>
<section class="panel table-panel" id="lhBags"></section>
<section class="panel table-panel" id="lhIssues"></section>
<section class="panel table-panel" id="lhVehicles" hidden></section>`;
    },
  };

  Ops.enhance[PAGE] = () => {
    for (const part of ["metrics", "bag", "receive", "inbound", "trip", "trips", "bags", "issues", "vehicles"]) paint(part);
    if (!state.bags.loaded) reloadAll();
  };

  function paint(part) {
    if (!onPage()) return;
    const painters = { metrics: paintMetrics, bag: paintBag, receive: paintReceive, inbound: paintInbound, trip: paintTrip, trips: paintTrips, bags: paintBags, issues: paintIssues, vehicles: paintVehicles };
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

  // Receive panel: scan at the destination hub (POST /linehaul/receive-scan). A bag label receives the
  // whole bag, a parcel is received out of its inbound bag, a manifest selects the trip to check.
  const recvHubs = () => Ops.myHubs() || DF.state.hubs || [];
  const recvHub = () => {
    const r = state.recv;
    if (!r.hubId || !recvHubs().some(h => h.id === r.hubId)) r.hubId = recvHubs()[0]?.id || "";
    return r.hubId;
  };
  const OUTCOME = {
    RECEIVED: "Received",
    BAG_RECEIVED: "Bag received",
    ALREADY_RECEIVED: "Already received",
    TRIP: "Checking trip",
    EXTRA: "Extra parcel",
    WRONG_HUB: "Wrong hub",
    NOT_FOUND: "Not found",
    NOT_IN_TRANSIT: "Not departed",
    REFUSED: "Refused",
  };
  const outcomePill = o => `<span class="status ${o === "RECEIVED" || o === "BAG_RECEIVED" ? "status-good" : o === "ALREADY_RECEIVED" || o === "TRIP" ? "status-blue" : "status-bad"}">${esc(OUTCOME[o] || o)}</span>`;

  function paintReceive() {
    const el = $("lhReceivePanel");
    if (!el) return;
    const r = state.recv;
    const hubs = recvHubs();
    const hubId = recvHub();
    const canScan = Ops.can("dispatch") && !!hubId;
    const t = r.trip;
    const b = r.bag;
    const context = t
      ? `<div id="lhRecvContext" data-trip="${esc(t.number)}" style="margin:8px 0;padding:10px 12px;border:1px solid var(--line);border-radius:10px"><strong>${esc(t.number)}</strong> · ${esc(hubName(t.originHub))} → ${esc(hubName(t.destHub))} · ${pillFor(TRIP_STATUS[t.status])}<span class="subcell" id="lhRecvCounts">Expected ${t.totals.expected} · received ${t.totals.received} · missing ${t.totals.missing} · still expected ${t.totals.pending}</span>${
          t.bags.length
            ? `<table style="margin-top:6px"><tbody>${t.bags
                .map(x => `<tr data-bag="${esc(x.number)}"${b?.number === x.number ? ' style="background:#eef4ff"' : ""}><td><strong>${esc(x.number)}</strong>${x.label ? `<span class="subcell">${esc(x.label)}</span>` : ""}</td><td>${x.received} / ${x.expected} received${x.missing ? ` · ${x.missing} missing` : ""}</td><td>${pillFor(BAG_STATUS[x.status])}</td></tr>`)
                .join("")}</tbody></table>`
            : ""
        }</div>`
      : b
        ? `<div id="lhRecvContext" data-bag="${esc(b.number)}" style="margin:8px 0;padding:10px 12px;border:1px solid var(--line);border-radius:10px"><strong>${esc(b.number)}</strong> · ${esc(route(b))} · ${pillFor(BAG_STATUS[b.status])}<span class="subcell" id="lhRecvCounts">Expected ${b.totals.parcels} · received ${b.totals.received} · missing ${b.totals.missing} · still expected ${b.totals.loaded}</span></div>`
        : `<p class="panel-subtitle" id="lhRecvContext">Scan a manifest (MF-…) to check a trip, a bag label (BG-…) to receive the whole bag, or parcels one by one. Or press Check on an inbound trip below.</p>`;
    const missingLeft = b && b.status === "IN_TRANSIT" ? b.items.filter(i => i.state === "LOADED") : [];
    const log = r.log
      .slice(0, 12)
      .map(x => `<tr data-outcome="${esc(x.outcome)}"><td><strong>${esc(x.code)}</strong></td><td>${outcomePill(x.outcome)}</td><td>${esc(x.message)}</td></tr>`)
      .join("");
    // The scan form is drawn once per hub (the scanner keeps its feedback and focus); the rest follows each scan.
    const formKey = `${hubId}|${hubs.length}|${canScan}`;
    if (el.dataset.form !== formKey || !$("lhRecvBody")) {
      el.dataset.form = formKey;
      el.innerHTML = `<div class="panel-heading"><div><h2 class="panel-title">Receive transfers</h2><p class="panel-subtitle">Scan at ${esc(hubs.find(h => h.id === hubId)?.name || "your hub")}: bags whole, or parcels one by one against the manifest. Missing and extra parcels are recorded.</p></div></div>${
        canScan
          ? `<form class="workflow-form" id="lhRecvForm">${hubs.length > 1 ? `<label>Receiving hub${ui.select("lhRecvHub", ui.hubOptions(hubs), hubId, 'aria-label="Receiving hub"')}</label>` : ""}<label>Scan bag, manifest or parcel<input id="lhRecvScan" autocomplete="off" placeholder="BG-… · MF-… · tracking ID" aria-label="Scan bag, manifest or parcel"></label><label>Seal number on arrival (bags, optional)<input id="lhRecvSeal" autocomplete="off" value="${esc(r.seal)}" placeholder="As printed on the seal"></label><button class="button button-primary" type="submit">Receive</button></form>`
          : `<p class="panel-subtitle">Only operations staff of the receiving hub can receive transfers.</p>`
      }<div id="lhRecvBody"></div>`;
      const input = $("lhRecvScan");
      if (input) DF.scanner?.attach(input, { title: "Scan bags or parcels to receive", continuous: true, onScan: code => void recvScan(code, "CAMERA") });
    }
    const seal = $("lhRecvSeal");
    if (seal && document.activeElement !== seal) seal.value = r.seal;
    $("lhRecvBody").innerHTML = `<p class="panel-subtitle" id="lhRecvFeedback" aria-live="polite"${r.last ? ` data-outcome="${esc(r.last.outcome)}"` : ""}>${esc(r.last?.message || "")}</p>${context}<div class="form-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">${
      missingLeft.length && b.items.some(i => i.state === "RECEIVED") && canAct(b.destHub.id) ? `<button class="button" type="button" data-lh="recv-finish">Finish ${esc(b.number)}: ${missingLeft.length} not scanned → missing</button>` : ""
    }${t || b ? `<button class="button" type="button" data-lh="recv-clear">Clear</button>` : ""}</div>${log ? ui.table(["Scanned", "Result", "Message"], log, "") : ""}`;
  }

  async function recvScan(code, source = "KEYBOARD") {
    const r = state.recv;
    const clean = String(code || "").trim();
    if (!clean) return;
    r.seal = $("lhRecvSeal")?.value.trim() || "";
    try {
      const res = await DF.api("/linehaul/receive-scan", {
        method: "POST",
        body: { hubId: recvHub(), code: clean, source, tripId: r.trip?.id, bagId: r.bag?.id, sealNo: /^BG-/i.test(clean) && r.seal ? r.seal : undefined },
      });
      if (res.trip) r.trip = res.trip;
      if (res.bag) r.bag = res.bag;
      if (/^BG-/i.test(clean) && res.ok) r.seal = "";
      r.last = res;
      r.log.unshift({ code: res.code, outcome: res.outcome, message: res.message });
      paint("receive");
      DF.scanner?.feedback?.("lhRecvScan", res.ok, res.message);
      if (["RECEIVED", "BAG_RECEIVED", "EXTRA"].includes(res.outcome)) inboundLater();
    } catch (error) {
      r.last = { outcome: "REFUSED", message: DF.describe(error) };
      r.log.unshift({ code: clean.toUpperCase(), outcome: "REFUSED", message: r.last.message });
      paint("receive");
      DF.scanner?.feedback?.("lhRecvScan", false, r.last.message);
    }
  }

  /** The bag being opened is done: whatever wasn't scanned out of it is recorded missing. */
  async function finishBag() {
    const r = state.recv;
    const b = r.bag;
    if (!b) return;
    const left = b.items.filter(i => i.state === "LOADED").length;
    if (!(await Ops.confirm({ title: `Finish ${b.number}?`, message: `${left} parcel(s) not scanned out of the bag are recorded as missing (a discrepancy to resolve).`, confirm: "Finish and record missing", danger: true }))) return;
    try {
      const res = await DF.api(`/linehaul/bags/${b.id}/receive`, { method: "POST", body: { hubId: b.destHub.id, trackingIds: [], source: "KEYBOARD" } });
      r.bag = res.bag;
      if (r.trip) r.trip = (await DF.api(`/linehaul/inbound?hubId=${encodeURIComponent(b.destHub.id)}`).catch(() => null))?.items.find(t => t.id === r.trip.id) || r.trip;
      r.last = { outcome: "BAG_RECEIVED", message: `${res.bag.number} finished: ${res.missing} missing.` };
      showToast(r.last.message);
      reloadAll();
    } catch (error) {
      showToast(DF.describe(error));
    }
    paint("receive");
  }

  // Inbound transfers: trips and bags coming to my hub(s) with expected / received counts.
  async function loadInbound() {
    const s = state.inbound;
    const hubs = Ops.myHubs();
    const params = new URLSearchParams();
    if (!hubs && s.hubId) params.set("hubId", s.hubId);
    try {
      const page = await DF.api(`/linehaul/inbound${params.size ? `?${params}` : ""}`);
      s.items = page.items;
      s.totals = page.totals;
      s.error = null;
      const r = state.recv;
      if (r.trip) r.trip = page.items.find(t => t.id === r.trip.id) || r.trip;
    } catch (error) {
      s.error = DF.describe(error);
    }
    s.loaded = true;
    paint("inbound");
    paint("receive");
  }
  const inboundLater = ui.debounce(() => void loadInbound(), 400);

  function paintInbound() {
    const el = $("lhInbound");
    if (!el) return;
    const s = state.inbound;
    const rows = s.items
      .map(t => {
        const bags = t.bags.map(b => `<span class="subcell">${esc(b.number)}${b.label ? ` (${esc(b.label)})` : ""}: ${b.received}/${b.expected}${b.missing ? ` · ${b.missing} missing` : ""} · ${esc(BAG_STATUS[b.status])}</span>`).join("");
        const acts = [`<button class="button button-sm" data-lh="recv-check" data-id="${t.id}">Check</button>`, `<button class="button button-sm" data-lh="open-trip" data-id="${t.id}">Manifest</button>`];
        return `<tr data-trip="${esc(t.number)}"><td><strong>${esc(t.number)}</strong><span class="subcell">${esc(t.vehicleRegNo)} · ${esc(t.driverName)}</span></td><td>${esc(hubName(t.originHub))} → ${esc(hubName(t.destHub))}</td><td>${esc(t.departedAt ? `Left ${Ops.when(t.departedAt)}` : t.plannedDepartureAt ? `Planned ${Ops.when(t.plannedDepartureAt)}` : "Planned")}${t.arrivedAt ? `<span class="subcell">Arrived ${esc(Ops.when(t.arrivedAt))}</span>` : ""}</td><td>${t.totals.bagsReceived} / ${t.totals.bags}${bags}</td><td data-col="counts">${t.totals.expected} expected · ${t.totals.received} received${t.totals.missing ? ` · ${t.totals.missing} missing` : ""}${t.totals.pending && t.status !== "PLANNED" ? `<span class="subcell">${t.totals.pending} still expected</span>` : ""}</td><td>${pillFor(TRIP_STATUS[t.status])}${t.totals.openDiscrepancies ? `<span class="subcell">${t.totals.openDiscrepancies} open issue(s)</span>` : ""}</td><td><div style="display:flex;gap:6px;flex-wrap:wrap">${acts.join("")}</div></td></tr>`;
      })
      .join("");
    const m = s.totals;
    const tools = !Ops.myHubs() ? ui.select("lhInboundHub", ui.hubOptions(DF.state.hubs, "All hubs"), s.hubId, 'class="select-small" aria-label="Receiving hub"') : "";
    el.outerHTML = ui.panel(
      "Inbound transfers",
      m ? `${m.trips} trip(s) coming in · ${m.onTheRoad} on the road · ${m.expected} parcels expected, ${m.received} received${m.missing ? `, ${m.missing} missing` : ""}` : "Trips and bags coming to your hub",
      ui.table(["Manifest", "Route", "Departure", "Bags received", "Parcels", "Status", ""], rows, s.error || (s.loaded ? "No transfers coming in." : "Loading inbound transfers…")),
      tools,
      'id="lhInbound"',
    );
  }

  async function startReceive(number) {
    try {
      const bag = await DF.api(`/linehaul/bags/${encodeURIComponent(number)}`);
      state.recv.bag = bag;
      state.recv.hubId = bag.destHub.id;
      state.recv.trip = bag.trip ? state.inbound.items.find(t => t.id === bag.trip.id) || null : null;
      state.recv.last = { outcome: "TRIP", message: `Opening ${bag.number}: scan its parcels one by one, or scan the bag label to receive it whole.` };
    } catch (error) {
      showToast(DF.describe(error));
    }
    paint("receive");
    $("lhReceivePanel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ───────────── bulk transfer by Excel ─────────────

  const topt = { seal: true, trip: "", vehicle: "", regNo: "", driver: "", phone: "", trips: [], vehicles: [] };

  function transferOptionsHtml() {
    const trips = topt.trips.map(t => ({ value: t.id, label: `${t.number} → ${hubName(t.destHub)} · ${t.vehicleRegNo}` }));
    const isNew = topt.trip === "new";
    const vehicles = [...topt.vehicles.map(v => ({ value: v.id, label: `${v.regNo} · ${v.kind}` })), { value: "", label: "Other (type the registration)" }];
    return `<form id="dfiTransferOptions" onsubmit="return false" style="margin-top:14px;padding:12px 14px;border:1px solid #e3e8ef;border-radius:10px;display:grid;gap:10px">
      <h3 style="margin:0;font-size:15px">After the parcels are in their bags</h3>
      <label style="display:flex;gap:8px;align-items:center;font-weight:600;font-size:13px"><input type="checkbox" id="dfiTSeal" ${topt.seal || topt.trip ? "checked" : ""} ${topt.trip ? "disabled" : ""}> Seal the bags (seal number = the bag number on its printed tag)</label>
      <label style="display:grid;gap:4px;font-weight:600;font-size:13px">Load on a trip${ui.select("dfiTTrip", [{ value: "", label: "Don't load yet (load later from the manifest)" }, ...trips, { value: "new", label: "New trip per destination…" }], topt.trip, 'aria-label="Load on a trip"')}</label>
      ${
        isNew
          ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">
        <label style="display:grid;gap:4px;font-size:13px">Vehicle${ui.select("dfiTVehicle", vehicles, topt.vehicle, 'aria-label="Vehicle"')}</label>
        <label style="display:grid;gap:4px;font-size:13px">Registration number<input id="dfiTRegNo" maxlength="40" value="${esc(topt.regNo)}" ${topt.vehicle ? "disabled" : ""} placeholder="DHAKA METRO-TA 11-2345"></label>
        <label style="display:grid;gap:4px;font-size:13px">Driver name<input id="dfiTDriver" maxlength="120" value="${esc(topt.driver)}"></label>
        <label style="display:grid;gap:4px;font-size:13px">Driver phone<input id="dfiTPhone" inputmode="tel" value="${esc(topt.phone)}"></label>
      </div>`
          : ""
      }
      <p class="panel-subtitle" style="margin:0">Parcels stay "At hub" in their bags; they become "In transit" when the trip departs (Transfers → manifest → Depart). Bags on a trip are sealed first.</p>
      <p role="alert" id="dfiTError" style="margin:0;color:#b42318;font-weight:600"></p>
    </form>`;
  }
  function mountTransferOptions() {
    const form = $("dfiTransferOptions");
    if (!form) return;
    const phone = $("dfiTPhone");
    if (phone && !phone.dataset.dfPhone) {
      DF.phoneInput(phone);
      phone.dataset.dfPhone = "1";
    }
    const read = () => {
      topt.seal = !!$("dfiTSeal")?.checked;
      topt.trip = $("dfiTTrip")?.value || "";
      topt.vehicle = $("dfiTVehicle")?.value || "";
      topt.regNo = $("dfiTRegNo")?.value || "";
      topt.driver = $("dfiTDriver")?.value || "";
      topt.phone = $("dfiTPhone")?.value || "";
    };
    form.addEventListener("input", read);
    form.addEventListener("change", event => {
      read();
      if (["dfiTTrip", "dfiTVehicle"].includes(event.target.id)) {
        form.outerHTML = transferOptionsHtml();
        mountTransferOptions();
      }
    });
  }
  function transferBody() {
    const error = $("dfiTError");
    const fail = message => {
      if (error) error.textContent = message;
      return false;
    };
    if (topt.trip === "new") {
      if (!topt.vehicle && topt.regNo.trim().length < 3) return fail("Choose the vehicle or type its registration number.");
      if (topt.driver.trim().length < 2) return fail("Enter the driver's name.");
      const problem = DF.phoneProblem(topt.phone);
      if (problem) return fail(`Driver phone: ${problem}`);
    }
    if (error) error.textContent = "";
    const transfer = { seal: topt.seal || !!topt.trip };
    if (topt.trip === "new")
      transfer.newTrip = { vehicleId: topt.vehicle || undefined, vehicleRegNo: topt.vehicle ? undefined : topt.regNo.trim(), driverName: topt.driver.trim(), driverPhone: topt.phone };
    else if (topt.trip) transfer.tripId = topt.trip;
    return { transfer };
  }
  function transferResultHtml(job) {
    const r = job.transfer?.result;
    if (!r) return "";
    const bags = r.bags
      .map(b => `<tr data-bag="${esc(b.number)}"><td><strong>${esc(b.number)}</strong>${b.label ? `<span class="subcell">${esc(b.label)}</span>` : ""}</td><td>${esc(b.originHub)} → ${esc(b.destHub)}</td><td>${b.parcels}</td><td>${esc(BAG_STATUS[b.status] || b.status)}</td><td>${esc(b.trip || "—")}</td><td><button class="button button-sm" type="button" data-lh="print-bag-n" data-number="${esc(b.number)}">Print tag</button></td></tr>`)
      .join("");
    const trips = r.trips.map(t => `<button class="button button-sm" type="button" data-lh="print-manifest-n" data-number="${esc(t.number)}">Manifest ${esc(t.number)} → ${esc(t.destHub)} (${t.bags} bag${t.bags === 1 ? "" : "s"})</button>`).join("");
    return `<section id="dfiTransferResult" style="margin:0 0 12px;display:grid;gap:8px"><h3 style="margin:0;font-size:15px">Bags${r.trips.length ? " and trips" : ""}</h3>${ui.table(["Bag", "Route", "Parcels", "Status", "Trip", ""], bags, "No bags.")}${trips ? `<div style="display:flex;gap:8px;flex-wrap:wrap">${trips}</div>` : ""}${r.problems.length ? `<div role="alert" style="color:#946200;font-size:13px">${r.problems.map(p => `<div>${esc(p)}</div>`).join("")}</div>` : ""}</section>`;
  }
  async function transferConfig() {
    const cfg = await Ops.bulkConfig("transfers");
    const [trips, vehicles] = await Promise.all([
      DF.api("/linehaul/trips?status=PLANNED&direction=outbound&limit=100").then(p => p.items.filter(t => canAct(t.originHub.id))).catch(() => []),
      state.vehicles ? Promise.resolve(state.vehicles) : DF.api("/linehaul/vehicles?limit=200").then(p => p.items).catch(() => []),
    ]);
    Object.assign(topt, { trips, vehicles: vehicles.filter(v => v.active), trip: topt.trips.some(t => t.id === topt.trip) || topt.trip === "new" ? topt.trip : "" });
    if (!topt.vehicle && topt.vehicles[0]) topt.vehicle = topt.vehicles[0].id;
    return {
      ...cfg,
      bulkKind: "transfers",
      bulkAction: "transfer",
      applyExtra: () => transferOptionsHtml(),
      applyMount: () => mountTransferOptions(),
      applyBody: () => transferBody(),
      resultExtra: job => transferResultHtml(job),
      onDone: () => reloadAll(),
    };
  }
  async function openTransferBulk(history = false) {
    if (!Ops.require("dispatch", "transfer parcels in bulk")) return;
    try {
      const cfg = await transferConfig();
      if (history) window.DFImport.bulkHistory(cfg);
      else window.DFImport.bulk(cfg);
    } catch (error) {
      showToast(DF.describe(error));
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
      paint("bag");
      DF.scanner?.feedback?.("lhScanParcel", result.added);
      return;
    } catch (error) {
      state.last = DF.describe(error);
      showToast(state.last);
    }
    paint("bag");
    DF.scanner?.feedback?.("lhScanParcel", false);
  }

  async function loadBag(code, source = "KEYBOARD") {
    const t = state.trip;
    if (!t || !code) return;
    try {
      state.trip = await DF.api(`/linehaul/trips/${t.id}/bags`, { method: "POST", body: { bag: code, source } });
      showToast(`${String(code).toUpperCase()} loaded on ${t.number}.`);
      void loadList("bags");
      paint("trip");
      DF.scanner?.feedback?.("lhLoadBag", true);
      return;
    } catch (error) {
      showToast(DF.describe(error));
    }
    paint("trip");
    DF.scanner?.feedback?.("lhLoadBag", false);
  }

  async function tripAction(id, action, question) {
    if (question && !(await Ops.confirm(typeof question === "string" ? { message: question, confirm: "Continue" } : question))) return;
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

  /** The manifest (bags, parcels, totals, signatures) and the bag tag as PDFs in a new tab. */
  const printManifest = t => Ops.printPdf(`/documents/manifest/${t.id}`, { title: "Preparing the manifest…" });
  const printBagLabel = b => Ops.printPdf(`/documents/bag-label/${b.id}`, { title: "Preparing the bag tag…" });

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
          return void Ops.confirm({ title: `Reopen ${state.bag.number}?`, message: "The seal is broken and recorded; the bag must be sealed again before it travels.", confirm: "Break seal and reopen", danger: true }).then(ok => {
            if (!ok) return;
            DF.api(`/linehaul/bags/${state.bag.id}/reopen`, { method: "POST" })
              .then(bag => ((state.bag = bag), paint("bag"), loadList("bags"), showToast(`${bag.number} reopened.`)))
              .catch(error => showToast(DF.describe(error)));
          });
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
          return void tripAction(id, "depart", { title: "Dispatch this truck?", message: "Every parcel on the manifest goes in transit to the destination hub.", confirm: "Dispatch truck" });
        case "arrive":
          return void tripAction(id, "arrive");
        case "close":
          return void tripAction(id, "close", { title: "Close this trip?", message: "Parcels in bags that weren't received are recorded as missing.", confirm: "Close trip", danger: true });
        case "cancel-trip":
          return void tripAction(id, "cancel", { title: "Cancel this planned trip?", message: "Its bags stay sealed and can go on another trip.", confirm: "Cancel trip", cancel: "Keep it", danger: true });
        case "resolve":
          return resolveDialog(id);
        case "more":
          return void loadList(el.dataset.kind, true);
        case "receive-start":
          return void startReceive(el.dataset.number);
        case "recv-clear":
          Object.assign(state.recv, { trip: null, bag: null, last: null });
          return paint("receive");
        case "recv-finish":
          return void finishBag();
        case "recv-check": {
          const t = state.inbound.items.find(x => x.id === id);
          if (!t) return;
          Object.assign(state.recv, { trip: t, bag: null, hubId: t.destHub.id, last: { outcome: "TRIP", message: `Checking ${t.number}: scan its bags to receive them whole, or the parcels one by one.` } });
          paint("receive");
          return $("lhReceivePanel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
        case "bulk-transfer":
          return void openTransferBulk(false);
        case "transfer-history":
          return void openTransferBulk(true);
        case "print-bag-n":
          return void Ops.printPdf(`/documents/bag-label/${encodeURIComponent(el.dataset.number)}`, { title: "Preparing the bag tag…" });
        case "print-manifest-n":
          return void Ops.printPdf(`/documents/manifest/${encodeURIComponent(el.dataset.number)}`, { title: "Preparing the manifest…" });
      }
    },
    true,
  );

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
        lhRecvForm: () => {
          const input = $("lhRecvScan");
          const code = input.value.trim();
          input.value = "";
          return recvScan(code, "KEYBOARD");
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
    if (event.target.id === "lhRecvHub") {
      Object.assign(state.recv, { hubId: event.target.value, trip: null, bag: null, last: null });
      return paint("receive");
    }
    if (event.target.id === "lhInboundHub") {
      state.inbound.hubId = event.target.value;
      return void loadInbound();
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
