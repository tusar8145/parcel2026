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
  const PREF_KEY = "pairaexpress-scan-choice";
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
    let created;
    try {
      created = await DF.api("/parcel-scans/sessions", { method: "POST", body: { kind, ...(merchantId ? { merchantId } : {}) } });
    } catch (e) {
      error.textContent = DF.describe(e);
      error.hidden = false;
      if (startButton) startButton.disabled = false;
      return;
    }
    // The window was closed meanwhile: end the new session (its link) at once.
    if (!s) return void closeSession(created.id);
    s.session = created;
    await loadCatalog(); // the district / zone / area dropdowns
    if (!s) return void closeSession(created.id);
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
      `<div style="display:grid;grid-template-columns:minmax(200px,240px) 1fr;gap:18px;align-items:start" class="df-scan-layout" id="dfScanLayout">
        <div style="padding:14px;border:1px solid var(--line);border-radius:10px;background:#fbfcfe;min-width:0">
          <div id="dfScanQrView" style="display:grid;gap:10px;justify-items:center">
            <div id="dfScanQr" style="width:190px;height:190px" role="img" aria-label="QR code of the phone link">${session.qrSvg}</div>
            <p style="margin:0;font-size:12px;color:var(--muted);text-align:center">Scan with the phone's camera, or open the link on the phone.</p>
            <div style="display:flex;gap:6px;width:100%"><input class="table-search" id="dfScanLink" value="${esc(session.url)}" readonly aria-label="Phone link" style="flex:1;min-width:0;font-size:12px"><button type="button" class="button button-sm" data-scan="copy">Copy</button></div>
            <p style="margin:0;font-size:12px;color:#946200;text-align:center">The link stops working when you close this window.</p>
            <p style="margin:0;font-size:12px;color:var(--muted);text-align:center">Click a row's photo to see it here and compare it with what was read.</p>
          </div>
          <div id="dfScanPhotoView" hidden></div>
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
    $("dfScanCount").textContent = `${scans.length} parcel${scans.length === 1 ? "" : "s"}${scans.some(x => x.status === "READING") ? ` · ${scans.filter(x => x.status === "READING").length} being read (a minute or two each, one at a time)` : ""}`;
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
            .map(c =>
              PLACE[c.key]
                ? `<td><select class="select-small" data-cell="${esc(c.key)}" data-place aria-label="${esc(c.header)} (parcel ${scan.number})" style="width:150px"></select></td>`
                : `<td><input class="table-search" data-cell="${esc(c.key)}" aria-label="${esc(c.header)} (parcel ${scan.number})" style="width:${WIDE[c.key] || 130}px;min-width:0"></td>`,
            )
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
        if (input.dataset.place !== undefined) {
          placeOptions(input, scan.cells);
          continue;
        }
        const value = scan.cells[input.dataset.cell] ?? "";
        if (input.value !== value) input.value = value;
      }
      tr.querySelector('[data-scan="remove"]').disabled = !!scan.trackingId;
    }
    // The photo being viewed: its text once read (or back to the QR code if its row was removed).
    if (s.viewing) {
      const viewed = scans.find(x => x.id === s.viewing);
      if (!viewed) showQr();
      else if (viewed.status !== s.viewedStatus || viewed.text !== s.viewedText) {
        s.viewedStatus = viewed.status;
        s.viewedText = viewed.text;
        viewer();
      }
    }
  }

  // ───────────── the photo beside the rows (compare it with what was read) ─────────────

  const VIEWER_CSS = `
