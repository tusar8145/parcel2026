/*
 * Merchant panels: New orders and All orders (e-commerce) / New requests and All requests (Banking & Financial).
 *
 *   New orders    booked and not yet collected or brought in (GET /parcels ?stage=not_picked_up)
 *   All orders    every order, the last month unless other dates are chosen; the old "Shipments" and
 *                 "Delivery tracking" pages open it (the "Orders" page keeps its internal name)
 *
 * Both are server-paged (GET /parcels ?page), so filters and totals cover every order, not only the ones
 * the panel keeps in the browser. Rows use the page script's markup and its row actions (tracking history,
 * cancel, complete, confirm return), by giving it the page's orders while it draws.
 *
 *   Filters   search, status, date field, from, to; e-commerce: product, payment, district;
 *             Banking & Financial: document, origin branch, district
 *   Export    GET /merchants/me/parcels/export: every matching order (or the ticked rows) as Excel, with
 *             the columns of the merchant type and status, and nothing internal
 *   Print     the ticked rows, else every matching order
 */
(() => {
  const DF = window.DF;
  const P = () => window.DFMerchantPanel;
  if (!DF || !P()) return;
  const S = () => P().state;
  const q = (sep = "?") => P().merchantQuery(sep);
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = n => Number(n || 0).toLocaleString("en-BD");
  const doc = () => !!S().cfg?.document;
  const owner = () => S().merchant?.myRole === "MERCHANT_OWNER";
  const noun = () => (doc() ? "request" : "order");
  const NEEDS_INFO = "__needs_info";
  const PAGE_SIZES = [25, 50, 100];
  const PRINT_CAP = 1000;
  const STATUSES = {
    "New orders": ["Pending operations confirmation", "Pickup assigned", "Pickup confirmed"],
    Orders: ["Pending operations confirmation", "Pickup assigned", "Pickup confirmed", "Picked up", "At hub", "In transit", "Assigned", "Out for delivery", "Retry scheduled", "Ready for collection", "Exception", "Return scheduled", "Delivered", "Returned", "Pickup cancelled"],
  };

  const day = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  /** The last calendar month up to today (31 March → 28 February). */
  function lastMonth() {
    const to = new Date();
    const from = new Date(to.getFullYear(), to.getMonth() - 1, 1);
    from.setDate(Math.min(to.getDate(), new Date(from.getFullYear(), from.getMonth() + 1, 0).getDate()));
    return { from: day(from), to: day(to) };
  }
  const defaults = page => ({ q: "", status: "", dateField: "pickup", from: "", to: "", contents: "", payment: "", district: "", branch: "", ...(page === "Orders" ? lastMonth() : {}) });
  const lists = {
    "New orders": { page: "New orders", no: 1, size: 25, total: 0, pages: 1, items: [], loaded: false, seq: 0, filters: defaults("New orders") },
    Orders: { page: "Orders", no: 1, size: 25, total: 0, pages: 1, items: [], loaded: false, seq: 0, filters: defaults("Orders") },
  };
  let current = null;
  let timer = null;
  const active = () => !!current && S().page === current.page;
  const titleOf = page => (page === "New orders" ? (doc() ? "New requests" : "New orders") : doc() ? "All requests" : "All orders");
  const isFiltered = list => {
    const base = defaults(list.page);
    return Object.keys(base).some(key => list.filters[key] !== base[key]);
  };

  /** The filters as GET /parcels query (also the export's). */
  function query(list) {
    const f = list.filters;
    const params = new URLSearchParams();
    if (list.page === "New orders") params.set("stage", "not_picked_up");
    if (f.q.trim().length >= 2) params.set("q", f.q.trim());
    if (f.status === NEEDS_INFO) params.set("incomplete", "true");
    else if (f.status) params.set("status", f.status);
    if (f.from) params.set("from", new Date(`${f.from}T00:00:00`).toISOString());
    if (f.to) params.set("to", new Date(`${f.to}T23:59:59.999`).toISOString());
    if (f.dateField === "status" && (f.from || f.to)) params.set("dateField", "status");
    for (const key of ["contents", "payment", "district", "branch"]) if (f[key]) params.set(key, f[key]);
    return params;
  }

  async function load(list, { soft = false } = {}) {
    const seq = ++list.seq;
    const params = query(list);
    params.set("limit", String(list.size));
    params.set("page", String(list.no));
    try {
      const answer = await DF.api(`/parcels?${params}${q("&")}`);
      if (seq !== list.seq) return;
      // The page emptied (its orders left the filters): the last page that still has rows.
      if (!answer.items.length && answer.total > 0) {
        list.no = answer.pages;
        return load(list, { soft });
      }
      const same = soft && list.loaded && list.total === answer.total && answer.items.length === list.items.length && answer.items.every((p, i) => list.items[i]?.id === p.id && list.items[i]?.updatedAt === p.updatedAt);
      Object.assign(list, { items: answer.items, total: answer.total, pages: Math.max(1, answer.pages), loaded: true, error: null });
      for (const p of answer.items) S().listed.set(p.trackingId, p);
      if (!same && current === list && active()) draw(list);
    } catch (error) {
      if (seq !== list.seq) return;
      list.error = error;
      list.loaded = true;
      if (!soft) window.showToast?.(DF.describe(error));
      if (current === list && active()) draw(list);
    }
  }

  const unique = values => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const select = (id, label, all, options, value) =>
    `<select class="select-small" id="${id}" aria-label="${esc(label)}"><option value="">${esc(all)}</option>${options.map(([v, text]) => `<option value="${esc(v)}"${v === value ? " selected" : ""}>${esc(text)}</option>`).join("")}</select>`;
  const pairs = values => values.map(v => [v, v]);

  /** The filters of this merchant type; their choices come from the merchant's own orders. */
  function filterBar(list) {
    const f = list.filters;
    const parcels = S().parcels;
    const contentOf = p => (doc() ? String(p.contents || "").split(/\s[-·|]\s|:/)[0].trim() : p.contents);
    const needs = parcels.filter(p => p.incomplete).length;
    const district = select("merchantDistrictFilter", "Filter by district", "All districts", pairs(unique(parcels.map(p => p.delivery?.district))), f.district);
    const kind = doc()
      ? select("merchantContentsFilter", "Filter by document", "All documents", pairs(unique(parcels.map(contentOf))), f.contents) +
        select("merchantBranchFilter", "Filter by origin branch", "All branches", pairs(unique(parcels.map(p => p.originBranchCode))), f.branch)
      : select("merchantContentsFilter", "Filter by product", "All products", pairs(unique(parcels.map(contentOf))), f.contents) +
        select("merchantPaymentFilter", "Filter by payment", "COD and prepaid", [["cod", "Cash on delivery"], ["prepaid", "Prepaid"]], f.payment);
    const status = select("merchantStatusFilter", "Filter by status", "All statuses", [...pairs(STATUSES[list.page]), [NEEDS_INFO, `Needs info${needs ? ` (${needs})` : ""}`]], f.status);
    const dates = `<label>Date field<select class="select-small" id="merchantDateField"><option value="pickup"${f.dateField === "status" ? "" : " selected"}>Pickup / created date</option><option value="status"${f.dateField === "status" ? " selected" : ""}>Status update date</option></select></label><label>From<input class="table-search" id="merchantDateFrom" type="date" aria-label="From date" value="${esc(f.from)}"></label><label>To<input class="table-search" id="merchantDateTo" type="date" aria-label="To date" value="${esc(f.to)}"></label>`;
    const clear = isFiltered(list) ? `<button type="button" class="button button-sm" id="merchantClearFilters">Clear filters</button>` : "";
    return `<div class="merchant-record-filters">${dates}${status}${kind}${district}${clear}</div>`;
  }

  function printOptions() {
    const options = doc()
      ? [["invoice", "Invoices · A4"], ["invoice-4", "4 invoices · A4"], ["invoice-8", "8 invoices · A4"], ["label", "Shipment labels"], ["orders", "Consignment list"]]
      : [["invoice", "Invoices · A4"], ["invoice-4", "4 invoices · A4"], ["invoice-8", "8 invoices · A4"], ["pos", "Invoice · POS 80mm"], ["label", "Shipment labels"], ["orders", "Order list"]];
    return options.map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join("");
  }

  function pager(list) {
    const label = noun();
    const first = (list.no - 1) * list.size + 1;
    const text = list.total ? `Showing ${fmt(first)}–${fmt(first + list.items.length - 1)} of ${fmt(list.total)} ${label}${list.total === 1 ? "" : "s"}` : `No matching ${label}s`;
    const jump = (content, no, aria, { on = false, off = false } = {}) => `<button class="page-btn${on ? " current" : ""}" type="button" data-df-list-page="${no}" aria-label="${esc(aria)}"${on ? ' aria-current="page"' : ""}${off ? " disabled" : ""}>${content}</button>`;
    const near = [...new Set([1, list.no - 1, list.no, list.no + 1, list.pages])].filter(n => n >= 1 && n <= list.pages).sort((a, b) => a - b);
    const numbers = near.map((n, i) => `${i && n - near[i - 1] > 1 ? `<span aria-hidden="true">…</span>` : ""}${jump(fmt(n), n, `Page ${n}`, { on: n === list.no })}`).join("");
    return `<span>${esc(text)}</span><div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center"><label style="display:inline-flex;gap:6px;align-items:center">Rows per page<select class="select-small" id="merchantPageSize" aria-label="Rows per page">${PAGE_SIZES.map(s => `<option value="${s}"${s === list.size ? " selected" : ""}>${s}</option>`).join("")}</select></label><div class="pagination">${jump("‹", list.no - 1, "Previous page", { off: list.no === 1 })}${numbers}${jump("›", list.no + 1, "Next page", { off: list.no === list.pages })}</div></div>`;
  }

  /** Draws the page: the page script's rows and row actions, with this page's orders, heading and tools. */
  function draw(list) {
    const panel = P();
    const focus = document.activeElement?.id;
    const caret = focus === "tableSearch" ? $("tableSearch").selectionStart : null;
    const ticked = [...document.querySelectorAll("#tableBody [data-merchant-select]:checked")].map(box => box.dataset.merchantSelect);
    const scroll = window.scrollY;
    const saved = sampleOrders.slice();
    sampleOrders.length = 0;
    sampleOrders.push(...list.items.map(panel.toOrder));
    pageData.Orders.rows = sampleOrders;
    current = list;
    try {
      base("Orders");
    } finally {
      sampleOrders.length = 0;
      sampleOrders.push(...saved);
    }
    S().page = list.page;
    const main = $("mainContent");
    const title = titleOf(list.page);
    $("breadcrumbPage").textContent = title;
    document.querySelectorAll("#navigation .nav-item").forEach(item => item.classList.toggle("active", item.dataset.page === list.page));
    const heading = main.querySelector(".page-heading");
    if (heading) {
      heading.querySelector("h1").textContent = title;
      heading.querySelector(".subtitle").textContent = list.page === "New orders" ? `Booked and waiting to be collected or brought to a hub. Everything you create starts here.` : `Every ${noun()}, with its full journey. Filter, export or print any of them.`;
    }
    main.querySelector(".page-table-panel .panel-title").textContent = `${title} list`;
    // One line under the title: the page script's upload note is in the import dialog too.
    for (const note of main.querySelectorAll(".page-table-panel .panel-heading .panel-subtitle")) if (/bulk upload/i.test(note.textContent)) note.remove();
    const subtitle = main.querySelector(".page-table-panel .panel-heading p.panel-subtitle");
    if (subtitle) subtitle.textContent = list.page === "Orders" ? "Newest first · the last month unless you choose other dates · updates live" : "Newest first · updates live";
    main.querySelector(".merchant-record-filters")?.remove();
    const search = $("tableSearch");
    if (search) {
      // A fresh box: the page script's own handler would hide rows the server has matched.
      const box = search.cloneNode(false);
      box.placeholder = "Search ID, reference, phone, name";
      box.style.width = "min(300px, 100%)";
      box.value = list.filters.q;
      search.replaceWith(box);
      // The filters get their own row, so the search box and the columns keep their width.
      main.querySelector(".page-table-panel .panel-heading")?.insertAdjacentHTML("afterend", filterBar(list));
    }
    if (!$("dfMerchantListCss"))
      document.head.insertAdjacentHTML("beforeend", `<style id="dfMerchantListCss">.page-table-panel>.merchant-record-filters{display:flex;flex-wrap:wrap;gap:10px;align-items:end;padding:0 18px 14px}.heading-actions{flex-wrap:wrap;justify-content:flex-end}.heading-actions .button{white-space:nowrap}</style>`);
    const download = $("merchantDownloadOrders");
    if (download) download.lastChild.textContent = " Export";
    const format = $("merchantPrintFormat");
    if (format) format.innerHTML = printOptions();
    // Returns belong with every order; each redraw rebuilds the heading, so the button is added here.
    const actions = main.querySelector(".page-heading .heading-actions");
    if (list.page === "New orders") $("dffReturns")?.remove();
    else if (actions && !$("dffReturns")) actions.insertAdjacentHTML("afterbegin", `<button class="button" id="dffReturns">${icon("box")} Returns (RTO)</button>`);
    main.querySelector(".metrics")?.remove();
    const footer = main.querySelector(".page-table-panel .table-footer");
    if (footer) footer.innerHTML = pager(list);
    const body = $("tableBody");
    // Where it's going: the old Shipments page's column, after the recipient.
    main.querySelector(".page-table-panel thead tr th:nth-child(3)")?.insertAdjacentHTML("afterend", "<th>DESTINATION</th>");
    for (const row of body?.querySelectorAll("tr[data-merchant-record-id]") || []) {
      const delivery = S().listed.get(row.dataset.merchantRecordId)?.delivery;
      row.cells[2]?.insertAdjacentHTML("afterend", `<td>${esc([delivery?.zone, delivery?.district].filter(Boolean).join(", ") || "—")}</td>`);
    }
    if (body && !body.querySelector("tr[data-merchant-record-id]")) {
      const columns = main.querySelectorAll(".page-table-panel thead th").length || 6;
      const text = !list.loaded ? "Loading…" : list.error ? DF.describe(list.error) : isFiltered(list) ? `No ${noun()}s match these filters.` : list.page === "New orders" ? `No new ${noun()}s. Create one or import a file.` : doc() ? "No delivery requests yet. Create one with “New delivery request”." : "No orders yet. Create your first order or import a batch.";
      body.innerHTML = `<tr class="df-empty"><td colspan="${columns}" class="empty-state">${esc(text)}</td></tr>`;
    }
    for (const id of ticked) {
      const box = document.querySelector(`#tableBody [data-merchant-select="${CSS.escape(id)}"]`);
      if (box) box.checked = true;
    }
    window.scrollTo(0, scroll);
    if (focus && $(focus)) {
      $(focus).focus();
      if (caret !== null) $(focus).setSelectionRange?.(caret, caret);
    }
  }

  function setFilter(list, key, value, delay = 0) {
    if (list.filters[key] === value) return;
    list.filters[key] = value;
    list.no = 1;
    clearTimeout(timer);
    timer = setTimeout(() => void load(list), delay);
  }

  const ticked = () => [...document.querySelectorAll("#tableBody [data-merchant-select]:checked")].map(box => box.dataset.merchantSelect);

  /** The ticked rows, else every matching order (up to the PDF limit). */
  async function printIds(list) {
    const chosen = ticked();
    if (chosen.length) return chosen;
    const ids = [];
    for (let no = 1; ids.length < PRINT_CAP; no++) {
      const params = query(list);
      params.set("limit", "200");
      params.set("page", String(no));
      const answer = await DF.api(`/parcels?${params}${q("&")}`);
      ids.push(...answer.items.map(p => p.trackingId));
      if (no >= answer.pages) break;
    }
    return ids.slice(0, PRINT_CAP);
  }

  async function print(list, button) {
    const format = $("merchantPrintFormat").value;
    const ids = await printIds(list);
    if (!ids.length) return void window.showToast(`There are no ${noun()}s to print. Change the filters.`);
    await window.DFPrint.format(format, ids, { title: doc() ? "Consignment list" : "Order list", button });
  }

  /** Every matching order (or the ticked rows) as Excel, written by the server. */
  async function exportList(list) {
    const chosen = ticked();
    if (!chosen.length && !list.total) return void window.showToast(`There are no ${noun()}s to export. Change the dates or filters.`);
    const params = query(list);
    if (chosen.length) params.set("trackingIds", chosen.join(","));
    const response = await DF.apiRaw(`/merchants/me/parcels/export?${params}${q("&")}`);
    const name = (response.headers.get("content-disposition") || "").match(/filename="?([^";]+)"?/)?.[1] || "orders.xlsx";
    const url = URL.createObjectURL(await response.blob());
    const link = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    const rows = Number(response.headers.get("x-row-count"));
    const matched = Number(response.headers.get("x-matched"));
    window.showToast(rows < matched ? `Exported the newest ${fmt(rows)} of ${fmt(matched)} (the limit for one file). Use a shorter date range for the rest.` : `${fmt(rows)} ${noun()}${rows === 1 ? "" : "s"} exported to Excel.`);
  }

  const FILTERS = { merchantStatusFilter: "status", merchantDateField: "dateField", merchantContentsFilter: "contents", merchantPaymentFilter: "payment", merchantDistrictFilter: "district", merchantBranchFilter: "branch", merchantDateFrom: "from", merchantDateTo: "to" };

  window.addEventListener("input", event => {
    if (active() && event.target.id === "tableSearch") setFilter(current, "q", event.target.value, 350);
  });
  window.addEventListener("change", event => {
    if (!active()) return;
    const t = event.target;
    if (t.id === "merchantPageSize") {
      current.size = Number(t.value);
      current.no = 1;
      return void load(current);
    }
    const key = FILTERS[t.id];
    if (!key) return;
    if (key === "from" || key === "to") {
      const from = key === "from" ? t.value : current.filters.from;
      const to = key === "to" ? t.value : current.filters.to;
      if (from && to && from > to) {
        t.value = current.filters[key];
        return void window.showToast("The From date can't be after the To date.");
      }
    }
    setFilter(current, key, t.value);
  });
  window.addEventListener(
    "click",
    event => {
      if (!active() || !(event.target instanceof Element)) return;
      const hit = selector => event.target.closest(selector);
      const fail = error => window.showToast(DF.describe(error));
      let el;
      if ((el = hit("[data-df-list-page]"))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (el.disabled) return;
        current.no = Number(el.dataset.dfListPage);
        return void DF.busy(el, () => load(current)).then(() => $("mainContent").querySelector(".page-table-panel")?.scrollIntoView({ block: "start", behavior: "smooth" }));
      }
      if (hit("#merchantClearFilters")) {
        event.preventDefault();
        current.filters = defaults(current.page);
        current.no = 1;
        return void load(current);
      }
      if ((el = hit("#merchantDownloadOrders"))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return void DF.busy(el, () => exportList(current), "Exporting…").catch(fail);
      }
      if ((el = hit("#merchantPrint"))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return void DF.busy(el, () => print(current, el), "Preparing…").catch(fail);
      }
    },
    true,
  );

  // Rows here are filtered by the server only.
  const baseFilters = window.applyMerchantOrderFilters;
  window.applyMerchantOrderFilters = function () {
    if (!active()) baseFilters();
  };

  const base = window.renderPage;
  window.renderPage = function (page) {
    if (page === "Shipments") page = "Orders"; // the old page and its links
    const list = lists[page];
    if (!list || P().locked?.()) {
      current = null;
      return base(page);
    }
    // A live refresh of the page on screen: only what changed is redrawn.
    if (current === list && S().page === page && list.loaded) return void load(list, { soft: true });
    current = list;
    draw(list);
    void load(list, { soft: list.loaded });
  };

  window.DFMerchantOrders = { active, titleOf };
})();
