/*
 * Courier Operations: bulk operations by Excel (shared/importer.js in bulk mode, API /bulk-updates).
 *
 *   Bulk update by Excel      on Shipments and the E-commerce / Document / Customer operations pages:
 *   (#courierBulkUpdate)      the dialog first asks for an action (every action on All parcels, with how many
 *                             parcels can take it), then downloads that action's file with the parcels as
 *                             filtered on the page (status, merchant, dates, "Needs info", service line; plus
 *                             hub, intake and SLA state in the dialog, and quick presets), then takes the
 *                             filled-in file back: check → preview → apply → result.
 *   Bulk update history       past bulk updates ("Accept & assign pickup rider · New orders") with the rows
 *   (#courierBulkHistory)     not applied (.xlsx), filtered by page and action
 *
 * One file per action (GET /bulk-updates/actions, /export?action=): only the parcels that can take the
 * action and only the columns it needs; no Action column. Every journey page with "Bulk update <page> by
 * Excel" (bridge-nav.js #stageBulkUpdate) offers its own actions (GET /bulk-updates/kinds); All parcels
 * offers every action and takes any page's file of the chosen action.
 *   Ops.bulkKindOf(view)   the template of a journey view ("Delivery" → "delivery"), or null (none / not allowed)
 *   Ops.bulkLabel(kind)    "Bulk update Delivery by Excel"
 *   Ops.bulkConfig(kind)   the DFImport.bulk() config for that template
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops || !window.DFImport?.bulk) return;
  const $ = id => document.getElementById(id);
  const LINES = { "E-commerce operations": "ecommerce", "Banking & Financial operations": "document", "Customer parcels": "customer" };
  const PAGES = ["Shipments", ...Object.keys(LINES)];
  // Journey views with their own bulk template. Transfers has none: moving parcels between hubs goes
  // through linehaul bags and manifests, which have no bulk action yet.
  const STAGE_KINDS = { "New orders": "new_orders", Pickup: "pickup", "Hub desk": "hub_desk", Delivery: "delivery", Problems: "problems", Returns: "returns" };
  const PAGE_OF = { new_orders: "New orders", pickup: "Pickup", hub_desk: "Hub desk", delivery: "Delivery", problems: "Problems", returns: "Returns", all: "All parcels" };
  // The templates this person can use (a page whose actions they can't perform has no button).
  let kinds = null;
  (DF.bridgeReady || Promise.resolve())
    .then(() => (Ops.can("dispatch") ? DF.api("/bulk-updates/kinds") : null))
    .then(list => {
      if (list) kinds = list.map(k => k.kind);
    })
    .catch(() => undefined);
  Ops.bulkKindOf = view => {
    const kind = STAGE_KINDS[view];
    return kind && (!kinds || kinds.includes(kind)) ? kind : null;
  };
  Ops.bulkLabel = kind => `Bulk update ${PAGE_OF[kind] || "All parcels"} by Excel`;
  const STATUS_BY_LABEL = {
    "pending operations confirmation": "PENDING_CONFIRMATION",
    "pickup requested": "PENDING_CONFIRMATION",
    "pickup assigned": "PICKUP_ASSIGNED",
    "pickup confirmed": "PICKUP_CONFIRMED",
    "picked up": "PICKED_UP",
    "at hub": "AT_HUB",
    assigned: "ASSIGNED",
    "in transit": "IN_TRANSIT",
    "out for delivery": "OUT_FOR_DELIVERY",
    "retry scheduled": "RETRY_SCHEDULED",
    "return scheduled": "RETURN_SCHEDULED",
    exception: "EXCEPTION",
    delivered: "DELIVERED",
    "pickup cancelled": "PICKUP_CANCELLED",
    returned: "RETURNED",
  };

  async function merchants() {
    if (!Ops.cache.merchants?.value) Ops.cache.merchants = { value: await DF.api("/ops/merchants").catch(() => []), at: Date.now(), loading: false };
    return (Ops.cache.merchants.value || []).map(m => ({ id: m.id, code: m.code, name: m.name, type: m.type }));
  }

  /** The dialog starts from the page's own filters (status, merchant, created dates, "Needs info"); a journey page's template from its own. */
  async function config(kind = "all") {
    if (kind !== "all")
      return {
        mode: "bulk",
        bulkKind: kind,
        filters: {},
        merchants: await merchants(),
        hubs: Ops.myHubs() || DF.state.hubs,
        tones: { good: "status-good", warn: "status-warn", bad: "status-bad", info: "status-blue" },
        onDone: () => Ops.refresh().catch(() => undefined),
      };
    const page = Ops.page();
    const line = LINES[page];
    const list = (await merchants()).filter(m => !line || line === "customer" || (m.type === "BANKING_FINANCIAL") === (line === "document"));
    const filters = {};
    const status = $("statusFilter")?.value || "";
    if (status === "Needs info") filters.incomplete = true;
    else if (/^awaiting drop-off/i.test(status)) Object.assign(filters, { status: "PENDING_CONFIRMATION", intake: "DROP_OFF" });
    else if (STATUS_BY_LABEL[status.toLowerCase()]) filters.status = STATUS_BY_LABEL[status.toLowerCase()];
    const merchantName = $("merchantFilter")?.value;
    const merchant = merchantName && list.find(m => m.name === merchantName);
    if (merchant) filters.merchantId = merchant.id;
    if ($("shipmentDateField")?.value !== "status") {
      if ($("shipmentDateFrom")?.value) filters.from = $("shipmentDateFrom").value;
      if ($("shipmentDateTo")?.value) filters.to = $("shipmentDateTo").value;
    }
    return {
      mode: "bulk",
      bulkKind: "all",
      line,
      filters,
      merchants: line === "customer" ? [] : list,
      hubs: Ops.myHubs() || DF.state.hubs,
      tones: { good: "status-good", warn: "status-warn", bad: "status-bad", info: "status-blue" },
      onDone: () => Ops.refresh().catch(() => undefined),
    };
  }

  // The journey stage pages (bridge-nav.js) open the same dialog with their own filter preset.
  Ops.bulkConfig = config;

  window.addEventListener(
    "click",
    event => {
      const open = event.target.closest("#courierBulkUpdate");
      const history = event.target.closest("#courierBulkHistory");
      if (!open && !history) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!Ops.require("dispatch", "update parcels in bulk")) return;
      void config("all").then(cfg => (history ? DFImport.bulkHistory(cfg) : DFImport.bulk(cfg)));
    },
    true,
  );

  const baseEnhance = Ops.enhance["*"];
  Ops.enhance["*"] = page => {
    baseEnhance?.(page);
    if (!PAGES.includes(page) || $("courierBulkUpdate")) return;
    const actions = document.querySelector("#mainContent .page-heading .heading-actions");
    if (!actions) return;
    const anchor = $("courierImportHistory") || $("courierImport");
    const html = `<button class="button" id="courierBulkUpdate" type="button" title="Choose an action, download its Excel file with the filtered parcels, fill it in, upload and apply (every action)">${Ops.bulkLabel("all")}</button><button class="button" id="courierBulkHistory" type="button">Bulk update history</button>`;
    if (anchor) anchor.insertAdjacentHTML("afterend", html);
    else actions.insertAdjacentHTML("afterbegin", html);
  };
})();
