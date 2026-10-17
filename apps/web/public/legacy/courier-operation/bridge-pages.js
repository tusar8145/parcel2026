/*
 * Courier Operations on the API, part 2: the pages' counters, reports and forms.
 *
 * Each page keeps its original markup; Ops.prepare[page] puts real rows into the page's
 * data before it renders and Ops.enhance[page] replaces sample figures afterwards.
 *   Overview, Shipments, Exceptions, service lines  GET /ops/overview + the shipment register
 *   Dispatch & routes                               GET /ops/dispatch
 *   Riders & fleet (report, run sheets)             GET /ops/rider-report
 *   Hubs & zones (scan, receive, transfer, setup)   POST /parcels/:id/status, /hubs, GET /ops/transfers
 *   Merchant accounts                               GET /ops/merchants
 *   COD & finance                                   bridge-finance.js
 *   Analytics & SLA                                 GET /ops/analytics
 *   Admin settings                                  GET /catalog (managed in super admin)
 *   New shipment                                    POST /ops/parcels (Excel import: bridge-imports.js)
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  const $ = id => document.getElementById(id);
  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = Ops.esc;
  const setText = (el, text) => el && (el.textContent = text);
  const pct = v => (v == null ? "—" : `${v}%`);
  const CLOSED = ["Delivered", "Pickup cancelled", "Returned"];
  const longDate = () => new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const panelTitled = title => qa("#mainContent .panel").find(p => q(".panel-title", p)?.textContent === title);
  const setMetrics = items => {
    const box = q("#mainContent .metrics");
    if (box) box.innerHTML = items.map(m => metric(m[0], m[1], m[2], m[3], m[4])).join("");
  };
  const registerText = (subtitle, footer) => {
    setText(q("#mainContent .table-panel .panel-heading .panel-subtitle"), subtitle);
    const foot = q("#mainContent .table-panel > div:last-child");
    if (foot && /sample|demo/i.test(foot.textContent)) foot.textContent = footer;
  };
  const refreshButton = (toastText, done) =>
    window.addEventListener(
      "click",
      event => {
        if (!event.target.closest(`[data-toast="${toastText}"]`)) return;
        event.stopImmediatePropagation();
        Ops.invalidate("dispatch");
        Ops.refresh()
          .then(() => showToast(done))
          .catch(error => showToast(DF.describe(error)));
      },
      true,
    );

  // ───────────── live overview ─────────────

  /** The illustrated map stays decorative; its caption shows the real rider count. */
  const mapTag = () => Ops.overview && setText(q("#mainContent .map-tag.tag-zone"), `Network · ${Ops.num(Ops.overview.riders.online)} riders on shift`);

  Ops.enhance.Overview = () => {
    const o = Ops.overview;
    if (!o) return;
    const s = o.shipments;
    setText(q("#mainContent .page-heading .eyebrow"), `${longDate()} · Network operations`);
    const change = s.createdYesterday ? Math.round(((s.createdToday - s.createdYesterday) / s.createdYesterday) * 1000) / 10 : null;
    const pts = o.onTime.monthRate != null && o.onTime.previousMonthRate != null ? Math.round((o.onTime.monthRate - o.onTime.previousMonthRate) * 10) / 10 : null;
    setMetrics([
      ["Shipments today", Ops.num(s.createdToday), "box", change == null ? `${Ops.num(s.createdYesterday)} yesterday` : `${change >= 0 ? "↑" : "↓"} ${Math.abs(change)}%`, change == null ? "booked today" : "vs. yesterday"],
      ["Out for delivery", Ops.num(s.outForDelivery), "truck", `${o.riders.withOpenTasks} riders active`, `across ${o.hubs.length} hubs`],
      ["On-time delivery", pct(o.onTime.monthRate), "clock", pts == null ? `${Ops.num(o.onTime.monthDelivered)} delivered` : `${pts >= 0 ? "↑" : "↓"} ${Math.abs(pts)} pts`, "this month"],
      ["Active riders", Ops.num(o.riders.online), "users", `of ${Ops.num(o.riders.total)} riders`, "on shift now"],
      ["Open exceptions", Ops.num(s.exceptions), "alert", `${Ops.num(s.atRisk)} SLA at risk`, "needs attention"],
    ]);
    const lines = [
      ["ecommerce", "active shipments"],
      ["documents", "active shipments"],
      ["customer", "active customer requests"],
    ];
    qa("#mainContent .service-card").forEach((card, i) => {
      const [key, label] = lines[i] || [];
      if (!key) return;
      setText(q(".service-card-bottom strong", card), Ops.num(o.serviceLines[key]));
      setText(q(".service-card-bottom div span", card), label);
    });
    const summary = qa("#mainContent .network-summary strong");
    [s.createdToday, s.deliveredToday, s.exceptions].forEach((v, i) => setText(summary[i], Ops.num(v)));
    setText(q("#mainContent .progress-label strong"), pct(o.onTime.monthRate));
    const fill = q("#mainContent .progress-fill");
    if (fill) fill.style.width = `${o.onTime.monthRate ?? 0}%`;
    const rows = qa("#mainContent .dispatch-row strong");
    [s.atHub + s.inTransit, s.deliveredToday, s.outForDelivery, s.exceptions].forEach((v, i) => setText(rows[i], Ops.num(v)));
    mapTag();

    const list = q("#mainContent .alert-list");
    if (list) {
      list.innerHTML =
        o.alerts
          .map(a => {
            const when = a.kind === "sla" ? `due ${Ops.when(a.at)}` : a.kind === "cod" ? Ops.ago(a.at) : a.at ? Ops.ago(a.at) : "";
            const text = a.text;
            const action = a.action.exception ? `data-exception="${esc(a.action.exception)}"` : `data-page-link="${esc(a.action.page)}"`;
            return `<div class="alert-item"><span class="alert-icon${a.tone === "red" ? " red" : ""}">${icon(a.icon)}</span><div class="alert-copy"><strong>${esc(a.title)}</strong>${esc(text)}<small>${esc([a.meta, when].filter(Boolean).join(" · "))}</small></div><button class="button button-sm alert-action" ${action}>${esc(a.action.label)}</button></div>`;
          })
          .join("") || `<div class="empty-state">No priority alerts right now.</div>`;
      setText(q(".panel-heading .status", list.closest(".panel")), `${o.alerts.length} open`);
    }
  };
  refreshButton("Live network view refreshed.", "Live network view refreshed.");

  // ───────────── shipments, exceptions, service lines ─────────────

  Ops.enhance.Shipments = () => {
    const s = Ops.overview?.shipments;
    if (s) qa("#mainContent .stats-mini .mini-card strong").forEach((el, i) => setText(el, Ops.num([s.inTransit + s.outForDelivery, s.atHub, s.exceptions][i])));
    setText(q("#mainContent .table-panel .panel-subtitle"), "Live register · newest active parcels and the last 7 days · search and filters reach every parcel");
    setText(q("#mainContent .shipment-count"), `Showing ${Ops.num(shipments.length)} shipments · updates live`);
    Ops.pagingFooter?.();
  };

  Ops.enhance.Exceptions = () => {
    const s = Ops.overview?.shipments;
    if (s) qa("#mainContent .stats-mini .mini-card strong").forEach((el, i) => setText(el, Ops.num([s.exceptions, s.atRisk, s.unassigned][i])));
  };

  function enhanceServiceLine(page) {
    const category = page === "Customer parcels" ? "Customer parcels" : page === "E-commerce operations" ? "E-commerce" : "Documents";
    const data = shipments.filter(s => serviceCategory(s) === category);
    const open = data.filter(s => !CLOSED.includes(s.status));
    setMetrics([
      ["Active shipments", Ops.num(open.length), "box", "this service line", "open now"],
      ["In progress", Ops.num(open.filter(s => s.status !== "Exception").length), "truck", "pending confirmation or delivery", "active"],
      ["Delivered", Ops.num(data.filter(s => s.status === "Delivered").length), "check", "completed stops", "last 7 days"],
      ["Needs attention", Ops.num(open.filter(s => s.status === "Exception" || s.sla === "At risk" || s.rider === "Unassigned").length), "alert", "unassigned, SLA, or exception", "operations queue"],
    ]);
    setText(q("#mainContent .table-panel .panel-subtitle"), "Dedicated queue · live data from the shared fleet, hubs and tracking platform");
    const label = category === "Customer parcels" ? "customer parcels" : `${category.toLowerCase()} shipments`;
    setText(q("#mainContent .shipment-count"), `Showing ${Ops.num(data.length)} ${label} · newest active and the last 7 days`);
    Ops.pagingFooter?.();
  }
  for (const page of ["Customer parcels", "E-commerce operations", "Banking & Financial operations"]) Ops.enhance[page] = enhanceServiceLine;

  // ───────────── dispatch & routes ─────────────

  const loadDispatch = () => (Ops.can("readRiders") ? Ops.lazy("dispatch", () => DF.api("/ops/dispatch"), 20000) : null);
  const RANK = { "At risk": 0, "Assign now": 1, "Awaiting review": 2 };

  Ops.enhance.Dispatch = () => {
    mapTag();
    const d = loadDispatch();
    if (d) {
      setMetrics([
        ["Unassigned shipments", Ops.num(d.unassigned.total), "box", `${Ops.num(d.unassigned.urgent)} urgent`, d.unassigned.readyAtHub ? `${Ops.num(d.unassigned.readyAtHub)} ready at hub` : "pickup requests"],
        ["Riders available", Ops.num(d.riders.available), "users", `${Ops.num(d.riders.onShift)} on shift`, `of ${Ops.num(d.riders.total)} riders`],
        ["Routes active", Ops.num(d.routesActive), "route", `${Ops.num(d.routesNeedReview)} need review`, Ops.me?.hubIds ? "your hub" : "network wide"],
        ["Avg. stops / rider", String(d.avgStopsPerRoute), "truck", "assigned today", "per active route"],
      ]);
    } else setMetrics([["Unassigned shipments", Ops.num(Ops.overview?.shipments.unassigned), "box", "waiting for a rider", "network wide"]]);

    const queue = panelTitled("Assignment queue");
    if (queue) {
      const waiting = shipments
        .filter(s => s.rider === "Unassigned" && !CLOSED.includes(s.status) && (!s._api.currentHub || Ops.inMyHubs(s._api.currentHub.id)))
        // Pickup and Delivery (bridge-nav.js) each show their half of the queue.
        .filter(s => !Ops.dispatchQueueFilter || Ops.dispatchQueueFilter(s._api))
        .sort((a, b) => (RANK[a.sla] ?? 3) - (RANK[b.sla] ?? 3) || String(a._api.createdAt).localeCompare(String(b._api.createdAt)));
      const shown = waiting.slice(0, 8);
      const list = q(".alert-list", queue);
      if (list)
        list.innerHTML =
          shown
            .map(
              s =>
                `<div class="alert-item"><span class="alert-icon">${icon("box")}</span><div class="alert-copy"><strong>${esc(s.id)} · ${esc(s.service)}</strong>${esc(s.destination)}<small>${esc(`${s.merchant} · ${s.status}${s.hub ? ` · ${s.hub}` : ""} · ${s.created}`)}</small></div><button class="button button-sm alert-action" data-assign-shipment="${esc(s.id)}">Assign</button></div>`,
            )
            .join("") +
            (waiting.length > shown.length
              ? `<div class="alert-item"><span class="alert-icon">${icon("box")}</span><div class="alert-copy"><strong>${waiting.length - shown.length} additional shipments</strong>Awaiting rider allocation.<small>Oldest and most urgent are listed first</small></div><button class="button button-sm alert-action" data-action="assign">Assign</button></div>`
              : "") || `<div class="empty-state">Every shipment has a rider.</div>`;
      setText(q(".panel-heading .status", queue), `${Ops.num(waiting.length)} unassigned`);
    }

    const roster = q("tbody", panelTitled("Active route roster") || document.createElement("div"));
    if (roster) {
      const error = Ops.lazyError("dispatch");
      roster.innerHTML = !Ops.can("readRiders")
        ? `<tr><td colspan="6" class="empty-state">Rider workloads are available to dispatch staff.</td></tr>`
        : !d
          ? `<tr><td colspan="6" class="empty-state">${error ? esc(DF.describe(error)) : "Loading rider workloads…"}</td></tr>`
          : d.roster
              .map(
                r =>
                  `<tr><td>${esc(r.rider.label)}</td><td>${esc(r.rider.zone || r.rider.hub?.name || "—")}</td><td>${r.assignedToday}</td><td>${r.completed}</td><td>${r.remaining}</td><td>${statusPill(r.health)}</td></tr>`,
              )
              .join("") || `<tr><td colspan="6" class="empty-state">No riders at your hub yet.</td></tr>`;
    }
  };
  refreshButton("Route plan refreshed.", "Dispatch data refreshed. Rebalance by reassigning shipments to available riders.");

  // ───────────── riders & fleet ─────────────

  const riderStatusLabel = r => (!r.active ? "Inactive" : r.status === "ONLINE" ? (r.openDeliveries ? "On route" : "Available") : r.status === "ON_BREAK" ? "On break" : "Off shift");
  const VEHICLE = { MOTORBIKE: "Motorcycle", BICYCLE: "Bicycle", VAN: "Van", ON_FOOT: "On foot" };
  const reportKey = () => `riders:${riderReportState.from}|${riderReportState.to}`;
  const riderReport = () =>
    Ops.can("readRiders")
      ? Ops.lazy(reportKey(), () => DF.api(`/ops/rider-report?from=${riderReportState.from}&to=${riderReportState.to}`), 30000)
      : null;

  Ops.prepare.Riders = () => {
    const report = riderReport();
    genericPages.Riders.rows = (report?.riders || []).map(r => [
      `${r.code} · ${r.name}`,
      r.zone || r.hub?.name || "—",
      VEHICLE[r.vehicle] || r.vehicle,
      "—",
      String(r.openDeliveries),
      "—",
      riderStatusLabel(r),
    ]);
  };

  // The report, run sheets and export read the API's report for the chosen dates.
  riderReportData = function () {
    const report = Ops.cache[reportKey()]?.value;
    const rows = (report?.riders || []).map(r => ({
      id: r.code,
      name: r.name,
      zone: r.zone || r.hub?.name || "—",
      status: `${riderStatusLabel(r)}${r.hub ? ` · ${r.hub.name}` : ""}`,
      picked: r.picked,
      counts: r.counts,
      records: r.records.map(p => ({ id: p.trackingId, merchant: p.merchant, recipient: p.recipient, destination: p.destination, service: p.service, status: p.status, pickedUpAt: p.pickedUpAt, codAmount: p.codAmount })),
    }));
    return riderReportState.rider ? rows.filter(r => r.id === riderReportState.rider) : rows;
  };

  printRiderRunSheet = function (riderId) {
    const rider = riderReportData().find(r => r.id === riderId);
    if (!rider) return void showToast("This rider is not available in the report.");
    if (!rider.records.length) return void showToast("No assigned shipments are available for this rider and date range.");
    const popup = window.open("", "_blank");
    if (!popup) return void showToast("Allow pop-ups to open the rider run sheet.");
    const cod = rider.records.reduce((n, p) => n + (p.status === "Delivered" ? 0 : Number(p.codAmount) || 0), 0);
    const rows = rider.records
      .map(
        s =>
          `<tr><td>${esc(s.id)}</td><td>${esc(s.merchant || "—")}</td><td>${esc(s.recipient || "—")}</td><td>${esc(s.destination || "—")}</td><td>${esc(s.service || "—")}</td><td>${Number(s.codAmount) ? `৳ ${Number(s.codAmount).toLocaleString("en-BD")}` : "Prepaid"}</td><td>${esc(s.status)}</td></tr>`,
      )
      .join("");
    const range = `${riderReportState.from}${riderReportState.to !== riderReportState.from ? ` to ${riderReportState.to}` : ""}`;
    popup.document.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>Run sheet · ${esc(riderId)}</title><style>@page{size:A4 landscape;margin:12mm}body{font:12px Arial,sans-serif;color:#182230}h1{margin:0 0 6px}p{color:#647184;margin:4px 0 16px}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #dfe4eb;padding:8px;text-align:left}th{background:#f5f7fa;font-size:10px}.sign{display:flex;justify-content:space-between;margin-top:38px}.sign span{border-top:1px solid #687384;padding-top:6px;width:40%}@media print{body{print-color-adjust:exact;-webkit-print-color-adjust:exact}}</style></head><body><h1>Delivery Fast · Rider run sheet</h1><p>Rider: ${esc(riderId)} · ${esc(rider.name)} &nbsp; | &nbsp; Zone: ${esc(rider.zone)} &nbsp; | &nbsp; Date: ${esc(range)} &nbsp; | &nbsp; Shipments: ${rider.records.length} &nbsp; | &nbsp; COD to collect: ৳ ${cod.toLocaleString("en-BD")}</p><table><thead><tr><th>PARCEL / ORDER / SHIPMENT</th><th>SENDER / MERCHANT</th><th>RECIPIENT</th><th>DESTINATION</th><th>SERVICE</th><th>COD</th><th>STATUS</th></tr></thead><tbody>${rows}</tbody></table><div class="sign"><span>Rider signature</span><span>Dispatch handover</span></div><script>window.onload=()=>window.print();window.onafterprint=()=>window.close()<\/script></body></html>`,
    );
    popup.document.close();
  };

  Ops.enhance.Riders = () => {
    const error = Ops.lazyError(reportKey());
    if (!Ops.can("readRiders") || error) {
      const body = q("#mainContent tbody");
      if (body) body.innerHTML = `<tr><td colspan="5" class="empty-state">${Ops.can("readRiders") ? esc(DF.describe(error)) : "Rider reports are available to operations and support staff."}</td></tr>`;
    }
  };

  // ───────────── hubs & zones ─────────────

  const transfersRange = () => `from=${Ops.dayKey(new Date(Date.now() - 89 * 86400000))}&to=${Ops.dayKey()}`;
  /** API instant → local "YYYY-MM-DDTHH:mm:ss" so the page's date filter compares local days. */
  const localStamp = iso => {
    const d = new Date(iso);
    return `${Ops.dayKey(iso)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  };
  let hubFeedback = null;
  let refocusScan = false;

  Ops.prepare.Hubs = () => {
    hubList.splice(0, hubList.length, ...DF.state.hubs.map(h => h.name));
    const catalog = Ops.catalog;
    if (catalog) zoneList.splice(0, zoneList.length, ...catalog.districts.map(d => `${d}${catalog.zonesByDistrict[d]?.length ? ` (${catalog.zonesByDistrict[d].join(", ")})` : ""}`));
    routeList.splice(0, routeList.length, "Planned per rider in Dispatch & routes");
    const transfers = Ops.lazy("transfers", () => DF.api(`/ops/transfers?${transfersRange()}`), 30000) || [];
    hubTransferEvents.splice(
      0,
      hubTransferEvents.length,
      ...transfers.map(t => ({ trackingId: t.trackingId, fromHub: t.fromHub, toHub: t.toHub, date: localStamp(t.at), rider: t.rider || t.by || "—", status: t.status })),
    );
  };

  // Hub operators see the parcels held at (or heading to) their own hub.
  const baseHubPage = hubOperationsPage;
  hubOperationsPage = function () {
    const hubs = Ops.me?.hubIds;
    if (!hubs) return baseHubPage();
    const all = shipments.splice(0, shipments.length);
    shipments.push(...all.filter(s => s._api && s._api.currentHub && hubs.includes(s._api.currentHub.id)));
    try {
      return baseHubPage();
    } finally {
      shipments.splice(0, shipments.length, ...all);
    }
  };

  Ops.enhance.Hubs = () => {
    const mine = Ops.myHubs();
    if (mine?.length) {
      const options = mine.map(h => `<option>${esc(h.name)}</option>`).join("");
      for (const select of [$("hubScanLocation"), q('#hubReceiveForm select[name="hub"]')]) if (select) select.innerHTML = options;
    }
    if (hubFeedback) setText($("hubScanFeedback"), hubFeedback);
    if (refocusScan) {
      refocusScan = false;
      $("hubScanId")?.focus();
    }
  };

  /** A parcel by tracking ID: from the register, else from the API (staff see every parcel). */
  async function findParcel(id) {
    if (!id) return null;
    const known = Ops.apiParcel(id);
    if (known) return known;
    try {
      const parcel = await DF.api(`/parcels/${encodeURIComponent(id)}`);
      Ops.extra.set(parcel.trackingId, parcel);
      return parcel;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }
  const lineOf = p => (!p.merchant ? "Customer parcels" : p.merchant.type === "BANKING_FINANCIAL" ? "Documents" : "E-commerce");
  const onHubsPage = () => !!q('[data-page="Hubs"].active');

  async function hubScan() {
    const id = $("hubScanId").value.trim().toUpperCase();
    const eventName = $("hubScanEvent").value;
    const hub = Ops.hubByName($("hubScanLocation").value);
    const feedback = text => {
      hubFeedback = text;
      setText($("hubScanFeedback"), text);
    };
    const parcel = await findParcel(id);
    if (!parcel) return feedback(`No shipment found for ${id || "that barcode"}.`);
    if (!Ops.require("dispatch", "record hub scans")) return;
    if (!hub) return feedback("Choose the hub where you are scanning.");
    // Every scan is recorded for scan compliance (camera or keyboard / USB scanner).
    const SCAN_KIND = { "Received at hub": "HUB_RECEIVE", "Returned to hub": "HUB_RETURN", "Ready for dispatch": "HUB_SORT", "Out for delivery": "HUB_DISPATCH" };
    // Drop-off receipts record their scan with the status change (POST /ops/hub-receive).
    if (SCAN_KIND[eventName] && !(Ops.awaitingDropOff?.(parcel) && SCAN_KIND[eventName] !== "HUB_DISPATCH")) Ops.recordScan?.(parcel.trackingId, SCAN_KIND[eventName], hub.id, Ops.scanSource || "KEYBOARD");
    const scanSource = Ops.scanSource;
    Ops.scanSource = "KEYBOARD";
    const atThisHub = parcel.status === "AT_HUB" && parcel.currentHub?.id === hub.id;
    if (Ops.awaitingDropOff?.(parcel) && /^(Received at hub|Ready for dispatch)$/.test(eventName)) {
      refocusScan = true;
      return receiveDropOff(parcel, hub, scanSource || "KEYBOARD").then(feedback);
    }
    const done = text => () => {
      feedback(text);
      refocusScan = true;
      return text;
    };
    switch (eventName) {
      case "Received at hub":
      case "Returned to hub":
        if (atThisHub) return feedback(`${id} is already at ${hub.name}.`);
        return Ops.setStatus(id, { status: "AT_HUB", hubId: hub.id, note: eventName === "Returned to hub" ? "Returned to hub (hub scan)" : undefined }, done(`${id}: ${eventName.toLowerCase()} at ${hub.name}.`));
      case "Ready for dispatch":
        if (atThisHub) return Ops.act(DF.api(`/parcels/${encodeURIComponent(id)}/notes`, { method: "POST", body: { note: `Sorted and ready for dispatch at ${hub.name}` } }), done(`${id}: ready for dispatch at ${hub.name}.`));
        return Ops.setStatus(id, { status: "AT_HUB", hubId: hub.id, note: "Sorted and ready for dispatch" }, done(`${id}: received and ready for dispatch at ${hub.name}.`));
      case "Out for delivery":
        return Ops.setStatus(id, { status: "OUT_FOR_DELIVERY" }, done(`${id}: out for delivery with ${parcel.deliveryRider?.label || "its rider"}.`));
      case "Failed delivery":
        return Ops.setStatus(id, { status: "EXCEPTION", note: `Failed delivery reported at ${hub.name}` }, done(`${id}: failed delivery sent to the exception queue.`));
      case "Delivered":
        return feedback("Only the delivering rider can confirm delivery, with the recipient's code, signature or photo.");
    }
  }

  /** Receives a drop-off at its declared hub; returns the text to show. */
  async function receiveDropOff(parcel, hub, source = "KEYBOARD") {
    const result = await DF.api("/ops/hub-receive", { method: "POST", body: { code: parcel.trackingId, hubId: hub.id, source } });
    await Ops.refresh().catch(() => undefined);
    return result.message;
  }

  async function hubReceive(form) {
    const f = new FormData(form);
    const id = String(f.get("tracking")).trim().toUpperCase();
    const hub = Ops.hubByName(f.get("hub"));
    const line = String(f.get("line"));
    const parcel = await findParcel(id);
    if (!parcel) return showToast(`${id} isn't booked yet. Book it under ${line === "Customer parcels" ? "the website" : `${line} operations`} first, then receive it here.`);
    if (!Ops.require("dispatch", "receive parcels")) return;
    if (!hub) return showToast("Choose the receiving hub.");
    const mismatches = [];
    if (lineOf(parcel) !== line) mismatches.push(`service line is ${lineOf(parcel)}`);
    const sender = String(f.get("sender")).trim().toLowerCase();
    if (sender && ![parcel.merchant?.name, parcel.sender.name].some(n => n && n.toLowerCase().includes(sender))) mismatches.push(`sender is ${parcel.merchant?.name || parcel.sender.name}`);
    const recipient = String(f.get("recipient")).trim().toLowerCase();
    if (recipient && !(parcel.recipient.name || "").toLowerCase().includes(recipient)) mismatches.push(`recipient is ${parcel.recipient.name}`);
    if (mismatches.length && !confirm(`Check the label of ${id}: its ${mismatches.join(" and ")}. Receive it anyway?`)) return;
    if (Ops.awaitingDropOff?.(parcel)) return showToast(await receiveDropOff(parcel, hub, "MANUAL"));
    Ops.recordScan?.(parcel.trackingId, "HUB_RECEIVE", hub.id);
    if (parcel.status === "AT_HUB" && parcel.currentHub?.id === hub.id) return showToast(`${id} is already at ${hub.name}.`);
    await Ops.setStatus(id, { status: "AT_HUB", hubId: hub.id }, `${id} received at ${hub.name}.`);
  }

  async function hubTransfer(form) {
    const f = new FormData(form);
    const id = String(f.get("tracking")).trim().toUpperCase();
    const to = Ops.hubByName(f.get("hub"));
    const parcel = await findParcel(id);
    if (!parcel) return showToast(`No shipment found for ${id}.`);
    if (!Ops.require("dispatch", "transfer parcels")) return;
    if (!to) return showToast("Choose the destination hub.");
    if (parcel.currentHub?.id === to.id) return showToast("Choose a different destination hub to record a transfer.");
    const from = parcel.currentHub?.name || "Origin hub not recorded";
    Ops.recordScan?.(parcel.trackingId, "HUB_DISPATCH", parcel.currentHub?.id);
    Ops.invalidate("transfers");
    await Ops.setStatus(id, { status: "IN_TRANSIT", hubId: to.id }, `${id} transfer from ${from} to ${to.name} recorded.`);
  }

  async function addToNetwork(form) {
    const f = new FormData(form);
    const kind = String(f.get("kind"));
    const name = String(f.get("name")).trim();
    // Zones and routes are real configuration (bridge-network.js dialogs, /zones and /routes).
    if (kind === "zone" || kind === "route") return void openModal(kind === "zone" ? "zoneConfig" : "routeConfig", name);
    // Hubs: the dialog in bridge-network.js (district → zone, address).
    openModal("hubCreate", name);
  }

  window.addEventListener(
    "submit",
    event => {
      const form = event.target;
      const handlers = { hubScanForm: hubScan, hubReceiveForm: hubReceive, hubTransferForm: hubTransfer, hubConfigForm: addToNetwork };
      if (!onHubsPage() || !handlers[form.id]) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      Promise.resolve(handlers[form.id](form)).catch(error => showToast(DF.describe(error)));
    },
    true,
  );

  window.addEventListener(
    "click",
    event => {
      if (!onHubsPage()) return;
      const lookup = event.target.closest("[data-hub-lookup]");
      if (lookup) {
        event.stopImmediatePropagation();
        const id = $("hubScanId").value.trim().toUpperCase();
        findParcel(id)
          .then(p => {
            if (p) Ops.recordScan?.(p.trackingId, "HUB_LOOKUP", Ops.hubByName($("hubScanLocation")?.value)?.id, Ops.scanSource || "KEYBOARD");
            hubFeedback = p
              ? `${p.trackingId} · ${p.statusLabel} · ${p.currentHub?.name || "Not at a hub"} · Rider: ${p.deliveryRider?.label || p.pickupRider?.label || "Unassigned"} · ${p.recipient.name}, ${p.delivery.zone}`
              : `No shipment found for ${id || "that barcode"}.`;
            setText($("hubScanFeedback"), hubFeedback);
          })
          .catch(error => showToast(DF.describe(error)));
        return;
      }
      const assign = event.target.closest("[data-hub-assign]");
      if (assign) {
        event.stopImmediatePropagation();
        openModal("assign", assign.dataset.hubAssign);
      }
    },
    true,
  );

  window.addEventListener(
    "change",
    event => {
      const select = event.target.closest?.("[data-hub-status]");
      if (!select || !Ops.apiParcel(select.dataset.hubStatus)) return;
      event.stopImmediatePropagation();
      Ops.changeStatus(select.dataset.hubStatus, select.value, select);
    },
    true,
  );

  // ───────────── merchant accounts ─────────────

  const MERCHANT_STATUS = { ACTIVE: "Active", PENDING_REVIEW: "Review", SUSPENDED: "Suspended" };
  const loadMerchants = () => Ops.lazy("merchants", () => DF.api("/ops/merchants"), 60000);
  Ops.prepare.Merchants = () => {
    // Service packages replaced service plans: the column shows the package each merchant books with.
    genericPages.Merchants.cols[2] = "PACKAGE";
    genericPages.Merchants.rows = (loadMerchants() || []).map(m => [
      `${m.name} · ${m.type === "BANKING_FINANCIAL" ? "Banking & Financial" : "E-commerce"}`,
      m.code,
      m.package ? `${m.package.name}${m.package.isDefault ? " (default)" : ""}` : "Default package",
      Ops.num(m.parcelsThisMonth),
      "On approved settlement",
      m.contactName,
      MERCHANT_STATUS[m.status] || m.status,
    ]);
  };
  Ops.enhance.Merchants = () => {
    const rows = genericPages.Merchants.rows.length;
    const error = Ops.lazyError("merchants");
    registerText(error ? DF.describe(error) : "Live accounts · shipments booked this month", `Showing ${rows} merchant account${rows === 1 ? "" : "s"}`);
  };

  // COD & finance: see bridge-finance.js (finance, support and partner-applications area).

  // ───────────── analytics & SLA ─────────────

  const loadAnalytics = () => Ops.lazy("analytics", () => DF.api("/ops/analytics"), 60000);
  Ops.prepare.Analytics = () => {
    const a = loadAnalytics();
    const fmt = (v, unit) => (v == null ? "—" : unit === "%" ? `${v}%` : `${v} hrs`);
    genericPages.Analytics.rows = (a?.rows || []).map(r => {
      const delta = r.month != null && r.previousMonth != null ? Math.round((r.month - r.previousMonth) * 10) / 10 : null;
      const trend = delta == null ? "—" : `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(delta)} ${r.unit === "%" ? "pts" : "hrs"}`;
      const value = r.month ?? r.today;
      const ok = value != null && (r.better === "higher" ? value >= r.target : value <= r.target);
      const close = value != null && (r.better === "higher" ? value >= r.target * 0.95 : value <= r.target * 1.25);
      return [r.label, `${r.better === "higher" ? "≥" : "≤"} ${r.target}${r.unit === "%" ? "%" : " hrs"}`, fmt(r.today, r.unit), fmt(r.month, r.unit), fmt(r.previousMonth, r.unit), trend, value == null ? "No data" : ok ? "Healthy" : close ? "Monitor" : "At risk"];
    });
  };
  Ops.enhance.Analytics = () => {
    const a = Ops.cache.analytics?.value;
    const error = Ops.lazyError("analytics");
    registerText(error ? DF.describe(error) : "Live service levels · this month compared with last month", a ? `Based on ${Ops.num(a.samples.month.delivered)} deliveries and ${Ops.num(a.samples.month.pickups)} pickups this month` : "Loading service levels…");
  };

  // ───────────── admin settings ─────────────

  Ops.prepare.Settings = () => {
    const c = Ops.catalog;
    if (!c) return void (genericPages.Settings.rows = []);
    const zones = Object.values(c.zonesByDistrict).flat().length;
    const card = c.customerRateCard || {};
    genericPages.Settings.rows = [
      ["Delivery service levels", Object.values(c.serviceLevels || {}).join(" · "), "Network wide", "—", "Operations", "Manage"],
      ["Service zones", c.districts.join(" · "), `${c.districts.length} districts · ${zones} zones`, "—", "Network admin", "Manage"],
      ["COD settlement policy", `COD fee ${card.codFeePercent ?? "—"}% · payout on approved settlement`, "Service packages", "—", "Finance", "Manage"],
      ["Hubs", `${DF.state.hubs.length} active hubs`, DF.state.hubs.map(h => h.district).filter((d, i, all) => all.indexOf(d) === i).join(" · "), "—", "Operations", "Manage"],
      ["Admin roles", "Super admin · Operations manager · Hub operator · Finance · Support", "Role-based access", "—", "IT admin", "Manage"],
      ["Notifications & webhooks", "SMS · Signed merchant webhooks", "All services", "—", "IT admin", "Manage"],
    ];
  };
  Ops.enhance.Settings = () => registerText("Current configuration · managed by super admins", `Showing ${genericPages.Settings.rows.length} configuration areas`);
  window.addEventListener(
    "click",
    event => {
      const manage = event.target.closest("#genericBody [data-toast]");
      if (!manage || Ops.page() !== "Settings") return;
      event.stopImmediatePropagation();
      if (DF.auth.hasRole("SUPER_ADMIN")) location.href = "/super-admin";
      else showToast("These settings are managed by super admins in the admin console.");
    },
    true,
  );

  // ───────────── bookings by operations ─────────────

  const BOOKING_KINDS = { newShipment: "", newEcommerce: "E-commerce", newDomestic: "Documents", newDocument: "Documents" };
  const merchantsFor = line =>
    (Ops.cache.merchants?.value || []).filter(m => m.status === "ACTIVE" && (!line || (line === "Documents") === (m.type === "BANKING_FINANCIAL")));

  function fillZones() {
    const c = Ops.catalog;
    const district = $("bkDistrict")?.value;
    if (!c || !$("bkZone")) return;
    $("bkZone").innerHTML = (c.zonesByDistrict[district] || []).map(z => `<option>${esc(z)}</option>`).join("");
  }
  function fillMerchants() {
    const line = $("bkLine")?.value || modalContext.line;
    const select = $("bkMerchant");
    if (!select) return;
    const list = merchantsFor(line);
    select.innerHTML = list.length ? list.map(m => `<option value="${m.id}">${esc(`${m.name} · ${m.code}`)}</option>`).join("") : `<option value="">${Ops.cache.merchants ? "No active merchants for this service line" : "Loading merchants…"}</option>`;
    const cod = $("bkCod");
    if (cod) {
      cod.disabled = line === "Documents";
      if (line === "Documents") cod.value = "0";
    }
  }

  async function openBooking(kind) {
    if (!Ops.require("dispatch", "book shipments")) return;
    const fixed = BOOKING_KINDS[kind];
    const c = Ops.catalog;
    modalContext = { kind: "booking", line: fixed || "E-commerce" };
    $("modalTitle").textContent = fixed === "Documents" ? "Create document shipment" : fixed ? "Create e-commerce shipment" : "Create shipment";
    $("modalDescription").textContent = "Books the parcel for a merchant: picked up by a rider from the merchant's registered address, or dropped off at a hub by the merchant. The price comes from the merchant's service package either way.";
    $("modalSubmit").textContent = "Book shipment";
    const levels = Object.entries(c?.serviceLevels || { REGULAR: "Regular", SAME_DAY: "Same day", EXPRESS: "Express" });
    $("modalFields").innerHTML = `${fixed ? "" : `<div class="field"><label for="bkLine">Service line</label><select id="bkLine"><option>E-commerce</option><option>Documents</option></select></div>`}<div class="field ${fixed ? "full" : ""}"><label for="bkMerchant">Merchant / account</label><select id="bkMerchant" required></select></div><div class="field"><label for="bkRecipient">Recipient name</label><input id="bkRecipient" required maxlength="120" placeholder="Recipient name"></div><div class="field"><label for="bkPhone">Recipient phone</label><input id="bkPhone" required inputmode="tel" placeholder="01XXXXXXXXX"></div><div class="field"><label for="bkDistrict">District</label><select id="bkDistrict">${(c?.districts || []).map(d => `<option>${esc(d)}</option>`).join("")}</select></div><div class="field"><label for="bkZone">Zone</label><select id="bkZone"></select></div><div class="field full"><label for="bkStreet">Street address</label><input id="bkStreet" required maxlength="200" placeholder="House, road, flat"></div><div class="field"><label for="bkArea">Area / landmark (optional)</label><input id="bkArea" maxlength="120"></div><div class="field"><label for="bkLevel">Service level</label><select id="bkLevel">${levels.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select></div><div class="field"><label for="bkWeight">Weight (kg)</label><input id="bkWeight" type="number" min="0.1" max="50" step="0.1" value="1" required></div><div class="field"><label for="bkCod">COD amount (৳)</label><input id="bkCod" type="number" min="0" step="1" value="0"></div><div class="field"><label for="bkContents">${fixed === "Documents" ? "Document type" : "Contents"}</label><input id="bkContents" maxlength="120" placeholder="${fixed === "Documents" ? "e.g. Contract" : "e.g. Clothing"}"></div><div class="field"><label for="bkRef">Order reference (optional)</label><input id="bkRef" maxlength="80"></div><div class="field"><label for="bkCn">Pre-printed CN (optional)</label><input id="bkCn" maxlength="24" autocomplete="off" placeholder="Label from CN stock"></div>${Ops.intake ? Ops.intake.fields("bk") : ""}<div id="bkServices" style="display:contents"></div><div class="field full" id="bkPrice" aria-live="polite" style="font-size:13px;color:#637083"></div>`;
    Ops.intake?.wire("bk");
    DF.scanner?.attach($("bkCn"), { title: "Scan the CN label" });
    $("bkDistrict")?.addEventListener("change", fillZones);
    $("bkLine")?.addEventListener("change", fillMerchants);
    fillZones();
    fillMerchants();
    void loadBookingPackage();
    $("modalBackdrop").classList.add("open");
    if (!Ops.cache.merchants?.value) {
      try {
        Ops.cache.merchants = { value: await DF.api("/ops/merchants"), at: Date.now(), loading: false };
      } catch (error) {
        showToast(DF.describe(error));
      }
      fillMerchants();
      void loadBookingPackage();
    }
  }
  for (const kind of Object.keys(BOOKING_KINDS)) Ops.modals[kind] = () => openBooking(kind);

  // ───────────── the merchant's service package on the booking form (shared/order-services.js) ─────────────
  let bookingPkg = null;
  async function loadBookingPackage() {
    const merchantId = $("bkMerchant")?.value;
    const box = $("bkServices");
    if (!box || !window.DFOrderServices) return;
    bookingPkg = null;
    box.innerHTML = "";
    if (!merchantId) return;
    try {
      const view = await window.DFOrderServices.load(`/packages/effective?merchantId=${encodeURIComponent(merchantId)}`);
      if ($("bkMerchant")?.value !== merchantId) return;
      bookingPkg = view;
      box.innerHTML = window.DFOrderServices.block(view, { prefix: "bkSvc", firstMile: false, product: true });
      // The package choices make the form taller than small screens: the modal scrolls.
      const modal = box.closest(".modal");
      if (modal) Object.assign(modal.style, { maxHeight: "calc(100vh - 40px)", overflowY: "auto" });
      // COD only when the package offers it; the service level follows the Service choice.
      const cod = $("bkCod");
      if (cod && !view.options.cod) cod.value = "0";
      if (cod) cod.closest(".field").hidden = !view.options.cod;
      const level = $("bkLevel")?.closest(".field");
      if (level) level.hidden = true;
      window.DFOrderServices.sync("bkSvc");
      bookingQuote();
    } catch (error) {
      showToast(DF.describe(error));
    }
  }
  let bookingQuoteTimer = null;
  function bookingQuote() {
    clearTimeout(bookingQuoteTimer);
    bookingQuoteTimer = setTimeout(async () => {
      const out = $("bkPrice");
      if (!out || !bookingPkg || !$("bkZone")?.value) return;
      const merchant = (Ops.cache.merchants?.value || []).find(m => m.id === $("bkMerchant").value);
      const svc = window.DFOrderServices.read(bookingPkg, "bkSvc");
      let intake = { intake: "PICKUP" };
      try {
        intake = Ops.intake ? Ops.intake.read("bk") : intake;
      } catch {}
      try {
        const quote = await DF.api("/packages/quote", {
          method: "POST",
          body: {
            merchantId: $("bkMerchant").value,
            pickupDistrict: merchant?.pickupDistrict || $("bkDistrict").value,
            pickupZone: merchant?.pickupZone || merchant?.pickupArea || $("bkZone").value,
            deliveryDistrict: $("bkDistrict").value,
            deliveryZone: $("bkZone").value,
            weightKg: Number($("bkWeight").value) || 1,
            codAmount: bookingPkg.options.cod && svc.cod ? Number($("bkCod").value) || 0 : 0,
            ...(intake.intake === "DROP_OFF" && intake.dropOffHubId ? { dropOffHubId: intake.dropOffHubId } : svc.firstMile ? { firstMile: svc.firstMile } : {}),
            lastMile: svc.lastMile,
            ...(svc.collectHubId ? { collectHubId: svc.collectHubId } : {}),
            speed: svc.speed,
            openBox: svc.openBox,
          },
        });
        out.innerHTML = window.DFOrderServices.breakdown(quote);
      } catch (error) {
        out.textContent = DF.describe(error);
      }
    }, 300);
  }
  window.addEventListener("change", event => {
    if (modalContext.kind !== "booking" || !event.target.closest?.("#modalFields")) return;
    if (event.target.id === "bkMerchant" || event.target.id === "bkLine") return void setTimeout(loadBookingPackage);
    window.DFOrderServices?.sync("bkSvc");
    bookingQuote();
  });
  window.addEventListener("input", event => {
    if (modalContext.kind === "booking" && event.target.closest?.("#modalFields")) bookingQuote();
  });

  window.addEventListener(
    "submit",
    event => {
      if (event.target.id !== "modalForm" || modalContext.kind !== "booking") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const line = $("bkLine")?.value || modalContext.line;
      const merchantId = $("bkMerchant").value;
      if (!merchantId) return void showToast("Choose the merchant account.");
      const area = $("bkArea").value.trim();
      let intake;
      try {
        intake = Ops.intake ? Ops.intake.read("bk") : { intake: "PICKUP" };
      } catch (error) {
        return void showToast(error.message);
      }
      const body = {
        merchantId,
        intake: intake.intake,
        dropOffHubId: intake.dropOffHubId,
        recipient: { name: $("bkRecipient").value.trim(), phone: $("bkPhone").value.trim() },
        delivery: { category: "HOME", street: $("bkStreet").value.trim(), area: area || undefined, zone: $("bkZone").value, district: $("bkDistrict").value },
        type: line === "Documents" ? "DOCUMENT" : "ECOMMERCE",
        serviceLevel: $("bkLevel").value,
        weightKg: Number($("bkWeight").value),
        codAmount: line === "Documents" ? 0 : Number($("bkCod").value) || 0,
        // The merchant's service package choices (last mile, speed + handling, open box, product, messages).
        ...(bookingPkg ? bookingChoices(intake) : {}),
        contents: $("bkContents").value.trim() || undefined,
        merchantOrderRef: $("bkRef").value.trim() || undefined,
        cn: $("bkCn")?.value.trim().toUpperCase() || undefined,
      };
      const button = $("modalSubmit");
      button.disabled = true;
      DF.api("/ops/parcels", { method: "POST", body })
        .then(async parcel => {
          closeModal();
          await Ops.refresh().catch(() => undefined);
          render(line === "Documents" ? "Banking & Financial operations" : "E-commerce operations");
          if (parcel.intake === "DROP_OFF") {
            showToast(`${parcel.trackingId} booked for ${parcel.merchant?.name} · charge ৳${parcel.charges.total} · ${parcel.statusLabel.toLowerCase()}.`);
            Ops.labels?.open([parcel.trackingId], { title: "Print the label", description: `${parcel.trackingId} · stick the label on the parcel, then receive it at ${parcel.dropOffHub?.name || "the hub"}.` });
          } else showToast(`${parcel.trackingId} booked for ${parcel.merchant?.name} · charge ৳${parcel.charges.total}. Assign a pickup rider in Dispatch.`);
        })
        .catch(error => showToast(DF.describe(error)))
        .finally(() => (button.disabled = false));
    },
    true,
  );

  function bookingChoices(intake) {
    const { cod, firstMile, ...svc } = window.DFOrderServices.read(bookingPkg, "bkSvc");
    return { ...svc, ...(intake.intake !== "DROP_OFF" && firstMile ? { firstMile } : {}), ...(cod ? {} : { codAmount: 0 }) };
  }

  // Excel / CSV import: shared/importer.js (one import engine for merchants and operations), wired in bridge-imports.js.
})();
