/*
 * Courier Operations navigation, organised around the parcel journey (UI only).
 *
 * The menu (src/features/courier-operation/components/Sidebar.tsx, `data-nav`) opens views. A view
 * is one or more tabs, and each tab is an original page (its renderer, data, actions and
 * permissions unchanged) shown with a filter, a mode or a subset of its sections:
 *
 *   Today               Overview: a card per journey stage with its live count, one metrics row, the
 *                       map, the latest parcels and the priority alerts
 *   1 New orders        Shipments, only "Pending operations confirmation" (all lines), bulk Accept & assign
 *   2 Pickup            Dispatch: waiting for a pickup rider + being picked up · Scheduled pickups
 *   3 Hub desk          Hubs: Receive (the receive desk: any arrival, drop-offs, "Find") · At my hub
 *                       (parcels at the hub now, with their next action) · Collect from hub · End of day
 *   4 Transfers         Linehaul
 *   5 Delivery          Dispatch: waiting for a delivery rider + out with riders, map, route planner
 *   6 Problems          Exceptions page: Exceptions · Failed delivery · Needs info · SLA late-risk
 *   7 Returns           Returns
 *   8 COD & settlement  COD & finance
 *   All parcels         Shipments · E-commerce · Banking & Financial · Customer (the service-line pages)
 *   Reports             Reports · Analytics & SLA
 *   Riders · Merchants · CN stock · Settings (hubs, zones and routes are set up in Super admin › Hubs & zones)
 *
 * Parcel tables are server-paged lists (bridge-lists.js, about 100 rows a page): a tab's `list` names
 * its stage / service line; hub operators see "my hub" by default. A tab draws only its own sections.
 *
 * The page scripts keep using the original page names (render("Hubs"), Ops.page(), the hidden
 * #breadcrumbPage and #legacyNav buttons), so every old name still opens the right place:
 * render(oldName), ?page=<old or new name>[&tab=<tab>], alert and notification links. Stage counts
 * come from GET /ops/stage-counts (database counts for the scope on screen, reloaded after live
 * parcel events).
 * The menu shows what each role uses (the permissions themselves are unchanged).
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops) return;
  const $ = id => document.getElementById(id);
  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = Ops.esc;
  const show = (el, on) => el && (el.style.display = on ? "" : "none");

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="dfNavStyles">
#navigation [hidden]{display:none!important}
.df-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 13px}
.df-stage-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:11px;margin-bottom:13px}
.df-stage-grid .metric{cursor:pointer;min-height:92px}
.df-stage-grid .metric:hover,.df-stage-grid .metric:focus-visible{border-color:#b8c8ff;outline:none}
@media(max-width:1200px){.df-stage-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
@media(max-width:720px){.df-stage-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}}
</style>`,
  );

  // ───────────── journey stages ─────────────

  const JOURNEY = ["New orders", "Pickup", "Hub desk", "Transfers", "Delivery", "Problems", "Returns"];
  /** Each stage's number in GET /ops/stage-counts `stages`. */
  const STAGE_COUNT = { "New orders": "newOrders", Pickup: "pickup", "Hub desk": "hubDesk", Transfers: "transfers", Delivery: "delivery", Problems: "problems", Returns: "returns" };
  const STAGE_HINT = {
    "New orders": ["box", "Accept & assign rider"],
    Pickup: ["clock", "Riders collecting"],
    "Hub desk": ["pin", "At hubs · to receive or hand over"],
    Transfers: ["truck", "Between hubs"],
    Delivery: ["route", "With delivery riders"],
    Problems: ["alert", "Exceptions · failed · needs info"],
    Returns: ["box", "Going back to merchants"],
  };

  // ───────────── views ─────────────

  const VIEWS = {
    Today: { title: "Today", tabs: [{ id: "Today", page: "Overview" }] },
    "New orders": {
      stage: "New orders",
      subtitle: "Orders waiting for operations: accept and assign a pickup rider, switch to drop-off, or cancel the request.",
      tabs: [{ id: "New orders", page: "Shipments", list: { stage: "new" }, bulkAccept: true }],
      bulk: {}, // the New orders template (bridge-bulk.js) holds this page's parcels
      shipmentPage: true,
    },
    Pickup: {
      stage: "Pickup",
      tabs: [
        { id: "Assign pickup rider", page: "Dispatch", mode: "pickup" },
        { id: "Scheduled pickups", page: "Scheduled pickups" },
      ],
      bulk: {},
      subtitle: "Assign pickup riders to accepted orders and follow merchants' scheduled pickups.",
    },
    "Hub desk": {
      stage: "Hub desk",
      tabs: [
        { id: "At my hub", page: "Hubs", part: "athub" },
        // End-of-day reconciliation (bridge-desk.js): arrivals, dispatches and cash for a hub and a day.
        { id: "End of day", page: "Hubs", part: "eod" },
      ],
      bulk: {},
      subtitle: "Parcels at your hub with their next step, and the day's reconciliation. Scanning work is on Scan desk.",
    },
    // No bulk: transfers go through linehaul bags. One page (Linehaul), a tab per task (bridge-transfer-tabs.js).
    Transfers: {
      stage: "Transfers",
      tabs: [
        { id: "Send", page: "Linehaul", part: "send" },
        { id: "Receive", page: "Linehaul", part: "receive" },
        { id: "On the road", page: "Linehaul", part: "road" },
        { id: "Issues", page: "Linehaul", part: "issues" },
        { id: "Vehicles", page: "Linehaul", part: "vehicles" },
      ],
    },
    Delivery: {
      stage: "Delivery",
      tabs: [{ id: "Assign delivery rider", page: "Dispatch", mode: "delivery" }],
      bulk: {},
      subtitle: "Assign delivery riders to parcels at the hub, plan routes and follow riders on the map.",
    },
    Problems: {
      stage: "Problems",
      tabs: [
        { id: "Exceptions", page: "Exceptions", list: { stage: "exceptions" }, bulk: { status: "EXCEPTION" }, title: "Exception work queue", empty: "No open exceptions." },
        { id: "Failed delivery", page: "Exceptions", list: { stage: "failed" }, bulk: { status: "RETRY_SCHEDULED" }, title: "Failed deliveries · retry scheduled or back at the hub", empty: "No failed deliveries waiting for a decision." },
        { id: "Needs info", page: "Exceptions", list: { stage: "needs_info" }, bulk: { incomplete: true }, title: "Orders with details missing", empty: "No orders are missing details." },
        { id: "SLA late-risk", page: "Exceptions", list: { stage: "sla_risk" }, bulk: { sla: "AT_RISK" }, title: "Late or at risk of missing the delivery promise", sla: true, empty: "No parcels are past their promised delivery time." },
      ],
      subtitle: "Resolve exceptions, failed deliveries, missing details and parcels at risk of running late.",
    },
    Returns: { stage: "Returns", tabs: [{ id: "Returns", page: "Returns" }], bulk: {} },
    // A tab per task (bridge-section-tabs.js); tabs with nothing for this person are hidden.
    "COD & settlement": {
      tabs: [
        { id: "Cash from riders", page: "COD & finance", part: "cash" },
        { id: "Franchise", page: "COD & finance", part: "franchise" },
        { id: "Settlements & payouts", page: "COD & finance", part: "settlements" },
        { id: "Invoices & accounts", page: "COD & finance", part: "accounts" },
      ],
    },
    "All parcels": {
      tabs: [
        { id: "All", page: "Shipments", list: {} },
        { id: "E-commerce", page: "E-commerce operations", list: { line: "ECOMMERCE" } },
        { id: "Banking & Financial", page: "Banking & Financial operations", list: { line: "BANKING_FINANCIAL" } },
        { id: "Customer", page: "Customer parcels", list: { line: "CUSTOMER" }, merchants: false },
      ],
      shipmentPage: true,
    },
    Reports: {
      tabs: [
        { id: "Reports", page: "Reports" },
        { id: "Analytics & SLA", page: "Analytics" },
      ],
    },
    // Quick updates by scanning, one tab per job (the Hubs page's parts; bridge-hub-desk.js, bridge-intake.js, bridge-collect.js).
    "Scan desk": {
      subtitle: "Quick updates by scanning, one tab per job: receive, pickups, transfers, deliveries, failed deliveries and returns.",
      tabs: [
        // Every arrival, wherever it comes from: drop-offs, pickups, transfers, parcels back from riders.
        { id: "Receive entry", page: "Hubs", part: "receive" },
        { id: "Pickup entry", page: "Hubs", part: "pickup" },
        { id: "Transfer out", page: "Hubs", part: "transfer" },
        { id: "Collect from hub", page: "Hubs", part: "collect" },
        { id: "Out for delivery entry", page: "Hubs", part: "dispatch" },
        { id: "Delivery entry", page: "Hubs", part: "delivered" },
        { id: "Failed delivery entry", page: "Hubs", part: "failed" },
        { id: "Return rider assign", page: "Hubs", part: "returnassign" },
        { id: "Return entry", page: "Hubs", part: "returns" },
      ],
    },
    // Each parcel's next step, counted and grouped, done by scanning (bridge-workqueue.js).
    "Work queue": { keepTitle: true, tabs: [{ id: "Work queue", page: "Work queue" }] },
    Riders: {
      keepTitle: true,
      tabs: [
        { id: "Riders", page: "Riders", part: "riders" },
        { id: "Shifts & attendance", page: "Riders", part: "shifts" },
        { id: "Verification", page: "Riders", part: "kyc" },
      ],
    },
    Merchants: { keepTitle: true, tabs: [{ id: "Merchants", page: "Merchants" }] },
    "CN stock": { keepTitle: true, tabs: [{ id: "CN stock", page: "CN stock" }] },
    Settings: { keepTitle: true, tabs: [{ id: "Settings", page: "Settings" }] },
  };
  /** Old page names (and their old labels) → the view and tab that now hold them. */
  const OLD = {
    Overview: ["Today"],
    "Live overview": ["Today"],
    Shipments: ["All parcels", "All"],
    "E-commerce operations": ["All parcels", "E-commerce"],
    "Banking & Financial operations": ["All parcels", "Banking & Financial"],
    "Domestic & documents": ["All parcels", "Banking & Financial"],
    "Customer parcels": ["All parcels", "Customer"],
    Dispatch: ["Delivery"],
    "Dispatch & routes": ["Delivery"],
    Hubs: ["Scan desk", "Receive entry"],
    Linehaul: ["Transfers"],
    "Returns (RTO)": ["Returns"],
    "Scheduled pickups": ["Pickup", "Scheduled pickups"],
    Exceptions: ["Problems", "Exceptions"],
    Analytics: ["Reports", "Analytics & SLA"],
    "Analytics & SLA": ["Reports", "Analytics & SLA"],
    "COD & finance": ["COD & settlement"],
    "Merchant accounts": ["Merchants"],
    "Riders & fleet": ["Riders"],
    "Admin settings": ["Settings"],
  };
  Ops.views = VIEWS;
  Ops.oldPages = OLD;

  const state = { view: "Today", tab: 0 };
  let forced = null;
  let userNavigated = false;
  const tabOf = (view = state.view, tab = state.tab) => VIEWS[view]?.tabs[tab];
  Ops.view = () => (state.view ? { view: state.view, tab: tabOf()?.id } : null);

  /** Old tab names (links, bookmarks) → today's tab. */
  const TAB_ALIAS = { "drop-off receive": "Receive entry", "hub register": "At my hub", "hub pickup counter": "Collect from hub", "receive from rider": "Receive entry", receive: "Receive entry", "out for delivery": "Out for delivery entry", "delivered entry": "Delivery entry", "failed delivery": "Failed delivery entry" };
  // Names and their URL slugs (DF.nav: "Hub desk" ↔ hub-desk, "SLA late-risk" ↔ sla-late-risk) match alike.
  const same = (a, b) => {
    const x = String(a ?? "").trim().toLowerCase();
    const y = String(b ?? "").trim().toLowerCase();
    return x === y || (!!DF.nav && DF.nav.slug(x) === DF.nav.slug(y) && DF.nav.slug(x) !== "");
  };
  /** A tab's index in a view (its name, slug or an old name), -1 when the view has no such tab. */
  const tabIndex = (view, tab) => {
    const tabs = VIEWS[view].tabs;
    // An old name only when the view has no tab of that name (Problems › "Failed delivery" is its own tab).
    const direct = typeof tab === "number" ? tab : tabs.findIndex(t => same(t.id, tab));
    const alias = direct >= 0 ? null : Object.keys(TAB_ALIAS).find(a => same(a, tab));
    return direct >= 0 ? direct : alias ? tabs.findIndex(t => same(t.id, TAB_ALIAS[alias])) : -1;
  };
  const findTab = (view, tab) => {
    const tabs = VIEWS[view].tabs;
    const i = tabIndex(view, tab);
    return i >= 0 && i < tabs.length ? i : 0;
  };
  /** A view or old page name (any case, or its slug) → { view, tab } or null. */
  function lookup(name, tab) {
    const view = Object.keys(VIEWS).find(v => same(v, name));
    // The scan tabs moved from Hub desk to Scan desk: old links follow them.
    if (view === "Hub desk" && typeof tab === "string" && tabIndex(view, tab) < 0 && tabIndex("Scan desk", tab) >= 0) return { view: "Scan desk", tab: findTab("Scan desk", tab) };
    if (view) return { view, tab: findTab(view, tab) };
    const old = Object.keys(OLD).find(o => same(o, name));
    if (old) return { view: OLD[old][0], tab: findTab(OLD[old][0], tab ?? OLD[old][1]) };
    return null;
  }
  Ops.lookupView = lookup;

  /** Where a render(page) call from the page scripts goes: the tab on screen when it shows that page. */
  function resolve(name) {
    const internal = name === "Hubs & zones" ? "Hubs" : name === "Live overview" ? "Overview" : name;
    if (tabOf()?.page === internal) return { view: state.view, tab: state.tab };
    const same = state.view ? VIEWS[state.view].tabs.findIndex(t => t.page === internal) : -1;
    if (same >= 0) return { view: state.view, tab: same };
    return lookup(name);
  }

  /** Opens a view (and tab, by index or name). */
  function navigate(view, tab = 0) {
    if (!VIEWS[view]) return;
    // The scan tabs moved from Hub desk to Scan desk: old links follow them.
    if (view === "Hub desk" && typeof tab === "string" && tabIndex("Hub desk", tab) < 0 && tabIndex("Scan desk", tab) >= 0) view = "Scan desk";
    forced = { view, tab: findTab(view, tab) };
    render(VIEWS[view].tabs[forced.tab].page);
  }
  Ops.navigate = navigate;

  const innerRender = render;
  render = function (page) {
    const target = forced || resolve(page);
    forced = null;
    if (!target) {
      // Pages outside the menu (Support, Notifications): drawn as before.
      state.view = null;
      innerRender(page);
      decorate();
      DF.nav?.entered(page, null);
      return;
    }
    const moved = state.view !== target.view || state.tab !== target.tab;
    state.view = target.view;
    state.tab = target.tab;
    const tab = tabOf();
    // The page scripts draw only what the tab shows (Hub desk parts, Pickup / Delivery halves).
    Ops.tabMode = tab.mode || null;
    Ops.hubPart = tab.part || null;
    // Opening a tab (not a redraw of it): sections load their data once per opening (Ops.navEpoch).
    if (moved) Ops.navEpoch = (Ops.navEpoch || 0) + 1;
    innerRender(tab.page);
    decorate();
    // The address and title follow (DF.nav: ?page=<view>&tab=<tab>, a history entry per move).
    DF.nav?.entered(state.view, VIEWS[state.view].tabs.length > 1 ? tab.id : null);
    if (moved) {
      // Another view: only the parcels it shows (and the open drawer's) stay in the browser.
      Ops.lists.forgetHidden();
      Ops.keepParcels([...Ops.lists.shownIds(), ...(Ops.drawer?.ids?.() || [])]);
    }
  };

  // ───────────── drawing a view ─────────────

  function headingActions() {
    const heading = q("#mainContent .page-heading");
    if (!heading) return null;
    let actions = q(".heading-actions", heading);
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "heading-actions";
      for (const el of [...heading.children].filter(el => el.matches("button, a.button"))) actions.append(el);
      heading.append(actions);
    }
    return actions;
  }

  function tabsBar(view) {
    const v = VIEWS[view];
    if (v.tabs.length < 2) return;
    const bar = `<div class="df-tabs" role="tablist" aria-label="${esc(view)}">${v.tabs
      .map(
        (t, i) =>
          `<button type="button" role="tab" class="button button-sm${i === state.tab ? " button-primary" : ""}" data-nav-tab="${esc(t.id)}" aria-selected="${i === state.tab}">${esc(t.id)}</button>`,
      )
      .join("")}</div>`;
    const heading = q("#mainContent .page-heading");
    if (heading) heading.insertAdjacentHTML("afterend", bar);
    else $("mainContent").insertAdjacentHTML("afterbegin", bar);
  }

  /**
   * One print control: the format select reads "Print…" and prints the choice (labels included).
   * The old Print button is kept hidden (the page script's handler). One Export: "Download orders /
   * shipments" wrote the same CSV as Export.
   */
  function printMenu() {
    $("courierDownload")?.remove();
    const format = $("courierPrintFormat");
    if (format && !format.dataset.printMenu) {
      format.dataset.printMenu = "1";
      format.insertAdjacentHTML("afterbegin", `<option value="" selected>Print…</option>`);
      format.value = "";
      format.setAttribute("aria-label", "Print: choose what to print");
      format.title = "Prints the ticked rows, else the rows on screen";
      const option = q('option[value="label"]', format);
      if (option) option.textContent = "Shipment labels";
      const print = $("courierPrint");
      if (print) print.style.display = "none";
    }
    const cn = $("generateCNs");
    if (cn) {
      cn.textContent = "CN stock";
      cn.title = "Pre-printed consignment number labels (allocate, print, check)";
    }
  }

  const svg = body => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICONS = {
    plus: svg('<use href="#i-plus"/>'),
    upload: svg('<path d="M12 15V4m0 0-4 4m4-4 4 4"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>'),
    sheet: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M4 15h16M10 4v16"/>'),
    print: svg('<path d="M7 9V4h10v5"/><path d="M7 17H5a1 1 0 0 1-1-1v-5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5a1 1 0 0 1-1 1h-2"/><path d="M7 14h10v6H7z"/>'),
    download: svg('<use href="#i-download"/>'),
    box: svg('<use href="#i-box"/>'),
  };
  const withIcon = (el, name) => el && !el.querySelector(":scope > svg") && el.insertAdjacentHTML("afterbegin", ICONS[name]);

  /**
   * New orders heading, no "More actions": New order · Import Excel · Scan with phone · Bulk update Excel · Print… ·
   * Export · CN stock, each with an icon. The Excel template and both histories are in the import and
   * bulk-update dialogs; labels print from Print… (Shipment labels).
   */
  function newOrdersButtons() {
    const actions = headingActions();
    if (!actions) return;
    if (!$("dfIconActionsCss"))
      document.head.insertAdjacentHTML(
        "beforeend",
        `<style id="dfIconActionsCss">.df-icon-actions{flex-wrap:wrap;justify-content:flex-end}.df-icon-actions .button{white-space:nowrap}.df-icon-actions svg{flex:none}.df-icon-actions #courierPrintFormat{width:118px}</style>`,
      );
    actions.classList.add("df-icon-actions");
    printMenu();
    for (const id of ["printGeneratedCNs", "courierTemplate", "courierImportHistory", "courierBulkHistory"]) $(id)?.remove();
    const bulk = $("stageBulkUpdate");
    if (bulk) bulk.textContent = "Bulk update Excel";
    const format = $("courierPrintFormat");
    let print = format?.closest(".df-print-select");
    if (format && !print) {
      format.insertAdjacentHTML("beforebegin", `<span class="df-print-select" style="position:relative;display:inline-flex;align-items:center">${ICONS.print}</span>`);
      print = format.previousElementSibling;
      const icon = print.firstElementChild;
      icon.setAttribute("style", "position:absolute;left:9px;width:13px;height:13px;color:#586577;pointer-events:none");
      print.append(format);
      format.style.paddingLeft = "28px";
    }
    // Scan with phone (bridge-scan.js; its button carries its own camera icon).
    if (!$("scanWithPhone") && Ops.scanButton) actions.insertAdjacentHTML("beforeend", Ops.scanButton());
    const order = [
      [q('[data-action^="new"], a.button', actions), "plus"],
      [$("courierImport"), "upload"],
      [$("scanWithPhone"), null],
      [bulk, "sheet"],
      [print, null],
      [q('[data-action="export"]', actions), "download"],
      [$("generateCNs"), "box"],
    ];
    for (const [el, icon] of order) {
      if (!el) continue;
      el.classList.remove("button-primary");
      if (icon) withIcon(el, icon);
      actions.append(el);
    }
    order[0][0]?.classList.add("button-primary");
    // The page script's hidden Print button and the file input stay (their handlers), out of the way.
    for (const el of [$("courierPrint"), ...actions.querySelectorAll('input[type="file"]')]) if (el && el.parentElement === actions) actions.append(el);
  }

  /** Shipment-page headings: the main buttons stay, the rest go under "More actions". */
  function groupShipmentButtons() {
    const actions = headingActions();
    if (!actions || q(".df-more", actions)) return;
    printMenu();
    const keep = '[data-action^="new"], a.button, #courierImport, #courierBulkUpdate, #stageBulkUpdate, #printGeneratedCNs, #courierPrintFormat, #courierPrint';
    const rest = [...actions.children].filter(el => !el.matches(keep) && !el.matches('input[type="file"]'));
    const primary = q('[data-action^="new"], a.button', actions);
    for (const el of rest) el.classList.remove("button-primary");
    if (primary) {
      primary.classList.add("button-primary");
      actions.prepend(primary);
    }
    if (!rest.length) return;
    actions.insertAdjacentHTML("beforeend", Ops.moreMenu("", "More actions"));
    const menu = q(".df-more-menu", actions);
    for (const el of rest) menu.append(el);
    // The page button style for the summary, like the buttons beside it.
    q(".df-more > summary", actions)?.classList.remove("button-sm");
  }

  function stageBulkButton(view, tab) {
    const filters = tab.bulk || VIEWS[view].bulk;
    const kind = Ops.bulkKindOf?.(view);
    if (!filters || !kind || !Ops.can("dispatch") || !window.DFImport?.bulk) return;
    $("courierBulkUpdate")?.remove(); // the page's own button (status from the page filter) is replaced by the stage preset
    const actions = headingActions();
    if (!actions || $("stageBulkUpdate")) return;
    actions.insertAdjacentHTML(
      "beforeend",
      `<button class="button" id="stageBulkUpdate" type="button" data-stage-bulk data-kind="${kind}" title="Choose one of this page's actions, download its Excel file, fill it in, upload and apply">${Ops.bulkLabel(kind)}</button>`,
    );
  }

  /** A stage table (server-paged, bridge-lists.js) after `after`, or at the end of the page. */
  function stageList(id, cfg, title, subtitle, after) {
    q(`#mainContent [data-list="${CSS.escape(id)}"]`)?.remove();
    const html = Ops.lists.panel(id, cfg, { title, subtitle, tools: cfg.tools || "" });
    if (after) after.insertAdjacentHTML("afterend", html);
    else $("mainContent").insertAdjacentHTML("beforeend", html);
    Ops.lists.mount(id);
    return q(`#mainContent [data-list="${CSS.escape(id)}"]`);
  }

  /** Hub desk tabs: the receive desk and the counter draw themselves (Ops.hubPart); "At my hub" is a stage table. */
  function hubParts(part) {
    if (part !== "athub") return;
    const mine = Ops.scope.available();
    const chosen = Ops.lists.get("hub-now")?.filters.hubId || "";
    // Network staff choose a hub; hub operators switch between their hub and all hubs (Ops.scope).
    const tools = mine
      ? ""
      : `<select class="select-small" data-list-hub aria-label="Hub"><option value="">All hubs</option>${DF.state.hubs.map(h => `<option value="${esc(h.id)}"${h.id === chosen ? " selected" : ""}>${esc(h.name)}</option>`).join("")}</select>`;
    stageList(
      "hub-now",
      { params: () => ({ stage: "hub" }), tools, empty: "No parcels at the hub right now. Parcels you receive appear here with their next step." },
      mine && Ops.scope.value() === "mine" ? "At my hub now" : "At hubs now",
      "Received and waiting: assign a delivery rider, add to a transfer when another hub delivers there, or hand over at the counter",
    );
  }

  /** Pickup and Delivery: the stage's two tables (waiting for a rider, with a rider); the map and route planner on Delivery. */
  function dispatchMode(mode) {
    const pickup = mode === "pickup";
    // The assignment queue (with its "N additional shipments" line) gives way to the stage tables.
    qa("#mainContent .panel").find(p => q(".panel-title", p)?.textContent === "Assignment queue")?.remove();
    const grid = q("#mainContent .dashboard-grid");
    if (grid && pickup) grid.remove();
    else if (grid) grid.style.gridTemplateColumns = "1fr";
    if (pickup) $("routePlanner")?.remove();
    const tables = pickup
      ? [
          ["pickup-waiting", "pickup_waiting", "Waiting for a pickup rider", "Accepted orders without a pickup rider (new orders are accepted with a rider in New orders)", "Every accepted order has a pickup rider."],
          ["pickup-active", "pickup", "Being picked up", "Pickup assigned, confirmed or picked up · on the way to the hub", "No pickups in progress."],
        ]
      : [
          ["delivery-waiting", "delivery_waiting", "Waiting for a delivery rider", "At the hub · assign a rider, or add to a transfer when another hub delivers there", "No parcels are waiting at a hub for a delivery rider."],
          ["delivery-active", "delivery", "Out with delivery riders", "Assigned to a delivery rider or out for delivery", "No parcels are out with delivery riders."],
        ];
    let after = (!pickup && q("#mainContent .dashboard-grid")) || q("#mainContent .metrics") || q("#mainContent .df-tabs") || q("#mainContent .page-heading");
    // Waiting for a delivery rider: "Failed before" narrows it to parcels back after a failed attempt (bridge-failed.js badge).
    const failed = Ops.lists.get("delivery-waiting")?.filters.failedBefore || "";
    const failedTools = `<select class="select-small" data-list-failed aria-label="Failed before"><option value="">All parcels</option><option value="true"${failed === "true" ? " selected" : ""}>Failed before</option><option value="false"${failed === "false" ? " selected" : ""}>Not failed before</option></select>`;
    for (const [id, stage, title, subtitle, empty] of tables)
      after = stageList(id, { params: () => ({ stage }), empty, tools: id === "delivery-waiting" ? failedTools : "" }, title, subtitle, after) || after;
  }

  function problemsTab(tab) {
    Ops.lists.main(`problems-${tab.list.stage}`, { params: () => ({ ...tab.list }), empty: tab.empty });
    const title = q("#mainContent .table-panel .panel-title");
    if (title) title.textContent = tab.title;
    show($("slaAlerts"), !!tab.sla);
  }

  /** Today: the stage cards and one metrics row; the service-line cards and "Network health" repeated them. */
  function todayLayout() {
    q("#mainContent .service-card-grid")?.remove();
    qa("#mainContent .panel").find(p => q(".panel-title", p)?.textContent === "Network health")?.remove();
    const grid = q("#mainContent .dashboard-grid");
    if (grid) grid.style.gridTemplateColumns = "1fr";
    const feed = $("shipmentBody")?.closest(".table-panel");
    const feedSub = feed && q(".panel-subtitle", feed);
    if (feedSub) feedSub.textContent = "The newest parcels · search finds any parcel";
    Ops.lists.main("today-feed", { params: () => ({}), limit: 6, more: false, merchants: false, noun: "recent parcel", empty: "No parcels yet." });
  }

  function todayCards() {
    if ($("stageCards")) return;
    // (The numbers follow GET /ops/stage-counts: updateCounts below.)
    const allowed = allowedViews();
    const counts = stageCounts();
    const cards = JOURNEY.filter(stage => allowed.has(stage))
      .map((stage, i) => {
        const [ico, hint] = STAGE_HINT[stage];
        const n = JOURNEY.indexOf(stage) + 1;
        return metric(`${n} · ${stage}`, `<span data-stage-count="${esc(stage)}">${Ops.num(counts[stage])}</span>`, ico, hint, "Open ›").replace(
          '<article class="metric"',
          `<article class="metric" role="button" tabindex="0" data-stage-open="${esc(stage)}" aria-label="${esc(`Open ${stage}`)}" style="--i:${i}"`,
        );
      })
      .join("");
    if (!cards) return;
    const heading = q("#mainContent .page-heading");
    const html = `<div class="df-stage-grid" id="stageCards" aria-label="Parcel journey">${cards}</div>`;
    if (heading) heading.insertAdjacentHTML("afterend", html);
    else $("mainContent").insertAdjacentHTML("afterbegin", html);
  }

  /** The same words for the same actions everywhere (labels only). */
  function consistentLabels() {
    qa("#mainContent [data-assign-shipment], #mainContent .alert-list [data-action=\"assign\"]").forEach(b => /^assign$/i.test(b.textContent.trim()) && (b.textContent = "Assign rider"));
    // One way to assign a rider: the row's next action or the drawer ("Suggest riders" and Excel for many).
    qa('#mainContent .page-heading [data-action="assign"]').forEach(b => b.remove());
    qa("#mainContent [data-exception]").forEach(b => (b.textContent = "Resolve"));
  }

  function decorate() {
    const label = $("breadcrumbLabel");
    const view = state.view;
    if (label) label.textContent = view || $("breadcrumbPage").textContent;
    qa("#navigation [data-nav]").forEach(b => b.classList.toggle("active", b.dataset.nav === view));
    if (!view) return void updateCounts();
    const v = VIEWS[view];
    const tab = tabOf();
    // Heading: the menu's name for the view.
    if (!v.keepTitle) {
      const h1 = q("#mainContent .page-heading h1");
      if (h1) h1.textContent = v.title || view;
      const sub = q("#mainContent .page-heading .subtitle");
      if (sub && v.subtitle) sub.textContent = v.subtitle;
    }
    tabsBar(view);
    if (view === "Today") {
      todayCards();
      todayLayout();
    }
    if (tab.part) hubParts(tab.part);
    if (tab.mode) dispatchMode(tab.mode);
    if (view === "Problems") problemsTab(tab);
    if (view === "Transfers" && tab.part === "road") stageList("transfers", { params: () => ({ stage: "transfers" }), empty: "No parcels are between hubs right now." }, "Parcels in transit between hubs", "Transferred out of a hub and not yet received at the next one");
    if (view === "Returns") stageList("returns", { params: () => ({ stage: "returns" }), empty: "No parcels are on a return run." }, "Return scheduled", "Parcels going back to their merchants on a return run");
    if (view === "New orders") {
      show(q("#mainContent .stats-mini"), false);
      $("statusFilter")?.remove(); // every order here has the same status
      const panelTitle = q("#mainContent .table-panel .panel-title");
      if (panelTitle) panelTitle.textContent = "Orders waiting for operations";
      const panelSub = q("#mainContent .table-panel .panel-subtitle");
      if (panelSub) panelSub.textContent = "Newest first · 100 a page · tick orders to accept and assign them together";
      Ops.lists.main("new-orders", { params: () => ({ ...tab.list }), bulkAccept: tab.bulkAccept, noun: "order", lines: true, empty: "No orders are waiting for operations." });
    }
    if (view === "All parcels") Ops.lists.main(`all-${tab.id}`, { params: () => ({ ...tab.list }), merchants: tab.merchants, empty: "No parcels match." });
    stageBulkButton(view, tab);
    if (view === "New orders") newOrdersButtons();
    else if (v.shipmentPage) groupShipmentButtons();
    consistentLabels();
    applyMenu();
    updateCounts();
  }

  // The assign and exception dialogs use the same words as the buttons that open them.
  const previousOpenModal = openModal;
  openModal = function (kind, shipmentId) {
    previousOpenModal(kind, shipmentId);
    if (kind === "assign") {
      $("modalTitle").textContent = "Assign rider";
      $("modalSubmit").textContent = "Assign rider";
    }
    if (kind === "exception") {
      $("modalTitle").textContent = $("modalTitle").textContent.replace(/^Review exception/, "Resolve exception");
      $("modalSubmit").textContent = "Resolve";
    }
  };

  // ───────────── counts ─────────────

  /** Before the stage counts arrive: the statuses behind each stage in GET /ops/overview `shipments.byStatus`. */
  const STAGE_STATUSES = {
    "New orders": ["PENDING_CONFIRMATION"],
    Pickup: ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED", "PICKED_UP"],
    "Hub desk": ["AT_HUB", "READY_FOR_COLLECTION"],
    Transfers: ["IN_TRANSIT"],
    Delivery: ["ASSIGNED", "OUT_FOR_DELIVERY"],
    Problems: ["EXCEPTION", "RETRY_SCHEDULED"],
    Returns: ["RETURN_SCHEDULED"],
  };
  /**
   * Parcels per stage: GET /ops/stage-counts for the scope on screen (Problems includes "Needs info",
   * Returns the return requests too), reloaded after live parcel events; the overview until it arrives.
   */
  function stageCounts() {
    const counts = Object.fromEntries(JOURNEY.map(k => [k, 0]));
    const stages = Ops.stageCountsData?.stages;
    if (stages) {
      for (const k of JOURNEY) counts[k] = Number(stages[STAGE_COUNT[k]]) || 0;
      return counts;
    }
    const byStatus = Ops.overview?.shipments?.byStatus;
    if (byStatus) for (const k of JOURNEY) counts[k] = STAGE_STATUSES[k].reduce((n, st) => n + (Number(byStatus[st]) || 0), 0);
    return counts;
  }
  Ops.stageCounts = stageCounts;
  // New counters (bridge.js reloads them after parcel events) update the badges at once.
  let overview = Ops.overview;
  Object.defineProperty(Ops, "overview", {
    configurable: true,
    get: () => overview,
    set: value => {
      overview = value;
      setTimeout(updateCounts);
    },
  });
  function updateCounts() {
    for (const [stage, n] of Object.entries(stageCounts())) qa(`[data-stage-count="${stage}"]`).forEach(el => (el.textContent = Ops.num(n)));
  }
  Ops.onCounts?.push(updateCounts);

  // ───────────── role-based menu ─────────────

  function allowedViews() {
    const roles = new Set(DF.auth.user?.roles || []);
    const all = new Set(Object.keys(VIEWS));
    if (roles.has("SUPER_ADMIN") || roles.has("OPS_MANAGER")) return all;
    const allow = new Set();
    if (roles.has("HUB_OPERATOR")) {
      ["Today", ...JOURNEY, "Work queue", "Scan desk", "All parcels"].forEach(v => allow.add(v));
      if (Ops.can("readRiders")) allow.add("Riders");
      // Hub operators receive riders' cash on the COD page (cash handovers).
      if (Ops.can("receiveCash")) allow.add("COD & settlement");
    }
    if (roles.has("FINANCE")) ["COD & settlement", "All parcels", "Merchants", "Reports"].forEach(v => allow.add(v));
    if (roles.has("SUPPORT_AGENT")) ["All parcels", "Today"].forEach(v => allow.add(v));
    return allow.size ? allow : all; // other (custom) roles: the whole menu; the API still decides
  }
  Ops.allowedViews = allowedViews;
  const financeFirst = () => {
    const roles = DF.auth.user?.roles || [];
    return roles.includes("FINANCE") && !roles.some(r => ["SUPER_ADMIN", "OPS_MANAGER", "HUB_OPERATOR"].includes(r));
  };

  function applyMenu() {
    const allowed = allowedViews();
    const nav = $("navigation");
    if (!nav) return;
    qa("[data-nav]", nav).forEach(b => (b.hidden = !allowed.has(b.dataset.nav)));
    qa("[data-nav-group]", nav).forEach(g => (g.hidden = !qa("[data-nav]", g).some(b => !b.hidden)));
    const money = q('[data-nav-group="money"]', nav);
    if (money && financeFirst() && nav.firstElementChild !== money) nav.prepend(money);
  }
  Ops.applyMenu = applyMenu;

  // ───────────── events ─────────────

  $("navigation")?.addEventListener("click", event => {
    const item = event.target.closest("[data-nav]");
    if (!item) return;
    userNavigated = true;
    $("sidebar")?.classList.remove("open");
    navigate(item.dataset.nav);
  });
  $("mainContent").addEventListener("click", event => {
    const tab = event.target.closest("[data-nav-tab]");
    if (tab && state.view) {
      userNavigated = true;
      return void navigate(state.view, tab.dataset.navTab);
    }
    const card = event.target.closest("[data-stage-open]");
    if (card) {
      userNavigated = true;
      navigate(card.dataset.stageOpen);
    }
  });
  $("mainContent").addEventListener("keydown", event => {
    const card = event.target.closest?.("[data-stage-open]");
    if (!card || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    userNavigated = true;
    navigate(card.dataset.stageOpen);
  });

  // "Print…": choosing a format prints it (the page script's Print handler), then the select reads "Print…" again.
  window.addEventListener(
    "change",
    event => {
      const select = event.target;
      if (select?.id !== "courierPrintFormat" || !select.dataset.printMenu || !select.value) return;
      $("courierPrint")?.click();
      setTimeout(() => (select.value = ""), 0);
    },
    true,
  );

  window.addEventListener(
    "click",
    event => {
      if (!event.target.closest?.("#stageBulkUpdate")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!Ops.require("dispatch", "update parcels in bulk")) return;
      const tab = tabOf();
      const filters = { ...(tab?.bulk || VIEWS[state.view]?.bulk || {}) };
      void Ops.bulkConfig(Ops.bulkKindOf(state.view) || "all")
        .then(cfg => window.DFImport.bulk({ ...cfg, filters }))
        .catch(error => showToast(DF.describe(error)));
    },
    true,
  );

  // ───────────── start: the address (DF.nav), deep links (?page=, old or new names; ?parcel=; ?ticket=) ─────────────

  /** Opens a parcel's drawer, loading it from the API when it isn't on screen (deep links, notifications). */
  async function openParcel(id) {
    if (!Ops.apiParcel(id)) {
      try {
        Ops.upsertParcels([await DF.api(`/parcels/${encodeURIComponent(id)}`)]);
      } catch (error) {
        showToast(error?.status === 404 ? `Parcel ${id} was not found.` : DF.describe(error));
        DF.nav?.setParam("parcel", null);
        return;
      }
    }
    Ops.drawer.open(id, []);
  }
  Ops.openParcel = openParcel;
  // The open drawer is part of the address (?parcel=), so it can be shared and survives a reload.
  if (Ops.drawer && DF.nav) {
    const { open, close } = Ops.drawer;
    Ops.drawer.open = function (id, ...rest) {
      open.call(this, id, ...rest);
      if (this.id) DF.nav.setParam("parcel", this.id);
    };
    Ops.drawer.close = function (...rest) {
      const had = this.id;
      close.apply(this, rest);
      if (had) DF.nav.setParam("parcel", null);
    };
  }

  const ALIAS_OF = view => Object.keys(OLD).filter(o => OLD[o][0] === view);
  DF.nav?.start({
    panel: "Courier Operations",
    home: "Today",
    pages: () => [
      ...Object.keys(VIEWS).map(view => ({
        name: view,
        aliases: ALIAS_OF(view),
        tabs: VIEWS[view].tabs.length > 1 ? VIEWS[view].tabs.map(t => ({ name: t.id, aliases: Object.keys(TAB_ALIAS).filter(a => TAB_ALIAS[a] === t.id) })) : undefined,
      })),
      { name: "Support", label: "Support tickets", slug: "support" },
      { name: "Notifications", slug: "notifications" },
    ],
    open: (page, tab) => (VIEWS[page] ? navigate(page, tab ?? 0) : render(page)),
    openParcel,
    openTicket: number => window.DFSupport?.open(number),
  });

  const params = new URLSearchParams(location.search);
  if (params.has("report")) userNavigated = true; // the scheduled-report link opens Reports itself
  // Old names keep their tab (e.g. ?page=Scheduled pickups → Pickup › Scheduled pickups); the address is rewritten to the slugs.
  const linked = params.get("page") && lookup(params.get("page"), params.get("tab") ?? undefined);
  const other = !linked && (params.get("page") || params.get("ticket")) && DF.nav?.requested();
  if (linked) {
    userNavigated = true;
    navigate(linked.view, linked.tab);
  } else if (other) {
    userNavigated = true;
    render(other.page);
  } else render(Ops.page());

  (DF.bridgeReady || Promise.resolve()).then(() => {
    applyMenu();
    const allowed = allowedViews();
    if (!userNavigated && state.view && !allowed.has(state.view)) {
      const first = qa("#navigation [data-nav]").find(b => !b.hidden);
      // The role's landing page replaces the first address (Back doesn't return to a page they don't use).
      if (first) DF.nav ? DF.nav.quietly(() => navigate(first.dataset.nav)) : navigate(first.dataset.nav);
    } else updateCounts();
    DF.nav?.extras(); // ?parcel= opens the drawer, ?ticket= the support ticket
  });
})();
