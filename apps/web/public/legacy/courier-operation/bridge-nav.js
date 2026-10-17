/*
 * Courier Operations navigation, organised around the parcel journey (UI only).
 *
 * The menu (src/features/courier-operation/components/Sidebar.tsx, `data-nav`) opens views. A view
 * is one or more tabs, and each tab is an original page (its renderer, data, actions and
 * permissions unchanged) shown with a filter, a mode or a subset of its sections:
 *
 *   Today               Overview + a card per journey stage with its live count (the map stays)
 *   1 New orders        Shipments, only "Pending operations confirmation" (all lines)
 *   2 Pickup            Dispatch (pickup half of the queue) · Scheduled pickups
 *   3 Hub desk          Hubs: Receive (scan, receive, transfer, register) · Drop-off receive (receive
 *                       desk) · Hub Pickup counter
 *   4 Transfers         Linehaul
 *   5 Delivery          Dispatch (delivery half of the queue, map, route planner)
 *   6 Problems          Exceptions page: Exceptions · Failed delivery · Needs info · SLA late-risk
 *   7 Returns           Returns
 *   8 COD & settlement  COD & finance
 *   All parcels         Shipments · E-commerce · Banking & Financial · Customer (the service-line pages)
 *   Reports             Reports · Analytics & SLA
 *   Riders · Merchants · Hubs & zones (Hubs: register, capacity, zones, routes) · CN stock · Settings
 *
 * The page scripts keep using the original page names (render("Hubs"), Ops.page(), the hidden
 * #breadcrumbPage and #legacyNav buttons), so every old name still opens the right place:
 * render(oldName), ?page=<old or new name>[&tab=<tab>], alert and notification links. Stage counts
 * are the parcels of the loaded working set at each stage (updated with live parcel events).
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
  const CLOSED = ["DELIVERED", "PICKUP_CANCELLED", "RETURNED"];
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

  /** Parcels at each stage (API statuses), counted from the working set. */
  const STAGES = {
    "New orders": p => p.status === "PENDING_CONFIRMATION",
    Pickup: p => ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED", "PICKED_UP"].includes(p.status),
    "Hub desk": p => ["AT_HUB", "READY_FOR_COLLECTION"].includes(p.status),
    Transfers: p => p.status === "IN_TRANSIT",
    Delivery: p => ["ASSIGNED", "OUT_FOR_DELIVERY"].includes(p.status),
    Problems: p => ["EXCEPTION", "RETRY_SCHEDULED"].includes(p.status) || (!!p.incomplete && !CLOSED.includes(p.status)),
    Returns: p => p.status === "RETURN_SCHEDULED",
  };
  const JOURNEY = Object.keys(STAGES);
  const STAGE_HINT = {
    "New orders": ["box", "Accept & assign rider"],
    Pickup: ["clock", "Riders collecting"],
    "Hub desk": ["pin", "At hubs · to receive or hand over"],
    Transfers: ["truck", "Between hubs"],
    Delivery: ["route", "With delivery riders"],
    Problems: ["alert", "Exceptions · failed · needs info"],
    Returns: ["box", "Going back to merchants"],
  };
  /** Pickup-side work in the dispatch queue (the rest is delivery). */
  const isPickupWork = p => ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED"].includes(p.status) || (p.status === "EXCEPTION" && !p.pickedUpAt && !p.currentHub);

  // ───────────── views ─────────────

  const VIEWS = {
    Today: { title: "Today", tabs: [{ id: "Today", page: "Overview" }] },
    "New orders": {
      stage: "New orders",
      subtitle: "Orders waiting for operations: accept and assign a pickup rider, switch to drop-off, or cancel the request.",
      tabs: [{ id: "New orders", page: "Shipments", rows: p => p.status === "PENDING_CONFIRMATION" }],
      bulk: { preset: "pending_review" },
      shipmentPage: true,
    },
    Pickup: {
      stage: "Pickup",
      tabs: [
        { id: "Assign pickup rider", page: "Dispatch", mode: "pickup" },
        { id: "Scheduled pickups", page: "Scheduled pickups" },
      ],
      bulk: { status: "PICKUP_ASSIGNED" },
      subtitle: "Assign pickup riders to accepted orders and follow merchants' scheduled pickups.",
    },
    "Hub desk": {
      stage: "Hub desk",
      tabs: [
        { id: "Receive", page: "Hubs", part: "receive" },
        { id: "Drop-off receive", page: "Hubs", part: "desk" },
        { id: "Hub Pickup counter", page: "Hubs", part: "collect" },
      ],
      bulk: { status: "AT_HUB" },
      subtitle: "Receive parcels into the hub, scan drop-offs and hand parcels to receivers at the counter.",
    },
    Transfers: { stage: "Transfers", tabs: [{ id: "Transfers", page: "Linehaul" }], bulk: { status: "IN_TRANSIT" } },
    Delivery: {
      stage: "Delivery",
      tabs: [{ id: "Assign delivery rider", page: "Dispatch", mode: "delivery" }],
      bulk: { preset: "at_hub_unassigned" },
      subtitle: "Assign delivery riders to parcels at the hub, plan routes and follow riders on the map.",
    },
    Problems: {
      stage: "Problems",
      tabs: [
        { id: "Exceptions", page: "Exceptions", rows: p => p.status === "EXCEPTION", bulk: { status: "EXCEPTION" }, title: "Exception work queue" },
        { id: "Failed delivery", page: "Exceptions", rows: p => p.status === "RETRY_SCHEDULED", bulk: { status: "RETRY_SCHEDULED" }, title: "Failed deliveries · retry scheduled" },
        { id: "Needs info", page: "Exceptions", rows: p => !!p.incomplete && !CLOSED.includes(p.status), bulk: { incomplete: true }, title: "Orders with details missing" },
        { id: "SLA late-risk", page: "Exceptions", rows: (p, s) => s?.sla === "At risk" && !CLOSED.includes(p.status), bulk: { sla: "AT_RISK" }, title: "Late or at risk of missing the delivery promise", sla: true },
      ],
      subtitle: "Resolve exceptions, failed deliveries, missing details and parcels at risk of running late.",
    },
    Returns: { stage: "Returns", tabs: [{ id: "Returns", page: "Returns" }], bulk: { status: "RETURN_SCHEDULED" } },
    "COD & settlement": { tabs: [{ id: "COD & settlement", page: "COD & finance" }] },
    "All parcels": {
      tabs: [
        { id: "All", page: "Shipments" },
        { id: "E-commerce", page: "E-commerce operations" },
        { id: "Banking & Financial", page: "Banking & Financial operations" },
        { id: "Customer", page: "Customer parcels" },
      ],
      shipmentPage: true,
    },
    Reports: {
      tabs: [
        { id: "Reports", page: "Reports" },
        { id: "Analytics & SLA", page: "Analytics" },
      ],
    },
    Riders: { keepTitle: true, tabs: [{ id: "Riders", page: "Riders" }] },
    Merchants: { keepTitle: true, tabs: [{ id: "Merchants", page: "Merchants" }] },
    "Hubs & zones": { tabs: [{ id: "Hubs & zones", page: "Hubs", part: "manage" }], subtitle: "Hub register, capacity, delivery zones and routes." },
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
    Hubs: ["Hub desk", "Receive"],
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

  const findTab = (view, tab) => {
    const tabs = VIEWS[view].tabs;
    const i = typeof tab === "number" ? tab : tabs.findIndex(t => t.id.toLowerCase() === String(tab ?? "").toLowerCase());
    return i >= 0 && i < tabs.length ? i : 0;
  };
  /** A view or old page name (any case) → { view, tab } or null. */
  function lookup(name, tab) {
    const key = String(name || "").trim().toLowerCase();
    const view = Object.keys(VIEWS).find(v => v.toLowerCase() === key);
    if (view) return { view, tab: findTab(view, tab) };
    const old = Object.keys(OLD).find(o => o.toLowerCase() === key);
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
    forced = { view, tab: findTab(view, tab) };
    render(VIEWS[view].tabs[forced.tab].page);
  }
  Ops.navigate = navigate;

  const innerRender = render;
  render = function (page) {
    const target = forced || resolve(page);
    forced = null;
    if (!target) {
      // Pages outside the menu (Support): drawn as before.
      state.view = null;
      innerRender(page);
      decorate();
      return;
    }
    state.view = target.view;
    state.tab = target.tab;
    const tab = tabOf();
    Ops.dispatchQueueFilter = tab.mode === "pickup" ? isPickupWork : tab.mode === "delivery" ? p => !isPickupWork(p) : null;
    try {
      innerRender(tab.page);
    } finally {
      Ops.dispatchQueueFilter = null;
    }
    decorate();
  };

  // ───────────── drawing a view ─────────────

  const stageRows = stage => shipments.filter(s => s._api && STAGES[stage](s._api));

  /** Replaces a button's words, keeping its icon. */
  function setLabel(button, text) {
    if (!button) return;
    const icon = button.querySelector("svg");
    button.textContent = "";
    if (icon) button.append(icon, ` ${text}`);
    else button.textContent = text;
  }

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

  /** Shipment-page headings: the main buttons stay, the rest go under "More actions". */
  function groupShipmentButtons() {
    const actions = headingActions();
    if (!actions || q(".df-more", actions)) return;
    const keep = '[data-action^="new"], a.button, #courierImport, #courierBulkUpdate, #stageBulkUpdate, #printGeneratedCNs';
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
    if (!filters || !Ops.can("dispatch") || !window.DFImport?.bulk) return;
    $("courierBulkUpdate")?.remove(); // the page's own button (status from the page filter) is replaced by the stage preset
    const actions = headingActions();
    if (!actions || $("stageBulkUpdate")) return;
    actions.insertAdjacentHTML(
      "beforeend",
      `<button class="button" id="stageBulkUpdate" type="button" data-stage-bulk title="Download this stage's parcels, fill in actions in Excel, upload and apply">Bulk update by Excel</button>`,
    );
  }

  function stagePanel(title, subtitle, rows) {
    $("stageParcels")?.remove();
    $("mainContent").insertAdjacentHTML(
      "beforeend",
      `<section class="panel table-panel" id="stageParcels" style="margin-top:14px"><div class="panel-heading"><div><h2 class="panel-title">${esc(title)}</h2><p class="panel-subtitle">${esc(subtitle)}</p></div></div>${shipmentRows(rows)}<div class="shipment-count" style="padding:11px 16px;border-top:1px solid var(--line);color:#98a2ae;font-size:12px">${esc(`Showing ${rows.length} parcel${rows.length === 1 ? "" : "s"} · updates live`)}</div></section>`,
    );
  }

  /** Hubs page sections for each tab (Hub desk) and for Hubs & zones. */
  function hubParts(part) {
    const main = $("mainContent");
    show($("collectCounter"), part === "collect");
    show($("receiveDesk"), part === "desk");
    show($("hubScanForm")?.closest(".workflow-grid"), part === "receive");
    const transfer = $("hubTransferForm")?.closest(".panel");
    const config = $("hubConfigForm")?.closest(".panel");
    show(transfer, part === "receive");
    show(config, part === "manage");
    const grid = (transfer || config)?.closest(".workflow-grid");
    if (grid) {
      show(grid, part === "receive" || part === "manage");
      grid.style.gridTemplateColumns = part === "receive" || part === "manage" ? "1fr" : "";
    }
    show($("hubRegister"), part === "manage");
    show($("networkConfig"), part === "manage");
    show($("hubShipmentRows")?.closest(".table-panel"), part === "receive");
    const report = qa(":scope > .table-panel", main).find(p => q(".panel-title", p)?.textContent === "Shipment transfer report");
    show(report, part === "receive");
    show(q(":scope > .workflow-kpis", main), part !== "manage");
    const scan = q('#mainContent .heading-actions [data-hub-focus="scan"]');
    show(scan, part === "receive");
  }

  function dispatchMode(mode) {
    const pickup = mode === "pickup";
    const map = q("#mainContent .map")?.closest(".panel");
    show(map, !pickup);
    show($("routePlanner"), !pickup);
    const grid = q("#mainContent .dashboard-grid");
    if (grid) grid.style.gridTemplateColumns = pickup ? "1fr" : "";
    const queue = qa("#mainContent .panel").find(p => q(".panel-title", p)?.textContent === "Assignment queue");
    if (queue) {
      const sub = q(".panel-subtitle", queue);
      if (sub) sub.textContent = pickup ? "Accepted orders and pickups waiting for a rider" : "Parcels at the hub waiting for a delivery rider";
    }
    const stage = pickup ? "Pickup" : "Delivery";
    stagePanel(
      pickup ? "Parcels being picked up" : "Parcels out with delivery riders",
      pickup ? "Pickup assigned, confirmed or picked up · on the way to the hub" : "Assigned to a delivery rider or out for delivery",
      stageRows(stage),
    );
  }

  function problemsTab(tab) {
    const body = $("shipmentBody");
    if (body) {
      const rows = shipments.filter(s => s._api && tab.rows(s._api, s));
      body.closest(".table-scroll").outerHTML = shipmentRows(rows);
      if (!rows.length) $("shipmentBody").innerHTML = `<tr><td colspan="8" class="empty-state">Nothing here right now.</td></tr>`;
    }
    const title = q("#mainContent .table-panel .panel-title");
    if (title) title.textContent = tab.title;
    show($("slaAlerts"), !!tab.sla);
  }

  function todayCards() {
    if ($("stageCards")) return;
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
    qa('#mainContent .heading-actions [data-action="assign"]').forEach(b => /assign shipment/i.test(b.textContent) && setLabel(b, "Assign rider"));
    const receive = q('#hubReceiveForm button[type="submit"]');
    if (receive) receive.textContent = "Receive";
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
    if (view === "Today") todayCards();
    if (tab.part) hubParts(tab.part);
    if (tab.mode) dispatchMode(tab.mode);
    if (view === "Problems") problemsTab(tab);
    if (view === "Transfers") stagePanel("Parcels in transit between hubs", "Transferred out of a hub and not yet received at the next one", stageRows("Transfers"));
    if (view === "Returns") stagePanel("Return scheduled", "Parcels going back to their merchants", stageRows("Returns"));
    if (view === "New orders") {
      show(q("#mainContent .stats-mini"), false);
      show($("statusFilter"), false);
      const panelTitle = q("#mainContent .table-panel .panel-title");
      if (panelTitle) panelTitle.textContent = "Orders waiting for operations";
    }
    stageBulkButton(view, tab);
    if (v.shipmentPage) groupShipmentButtons();
    if (tab.rows && $("shipmentBody") && view !== "Problems") applyShipmentFilters();
    consistentLabels();
    applyMenu();
    updateCounts();
  }

  // A tab with its own rows (New orders) keeps only those, whatever the search or paging adds.
  const baseFilters = applyShipmentFilters;
  applyShipmentFilters = function () {
    baseFilters();
    const tab = state.view && tabOf();
    if (!tab?.rows || state.view === "Problems") return;
    let shown = 0;
    qa("#shipmentBody tr[data-shipment-id]").forEach(row => {
      const s = shipments.find(item => item.id === row.dataset.shipmentId);
      if (!s?._api || !tab.rows(s._api, s)) row.hidden = true;
      if (!row.hidden) shown++;
    });
    const count = $("shipmentBody")?.closest(".table-panel")?.querySelector(".shipment-count");
    if (count?.firstChild) count.firstChild.textContent = `Showing ${shown} order${shown === 1 ? "" : "s"} · updates live`;
  };

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

  /** Statuses behind each stage, counted in the database by GET /ops/overview (`shipments.byStatus`). */
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
   * Parcels per stage: the database's counts from the overview (refreshed after live parcel
   * events), else the loaded working set. "Needs info" orders (not a status) come from the working set.
   */
  function stageCounts() {
    const counts = Object.fromEntries(JOURNEY.map(k => [k, 0]));
    const byStatus = Ops.overview?.shipments?.byStatus;
    if (byStatus) {
      for (const k of JOURNEY) counts[k] = STAGE_STATUSES[k].reduce((n, st) => n + (Number(byStatus[st]) || 0), 0);
      counts.Problems += shipments.filter(s => s._api?.incomplete && !CLOSED.includes(s._api.status) && !STAGE_STATUSES.Problems.includes(s._api.status)).length;
      return counts;
    }
    for (const s of shipments) {
      const p = s._api;
      if (!p) continue;
      for (const k of JOURNEY) if (STAGES[k](p)) counts[k]++;
    }
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
  const baseSet = DF.parcels.set;
  DF.parcels.set = function (items) {
    const changed = baseSet.call(DF.parcels, items);
    setTimeout(updateCounts);
    return changed;
  };

  // ───────────── role-based menu ─────────────

  function allowedViews() {
    const roles = new Set(DF.auth.user?.roles || []);
    const all = new Set(Object.keys(VIEWS));
    if (roles.has("SUPER_ADMIN") || roles.has("OPS_MANAGER")) return all;
    const allow = new Set();
    if (roles.has("HUB_OPERATOR")) {
      ["Today", ...JOURNEY, "All parcels"].forEach(v => allow.add(v));
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

  window.addEventListener(
    "click",
    event => {
      if (!event.target.closest?.("#stageBulkUpdate")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!Ops.require("dispatch", "update parcels in bulk")) return;
      const tab = tabOf();
      const filters = { ...(tab?.bulk || VIEWS[state.view]?.bulk || {}) };
      void (Ops.bulkConfig ? Ops.bulkConfig() : Promise.resolve({ mode: "bulk", onDone: () => Ops.refresh().catch(() => undefined) }))
        .then(cfg => window.DFImport.bulk({ ...cfg, filters }))
        .catch(error => showToast(DF.describe(error)));
    },
    true,
  );

  // ───────────── start: deep links (?page=, old or new names) and the role's menu ─────────────

  const params = new URLSearchParams(location.search);
  if (params.has("report")) userNavigated = true; // the scheduled-report link opens Reports itself
  const linked = params.get("page") && lookup(params.get("page"), params.get("tab") ?? undefined);
  if (linked) {
    userNavigated = true;
    navigate(linked.view, linked.tab);
  } else render(Ops.page());

  (DF.bridgeReady || Promise.resolve()).then(() => {
    applyMenu();
    const allowed = allowedViews();
    if (!userNavigated && state.view && !allowed.has(state.view)) {
      const first = qa("#navigation [data-nav]").find(b => !b.hidden);
      if (first) navigate(first.dataset.nav);
    } else updateCounts();
  });
})();
