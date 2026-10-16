/*
 * Spreadsheet import, shared by the merchant panels (e-commerce and document) and Courier
 * Operations. One engine on the API (/imports); this file is its UI, drawn with the panel's own
 * CSS classes (modal, table, status pill, button):
 *
 *   DFImport.open(cfg)          choose file (+ operations: merchant per file, intake / drop-off hub)
 *                               → POST /imports/validate (dry run) → paginated preview with every
 *                               invalid cell highlighted → "Create N orders" → progress (live events
 *                               import.progress / import.completed) → result, failed-rows download, labels
 *   DFImport.history(cfg)       past imports with their numbers and downloads
 *   DFImport.template(cfg)      GET /imports/templates/:kind (.xlsx, built from live data)
 *   DFImport.complete(parcel, cfg)  completes an incomplete order ("Needs info") → POST /parcels/:id/complete
 *
 * cfg: { kind: "ecommerce"|"document", merchantId?, forOps?, merchants?: [{id, code, name}],
 *        hubs?: [{id, name}], hubId?, tones?: { good, warn, bad, info }, noun?: "orders",
 *        printLabels?(trackingIds, job), onDone?(job) }
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

  let ui = null; // the open dialog: { cfg, step, job, rows, filter, page, file, unsubscribe, poll }

  const tone = (cfg, key) => (cfg.tones || DEFAULT_TONES)[key] || DEFAULT_TONES[key];
  const pill = (cfg, text, key) => `<span class="status ${tone(cfg, key)}">${esc(text)}</span>`;
  const noun = cfg => cfg.noun || (cfg.kind === "document" ? "consignments" : "orders");
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
    if (ui.step === "preview" && ui.job?.status === "VALIDATED") DF.api(`/imports/${ui.job.id}`, { method: "DELETE" }).catch(() => undefined);
    if (ui.step === "booking") toast(`Import ${ui.job?.number || ""} continues in the background. Open the import history to follow it.`);
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

  // ───────────── step 1: choose a file ─────────────

  async function open(cfg) {
    ui = { cfg: { tones: DEFAULT_TONES, ...cfg }, step: "choose", filter: "all", page: 1 };
    draw(`Import ${noun(cfg)} from Excel`, "Loading the import settings…", "", button("close", "Cancel"));
    try {
      const [limits, config] = await Promise.all([DF.api(q("/imports/limits", { merchantId: cfg.merchantId })), DF.api("/imports/config")]);
      if (!ui) return;
      ui.limits = limits;
      ui.config = config;
      // A file chosen before the dialog opened (e.g. the panel's own file input).
      if (cfg.file) pick(cfg.file);
      else chooseStep();
    } catch (error) {
      toast(describe(error));
      close();
    }
  }

  function chooseStep(message = "") {
    const { cfg, limits, config } = ui;
    ui.step = "choose";
    const columns = config.templates[cfg.kind].filter(c => cfg.forOps || !c.opsOnly);
    const required = columns.filter(c => c.required).map(c => c.header);
    const options = [];
    if (cfg.forOps) {
      const merchants = (cfg.merchants || []).filter(m => !m.type || (m.type === "CORPORATE_DOCUMENT") === (cfg.kind === "document"));
      if (cfg.kinds?.length > 1)
        options.push(
          `<label style="display:grid;gap:5px;font-weight:600;font-size:13px">Template<select class="select-small" id="dfiKind">${cfg.kinds
            .map(k => `<option value="${k}" ${k === cfg.kind ? "selected" : ""}>${k === "document" ? "Document consignments" : "E-commerce orders"}</option>`)
            .join("")}</select></label>`,
        );
      options.push(
        `<label style="display:grid;gap:5px;font-weight:600;font-size:13px">Merchant<select class="select-small" id="dfiMerchant"><option value="">Per row (the Merchant column)</option>${merchants
          .map(m => `<option value="${esc(m.id)}" ${m.id === ui.merchantId ? "selected" : ""}>${esc(`${m.code} · ${m.name}`)}</option>`)
          .join("")}</select></label>`,
        `<label style="display:grid;gap:5px;font-weight:600;font-size:13px">Intake<select class="select-small" id="dfiIntake"><option value="PICKUP">Rider pickup</option><option value="DROP_OFF" ${ui.intake === "DROP_OFF" ? "selected" : ""}>Drop-off at hub</option></select></label>`,
        `<label style="display:grid;gap:5px;font-weight:600;font-size:13px">Drop-off hub<select class="select-small" id="dfiHub" ${ui.intake === "DROP_OFF" ? "" : "disabled"}>${(cfg.hubs || [])
          .map(h => `<option value="${esc(h.id)}" ${h.id === (ui.hubId || cfg.hubId) ? "selected" : ""}>${esc(h.name)}</option>`)
          .join("")}</select></label>`,
      );
    }
    const body = `<div style="display:grid;gap:14px">
      <div id="dfiLimits" style="padding:12px 14px;border-radius:10px;background:#f6f8fb;font-size:13px;line-height:1.55">
        <strong>Max ${esc(fmt(limits.maxRows))} rows and ${esc(limits.maxFileMb)} MB per file</strong> · Excel (.xlsx) or CSV with the template's headers.<br>
        Required columns: <strong>${esc(required.join(", ") || "none")}</strong> (red headers with * in the template). Other columns may stay empty; a value you enter must be valid or the row is not created.<br>
        Rows missing the recipient name, phone, address or destination are created as <strong>Needs info</strong>, priced with defaults and held before delivery until completed.
      </div>
      ${options.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">${options.join("")}</div>` : ""}
      <label for="dfiFile" id="dfiDrop" style="display:block;border:2px dashed #c7d2e0;border-radius:12px;padding:26px 16px;text-align:center;cursor:pointer;background:#fff">
        <strong style="display:block;font-size:15px">${ui.file ? esc(ui.file.name) : "Choose the filled-in file"}</strong>
        <span class="panel-subtitle" id="dfiFileInfo">${ui.file ? `${esc(fmt(Math.ceil(ui.file.size / 1024)))} KB · ready to check` : "or drop it here · .xlsx or .csv"}</span>
        <input type="file" id="dfiFile" accept="${ACCEPT}" style="display:none">
      </label>
      ${message ? `<p role="alert" id="dfiMessage" style="margin:0;color:#b42318;font-weight:600">${esc(message)}</p>` : ""}
    </div>`;
    draw(
      `Import ${noun(cfg)} from Excel`,
      `${esc(cfg.kind === "document" ? "Document consignment template" : "E-commerce order template")} · the preview shows every row before anything is created.`,
      body,
      `<div style="margin-right:auto;display:flex;gap:8px;flex-wrap:wrap">${button("template", "Download template (.xlsx)")}${button("history", "Import history")}</div>${button("close", "Cancel")}${button("check", "Check file", { primary: true, disabled: !ui.file })}`,
    );
    const drop = document.getElementById("dfiDrop");
    drop.addEventListener("dragover", event => {
      event.preventDefault();
      drop.style.borderColor = "#3766e8";
    });
    drop.addEventListener("dragleave", () => (drop.style.borderColor = ""));
    drop.addEventListener("drop", event => {
      event.preventDefault();
      drop.style.borderColor = "";
      if (event.dataTransfer?.files?.[0]) pick(event.dataTransfer.files[0]);
    });
  }

  function pick(file) {
    ui.file = null;
    if (!/\.(xlsx|csv)$/i.test(file.name)) return chooseStep(/\.xls$/i.test(file.name) ? "Old .xls files can't be read: save it as Excel Workbook (.xlsx)." : "Choose an Excel (.xlsx) or CSV file.");
    if (file.size > ui.limits.maxFileMb * 1024 * 1024) return chooseStep(`This file is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${ui.limits.maxFileMb} MB. Split it into smaller files.`);
    ui.file = file;
    chooseStep();
  }

  function readOptions() {
    if (!ui.cfg.forOps) return;
    ui.merchantId = document.getElementById("dfiMerchant")?.value || "";
    ui.intake = document.getElementById("dfiIntake")?.value || "PICKUP";
    ui.hubId = document.getElementById("dfiHub")?.value || "";
  }

  // ───────────── step 2: check (dry run) and preview ─────────────

  async function check() {
    readOptions();
    const { cfg, file } = ui;
    if (!file) return;
    if (cfg.forOps && ui.intake === "DROP_OFF" && !ui.hubId) return chooseStep("Choose the hub the sender brings the parcels to.");
    ui.step = "checking";
    draw(`Checking ${file.name}`, "Reading the file and checking every row. Nothing is created yet.", `<p class="panel-subtitle" id="dfiChecking" style="padding:28px 0;text-align:center">Checking rows…</p>`, button("close", "Cancel"));
    const form = new FormData();
    form.append("kind", cfg.kind);
    if (cfg.merchantId) form.append("merchantId", cfg.merchantId);
    if (cfg.forOps && ui.merchantId) form.append("merchantId", ui.merchantId);
    if (cfg.forOps && ui.intake === "DROP_OFF") {
      form.append("intake", "DROP_OFF");
      form.append("dropOffHubId", ui.hubId);
    }
    form.append("file", file, file.name);
    try {
      const response = await DF.apiRaw("/imports/validate", { method: "POST", body: form });
      const job = await response.json();
      if (!ui) return;
      ui.job = job;
      ui.rows = job.rows;
      ui.filter = "all";
      ui.page = 1;
      preview();
    } catch (error) {
      if (ui) chooseStep(describe(error));
    }
  }

  async function loadRows(filter = ui.filter, page = ui.page) {
    const rows = await DF.api(q(`/imports/${ui.job.id}/rows`, { filter, page, pageSize: PAGE_SIZE }));
    if (!ui) return;
    ui.rows = rows;
    ui.filter = filter;
    ui.page = rows.page;
    if (ui.step === "preview") preview();
    else result();
  }

  function rowsTable(filters) {
    const { cfg, job, rows } = ui;
    const columns = job.columns;
    const present = new Set(rows.items.flatMap(r => Object.keys(r.cells || {})));
    const shown = columns.filter(c => present.has(c.key) || c.required || ["recipient_name", "recipient_phone", "address", "district", "zone"].includes(c.key));
    const filterButtons = filters
      .map(([value, label, count]) => `<button type="button" class="button button-sm${ui.filter === value ? " button-primary" : ""}" data-dfi="filter" data-filter="${value}" aria-pressed="${ui.filter === value}">${esc(label)}${count === undefined ? "" : ` (${fmt(count)})`}</button>`)
      .join("");
    const missingCol = { recipientName: "recipient_name", recipientPhone: "recipient_phone", address: "address", district: "district", zone: "zone" };
    const body = rows.items
      .map(r => {
        const [label, key] = ROW_STATUS[r.status] || [r.status, "info"];
        const bad = new Map((r.errors || []).map(e => [e.column, e.message]));
        const missing = new Set((r.missing || []).map(m => missingCol[m]));
        const cells = shown
          .map(c => {
            const value = r.cells?.[c.key] ?? "";
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
        return `<tr data-row="${r.rowNumber}" data-status="${r.status}"><td>${r.rowNumber}</td><td>${pill(cfg, label, key)}</td>${cells}<td style="white-space:nowrap">${esc(taka(r.charge))}</td><td style="min-width:260px;font-size:12px;line-height:1.45">${problems}</td></tr>`;
      })
      .join("");
    const empty = `<tr><td colspan="${shown.length + 4}" class="empty-state">No rows match this filter.</td></tr>`;
    const pager = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;font-size:13px" id="dfiPager">
      ${button("page", "‹ Previous", { disabled: rows.page <= 1, extra: `data-page="${rows.page - 1}"` })}
      <span id="dfiPageInfo">Page ${fmt(rows.page)} of ${fmt(rows.pages)} · ${fmt(rows.total)} row${rows.total === 1 ? "" : "s"}</span>
      ${button("page", "Next ›", { disabled: rows.page >= rows.pages, extra: `data-page="${rows.page + 1}"` })}
      <label style="margin-left:auto;display:flex;align-items:center;gap:6px">Go to page <input class="table-search" id="dfiJump" type="number" min="1" max="${rows.pages}" value="${rows.page}" style="width:80px"></label>${button("jump", "Go")}
    </div>`;
    return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin:12px 0" role="group" aria-label="Filter rows">${filterButtons}</div>
      <div class="table-scroll" style="max-height:52vh;overflow:auto;border:1px solid #e3e8ef;border-radius:10px"><table id="dfiRows"><thead><tr><th>ROW</th><th>STATUS</th>${shown
        .map(c => `<th title="${esc(c.header)}">${esc(c.header.toUpperCase())}${c.required ? " *" : ""}</th>`)
        .join("")}<th>CHARGE</th><th>PROBLEMS</th></tr></thead><tbody>${body || empty}</tbody></table></div>${pager}`;
  }

  function summary(items) {
    return `<div id="dfiSummary" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${items.map(([text, key, id]) => `<span class="status ${tone(ui.cfg, key)}" data-count="${id}">${esc(text)}</span>`).join("")}</div>`;
  }

  function preview() {
    const { cfg, job } = ui;
    ui.step = "preview";
    const c = job.counts;
    const toBook = c.valid + c.incomplete;
    const where = job.intake === "DROP_OFF" ? ` · drop-off at ${job.dropOffHub?.name || "hub"}` : cfg.forOps ? " · rider pickup" : "";
    const notes = [
      job.ignoredColumns?.length ? `Ignored columns (not in the template): ${job.ignoredColumns.join(", ")}.` : "",
      c.errors ? `Rows with errors are skipped: fix them in your file and upload it again, or download them with the reason for each.` : "",
    ].filter(Boolean);
    draw(
      `Preview · ${job.fileName || "upload"}`,
      `${esc(job.number)}${esc(where)} · nothing is created until you confirm.`,
      summary([
        [`${fmt(c.rows)} rows`, "info", "rows"],
        [`${fmt(c.valid)} valid`, "good", "valid"],
        [`${fmt(c.incomplete)} needs info`, "warn", "incomplete"],
        [`${fmt(c.errors)} with errors`, "bad", "errors"],
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
      const job = await DF.api(`/imports/${ui.job.id}/commit`, { method: "POST" });
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
      `Creating ${noun(ui.cfg)} · ${job.number}`,
      "This runs on the server: you can close this window and follow it in the import history.",
      `<div style="display:grid;gap:10px;padding:10px 0" id="dfiProgress"><div role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.percent}" style="height:12px;background:#eef1f5;border-radius:8px;overflow:hidden"><div id="dfiBar" style="height:100%;width:${p.percent}%;background:#3766e8;transition:width .4s"></div></div><p class="panel-subtitle" id="dfiProgressText" style="margin:0">${esc(`${fmt(p.processed)} of ${fmt(p.total)} rows processed (${p.percent}%)`)}</p></div>`,
      button("close", "Close · keep running"),
    );
    const update = data => {
      if (!ui || data?.id !== ui.job.id) return;
      void refreshJob();
    };
    ui.unsubscribe = [DF.events.on("import.progress", update), DF.events.on("import.completed", update)];
    // Safety poll in case the live stream is unavailable.
    ui.poll = setInterval(() => void refreshJob(), 3000);
  }

  async function refreshJob() {
    if (!ui?.job) return;
    try {
      const job = await DF.api(`/imports/${ui.job.id}`);
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
    ui.filter = ui.job.result.notCreated ? "not_created" : "all";
    ui.page = 1;
    try {
      ui.rows = await DF.api(q(`/imports/${ui.job.id}/rows`, { filter: ui.filter, page: 1, pageSize: PAGE_SIZE }));
    } catch {
      ui.rows = { items: [], page: 1, pages: 1, total: 0 };
    }
    if (ui) result();
  }

  function result() {
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
      await DF.download(`/imports/${ui.job.id}/failed-rows`, `${ui.job.number}-not-created.xlsx`);
      toast("Rows not created downloaded with an Error column. Fix them and upload the file again.");
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
          const [label, key] = JOB_STATUS[j.status] || [j.status, "info"];
          const actions = [
            j.status === "VALIDATED" ? "" : `<button type="button" class="button button-sm" data-dfi="view" data-id="${esc(j.id)}">View</button>`,
            j.downloads.failedRows ? `<button type="button" class="button button-sm" data-dfi="failed" data-id="${esc(j.id)}">Not created (.xlsx)</button>` : "",
            j.result.created && ui.cfg.printLabels ? `<button type="button" class="button button-sm" data-dfi="labels" data-id="${esc(j.id)}">Labels</button>` : "",
          ].join(" ");
          return `<tr data-import="${esc(j.number)}"><td><strong>${esc(j.number)}</strong><span class="subcell" style="display:block;color:#8792a2;font-size:12px">${esc(j.fileName || "")}</span></td><td>${esc(when(j.createdAt))}<span class="subcell" style="display:block;color:#8792a2;font-size:12px">${esc(j.createdBy || "")}</span></td><td>${esc(j.merchant ? j.merchant.name : "Per row")}${j.intake === "DROP_OFF" ? `<span class="subcell" style="display:block;color:#8792a2;font-size:12px">Drop-off · ${esc(j.dropOffHub?.name || "")}</span>` : ""}</td><td>${fmt(j.counts.rows)}</td><td>${fmt(j.result.created)}</td><td>${fmt(j.result.createdIncomplete)}</td><td>${fmt(j.status === "COMPLETED" ? j.result.notCreated : j.counts.errors)}</td><td>${pill(ui.cfg, j.status === "PROCESSING" ? `${label} ${j.progress.percent}%` : label, key)}</td><td style="white-space:nowrap">${actions}</td></tr>`;
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
      ui.job = await DF.api(`/imports/${id}`);
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
    if (action === "template") return void template(ui.cfg);
    if (action === "history") return void history(ui.cfg);
    if (action === "new") return void open(ui.cfg);
    if (action === "check") return void check();
    if (action === "back") {
      const job = ui.job;
      ui.job = null;
      if (job?.status === "VALIDATED") DF.api(`/imports/${job.id}`, { method: "DELETE" }).catch(() => undefined);
      ui.file = null;
      return chooseStep();
    }
    if (action === "filter") return void loadRows(el.dataset.filter, 1).catch(error => toast(describe(error)));
    if (action === "page") return void loadRows(ui.filter, Number(el.dataset.page)).catch(error => toast(describe(error)));
    if (action === "jump") return void jump();
    if (action === "commit") return void commit(el);
    if (action === "failed") {
      if (el.dataset.id) return void DF.download(`/imports/${el.dataset.id}/failed-rows`).catch(error => toast(describe(error)));
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
    if (event.target.id === "dfiFile" && event.target.files?.[0]) {
      readOptions();
      return pick(event.target.files[0]);
    }
    if (event.target.id === "dfiKind") {
      readOptions();
      ui.cfg.kind = event.target.value;
      ui.merchantId = "";
      return chooseStep();
    }
    if (event.target.id === "dfiIntake") {
      const hub = document.getElementById("dfiHub");
      if (hub) hub.disabled = event.target.value !== "DROP_OFF";
    }
  }

  // ───────────── completing an incomplete order ─────────────

  let catalog = null;
  async function complete(parcel, cfg = {}) {
    try {
      catalog ??= await DF.api("/catalog");
    } catch (error) {
      return toast(describe(error));
    }
    const conf = { tones: DEFAULT_TONES, ...cfg };
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
        ${field("dfiWeight", "Weight (kg)", input("dfiWeight", parcel.weightKg, 'type="number" min="0.01" max="50" step="0.01"'))}
        ${field("dfiService", "Service", `<select class="select-small" id="dfiService">${[["REGULAR", "Regular"], ["SAME_DAY", "Same day"], ["EXPRESS", "Express"]].map(([v, l]) => option(v, parcel.serviceLevel, l)).join("")}</select>`)}
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
      if (value("dfiService") !== parcel.serviceLevel) body.serviceLevel = value("dfiService");
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

  window.DFImport = { open, history, template, complete };
})();
