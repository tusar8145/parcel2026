/*
 * Spreadsheet import, shared by the merchant panels (e-commerce and document) and Courier
 * Operations. One engine on the API (/imports); this file is its UI, drawn with the panel's own
 * CSS classes (modal, table, status pill, button):
 *
 *   DFImport.open(cfg)          choose file (+ operations: the category and the merchant (searchable) or
 *                               "Customer parcel"; first / last mile, drop-off hub and messages from that package)
 *                               → POST /imports/validate (dry run) → paginated preview with every
 *                               invalid cell highlighted → "Create N orders" → progress (live events
 *                               import.progress / import.completed) → result, failed-rows download, labels
 *   DFImport.history(cfg)       past imports with their numbers and downloads
 *   DFImport.template(cfg)      GET /imports/templates/:kind (.xlsx, built from live data)
 *   DFImport.complete(parcel, cfg)  completes an incomplete order ("Needs info") → POST /parcels/:id/complete
 *   DFImport.bulk(cfg)          Courier Operations "Bulk update by Excel" (cfg.mode = "bulk"): choose an action
 *                               (GET /bulk-updates/actions: the page's actions with counts), download its file
 *                               (GET /bulk-updates/export?action=), then the same upload → preview → apply →
 *                               progress → result steps on /bulk-updates (bulk_update.* events)
 *   DFImport.bulkHistory(cfg)   past bulk updates with their downloads, filtered by page
 *
 * cfg: { kind: "ecommerce"|"document"|"customer" (document = Banking & Financial; customer = customer parcels,
 *        operations only), kinds?: [...] (operations: the categories to choose from), merchantId?, forOps?,
 *        merchants?: [{id, code, name, type}],
 *        hubs?: [{id, name}], hubId?, tones?: { good, warn, bad, info }, noun?: "orders",
 *        printLabels?(trackingIds, job), onDone?(job) }
 * bulk cfg: { bulkKind?: "new_orders"|"pickup"|"hub_desk"|"delivery"|"problems"|"returns"|"all" (the page: its
 *        parcels and actions from GET /bulk-updates/kinds; default all), bulkAction?: "accept_pickup"|… (skip the
 *        "Choose an action" step), filters?: { preset, status,
 *        merchantId, hubId, intake, sla, from, to, incomplete }, line?: "ecommerce"|"document"|"customer",
 *        merchants?: [{id, code, name}], hubs?: [{id, name}], tones?, onDone?(job),
 *        applyExtra?(job) → HTML shown under the preview (apply options, e.g. Transfers: seal / trip),
 *        applyMount?(job) after it is drawn, applyBody?(job) → the apply request body (false = don't apply yet),
 *        resultExtra?(job) → HTML shown on the result step (e.g. the bags and trips a transfer made) }
 */