#dfScanPhotoView .df-scan-pic{position:relative;height:min(52vh,480px);display:grid;place-items:center;overflow:hidden;border-radius:8px;background:#eef2f7;cursor:zoom-in}
#dfScanPhotoView .df-scan-pic img{max-width:100%;max-height:100%;object-fit:contain;transition:transform .08s ease-out;will-change:transform}
#dfScanPhotoView .df-scan-ocr{position:absolute;inset:0;overflow:auto;margin:0;padding:12px;background:rgba(255,255,255,.95);color:#172033;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word;display:none;cursor:auto}
#dfScanPhotoView .df-scan-pic.pinned .df-scan-ocr{display:block}
#dfScanRows tr.df-scan-viewing td{background:#eef3ff}`;
  /** Hover zoom: starting level, and the range the mouse wheel moves it in. */
  const ZOOM = { start: 2.5, min: 1.5, max: 6 };

  /** Shows a row's photo in the left panel (instead of the QR code): hover to zoom, "Keep text shown" for the text read from it. */
  async function showPhoto(scanId) {
    if (!s?.session) return;
    if (!document.getElementById("dfScanCss")) document.head.insertAdjacentHTML("beforeend", `<style id="dfScanCss">${VIEWER_CSS}</style>`);
    s.viewing = scanId;
    s.turn = 0;
    $("dfScanQrView").style.display = "none";
    $("dfScanPhotoView").hidden = false;
    // A wider panel for the photo (one column on small screens).
    if (!window.matchMedia("(max-width: 760px)").matches) $("dfScanLayout").style.gridTemplateColumns = "minmax(280px,380px) 1fr";
    viewer();
    if (!s.photos.get(scanId)) {
      await thumbnail(scanId, null);
      viewer();
    }
  }

  function showQr() {
    if (!s) return;
    s.viewing = null;
    $("dfScanPhotoView").hidden = true;
    $("dfScanQrView").style.display = "grid";
    if (!window.matchMedia("(max-width: 760px)").matches) $("dfScanLayout").style.gridTemplateColumns = "minmax(200px,240px) 1fr";
    document.querySelectorAll("#dfScanRows tr.df-scan-viewing").forEach(tr => tr.classList.remove("df-scan-viewing"));
  }

  /** Draws the photo panel for the row being viewed (again when the row is read or changes). */
  function viewer() {
    const box = $("dfScanPhotoView");
    if (!box || !s?.viewing) return;
    const scan = s.session.scans.find(x => x.id === s.viewing);
    if (!scan) return showQr();
    document.querySelectorAll("#dfScanRows tr[data-scan-id]").forEach(tr => tr.classList.toggle("df-scan-viewing", tr.dataset.scanId === scan.id));
    const url = s.photos.get(s.turn ? `${scan.id}@${s.turn}` : scan.id) || s.photos.get(scan.id);
    const text = scan.status === "READING" ? "Still reading this photo…" : scan.text || "No text could be read from this photo.";
    const state = scan.trackingId ? `Booked · ${scan.trackingId}` : (STATUS[scan.status] || [scan.status])[0];
    box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px"><strong style="font-size:13px">Parcel #${scan.number} · ${esc(state)}</strong><span style="display:flex;gap:6px">${button("turn", "Turn ↻")}${button("qr", "QR code")}</span></div>
      <div class="df-scan-pic${s.pinText ? " pinned" : ""}" id="dfScanPic">${url ? `<img src="${url}" alt="Photo of parcel ${scan.number}" id="dfScanPicImg" draggable="false">` : '<span class="subcell">Loading the photo…</span>'}<pre class="df-scan-ocr" id="dfScanOcr" aria-label="Text read from the photo"></pre></div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px"><span class="panel-subtitle" style="margin:0">Point at the photo to zoom (mouse wheel: more / less).</span>${button("pin-text", s.pinText ? "Hide text" : "Keep text shown")}</div>`;
    $("dfScanOcr").textContent = `Read from the photo:\n\n${text}`;
    zoomable($("dfScanPic"), $("dfScanPicImg"));
  }

  /** Hover zoom: the part of the photo under the mouse, enlarged in place (not while the text is shown). */
  function zoomable(pic, img) {
    if (!pic || !img) return;
    let base = null;
    const level = () => s?.zoom || ZOOM.start;
    const follow = event => {
      if (!base || s?.pinText) return;
      const x = Math.min(1, Math.max(0, (event.clientX - base.left) / base.width));
      const y = Math.min(1, Math.max(0, (event.clientY - base.top) / base.height));
      img.style.transformOrigin = `${(x * 100).toFixed(1)}% ${(y * 100).toFixed(1)}%`;
      img.style.transform = `scale(${level()})`;
    };
    const reset = () => {
      base = null;
      img.style.transform = "";
    };
    pic.addEventListener("mouseenter", event => {
      if (s?.pinText) return;
      img.style.transform = "";
      base = img.getBoundingClientRect();
      follow(event);
    });
    pic.addEventListener("mousemove", follow);
    pic.addEventListener("mouseleave", reset);
    pic.addEventListener(
      "wheel",
      event => {
        if (!base || s?.pinText) return;
        event.preventDefault();
        s.zoom = Math.min(ZOOM.max, Math.max(ZOOM.min, level() * (event.deltaY < 0 ? 1.2 : 1 / 1.2)));
        follow(event);
      },
      { passive: false },
    );
  }

  /** The photo turned by `deg` (drawn turned, so zooming follows the mouse on sideways photos too); kept for the session. */
  async function turned(scanId, deg) {
    const key = `${scanId}@${deg}`;
    if (!deg || s.photos.get(key)) return;
    const source = s.photos.get(scanId);
    if (!source) return;
    const bitmap = await createImageBitmap(await (await fetch(source)).blob());
    const canvas = document.createElement("canvas");
    const sideways = deg % 180 !== 0;
    canvas.width = sideways ? bitmap.height : bitmap.width;
    canvas.height = sideways ? bitmap.width : bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    bitmap.close?.();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (blob && s) s.photos.set(key, URL.createObjectURL(blob));
  }

  /** Loads a row's photo once (kept as an object URL) and shows it in `target` (a thumbnail button), if given. */
  async function thumbnail(scanId, target) {
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
    if (target) target.innerHTML = `<img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`;
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

  // ───────────── district / zone / area dropdowns (the service catalog) ─────────────

  /** The place columns: each one's parent column (zones of the district, areas of the zone). */
  const PLACE = { district: { parent: null }, zone: { parent: "district" }, area: { parent: "zone" }, pickup_district: { parent: null }, pickup_zone: { parent: "pickup_district" }, pickup_area: { parent: "pickup_zone" } };
  const familyOf = key => (key.startsWith("pickup_") ? { district: "pickup_district", zone: "pickup_zone", area: "pickup_area" } : { district: "district", zone: "zone", area: "area" });

  /** The active catalog (GET /catalog), loaded once per window. */
  async function loadCatalog() {
    if (s && !s.catalog) s.catalog = DF.state?.catalog || (await DF.api("/catalog").catch(() => null));
  }
  const zoneOwner = zone => Object.keys(s?.catalog?.zonesByDistrict || {}).find(d => s.catalog.zonesByDistrict[d].includes(zone));

  /**
   * A place dropdown's choices: districts; the chosen district's zones (every zone while no district is
   * chosen: picking one fills its district); the chosen zone's areas. A value read from the photo that
   * isn't in the catalog stays, marked, until it is changed.
   */
  function placeOptions(select, cells) {
    const c = s?.catalog;
    const key = select.dataset.cell;
    const f = familyOf(key);
    const value = cells[key] ?? "";
    let list = [];
    let empty = "Choose…";
    if (c && key === f.district) list = c.districts;
    else if (c && key === f.zone) {
      const district = cells[f.district];
      list = district ? c.zonesByDistrict[district] || [] : [...new Set(Object.values(c.zonesByDistrict).flat())].sort((a, b) => a.localeCompare(b));
      empty = district ? `Choose a zone (${list.length})` : "Choose a zone";
    } else if (c && key === f.area) {
      const zone = cells[f.zone];
      list = zone ? c.areasByZone[zone] || [] : [];
      empty = zone ? (list.length ? `Choose an area (${list.length})` : "No areas listed") : "Choose the zone first";
    }
    const signature = `${value}|${list.length}|${list[0] ?? ""}|${empty}`;
    if (select.dataset.signature === signature) return;
    select.dataset.signature = signature;
    const unknown = value && !list.includes(value);
    select.innerHTML = `<option value="">${esc(empty)}</option>${unknown ? `<option value="${esc(value)}" selected>${esc(value)} (not in the list)</option>` : ""}${list.map(name => `<option value="${esc(name)}"${name === value ? " selected" : ""}>${esc(name)}</option>`).join("")}`;
    select.value = value;
    // Searchable (shared/select-search.js), short lists too.
    DF.searchSelect?.(select, { label: key.replace("pickup_", "pickup ").replace(/^./, ch => ch.toUpperCase()) });
  }

  /** A place was chosen: the dependent places follow (a zone brings its district; a new district or zone clears what no longer fits). */
  async function placeChanged(select) {
    const tr = select.closest("tr");
    const scan = s?.session?.scans.find(x => x.id === tr?.dataset.scanId);
    if (!scan || !s.catalog) return;
    const key = select.dataset.cell;
    const f = familyOf(key);
    const cells = { ...scan.cells, [key]: select.value };
    if (key === f.zone && select.value) {
      const district = zoneOwner(select.value);
      if (district) cells[f.district] = district;
    }
    // Cleared: what lies inside it goes too.
    if (!select.value && key === f.district) cells[f.zone] = cells[f.area] = "";
    if (!select.value && key === f.zone) cells[f.area] = "";
    if (cells[f.zone] && cells[f.district] && !(s.catalog.zonesByDistrict[cells[f.district]] || []).includes(cells[f.zone])) cells[f.zone] = "";
    if (cells[f.area] && !(s.catalog.areasByZone[cells[f.zone]] || []).includes(cells[f.area])) cells[f.area] = "";
    const columns = new Set(s.session.columns.map(col => col.key));
    const changed = Object.fromEntries([f.district, f.zone, f.area].filter(k => columns.has(k) && (cells[k] ?? "") !== (scan.cells[k] ?? "")).map(k => [k, cells[k] || null]));
    if (!Object.keys(changed).length) return;
    const saving = `${scan.id}:${key}`;
    s.saving.set(saving, 0);
    try {
      const fresh = await DF.api(`/parcel-scans/sessions/${s.session.id}/scans/${scan.id}`, { method: "PATCH", body: { cells: changed } });
      Object.assign(scan, fresh);
    } catch (e) {
      showToast(DF.describe(e));
    } finally {
      s?.saving.delete(saving);
      rows();
    }
  }

  // ───────────── editing ─────────────

  function onInput(event) {
    const input = event.target.closest?.("[data-cell]");
    if (!input || !s?.session || input.dataset.place !== undefined) return;
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
    if (action === "photo") return showPhoto(target.closest("tr").dataset.scanId);
    if (action === "qr") return showQr();
    if (action === "turn") {
      s.turn = ((s.turn || 0) + 90) % 360;
      await turned(s.viewing, s.turn);
      return viewer();
    }
    if (action === "pin-text") {
      s.pinText = !s.pinText;
      return viewer();
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
    if (event.target.matches?.("select[data-place]")) return void placeChanged(event.target);
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
