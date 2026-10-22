/*
 * Courier Operations › New orders › "Scan with phone" (API: /parcel-scans).
 *
 *   1. Choose the parcel type and merchant (one per session) → POST /parcel-scans/sessions.
 *   2. A QR code and link: opened on a phone (/scan/<token>, app/(scan)), photos of parcel labels
 *      are sent, kept (compressed) and read on the server into order fields. Rows appear here live
 *      (parcel_scan.updated events) with their photo; cells are edited in place (PATCH …/scans/:id).
 *   3. Download Excel (the import template with a Scan ID column) / Import Excel (the edited file
 *      back: rows matched by Scan ID), or Submit: the rows go to the import dialog (shared/importer.js,
 *      with the first / last mile, hub and message choices), and each booked parcel keeps its photo.
 *
 * The link works only while this window is open: it is extended every minute and ends when the
 * window closes (DELETE /parcel-scans/sessions/:id, also on leaving the page).
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops || !window.DFImport) return;
  const $ = id => document.getElementById(id);
  const esc = Ops.esc;
  const KINDS = [
    ["ecommerce", "E-commerce"],
    ["document", "Banking & Financial"],
    ["customer", "Customer parcel"],
  ];
  const MERCHANT_TYPE = { ecommerce: "ECOMMERCE", document: "BANKING_FINANCIAL" };
  /** Columns edited in the table (the rest are in the Excel file), in this order when the template has them. */
  const TABLE_COLUMNS = ["sender_name", "sender_phone", "pickup_address", "pickup_district", "pickup_zone", "recipient_name", "recipient_phone", "address", "district", "zone", "area", "cod_amount", "weight_kg", "order_ref", "instructions"];
  const WIDE = { address: 220, pickup_address: 200, instructions: 180 };
  const STATUS = { READING: ["Reading…", "status-blue"], READ: ["Read", "status-good"], FAILED: ["Couldn't read", "status-warn"] };
  const PREF_KEY = "deliveryfast-scan-choice";
  const KEEPALIVE_MS = 60_000;

  const icon = body => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const CAMERA = icon('<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>');

  /** The heading button (bridge-nav.js places it on New orders). */
  Ops.scanButton = () => (Ops.can("dispatch") ? `<button class="button" id="scanWithPhone" type="button" title="Photograph parcel labels with a phone: each photo becomes an order row">${CAMERA}Scan with phone</button>` : "");

  let s = null; // { session, timer, off, photos: Map(scanId → objectURL), saving: Map(scanId → timeout), busy }

  // ───────────── the dialog frame ─────────────

  function frame(title, subtitle, body, actions) {
    let backdrop = $("dfScanBackdrop");
    if (!backdrop) {
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div class="modal-backdrop open" id="dfScanBackdrop" role="dialog" aria-modal="true" aria-labelledby="dfScanTitle" style="z-index:110"><div class="modal" style="max-width:min(1240px,calc(100vw - 32px));max-height:calc(100vh - 40px);overflow:auto"><div class="modal-head"><div><h2 id="dfScanTitle"></h2><p id="dfScanSubtitle"></p></div><button type="button" class="modal-close" data-scan="close" aria-label="Close">×</button></div><div id="dfScanBody"></div><div class="modal-actions" id="dfScanActions" style="flex-wrap:wrap"></div></div></div>`,
      );
      backdrop = $("dfScanBackdrop");
      backdrop.addEventListener("click", onClick);
      backdrop.addEventListener("change", onChange);
      backdrop.addEventListener("input", onInput);
    }
    $("dfScanTitle").textContent = title;
    $("dfScanSubtitle").textContent = subtitle;
    $("dfScanBody").innerHTML = body;
    $("dfScanActions").innerHTML = actions;
  }
  const button = (action, label, { primary = false, disabled = false, id = "" } = {}) =>
    `<button type="button" class="button${primary ? " button-primary" : ""}" data-scan="${action}"${id ? ` id="${id}"` : ""}${disabled ? " disabled" : ""}>${label}</button>`;

  // ───────────── step 1: type and merchant ─────────────

  async function open() {
    if (!Ops.require("dispatch", "scan parcels")) return;
    if (s) return;
    s = { session: null, timer: null, off: null, photos: new Map(), saving: new Map(), busy: false };
    let pref = {};
    try {
      pref = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
    } catch {}
    frame("Scan with phone", "Loading merchants…", "", button("close", "Cancel"));
    const merchants = (Ops.cache.merchants?.value || (await DF.api("/ops/merchants").catch(() => []))).filter(m => m.status === "ACTIVE");
    if (!s) return;
    const kind = KINDS.some(([k]) => k === pref.kind) ? pref.kind : "ecommerce";
    const label = "display:grid;gap:5px;font-weight:600;font-size:13px";
    frame(
      "Scan with phone",
      "Photograph parcel labels with a phone: each photo becomes an order row here, read from the label.",
      `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:12px">
        <label style="${label}">Parcel type<select class="select-small" id="dfScanKind">${KINDS.map(([k, l]) => `<option value="${k}"${k === kind ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
        <label style="${label}" id="dfScanMerchantField">Merchant<select class="select-small" id="dfScanMerchant" data-search aria-label="Merchant"></select></label>
      </div>
      <p class="panel-subtitle" style="margin:12px 0 0">Every row of this session uses this type and merchant. The phone link works only while this window is open.</p>
      <p role="alert" id="dfScanError" style="margin:10px 0 0;color:#b42318;font-weight:600" hidden></p>`,
      `${button("close", "Cancel")}${button("start", `${CAMERA}Show QR code`, { primary: true })}`,
    );
    s.merchants = merchants;
    fillMerchants(pref.merchantId);
  }

  function fillMerchants(chosen) {
    const kind = $("dfScanKind")?.value;
    const select = $("dfScanMerchant");
    if (!select) return;
    const type = MERCHANT_TYPE[kind];
    $("dfScanMerchantField").hidden = !type;
    const list = type ? s.merchants.filter(m => m.type === type) : [];
    select.innerHTML = `<option value="">${list.length ? `Choose the merchant (${list.length})` : "No active merchant of this type"}</option>${list.map(m => `<option value="${esc(m.id)}"${m.id === chosen ? " selected" : ""}>${esc(`${m.code} · ${m.name}`)}</option>`).join("")}`;
    DF.searchSelect?.(select, { label: "Merchants", placeholder: "Search merchants…" });
  }

  async function start() {
    const kind = $("dfScanKind").value;
    const merchantId = MERCHANT_TYPE[kind] ? $("dfScanMerchant").value : "";
    const error = $("dfScanError");
    if (MERCHANT_TYPE[kind] && !merchantId) {
      error.textContent = "Choose the merchant.";
      error.hidden = false;
      return;
    }
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({ kind, merchantId }));
    } catch {}
    const startButton = document.querySelector('[data-scan="start"]');
    if (startButton) startButton.disabled = true;
    try {
      s.session = await DF.api("/parcel-scans/sessions", { method: "POST", body: { kind, ...(merchantId ? { merchantId } : {}) } });
    } catch (e) {
      error.textContent = DF.describe(e);
      error.hidden = false;
      if (startButton) startButton.disabled = false;
      return;
    }
    if (!s) return void closeSession(s?.session?.id);
    s.timer = setInterval(() => void keepalive(), KEEPALIVE_MS);
    s.off = DF.events.on("parcel_scan.updated", data => {
      if (s?.session && data?.id === s.session.id) void reload();
    });
    scanStep();
  }

  // ───────────── step 2: QR code, link and the rows ─────────────

  const columnsOf = session => TABLE_COLUMNS.map(key => session.columns.find(c => c.key === key)).filter(Boolean);

  function scanStep(message = "") {
    const session = s.session;
    const cols = columnsOf(session);
    const who = `${session.kindLabel}${session.merchant ? ` · ${session.merchant.name}` : ""}`;
    frame(
      "Scan with phone",
      `${who} · photos taken through the link appear below, read from the label. Check each row, then submit.`,
      `<div style="display:grid;grid-template-columns:minmax(200px,240px) 1fr;gap:18px;align-items:start" class="df-scan-layout">
        <div style="display:grid;gap:10px;justify-items:center;padding:14px;border:1px solid var(--line);border-radius:10px;background:#fbfcfe">
          <div id="dfScanQr" style="width:190px;height:190px" role="img" aria-label="QR code of the phone link">${session.qrSvg}</div>
          <p style="margin:0;font-size:12px;color:var(--muted);text-align:center">Scan with the phone's camera, or open the link on the phone.</p>
          <div style="display:flex;gap:6px;width:100%"><input class="table-search" id="dfScanLink" value="${esc(session.url)}" readonly aria-label="Phone link" style="flex:1;min-width:0;font-size:12px"><button type="button" class="button button-sm" data-scan="copy">Copy</button></div>
          <p style="margin:0;font-size:12px;color:#946200;text-align:center">The link stops working when you close this window.</p>
        </div>
        <div style="min-width:0">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px"><strong id="dfScanCount"></strong><span class="panel-subtitle" style="margin:0">Changes are saved as you type · they go into the Excel file and the order</span></div>
          <div class="table-scroll" style="max-height:52vh;overflow:auto;border:1px solid var(--line);border-radius:10px">
            <table style="min-width:${300 + cols.reduce((a, c) => a + (WIDE[c.key] || 130), 0)}px"><thead><tr><th>#</th><th>PHOTO</th><th>STATUS</th>${cols.map(c => `<th>${esc(c.header.toUpperCase())}</th>`).join("")}<th></th></tr></thead><tbody id="dfScanRows"></tbody></table>
          </div>
          <p class="panel-subtitle" id="dfScanEmpty" style="margin:14px 0 0;text-align:center">Waiting for the first photo…</p>
        </div>
      </div>
      ${message ? `<p role="alert" style="margin:12px 0 0;color:#b42318;font-weight:600">${esc(message)}</p>` : ""}
      <input type="file" id="dfScanFile" accept=".xlsx,.csv" hidden>`,
      `<div style="margin-right:auto;display:flex;gap:8px;flex-wrap:wrap">${button("excel", "Download Excel")}${button("import", "Import Excel")}</div>${button("close", "Close")}${button("submit", "Submit", { primary: true, id: "dfScanSubmit" })}`,
    );
    const qr = $("dfScanQr").querySelector("svg");
    if (qr) qr.setAttribute("style", "width:100%;height:100%");
    if (window.matchMedia("(max-width: 760px)").matches) $("dfScanBody").querySelector(".df-scan-layout").style.gridTemplateColumns = "1fr";
    rows();
  }

  /** Updates the table in place: new rows are added, typed cells (focused or being saved) are kept. */
  function rows() {
    const body = $("dfScanRows");
    if (!body || !s?.session) return;
    const session = s.session;
    const cols = columnsOf(session);
    const scans = session.scans;
    const open = scans.filter(x => !x.trackingId);
    $("dfScanCount").textContent = `${scans.length} parcel${scans.length === 1 ? "" : "s"}${scans.some(x => x.status === "READING") ? ` · ${scans.filter(x => x.status === "READING").length} being read` : ""}`;
    $("dfScanEmpty").hidden = scans.length > 0;
    const submit = $("dfScanSubmit");
    if (submit) {
      submit.disabled = !open.length || s.busy;
      submit.textContent = open.length ? `Submit ${open.length} order${open.length === 1 ? "" : "s"}` : "Submit";
    }
    const ids = new Set(scans.map(x => x.id));
    body.querySelectorAll("tr[data-scan-id]").forEach(tr => !ids.has(tr.dataset.scanId) && tr.remove());
    for (const scan of scans) {
      let tr = body.querySelector(`tr[data-scan-id="${CSS.escape(scan.id)}"]`);
      if (!tr) {
        body.insertAdjacentHTML(
          "beforeend",
          `<tr data-scan-id="${esc(scan.id)}"><td>${scan.number}</td><td data-scan-photo>${scan.hasPhoto ? `<button type="button" class="button button-sm" data-scan="photo" style="padding:0;width:52px;height:52px;overflow:hidden" aria-label="Photo of parcel ${scan.number}"></button>` : '<span class="subcell">Excel</span>'}</td><td data-scan-status></td>${cols
            .map(c => `<td><input class="table-search" data-cell="${esc(c.key)}" aria-label="${esc(c.header)} (parcel ${scan.number})" style="width:${WIDE[c.key] || 130}px;min-width:0"></td>`)
            .join("")}<td><button type="button" class="button button-sm" data-scan="remove" title="Remove this row and its photo" aria-label="Remove parcel ${scan.number}">×</button></td></tr>`,
        );
        tr = body.lastElementChild;
        if (scan.hasPhoto) void thumbnail(scan.id, tr.querySelector('[data-scan="photo"]'));
      }
      const [label, tone] = scan.trackingId ? [`Booked · ${scan.trackingId}`, "status-good"] : STATUS[scan.status] || [scan.status, "status-blue"];
      // Hover: the text read from the photo (why a field is empty or wrong).
      tr.querySelector("[data-scan-status]").innerHTML = `<span class="status ${tone}"${scan.text ? ` title="${esc(`Read from the photo:\n${scan.text}`)}"` : ""}>${esc(label)}</span>`;
      for (const input of tr.querySelectorAll("[data-cell]")) {
        input.disabled = !!scan.trackingId;
        if (document.activeElement === input || s.saving.has(`${scan.id}:${input.dataset.cell}`)) continue;
        const value = scan.cells[input.dataset.cell] ?? "";
        if (input.value !== value) input.value = value;
      }
      tr.querySelector('[data-scan="remove"]').disabled = !!scan.trackingId;
    }
  }

  async function thumbnail(scanId, target) {
    if (!target) return;
    let url = s?.photos.get(scanId);
    if (!url) {
      try {
        url = URL.createObjectURL(await (await DF.apiRaw(`/parcel-scans/scans/${scanId}/photo`)).blob());
      } catch {
        return;
      }
      if (!s) return URL.revokeObjectURL(url);
      s.photos.set(scanId, url);
    }
    target.innerHTML = `<img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`;
  }

  async function reload() {
    if (!s?.session) return;
    try {
      const fresh = await DF.api(`/parcel-scans/sessions/${s.session.id}`);
      if (!s?.session) return;
      s.session = { ...s.session, ...fresh };
      rows();
    } catch (e) {
      if (e?.status === 404) close();
    }
  }

  async function keepalive() {
    if (!s?.session) return;
    try {
      await DF.api(`/parcel-scans/sessions/${s.session.id}/keepalive`, { method: "POST" });
      void reload(); // also the safety net when live events are not coming through
    } catch (e) {
      if (e?.status === 410) {
        clearInterval(s.timer);
        showToast("The phone link has expired. Close this window and open Scan with phone again for a new QR code.");
      }
    }
  }

  // ───────────── editing ─────────────

  function onInput(event) {
    const input = event.target.closest?.("[data-cell]");
    if (!input || !s?.session) return;
    const scanId = input.closest("tr").dataset.scanId;
    const key = `${scanId}:${input.dataset.cell}`;
    clearTimeout(s.saving.get(key));
    s.saving.set(
      key,
      setTimeout(() => void save(scanId, input.dataset.cell, input.value, key), 600),
    );
  }

  async function save(scanId, cell, value, key) {
    if (!s?.session) return;
    try {
      const scan = await DF.api(`/parcel-scans/sessions/${s.session.id}/scans/${scanId}`, { method: "PATCH", body: { cells: { [cell]: value.trim() || null } } });
      const row = s.session.scans.find(x => x.id === scanId);
      if (row) Object.assign(row, scan);
    } catch (e) {
      showToast(DF.describe(e));
    } finally {
      s?.saving.delete(key);
    }
  }

  /** Waits for the edits being saved (before Excel or Submit reads the rows on the server). */
  async function flushEdits() {
    const pending = [...document.querySelectorAll("#dfScanRows [data-cell]")].filter(input => s.saving.has(`${input.closest("tr").dataset.scanId}:${input.dataset.cell}`));
    for (const input of pending) {
      const scanId = input.closest("tr").dataset.scanId;
      const key = `${scanId}:${input.dataset.cell}`;
      clearTimeout(s.saving.get(key));
      await save(scanId, input.dataset.cell, input.value, key);
    }
  }

  // ───────────── actions ─────────────

  async function onClick(event) {
    const target = event.target.closest("[data-scan]");
    if (!target || target.disabled) return;
    const action = target.dataset.scan;
    if (action === "close") return close();
    if (action === "start") return start();
    if (action === "copy") {
      const link = $("dfScanLink");
      try {
        await navigator.clipboard.writeText(link.value);
        showToast("Link copied. Send it to the phone, or type it in the phone's browser.");
      } catch {
        link.select();
      }
      return;
    }
    if (action === "photo") {
      const url = s.photos.get(target.closest("tr").dataset.scanId);
      if (url) window.open(url, "_blank", "noopener");
      return;
    }
    if (action === "remove") {
      const tr = target.closest("tr");
      const ok = await DF.confirm({ title: "Remove this row?", message: "The row and its photo are deleted.", confirm: "Remove", danger: true }).catch(() => false);
      if (!ok || !s?.session) return;
      try {
        await DF.api(`/parcel-scans/sessions/${s.session.id}/scans/${tr.dataset.scanId}`, { method: "DELETE" });
        s.session.scans = s.session.scans.filter(x => x.id !== tr.dataset.scanId);
        rows();
      } catch (e) {
        showToast(DF.describe(e));
      }
      return;
    }
    if (action === "excel") {
      await flushEdits();
      try {
        await DF.download(`/parcel-scans/sessions/${s.session.id}/workbook`, "delivery-fast-scanned.xlsx");
        showToast("Excel downloaded. Keep the Scan ID column, then use Import Excel here to bring your changes back.");
      } catch (e) {
        showToast(DF.describe(e));
      }
      return;
    }
    if (action === "import") return $("dfScanFile")?.click();
    if (action === "submit") return submit();
  }

  function onChange(event) {
    if (event.target.id === "dfScanKind") return fillMerchants("");
    if (event.target.id === "dfScanFile" && event.target.files?.length) {
      const file = event.target.files[0];
      event.target.value = "";
      void importFile(file);
    }
  }

  async function importFile(file) {
    if (!/\.(xlsx|csv)$/i.test(file.name)) return showToast("Choose the Excel (.xlsx) or CSV file.");
    await flushEdits();
    const form = new FormData();
    form.append("file", file);
    try {
      const response = await DF.apiRaw(`/parcel-scans/sessions/${s.session.id}/workbook`, { method: "POST", body: form });
      const result = await response.json();
      s.session = { ...s.session, ...result.session };
      // Rebuild the rows: values changed in Excel replace what is on screen.
      $("dfScanRows").innerHTML = "";
      rows();
      showToast(`Excel imported: ${result.updated} row${result.updated === 1 ? "" : "s"} updated${result.added ? `, ${result.added} added` : ""}${result.skipped ? `, ${result.skipped} already booked (unchanged)` : ""}.`);
    } catch (e) {
      showToast(DF.describe(e));
    }
  }

  /** The rows go to the import dialog (first / last mile, hub, messages, check, preview, create). */
  async function submit() {
    if (s.busy) return;
    s.busy = true;
    rows();
    try {
      await flushEdits();
      if (s.session.scans.some(x => x.status === "READING") && !(await DF.confirm({ title: "Some photos are still being read", message: "Submit now? Those rows go with what is filled in so far.", confirm: "Submit" }).catch(() => false))) return;
      const response = await DF.apiRaw(`/parcel-scans/sessions/${s.session.id}/workbook`);
      const blob = await response.blob();
      const { kind, merchant } = s.session;
      const file = new File([blob], `scanned-${kind}.xlsx`, { type: blob.type });
      const cfg = await Ops.importConfig();
      close();
      DFImport.open({ ...cfg, kind, kinds: undefined, merchantId: merchant?.id, file });
    } catch (e) {
      showToast(DF.describe(e));
    } finally {
      if (s) {
        s.busy = false;
        rows();
      }
    }
  }

  function closeSession(id, { beacon = false } = {}) {
    if (!id) return;
    if (beacon) {
      // Leaving the page: a request that outlives it.
      void DF.apiRaw(`/parcel-scans/sessions/${id}`, { method: "DELETE", keepalive: true }).catch(() => undefined);
      return;
    }
    void DF.api(`/parcel-scans/sessions/${id}`, { method: "DELETE" }).catch(() => undefined);
  }

  function close() {
    if (!s) return;
    clearInterval(s.timer);
    s.off?.();
    for (const t of s.saving.values()) clearTimeout(t);
    for (const url of s.photos.values()) URL.revokeObjectURL(url);
    closeSession(s.session?.id);
    s = null;
    $("dfScanBackdrop")?.remove();
  }

  window.addEventListener("pagehide", () => {
    if (s?.session) closeSession(s.session.id, { beacon: true });
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && s && !DF.searchSelect?.isOpen?.() && !document.querySelector(".df-dialog")) close();
  });
  window.addEventListener(
    "click",
    event => {
      if (!event.target.closest?.("#scanWithPhone")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void open();
    },
    true,
  );

  window.DFScan = { open, close };
})();
