/*
 * Courier Operations: the Excel import (shared/importer.js, one engine with the merchant panels)
 * and incomplete orders ("Needs info").
 *
 *   Sample Excel / Import Excel     GET /imports/templates/:kind, the importer dialog: the category
 *   (shipment pages)                (Customer parcel / E-commerce / Banking & Financial), the merchant
 *                                   (searchable; none for customer parcels), first / last mile, drop-off
 *                                   hub and messages from that package; result
 *                                   with "Print labels" (Ops.labels → PDF, GET/POST /documents/labels)
 *   Import history                  GET /imports (operations imports)
 *   "Needs info"                    a badge on imported orders that miss delivery details, a status
 *                                   filter option (GET /parcels?incomplete=true) and "Edit details"
 *                                   completing them (POST /parcels/:id/complete, bridge.js)
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops || !window.DFImport) return;
  const $ = id => document.getElementById(id);
  const esc = Ops.esc;
  const NEEDS = "Needs info";
  const SHIPMENT_PAGES = ["Shipments", "Customer parcels", "E-commerce operations", "Banking & Financial operations"];
  const TONES = { good: "status-good", warn: "status-warn", bad: "status-bad", info: "status-blue" };

  async function merchants() {
    if (!Ops.cache.merchants?.value) Ops.cache.merchants = { value: await DF.api("/ops/merchants").catch(() => []), at: Date.now(), loading: false };
    return (Ops.cache.merchants.value || []).filter(m => m.status === "ACTIVE").map(m => ({ id: m.id, code: m.code, name: m.name, type: m.type }));
  }

  async function config() {
    const page = Ops.page();
    // The page's own category; Shipments offers all three.
    const kind = page === "Banking & Financial operations" ? "document" : page === "Customer parcels" ? "customer" : "ecommerce";
    const hubs = Ops.myHubs() || DF.state.hubs;
    return {
      kind,
      kinds: page === "Shipments" ? ["customer", "ecommerce", "document"] : undefined,
      forOps: true,
      merchants: await merchants(),
      hubs,
      hubId: Ops.myHubs()?.[0]?.id,
      tones: TONES,
      printLabels: ids => {
        const max = window.DFPrint.LIMITS.labels;
        if (ids.length > max) showToast(`Labels for the first ${max.toLocaleString("en-US")} of ${ids.length.toLocaleString("en-US")} parcels; print the rest from the shipment list.`);
        Ops.labels?.open(ids.slice(0, max), { description: `${Math.min(ids.length, max)} imported parcel${ids.length === 1 ? "" : "s"}. Stick each label on its parcel.` });
      },
      onDone: () => Ops.refresh().catch(() => undefined),
    };
  }
  /** The importer's operations config (Scan with phone hands its rows to the same dialog). */
  Ops.importConfig = config;

  window.addEventListener(
    "click",
    event => {
      const template = event.target.closest("#courierTemplate");
      const importer = event.target.closest("#courierImport");
      const history = event.target.closest("#courierImportHistory");
      if (!template && !importer && !history) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!Ops.require("dispatch", "import shipments")) return;
      void config().then(cfg => (template ? DFImport.template(cfg) : history ? DFImport.history(cfg) : DFImport.open(cfg)));
    },
    true,
  );

  // The page's hidden file input (02.js) goes to the importer too.
  window.addEventListener(
    "change",
    event => {
      if (event.target.id !== "courierBulkFile" || !event.target.files?.length) return;
      event.stopImmediatePropagation();
      const file = event.target.files[0];
      event.target.value = "";
      if (Ops.require("dispatch", "import shipments")) void config().then(cfg => DFImport.open({ ...cfg, file }));
    },
    true,
  );

  // ───────────── "Needs info" ─────────────

  const incomplete = s => !!s?._api?.incomplete;

  // A badge next to the tracking ID (the row text then also matches a search for "needs info").
  const baseRows = shipmentRows;
  shipmentRows = function (rows) {
    let html = baseRows(rows);
    for (const s of rows) {
      if (!incomplete(s)) continue;
      const cell = `<td class="tracking">${courierEscape(s.id)}<span class="subcell">`;
      const title = `Imported with details missing: ${(s._api.missingLabels || []).join(", ")}. Use Edit details to complete it before delivery.`;
      // The missing fields are listed under the badge too (all of them are needed before a delivery rider is assigned).
      const missing = `<span class="subcell" data-needs-missing style="color:#946200">Missing: ${esc((s._api.missingLabels || []).join(", "))}</span>`;
      html = html.replace(cell, `<td class="tracking">${courierEscape(s.id)} <span class="status status-warn" data-needs-info title="${esc(title)}">${NEEDS}</span>${missing}<span class="subcell">`);
    }
    return html;
  };

  // "Needs info" in the status filter shows the incomplete orders.
  const baseFilters = applyShipmentFilters;
  applyShipmentFilters = function () {
    const select = $("statusFilter");
    if (select?.value !== NEEDS) return baseFilters();
    select.value = "";
    try {
      baseFilters();
    } finally {
      select.value = NEEDS;
    }
    let shown = 0;
    document.querySelectorAll("#shipmentBody tr").forEach(row => {
      const s = shipments.find(item => item.id === row.dataset.shipmentId);
      if (!incomplete(s)) row.hidden = true;
      if (!row.hidden) shown++;
    });
    const count = $("shipmentBody")?.closest(".table-panel")?.querySelector(".shipment-count");
    if (count?.firstChild) count.firstChild.textContent = `Showing ${shown} matching shipments`;
  };

  const baseEnhance = Ops.enhance["*"];
  Ops.enhance["*"] = page => {
    baseEnhance?.(page);
    if (!SHIPMENT_PAGES.includes(page)) return;
    const select = $("statusFilter");
    if (select && ![...select.options].some(o => o.value === NEEDS)) {
      const n = Ops.countValue?.("detail.needsInfo") || 0; // GET /ops/stage-counts (bridge-lists.js)
      select.insertAdjacentHTML("beforeend", `<option value="${NEEDS}">${NEEDS}${n ? ` (${n})` : ""}</option>`);
    }
    const actions = document.querySelector("#mainContent .page-heading .heading-actions");
    const importButton = $("courierImport");
    if (actions && importButton && !$("courierImportHistory")) importButton.insertAdjacentHTML("afterend", `<button class="button" id="courierImportHistory" type="button">Import history</button>`);
    const sample = $("courierTemplate");
    if (sample) sample.textContent = "Excel template";
  };
})();
