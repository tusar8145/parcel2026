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
  /** Operational settings › Products: the product lists by merchant type. Service plans keeps only which ones send messages. */
  const PRODUCTS_PAGE = "Products";
  const PRODUCT_LISTS = [
    ["ECOMMERCE", "Customer & E-commerce"],
    ["BANKING_FINANCIAL", "Banking & Financial"],
  ];
  const SEGMENTS = [
    ["CUSTOMER", "Customer"],
    ["ECOMMERCE", "E-commerce"],
    ["BANKING_FINANCIAL", "Banking & Financial"],
  ];
  const PENDING = "Sent for approval: another super admin has to approve it (Admin users & roles → Approvals). Nothing changes until then.";
  const S = {
    segment: "CUSTOMER",
    /** The page on screen, and the product list open on the Products page. */
    view: PAGE,
    productList: "ECOMMERCE",
    /** The Service plans tab on screen (also ?section= in the address); the merchant search; closed editor groups. */
    section: new URLSearchParams(location.search).get("section") || "packages",
    merchantQuery: "",
    productQuery: "",
    productStatus: "",
    /** "asc" or "desc" by name, from the column header; "" = the list's own order. */
    productSort: "",
    closedGroups: new Set(),
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

  // The base renderer draws unknown pages from its `generic` table: give the new page an empty entry.
  try {
    if (typeof generic === "object" && !generic[PRODUCTS_PAGE]) generic[PRODUCTS_PAGE] = { desc: "Products by merchant type", cols: [], rows: [] };
  } catch {}

  const baseShowPage = window.showPage;
  window.showPage = showPage = function (page) {
    // A live redraw of this page starts by clearing it: remember the merchant select the person is on.
    S.keepFocus = document.activeElement?.dataset?.pkgAssignSelect || S.keepFocus;
    baseShowPage(page);
    active = page === PAGE || page === PRODUCTS_PAGE;
    if (!active) return;
    S.view = page;
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
    S.section = "merchants";
    S.merchantQuery = merchantCode;
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
  /** Opens a merchant type's products. */
  async function openProducts(segment = "ECOMMERCE") {
    S.productList = segment === "BANKING_FINANCIAL" ? segment : "ECOMMERCE";
    showPage(PRODUCTS_PAGE);
  }
  document.addEventListener("click", event => {
    const button = event.target.closest?.("[data-open-products]");
    if (!button) return;
    event.preventDefault();
    void openProducts(button.dataset.openProducts || "ECOMMERCE");
  });
  window.DFPackages = { openAssignment, openProducts, styles: () => styles() };

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
    window.scrollTo(0, 0);
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
    if (S.view === PRODUCTS_PAGE) return renderProducts(main);
    styles();
    const seg = S.segment;
    if (S.editing) return renderEditor(main, seg);
    // A live redraw (an approval decided) keeps the merchant select the person is on.
    const focused = document.activeElement?.dataset?.pkgAssignSelect || S.keepFocus;
    S.keepFocus = null;
    const sections = sectionsOf(seg);
    if (!sections.some(([key]) => key === S.section)) S.section = "packages";
    main.innerHTML = `${heading(`<button type="button" class="button button-primary" data-pkg-new>New package</button>`)}
      ${segmentTabs(seg)}
      ${summary(seg)}
      <div class="svp-tabs" role="tablist" aria-label="Service plan sections">${sections
        .map(
          ([key, label, count]) =>
            `<button type="button" role="tab" id="pkgTab-${key}" class="svp-tab" data-pkg-section="${key}" aria-selected="${S.section === key}" aria-controls="servicePackagesPage" tabindex="${S.section === key ? 0 : -1}">${esc(label)}${count == null ? "" : `<span class="svp-count">${esc(count)}</span>`}</button>`,
        )
        .join("")}</div>
      <div class="svp-body" id="servicePackagesPage" role="tabpanel" aria-labelledby="pkgTab-${S.section}">${sectionBody(seg)}</div>`;
    filterMerchants();
    keepSectionInAddress();
    if (focused) document.querySelector(`[data-pkg-assign-select="${CSS.escape(focused)}"]`)?.focus();
  }

  const heading = actions => `<div class="page-heading"><div><p class="eyebrow">Merchant management · Service packages</p><h1>Service plans &amp; pricing</h1><p class="subtitle">Choose who a plan is for, then manage its packages, merchants and messages.</p></div>${actions ? `<div class="heading-actions">${actions}</div>` : ""}</div>`;

  const segmentTabs = seg =>
    `<div class="svp-segments" role="group" aria-label="Who the plans are for" id="pkgSegments">${SEGMENTS.map(
      ([code, label]) => `<button type="button" class="svp-segment" data-pkg-segment="${code}" aria-pressed="${seg === code}">${esc(label)}</button>`,
    ).join("")}</div>`;

  /** The segment's list of products (Customer shares E-commerce's). */
  const productsOf = seg => S.products.filter(p => p.segment === (seg === "BANKING_FINANCIAL" ? "BANKING_FINANCIAL" : "ECOMMERCE"));

  /** Tabs: [key, label, count]. */
  function sectionsOf(seg) {
    const live = pkgsOf(seg).filter(p => p.status === "ACTIVE").length;
    return [
      ["packages", "Packages", live],
      ...(seg !== "CUSTOMER" ? [["merchants", "Merchants", (S.assignments[seg] || []).length]] : []),
      ["simulator", "Price simulator", null],
      ["messages", "Messages", productsOf(seg).filter(p => p.sendMessages).length],
      ["hub-pickup", "Hub Pickup", null],
    ];
  }

  /** The plan at a glance. */
  function summary(seg) {
    const main = pkgsOf(seg).find(p => p.isDefault);
    const custom = (S.assignments[seg] || []).filter(r => r.package && !r.package.isDefault).length;
    const products = productsOf(seg);
    const tile = (label, value, hint) => `<article class="svp-tile"><span>${esc(label)}</span><strong>${esc(value)}</strong>${hint ? `<small>${esc(hint)}</small>` : ""}</article>`;
    return `<section class="svp-summary" aria-label="${esc(segLabel(seg))} at a glance">${[
      tile("Default package", main?.name || "None yet", main?.current ? `Version ${main.current.version}` : "Applies when no package is assigned"),
      tile("Active packages", pkgsOf(seg).filter(p => p.status === "ACTIVE").length.toLocaleString("en-US"), ""),
      seg === "CUSTOMER" ? tile("Applies to", "Website & walk-in", "Customers and walk-in senders") : tile("On their own package", custom.toLocaleString("en-US"), `of ${(S.assignments[seg] || []).length.toLocaleString("en-US")} merchants`),
      tile("Products with messages", products.filter(p => p.sendMessages).length.toLocaleString("en-US"), `of ${products.length.toLocaleString("en-US")} products`),
    ].join("")}</section>`;
  }

  function sectionBody(seg) {
    switch (S.section) {
      case "merchants":
        return panel(`${segLabel(seg)} merchants`, "Assign a package from a date (empty = now). Merchants without one use the default package.", assignmentsTable(seg), `<input class="table-search" id="pkgMerchantSearch" type="search" placeholder="Search merchants" aria-label="Search merchants" value="${esc(S.merchantQuery)}">`, "pkgAssignmentsPanel");
      case "simulator":
        return `<div class="svp-narrow">${panel("Price simulator", "See what a booking would cost on the default package.", simulator(seg), "", "pkgSimulatorPanel")}</div>`;
      case "messages":
        return panel("Products with messages", `Choose the products that send SMS & email. The others send none. New bookings follow this.${seg === "CUSTOMER" ? " Customer and E-commerce share one product list." : ""}`, messagesPanel(seg === "BANKING_FINANCIAL" ? "BANKING_FINANCIAL" : "ECOMMERCE"), "", "pkgProductsPanel");
      case "hub-pickup":
        return `<div class="svp-narrow">${panel("Hub Pickup", "How long a parcel waits at the collection hub, and when the reminder SMS goes out. This applies to every plan.", settingsPanel(), "", "pkgSettingsPanel")}</div>`;
      default:
        return panel("Packages", `The default package applies to every ${seg === "CUSTOMER" ? "website customer and walk-in sender" : "merchant without its own package"}. Price and package changes start from their date and need a second super admin's approval; parcels keep the price they were booked with.`, packagesTable(seg));
    }
  }

  /** Editing a package has the page to itself: the form, with what the draft would charge beside it. */
  function renderEditor(main, seg) {
    const title = S.editing === "new" ? `New ${segLabel(seg)} package` : `Edit ${S.packages.find(p => p.id === S.editing)?.name || ""}`;
    main.innerHTML = `${heading("")}
      <div class="svp-editor-head"><button type="button" class="svp-back" data-pkg-cancel>‹ Back to packages</button><h2>${esc(title)}</h2><p class="panel-subtitle">Saving creates a new version from its effective date.</p></div>
      <nav class="svp-jump" aria-label="Sections of this package"><a href="#pkgSecDetails" data-pkg-jump>Details</a><a href="#pkgSecServices" data-pkg-jump>Services</a><a href="#pkgSecPrices" data-pkg-jump>Prices</a></nav>
      <div class="svp-workspace" id="servicePackagesPage">
        <section class="panel" id="pkgEditorPanel">${editor(seg)}</section>
        <div class="svp-side">${panel("Price preview", "What this draft would charge, before you save it.", simulator(seg), "", "pkgSimulatorPanel")}</div>
      </div>`;
  }

  /** The tab stays in the address (a reload or a shared link opens it). */
  function keepSectionInAddress() {
    const url = new URL(location.href);
    if (S.section === "packages") url.searchParams.delete("section");
    else url.searchParams.set("section", S.section);
    if (url.href !== location.href) history.replaceState(history.state, "", url);
  }

  function filterMerchants() {
    const q = S.merchantQuery.trim().toLowerCase();
    for (const row of document.querySelectorAll("#pkgAssignments tbody tr")) row.hidden = !!q && !row.textContent.toLowerCase().includes(q);
  }

  /** Editor groups: "3 of 5 on" follows the ticks. */
  function updateGroupCounts() {
    for (const group of document.querySelectorAll("[data-svp-services]")) {
      const boxes = [...group.querySelectorAll('input[type="checkbox"]')];
      group.querySelector("[data-svp-on]").textContent = `${boxes.filter(b => b.checked).length} of ${boxes.length} on`;
    }
  }

  function styles() {
    if (document.getElementById("svpCss")) return;
    document.head.insertAdjacentHTML(
      "beforeend",
      `<style id="svpCss">
      .svp-segments{display:inline-flex;gap:4px;padding:4px;margin:4px 0 14px;border-radius:11px;background:#eef1f5;max-width:100%;overflow-x:auto}
      .svp-segment{padding:8px 16px;border:0;border-radius:8px;background:transparent;color:#526071;font:inherit;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}
      .svp-segment:hover{color:var(--ink)}
      .svp-segment[aria-pressed="true"]{background:var(--surface,#fff);color:var(--blue);box-shadow:0 1px 2px #1720331f}
      .svp-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}
      .svp-tile{display:grid;gap:3px;align-content:start;padding:13px 15px;border:1px solid var(--line);border-radius:10px;background:var(--surface,#fff);min-width:0}
      .svp-tile span{color:#667283;font-size:12px}
      .svp-tile strong{color:var(--ink);font-size:18px;line-height:1.25;overflow-wrap:anywhere}
      .svp-tile small{color:#8a95a5;font-size:12px}
      .svp-tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:14px;overflow-x:auto}
      .svp-tab{display:inline-flex;align-items:center;gap:7px;padding:10px 14px;margin-bottom:-1px;border:0;border-bottom:2px solid transparent;background:none;color:#5d6a7b;font:inherit;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}
      .svp-tab:hover{color:var(--ink)}
      .svp-tab[aria-selected="true"]{color:var(--blue);border-bottom-color:var(--blue)}
      .svp-tab:focus-visible,.svp-segment:focus-visible,.svp-back:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
      .svp-count{padding:0 7px;border-radius:999px;background:#eef1f5;color:#5d6a7b;font-size:11px;line-height:18px}
      .svp-tab[aria-selected="true"] .svp-count{background:var(--blue-soft);color:var(--blue)}
      .svp-body>.panel,.svp-workspace .panel{margin:0}
      .svp-narrow{max-width:720px}
      .svp-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0 12px}
      .svp-tools .table-search{width:min(280px,100%)}
      .svp-tools-end{display:inline-flex;gap:8px;margin-left:auto}
      .svp-sort{display:inline-flex;align-items:center;gap:6px;padding:0;border:0;background:none;color:inherit;font:inherit;letter-spacing:inherit;cursor:pointer}
      .svp-sort:hover{color:var(--blue)}
      .svp-sort:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
      .svp-editor-head{margin:2px 0 10px}
      .svp-editor-head h2{margin:6px 0 2px;font-size:19px;color:var(--ink)}
      .svp-back{padding:0;border:0;background:none;color:var(--blue);font:inherit;font-size:13px;font-weight:600;cursor:pointer}
      .svp-jump{position:sticky;top:60px;z-index:5;display:flex;gap:4px;padding:8px 0;margin-bottom:6px;background:var(--canvas)}
      .svp-jump a{padding:6px 12px;border-radius:7px;color:#526071;font-size:13px;font-weight:600;text-decoration:none}
      .svp-jump a:hover{background:var(--blue-soft);color:var(--blue)}
      .svp-workspace{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,340px);gap:14px;align-items:start;margin-bottom:14px}
      .svp-side{position:sticky;top:112px;max-height:calc(100vh - 124px);overflow:auto}
      .svp-section-title{margin:18px 0 8px;font-size:14px;color:var(--ink);scroll-margin-top:116px}
      .svp-section-title:first-child{margin-top:0}
      details.svp-group{padding:0;background:var(--surface,#fff)}
      details.svp-group>summary{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;color:var(--ink);font-size:13px;font-weight:600;cursor:pointer;list-style:none}
      details.svp-group>summary::-webkit-details-marker{display:none}
      details.svp-group>summary::after{content:"▾";color:#8a95a5}
      details.svp-group:not([open])>summary::after{content:"▸"}
      details.svp-group>summary small{margin-left:auto;color:#8a95a5;font-size:12px;font-weight:500}
      details.svp-group>div{padding:2px 12px 12px}
      #pkgEditor .modal-actions{position:sticky;bottom:0;margin:14px -15px -14px;padding:11px 15px;border-top:1px solid var(--line);border-radius:0 0 9px 9px;background:var(--surface,#fff)}
      @media(max-width:980px){.svp-workspace{grid-template-columns:1fr}.svp-side{position:static;max-height:none}}
      </style>`,
    );
  }

  /** Operational settings › Products: one list per merchant type, with add, deactivate and delete. */
  function renderProducts(main) {
    const list = S.productList;
    const tabs = PRODUCT_LISTS.map(
      ([code, label]) => `<button type="button" class="button button-sm${list === code ? " button-primary" : ""}" data-product-list="${code}" aria-pressed="${list === code}">${esc(label)}</button>`,
    ).join("");
    main.innerHTML = `<div class="page-heading"><div><p class="eyebrow">Operational settings</p><h1>Products</h1><p class="subtitle">The products offered in bookings, by merchant type. A product's type (Regular, Document, Books) prices the parcel.</p></div></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 12px" role="tablist" id="productLists">${tabs}</div>
      <div class="config-layout" id="productsPage">${panel(`${PRODUCT_LISTS.find(l => l[0] === list)[1]} products`, "Optional in bookings. A product with parcels can be deactivated; one without can be deleted. Messages are switched on in Service plans.", productsPanel(list), "", "pkgProductsPanel", true)}</div>`;
    const crumb = document.getElementById("breadcrumbPage");
    if (crumb) crumb.textContent = PRODUCTS_PAGE;
    styles();
    filterProducts();
  }

  function panel(title, subtitle, body, actions = "", id = "", wide = false) {
    return `<section class="panel"${id ? ` id="${id}"` : ""}${wide ? ' style="grid-column:1/-1"' : ""}><div class="panel-heading"><div><h2 class="panel-title">${esc(title)}</h2>${subtitle ? `<p class="panel-subtitle">${esc(subtitle)}</p>` : ""}</div>${actions ? `<div>${actions}</div>` : ""}</div>${body}</section>`;
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
        return `<details class="service-group svp-group" data-svp-group="${esc(g.label)}" data-svp-services ${S.closedGroups.has(g.label) ? "" : "open"}><summary>${esc(g.label)}<small data-svp-on>${items.filter(s => d.services.has(s.code) || s.core).length} of ${items.length} on</small></summary><div class="service-plan-checks">${items
          .map(
            s =>
              `<label class="config-check" title="${esc(s.hint || "")}"><input type="checkbox" data-pkg-service="${esc(s.code)}" ${d.services.has(s.code) || s.core ? "checked" : ""} ${s.core ? "disabled" : ""}> ${esc(s.label)}${s.core ? " (always on)" : ""}</label>`,
          )
          .join("")}</div></details>`;
      })
      .join("");
    // Price fields in the owner's groups (Route, What are you sending, Weight, Service, Last mile, First mile, …).
    const fields = fieldsFor(seg);
    const prices = [...new Set(fields.map(f => f.group))]
      .map(
        group =>
          `<details class="service-group svp-group" data-svp-group="${esc(group)}" ${S.closedGroups.has(group) ? "" : "open"}><summary>${esc(group)}</summary><div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">${fields
            .filter(f => f.group === group)
            .map(
              f =>
                `<div class="field"><label for="pkgPrice-${f.key}">${esc(`${f.sign === "-" ? "− " : f.sign === "+" ? "+ " : ""}${f.label}`)}${unitOf(f) ? ` (${unitOf(f)})` : ""}</label><input id="pkgPrice-${f.key}" type="number" ${f.signed ? "" : 'min="0"'} step="${f.unit === "count" ? 1 : 0.01}" data-pkg-price="${f.key}" value="${esc(d.prices[f.key] ?? 0)}" required></div>`,
            )
            .join("")}</div></details>`,
      )
      .join("");
    return `<form id="pkgEditor" class="config-form" novalidate>
      <h3 class="svp-section-title" id="pkgSecDetails">Details</h3>
      <div class="form-grid">
        <div class="field"><label for="pkgName">Package name *</label><input id="pkgName" name="pkgName" value="${esc(d.name)}" maxlength="80" required></div>
        <div class="field"><label for="pkgEffectiveFrom">Effective from</label><input id="pkgEffectiveFrom" name="pkgEffectiveFrom" type="datetime-local" value="${esc(d.effectiveFrom)}" min="${localInput(new Date())}"><small class="subcell">Empty: as soon as it is approved.</small></div>
        <div class="field full"><label for="pkgDescription">Description</label><input id="pkgDescription" name="pkgDescription" value="${esc(d.description)}" maxlength="300"></div>
        <div class="field full"><label for="pkgNote">Change note</label><input id="pkgNote" name="pkgNote" value="${esc(d.note)}" maxlength="300" placeholder="Why the change (shown to the approver)"></div>
        ${S.editing === "new" ? `<label class="config-check field full"><input type="checkbox" name="pkgMakeDefault" ${d.makeDefault ? "checked" : ""}> Make it the default ${esc(segLabel(seg))} package</label>` : ""}
      </div>
      <h3 class="svp-section-title" id="pkgSecServices">Services</h3>
      <div style="display:grid;gap:9px">${groups}</div>
      <h3 class="svp-section-title" id="pkgSecPrices">Prices</h3>
      <p class="panel-subtitle" style="margin:0 0 8px">Prices depend on the districts only. Every line rounded to whole taka. “−” adjustments are subtracted; the delivery charge never goes below ৳0.</p>
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

  /**
   * Which products send SMS & email: one field that takes any number of products, with search and select all.
   * Saved together; a product that isn't chosen sends no messages.
   */
  function messagesField(rows) {
    const key = `${rows[0].segment}:${rows.length}`; // a product added or removed starts again from what is saved
    if (S.msgKey !== key) Object.assign(S, { msgKey: key, msgFor: rows[0].segment, msgPick: new Set(rows.filter(p => p.sendMessages).map(p => p.id)), msgOpen: false, msgQuery: "" });
    const pick = S.msgPick;
    const changed = rows.some(p => p.sendMessages !== pick.has(p.id));
    const chosen = rows.filter(p => pick.has(p.id));
    const chips = chosen.slice(0, 8).map(p => `<span class="config-chip">${esc(p.name)}</span>`).join("");
    const q = S.msgQuery.toLowerCase();
    const options = rows
      .map(p => `<label class="config-check" data-msg-option="${esc(p.name.toLowerCase())}" ${q && !p.name.toLowerCase().includes(q) ? "hidden" : ""} style="padding:4px 2px"><input type="checkbox" data-pkg-msg-pick="${p.id}" ${pick.has(p.id) ? "checked" : ""}> ${esc(p.name)}</label>`)
      .join("");
    return `<section id="pkgMessages" style="display:grid;gap:8px">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button type="button" class="button" id="pkgMsgToggle" aria-expanded="${!!S.msgOpen}" aria-controls="pkgMsgList">${chosen.length.toLocaleString("en-US")} of ${rows.length.toLocaleString("en-US")} selected ${S.msgOpen ? "▲" : "▼"}</button><button type="button" class="button button-primary" id="pkgMsgSave" ${changed ? "" : "disabled"}>Save</button>${changed ? `<span class="panel-subtitle">Not saved yet</span>` : ""}</div>
      ${chosen.length ? `<div class="config-list" id="pkgMsgChips">${chips}${chosen.length > 8 ? `<span class="panel-subtitle">and ${(chosen.length - 8).toLocaleString("en-US")} more</span>` : ""}</div>` : ""}
      ${S.msgOpen ? `<div id="pkgMsgList" style="display:grid;gap:8px"><div style="display:flex;gap:8px;flex-wrap:wrap"><input class="table-search" id="pkgMsgSearch" type="search" placeholder="Search products" aria-label="Search products" value="${esc(S.msgQuery)}"><button type="button" class="button button-sm" data-pkg-msg-all="1">Select all</button><button type="button" class="button button-sm" data-pkg-msg-all="">Clear</button></div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:2px 12px;max-height:280px;overflow:auto;padding:4px">${options}</div></div>` : ""}</section>`;
  }

  /** Service plans: which of the merchant type's products send messages. */
  function messagesPanel(segment) {
    const rows = S.products.filter(p => p.segment === segment);
    if (rows.length) return messagesField(rows);
    return `<p class="panel-subtitle">No products yet. <button type="button" class="button button-sm" data-open-products="${segment}">Add products</button></p>`;
  }

  const productType = code => (S.catalog.productTypes || []).find(t => t.code === code)?.label || code;

  /** The list: search, status, Excel and add above it; numbered pages come with shared/table-pager.js. */
  function productsPanel(segment) {
    const rows = S.products.filter(p => p.segment === segment);
    if (S.productSort) rows.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true }) * (S.productSort === "asc" ? 1 : -1));
    const ariaSort = { asc: "ascending", desc: "descending" }[S.productSort] || "none";
    const arrow = { asc: "▲", desc: "▼" }[S.productSort] || "↕";
    const statusOption = (value, label) => `<option value="${value}"${S.productStatus === value ? " selected" : ""}>${label}</option>`;
    const tools = `<div class="svp-tools"><input class="table-search" id="pkgProductSearch" type="search" placeholder="Search products" aria-label="Search products" value="${esc(S.productQuery)}"><select class="select-small" id="pkgProductStatus" aria-label="Filter by status">${statusOption("", "All statuses")}${statusOption("active", "Active")}${statusOption("inactive", "Inactive")}</select><span class="panel-subtitle" id="pkgProductCount" role="status"></span><span class="svp-tools-end"><button type="button" class="button" id="pkgProductExport">Export Excel</button><button type="button" class="button button-primary" id="pkgProductAdd">Add product</button></span></div>`;
    const list = rows.length
      ? `<div class="table-scroll"><table id="pkgProducts"><thead><tr><th aria-sort="${ariaSort}"><button type="button" class="svp-sort" id="pkgProductSort" title="Sort by name">PRODUCT <span aria-hidden="true">${arrow}</span></button></th><th>TYPE</th><th>STATUS</th><th>PARCELS</th><th></th></tr></thead><tbody>${rows
          .map(
            p => `<tr data-pkg-product="${esc(p.name)}" data-product-active="${p.active}"><td class="primary-cell">${esc(p.name)}</td><td>${esc(productType(p.type))}</td><td><span class="status ${p.active ? "status-good" : "status-warn"}">${p.active ? "Active" : "Inactive"}</span></td><td>${Number(p.parcels).toLocaleString("en-US")}</td><td><div style="display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end"><button type="button" class="button button-sm" data-pkg-product-edit="${p.id}">Edit</button><button type="button" class="button button-sm" data-pkg-product-toggle="${p.id}">${p.active ? "Deactivate" : "Activate"}</button>${p.parcels ? "" : `<button type="button" class="button button-sm button-danger" data-pkg-product-delete="${p.id}">Delete</button>`}</div></td></tr>`,
          )
          .join("")}</tbody></table></div><p class="empty-state" id="pkgProductNone" hidden>No products match.</p>`
      : `<p class="empty-state">No products yet. Add the first one.</p>`;
    return `${tools}${list}`;
  }

  function filterProducts() {
    const q = S.productQuery.trim().toLowerCase();
    const rows = [...document.querySelectorAll("#pkgProducts tbody tr")];
    let shown = 0;
    for (const row of rows) {
      const hide = (q && !row.dataset.pkgProduct.toLowerCase().includes(q)) || (S.productStatus && (row.dataset.productActive === "true") !== (S.productStatus === "active"));
      row.hidden = !!hide;
      if (!hide) shown++;
    }
    const count = document.getElementById("pkgProductCount");
    if (count) count.textContent = rows.length ? `${shown.toLocaleString("en-US")} of ${rows.length.toLocaleString("en-US")} products` : "";
    const none = document.getElementById("pkgProductNone");
    if (none) none.hidden = !!shown;
  }

  /** Add or edit a product: its name and type. */
  function productDialog(product) {
    closeProductDialog();
    const segment = S.productList;
    const types = S.catalog.productTypes || [];
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="pkgProductDialog" role="dialog" aria-modal="true" aria-labelledby="pkgProductDialogTitle" style="position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:16px;background:#14203380"><form id="pkgProductForm" class="config-form panel" data-segment="${segment}" data-id="${product?.id ?? ""}" style="width:min(460px,100%);padding:20px"><h2 class="panel-title" id="pkgProductDialogTitle" style="font-size:16px">${product ? `Edit ${esc(product.name)}` : "Add product"}</h2><div class="field"><label for="pkgProductName">Product name</label><input id="pkgProductName" name="productName" maxlength="120" value="${esc(product?.name ?? "")}" placeholder="${segment === "BANKING_FINANCIAL" ? "e.g. Credit Cards" : "e.g. Fashion & Apparel"}" required></div><div class="field"><label for="pkgProductType">Type</label><select id="pkgProductType" name="productType">${types.map(t => `<option value="${t.code}"${t.code === product?.type ? " selected" : ""}>${esc(t.label)}</option>`).join("")}</select></div><p class="panel-subtitle" style="margin:0">The type prices the parcel.</p><div class="modal-actions"><button type="button" class="button" data-pkg-product-close>Cancel</button><button type="submit" class="button button-primary">${product ? "Save" : "Add product"}</button></div></form></div>`,
    );
    document.getElementById("pkgProductName").focus();
  }
  function closeProductDialog() {
    document.getElementById("pkgProductDialog")?.remove();
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
      // The product dialog sits on <body>, outside the page.
      if (!active || !(t instanceof Element) || !t.closest("#mainContent, #pkgProductDialog")) return;
      const btn = sel => t.closest(sel);
      let b;
      if ((b = btn("[data-pkg-section]"))) {
        stop(event);
        S.section = b.dataset.pkgSection;
        render();
        return document.querySelector(`[data-pkg-section="${S.section}"]`)?.focus();
      }
      if ((b = btn("[data-pkg-jump]"))) {
        stop(event);
        const to = document.querySelector(b.getAttribute("href"));
        return to && window.scrollTo({ top: to.getBoundingClientRect().top + window.scrollY - 116, behavior: "smooth" });
      }
      if ((b = btn("[data-product-list]"))) {
        stop(event);
        // The address keeps the tab in step by clicking it: only a real change starts a new search.
        if (b.dataset.productList === S.productList) return;
        S.productList = b.dataset.productList;
        S.productQuery = "";
        S.productStatus = "";
        return render();
      }
      if (btn("#pkgProductSort")) {
        stop(event);
        S.productSort = S.productSort === "asc" ? "desc" : "asc";
        render();
        return document.getElementById("pkgProductSort")?.focus();
      }
      if (btn("#pkgProductAdd")) return stop(event), productDialog(null);
      if ((b = btn("[data-pkg-product-edit]"))) return stop(event), productDialog(S.products.find(p => p.id === b.dataset.pkgProductEdit));
      if (btn("[data-pkg-product-close]")) return stop(event), closeProductDialog();
      if ((b = btn("#pkgProductExport"))) {
        stop(event);
        const query = new URLSearchParams({ segment: S.productList });
        if (S.productQuery.trim()) query.set("q", S.productQuery.trim());
        if (S.productStatus) query.set("status", S.productStatus);
        if (S.productSort) query.set("sort", S.productSort);
        return void DF.busy(b, () => DF.download(`/parcel-products/export?${query}`, "products.xlsx").then(() => toast("Products exported to Excel."), fail), "Exporting…");
      }
      if ((b = btn("[data-pkg-segment]"))) {
        stop(event);
        if (b.dataset.pkgSegment === S.segment) return; // the address keeping the tab in step
        S.segment = b.dataset.pkgSegment;
        S.merchantQuery = "";
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
        return void DF.confirm({ title: `Make ${p.name} the default?`, message: `Every ${segLabel(p.segment)} merchant without their own package will use it.`, confirm: "Make default" }).then(ok => ok && busy(b, async () => {
          outcome(await DF.api(`/packages/${p.id}/default`, { method: "POST" }), `${p.name} is now the default package.`);
          await load("packages", "assignments");
          render();
        }));
      }
      if ((b = btn("[data-pkg-archive]"))) {
        stop(event);
        const p = S.packages.find(x => x.id === b.dataset.pkgArchive);
        return void DF.confirm({ title: `Archive ${p.name}?`, message: "It can't be assigned any more; merchants already on it keep it until you assign another.", confirm: "Archive", danger: true }).then(ok => ok && busy(b, async () => {
          outcome(await DF.api(`/packages/${p.id}/archive`, { method: "POST" }), `${p.name} archived.`);
          await load("packages");
          render();
        }));
      }
      if ((b = btn("[data-pkg-delete]"))) {
        stop(event);
        const p = S.packages.find(x => x.id === b.dataset.pkgDelete);
        return void DF.confirm({ title: `Delete ${p.name}?`, message: "Only packages nothing used can be deleted.", confirm: "Delete", danger: true }).then(ok => ok && busy(b, async () => {
          await DF.api(`/packages/${p.id}`, { method: "DELETE" });
          toast(`${p.name} deleted.`);
          await load("packages");
          render();
        }));
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
        return void DF.confirm({ title: `Delete ${p.name}?`, message: "The product is removed from the catalogue.", confirm: "Delete", danger: true }).then(ok => ok && busy(b, async () => {
          await DF.api(`/parcel-products/${p.id}`, { method: "DELETE" });
          await load("products");
          render();
        }));
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
        return void DF.confirm({ title: `Delete the hub group ${g.name}?`, message: "Prices between its hubs go back to the normal zone prices.", confirm: "Delete group", danger: true }).then(ok => ok && busy(b, async () => {
          await DF.api(`/hub-groups/${g.id}`, { method: "DELETE" });
          await load("groups");
          render();
        }));
      }
    },
    true,
  );

  // Tabs follow the arrow keys; the merchant search and the editor's open groups are kept across redraws.
  window.addEventListener("keydown", event => {
    if (event.key === "Escape") closeProductDialog();
    const tab = event.target.closest?.("[data-pkg-section]");
    if (!tab || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const tabs = [...document.querySelectorAll("[data-pkg-section]")];
    const next = tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    event.preventDefault();
    next.click();
  });
  window.addEventListener("input", event => {
    if (event.target.id === "pkgProductSearch") {
      S.productQuery = event.target.value;
      return filterProducts();
    }
    if (event.target.id !== "pkgMerchantSearch") return;
    S.merchantQuery = event.target.value;
    filterMerchants();
  });
  document.addEventListener(
    "toggle",
    event => {
      const group = event.target.dataset?.svpGroup;
      if (!group) return;
      if (event.target.open) S.closedGroups.delete(group);
      else S.closedGroups.add(group);
    },
    true,
  );

  /** Only the field redraws: the page's other forms keep what's typed, and the list keeps its scroll. */
  function redrawMessages() {
    const box = document.getElementById("pkgMessages");
    if (!box) return;
    const list = box.querySelector("#pkgMsgList > div:last-child");
    const top = list?.scrollTop;
    const focus = document.activeElement?.id === "pkgMsgSearch";
    const rows = S.products.filter(p => p.segment === S.msgFor);
    box.outerHTML = messagesField(rows);
    const fresh = document.querySelector("#pkgMsgList > div:last-child");
    if (fresh && top) fresh.scrollTop = top;
    if (focus) document.getElementById("pkgMsgSearch")?.focus();
  }
  window.addEventListener("input", event => {
    if (event.target.id !== "pkgMsgSearch") return;
    S.msgQuery = event.target.value;
    const q = S.msgQuery.toLowerCase();
    for (const row of document.querySelectorAll("[data-msg-option]")) row.hidden = !!q && !row.dataset.msgOption.includes(q);
  });
  window.addEventListener("click", event => {
    const t = event.target;
    if (!active || !(t instanceof Element)) return;
    if (t.closest("#pkgMsgToggle")) {
      S.msgOpen = !S.msgOpen;
      return redrawMessages();
    }
    const all = t.closest("[data-pkg-msg-all]");
    if (all) {
      const q = S.msgQuery.toLowerCase();
      // With a search, only the products it shows.
      for (const p of S.products.filter(x => x.segment === S.msgFor && (!q || x.name.toLowerCase().includes(q)))) {
        if (all.dataset.pkgMsgAll) S.msgPick.add(p.id);
        else S.msgPick.delete(p.id);
      }
      return redrawMessages();
    }
    const save = t.closest("#pkgMsgSave");
    if (!save) return;
    const segment = S.msgFor;
    void DF.busy(save, async () => {
      try {
        await DF.api("/parcel-products/messages", { method: "PUT", body: { segment, productIds: [...S.msgPick] } });
        toast(`Messages are on for ${S.msgPick.size.toLocaleString("en-US")} product${S.msgPick.size === 1 ? "" : "s"}.`);
        await load("products");
        S.msgKey = null;
        render();
      } catch (error) {
        fail(error);
      }
    }, "Saving…");
  });
  window.addEventListener(
    "change",
    event => {
      const t = event.target;
      if (!active || !(t instanceof Element)) return;
      if (t.id === "pkgProductStatus") {
        S.productStatus = t.value;
        return filterProducts();
      }
      if (t.closest("#pkgEditor")) {
        updateGroupCounts();
        return readEditor();
      }
      if (t.matches?.("[data-pkg-msg-pick]")) {
        if (t.checked) S.msgPick.add(t.dataset.pkgMsgPick);
        else S.msgPick.delete(t.dataset.pkgMsgPick);
        return redrawMessages();
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
        const type = form.elements.productType.value;
        const id = form.dataset.id;
        return busy(form.querySelector("button[type=submit]"), async () => {
          if (id) await DF.api(`/parcel-products/${id}`, { method: "PATCH", body: { name, type } });
          else await DF.api("/parcel-products", { method: "POST", body: { segment: form.dataset.segment, name, type } });
          toast(id ? `${name} saved.` : `${name} added.`);
          closeProductDialog();
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