(() => {
  const DF = window.DF;
  if (!DF) return;
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = n => Number(n || 0).toLocaleString("en-US");
  const taka = n => (n == null ? "—" : `৳${Number(n).toLocaleString("en-BD", { maximumFractionDigits: 2 })}`);
  const toast = message => (typeof window.showToast === "function" ? window.showToast(message) : DF.toast?.(message));
  const describe = error => (error instanceof DF.ApiError ? DF.describe(error) : error?.message || String(error));
  const when = iso => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
  const PAGE_SIZE = 50;
  const ACCEPT = ".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const DEFAULT_TONES = { good: "status-good", warn: "status-warn", bad: "status-bad", info: "status-blue" };
  const ROW_STATUS = {
    VALID: ["Valid", "good"],
    INCOMPLETE: ["Needs info", "warn"],
    ERROR: ["Error", "bad"],
    CREATED: ["Created", "good"],
    FAILED: ["Not created", "bad"],
  };
  const JOB_STATUS = { VALIDATED: ["Not submitted", "info"], QUEUED: ["Queued", "info"], PROCESSING: ["Booking", "info"], COMPLETED: ["Completed", "good"], FAILED: ["Stopped", "bad"], DISCARDED: ["Discarded", "info"] };
  const MISSING = { recipientName: "recipient name", recipientPhone: "recipient phone", address: "delivery address", district: "district", zone: "zone" };

  /** Bulk updates (cfg.mode = "bulk") run the same dialog steps on their own endpoints, statuses and events. */
  const BULK_ROW_STATUS = {
    READY: ["Will apply", "good"],
    WARNING: ["Will apply · warning", "warn"],
    ERROR: ["Error", "bad"],
    APPLIED: ["Applied", "good"],
    ALREADY_DONE: ["Already done", "info"],
    FAILED: ["Not applied", "bad"],
  };
  const BULK_JOB_STATUS = { ...JOB_STATUS, PROCESSING: ["Applying", "info"] };
  const isBulk = (cfg = ui?.cfg) => cfg?.mode === "bulk";
  const base = () => (isBulk() ? "/bulk-updates" : "/imports");
  const rowStatus = () => (isBulk() ? BULK_ROW_STATUS : ROW_STATUS);
  const jobStatus = cfg => (isBulk(cfg) ? BULK_JOB_STATUS : JOB_STATUS);
  /** The page template of a bulk update (GET /bulk-updates/kinds): "new_orders", …, "all". */
  const bulkKind = (cfg = ui?.cfg) => cfg?.bulkKind || "all";
  const kindDef = (kind = bulkKind()) => (ui?.kinds || []).find(k => k.kind === kind);
  const pageOf = kind => kindDef(kind)?.page || (kind === "all" ? "All parcels" : kind);
  const bulkTitle = (cfg = ui?.cfg) => `Bulk update ${pageOf(bulkKind(cfg))} by Excel`;
  /** The chosen action of a bulk update (GET /bulk-updates/actions item), or null before step 1. */
  const bulkAction = () => ui?.action || null;

  let ui = null; // the open dialog: { cfg, step, job, rows, filter, page, file, unsubscribe, poll }

  const tone = (cfg, key) => (cfg.tones || DEFAULT_TONES)[key] || DEFAULT_TONES[key];
  const pill = (cfg, text, key) => `<span class="status ${tone(cfg, key)}">${esc(text)}</span>`;
  const noun = cfg => cfg.noun || (cfg.kind === "document" ? "consignments" : cfg.kind === "customer" ? "parcels" : "orders");
  /** The three bulk-create templates (API kinds; "document" is Banking & Financial). */
  const KIND_LABEL = { customer: "Customer parcel", ecommerce: "E-commerce", document: "Banking & Financial" };
  const MERCHANT_TYPE = { ecommerce: "ECOMMERCE", document: "BANKING_FINANCIAL" };
  /** Operations pick the merchant of an E-commerce / Banking & Financial file in the dialog (customer parcels have none). */
  const needsMerchant = (cfg = ui?.cfg) => !!cfg?.forOps && cfg.kind !== "customer";
  /** "1 order", "2 orders" */
  const nounFor = (cfg, n) => (n === 1 ? noun(cfg).replace(/s$/, "") : noun(cfg));
  const count = (cfg, n) => `${fmt(n)} ${nounFor(cfg, n)}`;
  const q = (path, params) => {
    const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""));
    return s.toString() ? `${path}?${s}` : path;
  };

  // ───────────── dialog shell ─────────────

  function close() {
    if (!ui) return;
    ui.unsubscribe?.forEach(off => off());
    clearInterval(ui.poll);
    // A checked file that wasn't submitted is dropped (nothing was created).
    if (ui.step === "preview" && ui.job?.status === "VALIDATED") DF.api(`${base()}/${ui.job.id}`, { method: "DELETE" }).catch(() => undefined);
    if (ui.step === "booking")
      toast(isBulk() ? `Bulk update ${ui.job?.number || ""} continues in the background. Open the bulk update history to follow it.` : `Import ${ui.job?.number || ""} continues in the background. Open the import history to follow it.`);
    document.getElementById("dfImportBackdrop")?.remove();
    const done = ui.cfg.onDone;
    const job = ui.job;
    ui = null;
    if (job && ["COMPLETED", "QUEUED", "PROCESSING"].includes(job.status)) done?.(job);
  }

  function draw(title, subtitle, body, actions) {
    let backdrop = document.getElementById("dfImportBackdrop");
    if (!backdrop) {
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div class="modal-backdrop open" id="dfImportBackdrop" role="dialog" aria-modal="true" aria-labelledby="dfImportTitle" style="z-index:120"><div class="modal" style="max-width:min(1120px,calc(100vw - 32px));max-height:calc(100vh - 40px);overflow:auto"><div class="modal-head"><div><h2 id="dfImportTitle"></h2><p id="dfImportSubtitle"></p></div><button type="button" class="modal-close" data-dfi="close" aria-label="Close">×</button></div><div id="dfImportBody"></div><div class="modal-actions" id="dfImportActions"></div></div></div>`,
      );
      backdrop = document.getElementById("dfImportBackdrop");
      backdrop.addEventListener("click", onClick);
      backdrop.addEventListener("change", onChange);
      backdrop.addEventListener("keydown", event => {
        if (event.key === "Enter" && event.target.id === "dfiJump") {
          event.preventDefault();
          void jump();
        }
      });
    }
    document.getElementById("dfImportTitle").textContent = title;
    document.getElementById("dfImportSubtitle").innerHTML = subtitle;
    document.getElementById("dfImportBody").innerHTML = body;
    document.getElementById("dfImportActions").innerHTML = actions;
  }
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && ui && document.getElementById("dfImportBackdrop")) close();
  });

  const button = (action, label, { primary = false, disabled = false, extra = "" } = {}) =>
    `<button type="button" class="button${primary ? " button-primary" : ""}" data-dfi="${action}" ${disabled ? "disabled" : ""} ${extra}>${esc(label)}</button>`;

  // ───────────── service package choices (first / last mile, drop hub, notifications) ─────────────

  /** First mile → the value of #dfiIntake (kept from the drop-off intake select) and its label. */
  const FIRST_MILE = { RIDER_PICKUP: ["PICKUP", "Rider pickup"], HUB_DROP: ["DROP_OFF", "Drop at hub"], ON_DEMAND_PICKUP: ["ON_DEMAND_PICKUP", "On-demand pickup"] };
  const LAST_MILE = { DOORSTEP: "Home delivery", HUB_COLLECT: "Hub Pickup" };
  const optionLabel = "display:grid;gap:5px;font-weight:600;font-size:13px";

  /**
   * The package the file books with: the merchant's (merchants; operations: the merchant chosen in the
   * dialog), the Customer default for customer parcels, none until operations choose the merchant.
   * Its options are the only first / last miles, hubs and messages offered.
   */
  async function loadPackage() {
    const { cfg } = ui;
    ui.pkg = null;
    try {
      if (!cfg.forOps) ui.pkg = await DF.api("/packages/me");
      else if (cfg.kind === "customer") ui.pkg = await DF.api(q("/packages/effective", { segment: "CUSTOMER" }));
      else if (ui.merchantId) ui.pkg = await DF.api(q("/packages/effective", { merchantId: ui.merchantId }));
    } catch (error) {
      ui.pkg = null;
      toast(describe(error));
    }
    if (!ui?.pkg) return;
    const o = ui.pkg.options;
    if (!o.firstMiles.includes(ui.firstMile)) ui.firstMile = o.defaultFirstMile || "RIDER_PICKUP";
    if (!o.lastMiles.includes(ui.lastMile)) ui.lastMile = o.defaultLastMile || "DOORSTEP";
    // Every message in the package is ticked, except the ones unticked earlier in this dialog.
    ui.notifications = new Set(ui.pkg.notifications.map(n => n.code).filter(c => !ui.unticked?.has(c)));
  }

  /** First mile (with its hub) and last mile for the whole file. */
  function packageOptions() {
    const { cfg, pkg } = ui;
    if (!pkg) return [];
    const out = [];
    const firsts = pkg.options.firstMiles;
    const lasts = pkg.options.lastMiles;
    if (firsts.length > 1 || cfg.forOps)
      out.push(
        `<label style="${optionLabel}">First mile<select class="select-small" id="dfiIntake">${firsts
          .map(f => `<option value="${FIRST_MILE[f][0]}" ${ui.firstMile === f ? "selected" : ""}>${esc(FIRST_MILE[f][1])}</option>`)
          .join("")}</select></label>`,
      );
    if (firsts.includes("HUB_DROP")) {
      const hubs = cfg.forOps ? cfg.hubs || [] : pkg.dropHubs || [];
      out.push(
        `<label style="${optionLabel}">Drop-off hub<select class="select-small" id="dfiHub" ${ui.firstMile === "HUB_DROP" ? "" : "disabled"}>${cfg.forOps ? "" : `<option value="">Choose the hub</option>`}${hubs
          .map(h => `<option value="${esc(h.id)}" ${h.id === (ui.hubId || cfg.hubId) ? "selected" : ""}>${esc(h.name)}</option>`)
          .join("")}</select></label>`,
      );
    }
    if (lasts.length > 1)
      out.push(`<label style="${optionLabel}">Last mile<select class="select-small" id="dfiLastMile">${lasts.map(l => `<option value="${l}" ${ui.lastMile === l ? "selected" : ""}>${esc(LAST_MILE[l])}</option>`).join("")}</select></label>`);
    return out;
  }

  /** The parcel messages of the package, all ticked; unticking one leaves it out for this file. */
  function notificationBox() {
    const { pkg } = ui;
    if (!pkg?.notifications?.length) return "";
    return `<fieldset id="dfiNotifications" style="border:1px solid #e3e8ef;border-radius:10px;padding:10px 12px;margin:0"><legend style="font-weight:600;font-size:13px;padding:0 4px">${esc(notificationLegend())}</legend>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:6px 12px;font-size:13px">${pkg.notifications
        .map(n => `<label style="display:flex;gap:7px;align-items:center"><input type="checkbox" data-dfi-notify="${esc(n.code)}" ${ui.notifications.has(n.code) ? "checked" : ""}> ${esc(n.title)}</label>`)
        .join("")}</div><p class="panel-subtitle" style="margin:6px 0 0;font-size:12px">Rows whose product doesn't send messages are booked without any.</p></fieldset>`;
  }
  const notificationLegend = () => `Messages to send for these ${noun(ui.cfg)} (${ui.notifications.size} of ${ui.pkg.notifications.length})`;
  const lastMileNote = () =>
    ui.pkg && ui.lastMile === "HUB_COLLECT"
      ? `<p class="panel-subtitle" style="margin:0">Hub Pickup: each order waits at the hub serving its recipient's zone; the recipient gets an SMS with the hub address and a collection code.</p>`
      : "";

  // ───────────── step 1: choose a file ─────────────

  async function open(cfg) {
    ui = { cfg: { tones: DEFAULT_TONES, ...cfg }, step: "choose", filter: "all", page: 1, filters: { ...(cfg.filters || {}) } };
    // Operations opening it for a known merchant (e.g. Scan with phone): that merchant is chosen already.
    if (cfg.forOps && cfg.merchantId && !isBulk(cfg)) ui.merchantId = cfg.merchantId;
    draw(isBulk(cfg) ? bulkTitle(cfg) : `Import ${noun(cfg)} from Excel`, "Loading the limits…", "", button("close", "Cancel"));
    try {
      const [limits, config] = isBulk(cfg)
        ? await Promise.all([DF.api("/bulk-updates/limits"), DF.api("/bulk-updates/kinds")])
        : await Promise.all([DF.api(q("/imports/limits", { merchantId: cfg.merchantId })), DF.api("/imports/config")]);
      if (!ui) return;
      ui.limits = limits;
      ui.config = isBulk(cfg) ? null : config;
      if (isBulk(cfg)) {
        ui.kinds = config;
        if (!kindDef()) throw new Error(`You can't use the ${pageOf(bulkKind())} bulk update.`);
      }
      if (!isBulk(cfg)) await loadPackage();
      if (!ui) return;
      // A file chosen before the dialog opened (e.g. the panel's own file input).
      if (cfg.file) pick(cfg.file);
      else chooseStep();
    } catch (error) {
      toast(describe(error));
      close();
    }
  }

  function chooseStep(message = "") {
    if (isBulk()) return bulkChooseStep(message);
    const { cfg, limits, config } = ui;
    ui.step = "choose";
    // The template's columns (COD and open box only when the package offers them; district / zone / area are found from the address).
    const columns = config.templates[cfg.kind].filter(c => c.inTemplate !== false && (!c.packageOnly || !ui.pkg || ui.pkg.options?.[c.packageOnly]));
    const required = columns.filter(c => c.required).map(c => c.header);
    const options = [];
    if (cfg.forOps) {
      if (cfg.kinds?.length > 1)
        options.push(
          `<label style="${optionLabel}">Category<select class="select-small" id="dfiKind">${cfg.kinds
            .map(k => `<option value="${k}" ${k === cfg.kind ? "selected" : ""}>${esc(KIND_LABEL[k] || k)}</option>`)
            .join("")}</select></label>`,
        );
      if (needsMerchant(cfg)) {
        const all = merchantsOf(cfg);
        options.push(
          // Searchable (shared/select-search.js): type a code or name in the list.
          `<label style="${optionLabel}">Merchant<select class="select-small" id="dfiMerchant" aria-label="Merchant" data-search>${merchantOptions(all)}</select></label>`,
        );
      }
    }
    options.push(...packageOptions());
    const choose = needsMerchant(cfg) && !ui.merchantId;
    const body = `<div style="display:grid;gap:14px">
      <div id="dfiLimits" style="padding:12px 14px;border-radius:10px;background:#f6f8fb;font-size:13px;line-height:1.55">
        <strong>Max ${esc(fmt(limits.maxRows))} rows and ${esc(limits.maxFileMb)} MB per file</strong> · ${cfg.forOps ? "Excel (.xlsx) or CSV: our template or any merchant's own file (you match its columns next)." : "Excel (.xlsx) or CSV with the template's headers."}<br>
        Required columns: <strong>${esc(required.join(", ") || "none")}</strong> (red headers with * in the template). Other columns may stay empty; a value you enter must be valid or the row is not created.<br>
        The recipient phone is required. Rows missing the recipient name, address or destination are created as <strong>Needs info</strong>, priced with defaults and held before delivery until completed.<br>
        First mile, the drop-off hub, last mile and the messages are chosen here for the whole file${cfg.forOps ? (cfg.kind === "customer" ? " (Customer package); the sender and pickup are in each row" : " (the merchant's package)") : ""}.
      </div>
      ${options.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:12px">${options.join("")}</div>` : ""}
      ${choose ? `<p class="panel-subtitle" id="dfiChooseMerchant" style="margin:0">Choose the merchant: the template's services, the choices above and the checks follow its package.</p>` : ""}
      ${lastMileNote()}
      ${notificationBox()}
      ${fileDrop()}
      ${message ? `<p role="alert" id="dfiMessage" style="margin:0;color:#b42318;font-weight:600">${esc(message)}</p>` : ""}
    </div>`;
    draw(
      `Import ${noun(cfg)} from Excel`,
      `${esc(KIND_LABEL[cfg.kind] || cfg.kind)} template${ui.merchantId && needsMerchant(cfg) ? ` · ${esc(merchantsOf(cfg).find(m => m.id === ui.merchantId)?.name || "")}` : ""} · the preview shows every row before anything is created.`,
      body,
      `<div style="margin-right:auto;display:flex;gap:8px;flex-wrap:wrap">${button("template", "Download template (.xlsx)")}${button("history", "Import history")}</div>${button("close", "Cancel")}${button("check", "Check file", { primary: true, disabled: !ui.file || choose })}`,
    );
    dropZone();
  }

  /** Active merchants of the dialog's category. */
  const merchantsOf = cfg => (cfg.merchants || []).filter(m => !m.type || m.type === MERCHANT_TYPE[cfg.kind]);
  /** The merchant select's options (searchable: shared/select-search.js). */
  function merchantOptions(all) {
    const placeholder = all.length ? `Choose the merchant (${all.length})` : "No active merchant in this category";
    return `<option value="">${esc(placeholder)}</option>${all.map(m => `<option value="${esc(m.id)}" ${m.id === ui.merchantId ? "selected" : ""}>${esc(`${m.code} · ${m.name}`)}</option>`).join("")}`;
  }

  // The shared "Choose file" drop zone (shared/file-input.js): click or drop, name and size, clear (×).
  const fileDrop = () => `<div id="dfiDrop"><input type="file" id="dfiFile" accept="${ACCEPT}" aria-label="The filled-in file" data-file-drop data-max-mb="${esc(ui.limits.maxFileMb)}"></div>`;

  /** Makes the file box a drop zone and shows the file already picked (the step re-renders after a pick). */
  function dropZone() {
    const input = document.getElementById("dfiFile");
    if (!input) return;
    if (DF.fileInput) DF.fileInput(input, { drop: true, maxMb: ui.limits.maxFileMb, file: ui.file || undefined });
  }

  function pick(file) {
    ui.file = null;
    ui.layout = null;
    if (!/\.(xlsx|csv)$/i.test(file.name)) return chooseStep(/\.xls$/i.test(file.name) ? "Old .xls files can't be read: save it as Excel Workbook (.xlsx)." : "Choose an Excel (.xlsx) or CSV file.");
    if (file.size > ui.limits.maxFileMb * 1024 * 1024) return chooseStep(`This file is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${ui.limits.maxFileMb} MB. Split it into smaller files.`);
    ui.file = file;
    chooseStep();
  }

  function readOptions() {
    if (isBulk()) return readBulkFilters();
    if (ui.cfg.forOps) ui.merchantId = needsMerchant() ? document.getElementById("dfiMerchant")?.value || "" : "";
    const first = document.getElementById("dfiIntake")?.value;
    if (first) ui.firstMile = Object.keys(FIRST_MILE).find(k => FIRST_MILE[k][0] === first) || "RIDER_PICKUP";
    ui.intake = ui.firstMile === "HUB_DROP" ? "DROP_OFF" : "PICKUP";
    ui.hubId = document.getElementById("dfiHub")?.value || "";
    ui.lastMile = document.getElementById("dfiLastMile")?.value || ui.lastMile;
    const boxes = [...document.querySelectorAll("[data-dfi-notify]")];
    if (boxes.length) {
      ui.notifications = new Set(boxes.filter(b => b.checked).map(b => b.dataset.dfiNotify));
      ui.unticked = new Set(boxes.filter(b => !b.checked).map(b => b.dataset.dfiNotify));
    }
  }

  // ───────────── step 2: check (dry run) and preview ─────────────

  async function check() {
    if (ui.step === "map") readMapping();
    else readOptions();
    const { cfg, file } = ui;
    if (!file) return;
    if (!isBulk() && needsMerchant() && !ui.merchantId) return chooseStep("Choose the merchant for this file.");
    if (!isBulk() && ui.firstMile === "HUB_DROP" && !ui.hubId) return chooseStep("Choose the hub the parcels are dropped at.");
    // Courier Operations: any merchant's file. The columns are matched (and can be corrected) first.
    if (mapsColumns() && !ui.layout) return void analyzeStep();
    // From the first step again (Back): show the matching before checking.
    if (mapsColumns() && ui.step === "choose") return mappingStep();
    if (mapsColumns()) {
      const problem = mappingProblem();
      if (problem) return mappingStep(problem);
    }
    ui.step = "checking";
    draw(`Checking ${file.name}`, `Reading the file and checking every row. Nothing ${isBulk() ? "changes" : "is created"} yet.`, `<p class="panel-subtitle" id="dfiChecking" style="padding:28px 0;text-align:center">Checking rows…</p>`, button("close", "Cancel"));
    const form = new FormData();
    if (!isBulk()) {
      form.append("kind", cfg.kind);
      if (cfg.merchantId) form.append("merchantId", cfg.merchantId);
      if (needsMerchant(cfg) && ui.merchantId) form.append("merchantId", ui.merchantId);
      if (ui.firstMile === "HUB_DROP") {
        form.append("intake", "DROP_OFF");
        form.append("dropOffHubId", ui.hubId);
      } else if (ui.pkg && ui.firstMile) form.append("firstMile", ui.firstMile);
      if (ui.pkg && ui.lastMile) form.append("lastMile", ui.lastMile);
      // The package's messages are the default; only an unticked one is sent.
      if (ui.pkg?.notifications?.length && ui.notifications.size !== ui.pkg.notifications.length) form.append("notifications", ui.notifications.size ? [...ui.notifications].join(",") : "none");
      if (mapsColumns() && ui.layout) form.append("mapping", JSON.stringify({ headerRow: ui.layout.headerRow, columns: ui.layout.columns.map(c => c.key || null) }));
    }
    form.append("file", file, file.name);
    try {
      const response = await DF.apiRaw(isBulk() ? q(`${base()}/validate`, { kind: bulkKind(), action: bulkAction()?.action }) : `${base()}/validate`, { method: "POST", body: form });
      const job = await response.json();
      if (!ui) return;
      ui.job = job;
      ui.rows = job.rows;
      ui.filter = "all";
      ui.page = 1;
      if (!isBulk()) await loadCatalog(); // the district / zone / area dropdowns of the preview
      if (!ui) return;
      preview();
    } catch (error) {
      if (!ui) return;
      if (mapsColumns() && ui.layout) return mappingStep(describe(error));
      chooseStep(describe(error));
    }
  }

  // ───────────── any merchant's file: match the columns (Courier Operations) ─────────────
  // POST /imports/analyze finds the header row (titles, blank lines, totals and notes are skipped) and
  // which column is which, from the headers and the data; the user corrects it; validate gets `mapping`.
  // A merchant's next file with the same headers is matched the same way (server side).

  const mapsColumns = () => !isBulk() && !!ui.cfg.forOps;
  const BY_LABEL = { saved: "as last time", header: "by its name", data: "by its data" };

  async function analyzeStep(headerRow) {
    const { cfg, file } = ui;
    ui.step = "analyzing";
    draw(`Reading ${file.name}`, "Finding the header row and which column is which…", `<p class="panel-subtitle" id="dfiAnalyzing" style="padding:28px 0;text-align:center">Reading the file…</p>`, button("close", "Cancel"));
    const form = new FormData();
    form.append("kind", cfg.kind);
    const merchantId = cfg.merchantId || (needsMerchant(cfg) ? ui.merchantId : "");
    if (merchantId) form.append("merchantId", merchantId);
    if (headerRow !== undefined) form.append("headerRow", String(headerRow));
    form.append("file", file, file.name);
    try {
      const response = await DF.apiRaw(`${base()}/analyze`, { method: "POST", body: form });
      const layout = await response.json();
      if (!ui) return;
      ui.layout = layout;
      // Our own template (or a Scan with phone workbook): nothing to match, check it straight away.
      if (layout.template && headerRow === undefined) {
        ui.step = "map";
        return void check();
      }
      mappingStep();
    } catch (error) {
      if (ui) chooseStep(describe(error));
    }
  }

  /** The choices in the table (kept when the step re-renders). */
  function readMapping() {
    if (!ui.layout) return;
    for (const select of document.querySelectorAll("[data-dfi-map]")) {
      const col = ui.layout.columns[Number(select.dataset.dfiMap)];
      if (!col) continue;
      const key = select.value || null;
      if (key !== col.key) col.by = null;
      col.key = key;
    }
  }

  /** What stops the check: the phone column(s) not chosen, or a field chosen twice. */
  function mappingProblem() {
    const { columns, fields } = ui.layout;
    const chosen = columns.map(c => c.key).filter(Boolean);
    const missing = fields.filter(f => f.required && !chosen.includes(f.key)).map(f => f.header);
    if (missing.length) return `Choose the ${missing.join(" and ")} column.`;
    const twice = fields.find(f => f.key !== "__address_part" && chosen.filter(k => k === f.key).length > 1);
    if (twice) return `${twice.header} is chosen for more than one column: keep one.`;
    return "";
  }

  function mappingStep(message = "") {
    const { layout, file } = ui;
    ui.step = "map";
    const fieldOptions = key =>
      `<option value="">Ignore this column</option>${layout.fields.map(f => `<option value="${esc(f.key)}" ${f.key === key ? "selected" : ""}>${esc(f.header)}${f.required ? " *" : ""}</option>`).join("")}`;
    const rows = layout.columns
      .map(
        c => `<tr data-dfi-map-row="${c.index}">
          <td class="primary-cell" style="white-space:nowrap">${esc(c.letter)}${c.header ? ` · ${esc(c.header)}` : ""}</td>
          <td style="max-width:340px">${c.samples.length ? c.samples.map(v => `<span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#586577">${esc(v)}</span>`).join("") : `<span style="color:#98a2ae">empty</span>`}</td>
          <td><select class="select-small" data-dfi-map="${c.index}" aria-label="Field for column ${esc(c.letter)}" style="min-width:210px${c.key ? "" : ";color:#98a2ae"}">${fieldOptions(c.key)}</select>${c.key && c.by ? `<small style="display:block;margin-top:3px;color:#16845b">Matched ${esc(BY_LABEL[c.by] || "")}</small>` : ""}</td>
        </tr>`,
      )
      .join("");
    const headerOptions = `<option value="0" ${layout.headerRow === 0 ? "selected" : ""}>No header row (data from row 1)</option>${layout.top
      .filter(t => t.text)
      .map(t => `<option value="${t.row}" ${t.row === layout.headerRow ? "selected" : ""}>Row ${t.row}: ${esc(t.text.slice(0, 90))}</option>`)
      .join("")}`;
    const body = `<div style="display:grid;gap:12px">
      <div id="dfiMapSummary" style="padding:12px 14px;border-radius:10px;background:#f6f8fb;font-size:13px;line-height:1.55">
        <strong>${esc(fmt(layout.orders))} order${layout.orders === 1 ? "" : "s"}</strong> found${layout.extraLines ? ` · ${esc(fmt(layout.extraLines))} other line${layout.extraLines === 1 ? "" : "s"} (titles, totals, notes) will be skipped` : ""}.
        ${layout.remembered ? "Matched as this merchant's last file with the same columns." : "Check each column's field; change any that is wrong, or ignore columns you don't need."}
        Columns set to <strong>Add to delivery address</strong> (e.g. a separate City or Thana) are added to the address; district, zone and area are found from it.
      </div>
      <label style="${optionLabel}">Header row<select class="select-small" id="dfiHeaderRow">${headerOptions}</select></label>
      <div class="table-scroll"><table id="dfiMapTable"><thead><tr><th>COLUMN IN THE FILE</th><th>VALUES</th><th>FIELD</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${message ? `<p role="alert" id="dfiMessage" style="margin:0;color:#b42318;font-weight:600">${esc(message)}</p>` : ""}
    </div>`;
    draw(`Match the columns of ${file.name}`, `${esc(KIND_LABEL[ui.cfg.kind] || ui.cfg.kind)}${ui.merchantId && needsMerchant() ? ` · ${esc(merchantsOf(ui.cfg).find(m => m.id === ui.merchantId)?.name || "")}` : ""} · any merchant's Excel or CSV. Nothing is created yet.`, body, `${button("map-back", "Back")}${button("check", "Check file", { primary: true })}`);
  }

  async function loadRows(filter = ui.filter, page = ui.page) {
    const rows = await DF.api(q(`${base()}/${ui.job.id}/rows`, { filter, page, pageSize: PAGE_SIZE }));
    if (!ui) return;
    ui.rows = rows;
    ui.filter = filter;
    ui.page = rows.page;
    if (ui.step === "preview") preview();
    else result();
  }

  // ───────────── preview corrections: the address inline, district / zone / area from the catalog ─────────────

  /** The address columns and their place columns (a changed address picks its places again on the server). */
  const PLACE_FAMILIES = [
    { address: "address", district: "district", zone: "zone", area: "area" },
    { address: "pickup_address", district: "pickup_district", zone: "pickup_zone", area: "pickup_area" },
  ];
  const familyOf = key => PLACE_FAMILIES.find(f => Object.values(f).includes(key));
  /** A checked file not submitted yet: its address and places can be corrected row by row (PATCH /imports/:id/rows/:row). */
  const editable = () => !isBulk() && ui?.step === "preview" && ui.job?.status === "VALIDATED" && !!ui.catalog;
  async function loadCatalog() {
    if (ui && !ui.catalog) ui.catalog = DF.state?.catalog || (await DF.api("/catalog").catch(() => null));
  }

  /** A correctable cell: an input for an address, a dropdown for a place (the row's district → zones → areas). */
  function editCell(r, c, value, problem, auto) {
    const f = familyOf(c.key);
    const tone = problem ? "border-color:#f3b4ad;background:#fdecea" : auto ? "background:#effaf3" : "";
    const title = problem ? `${c.header}: ${problem}` : auto ? `${c.header}: picked from the address (you can change it)` : c.header;
    const attrs = `data-dfi-edit="${esc(c.key)}" aria-label="${esc(`${c.header}, row ${r.rowNumber}`)}" title="${esc(title)}"`;
    if (c.key === f.address) return `<td data-col="${c.key}"${problem ? ' data-invalid="true"' : ""}><input class="table-search" ${attrs} value="${esc(value)}" style="width:230px;min-width:0;${tone}"></td>`;
    const k = ui.catalog;
    const cells = r.cells || {};
    let list = [];
    let empty = "Choose…";
    if (c.key === f.district) list = k.districts;
    else if (c.key === f.zone) {
      list = cells[f.district] ? k.zonesByDistrict[cells[f.district]] || [] : [...new Set(Object.values(k.zonesByDistrict).flat())].sort((a, b) => a.localeCompare(b));
      empty = cells[f.district] ? "Choose a zone" : "Choose a zone (any district)";
    } else {
      list = cells[f.zone] ? k.areasByZone[cells[f.zone]] || [] : [];
      empty = cells[f.zone] ? (list.length ? "Choose an area" : "No areas listed") : "Choose the zone first";
    }
    const unknown = value && !list.includes(value);
    const options = `<option value="">${esc(empty)}</option>${unknown ? `<option value="${esc(value)}" selected>${esc(value)} (not in the list)</option>` : ""}${list.map(o => `<option value="${esc(o)}"${o === value ? " selected" : ""}>${esc(o)}</option>`).join("")}`;
    return `<td data-col="${c.key}"${problem ? ' data-invalid="true"' : ""}><select class="select-small" ${attrs} style="width:150px;${tone}">${options}</select></td>`;
  }

  /** A corrected cell: the row is checked and priced again on the server; the table and the counts follow. */
  async function saveCell(el) {
    const tr = el.closest("tr[data-row]");
    const rowNumber = Number(tr?.dataset.row);
    const r = ui.rows.items.find(x => x.rowNumber === rowNumber);
    if (!r) return;
    const key = el.dataset.dfiEdit;
    const value = el.value.trim();
    const f = familyOf(key);
    const cells = { [key]: value || null };
    let detect = false;
    if (key === f.address) detect = true;
    else if (key === f.district) Object.assign(cells, { [f.zone]: null, [f.area]: null });
    else if (key === f.zone) {
      // A zone chosen with no (or another) district brings its district; the area starts again.
      const owner = Object.keys(ui.catalog.zonesByDistrict).find(d => ui.catalog.zonesByDistrict[d].includes(value));
      if (value && owner && owner !== r.cells?.[f.district]) cells[f.district] = owner;
      cells[f.area] = null;
    }
    // Only the template's columns (a customer file has no pickup area, for example).
    const known = new Set(ui.job.columns.map(c => c.key));
    for (const k of Object.keys(cells)) if (!known.has(k)) delete cells[k];
    const scroll = document.querySelector("#dfImportBody .table-scroll");
    const at = { top: scroll?.scrollTop || 0, left: scroll?.scrollLeft || 0 };
    el.disabled = true;
    try {
      const res = await DF.api(`/imports/${ui.job.id}/rows/${rowNumber}`, { method: "PATCH", body: { cells, ...(detect ? { detect: true } : {}) } });
      if (!ui) return;
      ui.job = { ...ui.job, ...res.job };
      ui.rows.items = ui.rows.items.map(x => (x.rowNumber === rowNumber ? res.row : x));
      preview();
      const again = document.querySelector("#dfImportBody .table-scroll");
      if (again) Object.assign(again, { scrollTop: at.top, scrollLeft: at.left });
    } catch (error) {
      el.disabled = false;
      toast(describe(error));
    }
  }

  function rowsTable(filters) {
    if (isBulk()) return bulkRowsTable(filters);
    const { cfg, job, rows } = ui;
    const columns = job.columns;
    const present = new Set(rows.items.flatMap(r => Object.keys(r.cells || {})));
    const canEdit = editable();
    // The address and its places are always shown (and correctable) when the template has them.
    const always = ["recipient_name", "recipient_phone", "address", "district", "zone", ...(canEdit ? ["area", "pickup_address", "pickup_district", "pickup_zone"] : [])];
    const shown = columns.filter(c => present.has(c.key) || c.required || always.includes(c.key));
    const missingCol = { recipientName: "recipient_name", recipientPhone: "recipient_phone", address: "address", district: "district", zone: "zone" };
    const body = rows.items
      .map(r => {
        const [label, key] = rowStatus()[r.status] || [r.status, "info"];
        const bad = new Map((r.errors || []).map(e => [e.column, e.message]));
        const missing = new Set((r.missing || []).map(m => missingCol[m]));
        const auto = new Set(r.autoFilled || []);
        const cells = shown
          .map(c => {
            const value = r.cells?.[c.key] ?? "";
            if (canEdit && familyOf(c.key)) return editCell(r, c, value, bad.get(c.key) || (r.status === "INCOMPLETE" && missing.has(c.key) ? "needed before delivery" : ""), auto.has(c.key));
            if (bad.has(c.key))
              return `<td data-col="${c.key}" data-invalid="true" title="${esc(`${c.header}: ${bad.get(c.key)}`)}" style="background:#fdecea;color:#b42318;box-shadow:inset 0 0 0 1px #f3b4ad;font-weight:600">${esc(value || "—")}</td>`;
            if (r.status === "INCOMPLETE" && missing.has(c.key)) return `<td data-col="${c.key}" data-missing="true" title="${esc(`${c.header}: needed before delivery`)}" style="background:#fff7e0;color:#946200">—</td>`;
            return `<td data-col="${c.key}">${esc(value)}</td>`;
          })
          .join("");
        const problems = r.errors?.length
          ? r.errors.map(e => `<div>${esc(e.text)}</div>`).join("")
          : r.status === "INCOMPLETE"
            ? `<span style="color:#946200">Needs ${esc(r.missing.map(m => MISSING[m] || m).join(", "))} before delivery</span>`
            : r.trackingId
              ? `<span class="tracking">${esc(r.trackingId)}</span>`
              : "";
        // The row's product has "Send SMS & email" off: booked with no messages, whatever is ticked above.
        const quiet = r.messagesOff && r.status !== "ERROR" ? `<div data-messages-off style="color:#637083">${esc(r.messagesNote || "This product doesn't send messages")}</div>` : "";
        // The row's price, with its breakdown (service packages) one click away.
        const charge = r.lines?.length
          ? `<details data-price="${esc(r.charge)}"><summary title="${esc(r.lines.map(l => `${l.label}: ${l.amount < 0 ? "−" : ""}৳${Math.abs(l.amount)}`).join("\n"))}" style="cursor:pointer">${esc(taka(r.charge))}</summary><div style="font-size:11px;line-height:1.5;color:#637083;white-space:nowrap">${r.lines
              .map(l => `<div>${esc(l.label)} · ${l.amount < 0 ? "−" : ""}৳${esc(Math.abs(l.amount))}</div>`)
              .join("")}</div></details>`
          : esc(taka(r.charge));
        return `<tr data-row="${r.rowNumber}" data-status="${r.status}"><td>${r.rowNumber}</td><td>${pill(cfg, label, key)}</td>${cells}<td style="white-space:nowrap" data-col="charge">${charge}</td><td style="min-width:260px;font-size:12px;line-height:1.45">${problems}${quiet}</td></tr>`;
      })
      .join("");
    const empty = `<tr><td colspan="${shown.length + 4}" class="empty-state">No rows match this filter.</td></tr>`;
    return `${filterBar(filters)}
      <div class="table-scroll" style="max-height:52vh;overflow:auto;border:1px solid #e3e8ef;border-radius:10px"><table id="dfiRows"><thead><tr><th>ROW</th><th>STATUS</th>${shown
        .map(c => `<th title="${esc(c.header)}">${esc(c.header.toUpperCase())}${c.required ? " *" : ""}</th>`)
        .join("")}<th>CHARGE</th><th>PROBLEMS</th></tr></thead><tbody>${body || empty}</tbody></table></div>${pager()}`;
  }

  /** The row filters above a preview or result table. */
  function filterBar(filters) {
    const filterButtons = filters
      .map(([value, label, count]) => `<button type="button" class="button button-sm${ui.filter === value ? " button-primary" : ""}" data-dfi="filter" data-filter="${value}" aria-pressed="${ui.filter === value}">${esc(label)}${count === undefined ? "" : ` (${fmt(count)})`}</button>`)
      .join("");
    return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin:12px 0" role="group" aria-label="Filter rows">${filterButtons}</div>`;
  }

  /** Page numbers below a preview or result table. */
  function pager() {
    const { rows } = ui;
    return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;font-size:13px" id="dfiPager">
      ${button("page", "‹ Previous", { disabled: rows.page <= 1, extra: `data-page="${rows.page - 1}"` })}
      <span id="dfiPageInfo">Page ${fmt(rows.page)} of ${fmt(rows.pages)} · ${fmt(rows.total)} row${rows.total === 1 ? "" : "s"}</span>
      ${button("page", "Next ›", { disabled: rows.page >= rows.pages, extra: `data-page="${rows.page + 1}"` })}
      <label style="margin-left:auto;display:flex;align-items:center;gap:6px">Go to page <input class="table-search" id="dfiJump" type="number" min="1" max="${rows.pages}" value="${rows.page}" style="width:80px"></label>${button("jump", "Go")}
    </div>`;
  }

  function summary(items) {
    return `<div id="dfiSummary" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${items.map(([text, key, id]) => `<span class="status ${tone(ui.cfg, key)}" data-count="${id}">${esc(text)}</span>`).join("")}</div>`;
  }

  function preview() {
    if (isBulk()) return bulkPreview();
    const { cfg, job } = ui;
    ui.step = "preview";
    const c = job.counts;
    const toBook = c.valid + c.incomplete;
    const s = job.services || {};
    const where = [
      job.intake === "DROP_OFF" ? ` · drop-off at ${job.dropOffHub?.name || "hub"}` : s.firstMileLabel ? ` · ${s.firstMileLabel.toLowerCase()}` : cfg.forOps ? " · rider pickup" : "",
      s.lastMileLabel ? ` · ${s.lastMileLabel.toLowerCase()}` : "",
      s.notifications ? ` · ${s.notifications.length} message${s.notifications.length === 1 ? "" : "s"}` : "",
    ].join("");
    const notes = [
      job.ignoredColumns?.length ? `Ignored columns (${ui.cfg.forOps ? "not matched to a field" : "not in the template"}): ${job.ignoredColumns.join(", ")}.` : "",
      job.skippedLines?.count ? `${fmt(job.skippedLines.count)} line${job.skippedLines.count === 1 ? "" : "s"} that ${job.skippedLines.count === 1 ? "isn't an order was" : "aren't orders were"} skipped (row${job.skippedLines.count === 1 ? "" : "s"} ${job.skippedLines.rows.slice(0, 12).join(", ")}${job.skippedLines.count > 12 ? ", …" : ""}).` : "",
      c.errors ? `Rows with errors are skipped: correct the address and places below, or fix them in your file and upload it again (download them with the reason for each).` : "",
      editable() ? `District, zone and area left out of the file are picked from the address (green). Change any address or place below: the row is checked and priced again.` : "",
    ].filter(Boolean);
    draw(
      `Preview · ${job.fileName || "upload"}`,
      `${esc(job.number)}${esc(where)} · nothing is created until you confirm.`,
      summary([
        [`${fmt(c.rows)} rows`, "info", "rows"],
        [`${fmt(c.valid)} valid`, "good", "valid"],
        [`${fmt(c.incomplete)} needs info`, "warn", "incomplete"],
        [`${fmt(c.errors)} with errors`, "bad", "errors"],
        // The delivery charges of every row that will be created (service packages).
        ...(job.totals && toBook ? [[`Total ৳${Number(job.totals.charge).toLocaleString("en-BD")} for ${count(cfg, toBook)}`, "info", "total"]] : []),
      ]) +
        (notes.length ? `<p class="panel-subtitle" style="margin:10px 0 0">${esc(notes.join(" "))}</p>` : "") +
        rowsTable([
          ["all", "All", c.rows],
          ["valid", "Valid", c.valid],
          ["incomplete", "Needs info", c.incomplete],
          ["error", "Errors", c.errors],
        ]),
      `<div style="margin-right:auto;display:flex;gap:8px;flex-wrap:wrap">${button("back", "Back · choose another file")}${c.errors ? button("failed", "Download rows with errors (.xlsx)") : ""}</div>${button(
        "commit",
        toBook ? `Create ${count(cfg, toBook)}` : "Nothing to create",
        { primary: true, disabled: !toBook },
      )}`,
    );
  }

  async function jump() {
    const n = Math.round(Number(document.getElementById("dfiJump")?.value));
    if (!n || n < 1 || n > ui.rows.pages) return toast(`Choose a page from 1 to ${ui.rows.pages}.`);
    await loadRows(ui.filter, n).catch(error => toast(describe(error)));
  }

  // ───────────── step 3: create (background booking with progress) ─────────────

  async function commit(target) {
    target.disabled = true;
    try {
      // Apply options of the page (Transfers: seal the bags, load them on a trip); false = not ready.
      const body = isBulk() && ui.cfg.applyBody ? await ui.cfg.applyBody(ui.job) : undefined;
      if (body === false) {
        target.disabled = false;
        return;
      }
      const job = await DF.api(isBulk() ? q(`/bulk-updates/${ui.job.id}/apply`, { kind: bulkKind(), action: ui.job.action || undefined }) : `/imports/${ui.job.id}/commit`, { method: "POST", ...(body ? { body } : {}) });
      if (!ui) return;
      ui.job = job;
      if (["COMPLETED", "FAILED"].includes(job.status)) return finish();
      booking();
    } catch (error) {
      target.disabled = false;
      toast(describe(error));
    }
  }

  function booking() {
    const { job } = ui;
    ui.step = "booking";
    const p = job.progress;
    draw(
      isBulk() ? `Applying changes · ${job.number}` : `Creating ${noun(ui.cfg)} · ${job.number}`,
      `This runs on the server: you can close this window and follow it in the ${isBulk() ? "bulk update" : "import"} history.`,
      `<div style="display:grid;gap:10px;padding:10px 0" id="dfiProgress"><div role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.percent}" style="height:12px;background:#eef1f5;border-radius:8px;overflow:hidden"><div id="dfiBar" style="height:100%;width:${p.percent}%;background:#3766e8;transition:width .4s"></div></div><p class="panel-subtitle" id="dfiProgressText" style="margin:0">${esc(`${fmt(p.processed)} of ${fmt(p.total)} rows processed (${p.percent}%)`)}</p></div>`,
      button("close", "Close · keep running"),
    );
    const update = data => {
      if (!ui || data?.id !== ui.job.id) return;
      void refreshJob();
    };
    const events = isBulk() ? ["bulk_update.progress", "bulk_update.completed"] : ["import.progress", "import.completed"];
    ui.unsubscribe = events.map(type => DF.events.on(type, update));
    // Safety poll in case the live stream is unavailable.
    ui.poll = setInterval(() => void refreshJob(), 3000);
  }

  async function refreshJob() {
    if (!ui?.job) return;
    try {
      const job = await DF.api(`${base()}/${ui.job.id}`);
      if (!ui) return;
      ui.job = job;
      if (["COMPLETED", "FAILED"].includes(job.status)) return finish();
      const bar = document.getElementById("dfiBar");
      if (bar) {
        bar.style.width = `${job.progress.percent}%`;
        bar.parentElement.setAttribute("aria-valuenow", job.progress.percent);
        document.getElementById("dfiProgressText").textContent = `${fmt(job.progress.processed)} of ${fmt(job.progress.total)} rows processed (${job.progress.percent}%)`;
      }
    } catch {}
  }

  async function finish() {
    ui.unsubscribe?.forEach(off => off());
    ui.unsubscribe = null;
    clearInterval(ui.poll);
    ui.step = "result";
    ui.filter = isBulk() ? (ui.job.result.notApplied ? "not_applied" : "all") : ui.job.result.notCreated ? "not_created" : "all";
    ui.page = 1;
    try {
      ui.rows = await DF.api(q(`${base()}/${ui.job.id}/rows`, { filter: ui.filter, page: 1, pageSize: PAGE_SIZE }));
    } catch {
      ui.rows = { items: [], page: 1, pages: 1, total: 0 };
    }
    if (ui) result();
  }

  function result() {
    if (isBulk()) return bulkResult();
    const { cfg, job } = ui;
    ui.step = "result";
    const r = job.result;
    const failed = job.status === "FAILED";
    const counts = summary([
      [`${fmt(r.created)} created`, "good", "created"],
      [`${fmt(r.createdIncomplete)} of them need info`, "warn", "incomplete"],
      [`${fmt(r.notCreated)} not created`, r.notCreated ? "bad" : "info", "notCreated"],
    ]);
    const lead = failed
      ? `<p role="alert" style="color:#b42318;font-weight:600;margin:0 0 10px">${esc(job.error || "The import stopped.")}</p>`
      : `<p style="margin:0 0 10px;font-size:14px" id="dfiResultText"><strong>${esc(fmt(r.created))}</strong> ${esc(nounFor(cfg, r.created))} created${r.createdIncomplete ? `, <strong>${esc(fmt(r.createdIncomplete))}</strong> marked “Needs info”` : ""}. <strong>${esc(fmt(r.notCreated))}</strong> row${r.notCreated === 1 ? "" : "s"} not created.</p>`;
    const rowsAvailable = job.rowsAvailable !== false;
    draw(
      failed ? `Import ${job.number} stopped` : `Import ${job.number} finished`,
      `${esc(job.fileName || "")}${job.batch ? ` · batch ${esc(job.batch.number)}` : ""}${job.intake === "DROP_OFF" ? ` · drop-off at ${esc(job.dropOffHub?.name || "hub")}` : ""}`,
      lead +
        counts +
        (rowsAvailable
          ? rowsTable([
              ["all", "All", job.counts.rows],
              ["created", "Created", r.created],
              ["not_created", "Not created", r.notCreated],
            ])
          : `<p class="panel-subtitle">The rows of this import are no longer kept.</p>`),
      `<div style="margin-right:auto;display:flex;gap:8px;flex-wrap:wrap">${r.notCreated && rowsAvailable ? button("failed", "Download rows not created (.xlsx)") : ""}${r.created && cfg.printLabels ? button("labels", `Print labels (${fmt(r.created)})`) : ""}${button("history", "Import history")}</div>${button("close", "Done", { primary: true })}`,
    );
  }

  // ───────────── downloads, labels, history ─────────────

  async function downloadFailed() {
    try {
      await DF.download(`${base()}/${ui.job.id}/failed-rows`, `${ui.job.number}-not-${isBulk() ? "applied" : "created"}.xlsx`);
      toast(`Rows not ${isBulk() ? "applied" : "created"} downloaded with an Error column. Fix them and upload the file again.`);
    } catch (error) {
      toast(describe(error));
    }
  }

  async function labels(job = ui.job) {
    try {
      const { trackingIds } = await DF.api(`/imports/${job.id}/tracking-ids`);
      if (!trackingIds.length) return toast("This import didn't create any parcels.");
      const cfg = ui?.cfg;
      if (ui) close();
      cfg?.printLabels?.(trackingIds, job);
    } catch (error) {
      toast(describe(error));
    }
  }

  async function template(cfg) {
    try {
      const name = await DF.download(q(`/imports/templates/${cfg.kind}`, { merchantId: cfg.merchantId }), `delivery-fast-${cfg.kind}-template.xlsx`);
      toast(`${name} downloaded. Required columns have red headers with *; the Instructions sheet explains every column.`);
    } catch (error) {
      toast(describe(error));
    }
  }

  async function history(cfg) {
    if (isBulk(cfg)) return bulkHistory(cfg);
    ui = ui && ui.cfg === cfg ? ui : { cfg: { tones: DEFAULT_TONES, ...cfg }, filter: "all", page: 1 };
    ui.step = "history";
    ui.job = null;
    draw("Import history", "Loading…", "", button("close", "Close"));
    try {
      const list = await DF.api(q("/imports", { merchantId: cfg.merchantId, kind: cfg.kind, limit: 50 }));
      if (!ui) return;
      ui.historyItems = list.items;
      const rows = list.items
        .map(j => {
          const [label, key] = jobStatus(ui.cfg)[j.status] || [j.status, "info"];
          const actions = [
            j.status === "VALIDATED" ? "" : `<button type="button" class="button button-sm" data-dfi="view" data-id="${esc(j.id)}">View</button>`,
            j.downloads.failedRows ? `<button type="button" class="button button-sm" data-dfi="failed" data-id="${esc(j.id)}">Not created (.xlsx)</button>` : "",
            j.result.created && ui.cfg.printLabels ? `<button type="button" class="button button-sm" data-dfi="labels" data-id="${esc(j.id)}">Labels</button>` : "",
          ].join(" ");
          return `<tr data-import="${esc(j.number)}"><td><strong>${esc(j.number)}</strong><span class="subcell" style="display:block;color:#8792a2;font-size:12px">${esc(j.fileName || "")}</span></td><td>${esc(when(j.createdAt))}<span class="subcell" style="display:block;color:#8792a2;font-size:12px">${esc(j.createdBy || "")}</span></td><td>${esc(j.merchant ? j.merchant.name : j.kind === "customer" ? "Customer parcels" : "—")}${j.intake === "DROP_OFF" ? `<span class="subcell" style="display:block;color:#8792a2;font-size:12px">Drop-off · ${esc(j.dropOffHub?.name || "")}</span>` : ""}</td><td>${fmt(j.counts.rows)}</td><td>${fmt(j.result.created)}</td><td>${fmt(j.result.createdIncomplete)}</td><td>${fmt(j.status === "COMPLETED" ? j.result.notCreated : j.counts.errors)}</td><td>${pill(ui.cfg, j.status === "PROCESSING" ? `${label} ${j.progress.percent}%` : label, key)}</td><td style="white-space:nowrap">${actions}</td></tr>`;
        })
        .join("");
      draw(
        "Import history",
        `${list.items.length ? `Your last ${fmt(list.items.length)} import${list.items.length === 1 ? "" : "s"}` : "No imports yet"} · each import is a booking batch with its own number.`,
        `<div class="table-scroll" style="max-height:60vh;overflow:auto"><table id="dfiHistory"><thead><tr><th>IMPORT</th><th>UPLOADED</th><th>MERCHANT</th><th>ROWS</th><th>CREATED</th><th>NEEDS INFO</th><th>NOT CREATED</th><th>STATUS</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="9" class="empty-state">No imports yet.</td></tr>`}</tbody></table></div>`,
        `${button("new", "New import")}${button("close", "Close", { primary: true })}`,
      );
    } catch (error) {
      toast(describe(error));
      close();
    }
  }

  async function view(id) {
    try {
      ui.job = await DF.api(`${base()}/${id}`);
      if (["QUEUED", "PROCESSING"].includes(ui.job.status)) return booking();
      await finish();
    } catch (error) {
      toast(describe(error));
    }
  }

  // ───────────── events ─────────────

  function onClick(event) {
    if (event.target.id === "dfImportBackdrop") return close();
    const el = event.target.closest("[data-dfi]");
    if (!el || !ui) return;
    const action = el.dataset.dfi;
    if (action === "close") return close();
    // The template's Service list follows the merchant's package (operations: the merchant chosen in the dialog).
    if (action === "template") {
      if (ui.step === "choose" && !isBulk()) readOptions();
      if (!isBulk() && needsMerchant() && !ui.merchantId && !ui.cfg.merchantId) return chooseStep("Choose the merchant first: the template's services follow its package.");
      return void template({ ...ui.cfg, merchantId: ui.cfg.merchantId || (needsMerchant() ? ui.merchantId : "") || undefined });
    }
    if (action === "download") return void bulkDownload(el);
    if (action === "preset") return bulkPreset(el.dataset.preset);
    if (action === "pick-action") return bulkPickAction(el.dataset.action);
    if (action === "actions") return void bulkActionStep();
    if (action === "history") return void history(ui.cfg);
    if (action === "new") return void open(ui.cfg);
    if (action === "check") return void check();
    if (action === "map-back") {
      readMapping();
      return chooseStep();
    }
    if (action === "back") {
      const job = ui.job;
      ui.job = null;
      if (job?.status === "VALIDATED") DF.api(`${base()}/${job.id}`, { method: "DELETE" }).catch(() => undefined);
      ui.file = null;
      return chooseStep();
    }
    if (action === "filter") return void loadRows(el.dataset.filter, 1).catch(error => toast(describe(error)));
    if (action === "page") return void loadRows(ui.filter, Number(el.dataset.page)).catch(error => toast(describe(error)));
    if (action === "jump") return void jump();
    if (action === "commit") return void commit(el);
    if (action === "failed") {
      if (el.dataset.id) return void DF.download(`${base()}/${el.dataset.id}/failed-rows`).catch(error => toast(describe(error)));
      return void downloadFailed();
    }
    if (action === "labels") {
      const job = el.dataset.id ? ui.historyItems?.find(j => j.id === el.dataset.id) : ui.job;
      return void labels(job);
    }
    if (action === "view") return void view(el.dataset.id);
  }

  function onChange(event) {
    if (!ui) return;
    if (event.target.id === "dfiHeaderRow" && ui.step === "map") return void analyzeStep(Number(event.target.value));
    if (event.target.matches?.("[data-dfi-map]")) {
      readMapping();
      return mappingStep();
    }
    if (event.target.matches?.("[data-dfi-edit]")) return void saveCell(event.target);
    if (event.target.id === "dfiFile") {
      readOptions();
      if (event.target.files?.[0]) return pick(event.target.files[0]);
      // Cleared with ×: back to "choose a file".
      if (ui.file) {
        ui.file = null;
        return chooseStep();
      }
      return;
    }
    if (event.target.id === "dfiKind") {
      readOptions();
      ui.layout = null;
      ui.cfg.kind = event.target.value;
      ui.merchantId = "";
      return void loadPackage().then(() => ui && chooseStep());
    }
    if (event.target.id === "dfiIntake") {
      const hub = document.getElementById("dfiHub");
      if (hub) hub.disabled = event.target.value !== "DROP_OFF";
      readOptions();
    }
    if (event.target.id === "dfiLastMile") {
      readOptions();
      return chooseStep();
    }
    if (event.target.dataset?.dfiNotify) {
      readOptions();
      const legend = document.querySelector("#dfiNotifications legend");
      if (legend) legend.textContent = notificationLegend();
    }
    // Bulk update history: one page's bulk updates, or every page's.
    if (event.target.id === "dfiHKind" && isBulk()) {
      ui.historyKind = event.target.value;
      return void bulkHistory(ui.cfg);
    }
    if (event.target.id === "dfiHAction" && isBulk()) {
      ui.historyAction = event.target.value;
      return void bulkHistory(ui.cfg);
    }
    // Operations: the merchant chosen for the file brings its package (choices, template columns).
    if (event.target.id === "dfiMerchant" && !isBulk()) {
      readOptions();
      ui.layout = null;
      return void loadPackage().then(() => ui && chooseStep());
    }
  }

  // ───────────── bulk updates (Courier Operations) ─────────────
  // Step 1 downloads the filtered parcels with action columns; the upload, preview, apply,
  // progress and result steps above run on /bulk-updates with these tables and counters.

  const STATUS_OPTIONS = [
    ["PENDING_CONFIRMATION", "Pending operations confirmation"],
    ["PICKUP_ASSIGNED", "Pickup assigned"],
    ["PICKUP_CONFIRMED", "Pickup confirmed"],
    ["PICKED_UP", "Picked up"],
    ["AT_HUB", "At hub"],
    ["ASSIGNED", "Assigned"],
    ["IN_TRANSIT", "In transit"],
    ["OUT_FOR_DELIVERY", "Out for delivery"],
    ["RETRY_SCHEDULED", "Retry scheduled"],
    ["RETURN_SCHEDULED", "Return scheduled"],
    ["EXCEPTION", "Exception"],
    ["DELIVERED", "Delivered"],
    ["PICKUP_CANCELLED", "Pickup cancelled"],
    ["RETURNED", "Returned"],
  ];
  const PRESETS = [
    ["pending_review", "Pending operations confirmation"],
    ["at_hub_unassigned", "At hub · no delivery rider"],
    ["needs_info", "Needs info"],
  ];
  const LINE_LABEL = { ecommerce: "E-commerce", document: "Documents", customer: "Customer parcels" };
  const field = (label, control) => `<label style="display:grid;gap:5px;font-weight:600;font-size:13px">${esc(label)}${control}</label>`;
  const selectOf = (id, options, value, all) =>
    `<select class="select-small" id="${id}"><option value="">${esc(all)}</option>${options.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;

  /**
   * Step 1: choose an action. The page's actions (GET /bulk-updates/actions?kind=) with a one-line
   * description and how many parcels can take it now (the page's filters).
   */
  async function bulkActionStep(message = "") {
    ui.step = "actions";
    ui.action = null;
    ui.file = null;
    ui.exportInfo = "";
    draw(bulkTitle(), "Loading the actions…", "", button("close", "Cancel"));
    try {
      const f = ui.filters;
      const list = await DF.api(
        q("/bulk-updates/actions", { kind: bulkKind(), preset: f.preset, status: f.status, merchantId: f.merchantId, hubId: f.hubId, intake: f.intake, sla: f.sla, incomplete: f.incomplete ? "true" : "", line: ui.cfg.line }),
      );
      if (!ui || ui.step !== "actions") return;
      ui.actions = list;
      // A page that opens the dialog for one action (cfg.bulkAction) skips this step once.
      if (ui.cfg.bulkAction && !ui.autoPicked) {
        ui.autoPicked = true;
        if (list.some(a => a.action === ui.cfg.bulkAction)) return bulkPickAction(ui.cfg.bulkAction);
      }
      const items = list
        .map(
          a => `<button type="button" class="dfi-action" data-dfi="pick-action" data-action="${esc(a.action)}" style="display:grid;gap:3px;text-align:left;padding:12px 14px;border:1px solid #e3e8ef;border-radius:10px;background:#fff;cursor:pointer;font:inherit">
            <span style="display:flex;gap:8px;align-items:baseline;justify-content:space-between"><strong style="font-size:14px">${esc(a.label)}</strong><span class="status ${tone(ui.cfg, a.count ? "info" : "warn")}" data-count="${esc(a.action)}">${esc(fmt(a.count))} parcel${a.count === 1 ? "" : "s"}</span></span>
            <span class="panel-subtitle" style="font-size:13px">${esc(a.summary)}</span>
          </button>`,
        )
        .join("");
      draw(
        bulkTitle(),
        "Choose an action → download its Excel file → fill it in → upload → check the preview → apply. Each action has its own file with only the parcels and columns it needs.",
        `<div style="display:grid;gap:10px"><h3 style="margin:0;font-size:15px">1 · Choose an action</h3><div id="dfiActions" data-kind="${esc(bulkKind())}" role="list" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px">${items}</div>${
          message ? `<p role="alert" id="dfiMessage" style="margin:0;color:#b42318;font-weight:600">${esc(message)}</p>` : ""
        }</div>`,
        `<div style="margin-right:auto;display:flex;gap:8px;flex-wrap:wrap">${button("history", "Bulk update history")}</div>${button("close", "Cancel")}`,
      );
    } catch (error) {
      toast(describe(error));
      close();
    }
  }

  function bulkPickAction(action) {
    ui.action = (ui.actions || []).find(a => a.action === action) || null;
    if (!ui.action) return void bulkActionStep();
    ui.file = null;
    ui.exportInfo = "";
    bulkChooseStep();
  }

  /** What the chosen action's file does and what to fill in. */
  function actionInfo() {
    const a = bulkAction();
    if (!a) return "";
    return `<section id="dfiActionInfo" data-action="${esc(a.action)}" style="padding:12px 14px;border-radius:10px;background:#f6f8fb;font-size:13px;line-height:1.55">
        <strong style="display:block;margin-bottom:4px">${esc(a.title)}</strong>
        <span style="display:block;margin-bottom:4px">${esc(a.howTo)}</span>
        <span class="panel-subtitle" style="display:block;margin-bottom:4px">${esc(a.does)} The file lists ${esc(a.parcels)}: ${esc(fmt(a.count))} now.</span>
        <span>Columns to fill in: <strong>${esc(a.fill.join(", "))}</strong> (* = required). The other columns are the parcel's data (grey, locked). There is no Action column: the file is "${esc(a.label)}".</span>
      </section>`;
  }

  function bulkChooseStep(message = "") {
    if (!bulkAction()) return void bulkActionStep(message);
    const { cfg, limits } = ui;
    const f = ui.filters;
    const def = kindDef();
    const a = bulkAction();
    ui.step = "choose";
    const presets = PRESETS.filter(([v]) => !def || def.presets.includes(v)).map(
      ([v, l]) => `<button type="button" class="button button-sm${f.preset === v ? " button-primary" : ""}" data-dfi="preset" data-preset="${v}" aria-pressed="${f.preset === v}">${esc(l)}</button>`,
    ).join("");
    const fields = [
      field("Status", selectOf("dfiBStatus", def && def.kind !== "all" ? def.statuses.map(s => [s.value, s.label]) : STATUS_OPTIONS, f.status, def && def.kind !== "all" ? `Every ${def.page} status` : "All statuses")),
      field("Merchant", selectOf("dfiBMerchant", (cfg.merchants || []).map(m => [m.id, `${m.code} · ${m.name}`]), f.merchantId, "All merchants")),
      field("Hub", selectOf("dfiBHub", (cfg.hubs || []).map(h => [h.id, h.name]), f.hubId, cfg.hubs?.length === 1 ? "My hub's work" : "All hubs")),
      field("Intake", selectOf("dfiBIntake", [["PICKUP", "Rider pickup"], ["DROP_OFF", "Drop-off at hub"]], f.intake, "Pickup and drop-off")),
      field("SLA state", selectOf("dfiBSla", [["AWAITING_REVIEW", "Awaiting review"], ["ON_TRACK", "On track"], ["AT_RISK", "At risk"], ["BREACHED", "Breached"]], f.sla, "Any")),
      field("Created from", `<input class="table-search" type="date" id="dfiBFrom" value="${esc(f.from || "")}">`),
      field("Created to", `<input class="table-search" type="date" id="dfiBTo" value="${esc(f.to || "")}">`),
      `<label style="display:flex;gap:8px;align-items:center;font-weight:600;font-size:13px;padding-top:18px"><input type="checkbox" id="dfiBNeeds" ${f.incomplete ? "checked" : ""}> Needs info only</label>`,
    ];
    const body = `<div style="display:grid;gap:18px">
      <section id="dfiExport" style="display:grid;gap:10px">
        <h3 style="margin:0;font-size:15px">2 · Download the "${esc(a.label)}" file</h3>
        ${actionInfo()}
        <p class="panel-subtitle" style="margin:0">${presets ? "Choose a quick filter or set your own" : "Narrow it with the filters below if you like"}${cfg.line ? ` (service line: <strong>${esc(LINE_LABEL[cfg.line])}</strong>)` : ""}. Only the parcels that can take this action are in the file. <strong>Max ${esc(fmt(limits.maxRows))} parcels per file.</strong></p>
        <div role="group" aria-label="Quick filters" style="display:flex;gap:6px;flex-wrap:wrap">${presets}${button("preset", "Clear filters", { extra: 'data-preset=""' })}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">${fields.join("")}</div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${button("download", `Download "${a.label}" file (.xlsx)`, { primary: true, extra: 'id="dfiBDownload"' })}<span class="panel-subtitle" id="dfiExportInfo" role="status">${esc(ui.exportInfo || "")}</span></div>
      </section>
      <section style="display:grid;gap:10px">
        <h3 style="margin:0;font-size:15px">3 · Upload the filled-in file</h3>
        <p class="panel-subtitle" style="margin:0">Every row is checked first (lifecycle, hub, rider, details and whether the parcel changed since you downloaded it). Only a "${esc(a.label)}" file is accepted here. Nothing changes until you press Apply. Max ${esc(fmt(limits.maxRows))} rows and ${esc(limits.maxFileMb)} MB.</p>
        ${fileDrop()}
      </section>
      ${message ? `<p role="alert" id="dfiMessage" style="margin:0;color:#b42318;font-weight:600">${esc(message)}</p>` : ""}
    </div>`;
    draw(
      bulkTitle(),
      `${esc(a.title)} · download → fill in → upload → check the preview → apply. Each row is applied on its own, exactly like the single action.`,
      body,
      `<div style="margin-right:auto;display:flex;gap:8px;flex-wrap:wrap">${button("actions", "‹ Change action")}${button("history", "Bulk update history")}</div>${button("close", "Cancel")}${button("check", "Check file", { primary: true, disabled: !ui.file })}`,
    );
    dropZone();
  }

  function readBulkFilters() {
    const value = id => document.getElementById(id)?.value || "";
    if (!document.getElementById("dfiBStatus")) return;
    Object.assign(ui.filters, {
      status: value("dfiBStatus"),
      merchantId: value("dfiBMerchant"),
      hubId: value("dfiBHub"),
      intake: value("dfiBIntake"),
      sla: value("dfiBSla"),
      from: value("dfiBFrom"),
      to: value("dfiBTo"),
      incomplete: !!document.getElementById("dfiBNeeds")?.checked,
    });
  }

  function bulkPreset(preset) {
    readBulkFilters();
    ui.filters = preset && ui.filters.preset !== preset ? { preset } : {};
    bulkChooseStep();
  }

  function bulkQuery() {
    const f = ui.filters;
    const day = (d, end) => (d ? new Date(`${d}T${end ? "23:59:59.999" : "00:00:00"}`).toISOString() : "");
    return q("/bulk-updates/export", {
      kind: bulkKind(),
      action: bulkAction()?.action,
      preset: f.preset,
      status: f.status,
      merchantId: f.merchantId,
      hubId: f.hubId,
      intake: f.intake,
      sla: f.sla,
      from: day(f.from),
      to: day(f.to, true),
      incomplete: f.incomplete ? "true" : "",
      line: ui.cfg.line,
    });
  }

  async function bulkDownload(target) {
    readBulkFilters();
    target.disabled = true;
    const info = document.getElementById("dfiExportInfo");
    if (info) info.textContent = "Preparing the file…";
    try {
      const response = await DF.apiRaw(bulkQuery());
      const count = Number(response.headers.get("x-row-count") || 0);
      const matched = Number(response.headers.get("x-matched") || count);
      const limit = Number(response.headers.get("x-row-limit") || 0);
      if (!count) {
        ui.exportInfo = `No parcels can take "${bulkAction()?.label}" with these filters.`;
      } else {
        const name = (response.headers.get("content-disposition") || "").match(/filename="?([^";]+)"?/)?.[1] || "delivery-fast-bulk-update.xlsx";
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        ui.exportInfo =
          matched > count
            ? `Downloaded the first ${fmt(count)} of ${fmt(matched)} parcels (limit ${fmt(limit)} per file). Narrow the filters for the rest.`
            : `Downloaded ${fmt(count)} parcel${count === 1 ? "" : "s"}. ${bulkAction()?.skipBlank ? "Fill in the rows to change (empty rows are skipped)" : "Delete the rows you don't want to change"}, save, and upload it below.`;
      }
      toast(ui.exportInfo);
    } catch (error) {
      ui.exportInfo = describe(error);
      toast(ui.exportInfo);
    }
    if (!ui || ui.step !== "choose") return;
    target.disabled = false;
    const el = document.getElementById("dfiExportInfo");
    if (el) el.textContent = ui.exportInfo;
  }


  function bulkRowsTable(filters) {
    const { job, rows } = ui;
    const header = new Map(job.columns.map(c => [c.key, c.header]));
    // Tracking ID, status and the action's input columns (the Set … ones and Priority only when used).
    const keys = new Set(["tracking_id", "status", ...job.columns.filter(c => c.editable && !c.key.startsWith("set_") && c.key !== "priority").map(c => c.key)]);
    for (const r of rows.items) {
      for (const k of Object.keys(r.cells || {})) if (k.startsWith("set_") || k === "priority") keys.add(k);
      for (const e of [...r.errors, ...r.warnings]) if (header.has(e.column)) keys.add(e.column);
    }
    const shown = job.columns.filter(c => keys.has(c.key));
    // Rows that re-price the parcel (completion, intake change): its charge now → after applying.
    const priced = rows.items.some(r => r.plan?.price);
    const priceCell = r => {
      const p = r.plan?.price;
      if (!priced) return "";
      if (!p) return `<td data-col="price"></td>`;
      const d = p.difference;
      const diff = d ? ` <span style="color:${d > 0 ? "#b42318" : "#067647"};font-weight:600">(${d > 0 ? "+" : "−"}${esc(taka(Math.abs(d)))})</span>` : ` <span style="color:#637083">(no change)</span>`;
      return `<td data-col="price" data-price-before="${esc(p.before)}" data-price-after="${esc(p.after)}" style="white-space:nowrap">${esc(taka(p.before))} → <strong>${esc(taka(p.after))}</strong>${diff}</td>`;
    };
    const body = rows.items
      .map(r => {
        const [label, key] = rowStatus()[r.status] || [r.status, "info"];
        const bad = new Map(r.errors.map(e => [e.column, e.message]));
        const warned = new Map(r.warnings.map(e => [e.column, e.message]));
        const cells = shown
          .map(c => {
            let value = r.cells?.[c.key] ?? "";
            if (c.key === "rider" && !value && r.plan?.usedSuggestion) value = `${r.cells?.suggested_rider || ""} (suggested)`;
            if (bad.has(c.key))
              return `<td data-col="${c.key}" data-invalid="true" title="${esc(`${c.header}: ${bad.get(c.key)}`)}" style="background:#fdecea;color:#b42318;box-shadow:inset 0 0 0 1px #f3b4ad;font-weight:600">${esc(value || "—")}</td>`;
            if (warned.has(c.key)) return `<td data-col="${c.key}" data-warning="true" title="${esc(`${c.header}: ${warned.get(c.key)}`)}" style="background:#fff7e0;color:#946200">${esc(value || "—")}</td>`;
            return `<td data-col="${c.key}"${c.key === "tracking_id" ? ' class="tracking"' : ""}>${esc(value)}</td>`;
          })
          .join("");
        const notes = [
          ...r.errors.map(e => `<div>${esc(e.text)}</div>`),
          ...r.warnings.map(e => `<div style="color:#946200">${esc(e.text)}</div>`),
          r.result ? `<div style="color:${r.status === "APPLIED" ? "#067647" : "#475467"}">${esc(r.result)}</div>` : "",
        ].join("");
        return `<tr data-row="${r.rowNumber}" data-status="${r.status}" data-tracking="${esc(r.trackingId || r.cells?.tracking_id || "")}"><td>${r.rowNumber}</td><td>${pill(ui.cfg, label, key)}</td>${cells}${priceCell(r)}<td style="min-width:280px;font-size:12px;line-height:1.45">${notes}</td></tr>`;
      })
      .join("");
    const empty = `<tr><td colspan="${shown.length + 3 + (priced ? 1 : 0)}" class="empty-state">No rows match this filter.</td></tr>`;
    return `${filterBar(filters)}
      <div class="table-scroll" style="max-height:52vh;overflow:auto;border:1px solid #e3e8ef;border-radius:10px"><table id="dfiRows"><thead><tr><th>ROW</th><th>STATUS</th>${shown
        .map(c => `<th title="${esc(c.header)}">${esc(c.header.toUpperCase())}</th>`)
        .join("")}${priced ? `<th title="Delivery charge now → after this change">PRICE</th>` : ""}<th>PROBLEMS / RESULT</th></tr></thead><tbody>${body || empty}</tbody></table></div>${pager()}`;
  }

  /** "Re-priced: ৳1,200 → ৳1,350 (+৳150) on 3 rows". */
  function priceSummary(p) {
    const d = p.difference;
    return `Re-priced: ${taka(p.before)} → ${taka(p.after)} (${d > 0 ? "+" : d < 0 ? "−" : "±"}${taka(Math.abs(d))}) on ${fmt(p.rows)} row${p.rows === 1 ? "" : "s"}`;
  }

  function bulkPreview() {
    const { job } = ui;
    ui.step = "preview";
    const c = job.counts;
    const notes = [
      c.ignored ? `${fmt(c.ignored)} row${c.ignored === 1 ? "" : "s"} with nothing filled in ${c.ignored === 1 ? "was" : "were"} skipped.` : "",
      job.ignoredColumns?.length ? `Ignored columns (not in the download): ${job.ignoredColumns.join(", ")}.` : "",
      c.errors ? "Rows with errors are skipped: fix them in your file and upload it again, or download them with the reason for each." : "",
      c.warnings ? "Rows with warnings are applied; check them first." : "",
    ].filter(Boolean);
    draw(
      `Preview · ${job.fileName || "upload"}`,
      `${esc(job.number)} · ${esc(job.title || job.kindTitle || "")} · nothing changes until you apply.`,
      summary([
        [`${fmt(c.rows)} row${c.rows === 1 ? "" : "s"} checked`, "info", "rows"],
        [`${fmt(c.toApply)} will apply`, "good", "apply"],
        [`${fmt(c.warnings)} with warnings`, "warn", "warnings"],
        [`${fmt(c.errors)} with errors`, "bad", "errors"],
        [`${fmt(c.alreadyDone)} already done`, "info", "alreadyDone"],
        ...(job.pricing?.rows ? [[priceSummary(job.pricing), job.pricing.difference > 0 ? "warn" : "info", "price"]] : []),
      ]) +
        (notes.length ? `<p class="panel-subtitle" style="margin:10px 0 0">${esc(notes.join(" "))}</p>` : "") +
        bulkRowsTable([
          ["all", "All", c.rows],
          ["apply", "Will apply", c.toApply],
          ["warning", "Warnings", c.warnings],
          ["error", "Errors", c.errors],
          ...(c.alreadyDone ? [["already_done", "Already done", c.alreadyDone]] : []),
        ]) +
        (c.toApply && ui.cfg.applyExtra ? ui.cfg.applyExtra(job) || "" : ""),
      `<div style="margin-right:auto;display:flex;gap:8px;flex-wrap:wrap">${button("back", "Back · choose another file")}${c.errors ? button("failed", "Download rows with errors (.xlsx)") : ""}</div>${button(
        "commit",
        c.toApply ? `Apply ${fmt(c.toApply)} row${c.toApply === 1 ? "" : "s"}` : "Nothing to apply",
        { primary: true, disabled: !c.toApply },
      )}`,
    );
    if (c.toApply) ui.cfg.applyMount?.(job);
  }

  function bulkResult() {
    const { job } = ui;
    ui.step = "result";
    const r = job.result;
    const failed = job.status === "FAILED";
    const lead = failed
      ? `<p role="alert" style="color:#b42318;font-weight:600;margin:0 0 10px">${esc(job.error || "The bulk update stopped.")}</p>`
      : `<p style="margin:0 0 10px;font-size:14px" id="dfiResultText"><strong>${esc(fmt(r.applied))}</strong> row${r.applied === 1 ? "" : "s"} applied, <strong>${esc(fmt(r.alreadyDone))}</strong> already done (skipped), <strong>${esc(fmt(r.notApplied))}</strong> not applied.</p>`;
    const rowsAvailable = job.rowsAvailable !== false;
    draw(
      failed ? `Bulk update ${job.number} stopped` : `Bulk update ${job.number} finished`,
      esc([job.title || job.kindTitle, job.fileName].filter(Boolean).join(" · ")),
      lead +
        (ui.cfg.resultExtra ? ui.cfg.resultExtra(job) || "" : "") +
        summary([
          [`${fmt(r.applied)} applied`, "good", "applied"],
          [`${fmt(r.alreadyDone)} already done`, "info", "alreadyDone"],
          [`${fmt(r.notApplied)} not applied`, r.notApplied ? "bad" : "info", "notApplied"],
        ]) +
        (rowsAvailable
          ? bulkRowsTable([
              ["all", "All", job.counts.rows],
              ["applied", "Applied", r.applied],
              ["already_done", "Already done", r.alreadyDone],
              ["not_applied", "Not applied", r.notApplied],
            ])
          : `<p class="panel-subtitle">The rows of this bulk update are no longer kept.</p>`),
      `<div style="margin-right:auto;display:flex;gap:8px;flex-wrap:wrap">${r.notApplied && rowsAvailable ? button("failed", "Download rows not applied (.xlsx)") : ""}${button("history", "Bulk update history")}</div>${button("close", "Done", { primary: true })}`,
    );
  }

  async function bulkHistory(cfg) {
    ui = ui && ui.cfg.mode === "bulk" ? ui : { cfg: { tones: DEFAULT_TONES, ...cfg, mode: "bulk" }, filter: "all", page: 1, filters: { ...(cfg.filters || {}) } };
    ui.step = "history";
    ui.job = null;
    // A page's history starts with that page's bulk updates; All parcels shows every page's.
    ui.historyKind ??= bulkKind() === "all" ? "" : bulkKind();
    draw("Bulk update history", "Loading…", "", button("close", "Close"));
    try {
      const [list, kinds] = await Promise.all([DF.api(q("/bulk-updates", { limit: 50, kind: ui.historyKind, action: ui.historyAction })), ui.kinds ? ui.kinds : DF.api("/bulk-updates/kinds").catch(() => [])]);
      if (!ui) return;
      ui.kinds = kinds;
      const kindFilter = `<label style="display:flex;gap:8px;align-items:center;font-weight:600;font-size:13px;margin-bottom:10px">Page<select class="select-small" id="dfiHKind"><option value="">Every page</option>${kinds
        .map(k => `<option value="${esc(k.kind)}" ${k.kind === ui.historyKind ? "selected" : ""}>${esc(k.title)}</option>`)
        .join("")}</select></label>`;
      // Actions of the chosen page (every page: every action).
      const actionOptions = [...new Map((ui.historyKind ? kinds.filter(k => k.kind === ui.historyKind) : kinds).flatMap(k => k.actions).map(a => [a.action, a.label])).entries()];
      const actionFilter = `<label style="display:flex;gap:8px;align-items:center;font-weight:600;font-size:13px;margin-bottom:10px">Action<select class="select-small" id="dfiHAction"><option value="">Every action</option>${actionOptions
        .map(([value, label]) => `<option value="${esc(value)}" ${value === ui.historyAction ? "selected" : ""}>${esc(label)}</option>`)
        .join("")}</select></label>`;
      const rows = list.items
        .map(j => {
          const [label, key] = BULK_JOB_STATUS[j.status] || [j.status, "info"];
          const actions = [
            j.status === "VALIDATED" ? "" : `<button type="button" class="button button-sm" data-dfi="view" data-id="${esc(j.id)}">View</button>`,
            j.downloads.failedRows ? `<button type="button" class="button button-sm" data-dfi="failed" data-id="${esc(j.id)}">Not applied (.xlsx)</button>` : "",
          ].join(" ");
          const done = j.status === "COMPLETED";
          return `<tr data-bulk="${esc(j.number)}" data-kind="${esc(j.kind || "all")}" data-action="${esc(j.action || "")}"><td><strong>${esc(j.number)}</strong><span class="subcell" style="display:block;color:#8792a2;font-size:12px">${esc(j.fileName || "")}</span></td><td data-col="kind">${esc(j.title || j.kindTitle || "")}</td><td>${esc(when(j.createdAt))}<span class="subcell" style="display:block;color:#8792a2;font-size:12px">${esc(j.createdBy || "")}</span></td><td>${fmt(j.counts.rows)}</td><td>${fmt(j.result.applied)}</td><td>${fmt(j.result.alreadyDone)}</td><td>${fmt(done ? j.result.notApplied : j.counts.errors)}</td><td>${pill(ui.cfg, j.status === "PROCESSING" ? `${label} ${j.progress.percent}%` : label, key)}</td><td style="white-space:nowrap">${actions}</td></tr>`;
        })
        .join("");
      draw(
        "Bulk update history",
        `${list.items.length ? `The last ${fmt(list.items.length)} bulk update${list.items.length === 1 ? "" : "s"}` : "No bulk updates yet"} · each has its own number, recorded on every change in the audit log.`,
        `<div style="display:flex;gap:16px;flex-wrap:wrap">${kindFilter}${actionFilter}</div><div class="table-scroll" style="max-height:60vh;overflow:auto"><table id="dfiHistory"><thead><tr><th>BULK UPDATE</th><th>ACTION · PAGE</th><th>UPLOADED</th><th>ROWS</th><th>APPLIED</th><th>ALREADY DONE</th><th>NOT APPLIED</th><th>STATUS</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="9" class="empty-state">No bulk updates yet.</td></tr>`}</tbody></table></div>`,
        `${button("new", "New bulk update")}${button("close", "Close", { primary: true })}`,
      );
    } catch (error) {
      toast(describe(error));
      close();
    }
  }

  // ───────────── completing an incomplete order ─────────────

  let catalog = null;
  DF.events?.on("catalog.updated", () => (catalog = null)); // geography changed in super admin
  async function complete(parcel, cfg = {}) {
    try {
      catalog ??= await DF.api("/catalog");
    } catch (error) {
      return toast(describe(error));
    }
    const conf = { tones: DEFAULT_TONES, ...cfg };
    // The Service choices are the parcel's package options (no "Same day": Express is the same-day service).
    let pkg = null;
    try {
      pkg = await DF.api(conf.forOps ? (parcel.merchant?.id ? `/packages/effective?merchantId=${encodeURIComponent(parcel.merchant.id)}` : "/packages/effective?segment=CUSTOMER") : "/packages/me");
    } catch {
      pkg = null; // the current service stays the only choice
    }
    const currentSpeed = parcel.service?.speed || "REGULAR";
    const speedChoices = (pkg?.options?.speeds?.length ? pkg.options.speeds : [currentSpeed]).map(code => [code, pkg?.labels?.speed?.[code] || (code === currentSpeed && parcel.service?.speedLabel) || code]);
    if (!speedChoices.some(([code]) => code === currentSpeed)) speedChoices.unshift([currentSpeed, parcel.service?.speedLabel || currentSpeed]);
    const banking = pkg?.package?.segment === "BANKING_FINANCIAL" || pkg?.segment === "BANKING_FINANCIAL" || parcel.merchant?.type === "BANKING_FINANCIAL";
    const missing = (parcel.missingLabels || []).join(", ");
    const zonesOf = d => catalog.zonesByDistrict?.[d] || [];
    const option = (v, selected, label = v) => `<option value="${esc(v)}" ${v === selected ? "selected" : ""}>${esc(label)}</option>`;
    // The fields still missing are marked: all of them are needed before a delivery rider is assigned.
    const missingField = { dfiName: "recipientName", dfiPhone: "recipientPhone", dfiStreet: "address", dfiDistrict: "district", dfiZone: "zone" };
    const isMissing = id => (parcel.missingFields || []).includes(missingField[id]);
    const field = (id, label, control) =>
      `<label style="display:grid;gap:5px;font-weight:600;font-size:13px" for="${id}"${isMissing(id) ? ' data-missing="true"' : ""}>${isMissing(id) ? `<span>${esc(label)} <span style="color:#946200;font-weight:600">· needed before delivery</span></span>` : esc(label)}${control}</label>`;
    const input = (id, value, attrs = "") => `<input class="table-search" id="${id}" value="${esc(value ?? "")}" ${attrs} style="width:100%">`;
    const district = parcel.delivery.district || "";
    const body = `<form id="dfiComplete" novalidate style="display:grid;gap:12px">
      <p class="panel-subtitle" style="margin:0">${missing ? `Missing: <strong>${esc(missing)}</strong>. ` : ""}The order can't be assigned to a delivery rider until the recipient's name, phone, address, district and zone are all known. Changing the destination, weight or service re-prices it.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
        ${field("dfiName", "Recipient name", input("dfiName", parcel.recipient.name, 'maxlength="120"'))}
        ${field("dfiPhone", "Recipient phone", input("dfiPhone", DF.localPhone(parcel.recipient.phone || "").replace(/^0/, "")))}
        ${field("dfiStreet", "Delivery address", input("dfiStreet", parcel.delivery.street, 'maxlength="200"'))}
        ${field("dfiArea", "Area / landmark", input("dfiArea", parcel.delivery.area, 'maxlength="120"'))}
        ${field("dfiDistrict", "District", `<select class="select-small" id="dfiDistrict"><option value="">Choose</option>${(catalog.districts || []).map(d => option(d, district)).join("")}</select>`)}
        ${field("dfiZone", "Zone", `<select class="select-small" id="dfiZone"><option value="">Choose</option>${zonesOf(district).map(z => option(z, parcel.delivery.zone)).join("")}</select>`)}
        ${banking ? "" : field("dfiWeight", "Weight (kg)", input("dfiWeight", parcel.weightKg, 'type="number" min="0.01" max="50" step="0.01"'))}
        ${speedChoices.length > 1 ? field("dfiService", "Service", `<select class="select-small" id="dfiService">${speedChoices.map(([v, l]) => option(v, currentSpeed, l)).join("")}</select>`) : ""}
      </div>
      ${conf.forOps ? field("dfiNote", "Note (staff only)", input("dfiNote", "", 'maxlength="500" placeholder="e.g. Merchant confirmed by phone"')) : ""}
    </form>`;
    ui = { cfg: conf, step: "complete" };
    draw(
      `Complete order · ${parcel.trackingId}`,
      `${pill(conf, "Needs info", "warn")} ${esc(parcel.merchant?.name || "")} · current charge ${esc(taka(parcel.charges?.total))}`,
      body,
      `${button("close", "Cancel")}<button type="submit" form="dfiComplete" class="button button-primary" id="dfiCompleteSubmit">Save details</button>`,
    );
    const form = document.getElementById("dfiComplete");
    const phoneInput = document.getElementById("dfiPhone");
    DF.phoneInput?.(phoneInput);
    const valid = DF.validate(form, {
      dfiPhone: v => (v.trim() ? DF.phoneProblem(v) : ""),
      dfiWeight: v => (v === "" || (Number(v) > 0 && Number(v) <= 50) ? "" : "Enter a weight from 0.01 to 50 kg"),
      dfiZone: v => (document.getElementById("dfiDistrict").value && !v ? "Choose the zone" : ""),
    });
    document.getElementById("dfiDistrict").addEventListener("change", event => {
      document.getElementById("dfiZone").innerHTML = `<option value="">Choose</option>${zonesOf(event.target.value).map(z => option(z, "")).join("")}`;
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (!valid()) return;
      const value = id => document.getElementById(id)?.value.trim() ?? "";
      const body = {};
      const recipient = {};
      if (value("dfiName") && value("dfiName") !== (parcel.recipient.name || "")) recipient.name = value("dfiName");
      const phone = value("dfiPhone") ? DF.normalizePhone(value("dfiPhone")) : null;
      if (phone && phone !== parcel.recipient.phone) recipient.phone = phone;
      if (Object.keys(recipient).length) body.recipient = recipient;
      const delivery = {};
      if (value("dfiStreet") && value("dfiStreet") !== (parcel.delivery.street || "")) delivery.street = value("dfiStreet");
      if (value("dfiArea") !== (parcel.delivery.area || "")) delivery.area = value("dfiArea");
      if (value("dfiDistrict") && value("dfiDistrict") !== (parcel.delivery.district || "")) delivery.district = value("dfiDistrict");
      if (value("dfiZone") && value("dfiZone") !== (parcel.delivery.zone || "")) delivery.zone = value("dfiZone");
      if (Object.keys(delivery).length) body.delivery = delivery;
      if (value("dfiWeight") && Number(value("dfiWeight")) !== Number(parcel.weightKg)) body.weightKg = Number(value("dfiWeight"));
      if (value("dfiService") && value("dfiService") !== currentSpeed) body.speed = value("dfiService");
      if (!Object.keys(body).length) return toast("Nothing changed.");
      if (value("dfiNote")) body.note = value("dfiNote");
      body.expectedVersion = parcel.version;
      const submit = document.getElementById("dfiCompleteSubmit");
      submit.disabled = true;
      try {
        const updated = await DF.api(`/parcels/${encodeURIComponent(parcel.trackingId)}/complete`, { method: "POST", body });
        ui = null;
        document.getElementById("dfImportBackdrop")?.remove();
        toast(
          updated.incomplete
            ? `${updated.trackingId} updated. Still needed: ${updated.missingLabels.join(", ")}.`
            : `${updated.trackingId} is complete · charge ${taka(updated.charges.total)}. It can now be assigned for delivery.`,
        );
        conf.onDone?.(updated);
      } catch (error) {
        submit.disabled = false;
        toast(describe(error));
      }
    });
  }

  window.DFImport = { open, history, template, complete, bulk: cfg => open({ ...cfg, mode: "bulk" }), bulkHistory: cfg => history({ ...cfg, mode: "bulk" }) };

  // The address holds the full address: its district / zone / area are picked from it (shared/api.js DF.autoPlace).
  window.DF?.autoPlace?.({ street: "dfiStreet", district: "dfiDistrict", zone: "dfiZone", area: "dfiArea" });
})();
