/*
 * Courier Operations on the API: hub drop-off intake and shipping labels.
 *
 *   Import Excel                     shared/importer.js (intake choice, preview, result, labels) via bridge-imports.js
 *   Print labels (shipment tables)   GET/POST /documents/labels → PDF in a new tab: A4 sheet (4 per page)
 *                                    or 100×150 mm thermal labels (Code 128 tracking barcode, QR, COD)
 *   Hub desk → Receive               the one place to receive parcels: POST /ops/hub-receive per scan (a bag
 *                                    label receives the whole linehaul bag; a parcel in an inbound bag is
 *                                    received out of it, see Transfers → Receive transfers)
 *                                    (any arrival: drop-offs, picked-up parcels, transfers; USB scanner
 *                                    in keyboard mode, camera via DF.scanner, or a typed tracking ID /
 *                                    CN), batch expected vs received from GET /ops/booking-batches(/:id),
 *                                    and "Find" (the code → the parcel drawer)
 *
 * Shared on window.DFOps: Ops.barcode128, Ops.labels.open(ids), Ops.intake.receive.
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  const $ = id => document.getElementById(id);
  const q = (selector, root = document) => root.querySelector(selector);
  const esc = Ops.esc;
  const ui = Ops.ui;
  const DESK_HUB_KEY = "deliveryfast-receive-desk-hub";

  // ───────────── Code 128 (set B) ─────────────
  // Bar/space widths of the 107 symbols (values 0–105 and the stop symbol), each 11 modules wide.
  const C128 = "212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112".split(" ");
  /** Module widths (bar, space, bar…) for `text` in Code 128 set B, with checksum and stop; null for characters set B can't hold. */
  function code128Widths(text) {
    const values = [104];
    for (const char of String(text)) {
      const code = char.charCodeAt(0);
      if (code < 32 || code > 126) return null;
      values.push(code - 32);
    }
    values.push(values.reduce((sum, v, i) => (sum + v * (i || 1)) % 103, 0), 106);
    return values.flatMap(v => [...C128[v]].map(Number));
  }
  /** A Code 128 barcode as SVG (10-module quiet zones), scaled by the CSS around it. */
  Ops.barcode128 = text => {
    const widths = code128Widths(text);
    if (!widths) return `<span class="barcode-fallback">${esc(text)}</span>`;
    let x = 10;
    let bars = "";
    widths.forEach((w, i) => {
      if (i % 2 === 0) bars += `M${x} 0h${w}v60h-${w}z`;
      x += w;
    });
    return `<svg class="code128" viewBox="0 0 ${x + 10} 60" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="Code 128 barcode ${esc(text)}" data-code="${esc(text)}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#fff"/><path d="${bars}" fill="#000"/></svg>`;
  };

  // ───────────── labels ─────────────

  const FORMATS = {
    a4: { label: "A4 sheet · 4 labels per page (PDF)" },
    thermal: { label: "Labels · thermal 4 × 6 in (100 × 150 mm) · one per page (PDF)" },
  };
  const savedFormat = () => window.DFPrint.labelFormat();
  const MAX_LABELS = window.DFPrint.LIMITS.labels;

  /** Asks for the label format, then opens the labels PDF (GET/POST /documents/labels) in a new tab. */
  function openLabels(trackingIds, { title = "Print labels", description } = {}) {
    const ids = [...new Set(trackingIds.filter(Boolean))];
    if (!ids.length) return void showToast("Select the parcels whose labels you want to print.");
    if (ids.length > MAX_LABELS) return void showToast(`Print at most ${MAX_LABELS.toLocaleString("en-US")} labels at a time (${ids.length.toLocaleString("en-US")} selected).`);
    Ops.dialog("labels", {
      title,
      description: description || `${ids.length} parcel${ids.length === 1 ? "" : "s"}. Each label shows the tracking ID as a Code 128 barcode, the COD to collect, the recipient, the hubs and a tracking QR code.`,
      submit: "Open PDF",
      fields: ui.field("labelFormat", "Label format", ui.select("labelFormat", Object.entries(FORMATS).map(([value, f]) => ({ value, label: f.label })), savedFormat()), true),
      context: { trackingIds: ids },
    });
  }
  Ops.submitters.labels = async button => {
    const format = $("labelFormat").value;
    try {
      localStorage.setItem(window.DFPrint.LABEL_FORMAT_KEY, format);
    } catch {}
    const ids = modalContext.trackingIds;
    closeModal();
    const result = await window.DFPrint.labels(ids, format, { button });
    if (result) showToast(`${result.count ?? ids.length} label${(result.count ?? ids.length) === 1 ? "" : "s"} opened as a PDF${format === "thermal" ? " (100 × 150 mm)" : " (A4, 4 per page)"}.`);
  };
  Ops.labels = { open: openLabels, code128Widths };

  // "Print labels" on the shipment tables (the original "Print generated CNs" button): the ticked
  // rows, else the filtered rows on screen.
  const SHIPMENT_PAGES = ["Shipments", "Customer parcels", "E-commerce operations", "Banking & Financial operations"];
  const baseEnhanceAll = Ops.enhance["*"];
  Ops.enhance["*"] = page => {
    baseEnhanceAll?.(page);
    const button = $("printGeneratedCNs");
    if (button && SHIPMENT_PAGES.includes(page)) {
      button.textContent = "Print labels";
      button.title = "Shipping labels with a Code 128 barcode for the ticked rows (or the filtered list)";
    }
  };
  /**
   * What the shipment table's print buttons print: the ticked rows, else every row the table shows
   * (its filters and search; with server-paged lists, the pages loaded so far). Read from the table
   * itself, so rows loaded from the API that aren't in the page's working set are included.
   */
  Ops.printIds = () => {
    const body = $("shipmentBody");
    if (!body) return { ids: [], ticked: false };
    const ticked = [...body.querySelectorAll("[data-shipment-select]:checked")].map(box => box.dataset.shipmentSelect);
    if (ticked.length) return { ids: [...new Set(ticked)], ticked: true };
    const shown = [...body.querySelectorAll("tr[data-shipment-id]")].filter(row => !row.hidden && row.offsetParent !== null).map(row => row.dataset.shipmentId);
    return { ids: [...new Set(shown)], ticked: false };
  };

  window.addEventListener(
    "click",
    event => {
      if (!event.target.closest("#printGeneratedCNs, #printParcelLabels")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      // Server-paged tables (bridge-lists.js): unticked, every parcel the filter matches, up to the PDF limit.
      const pick = Ops.lists?.printIds ? Ops.lists.printIds(MAX_LABELS) : Promise.resolve({ ...Ops.printIds(), capped: false });
      pick
        .then(({ ids, ticked, capped }) =>
          openLabels(ids, {
            description: `${ids.length} ${ticked ? "selected" : "matching"} parcel${ids.length === 1 ? "" : "s"}${capped ? ` (the first ${MAX_LABELS.toLocaleString("en-US")}: the most per PDF; narrow the filter for the rest)` : ""}. Each label shows the tracking ID as a Code 128 barcode, the COD to collect, the recipient, the hubs and a tracking QR code.`,
          }),
        )
        .catch(error => showToast(DF.describe(error)));
    },
    true,
  );

  // ───────────── intake ─────────────
  // New shipment chooses the first mile in its one first-mile select (shared/order-services.js: rider
  // pickup / drop at hub + hub / on-demand pickup); the Excel import chooses it in its modal (shared/importer.js).

  const hubChoices = () => Ops.myHubs() || DF.state.hubs;
  Ops.intake = {};

  // The Excel import (intake choice, preview, result and labels) is shared/importer.js, wired in bridge-imports.js.

  // ───────────── receive desk (Hubs page) ─────────────

  const desk = {
    hubId: null,
    batchId: "",
    batches: [],
    batch: null, // progress of the chosen batch
    missing: null, // parcels of the batch not yet received (when shown)
    log: [], // newest first
    received: 0,
    queue: Promise.resolve(),
    pending: 0,
    feedback: { tone: "", text: "Scan with a USB scanner (keyboard mode), use the camera, or type a tracking ID / CN and press Enter. The box stays ready for the next parcel." },
  };
  const OUTCOME = {
    RECEIVED: { label: "Received", tone: "good" },
    // Linehaul transfers (the hub-receive answer of a bag label or a parcel in an inbound bag).
    BAG_RECEIVED: { label: "Bag received", tone: "good" },
    TRIP: { label: "Manifest", tone: "blue" },
    EXTRA: { label: "Extra parcel", tone: "bad" },
    NOT_IN_TRANSIT: { label: "Not departed", tone: "warn" },
    ALREADY_RECEIVED: { label: "Already received", tone: "blue" },
    WRONG_HUB: { label: "Wrong hub", tone: "bad" },
    NOT_FOUND: { label: "Not found", tone: "bad" },
    NOT_DROP_OFF: { label: "Not a drop-off", tone: "warn" },
    REFUSED: { label: "Refused", tone: "bad" },
    ERROR: { label: "Not sent", tone: "bad" },
    PENDING: { label: "Checking…", tone: "blue" },
  };
  const pill = outcome => `<span class="status status-${(OUTCOME[outcome] || OUTCOME.REFUSED).tone}">${esc((OUTCOME[outcome] || { label: outcome }).label)}</span>`;
  const deskHubs = () => Ops.myHubs() || DF.state.hubs;

  /** The shared scan result (shared/scanner.js): beep, vibration, the scan box flashing green / red. */
  const beep = ok => DF.scanner?.feedback?.("rdCode", ok);

  function summaryMarkup() {
    const b = desk.batch;
    if (!desk.batchId || !b) return `<p class="panel-subtitle">Choose an import batch to see which of its parcels are still missing.</p>`;
    const missing = desk.missing
      ? desk.missing.length
        ? `<div class="table-scroll" style="max-height:200px;overflow:auto;margin-top:8px"><table><thead><tr><th>MISSING PARCEL</th><th>RECIPIENT</th><th>ORDER</th></tr></thead><tbody>${desk.missing
            .map(p => `<tr><td class="tracking">${esc(p.trackingId)}</td><td>${esc(p.recipient)}<span class="subcell">${esc(p.destination)}</span></td><td>${esc(p.merchantOrderRef || "—")}</td></tr>`)
            .join("")}</tbody></table></div>`
        : `<p class="panel-subtitle">Every parcel of this import has been received.</p>`
      : "";
    return `<div class="workflow-kpis" id="rdBatchSummary" style="margin:10px 0 0"><span>${esc(`Expected ${b.expected}`)}</span><span>${esc(`Received ${b.received}`)}</span><span>${esc(`Missing ${b.missing}`)}</span>${b.cancelled ? `<span>${esc(`${b.cancelled} cancelled`)}</span>` : ""}</div><div class="form-actions" style="margin-top:8px"><button class="button button-sm" type="button" data-rd="missing">${desk.missing ? "Refresh missing" : "Show missing"}</button>${b.missing ? `<button class="button button-sm" type="button" data-rd="labels">Print missing labels</button>` : ""}</div>${missing}`;
  }

  function logMarkup() {
    const rows = desk.log
      .slice(0, 100)
      .map(
        e =>
          `<tr data-rd-outcome="${e.outcome}"><td>${esc(e.at)}</td><td class="tracking">${esc(e.code)}</td><td>${pill(e.outcome)}</td><td>${esc(e.message)}${e.parcel ? `<span class="subcell">${esc([e.parcel.merchant, e.parcel.recipient, e.parcel.destination].filter(Boolean).join(" · "))}${e.parcel.inBatch === false ? " · not in this import" : ""}</span>` : ""}</td></tr>`,
      )
      .join("");
    return ui.table(["Time", "Code", "Result", "Details"], rows, "Scanned parcels appear here, newest first.");
  }

  function deskMarkup() {
    const hubs = deskHubs();
    const batchOptions = [{ value: "", label: "Any parcel (no import)" }, ...desk.batches.map(b => ({ value: b.id, label: `${b.number} · ${b.received}/${b.expected} received${b.fileName ? ` · ${b.fileName}` : ""}` }))];
    const tone = desk.feedback.tone ? ` style="font-weight:600;color:${desk.feedback.tone === "good" ? "var(--green)" : desk.feedback.tone === "bad" ? "var(--red)" : desk.feedback.tone === "warn" ? "var(--amber)" : "#4266ce"}"` : "";
    return `<div class="workflow-grid" id="receiveDesk">
      <section class="panel"><div class="panel-heading"><div><h2 class="panel-title">Receive</h2><p class="panel-subtitle">Every arrival, wherever it comes from: drop-offs (at the hub they were booked for), picked-up parcels, transfers and parcels back from riders (failed deliveries, unfinished returns). "Find" shows a parcel without receiving it.</p></div><div class="table-tools"><span class="status status-good" id="rdCount" style="white-space:nowrap">${esc(`${desk.received} received`)}</span></div></div>
        <form class="workflow-form" id="receiveDeskForm" autocomplete="off">
          <label>Hub${ui.select("rdHub", ui.hubOptions(hubs), desk.hubId)}</label>
          <label>Import batch${ui.select("rdBatch", batchOptions, desk.batchId)}</label>
          <label>Tracking ID / CN<input id="rdCode" autocomplete="off" spellcheck="false" placeholder="Scan or type, then Enter" aria-describedby="rdFeedback"></label>
          <div class="form-actions"><button class="button button-primary" type="submit">Receive</button><button class="button" type="button" data-rd="find" title="Show the parcel's details without receiving it">Find</button></div>
        </form>
        <p class="panel-subtitle" id="rdFeedback" aria-live="polite"${tone}>${esc(desk.feedback.text)}</p>
        <div id="rdBatchInfo">${summaryMarkup()}</div>
      </section>
      <section class="panel table-panel"><div class="panel-heading"><div><h2 class="panel-title">Scanned this session</h2><p class="panel-subtitle" id="rdSessionText">${esc(`${desk.log.length} scan${desk.log.length === 1 ? "" : "s"} · ${desk.received} received`)}</p></div></div><div id="rdLog">${logMarkup()}</div></section>
    </div>`;
  }

  /** Repaints the parts that change per scan, without touching the focused input. */
  function paintDesk() {
    if (!$("receiveDesk")) return;
    const f = $("rdFeedback");
    f.textContent = desk.feedback.text;
    f.style.fontWeight = desk.feedback.tone ? "600" : "";
    f.style.color = { good: "var(--green)", bad: "var(--red)", warn: "var(--amber)", blue: "#4266ce" }[desk.feedback.tone] || "";
    $("rdCount").textContent = `${desk.received} received`;
    $("rdSessionText").textContent = `${desk.log.length} scan${desk.log.length === 1 ? "" : "s"} · ${desk.received} received`;
    $("rdLog").innerHTML = logMarkup();
    $("rdBatchInfo").innerHTML = summaryMarkup();
  }

  async function loadBatches() {
    if (!desk.hubId) return;
    try {
      const page = await DF.api(`/ops/booking-batches?intake=DROP_OFF&hubId=${desk.hubId}&limit=30`);
      desk.batches = page.items;
      if (desk.batchId && !desk.batches.some(b => b.id === desk.batchId)) desk.batchId = "";
      desk.batch = desk.batches.find(b => b.id === desk.batchId) || null;
      const select = $("rdBatch");
      if (select && document.activeElement !== select) {
        select.innerHTML = [{ id: "", label: "Any parcel (no import)" }, ...desk.batches.map(b => ({ id: b.id, label: `${b.number} · ${b.received}/${b.expected} received${b.fileName ? ` · ${b.fileName}` : ""}` }))]
          .map(o => `<option value="${esc(o.id)}" ${o.id === desk.batchId ? "selected" : ""}>${esc(o.label)}</option>`)
          .join("");
      }
      paintDesk();
    } catch (error) {
      if (error?.status !== 403) console.error("Delivery Fast: import batches could not be loaded", error);
    }
  }

  async function loadMissing() {
    if (!desk.batchId) return;
    const detail = await DF.api(`/ops/booking-batches/${desk.batchId}`);
    desk.batch = detail;
    desk.missing = detail.parcels.filter(p => !p.received && !p.cancelled);
    paintDesk();
  }

  /** One scan: queued so scans are sent in order while the person keeps scanning. */
  function receive(code, source) {
    code = DF.scanner?.normalize ? DF.scanner.normalize(code) : String(code || "").trim().toUpperCase();
    if (!code) return;
    const hub = Ops.hubById(desk.hubId);
    if (!hub) return void ((desk.feedback = { tone: "bad", text: "Choose the hub you are receiving at." }), paintDesk());
    const entry = { code, outcome: "PENDING", message: `Receiving at ${hub.name}…`, at: new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) };
    desk.log.unshift(entry);
    desk.pending++;
    paintDesk();
    const batchId = desk.batchId || undefined;
    desk.queue = desk.queue.then(async () => {
      try {
        const r = await DF.api("/ops/hub-receive", { method: "POST", body: { code, hubId: hub.id, source, batchId } });
        Object.assign(entry, { outcome: r.outcome, message: r.message, parcel: r.parcel, code: r.parcel?.trackingId || r.code });
        if (r.outcome === "RECEIVED") desk.received++;
        if (r.batch && r.batch.id === desk.batchId) {
          desk.batch = r.batch;
          const listed = desk.batches.find(b => b.id === r.batch.id);
          if (listed) Object.assign(listed, r.batch);
          if (desk.missing && r.parcel) desk.missing = desk.missing.filter(p => p.trackingId !== r.parcel.trackingId || r.outcome !== "RECEIVED");
        }
        desk.feedback = { tone: (OUTCOME[r.outcome] || OUTCOME.REFUSED).tone, text: r.message };
        beep(r.ok);
      } catch (error) {
        Object.assign(entry, { outcome: "ERROR", message: DF.describe(error) });
        desk.feedback = { tone: "bad", text: DF.describe(error) };
        beep(false);
      } finally {
        desk.pending--;
        paintDesk();
      }
    });
    return desk.queue;
  }
  Ops.intake.receive = receive;

  // Only on Hub desk → Receive (Ops.hubPart, bridge-nav.js). The import batches load once when the
  // tab opens (or the hub changes), then after live parcel changes, never on every redraw.
  const baseHubs = Ops.enhance.Hubs;
  Ops.enhance.Hubs = page => {
    baseHubs?.(page);
    $("receiveDesk")?.remove();
    if (Ops.hubPart && Ops.hubPart !== "receive") return;
    const hubs = deskHubs();
    if (!desk.hubId || !hubs.some(h => h.id === desk.hubId)) {
      let remembered = null;
      try {
        remembered = localStorage.getItem(DESK_HUB_KEY);
      } catch {}
      desk.hubId = (hubs.some(h => h.id === remembered) && remembered) || hubs[0]?.id || null;
    }
    $("mainContent").insertAdjacentHTML("beforeend", deskMarkup());
    const input = $("rdCode");
    if (input && DF.scanner) {
      DF.scanner.attach(input, {
        title: "Scan parcels into the hub",
        label: "Camera",
        continuous: true,
        onScan: code => {
          input.value = "";
          receive(code, "CAMERA");
        },
      });
    }
    // Not before the person's hubs are known (Ops.ready): a deep link / reload can draw the desk first.
    if (Ops.ready && (desk.epoch !== Ops.navEpoch || desk.loadedFor !== desk.hubId)) {
      desk.epoch = Ops.navEpoch;
      desk.loadedFor = desk.hubId;
      void loadBatches();
    }
  };

  window.addEventListener(
    "submit",
    event => {
      if (event.target.id !== "receiveDeskForm") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!Ops.require("dispatch", "receive parcels")) return;
      const input = $("rdCode");
      const code = input.value;
      input.value = "";
      input.focus();
      receive(code, input.dataset.typed === "1" ? "MANUAL" : "KEYBOARD");
      input.dataset.typed = "";
    },
    true,
  );
  // Scanners type a whole code in a few milliseconds; slower typing is a person (MANUAL).
  let lastKey = 0;
  window.addEventListener("keydown", event => {
    if (event.target?.id !== "rdCode" || event.key === "Enter") return;
    const now = performance.now();
    if (event.target.value && now - lastKey > 60) event.target.dataset.typed = "1";
    lastKey = now;
  });
  window.addEventListener("change", event => {
    if (event.target.id === "rdHub") {
      desk.hubId = event.target.value;
      try {
        localStorage.setItem(DESK_HUB_KEY, desk.hubId);
      } catch {}
      desk.batchId = "";
      desk.batch = null;
      desk.missing = null;
      desk.batches = [];
      desk.loadedFor = desk.hubId;
      void loadBatches();
      $("rdCode")?.focus();
    }
    if (event.target.id === "rdBatch") {
      desk.batchId = event.target.value;
      desk.batch = desk.batches.find(b => b.id === desk.batchId) || null;
      desk.missing = null;
      paintDesk();
      $("rdCode")?.focus();
    }
  });
  window.addEventListener(
    "click",
    event => {
      const button = event.target.closest("[data-rd]");
      if (!button || !$("receiveDesk")?.contains(button)) return;
      event.stopImmediatePropagation();
      if (button.dataset.rd === "find") return void findCode();
      if (button.dataset.rd === "missing") loadMissing().catch(error => showToast(DF.describe(error)));
      if (button.dataset.rd === "labels") {
        const run = desk.missing ? Promise.resolve() : loadMissing();
        run.then(() => openLabels(desk.missing.map(p => p.trackingId), { title: "Print labels for missing parcels" })).catch(error => showToast(DF.describe(error)));
      }
    },
    true,
  );
  /** "Find": the code in the box → the parcel drawer (nothing is received). */
  function findCode() {
    const input = $("rdCode");
    const raw = input.value.trim();
    if (!raw) {
      desk.feedback = { tone: "warn", text: "Scan or type a tracking ID, CN or phone number, then choose Find." };
      return paintDesk();
    }
    Ops.recordScan?.(raw, "HUB_LOOKUP", desk.hubId, "KEYBOARD");
    (Ops.findParcels ? Ops.findParcels(raw) : Promise.resolve([]))
      .then(found => {
        if (!found.length) {
          desk.feedback = { tone: "bad", text: `No parcel found for ${raw}.` };
          return paintDesk();
        }
        const p = found[0];
        desk.feedback = { tone: "blue", text: `${p.trackingId} · ${p.statusLabel} · ${p.currentHub?.name || "not at a hub"} · ${p.recipient?.name || "recipient not set"}, ${p.delivery?.zone || "—"}` };
        paintDesk();
        Ops.drawer?.open(p.trackingId, found.length > 1 ? found : []);
      })
      .catch(error => {
        desk.feedback = { tone: "bad", text: DF.describe(error) };
        paintDesk();
      });
  }

  // Live: other desks receiving parcels of the chosen import.
  DF.events.on("parcel.updated", () => {
    if (!desk.batchId || !$("receiveDesk")) return;
    clearTimeout(desk.liveTimer);
    desk.liveTimer = setTimeout(() => void loadBatches(), 1500);
  });
  // ───────────── switching rider pickup ↔ hub drop-off ─────────────
  // Row action next to "Edit details" and a button in the parcel's tracking history:
  // POST /parcels/:id/intake (only before pickup; a pickup assignment is released, the parcel is
  // re-priced from its new origin and the sender gets an SMS).

  const INTAKE_CHANGEABLE = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];
  const canChangeIntake = p => !!p && INTAKE_CHANGEABLE.includes(p.status) && Ops.can("dispatch") && (p.intake !== "DROP_OFF" || Ops.inMyHubs(p.dropOffHub?.id));
  const intakeActionLabel = p => (p.intake === "DROP_OFF" ? "Change to rider pickup" : "Change to drop-off");
  const intakeButton = (p, extra = "") =>
    `<button class="button button-sm" type="button" data-intake-change="${esc(p.trackingId)}" ${extra}>${esc(intakeActionLabel(p))}</button>`;

  function addIntakeActions() {
    for (const edit of document.querySelectorAll("#mainContent [data-generated-edit]")) {
      const parcel = Ops.apiParcel(edit.dataset.generatedEdit);
      const cell = edit.parentElement;
      if (!cell || cell.querySelector("[data-intake-change]") || !canChangeIntake(parcel)) continue;
      edit.insertAdjacentHTML("afterend", intakeButton(parcel));
    }
  }
  // Shipment rows are redrawn by searches, filters, paging and live updates, not only by page renders.
  let intakeQueued = false;
  new MutationObserver(() => {
    if (intakeQueued) return;
    intakeQueued = true;
    queueMicrotask(() => {
      intakeQueued = false;
      addIntakeActions();
    });
  }).observe(document.getElementById("mainContent") || document.body, { childList: true, subtree: true });

  // (The parcel's detail view is the drawer, bridge-parcel.js: it shows the intake and its change button.)

  function openIntakeChange(parcel) {
    const toDropOff = parcel.intake !== "DROP_OFF";
    const hubs = hubChoices();
    const current = parcel.dropOffHub?.id;
    const preferred = toDropOff ? (hubs.length === 1 ? hubs[0].id : "") : current;
    const released = parcel.pickupRider ? ` ${parcel.pickupRider.label} is released from the pickup.` : "";
    Ops.dialog("intakeChange", {
      title: `${intakeActionLabel(parcel)} · ${parcel.trackingId}`,
      description: toDropOff
        ? `The sender brings the parcel to the hub instead of a rider collecting it.${released} The price is recalculated from the hub's location and the sender gets an SMS with the hub's address.`
        : `A pickup rider collects the parcel from ${[parcel.pickup?.zone, parcel.pickup?.district].filter(Boolean).join(", ") || "the pickup address"}; assign one afterwards. The price is recalculated from the pickup address and the sender gets an SMS.`,
      submit: intakeActionLabel(parcel),
      fields:
        ui.field("icIntake", "Intake", ui.select("icIntake", [{ value: "PICKUP", label: "Rider pickup" }, { value: "DROP_OFF", label: "Drop-off at hub" }], toDropOff ? "DROP_OFF" : "PICKUP")) +
        ui.field("icHub", "Drop-off hub", ui.select("icHub", ui.hubOptions(hubs, "Choose the hub"), preferred)) +
        ui.field("icNote", "Reason (staff only)", ui.input("icNote", 'maxlength="500" placeholder="e.g. The merchant will bring it to the hub"'), true) +
        `<div class="field full"><p id="icProblem" class="df-field-error" role="alert" hidden style="color:#c2410c;margin:0"></p></div>`,
      context: { trackingId: parcel.trackingId },
    });
    const intake = $("icIntake");
    const hub = $("icHub");
    const sync = () => {
      const drop = intake.value === "DROP_OFF";
      hub.disabled = !drop;
      hub.required = drop;
      $("modalSubmit").textContent = drop ? (parcel.intake === "DROP_OFF" ? "Move drop-off" : "Change to drop-off") : "Change to rider pickup";
    };
    intake.addEventListener("change", sync);
    sync();
  }

  window.addEventListener(
    "click",
    event => {
      const button = event.target.closest("[data-intake-change]");
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const parcel = Ops.apiParcel(button.dataset.intakeChange);
      if (!parcel) return;
      if (!Ops.require("dispatch", "change pickup or drop-off")) return;
      if (!INTAKE_CHANGEABLE.includes(parcel.status)) return void showToast(`${parcel.trackingId} is ${parcel.statusLabel.toLowerCase()}; pickup and drop-off can only change before pickup.`);
      openIntakeChange(parcel);
    },
    true,
  );

  Ops.submitters.intakeChange = async () => {
    const parcel = Ops.apiParcel(modalContext.trackingId);
    if (!parcel) return void closeModal();
    const problem = $("icProblem");
    const intake = $("icIntake").value;
    const hub = intake === "DROP_OFF" ? Ops.hubById($("icHub").value) : null;
    const say = message => {
      problem.textContent = message;
      problem.hidden = !message;
    };
    if (intake === "DROP_OFF" && !hub) {
      say("Choose the hub the sender will bring the parcel to.");
      $("icHub").focus();
      return;
    }
    if (intake === parcel.intake && (intake === "PICKUP" || hub?.id === parcel.dropOffHub?.id)) {
      say(intake === "PICKUP" ? "This parcel is already a rider pickup." : `It is already booked for drop-off at ${hub.name}.`);
      return;
    }
    say("");
    const body = { intake, ...(hub ? { dropOffHubId: hub.id } : {}), note: $("icNote").value.trim() || undefined, expectedVersion: parcel.version };
    try {
      const updated = await DF.api(`/parcels/${encodeURIComponent(parcel.trackingId)}/intake`, { method: "POST", body });
      closeModal();
      await Ops.refresh().catch(() => undefined);
      const charge = updated.charges?.total !== parcel.charges?.total ? ` New delivery charge ${Ops.money(updated.charges.total)}.` : "";
      showToast(`${parcel.trackingId} ${intake === "DROP_OFF" ? `is now a drop-off at ${hub.name}` : "is now a rider pickup"}. The sender was notified.${charge}`);
    } catch (error) {
      say(DF.describe(error));
      throw error;
    }
  };
})();
