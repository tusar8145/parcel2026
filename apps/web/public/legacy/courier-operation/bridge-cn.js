/*
 * Courier Operations on the API, part 6: consignment-number (CN) stock (sidebar "CN stock").
 *
 *   Allocate a batch       POST /cn/batches (up to 1000 CNs from the tracking-ID generator)
 *   Batches / stock        GET /cn/batches, /cn/batches/:id, /cn/stock, /cn/summary
 *   Issue to hub/merchant  PATCH /cn/batches/:id
 *   Print labels           POST /cn/batches/:id/print → barcode label sheet (A4, 3 × 8)
 *   Void lost labels       POST /cn/stock/void
 *   Check a label          GET /cn/stock/:cn (scan with the camera or a USB scanner)
 * A booking uses a label by sending its CN (New shipment → "Pre-printed CN").
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  const ui = Ops.ui;
  const $ = id => document.getElementById(id);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = Ops.esc;
  const PAGE = "CN stock";
  const onPage = () => Ops.page() === PAGE;
  const STATUS = { AVAILABLE: "Available", USED: "Used", VOID: "Void" };

  const state = { summary: null, batches: { items: [], next: null, q: "", hubId: "", loaded: false }, batch: null, check: null, merchants: null };

  async function loadSummary() {
    state.summary = await DF.api("/cn/summary").catch(() => null);
    paint();
  }
  async function loadBatches(more = false) {
    const s = state.batches;
    const params = new URLSearchParams({ limit: "25" });
    if (s.q) params.set("q", s.q);
    if (s.hubId) params.set("hubId", s.hubId);
    if (more && s.next) params.set("cursor", s.next);
    try {
      const page = await DF.api(`/cn/batches?${params}`);
      s.items = more ? [...s.items, ...page.items] : page.items;
      s.next = page.nextCursor;
      s.error = null;
    } catch (error) {
      s.error = DF.describe(error);
    }
    s.loaded = true;
    paint();
  }
  async function openBatch(id) {
    try {
      state.batch = await DF.api(`/cn/batches/${id}`);
    } catch (error) {
      showToast(DF.describe(error));
    }
    paint();
    $("cnBatchDetail")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  async function merchants() {
    if (!state.merchants) state.merchants = (await DF.api("/ops/merchants").catch(() => [])).filter(m => m.status === "ACTIVE");
    return state.merchants;
  }
  const reload = () => {
    void loadSummary();
    void loadBatches();
    if (state.batch) void openBatch(state.batch.id);
  };

  Ops.pages[PAGE] = {
    render: () =>
      `<div class="page-heading"><div><p class="eyebrow">Hub operations · labels</p><h1>CN stock</h1><p class="subtitle">Pre-allocate consignment numbers in batches, print barcode labels for hubs and merchants, and track used, unused and voided labels.</p></div><div class="heading-actions">${Ops.can("dispatch") ? `<button class="button button-primary" data-cn="allocate">${icon("plus")} Allocate batch</button>` : ""}</div></div><div class="metrics" id="cnMetrics"></div><div class="workflow-grid"><section class="panel" id="cnCheck"></section><section class="panel"><div class="panel-heading"><div><h2 class="panel-title">Using a label</h2><p class="panel-subtitle">Stick a pre-printed label on the parcel and enter its CN when booking (New shipment → Pre-printed CN, or the merchant API field cn). The CN becomes the tracking ID; each label can be used once. A batch issued to a merchant can only be used for that merchant's bookings.</p></div></div></section></div><section class="panel table-panel" id="cnBatchDetail" hidden></section><section class="panel table-panel" id="cnBatches"></section>`,
  };
  Ops.enhance[PAGE] = () => {
    paint();
    if (!state.batches.loaded) reload();
  };

  function paint() {
    if (onPage()) ui.keepFocus(repaint);
  }
  function repaint() {
    const s = state.summary;
    const v = key => (s ? Ops.num(s[key]) : "…");
    $("cnMetrics").innerHTML = [
      metric("Unused labels", v("available"), "box", s ? `${Ops.num(s.printedUnused)} printed` : "", "in stock"),
      metric("Used", v("used"), "check", "booked parcels", "all time"),
      metric("Voided", v("void"), "alert", "lost or damaged", "all time"),
      metric("Batches", v("batches"), "chart", s ? `${Ops.num(s.total)} labels` : "", Ops.me?.hubIds ? "your hub" : "network wide"),
    ].join("");

    const c = state.check;
    $("cnCheck").innerHTML = `<div class="panel-heading"><div><h2 class="panel-title">Check a label</h2><p class="panel-subtitle">Scan a pre-printed label to see whether it can still be used.</p></div></div><form class="workflow-form" id="cnCheckForm"><label>Consignment number<input id="cnCheckInput" autocomplete="off" placeholder="PP-261016-7K3QF" required></label><button class="button" type="submit">Check</button></form><p class="panel-subtitle" aria-live="polite">${
      c ? (c.error ? esc(c.error) : `${esc(c.cn)} · ${esc(STATUS[c.status])} · batch ${esc(c.batch.number)}${c.batch.hub ? ` · ${esc(c.batch.hub.name)}` : ""}${c.batch.merchant ? ` · issued to ${esc(c.batch.merchant.name)}` : ""}${c.parcel ? ` · parcel ${esc(c.parcel.trackingId)} (${esc(c.parcel.status)})` : ""}${c.voidReason ? ` · ${esc(c.voidReason)}` : ""}`) : ""
    }</p>`;
    DF.scanner?.attach($("cnCheckInput"), { title: "Scan a CN label", onScan: () => $("cnCheckForm").requestSubmit() });

    const b = state.batches;
    const rows = b.items
      .map(
        x =>
          `<tr><td><strong>${esc(x.number)}</strong><span class="subcell">${esc(ui.date(x.createdAt))}</span></td><td>${esc(x.hub?.name || "—")}</td><td>${esc(x.merchant?.name || "Any account")}</td><td>${x.stock.available} / ${x.count}</td><td>${x.stock.used}</td><td>${x.stock.void}</td><td>${esc(x.note || "")}</td><td><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="button button-sm" data-cn="open" data-id="${x.id}">View</button>${Ops.can("dispatch") ? `<button class="button button-sm" data-cn="print" data-id="${x.id}" ${x.stock.available ? "" : "disabled"}>Print unused</button><button class="button button-sm" data-cn="assign" data-id="${x.id}">Issue</button>` : ""}</div></td></tr>`,
      )
      .join("");
    const hubs = Ops.myHubs() || DF.state.hubs;
    $("cnBatches").outerHTML = ui.panel(
      "Batches",
      "Allocated label batches · newest first",
      ui.table(["Batch", "Hub", "Issued to", "Unused", "Used", "Void", "Note", ""], rows, b.error || (b.loaded ? "No batches yet. Allocate one to print labels." : "Loading…")) + ui.footer(`Showing ${b.items.length} batch(es)`, b.next ? 'data-cn="more"' : ""),
      `<input class="table-search" id="cnSearch" value="${esc(b.q)}" placeholder="Batch number, note or CN" aria-label="Search batches">${hubs.length > 1 ? ui.select("cnHubFilter", ui.hubOptions(hubs, "All hubs"), b.hubId, 'class="select-small" aria-label="Hub"') : ""}`,
      'id="cnBatches"',
    );

    const d = state.batch;
    const detail = $("cnBatchDetail");
    detail.hidden = !d;
    if (!d) return void (detail.innerHTML = "");
    const items = d.items
      .map(
        i =>
          `<tr><td>${i.status === "AVAILABLE" ? `<input type="checkbox" data-cn-item="${esc(i.cn)}" aria-label="Select ${esc(i.cn)}">` : ""}</td><td><strong>${esc(i.cn)}</strong></td><td>${ui.pill(STATUS[i.status])}</td><td>${esc(i.parcel ? `${i.parcel.trackingId} · ${i.parcel.recipientName}` : i.voidReason || "—")}</td><td>${i.printCount ? `${i.printCount}× · ${esc(Ops.when(i.lastPrintAt))}` : "Not printed"}</td></tr>`,
      )
      .join("");
    detail.innerHTML = `<div class="panel-heading"><div><h2 class="panel-title">Batch ${esc(d.number)}</h2><p class="panel-subtitle">${d.stock.available} unused · ${d.stock.used} used · ${d.stock.void} void${d.hub ? ` · ${esc(d.hub.name)}` : ""}${d.merchant ? ` · issued to ${esc(d.merchant.name)}` : ""}</p></div><div class="table-tools">${Ops.can("dispatch") ? `<button class="button button-sm" data-cn="print-selected">Print selected</button><button class="button button-sm" data-cn="void-selected">Void selected</button>` : ""}<button class="button button-sm" data-cn="close">Close</button></div></div><div class="table-scroll" style="max-height:360px;overflow:auto">${ui.table(["", "CN", "Status", "Parcel / reason", "Printed"], items, "Empty batch.").replace(/^<div class="table-scroll">|<\/div>$/g, "")}</div>`;
  }

  // ───────────── labels ─────────────

  async function printLabels(batchId, cns) {
    try {
      const result = await DF.api(`/cn/batches/${batchId}/print`, { method: "POST", body: cns ? { cns } : {} });
      if (!result.labels.length) return void showToast("No unused labels to print in this batch.");
      const who = [result.batch.hub?.name, result.batch.merchant?.name].filter(Boolean).join(" · ") || "Delivery Fast";
      const labels = result.labels
        .map(l => `<div class="label"><strong>Delivery Fast</strong><div class="barcode">${Ops.barcode(l.cn)}</div><div class="cn">${esc(l.cn)}</div><small>${esc(who)} · ${esc(result.batch.number)}${l.reprint ? " · reprint" : ""}</small></div>`)
        .join("");
      Ops.printPage(
        `Labels ${result.batch.number}`,
        `<style>@page{margin:8mm}.sheet{display:grid;grid-template-columns:repeat(3,1fr);gap:4mm}.label{border:1px dashed #98a2ae;border-radius:4px;padding:3mm;height:31mm;overflow:hidden;break-inside:avoid;text-align:center}.label .barcode svg{height:12mm;width:100%}.cn{font:700 13px Arial,sans-serif;letter-spacing:1px}.label small{color:#647184;font-size:9px}</style><div class="sheet">${labels}</div>`,
      );
      if (state.batch?.id === batchId) void openBatch(batchId);
      void loadBatches();
      void loadSummary();
    } catch (error) {
      showToast(DF.describe(error));
    }
  }

  // ───────────── dialogs ─────────────

  async function allocateDialog() {
    if (!Ops.require("dispatch", "allocate labels")) return;
    const list = await merchants();
    const hubs = Ops.myHubs() || DF.state.hubs;
    Ops.dialog("cnAllocate", {
      title: "Allocate CN batch",
      description: "Reserves consignment numbers for pre-printed labels. They are ordinary tracking IDs once used.",
      submit: "Allocate",
      fields:
        ui.field("cnCount", "Number of labels", ui.input("cnCount", 'type="number" min="1" max="1000" step="1" value="50" required')) +
        ui.field("cnHub", "Kept at hub", ui.select("cnHub", ui.hubOptions(hubs, Ops.myHubs() ? undefined : "No hub"), Ops.myHubs()?.[0]?.id)) +
        ui.field("cnMerchant", "Issued to merchant (optional)", ui.select("cnMerchant", [{ value: "", label: "Any account (hub counter)" }, ...list.map(m => ({ value: m.id, label: `${m.name} · ${m.code}` }))], ""), true) +
        ui.field("cnNote", "Note (optional)", ui.input("cnNote", 'maxlength="300" placeholder="e.g. Counter labels for October"'), true),
    });
  }
  Ops.submitters.cnAllocate = async () => {
    const valid = DF.validate($("modalForm"), { cnCount: v => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 1000 ? "" : "Allocate between 1 and 1000 labels") });
    if (!valid()) return;
    $("modalSubmit").textContent = "Allocating…";
    const batch = await DF.api("/cn/batches", {
      method: "POST",
      body: { count: Number($("cnCount").value), hubId: $("cnHub").value || undefined, merchantId: $("cnMerchant").value || undefined, note: $("cnNote").value.trim() || undefined },
    });
    closeModal();
    showToast(`${batch.number}: ${batch.count} consignment numbers allocated. Print the labels from the batch.`);
    state.batch = batch;
    reload();
  };

  async function assignDialog(id) {
    const batch = state.batches.items.find(b => b.id === id);
    if (!batch) return;
    const list = await merchants();
    Ops.dialog("cnAssign", {
      title: `Issue ${batch.number}`,
      description: "Move the labels to another hub or issue them to a merchant (only possible before any is used).",
      submit: "Save",
      context: { batchId: id },
      fields:
        ui.field("cnaHub", "Kept at hub", ui.select("cnaHub", ui.hubOptions(Ops.myHubs() || DF.state.hubs, Ops.myHubs() ? undefined : "No hub"), batch.hub?.id)) +
        ui.field("cnaMerchant", "Issued to merchant", ui.select("cnaMerchant", [{ value: "", label: "Any account (hub counter)" }, ...list.map(m => ({ value: m.id, label: `${m.name} · ${m.code}` }))], batch.merchant?.id || "")) +
        ui.field("cnaNote", "Note", ui.input("cnaNote", `maxlength="300" value="${esc(batch.note || "")}"`), true),
    });
  }
  Ops.submitters.cnAssign = async () => {
    await DF.api(`/cn/batches/${modalContext.batchId}`, {
      method: "PATCH",
      body: { hubId: $("cnaHub").value || null, merchantId: $("cnaMerchant").value || null, note: $("cnaNote").value.trim() || null },
    });
    closeModal();
    showToast("Batch updated.");
    reload();
  };

  function voidDialog(cns) {
    Ops.dialog("cnVoid", {
      title: `Void ${cns.length} label(s)`,
      description: cns.slice(0, 6).join(", ") + (cns.length > 6 ? "…" : ""),
      submit: "Void labels",
      context: { cns },
      fields: ui.field("cnVoidReason", "Reason", ui.input("cnVoidReason", 'required maxlength="300" placeholder="e.g. Labels damaged in the printer"'), true),
    });
  }
  Ops.submitters.cnVoid = async () => {
    const valid = DF.validate($("modalForm"), { cnVoidReason: v => (v.trim().length < 3 ? "Say why the labels are voided" : "") });
    if (!valid()) return;
    const result = await DF.api("/cn/stock/void", { method: "POST", body: { cns: modalContext.cns, reason: $("cnVoidReason").value.trim() } });
    closeModal();
    showToast(`${result.voided} label(s) voided${result.skipped.length ? `; ${result.skipped.length} skipped` : ""}.`);
    reload();
  };

  // ───────────── events ─────────────

  window.addEventListener(
    "click",
    event => {
      if (!onPage()) return;
      const el = event.target.closest("[data-cn]");
      if (!el) return;
      event.stopImmediatePropagation();
      const selected = () => qa("#cnBatchDetail [data-cn-item]:checked").map(i => i.dataset.cnItem);
      switch (el.dataset.cn) {
        case "allocate":
          return void allocateDialog();
        case "open":
          return void openBatch(el.dataset.id);
        case "close":
          state.batch = null;
          return paint();
        case "print":
          return void printLabels(el.dataset.id);
        case "assign":
          return void assignDialog(el.dataset.id);
        case "more":
          return void loadBatches(true);
        case "print-selected": {
          const cns = selected();
          return cns.length ? void printLabels(state.batch.id, cns) : showToast("Tick the labels to print.");
        }
        case "void-selected": {
          const cns = selected();
          return cns.length ? voidDialog(cns) : showToast("Tick the unused labels to void.");
        }
      }
    },
    true,
  );
  window.addEventListener(
    "submit",
    event => {
      if (!onPage() || event.target.id !== "cnCheckForm") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const code = $("cnCheckInput").value.trim();
      Ops.recordScan?.(code, "CN_CHECK", Ops.myHubs()?.[0]?.id);
      DF.api(`/cn/stock/${encodeURIComponent(code)}`)
        .then(item => (state.check = item))
        .catch(error => (state.check = { error: DF.describe(error) }))
        .finally(paint);
    },
    true,
  );
  const searchLater = ui.debounce(() => void loadBatches(), 350);
  window.addEventListener("input", event => {
    if (!onPage() || event.target.id !== "cnSearch") return;
    state.batches.q = event.target.value.trim();
    searchLater();
  });
  window.addEventListener("change", event => {
    if (!onPage() || event.target.id !== "cnHubFilter") return;
    state.batches.hubId = event.target.value;
    void loadBatches();
  });
  // Bookings use labels: refresh the counts when parcels are created.
  DF.live(["parcel.created"], () => {
    if (onPage()) {
      void loadSummary();
      void loadBatches();
    } else state.batches.loaded = false;
  });
})();
