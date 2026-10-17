/*
 * Super admin → "Service plans & pricing" (service packages, docs/architecture-contracts.md):
 * packages per segment with a checkbox per service and their own price fields, versions with an
 * effective date (maker-checker: a second super admin approves), the Default package, assignment
 * to merchants, a price simulator (district route tiers), products (fixed types, with a checkbox per
 * message that may be sent) and the Hub Pickup hold period (spec v2). Replaces the old plan editor of 03.js on this page.
 */
(() => {
  const DF = window.DF;
  if (!DF) return;
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const toast = message => (typeof showToast === "function" ? showToast(message) : DF.toast?.(message));
  const fail = error => toast(DF.describe(error));
  const PAGE = "Service plans";
  const SEGMENTS = [
    ["CUSTOMER", "Customer"],
    ["ECOMMERCE", "E-commerce"],
    ["BANKING_FINANCIAL", "Banking & Financial"],
  ];
  const PENDING = "Sent for approval: another super admin has to approve it (Admin users & roles → Approvals). Nothing changes until then.";
  const S = {
    segment: "CUSTOMER",
    catalog: null,
    geo: null,
    packages: [],
    assignments: { ECOMMERCE: [], BANKING_FINANCIAL: [] },
    hubs: [],
    groups: [],
    products: [],
    settings: null,
    editing: null, // package id, "new", or null
    draft: null, // { services: Set, prices: {}, name, description, effectiveFrom, note, makeDefault }
    sim: { pickupDistrict: "", pickupZone: "", deliveryDistrict: "", deliveryZone: "", weightKg: 1, codAmount: 0, declaredValue: "", speed: "REGULAR", firstMile: "", lastMile: "", openBox: false },
    simResult: null,
    loaded: false,
  };
  let active = false;
  let loading = null;

  const baseShowPage = window.showPage;
  window.showPage = showPage = function (page) {
    baseShowPage(page);
    active = page === PAGE;
    if (!active) return;
    if (S.loaded) render();
    else {
      document.getElementById("mainContent").innerHTML = `<div class="page-heading"><div><p class="eyebrow">Merchant management · Service packages</p><h1>Service plans &amp; pricing</h1><p class="subtitle">Loading packages…</p></div></div>`;
      loading ??= load().finally(() => (loading = null));
      void loading.then(() => active && render());
    }
  };

  /** Opens a merchant's row in the assignments table (from the merchant account dialog): choose the package there. */
  async function openAssignment(segment, merchantCode) {
    S.segment = segment;
    S.editing = null;
    S.draft = null;
    S.simResult = null;
    showPage(PAGE);
    if (loading) await loading;
    else await load("packages", "assignments");
    if (!active) return;
    render();
    const row = document.querySelector(`#pkgAssignments tr[data-pkg-merchant="${CSS.escape(merchantCode)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    row.style.background = "#f3f6ff";
    row.querySelector("select")?.focus();
  }
  /** Opens the product list of a segment (Shared catalogs & locations links here: products are parcel products, not catalog chips). */
  async function openProducts(segment = "ECOMMERCE") {
    S.segment = segment;
    S.editing = null;
    S.draft = null;
    S.simResult = null;
    showPage(PAGE);
    if (loading) await loading;
    if (!active) return;
    render();
    document.getElementById("pkgProductsPanel")?.scrollIntoView({ block: "start" });
  }
  document.addEventListener("click", event => {
    const button = event.target.closest?.("[data-open-products]");
    if (!button) return;
    event.preventDefault();
    void openProducts(button.dataset.openProducts || "ECOMMERCE");
  });
  window.DFPackages = { openAssignment, openProducts };

  async function load(...only) {
    const want = name => !only.length || only.includes(name);
    try {
      const jobs = [];
      if (want("catalog") && !S.catalog) jobs.push(DF.api("/service-catalog").then(c => (S.catalog = c)));
      if (want("geo") && !S.geo) jobs.push(DF.api("/catalog").then(c => (S.geo = c)));
      if (want("packages")) jobs.push(DF.api("/packages").then(p => (S.packages = p)));
      if (want("assignments"))
        jobs.push(
          DF.api("/packages/assignments?segment=ECOMMERCE").then(a => (S.assignments.ECOMMERCE = a)),
          DF.api("/packages/assignments?segment=BANKING_FINANCIAL").then(a => (S.assignments.BANKING_FINANCIAL = a)),
        );
      if (want("hubs")) jobs.push(DF.api("/hubs?includeInactive=true").then(h => (S.hubs = h)));
      if (want("products")) jobs.push(DF.api("/parcel-products?includeInactive=true").then(p => (S.products = p)));
      if (want("settings")) jobs.push(DF.api("/packages/settings").then(s => (S.settings = s)));
      await Promise.all(jobs);
      S.loaded = true;
    } catch (error) {
      fail(error);
    }
  }
  // Packages and assignments change through approvals: refresh when one is decided.
  DF.events?.on("change.updated", () => active && load("packages", "assignments").then(() => active && !S.editing && render()));

  // ───────────── helpers ─────────────
  const segLabel = code => SEGMENTS.find(([c]) => c === code)?.[1] ?? code;
  const servicesFor = segment => (S.catalog?.services || []).filter(s => s.segments.includes(segment));
  const fieldsFor = segment => (S.catalog?.priceFields || []).filter(f => f.segments.includes(segment));
  const pkgsOf = segment => S.packages.filter(p => p.segment === segment);
  const fmtDate = d => (d ? new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
  const money = n => `৳${Number(n ?? 0).toLocaleString("en-BD")}`;
  const unitOf = f => (f.unit === "৳" ? "৳" : f.unit === "%" ? "%" : f.unit === "kg" ? "kg" : "");
  const localInput = d => {
    const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return t.toISOString().slice(0, 16);
  };

  function startEdit(pkg) {
    const base = pkg?.current || pkg?.versions?.[0];
    const defaults = S.packages.find(p => p.segment === S.segment && p.isDefault)?.current;
    S.editing = pkg ? pkg.id : "new";
    S.draft = {
      name: pkg?.name ?? "",
      description: pkg?.description ?? "",
      services: new Set(base?.services ?? defaults?.services ?? servicesFor(S.segment).map(s => s.code)),
      prices: { ...(S.catalog?.defaults || {}), ...(defaults?.prices || {}), ...(base?.prices || {}) },
      effectiveFrom: "",
      note: "",
      makeDefault: false,
    };
    S.simResult = null;
    render();
    document.getElementById("pkgEditor")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /** The editor's values into S.draft (kept across re-renders). */
  function readEditor() {
    const form = document.getElementById("pkgEditor");
    if (!form || !S.draft) return;
    S.draft.name = form.elements.pkgName?.value.trim() ?? S.draft.name;
    S.draft.description = form.elements.pkgDescription?.value.trim() ?? "";
    S.draft.effectiveFrom = form.elements.pkgEffectiveFrom?.value ?? "";
    S.draft.note = form.elements.pkgNote?.value.trim() ?? "";
    S.draft.makeDefault = !!form.elements.pkgMakeDefault?.checked;
    S.draft.services = new Set([...form.querySelectorAll("[data-pkg-service]")].filter(i => i.checked).map(i => i.dataset.pkgService));
    for (const input of form.querySelectorAll("[data-pkg-price]")) S.draft.prices[input.dataset.pkgPrice] = input.value === "" ? 0 : Number(input.value);
  }

  // ───────────── rendering ─────────────
  function render() {
    const main = document.getElementById("mainContent");
    if (!main || !S.catalog) return;
    const seg = S.segment;
    const tabs = SEGMENTS.map(
      ([code, label]) => `<button type="button" class="button button-sm${seg === code ? " button-primary" : ""}" data-pkg-segment="${code}" aria-pressed="${seg === code}">${esc(label)}</button>`,
    ).join("");
    main.innerHTML = `
      <div class="page-heading"><div><p class="eyebrow">Merchant management · Service packages</p><h1>Service plans &amp; pricing</h1>
      <p class="subtitle">Each package switches services on or off and has its own prices. Every segment has a Default package for everyone without an assigned one. Price and package changes take effect from their date and need a second super admin's approval; parcels keep the price they were booked with.</p></div></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 2px" role="tablist" id="pkgSegments">${tabs}</div>
      <div class="config-layout" id="servicePackagesPage">
        ${panel("Packages", `${segLabel(seg)} packages. The default package applies to every ${seg === "CUSTOMER" ? "website customer and walk-in sender" : "merchant without its own package"}.`, packagesTable(seg), `<button type="button" class="button button-sm button-primary" data-pkg-new>New package</button>`)}
        ${S.editing ? panel(S.editing === "new" ? `New ${segLabel(seg)} package` : `Edit ${esc(S.packages.find(p => p.id === S.editing)?.name || "")}`, "Saving creates a new version from its effective date.", editor(seg), "", "pkgEditorPanel", true) : ""}
        ${panel("Price simulator", S.editing ? "Prices this draft would charge (before you save it)." : "Prices of the default package, or of the package you are editing.", simulator(seg), "", "pkgSimulatorPanel")}
        ${seg !== "CUSTOMER" ? panel(`${segLabel(seg)} merchants`, "Assign a package from a date (empty = now). Merchants without one use the default package.", assignmentsTable(seg), "", "pkgAssignmentsPanel") : ""}
        ${panel(seg === "BANKING_FINANCIAL" ? "Banking & Financial products" : "Customer & E-commerce products", "Optional in bookings; the product's type (Regular, Document, Books) prices the parcel. Switch off 'Send SMS & email' to send no messages for its parcels.", productsPanel(seg === "BANKING_FINANCIAL" ? "BANKING_FINANCIAL" : "ECOMMERCE"), "", "pkgProductsPanel", true)}
        ${panel("Hub Pickup", "How long a parcel waits at the collection hub, and when the reminder SMS goes out.", settingsPanel(), "", "pkgSettingsPanel")}
      </div>`;
  }

  function panel(title, subtitle, body, actions = "", id = "", wide = false) {
    return `<section class="panel"${id ? ` id="${id}"` : ""}${wide ? ' style="grid-column:1/-1"' : ""}><div class="panel-heading"><div><h2 class="panel-title">${esc(title)}</h2><p class="panel-subtitle">${esc(subtitle)}</p></div>${actions ? `<div>${actions}</div>` : ""}</div>${body}</section>`;
  }

  function packagesTable(seg) {
    const rows = pkgsOf(seg);
    if (!rows.length) return `<p class="panel-subtitle">No packages yet.</p>`;
    return `<div class="table-scroll"><table id="pkgTable"><thead><tr><th>PACKAGE</th><th>IN FORCE</th><th>MERCHANTS</th><th>NEXT CHANGE</th><th></th></tr></thead><tbody>${rows
      .map(p => {
        const status = p.status === "ARCHIVED" ? `<span class="status status-warn">Archived</span>` : p.isDefault ? `<span class="status status-good">Default</span>` : `<span class="status status-blue">Active</span>`;
        const next = p.scheduled?.[0] ? `v${p.scheduled[0].version} from ${fmtDate(p.scheduled[0].effectiveFrom)}` : "—";
        const actions = [
          p.status === "ACTIVE" ? `<button type="button" class="button button-sm" data-pkg-edit="${p.id}">Edit</button>` : "",
          p.status === "ACTIVE" && !p.isDefault ? `<button type="button" class="button button-sm" data-pkg-default="${p.id}">Make default</button>` : "",
          p.status === "ACTIVE" && !p.isDefault ? `<button type="button" class="button button-sm" data-pkg-archive="${p.id}">Archive</button>` : "",
          !p.isDefault && !p.merchants ? `<button type="button" class="button button-sm button-danger" data-pkg-delete="${p.id}">Delete</button>` : "",
        ].join(" ");
        return `<tr data-pkg-row="${esc(p.name)}"><td class="primary-cell">${esc(p.name)} ${status}<span class="subcell">${esc(p.description || "")}</span></td><td>${p.current ? `v${p.current.version} · since ${fmtDate(p.current.effectiveFrom)}<span class="subcell">${p.current.services.length} services</span>` : "Not yet in force"}</td><td>${p.merchants ?? 0}</td><td>${esc(next)}</td><td><div class="row-actions" style="display:flex;gap:5px;flex-wrap:wrap">${actions}</div></td></tr>`;
      })
      .join("")}</tbody></table></div>`;
  }

  function editor(seg) {
    const d = S.draft;
    const groups = (S.catalog.groups || [])
      .map(g => {
        const items = servicesFor(seg).filter(s => s.group === g.code);
        if (!items.length) return "";
        return `<section class="service-group"><h4>${esc(g.label)}</h4><div class="service-plan-checks">${items
          .map(
            s =>
              `<label class="config-check" title="${esc(s.hint || "")}"><input type="checkbox" data-pkg-service="${esc(s.code)}" ${d.services.has(s.code) || s.core ? "checked" : ""} ${s.core ? "disabled" : ""}> ${esc(s.label)}${s.core ? " (always on)" : ""}</label>`,
          )
          .join("")}</div></section>`;
      })
      .join("");
    // Price fields in the owner's groups (Route, What are you sending, Weight, Service, Last mile, First mile, …).
    const fields = fieldsFor(seg);
    const prices = [...new Set(fields.map(f => f.group))]
      .map(
        group =>
          `<section class="service-group"><h4>${esc(group)}</h4><div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">${fields
            .filter(f => f.group === group)
            .map(
              f =>
                `<div class="field"><label for="pkgPrice-${f.key}">${esc(`${f.sign === "-" ? "− " : f.sign === "+" ? "+ " : ""}${f.label}`)}${unitOf(f) ? ` (${unitOf(f)})` : ""}</label><input id="pkgPrice-${f.key}" type="number" ${f.signed ? "" : 'min="0"'} step="${f.unit === "count" ? 1 : 0.01}" data-pkg-price="${f.key}" value="${esc(d.prices[f.key] ?? 0)}" required></div>`,
            )
            .join("")}</div></section>`,
      )
      .join("");
    return `<form id="pkgEditor" class="config-form" novalidate>
      <div class="form-grid">
        <div class="field"><label for="pkgName">Package name *</label><input id="pkgName" name="pkgName" value="${esc(d.name)}" maxlength="80" required></div>
        <div class="field"><label for="pkgEffectiveFrom">Effective from</label><input id="pkgEffectiveFrom" name="pkgEffectiveFrom" type="datetime-local" value="${esc(d.effectiveFrom)}" min="${localInput(new Date())}"><small class="subcell">Empty: as soon as it is approved.</small></div>
        <div class="field full"><label for="pkgDescription">Description</label><input id="pkgDescription" name="pkgDescription" value="${esc(d.description)}" maxlength="300"></div>
        <div class="field full"><label for="pkgNote">Change note</label><input id="pkgNote" name="pkgNote" value="${esc(d.note)}" maxlength="300" placeholder="Why the change (shown to the approver)"></div>
        ${S.editing === "new" ? `<label class="config-check field full"><input type="checkbox" name="pkgMakeDefault" ${d.makeDefault ? "checked" : ""}> Make it the default ${esc(segLabel(seg))} package</label>` : ""}
      </div>
      <h3 class="panel-title" style="margin:12px 0 4px">Services</h3>
      <div style="display:grid;gap:9px">${groups}</div>
      <h3 class="panel-title" style="margin:14px 0 4px">Price fields</h3>
      <p class="panel-subtitle" style="margin:0 0 8px">Prices depend on the districts only. VAT-inclusive, every line rounded to whole taka. “−” adjustments are subtracted; the delivery charge never goes below ৳0.</p>
      <div style="display:grid;gap:9px">${prices}</div>
      <div class="modal-actions"><button type="button" class="button" data-pkg-cancel>Cancel</button><button type="submit" class="button button-primary" id="pkgSave">${S.editing === "new" ? "Create package" : "Save new version"}</button></div>
    </form>`;
  }

  function options(list, selected, empty) {
    return `${empty !== undefined ? `<option value="">${esc(empty)}</option>` : ""}${list.map(([v, l]) => `<option value="${esc(v)}" ${String(selected) === String(v) ? "selected" : ""}>${esc(l)}</option>`).join("")}`;
  }

  function simulator(seg) {
    const sim = S.sim;
    const districts = S.geo?.districts || [];
    const zones = d => (S.geo?.zonesByDistrict?.[d] || []).map(z => [z, z]);
    const labels = S.catalog.labels;
    const services = S.editing ? S.draft.services : new Set(pkgsOf(seg).find(p => p.isDefault)?.current?.services || []);
    const speeds = Object.entries(labels.speed).filter(([code]) => {
      const svc = { REGULAR: "speed.regular", EXPRESS: "speed.express", ON_DEMAND: "speed.on_demand", B2B: "handling.b2b", TRADE: "handling.trade", URGENT: "handling.urgent" }[code];
      return servicesFor(seg).some(s => s.code === svc);
    });
    const result = S.simResult
      ? S.simResult.error
        ? `<p class="status status-bad" style="display:block;margin-top:10px">${esc(S.simResult.error)}</p>`
        : `<div class="table-scroll" style="margin-top:10px"><table id="pkgSimResult"><thead><tr><th>LINE</th><th style="text-align:right">AMOUNT</th></tr></thead><tbody>${S.simResult.lines
            .map(l => `<tr><td>${esc(l.label)}</td><td style="text-align:right">${l.amount < 0 ? "−" : ""}${money(Math.abs(l.amount))}</td></tr>`)
            .join("")}<tr><td class="primary-cell">Total (${esc(S.simResult.tierLabel)})</td><td class="primary-cell" style="text-align:right" data-pkg-sim-total>${money(S.simResult.totalCharge)}</td></tr></tbody></table></div>`
      : "";
    return `<form id="pkgSimulator" class="config-form" novalidate>
      <div class="form-grid">
        <div class="field"><label for="simPickupDistrict">From district</label><select id="simPickupDistrict" data-sim="pickupDistrict">${options(districts.map(d => [d, d]), sim.pickupDistrict, "Choose")}</select></div>
        <div class="field"><label for="simPickupZone">From zone (optional)</label><select id="simPickupZone" data-sim="pickupZone">${options(zones(sim.pickupDistrict), sim.pickupZone, "Any zone")}</select></div>
        <div class="field"><label for="simDeliveryDistrict">To district</label><select id="simDeliveryDistrict" data-sim="deliveryDistrict">${options(districts.map(d => [d, d]), sim.deliveryDistrict, "Choose")}</select></div>
        <div class="field"><label for="simDeliveryZone">To zone (Hub Pickup finds its hub)</label><select id="simDeliveryZone" data-sim="deliveryZone">${options(zones(sim.deliveryDistrict), sim.deliveryZone, "Any zone")}</select></div>
        <div class="field"><label for="simSpeed">Service</label><select id="simSpeed" data-sim="speed">${options(speeds, sim.speed)}</select></div>
        ${seg === "BANKING_FINANCIAL" ? "" : `<div class="field"><label for="simWeight">Weight (kg)</label><input id="simWeight" type="number" min="0.01" step="0.01" data-sim="weightKg" value="${esc(sim.weightKg)}"></div><div class="field"><label for="simProduct">What is sent</label><select id="simProduct" data-sim="product">${options([["", "Regular (no product)"], ...S.products.filter(x => x.segment === "ECOMMERCE" && x.active && x.type !== "REGULAR").map(x => [x.name, `${x.name} · ${x.type === "BOOKS" ? "Books" : "Document"}`])], sim.product || "")}</select></div>`}
        <div class="field"><label for="simFirstMile">First mile</label><select id="simFirstMile" data-sim="firstMile">${options(Object.entries(labels.firstMile), sim.firstMile, "Package default")}</select></div>
        <div class="field"><label for="simLastMile">Last mile</label><select id="simLastMile" data-sim="lastMile">${options(Object.entries(labels.lastMile), sim.lastMile, "Package default")}</select></div>
        ${seg === "BANKING_FINANCIAL" ? "" : `<div class="field"><label for="simCod">COD amount (৳)</label><input id="simCod" type="number" min="0" data-sim="codAmount" value="${esc(sim.codAmount)}"></div>`}
        ${seg === "ECOMMERCE" ? `<label class="config-check field"><input type="checkbox" data-sim="openBox" ${sim.openBox ? "checked" : ""}> Open box</label>` : ""}
      </div>
      <div class="modal-actions"><button type="submit" class="button button-primary" data-pkg-simulate ${services.size ? "" : "disabled"}>Simulate price</button></div>
      ${result}
    </form>`;
  }

  function assignmentsTable(seg) {
    const rows = S.assignments[seg] || [];
    if (!rows.length) return `<p class="panel-subtitle">No ${esc(segLabel(seg).toLowerCase())} merchants yet.</p>`;
    const choices = pkgsOf(seg).filter(p => p.status === "ACTIVE");
    return `<div class="table-scroll"><table id="pkgAssignments"><thead><tr><th>MERCHANT</th><th>PACKAGE NOW</th><th>CHANGE TO</th><th>FROM</th><th></th></tr></thead><tbody>${rows
      .map(
        r => `<tr data-pkg-merchant="${esc(r.merchant.code)}"><td class="primary-cell">${esc(r.merchant.name)}<span class="subcell">${esc(r.merchant.code)} · ${esc(r.merchant.status)}</span></td>
        <td>${esc(r.package?.name || "—")}${r.package?.isDefault ? ` <span class="status status-good">Default</span>` : ""}${r.scheduled.length ? `<span class="subcell">Then ${esc(r.scheduled[0].package?.name || "default")} from ${fmtDate(r.scheduled[0].effectiveFrom)}</span>` : ""}</td>
        <td><select data-pkg-assign-select="${r.merchant.id}" aria-label="Package for ${esc(r.merchant.name)}">${options([["", "Default package"], ...choices.filter(p => !p.isDefault).map(p => [p.id, p.name])], r.package && !r.package.isDefault ? r.package.id : "")}</select></td>
        <td><input type="date" data-pkg-assign-date="${r.merchant.id}" aria-label="From date for ${esc(r.merchant.name)}" min="${new Date().toISOString().slice(0, 10)}"></td>
        <td><button type="button" class="button button-sm" data-pkg-assign="${r.merchant.id}">Assign</button></td></tr>`,
      )
      .join("")}</tbody></table></div>`;
  }

  function productsPanel(segment) {
    const rows = S.products.filter(p => p.segment === segment);
    const types = S.catalog.productTypes || [];
    const typeLabel = code => types.find(t => t.code === code)?.label || code;
    const list = rows.length
      ? `<div class="table-scroll"><table id="pkgProducts"><thead><tr><th>PRODUCT</th><th>TYPE</th><th>MESSAGES</th><th>PARCELS</th><th></th></tr></thead><tbody>${rows
          .map(
            p => `<tr data-pkg-product="${esc(p.name)}"><td class="primary-cell">${esc(p.name)} ${p.active ? "" : `<span class="status status-warn">Inactive</span>`}</td><td>${esc(typeLabel(p.type))}</td><td data-pkg-product-messages-cell><span class="status ${p.sendMessages ? "status-good" : "status-warn"}">Messages: ${p.sendMessages ? "On" : "Off"}</span>
            <label class="config-check" style="margin-top:5px"><input type="checkbox" data-pkg-product-messages="${p.id}" ${p.sendMessages ? "checked" : ""}> Send SMS &amp; email</label></td>
            <td>${p.parcels}</td><td><div style="display:flex;gap:5px;flex-wrap:wrap"><button type="button" class="button button-sm" data-pkg-product-toggle="${p.id}">${p.active ? "Deactivate" : "Activate"}</button>${p.parcels ? "" : `<button type="button" class="button button-sm button-danger" data-pkg-product-delete="${p.id}">Delete</button>`}</div></td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : `<p class="panel-subtitle">No products yet.</p>`;
    return `${list}<form id="pkgProductForm" class="config-form" style="margin-top:10px" data-segment="${segment}"><div class="form-grid"><div class="field"><label for="pkgProductName">New product</label><input id="pkgProductName" name="productName" maxlength="120" placeholder="${segment === "BANKING_FINANCIAL" ? "e.g. Credit Cards" : "e.g. Fashion & Apparel"}" required></div><div class="field"><label for="pkgProductType">Type</label><select id="pkgProductType" name="productType">${types.map(t => `<option value="${t.code}">${esc(t.label)}</option>`).join("")}</select></div></div>
      <label class="config-check"><input type="checkbox" name="sendMessages" id="pkgProductSendMessages" checked> Send SMS &amp; email for this product</label><p class="panel-subtitle" style="margin:4px 0 0">Off: parcels of this product get no messages. Which messages go is chosen on each booking.</p><div class="modal-actions"><button type="submit" class="button button-primary">Add product</button></div></form>`;
  }

  function settingsPanel() {
    const s = S.settings || { collectHoldDays: 7, collectReminderHours: 24 };
    return `<form id="pkgSettingsForm" class="config-form"><div class="form-grid"><div class="field"><label for="pkgHoldDays">Hold period (days)</label><input id="pkgHoldDays" name="collectHoldDays" type="number" min="1" max="60" value="${esc(s.collectHoldDays)}"></div><div class="field"><label for="pkgReminderHours">Reminder before it ends (hours, 0 = none)</label><input id="pkgReminderHours" name="collectReminderHours" type="number" min="0" max="720" value="${esc(s.collectReminderHours)}"></div></div><div class="modal-actions"><button type="submit" class="button button-primary">Save collect-from-hub settings</button></div></form>`;
  }

  // ───────────── actions ─────────────
  const stop = event => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  async function busy(button, work) {
    if (button) button.disabled = true;
    try {
      return await work();
    } catch (error) {
      fail(error);
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  }
  const outcome = (result, applied) => toast(result && result.status === "PENDING" ? PENDING : applied);

  window.addEventListener(
    "click",
    async event => {
      const t = event.target;
      if (!active || !(t instanceof Element) || !t.closest("#mainContent")) return;
      const btn = sel => t.closest(sel);
      let b;
      if ((b = btn("[data-pkg-segment]"))) {
        stop(event);
        S.segment = b.dataset.pkgSegment;
        S.editing = null;
        S.draft = null;
        S.simResult = null;
        return render();
      }
      if (btn("[data-pkg-new]")) return stop(event), startEdit(null);
      if ((b = btn("[data-pkg-edit]"))) return stop(event), startEdit(S.packages.find(p => p.id === b.dataset.pkgEdit));
      if (btn("[data-pkg-cancel]")) {
        stop(event);
        S.editing = null;
        S.draft = null;
        return render();
      }
      if ((b = btn("[data-pkg-default]"))) {
        stop(event);
        const p = S.packages.find(x => x.id === b.dataset.pkgDefault);
        if (!confirm(`Make ${p.name} the default ${segLabel(p.segment)} package? Everyone without their own package will use it.`)) return;
        return busy(b, async () => {
          outcome(await DF.api(`/packages/${p.id}/default`, { method: "POST" }), `${p.name} is now the default package.`);
          await load("packages", "assignments");
          render();
        });
      }
      if ((b = btn("[data-pkg-archive]"))) {
        stop(event);
        const p = S.packages.find(x => x.id === b.dataset.pkgArchive);
        if (!confirm(`Archive ${p.name}? It can't be assigned any more; merchants already on it keep it until you assign another.`)) return;
        return busy(b, async () => {
          outcome(await DF.api(`/packages/${p.id}/archive`, { method: "POST" }), `${p.name} archived.`);
          await load("packages");
          render();
        });
      }
      if ((b = btn("[data-pkg-delete]"))) {
        stop(event);
        const p = S.packages.find(x => x.id === b.dataset.pkgDelete);
        if (!confirm(`Delete ${p.name}? Only packages nothing used can be deleted.`)) return;
        return busy(b, async () => {
          await DF.api(`/packages/${p.id}`, { method: "DELETE" });
          toast(`${p.name} deleted.`);
          await load("packages");
          render();
        });
      }
      if ((b = btn("[data-pkg-assign]"))) {
        stop(event);
        const id = b.dataset.pkgAssign;
        const packageId = document.querySelector(`[data-pkg-assign-select="${id}"]`)?.value || null;
        const date = document.querySelector(`[data-pkg-assign-date="${id}"]`)?.value;
        const row = S.assignments[S.segment].find(r => r.merchant.id === id);
        return busy(b, async () => {
          const result = await DF.api(`/merchants/${id}/package`, { method: "PUT", body: { packageId, ...(date ? { effectiveFrom: new Date(`${date}T00:00:00+06:00`).toISOString() } : {}) } });
          outcome(result, `${row?.merchant.name || "Merchant"} assigned to ${packageId ? S.packages.find(p => p.id === packageId)?.name : "the default package"}${date ? ` from ${date}` : ""}.`);
          await load("assignments", "packages");
          render();
        });
      }
      if ((b = btn("[data-pkg-product-toggle]"))) {
        stop(event);
        const p = S.products.find(x => x.id === b.dataset.pkgProductToggle);
        return busy(b, async () => {
          await DF.api(`/parcel-products/${p.id}`, { method: "PATCH", body: { active: !p.active } });
          await load("products");
          render();
        });
      }
      if ((b = btn("[data-pkg-product-delete]"))) {
        stop(event);
        const p = S.products.find(x => x.id === b.dataset.pkgProductDelete);
        if (!confirm(`Delete ${p.name}?`)) return;
        return busy(b, async () => {
          await DF.api(`/parcel-products/${p.id}`, { method: "DELETE" });
          await load("products");
          render();
        });
      }
      if ((b = btn("[data-pkg-group-save]"))) {
        stop(event);
        const id = b.dataset.pkgGroupSave;
        const hubIds = [...document.querySelectorAll(`[data-pkg-group-hub="${id}"]`)].filter(i => i.checked).map(i => i.value);
        return busy(b, async () => {
          await DF.api(`/hub-groups/${id}/hubs`, { method: "PUT", body: { hubIds } });
          toast("Hub group saved. Prices between its hubs use the same-city price.");
          await load("groups");
          render();
        });
      }
      if ((b = btn("[data-pkg-group-active]"))) {
        stop(event);
        const g = S.groups.find(x => x.id === b.dataset.pkgGroupActive);
        return busy(b, async () => {
          await DF.api(`/hub-groups/${g.id}`, { method: "PATCH", body: { active: !g.active } });
          await load("groups");
          render();
        });
      }
      if ((b = btn("[data-pkg-group-delete]"))) {
        stop(event);
        const g = S.groups.find(x => x.id === b.dataset.pkgGroupDelete);
        if (!confirm(`Delete the hub group ${g.name}?`)) return;
        return busy(b, async () => {
          await DF.api(`/hub-groups/${g.id}`, { method: "DELETE" });
          await load("groups");
          render();
        });
      }
    },
    true,
  );

  window.addEventListener(
    "change",
    event => {
      const t = event.target;
      if (!active || !(t instanceof Element)) return;
      if (t.closest("#pkgEditor")) return readEditor();
      if (t.matches?.("[data-pkg-product-messages]")) {
        const p = S.products.find(x => x.id === t.dataset.pkgProductMessages);
        if (!p) return;
        const sendMessages = t.checked;
        t.disabled = true;
        void DF.api(`/parcel-products/${p.id}`, { method: "PATCH", body: { sendMessages } })
          .then(async () => {
            toast(sendMessages ? `${p.name}: SMS & email will be sent.` : `${p.name}: no SMS or email for its parcels.`);
            await load("products");
            render();
          })
          .catch(error => {
            t.checked = !sendMessages;
            t.disabled = false;
            fail(error);
          });
        return;
      }
      const key = t.dataset?.sim;
      if (!key) return;
      S.sim[key] = t.type === "checkbox" ? t.checked : t.value;
      if (key === "pickupDistrict") S.sim.pickupZone = "";
      if (key === "deliveryDistrict") S.sim.deliveryZone = "";
      if (key === "pickupDistrict" || key === "deliveryDistrict") {
        if (S.editing) readEditor();
        render();
      }
    },
    true,
  );

  window.addEventListener(
    "submit",
    async event => {
      const form = event.target;
      if (!active || !(form instanceof HTMLFormElement)) return;
      if (form.id === "pkgEditor") {
        stop(event);
        readEditor();
        const d = S.draft;
        if (d.name.length < 2) return toast("Enter the package name (at least 2 characters).");
        const body = {
          services: [...d.services],
          prices: d.prices,
          ...(d.effectiveFrom ? { effectiveFrom: new Date(d.effectiveFrom).toISOString() } : {}),
          ...(d.note ? { note: d.note } : {}),
        };
        const pkg = S.packages.find(p => p.id === S.editing);
        return busy(document.getElementById("pkgSave"), async () => {
          const result =
            S.editing === "new"
              ? await DF.api("/packages", { method: "POST", body: { ...body, segment: S.segment, name: d.name, description: d.description || undefined, makeDefault: d.makeDefault } })
              : await DF.api(`/packages/${pkg.id}/versions`, { method: "POST", body: { ...body, ...(d.name !== pkg.name ? { name: d.name } : {}), description: d.description } });
          outcome(result, S.editing === "new" ? `${d.name} created.` : `New version of ${d.name} saved${d.effectiveFrom ? ` from ${fmtDate(d.effectiveFrom)}` : ""}.`);
          S.editing = null;
          S.draft = null;
          await load("packages", "assignments");
          render();
        });
      }
      if (form.id === "pkgSimulator") {
        stop(event);
        if (S.editing) readEditor();
        const sim = S.sim;
        if (!sim.pickupDistrict || !sim.deliveryDistrict) return toast("Choose the districts the parcel goes from and to.");
        const pkg = S.editing ? null : pkgsOf(S.segment).find(p => p.isDefault);
        const body = {
          segment: S.segment,
          pickupDistrict: sim.pickupDistrict,
          ...(sim.pickupZone ? { pickupZone: sim.pickupZone } : {}),
          deliveryDistrict: sim.deliveryDistrict,
          ...(sim.deliveryZone ? { deliveryZone: sim.deliveryZone } : {}),
          weightKg: Number(sim.weightKg) || 1,
          codAmount: Number(sim.codAmount) || 0,
          ...(sim.product ? { product: sim.product } : {}),
          speed: sim.speed,
          ...(sim.firstMile ? { firstMile: sim.firstMile } : {}),
          ...(sim.lastMile ? { lastMile: sim.lastMile } : {}),
          ...(sim.openBox ? { openBox: true } : {}),
          ...(S.editing ? { services: [...S.draft.services], prices: S.draft.prices } : pkg ? { packageId: pkg.id } : {}),
        };
        try {
          S.simResult = await DF.api("/packages/simulate", { method: "POST", body });
        } catch (error) {
          S.simResult = { error: DF.describe(error) };
        }
        return render();
      }
      if (form.id === "pkgProductForm") {
        stop(event);
        const name = form.elements.productName.value.trim();
        if (!name) return toast("Enter the product name.");
        const sendMessages = form.elements.sendMessages.checked;
        return busy(form.querySelector("button[type=submit]"), async () => {
          await DF.api("/parcel-products", { method: "POST", body: { segment: form.dataset.segment, name, type: form.elements.productType.value, sendMessages } });
          toast(`${name} added.`);
          await load("products");
          render();
        });
      }
      if (form.id === "pkgGroupForm") {
        stop(event);
        const name = form.elements.groupName.value.trim();
        const code = form.elements.groupCode.value.trim();
        if (!name || !code) return toast("Enter the group's name and code.");
        return busy(form.querySelector("button[type=submit]"), async () => {
          await DF.api("/hub-groups", { method: "POST", body: { name, code } });
          toast(`${name} added. Choose its hubs below.`);
          await load("groups");
          render();
        });
      }
      if (form.id === "pkgSettingsForm") {
        stop(event);
        return busy(form.querySelector("button[type=submit]"), async () => {
          S.settings = await DF.api("/packages/settings", { method: "PUT", body: { collectHoldDays: Number(form.elements.collectHoldDays.value), collectReminderHours: Number(form.elements.collectReminderHours.value) } });
          toast("Collect-from-hub settings saved.");
        });
      }
    },
    true,
  );
})();
