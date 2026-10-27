/*
 * Merchant panel features on top of merchant-bridge.js (both merchant panels):
 * - Products page: the real catalogue (GET/POST/PATCH/DELETE /merchants/me/products), used to
 *   prefill the order form.
 * - Reports page: report exports from live data (GET /merchants/me/reports/:kind).
 * - Pickup requests page: recurring daily pickups and one-off pickup requests
 *   (/merchants/me/pickup-schedules, /merchants/me/pickup-requests); a pickup time window in the
 *   order form (GET /pickup-slots, when offered).
 * - Returns (RTO): request a return from the parcel details, the returns list on Shipments,
 *   confirm receipt (/returns, /parcels/:id/return-request, /parcels/:id/return-received).
 * - Proof of delivery in the parcel details (GET /parcels/:id/proof; tolerated while missing).
 * - Business verification (KYC) and the application review messages
 *   (/merchants/me/kyc…, /merchants/me/review…).
 * - Notification preferences (GET/PUT /me/notification-preferences; tolerated while missing).
 *
 * New UI reuses the page's CSS classes; actions use capture-phase listeners like the bridge.
 */
(() => {
  const DF = window.DF;
  const P = () => window.DFMerchantPanel;
  const S = () => P().state;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const q = (sep = "?") => P().merchantQuery(sep);
  const isOwner = () => S().merchant?.myRole === "MERCHANT_OWNER";
  const doc = () => !!S().cfg?.document;
  const toast = message => window.showToast(message);
  const fail = error => toast(DF.describe(error));
  const taka = n => `৳ ${(Math.round(Number(n || 0) * 100) / 100).toLocaleString("en-BD")}`;
  const dateOnly = iso => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
  const dateTime = iso => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
  const timeOnly = iso => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const pill = text => statusPill(text);
  const option = (value, label = value, selected = false) => `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;
  const input = (id, label, value = "", attrs = "", full = false) => `<div class="form-field${full ? " full" : ""}"><label for="${id}">${esc(label)}</label><input id="${id}" value="${esc(value ?? "")}" ${attrs}></div>`;
  const dhakaToday = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
  const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const F = { products: null, productsLoading: null, schedules: null, upcoming: null, slots: null, kyc: null, review: null, returnReasons: null };

  function dialog(title, subtitle, body, width) {
    return P().dialog(title, subtitle, body, width);
  }
  const closeDialog = () => P().closeDialog();
  /** Inline validation for our dialogs' forms (DF.validate); returns check() → valid. */
  const validate = (form, rules) => DF.validate(form, rules);

  // ───────────── products ─────────────

  async function loadProducts() {
    if (!S().merchant) return [];
    F.productsLoading ||= (async () => {
      const all = [];
      let cursor = null;
      do {
        const page = await DF.api(`/merchants/me/products?limit=200${q("&")}${cursor ? `&cursor=${cursor}` : ""}`);
        all.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor && all.length < 2000);
      F.products = all.sort((a, b) => a.name.localeCompare(b.name));
      return F.products;
    })().finally(() => (F.productsLoading = null));
    return F.productsLoading;
  }

  function productRows() {
    return (F.products || []).map(p => [
      p.name,
      p.sku,
      p.category || "—",
      doc() && !p.price ? "Per service package" : taka(p.price),
      [p.weightKg ? `${p.weightKg} kg` : "", p.packaging || ""].filter(Boolean).join(" · ") || "—",
      p.active ? "Active" : "Inactive",
    ]);
  }

  function beforeProducts() {
    const data = pageData.Products;
    data.columns = doc() ? ["Document class", "Code", "Category", "Price", "Default weight / packaging", "Status"] : ["Product", "SKU", "Category", "Price", "Default weight / packaging", "Status"];
    data.rows = productRows();
    data.stats = [
      [doc() ? "Document classes" : "Products", String(F.products?.length ?? 0)],
      ["Active", String((F.products || []).filter(p => p.active).length)],
      ["Categories", String(new Set((F.products || []).map(p => p.category).filter(Boolean)).size)],
    ];
  }

  function afterProducts() {
    const main = $("mainContent");
    const actions = main.querySelector(".page-heading .heading-actions");
    if (actions && !$("dfAddProduct")) actions.insertAdjacentHTML("afterbegin", `<button class="button button-primary" id="dfAddProduct">${icon("plus")} ${doc() ? "Add document class" : "Add product"}</button>`);
    const subtitle = main.querySelector(".page-table-panel .panel-subtitle");
    if (subtitle) subtitle.textContent = F.products ? `Catalogue · ${F.products.length} item(s) · used to prefill new orders` : "Loading the catalogue…";
    const head = main.querySelector(".page-table-panel thead tr");
    if (head && !head.querySelector("[data-dff-col]")) head.insertAdjacentHTML("beforeend", `<th data-dff-col></th>`);
    const body = $("tableBody");
    if (!body) return;
    [...body.querySelectorAll("tr")].forEach((row, i) => {
      const p = F.products?.[i];
      if (p) row.insertAdjacentHTML("beforeend", `<td style="white-space:nowrap"><button type="button" class="button button-sm" data-dff-product-edit="${esc(p.id)}">Edit</button> <button type="button" class="button button-sm" data-dff-product-delete="${esc(p.id)}">Remove</button></td>`);
    });
    if (!F.products?.length) body.innerHTML = `<tr class="df-empty"><td colspan="7" class="empty-state">${F.products ? (doc() ? "No document classes yet. Add the ones you send most often." : "No products yet. Add products to prefill orders with their weight, packaging and price.") : "Loading…"}</td></tr>`;
  }

  function openProduct(p) {
    const backdrop = dialog(
      p ? `Edit ${p.name}` : doc() ? "Add document class" : "Add product",
      "Prefills the order form: item, weight, packaging and value.",
      `<form id="dffProductForm" data-id="${esc(p?.id || "")}"><div class="form-grid" style="margin-top:12px">${input("dffProductName", doc() ? "Document class" : "Product name", p?.name, "required maxlength=160")}${input("dffProductSku", doc() ? "Code" : "SKU", p?.sku, "required maxlength=60")}${input("dffProductCategory", "Category (optional)", p?.category, "maxlength=80")}${input("dffProductPrice", doc() ? "Declared value (BDT)" : "Price (BDT)", p?.price ?? 0, 'type="number" min="0" step="0.01" required')}${input("dffProductWeight", "Default weight (kg, optional)", p?.weightKg ?? "", 'type="number" min="0.01" max="50" step="0.01"')}${input("dffProductPackaging", "Default packaging (optional)", p?.packaging, "maxlength=80")}<label class="form-field full" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="dffProductActive" ${p?.active === false ? "" : "checked"}> Active (offered in the order form)</label></div><div class="modal-actions"><button type="button" class="button" data-df-close>Cancel</button><button type="submit" class="button button-primary">Save</button></div></form>`,
    );
    const form = backdrop.querySelector("form");
    form.dfCheck = validate(form, {
      dffProductSku: v => (/^[\w.\-/ ]+$/.test(v.trim()) ? "" : "Use letters, digits, spaces and - _ . /"),
      dffProductPrice: v => (Number(v) >= 0 ? "" : "Enter 0 or more"),
      dffProductWeight: v => (!v || (Number(v) > 0 && Number(v) <= 50) ? "" : "Use a weight between 0.01 and 50 kg"),
    });
  }

  async function saveProduct(form) {
    if (form.dfCheck && !form.dfCheck()) return;
    const id = form.dataset.id;
    const weight = $("dffProductWeight").value;
    const optional = v => (v.trim() ? v.trim() : id ? null : undefined);
    const body = {
      name: $("dffProductName").value.trim(),
      sku: $("dffProductSku").value.trim(),
      category: optional($("dffProductCategory").value),
      price: Number($("dffProductPrice").value) || 0,
      weightKg: weight ? Number(weight) : id ? null : undefined,
      packaging: optional($("dffProductPackaging").value),
      active: $("dffProductActive").checked,
    };
    try {
      await DF.api(`/merchants/me/products${id ? `/${id}` : ""}${q()}`, { method: id ? "PATCH" : "POST", body });
      closeDialog();
      await loadProducts();
      if (S().page === "Products") window.renderPage("Products");
      toast(`${body.name} saved.`);
    } catch (error) {
      fail(error);
    }
  }

  /** A "From catalogue" picker at the top of the order form. */
  function addProductPicker() {
    const form = $("orderForm");
    if (!form || $("dffCatalogPick")) return;
    const active = (F.products || []).filter(p => p.active);
    if (!active.length) return;
    // Parcel section's slot (merchant-bridge.js layoutOrderForm), else the top of the form.
    const grid = $("dfoCatalogSlot") || form.querySelector(".form-grid") || form;
    grid.insertAdjacentHTML(
      "afterbegin",
      `<div class="form-field full"><label for="dffCatalogPick">From your catalogue (optional)</label><select id="dffCatalogPick">${option("", "Choose a product to prefill…")}${active.map(p => option(p.id, `${p.name} · ${p.sku}${p.price ? ` · ${taka(p.price)}` : ""}`)).join("")}</select></div>`,
    );
  }

  function applyProduct(id) {
    const p = (F.products || []).find(x => x.id === id);
    if (!p) return;
    const setSelect = (select, value) => {
      if (!select || !value) return;
      if (![...select.options].some(o => o.value === value)) select.insertAdjacentHTML("beforeend", option(value));
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    };
    // The product dropdown lists only the package's parcel products: pick one only when the saved item matches it.
    const wanted = doc() ? p.name : p.category || p.name;
    if ([...($("merchantProduct")?.options || [])].some(o => o.value && o.value === wanted)) setSelect($("merchantProduct"), wanted);
    const setNumber = (input, value) => {
      if (!input || !value) return;
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    setNumber($("merchantWeight"), p.weightKg);
    // The catalogue price is the product value; with COD ticked it is also the cash to collect.
    setNumber($("orderAmount"), p.price);
    if ($("merchantSvcCod")?.checked && $("merchantSvcCodAmount") && !$("merchantSvcCodAmount").value) setNumber($("merchantSvcCodAmount"), p.price);
    const ref = $("merchantReferenceNo");
    if (ref && !ref.value) ref.placeholder = `e.g. ${p.sku}-${new Date().getDate()}`;
  }

  // ───────────── pickup window in the order form ─────────────

  async function addPickupWindow() {
    const form = $("orderForm");
    const m = S().merchant;
    if (!form || !m || $("dffPickupWindow")) return;
    // In the Service section (merchant-bridge.js layoutOrderForm), else before the price.
    const slot = $("dfoPickupSlot");
    const anchor = slot || $("merchantPriceHint");
    if (!anchor) return;
    anchor.insertAdjacentHTML(slot ? "beforeend" : "beforebegin", `<div class="form-field"><label for="dffPickupWindow">Pickup time</label><select id="dffPickupWindow">${option("", "Any time today or next working day")}</select><small>Operations confirm the exact time.</small></div>`);
    try {
      const data = await DF.api(`/pickup-slots?district=${encodeURIComponent(m.pickupDistrict)}`);
      F.slots = data.days || [];
      const select = $("dffPickupWindow");
      if (!select) return;
      select.innerHTML =
        option("", "Any time (operations will confirm)") +
        F.slots
          .filter(d => !d.closed)
          .map(d => `<optgroup label="${esc(d.label)}">${d.slots.filter(s => s.available).map(s => option(`${s.start}|${s.end}`, `${d.label} · ${s.label}${s.remaining !== null ? ` · ${s.remaining} left` : ""}`)).join("")}</optgroup>`)
          .join("");
    } catch {
      // Pickup slots aren't available (yet): keep "any time".
    }
  }

  function pickupWindow() {
    const value = $("dffPickupWindow")?.value;
    if (!value) return undefined;
    const [start, end] = value.split("|");
    return { start, end };
  }

  // ───────────── reports ─────────────

  const REPORTS = () => [
    { kind: "orders", title: doc() ? "Delivery requests" : "Orders", owner: false },
    { kind: "delivery-performance", title: "Delivery performance by district", owner: false },
    { kind: "returns", title: "Returns (RTO)", owner: false },
    { kind: "cod-reconciliation", title: "COD reconciliation", owner: true, hide: doc() },
    { kind: "invoices", title: "Invoices", owner: true },
  ].filter(r => !r.hide);
  const PERIODS = { 7: "Last 7 days", 30: "Last 30 days", 90: "Last 90 days", 365: "Last 12 months" };
  let reportDays = 30;

  function beforeReports() {
    pageData.Reports.rows = REPORTS().map(r => [r.title, PERIODS[reportDays], "On demand · live data", "CSV", r.owner ? "Owners" : "Whole team", r.owner && !isOwner() ? "Owners only" : "Ready"]);
  }

  function afterReports() {
    const main = $("mainContent");
    const actions = main.querySelector(".page-heading .heading-actions");
    if (actions && !$("dffReportPeriod")) actions.insertAdjacentHTML("afterbegin", `<select id="dffReportPeriod" class="select-small" aria-label="Report period">${Object.entries(PERIODS).map(([d, l]) => option(d, l, Number(d) === reportDays)).join("")}</select>`);
    const subtitle = main.querySelector(".page-table-panel .panel-subtitle");
    if (subtitle) subtitle.textContent = "Generated from your live data when you download";
    const head = main.querySelector(".page-table-panel thead tr");
    if (head && !head.querySelector("[data-dff-col]")) head.insertAdjacentHTML("beforeend", `<th data-dff-col></th>`);
    const rows = $("tableBody")?.querySelectorAll("tr") || [];
    REPORTS().forEach((r, i) => {
      const cell = r.owner && !isOwner() ? `<td></td>` : `<td style="white-space:nowrap"><button type="button" class="button button-sm" data-dff-report="${r.kind}">Download CSV</button> <button type="button" class="button button-sm" data-dff-report-view="${r.kind}">View</button></td>`;
      rows[i]?.insertAdjacentHTML("beforeend", cell);
    });
  }

  async function fetchReport(kind) {
    const from = new Date(Date.now() - reportDays * 86_400_000).toISOString();
    return DF.api(`/merchants/me/reports/${kind}?format=json&from=${encodeURIComponent(from)}${q("&")}`);
  }
  const toCsv = (columns, rows) =>
    [columns, ...rows]
      .map(row => row.map(value => {
        let text = value == null ? "" : String(value);
        if (typeof value === "string" && /^[=+\-@]/.test(text)) text = `'${text}`;
        return `"${text.replaceAll('"', '""')}"`;
      }).join(","))
      .join("\r\n");

  async function downloadReport(kind) {
    try {
      const report = await fetchReport(kind);
      window.csvDownload(`${S().merchant.code.toLowerCase()}-${kind}-${new Date().toISOString().slice(0, 10)}.csv`, `﻿${toCsv(report.columns, report.rows)}`);
      toast(`${report.title}: ${report.rows.length} row(s) downloaded.`);
    } catch (error) {
      fail(error);
    }
  }

  async function viewReport(kind) {
    try {
      const report = await fetchReport(kind);
      const totals = Object.entries(report.summary).map(([k, v]) => `<span class="status status-blue">${esc(k.replace(/([A-Z])/g, " $1").toLowerCase())}: ${esc(typeof v === "number" ? v.toLocaleString("en-BD") : v)}</span>`).join(" ");
      dialog(
        report.title,
        `${esc(dateOnly(report.from))} – ${esc(dateOnly(report.to))} · ${report.rows.length} row(s)`,
        `<div style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0">${totals}</div><div class="table-scroll"><table><thead><tr>${report.columns.map(c => `<th>${esc(c.toUpperCase())}</th>`).join("")}</tr></thead><tbody>${report.rows
          .slice(0, 200)
          .map(r => `<tr>${r.map(v => `<td>${esc(typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? dateTime(v) : v ?? "—")}</td>`).join("")}</tr>`)
          .join("") || `<tr><td colspan="${report.columns.length}" class="empty-state">No rows in this period.</td></tr>`}</tbody></table></div>${report.rows.length > 200 ? `<p class="panel-subtitle">First 200 rows shown; download the CSV for all of them.</p>` : ""}<div class="modal-actions"><button type="button" class="button button-primary" data-dff-report="${esc(kind)}">Download CSV</button></div>`,
        900,
      );
    } catch (error) {
      fail(error);
    }
  }

  // ───────────── pickups ─────────────

  async function loadPickups() {
    if (!S().merchant) return;
    const [schedules, upcoming] = await Promise.allSettled([
      DF.api(`/merchants/me/pickup-schedules${q()}`),
      DF.api(`/merchants/me/pickup-requests?from=${dhakaToday()}&limit=50${q("&")}`),
    ]);
    F.schedules = schedules.status === "fulfilled" ? schedules.value.items : [];
    F.upcoming = upcoming.status === "fulfilled" ? upcoming.value.items : [];
  }

  const windowLabel = r => `${timeOnly(r.windowStart)} – ${timeOnly(r.windowEnd)}`;
  const PICKUP_STATUS = { REQUESTED: "Requested", ASSIGNED: "Rider assigned", COMPLETED: "Collected", CANCELLED: "Cancelled", MISSED: "Missed" };

  function afterPickups() {
    const main = $("mainContent");
    const actions = main.querySelector(".page-heading .heading-actions");
    if (actions && !$("dffSchedules"))
      actions.insertAdjacentHTML("afterbegin", `<button class="button" id="dffSchedules">${icon("calendar")} Recurring pickups</button><button class="button button-primary" id="dffRequestPickup">${icon("plus")} Request a pickup</button>`);
    if ($("dffPickupPanel")) return;
    const upcoming = (F.upcoming || []).filter(r => r.status === "REQUESTED" || r.status === "ASSIGNED");
    const rows = upcoming
      .map(r => `<tr><td><strong>${esc(r.number)}</strong></td><td>${esc(dateOnly(`${r.date}T00:00:00+06:00`))} · ${esc(windowLabel(r))}</td><td>${esc(r.schedule?.name || "One-off request")}</td><td>${esc(DF.addressText(r.street, r.zone))}</td><td>${r.expectedParcels}</td><td>${pill(PICKUP_STATUS[r.status] || r.status)}</td><td>${r.status === "REQUESTED" ? `<button type="button" class="button button-sm" data-dff-pickup-cancel="${esc(r.id)}">Cancel</button>` : ""}</td></tr>`)
      .join("");
    const panel = `<section class="panel table-panel" id="dffPickupPanel" style="margin-bottom:14px"><div class="panel-heading"><div><h2 class="panel-title">Scheduled pickups</h2><p class="panel-subtitle">${F.schedules?.length ? `${F.schedules.filter(s => s.active).length} recurring pickup(s) active · ` : ""}upcoming visits by operations</p></div></div><div class="table-scroll"><table><thead><tr><th>PICKUP</th><th>WHEN</th><th>SCHEDULE</th><th>ADDRESS</th><th>PARCELS</th><th>STATUS</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="empty-state">${F.upcoming ? "No scheduled pickups. Set up a recurring pickup or request one." : "Loading…"}</td></tr>`}</tbody></table></div></section>`;
    main.querySelector(".page-table-panel")?.insertAdjacentHTML("beforebegin", panel);
  }

  function openSchedules() {
    const m = S().merchant;
    const list = (F.schedules || [])
      .map(s => `<tr><td><strong>${esc(s.name)}</strong><div class="customer-phone">${esc(DF.addressText(s.street, s.zone, s.district))}</div></td><td>${s.days.map(d => WEEKDAYS[d]).join(", ")}</td><td>${esc(s.windowStart)}–${esc(s.windowEnd)}</td><td>${s.expectedParcels}</td><td>${pill(s.active ? "Active" : "Paused")}</td><td style="white-space:nowrap"><button type="button" class="button button-sm" data-dff-schedule-toggle="${esc(s.id)}">${s.active ? "Pause" : "Resume"}</button> <button type="button" class="button button-sm" data-dff-schedule-delete="${esc(s.id)}">Remove</button></td></tr>`)
      .join("");
    const backdrop = dialog(
      "Recurring pickups",
      "On the chosen days a pickup request is created for operations automatically.",
      `<div class="table-scroll"><table><thead><tr><th>SCHEDULE</th><th>DAYS</th><th>WINDOW</th><th>PARCELS</th><th>STATUS</th><th></th></tr></thead><tbody>${list || `<tr><td colspan="6" class="empty-state">No recurring pickups yet.</td></tr>`}</tbody></table></div>
      <form id="dffScheduleForm"><h3 style="font-size:14px;margin:16px 0 0">Add a recurring pickup</h3><div class="form-grid" style="margin-top:10px">${input("dffScheduleName", "Name", "Daily pickup", "required minlength=2 maxlength=80")}${input("dffScheduleParcels", "Usual number of parcels", "10", 'type="number" min="1" max="5000" required')}${input("dffScheduleStart", "Window starts", "10:00", 'type="time" required')}${input("dffScheduleEnd", "Window ends", "13:00", 'type="time" required')}<fieldset class="form-field full" style="border:0;padding:0;margin:0"><legend style="font-size:13px;font-weight:600;margin-bottom:6px">Days</legend>${WEEKDAYS.map((d, i) => `<label style="display:inline-flex;gap:6px;align-items:center;margin:4px 12px 4px 0;font-size:13px"><input type="checkbox" name="dffScheduleDay" value="${i}" ${i === 5 ? "" : "checked"}> ${d}</label>`).join("")}</fieldset>${input("dffScheduleStreet", "Pickup address", m.pickupAddress, "required minlength=3", true)}${input("dffScheduleZone", "Zone / area", m.pickup?.zone || m.pickupArea, "required minlength=2")}${input("dffScheduleDistrict", "District", m.pickupDistrict, "required minlength=2")}${input("dffScheduleContact", "Contact name", m.pickupContactName || m.contactName, "required minlength=2")}${input("dffSchedulePhone", "Contact mobile", String(m.pickupContactPhone || m.contactPhone || "").replace(/^\+880/, ""), "required")}${input("dffScheduleNote", "Note for the rider (optional)", "", "maxlength=500", true)}</div><div class="modal-actions"><button type="button" class="button" data-df-close>Close</button><button type="submit" class="button button-primary">Save recurring pickup</button></div></form>`,
      760,
    );
    const form = backdrop.querySelector("form");
    DF.phoneInput($("dffSchedulePhone"));
    form.dfCheck = validate(form, {
      dffScheduleEnd: v => (v && $("dffScheduleStart").value && v > $("dffScheduleStart").value ? "" : "End after the start time"),
      dffScheduleParcels: v => (Number(v) >= 1 ? "" : "At least 1"),
    });
  }

  async function saveSchedule(form) {
    if (form.dfCheck && !form.dfCheck()) return;
    const days = [...form.querySelectorAll('input[name="dffScheduleDay"]:checked')].map(i => Number(i.value));
    if (!days.length) return toast("Choose at least one day.");
    const body = {
      name: $("dffScheduleName").value.trim(),
      days,
      windowStart: $("dffScheduleStart").value,
      windowEnd: $("dffScheduleEnd").value,
      street: $("dffScheduleStreet").value.trim(),
      zone: $("dffScheduleZone").value.trim(),
      district: $("dffScheduleDistrict").value.trim(),
      contactName: $("dffScheduleContact").value.trim(),
      contactPhone: $("dffSchedulePhone").value.trim(),
      expectedParcels: Number($("dffScheduleParcels").value) || 1,
      note: $("dffScheduleNote").value.trim() || undefined,
    };
    try {
      await DF.api(`/merchants/me/pickup-schedules${q()}`, { method: "POST", body });
      await loadPickups();
      openSchedules();
      refreshPickupPage();
      toast("Recurring pickup saved. Upcoming pickups were scheduled.");
    } catch (error) {
      fail(error);
    }
  }

  function openPickupRequest() {
    const today = dhakaToday();
    const backdrop = dialog(
      "Request a pickup",
      `From ${esc(window.DFMerchantAddress ? window.DFMerchantAddress.placeText(S().merchant.pickup) : S().merchant.pickupAddress)} unless you change it.`,
      `<form id="dffPickupForm"><div class="form-grid" style="margin-top:12px"><div class="form-field"><label for="dffPickupDate">Date</label><select id="dffPickupDate">${[0, 1, 2, 3, 4, 5, 6].map(n => addDays(today, n)).map((d, i) => option(d, `${i === 0 ? "Today" : i === 1 ? "Tomorrow" : WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]} · ${d}`)).join("")}</select></div>${input("dffPickupParcels", "Number of parcels", "5", 'type="number" min="1" max="5000" required')}${input("dffPickupStart", "Window starts", "14:00", 'type="time" required')}${input("dffPickupEnd", "Window ends", "17:00", 'type="time" required')}${input("dffPickupNote", "Note for the rider (optional)", "", "maxlength=500", true)}</div><div class="modal-actions"><button type="button" class="button" data-df-close>Cancel</button><button type="submit" class="button button-primary">Request pickup</button></div></form>`,
    );
    const form = backdrop.querySelector("form");
    form.dfCheck = validate(form, { dffPickupEnd: v => (v && v > $("dffPickupStart").value ? "" : "End after the start time") });
  }

  async function savePickupRequest(form) {
    if (form.dfCheck && !form.dfCheck()) return;
    try {
      const r = await DF.api(`/merchants/me/pickup-requests${q()}`, {
        method: "POST",
        body: { date: $("dffPickupDate").value, windowStart: $("dffPickupStart").value, windowEnd: $("dffPickupEnd").value, expectedParcels: Number($("dffPickupParcels").value) || 1, note: $("dffPickupNote").value.trim() || undefined },
      });
      closeDialog();
      await loadPickups();
      refreshPickupPage();
      toast(`Pickup ${r.number} requested for ${windowLabel(r)}.`);
    } catch (error) {
      fail(error);
    }
  }

  function refreshPickupPage() {
    if (S().page !== "Pickup requests") return;
    $("dffPickupPanel")?.remove();
    afterPickups();
  }

  // ───────────── returns (RTO) ─────────────

  const RETURNABLE = ["PICKED_UP", "AT_HUB", "IN_TRANSIT", "ASSIGNED", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "EXCEPTION"];
  const STAGE = { requested: "Return requested", scheduled: "Return scheduled", returned: "Returned · confirm receipt", received: "Return received" };

  async function openReturns(stage = "all") {
    try {
      const page = await DF.api(`/returns?stage=${stage}&limit=100${q("&")}`);
      const rows = page.items
        .map(r => `<tr><td><button type="button" class="button button-sm" data-merchant-history="${esc(r.trackingId)}">${esc(r.trackingId)}</button><div class="customer-phone">${esc(r.merchantOrderRef || "")}</div></td><td>${esc(r.recipientName)}<div class="customer-phone">${esc(r.deliveryZone)}, ${esc(r.deliveryDistrict)}</div></td><td>${esc(r.reason || "—")}</td><td>${esc(dateOnly(r.requestedAt))}</td><td>${r.returnCharge != null ? taka(r.returnCharge) : "—"}</td><td>${pill(STAGE[r.stage] || r.stage)}</td><td>${r.stage === "returned" ? `<button type="button" class="button button-sm" data-dff-return-received="${esc(r.trackingId)}">Confirm received</button>` : ""}</td></tr>`)
        .join("");
      const tabs = ["all", "requested", "scheduled", "returned", "received"].map(s => `<button type="button" class="button button-sm${s === stage ? " button-primary" : ""}" data-dff-returns="${s}">${s === "all" ? "All" : STAGE[s].split(" · ")[0]}</button>`).join(" ");
      dialog(
        "Returns (RTO)",
        "Parcels coming back to you. Request a return from a parcel's details when it can't be delivered.",
        `<div style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0">${tabs}</div><div class="table-scroll"><table><thead><tr><th>TRACKING</th><th>RECIPIENT</th><th>REASON</th><th>REQUESTED</th><th>RETURN CHARGE</th><th>STAGE</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="empty-state">No returns${stage === "all" ? "" : " at this stage"}.</td></tr>`}</tbody></table></div>`,
        900,
      );
    } catch (error) {
      fail(error);
    }
  }

  async function requestReturn(trackingId) {
    if (!F.returnReasons) F.returnReasons = (await DF.api("/returns/reasons").catch(() => ({ reasons: [] }))).reasons;
    const backdrop = dialog(
      `Return ${trackingId} to you`,
      "Operations stop delivery attempts and bring the parcel back. A return charge applies.",
      `<form id="dffReturnForm" data-id="${esc(trackingId)}"><div class="form-grid" style="margin-top:12px"><div class="form-field full"><label for="dffReturnReason">Reason</label><select id="dffReturnReason">${F.returnReasons.map(r => option(r)).join("")}${option("__other", "Other…")}</select></div>${input("dffReturnOther", "Describe the reason", "", "maxlength=300", true)}</div><div class="modal-actions"><button type="button" class="button" data-df-close>Cancel</button><button type="submit" class="button button-primary">Request return</button></div></form>`,
    );
    const other = $("dffReturnOther").closest(".form-field");
    const sync = () => (other.hidden = $("dffReturnReason").value !== "__other");
    $("dffReturnReason").addEventListener("change", sync);
    sync();
    backdrop.querySelector("form").dfCheck = validate(backdrop.querySelector("form"), { dffReturnOther: v => ($("dffReturnReason").value !== "__other" || v.trim().length >= 3 ? "" : "Describe the reason (at least 3 characters)") });
  }

  async function saveReturn(form) {
    if (form.dfCheck && !form.dfCheck()) return;
    const chosen = $("dffReturnReason").value;
    const reason = chosen === "__other" ? $("dffReturnOther").value.trim() : chosen;
    try {
      await DF.api(`/parcels/${encodeURIComponent(form.dataset.id)}/return-request`, { method: "POST", body: { reason } });
      closeDialog();
      await P().refresh();
      toast(`Return requested for ${form.dataset.id}. Operations will schedule it.`);
    } catch (error) {
      fail(error);
    }
  }

  async function confirmReceived(trackingId) {
    try {
      await DF.api(`/parcels/${encodeURIComponent(trackingId)}/return-received`, { method: "POST" });
      closeDialog();
      await P().refresh();
      toast(`${trackingId} marked as received.`);
    } catch (error) {
      fail(error);
    }
  }

  /** Adds return actions, return details and proof of delivery to the bridge's parcel dialog. */
  async function enhanceParcelDialog(backdrop) {
    const title = backdrop.querySelector("#merchantHistoryTitle")?.textContent || "";
    const match = title.match(/^Tracking history · (.+)$/);
    if (!match || backdrop.dataset.dffDone) return;
    backdrop.dataset.dffDone = "1";
    const id = match[1];
    const p = P().byId(id) || (await DF.api(`/parcels/${encodeURIComponent(id)}`).catch(() => null));
    if (!p) return;
    const body = backdrop.querySelector("#dfDialogBody");
    const grid = body?.querySelector("div");
    const info = p.returnInfo;
    const extra = [];
    if (info) extra.push(["Return", [info.reason, info.requestedBy ? `requested by ${info.requestedBy}` : "", info.charge != null ? `charge ${taka(info.charge)}` : "", info.receivedAt ? `received ${dateOnly(info.receivedAt)}` : ""].filter(Boolean).join(" · ")]);
    if (p.pickupWindowStart) extra.push(["Pickup window", `${dateTime(p.pickupWindowStart)} – ${timeOnly(p.pickupWindowEnd)}`]);
    for (const [label, value] of extra) grid?.insertAdjacentHTML("beforeend", `<div><small style="color:#758195;display:block;font-size:11px;letter-spacing:.06em;text-transform:uppercase">${esc(label)}</small><strong style="font-size:13px;font-weight:600">${esc(value)}</strong></div>`);
    const buttons = [];
    if (RETURNABLE.includes(p.status) && !info?.requestedAt) buttons.push(`<button type="button" class="button" data-dff-return-request="${esc(id)}">Request return</button>`);
    if (p.status === "RETURNED" && !info?.receivedAt) buttons.push(`<button type="button" class="button button-primary" data-dff-return-received="${esc(id)}">Confirm return received</button>`);
    if (buttons.length) {
      const existing = body.querySelector(".modal-actions");
      if (existing) existing.insertAdjacentHTML("beforeend", buttons.join(""));
      else body.insertAdjacentHTML("beforeend", `<div class="modal-actions">${buttons.join("")}</div>`);
    }
    if (p.status !== "DELIVERED") return;
    try {
      const proof = await DF.api(`/parcels/${encodeURIComponent(id)}/proof`);
      const where = proof.location ? ` · <a href="https://www.openstreetmap.org/?mlat=${proof.location.lat}&mlon=${proof.location.lng}#map=17/${proof.location.lat}/${proof.location.lng}" target="_blank" rel="noopener">map ↗</a>` : "";
      let image = "";
      if (proof.image?.url) {
        const file = await DF.api(proof.image.url.replace(/^\/api\/v1/, ""), { headers: { accept: "application/json" } }).catch(() => null);
        if (file?.dataUrl && /^data:image\//.test(file.dataUrl)) image = `<img src="${esc(file.dataUrl)}" alt="Proof of delivery" style="display:block;max-width:100%;max-height:220px;margin-top:8px;border-radius:8px;border:1px solid #dfe5ee">`;
      }
      const method = { OTP: "Recipient code", SIGNATURE: "Signature", PHOTO: "Photo" }[proof.method] || proof.method;
      grid?.insertAdjacentHTML(
        "afterend",
        `<section style="margin-top:12px;padding:12px;border:1px solid #dfe5ee;border-radius:10px"><strong style="font-size:13px">Proof of delivery</strong><div class="panel-subtitle" style="margin-top:4px">${esc(method)} · received by ${esc(proof.receivedBy || p.recipient.name)} · ${esc(dateTime(proof.capturedAt || proof.recordedAt))}${proof.rider ? ` · ${esc(proof.rider.name)}` : ""}${where}</div>${image}</section>`,
      );
    } catch {
      // No proof recorded (or the endpoint isn't available yet).
    }
  }

  // ───────────── KYC and application review ─────────────

  const KYC_LABEL = { NOT_SUBMITTED: "Not submitted", PENDING: "Under review", APPROVED: "Verified", REJECTED: "Not approved" };

  async function openKyc() {
    try {
      F.kyc = await DF.api(`/merchants/me/kyc${q()}`);
    } catch (error) {
      return fail(error);
    }
    const k = F.kyc;
    const owner = isOwner();
    const rows = k.policy.documentTypes
      .map(t => {
        const d = k.documents.find(x => x.type === t.type);
        return `<tr><td><strong>${esc(t.label)}</strong>${t.required ? "" : " <small>(optional)</small>"}</td><td>${d ? `${esc(d.filename)}<div class="customer-phone">${esc(dateOnly(d.uploadedAt))}</div>` : "—"}</td><td>${d ? pill("Uploaded") : pill(t.required ? "Missing" : "Optional")}</td><td style="white-space:nowrap">${owner && k.canUpload ? `<button type="button" class="button button-sm" data-dff-kyc-pick="${esc(t.type)}">${d ? "Replace" : "Upload"}</button>` : ""}${d && owner ? ` <button type="button" class="button button-sm" data-dff-kyc-view="${esc(d.id)}">View</button>` : ""}</td></tr>`;
      })
      .join("");
    // One upload form under the table: document type, the shared "Choose file" drop zone, Upload.
    const uploadForm =
      owner && k.canUpload
        ? `<form id="dffKycForm" style="margin-top:12px;padding:12px;border:1px solid #dfe5ee;border-radius:10px;display:grid;gap:10px"><strong style="font-size:13px">Upload a document</strong><div class="form-field"><label for="dffKycType">Document</label><select id="dffKycType">${k.policy.documentTypes.map(t => `<option value="${esc(t.type)}">${esc(t.label)}${k.documents.some(x => x.type === t.type) ? " (replace)" : ""}</option>`).join("")}</select></div><div class="form-field"><label for="dffKycFile">File</label><input type="file" id="dffKycFile" accept="image/png,image/jpeg,image/webp,application/pdf" data-file-drop data-max-mb="3.5" required></div><div style="display:flex;justify-content:flex-end"><button type="submit" class="button button-primary" id="dffKycUpload">Upload</button></div></form>`
        : "";
    const needs = [k.policy.requireForApiKeys && "API keys", k.policy.requireForCodPayouts && "COD payouts", k.policy.requireForActivation && "account approval"].filter(Boolean);
    dialog(
      "Business verification",
      `${pill(KYC_LABEL[k.status] || k.status)} ${needs.length ? `· Needed for ${esc(needs.join(", "))}` : ""}`,
      `${k.status === "REJECTED" && k.rejectionReason ? `<p class="panel-subtitle" style="color:#b42318;margin:10px 0">Not approved: ${esc(k.rejectionReason)}. Replace the documents and submit again.</p>` : ""}${k.status === "PENDING" ? `<p class="panel-subtitle" style="margin:10px 0">Your documents are being reviewed. We'll text ${esc(S().merchant.contactPhone)} with the result.</p>` : ""}<div class="table-scroll"><table><thead><tr><th>DOCUMENT</th><th>FILE</th><th>STATUS</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>${uploadForm}<p class="panel-subtitle" style="margin:10px 0 0">PNG, JPEG, WebP or PDF, up to 3.5 MB each. Files are stored privately and only Paira Express reviewers can see them.</p>${
        k.history.length ? `<h3 style="font-size:13px;margin:14px 0 6px">History</h3><ul style="margin:0;padding-left:18px;color:#536174;font-size:12px;line-height:1.7">${k.history.map(h => `<li>${esc(dateTime(h.at))} · ${esc(h.body)}</li>`).join("")}</ul>` : ""
      }<div class="modal-actions"><button type="button" class="button" data-df-close>Close</button>${owner && k.canSubmit ? `<button type="button" class="button button-primary" data-dff-kyc-submit>Submit for review</button>` : ""}</div>${owner ? "" : `<p class="panel-subtitle">Only workspace owners can upload documents.</p>`}`,
      720,
    );
  }

  /** "Upload" / "Replace" in a row: choose that document type in the form and open the file picker. */
  function pickKyc(type) {
    const select = document.getElementById("dffKycType");
    const input = document.getElementById("dffKycFile");
    if (!select || !input) return;
    select.value = type;
    input.click();
  }

  function uploadKyc() {
    const inputEl = document.getElementById("dffKycFile");
    const type = document.getElementById("dffKycType")?.value;
    const file = inputEl?.files?.[0];
    if (!file) return toast("Choose the file to upload.");
    if (file.size > 3.5 * 1024 * 1024) return toast("That file is larger than 3.5 MB. Use a smaller scan or photo.");
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await DF.api(`/merchants/me/kyc/documents${q()}`, { method: "POST", body: { type, filename: file.name.slice(0, 120), file: reader.result } });
        toast(`${file.name} uploaded.`);
        await openKyc();
      } catch (error) {
        fail(error);
      }
    };
    reader.onerror = () => toast("The file couldn't be read.");
    reader.readAsDataURL(file);
  }

  async function submitKyc() {
    try {
      await DF.api(`/merchants/me/kyc/submit${q()}`, { method: "POST" });
      await P().reloadMerchant();
      await openKyc();
      toast("Documents submitted for review.");
    } catch (error) {
      fail(error);
    }
  }

  async function viewKycDocument(id) {
    try {
      const d = await DF.api(`/merchants/me/kyc/documents/${id}${q()}`);
      const w = window.open("", "_blank");
      if (!w) return toast("Allow pop-ups to view the document.");
      w.document.write(d.mimeType === "application/pdf" ? `<title>${esc(d.filename)}</title><iframe src="${esc(d.dataUrl)}" style="border:0;width:100%;height:100vh"></iframe>` : `<title>${esc(d.filename)}</title><img src="${esc(d.dataUrl)}" style="max-width:100%">`);
      w.document.close();
    } catch (error) {
      fail(error);
    }
  }

  /** Application status banner on the dashboard (under review, information requested, rejected). */
  async function reviewBanner() {
    const m = S().merchant;
    if (!m || !["PENDING_REVIEW", "INFO_REQUESTED", "REJECTED"].includes(m.status) || $("dffReview")) return;
    try {
      F.review = await DF.api(`/merchants/me/review${q()}`);
    } catch {
      return;
    }
    const r = F.review;
    const heading = { PENDING_REVIEW: "Your application is being reviewed", INFO_REQUESTED: "Paira Express needs more information", REJECTED: "Your application wasn't approved" }[r.status];
    const messages = r.messages
      .slice(-5)
      .map(x => `<div class="activity-item"><span class="activity-icon">${icon(x.kind === "APPLICANT_RESPONSE" ? "users" : "bell")}</span><div class="activity-copy"><strong>${esc(x.author)}</strong> ${esc(x.body)}<small>${esc(dateTime(x.at))}</small></div></div>`)
      .join("");
    const form =
      r.canRespond && isOwner()
        ? `<form id="dffReviewForm" style="margin-top:12px"><div class="form-field"><label for="dffReviewAnswer">Your answer</label><textarea id="dffReviewAnswer" rows="3" required minlength="2" maxlength="2000" placeholder="Explain what you changed or uploaded"></textarea></div><div class="modal-actions"><button type="button" class="button" data-dff-open-kyc>Upload documents</button><button type="submit" class="button button-primary">Send and resubmit</button></div></form>`
        : r.status === "REJECTED"
          ? `<p class="panel-subtitle" style="margin-top:10px">${esc(r.rejectionReason || "")} You can apply again with corrected details from the website.</p>`
          : `<div class="modal-actions" style="margin-top:10px"><button type="button" class="button" data-dff-open-kyc>Business verification</button></div>`;
    $("mainContent").querySelector(".page-heading")?.insertAdjacentHTML(
      "afterend",
      `<section class="panel" id="dffReview" style="margin-bottom:14px"><div class="panel-heading"><div><h2 class="panel-title">${esc(heading)}</h2><p class="panel-subtitle">${esc(m.name)} · ${esc(m.code)}</p></div>${pill({ PENDING_REVIEW: "Pending review", INFO_REQUESTED: "Action needed", REJECTED: "Not approved" }[r.status])}</div>${messages ? `<div class="activity-list">${messages}</div>` : ""}${form}</section>`,
    );
  }

  async function sendReviewAnswer(form) {
    const message = $("dffReviewAnswer").value.trim();
    if (message.length < 2) return toast("Write your answer first.");
    try {
      await DF.api(`/merchants/me/review/respond${q()}`, { method: "POST", body: { message } });
      await P().reloadMerchant();
      $("dffReview")?.remove();
      await reviewBanner();
      toast("Thanks — your application is back with our team.");
    } catch (error) {
      fail(error);
    }
  }

  // ───────────── notification preferences ─────────────

  async function openNotifications() {
    let prefs;
    try {
      prefs = await DF.api("/me/notification-preferences");
    } catch (error) {
      if (error.status === 404) return toast(`Delivery SMS go to ${S().merchant.contactPhone}. Change the contact phone in the profile.`);
      return fail(error);
    }
    const channels = [...new Set(prefs.events.flatMap(e => Object.keys(e.channels)))];
    const rows = prefs.events
      .map(e => `<tr><td><strong>${esc(e.label)}</strong><div class="customer-phone">${esc(e.group)}</div></td>${channels.map(c => {
        const ch = e.channels[c];
        if (!ch) return "<td>—</td>";
        return `<td><input type="checkbox" data-dff-pref="${esc(e.event)}" data-channel="${esc(c)}" ${ch.enabled ? "checked" : ""} ${ch.locked || !ch.available ? "disabled" : ""} title="${ch.locked ? "Security messages can't be switched off" : ch.available ? "" : "Not offered by Paira Express"}"></td>`;
      }).join("")}</tr>`)
      .join("");
    dialog(
      "Notification settings",
      "Choose the messages you receive. Security messages are always sent.",
      `<form id="dffPrefsForm"><div class="table-scroll"><table><thead><tr><th>MESSAGE</th>${channels.map(c => `<th>${esc(c.toUpperCase())}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="3" class="empty-state">No messages to configure.</td></tr>`}</tbody></table></div><div class="modal-actions"><button type="button" class="button" data-df-close>Cancel</button><button type="submit" class="button button-primary">Save</button></div></form>`,
      640,
    );
  }

  async function savePrefs(form) {
    const preferences = [...form.querySelectorAll("[data-dff-pref]:not(:disabled)")].map(box => ({ event: box.dataset.dffPref, channel: box.dataset.channel, enabled: box.checked }));
    try {
      await DF.api("/me/notification-preferences", { method: "PUT", body: { preferences } });
      closeDialog();
      toast("Notification settings saved.");
    } catch (error) {
      fail(error);
    }
  }

  // ───────────── wiring ─────────────

  function stop(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onClick(event) {
    const t = event.target;
    if (!(t instanceof Element)) return;
    const hit = sel => t.closest(sel);
    let el;
    if (hit("#dfAddProduct")) return stop(event), openProduct(null);
    if ((el = hit("[data-dff-product-edit]"))) return stop(event), openProduct((F.products || []).find(p => p.id === el.dataset.dffProductEdit));
    if ((el = hit("[data-dff-product-delete]"))) {
      stop(event);
      const p = (F.products || []).find(x => x.id === el.dataset.dffProductDelete);
      if (!p) return;
      return void DF.confirm({ title: `Remove ${p.name}?`, message: `${p.sku} is removed from the catalogue. Shipments already booked keep it.`, confirm: "Remove product", danger: true }).then(
        ok =>
          ok &&
          DF.api(`/merchants/me/products/${p.id}${q()}`, { method: "DELETE" })
            .then(loadProducts)
            .then(() => window.renderPage("Products"))
            .then(() => toast(`${p.name} removed.`), fail),
      );
    }
    if ((el = hit("[data-dff-report]"))) return stop(event), void downloadReport(el.dataset.dffReport);
    if ((el = hit("[data-dff-report-view]"))) return stop(event), void viewReport(el.dataset.dffReportView);
    if (hit("#dffSchedules")) return stop(event), void loadPickups().then(openSchedules, fail);
    if (hit("#dffRequestPickup")) {
      stop(event);
      if (S().merchant?.status !== "ACTIVE") return toast("Pickups are available once your account is approved.");
      return openPickupRequest();
    }
    if ((el = hit("[data-dff-pickup-cancel]"))) {
      stop(event);
      const pickupId = el.dataset.dffPickupCancel;
      return void DF.confirm({ title: "Cancel this pickup?", message: "The rider won't come for it.", confirm: "Cancel pickup", cancel: "Keep it", danger: true }).then(
        ok =>
          ok &&
          DF.api(`/merchants/me/pickup-requests/${pickupId}/cancel${q()}`, { method: "POST" })
            .then(loadPickups)
            .then(() => (refreshPickupPage(), toast("Pickup cancelled.")), fail),
      );
    }
    if ((el = hit("[data-dff-schedule-toggle]"))) {
      stop(event);
      const s = (F.schedules || []).find(x => x.id === el.dataset.dffScheduleToggle);
      return void DF.api(`/merchants/me/pickup-schedules/${s.id}${q()}`, { method: "PATCH", body: { active: !s.active } })
        .then(loadPickups)
        .then(() => (openSchedules(), refreshPickupPage(), toast(s.active ? "Recurring pickup paused." : "Recurring pickup resumed.")), fail);
    }
    if ((el = hit("[data-dff-schedule-delete]"))) {
      stop(event);
      const scheduleId = el.dataset.dffScheduleDelete;
      return void DF.confirm({ title: "Remove this recurring pickup?", message: "Its upcoming pickups are cancelled.", confirm: "Remove", danger: true }).then(
        ok =>
          ok &&
          DF.api(`/merchants/me/pickup-schedules/${scheduleId}${q()}`, { method: "DELETE" })
            .then(loadPickups)
            .then(() => (openSchedules(), refreshPickupPage(), toast("Recurring pickup removed.")), fail),
      );
    }
    if (hit("#dffReturns")) return stop(event), void openReturns();
    if ((el = hit("[data-dff-returns]"))) return stop(event), void openReturns(el.dataset.dffReturns);
    if ((el = hit("[data-dff-return-request]"))) return stop(event), void requestReturn(el.dataset.dffReturnRequest).catch(fail);
    if ((el = hit("[data-dff-return-received]"))) {
      stop(event);
      const returned = el.dataset.dffReturnReceived;
      return void DF.confirm({ title: `Received ${returned} back?`, message: "Confirm the returned parcel reached you.", confirm: "Yes, received" }).then(ok => ok && confirmReceived(returned));
    }
    if (hit("[data-dff-open-kyc], [data-df-open-kyc]")) return stop(event), void openKyc();
    if (hit("[data-dff-kyc-submit]")) return stop(event), void submitKyc();
    if ((el = hit("[data-dff-kyc-pick]"))) return stop(event), void pickKyc(el.dataset.dffKycPick);
    if ((el = hit("[data-dff-kyc-view]"))) return stop(event), void viewKycDocument(el.dataset.dffKycView);
  }

  function onSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const handlers = { dffKycForm: uploadKyc, dffProductForm: saveProduct, dffScheduleForm: saveSchedule, dffPickupForm: savePickupRequest, dffReturnForm: saveReturn, dffReviewForm: sendReviewAnswer, dffPrefsForm: savePrefs };
    const handler = handlers[form.id];
    if (!handler) return;
    stop(event);
    void handler(form);
  }

  function onChange(event) {
    const t = event.target;
    if (t.id === "dffCatalogPick") return applyProduct(t.value);
    if (t.id === "dffReportPeriod") {
      reportDays = Number(t.value) || 30;
      return window.renderPage("Reports");
    }
  }

  function install() {
    const render = window.renderPage;
    window.renderPage = function (page) {
      if (page === "Products") beforeProducts();
      if (page === "Reports") beforeReports();
      render(page);
      if (page === "Products") {
        afterProducts();
        if (!F.products) void loadProducts().then(() => S().page === "Products" && window.renderPage("Products"), fail);
      }
      if (page === "Reports") afterReports();
      if (page === "Pickup requests") {
        afterPickups();
        if (!F.upcoming) void loadPickups().then(refreshPickupPage);
      }
      if (page === "Shipments") {
        const actions = $("mainContent").querySelector(".page-heading .heading-actions");
        if (actions && !$("dffReturns")) actions.insertAdjacentHTML("afterbegin", `<button class="button" id="dffReturns">${icon("box")} Returns (RTO)</button>`);
      }
      if (page === "Overview") void reviewBanner();
    };
    const openModal = window.openOrderModal;
    window.openOrderModal = function () {
      openModal();
      void addPickupWindow();
      if (F.products) addProductPicker();
      else void loadProducts().then(addProductPicker, () => undefined);
    };
    window.addEventListener("click", onClick, true);
    window.addEventListener("submit", onSubmit, true);
    window.addEventListener("change", onChange, true);
    // The bridge's parcel dialog: add return actions and proof of delivery.
    new MutationObserver(records => {
      for (const r of records) for (const node of r.addedNodes) if (node instanceof HTMLElement && node.id === "merchantHistoryBackdrop") void enhanceParcelDialog(node);
    }).observe(document.body, { childList: true });
    DF.live(["pickup_request.updated"], async () => {
      if (S().page !== "Pickup requests") return void (F.upcoming = null);
      await loadPickups();
      refreshPickupPage();
    });
  }

  window.DFMerchantFeatures = { pickupWindow, openKyc, openNotifications, openReturns, loadProducts, state: F };

  // After the bridge has started (it wraps renderPage first).
  Promise.resolve(DF.bridgeReady)
    .catch(() => undefined)
    .then(() => {
      install();
      if (S().page === "Overview") void reviewBanner();
    });

  // The address holds the full address: its district / zone / area are picked from it (shared/api.js DF.autoPlace).
  window.DF?.autoPlace?.({ street: "dffScheduleStreet", district: "dffScheduleDistrict", zone: "dffScheduleZone" });
})();
