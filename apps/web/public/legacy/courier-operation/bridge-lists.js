/*
 * Courier Operations: server-paged parcel lists, the "my hub" scope, stage counts and bulk
 * Accept & assign (UI only; the API, its permissions and lifecycle rules are unchanged).
 *
 *   Lists          Ops.lists.main(id, cfg) (the page's own shipment table, its search and filters) and
 *                  Ops.lists.panel(id, cfg, …) (a stage table with its own search). About 100 rows a
 *                  page from GET /parcels (cursor paging: "Load more"); search, status, dates, merchant,
 *                  service line and stage are applied by the server (GET /parcels ?q &status &incomplete
 *                  &from &to &merchantId &line &stage &forHubIds &hubId). Rows use the page's markup
 *                  (shipmentRows) and actions; live parcel events patch the affected rows
 *                  (Ops.lists.patch) instead of redrawing the page.
 *   Scope          Hub operators see "My hub" by default (GET /parcels ?forHubIds=their hubs) with a
 *                  switch to "All hubs" (Ops.scope); counts follow the same scope.
 *   Stage counts   GET /ops/stage-counts → Ops.stageCountsData; any [data-count-key="stages.pickup"]
 *                  element shows its number and updates when the counts reload.
 *   Bulk accept    New orders: tick rows → "Accept & assign (N)" → one rider → one
 *                  POST /parcels/:id/assign-pickup per order (the row's own action), with progress and
 *                  the result.
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops) return;
  const $ = id => document.getElementById(id);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = Ops.esc;
  const PAGE = 100;
  const CLOSED = ["DELIVERED", "PICKUP_CANCELLED", "RETURNED"];
  const AT_RISK = ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED", "PICKED_UP", "AT_HUB", "READY_FOR_COLLECTION", "ASSIGNED", "IN_TRANSIT", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "RETURN_SCHEDULED"];

  // ───────────── scope: my hub / all hubs ─────────────

  const SCOPE_KEY = "pairaexpress-ops-scope";
  let scopeValue = "mine";
  try {
    if (localStorage.getItem(SCOPE_KEY) === "all") scopeValue = "all";
  } catch {}
  Ops.scope = {
    /** People who work at hubs (hub operators) can switch between their hub and the whole network. */
    available: () => !!Ops.me?.hubIds?.length,
    value: () => scopeValue,
    hubIds: () => (Ops.me?.hubIds?.length && scopeValue !== "all" ? Ops.me.hubIds : null),
    set(value) {
      scopeValue = value === "all" ? "all" : "mine";
      try {
        localStorage.setItem(SCOPE_KEY, scopeValue);
      } catch {}
      for (const list of lists.values()) list.stale = true;
      void Ops.loadStageCounts();
      Ops.rerender(true);
    },
    control() {
      if (!Ops.scope.available()) return "";
      const mine = Ops.me.hubIds.length === 1 ? "My hub" : "My hubs";
      return `<label class="subcell" style="display:inline-flex;gap:6px;align-items:center;margin:0">Show <select class="select-small" data-ops-scope aria-label="Which hubs' parcels to show"><option value="mine"${scopeValue === "mine" ? " selected" : ""}>${mine}</option><option value="all"${scopeValue === "all" ? " selected" : ""}>All hubs</option></select></label>`;
    },
  };
  window.addEventListener("change", event => {
    if (event.target.matches?.("[data-ops-scope]")) Ops.scope.set(event.target.value);
  });

  // ───────────── stage counts ─────────────

  const read = (data, key) => key.split(".").reduce((v, k) => (v == null ? v : v[k]), data);
  Ops.countValue = key => read(Ops.stageCountsData, key);
  /** A number that follows the stage counts: <span data-count-key="detail.exceptions">. */
  Ops.countSpan = key => {
    const v = Ops.countValue(key);
    return `<span data-count-key="${esc(key)}">${v == null ? "—" : Ops.num(v)}</span>`;
  };
  Ops.onCounts = [];
  function applyCounts() {
    for (const el of qa("[data-count-key]")) {
      const v = Ops.countValue(el.dataset.countKey);
      if (v != null) el.textContent = Ops.num(v);
    }
    for (const fn of Ops.onCounts) {
      try {
        fn();
      } catch (error) {
        console.error(error);
      }
    }
  }
  Ops.loadStageCounts = async () => {
    const hubIds = Ops.scope.hubIds();
    try {
      Ops.stageCountsData = await DF.api(`/ops/stage-counts${hubIds ? `?forHubIds=${hubIds.join(",")}` : ""}`);
    } catch (error) {
      if (error?.status !== 403) console.error("Paira Express: stage counts could not be loaded", error);
      return;
    }
    applyCounts();
  };

  // ───────────── lists ─────────────

  /** Back at a hub after a failed delivery attempt (parcel-stages.ts BACK_AFTER_FAILURE). */
  const backAfterFailure = p => ["AT_HUB", "READY_FOR_COLLECTION"].includes(p.status) && Number(p.failedAttempts) > 0;
  const lineOf = p => (!p.merchant ? "CUSTOMER" : p.merchant.type === "BANKING_FINANCIAL" ? "BANKING_FINANCIAL" : "ECOMMERCE");
  /** The browser's mirror of the API's stages (apps/api/src/modules/parcels/parcel-stages.ts), for live patches. */
  const STAGE = {
    new: p => p.status === "PENDING_CONFIRMATION",
    pickup_waiting: p => ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED"].includes(p.status) && !p.pickupRider,
    pickup: p => (["PICKUP_ASSIGNED", "PICKUP_CONFIRMED"].includes(p.status) && !!p.pickupRider) || p.status === "PICKED_UP",
    hub: p => ["AT_HUB", "READY_FOR_COLLECTION"].includes(p.status),
    transfers: p => p.status === "IN_TRANSIT",
    delivery_waiting: p => p.status === "AT_HUB",
    delivery: p => ["ASSIGNED", "OUT_FOR_DELIVERY"].includes(p.status),
    exceptions: p => p.status === "EXCEPTION",
    failed: p => p.status === "RETRY_SCHEDULED" || backAfterFailure(p),
    needs_info: p => !!p.incomplete && !CLOSED.includes(p.status),
    sla_risk: p => AT_RISK.includes(p.status) && !!p.estimatedDeliveryAt && new Date(p.estimatedDeliveryAt).getTime() < Date.now(),
    problems: p => ["EXCEPTION", "RETRY_SCHEDULED"].includes(p.status) || backAfterFailure(p) || (!!p.incomplete && !CLOSED.includes(p.status)),
    returns: p => p.status === "RETURN_SCHEDULED",
  };
  const norm = v => String(v || "").toLowerCase().replace(/_/g, " ").trim();

  const lists = new Map();
  /**
   * cfg: { params() → fixed query ({ stage, line, … }), empty (text when nothing is there), noun,
   *        limit (rows per page), more (false: no "Load more"), bulkAccept (New orders) }
   */
  function define(id, cfg) {
    let list = lists.get(id);
    if (!list) {
      list = { id, ids: [], cursor: null, key: null, loading: false, error: null, stale: true, seq: 0, filters: {}, pending: false, timer: null };
      lists.set(id, list);
    }
    list.cfg = cfg;
    return list;
  }
  const hostOf = list => document.querySelector(`#mainContent [data-list="${CSS.escape(list.id)}"]`);
  const visibleLists = () => [...lists.values()].filter(hostOf);
  const pageSize = list => list.cfg.limit || PAGE;

  /** The query for GET /parcels (without the cursor). */
  function query(list) {
    const params = new URLSearchParams({ limit: String(pageSize(list)) });
    const fixed = list.cfg.params?.() || {};
    const f = list.filters;
    for (const [k, v] of Object.entries(fixed)) if (v != null && v !== "") params.set(k, String(v));
    if (f.q && f.q.trim().length >= 2) params.set("q", f.q.trim());
    if (f.status === "Needs info") params.set("incomplete", "true");
    else if (f.status) params.set("status", f.status);
    if (f.from) params.set("from", new Date(`${f.from}T00:00:00`).toISOString());
    if (f.to) params.set("to", new Date(`${f.to}T23:59:59.999`).toISOString());
    if (f.line && !fixed.line) params.set("line", f.line);
    if (f.merchantId) params.set("merchantId", f.merchantId);
    if (f.hubId) params.set("hubId", f.hubId);
    if (f.failedBefore) params.set("failedBefore", f.failedBefore);
    const hubs = list.cfg.scoped === false ? null : Ops.scope.hubIds();
    if (hubs && !f.hubId) params.set("forHubIds", hubs.join(","));
    return params;
  }
  const filtered = list => Object.values(list.filters).some(Boolean);

  /**
   * Whether a parcel belongs in the list: false (no), true (yes) or null (the browser can't tell, e.g.
   * a search or "my hub": the server decides on the next load).
   */
  function fits(list, p) {
    const fixed = list.cfg.params?.() || {};
    const f = list.filters;
    if (fixed.stage && STAGE[fixed.stage] && !STAGE[fixed.stage](p)) return false;
    if (fixed.line && lineOf(p) !== fixed.line) return false;
    if (f.line && lineOf(p) !== f.line) return false;
    if (fixed.status && !String(fixed.status).split(",").includes(p.status)) return false;
    if (f.status === "Needs info" ? !p.incomplete : f.status && ![norm(p.status), norm(p.statusLabel)].includes(norm(f.status)) && !(norm(f.status) === "pending operations confirmation" && p.status === "PENDING_CONFIRMATION")) return false;
    if (f.merchantId && p.merchant?.id !== f.merchantId) return false;
    if (f.hubId && p.currentHub?.id !== f.hubId) return false;
    if (f.failedBefore && (Number(p.failedAttempts) > 0) !== (f.failedBefore === "true")) return false;
    if (f.from && Ops.dayKey(p.createdAt) < f.from) return false;
    if (f.to && Ops.dayKey(p.createdAt) > f.to) return false;
    const hubs = list.cfg.scoped !== false && !f.hubId ? Ops.scope.hubIds() : null;
    if (hubs) {
      // "My hub": a parcel held at another hub is not mine; held at, dropped off at or picked up by mine is.
      const mine = id => !!id && hubs.includes(id);
      const riderHub = p.pickupRider && (DF.state.riders || []).find(r => r.id === p.pickupRider.id)?.hub?.id;
      if (p.currentHub) {
        if (!mine(p.currentHub.id)) return false;
      } else if (!mine(p.dropOffHub?.id) && !mine(riderHub)) return null; // pickups by zone: the server decides
    }
    if (f.q) return null;
    return true;
  }

  async function load(list, { more = false, soft = false } = {}) {
    if (!Ops.ready) return;
    const params = query(list);
    const key = params.toString();
    if (more && list.cursor) params.set("cursor", list.cursor);
    const seq = ++list.seq;
    list.loading = true;
    list.pending = false;
    if (!soft) footer(list);
    if (!soft && !more && key !== list.key) {
      list.ids = [];
      list.cursor = null;
      list.key = key;
      paint(list);
    }
    const before = list.ids.slice();
    const versions = new Map(before.map(id => [id, Ops.apiParcel(id)?.updatedAt]));
    let changedRows = null;
    try {
      const page = await DF.api(`/parcels?${params}`);
      if (seq !== list.seq) return; // the filters changed meanwhile
      Ops.upsertParcels(page.items);
      if (soft) changedRows = page.items.filter(p => versions.has(p.trackingId) && versions.get(p.trackingId) !== p.updatedAt).map(p => p.trackingId);
      const fresh = page.items.map(p => p.trackingId);
      if (more) {
        list.ids = [...new Set([...list.ids, ...fresh])];
        list.cursor = page.nextCursor;
        list.loadedMore = true;
      } else if (soft && list.loadedMore && list.key === key) {
        // A live reload of the first page keeps the rows "Load more" added below it (minus those that left).
        const seen = new Set(fresh);
        list.ids = [...fresh, ...list.ids.filter(id => !seen.has(id) && fits(list, Ops.apiParcel(id) || {}) !== false)];
      } else {
        list.ids = fresh;
        list.cursor = page.nextCursor;
        list.loadedMore = false;
      }
      list.key = key;
      list.error = null;
      list.stale = false;
    } catch (error) {
      if (seq !== list.seq) return;
      list.error = error;
      if (!soft) showToast(DF.describe(error));
    } finally {
      if (seq === list.seq) list.loading = false;
    }
    if (seq !== list.seq) return;
    // A live reload that brought the same rows redraws only the rows that changed (an open menu stays open).
    if (soft && changedRows && !list.error && before.length === list.ids.length && before.every((id, i) => id === list.ids[i])) {
      const host = hostOf(list);
      for (const id of changedRows) {
        const tr = host?.querySelector(`tbody[data-list-body] tr[data-shipment-id="${CSS.escape(id)}"]`);
        const row = rowFor(id);
        if (!tr || !row) continue;
        if (tr.querySelector("[data-shipment-select]:checked")) row.querySelector("[data-shipment-select]").checked = true;
        tr.replaceWith(row);
      }
      footer(list);
      return;
    }
    paint(list);
  }

  function emptyText(list) {
    if (list.loading && !list.ids.length) return "Loading parcels…";
    if (list.error && !list.ids.length) return DF.describe(list.error);
    if (filtered(list)) return "No parcels match the search or filters.";
    return list.cfg.empty || "Nothing here right now.";
  }

  function footer(list) {
    const host = hostOf(list);
    if (!host) return;
    let foot = host.querySelector(":scope > .shipment-count");
    if (!foot) {
      host.insertAdjacentHTML("beforeend", `<div class="shipment-count" style="padding:11px 16px;border-top:1px solid var(--line);color:#98a2ae;font-size:12px"></div>`);
      foot = host.querySelector(":scope > .shipment-count");
    }
    const n = list.ids.length;
    const noun = list.cfg.noun || "parcel";
    const more = list.cursor && list.cfg.more !== false;
    const text = list.loading && !n ? "Loading…" : `Showing ${Ops.num(n)} ${noun}${n === 1 ? "" : "s"}${more ? " · more on the server" : ""} · updates live`;
    foot.innerHTML = `<span data-list-count>${esc(text)}</span>${more ? ` <button class="button button-sm" type="button" data-list-more="${esc(list.id)}"${list.loading ? " disabled" : ""}>${list.loading ? "Loading…" : `Load ${pageSize(list)} more`}</button>` : ""}`;
  }

  /** A row for one parcel, in the page's markup (decorated by bridge-parcel.js when inserted). */
  function rowFor(id) {
    const s = Ops.shipment(id);
    if (!s) return null;
    const template = document.createElement("template");
    template.innerHTML = shipmentRows([s]);
    return template.content.querySelector("tbody tr");
  }

  function paint(list) {
    const host = hostOf(list);
    if (!host) return;
    const rows = list.ids.map(id => Ops.shipment(id)).filter(Boolean);
    const checked = new Set(qa("[data-shipment-select]:checked", host).map(i => i.dataset.shipmentSelect));
    const html = shipmentRows(rows).replace('<tbody id="shipmentBody">', `<tbody id="shipmentBody" data-list-body="${esc(list.id)}">`);
    const scroll = host.querySelector(".table-scroll");
    if (scroll) scroll.outerHTML = html;
    else host.querySelector(".panel-heading").insertAdjacentHTML("afterend", html);
    const body = host.querySelector("tbody[data-list-body]");
    if (!rows.length) body.innerHTML = `<tr><td colspan="8" class="empty-state" data-list-empty>${esc(emptyText(list))}</td></tr>`;
    for (const id of checked) {
      const box = body.querySelector(`[data-shipment-select="${CSS.escape(id)}"]`);
      if (box) box.checked = true;
    }
    footer(list);
    bulkBar(list);
  }

  function mount(list) {
    const host = hostOf(list);
    if (!host) return;
    if (!Ops.ready) {
      paint(list);
      return;
    }
    const key = query(list).toString();
    const complete = list.ids.every(id => Ops.shipment(id));
    paint(list);
    if (list.stale || key !== list.key || !complete) void load(list, { soft: key === list.key && complete });
  }

  // ── the page's own shipment table (New orders, All parcels, Problems) ──

  const MAIN_INPUTS = { shipmentSearch: "q", statusFilter: "status", shipmentDateFrom: "from", shipmentDateTo: "to", lineFilter: "line", merchantFilter: "merchantId" };
  /** The parcel type filter (cfg.lines): GET /parcels ?line. Customer parcels have no merchant. */
  const LINES = [
    ["CUSTOMER", "Customer parcel"],
    ["ECOMMERCE", "E-commerce"],
    ["BANKING_FINANCIAL", "Banking & Financial"],
  ];

  function merchantOptions(list, select) {
    const line = list.filters.line || "";
    // Customer parcels have no merchant; for a merchant type, only that type's merchants.
    select.hidden = line === "CUSTOMER";
    const known = new Map();
    for (const m of Ops.cache.merchants?.value || []) if (!line || m.type === line) known.set(m.id, m.name);
    for (const id of list.ids) {
      const p = Ops.apiParcel(id);
      const m = p?.merchant;
      if (m && !known.has(m.id) && (!line || lineOf(p) === line)) known.set(m.id, m.name);
    }
    const chosen = list.filters.merchantId || "";
    if (chosen && !known.has(chosen)) known.set(chosen, list.merchantName || "Chosen merchant");
    select.innerHTML = `<option value="">All merchants</option>${[...known].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => `<option value="${esc(id)}"${id === chosen ? " selected" : ""}>${esc(name)}</option>`).join("")}`;
  }
  let merchantsAsked = false;
  function loadMerchantsOnce() {
    if (merchantsAsked || Ops.cache.merchants?.value) return;
    merchantsAsked = true;
    DF.api("/ops/merchants")
      .then(value => {
        Ops.cache.merchants = { value, at: Date.now(), loading: false };
        for (const list of visibleLists()) {
          const select = hostOf(list).querySelector("#merchantFilter");
          if (select && document.activeElement !== select) merchantOptions(list, select);
        }
      })
      .catch(() => undefined);
  }

  /** Takes over the page's shipment table: server-paged rows, server-side search and filters. */
  function main(id, cfg) {
    const body = $("shipmentBody");
    const host = body?.closest(".table-panel");
    if (!host) return null;
    const list = define(id, cfg);
    host.dataset.list = id;
    // Filters the server can't apply are dropped: the product / service filter and "status update date".
    $("productFilter")?.remove();
    $("shipmentDateField")?.closest("label")?.remove();
    const merchant = $("merchantFilter");
    if (cfg.lines && !$("lineFilter")) {
      const html = `<select class="select-small" id="lineFilter" aria-label="Filter by parcel type"><option value="">All parcel types</option>${LINES.map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join("")}</select>`;
      if (merchant) merchant.insertAdjacentHTML("beforebegin", html);
      else host.querySelector(".table-tools")?.insertAdjacentHTML("beforeend", html);
    }
    if (merchant) {
      if (cfg.merchants === false) merchant.remove();
      else {
        merchantOptions(list, merchant);
        DF.searchSelect?.(merchant, { label: "Merchants", placeholder: "Search merchants…" });
        loadMerchantsOnce();
      }
    }
    for (const [inputId, key] of Object.entries(MAIN_INPUTS)) {
      const el = $(inputId);
      if (!el || list.filters[key] == null) continue;
      if (el.tagName === "SELECT" && ![...el.options].some(o => o.value === list.filters[key])) continue;
      el.value = list.filters[key];
    }
    const tools = host.querySelector(".table-tools");
    if (tools && Ops.scope.available() && cfg.scoped !== false && !tools.querySelector("[data-ops-scope]")) tools.insertAdjacentHTML("afterbegin", Ops.scope.control());
    // A stray note below the table (the original pages' sample text) gives way to the footer.
    host.querySelectorAll(":scope > .empty-state").forEach(el => el.remove());
    mount(list);
    return list;
  }

  // ── a stage table of its own ──

  /** The markup of a stage table (insert it, then call Ops.lists.mount(id)). */
  function panel(id, cfg, { title, subtitle = "", tools = "", search = true }) {
    define(id, cfg);
    const list = lists.get(id);
    const searchBox = search
      ? `<input class="table-search" type="search" id="listSearch-${esc(id)}" data-list-search="${esc(id)}" placeholder="Search ID, phone, name" aria-label="Search ${esc(title)}" value="${esc(list.filters.q || "")}">`
      : "";
    const scope = cfg.scoped !== false ? Ops.scope.control() : "";
    return `<section class="panel table-panel" data-list="${esc(id)}" id="list-${esc(id)}" style="margin-top:14px"><div class="panel-heading"><div><h2 class="panel-title">${esc(title)}</h2>${subtitle ? `<p class="panel-subtitle">${esc(subtitle)}</p>` : ""}</div><div class="table-tools">${scope}${tools}${searchBox}</div></div><div class="table-scroll"></div></section>`;
  }

  // ── input: search, filters, Load more ──

  const listOfElement = el => {
    const host = el.closest?.("[data-list]");
    return host ? lists.get(host.dataset.list) : null;
  };
  function setFilter(list, key, value, delay = 0) {
    if ((list.filters[key] || "") === (value || "")) return;
    list.filters[key] = value || "";
    if (key === "merchantId") list.merchantName = value ? Ops.cache.merchants?.value?.find(m => m.id === value)?.name : "";
    if (key === "line") {
      // A merchant of another type (or any merchant, for customer parcels) no longer applies.
      const chosen = list.filters.merchantId && Ops.cache.merchants?.value?.find(m => m.id === list.filters.merchantId);
      if (list.filters.merchantId && value && (value === "CUSTOMER" || (chosen && chosen.type !== value))) list.filters.merchantId = "";
      const select = hostOf(list)?.querySelector("#merchantFilter");
      if (select) merchantOptions(list, select);
    }
    clearTimeout(list.timer);
    list.timer = setTimeout(() => void load(list), delay);
  }
  window.addEventListener("input", event => {
    const t = event.target;
    if (t.id === "shipmentSearch" || t.matches?.("[data-list-search]")) {
      const list = listOfElement(t);
      if (list) setFilter(list, "q", t.value, 350);
    }
  });
  window.addEventListener("change", event => {
    const t = event.target;
    const key = MAIN_INPUTS[t.id] || (t.matches?.("[data-list-hub]") ? "hubId" : t.matches?.("[data-list-failed]") ? "failedBefore" : null);
    if (!key || key === "q") return;
    const list = listOfElement(t);
    if (list) setFilter(list, key, t.value);
  });
  window.addEventListener(
    "click",
    event => {
      const more = event.target.closest?.("[data-list-more]");
      if (!more) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const list = lists.get(more.dataset.listMore);
      if (list && !list.loading) void load(list, { more: true });
    },
    true,
  );
  // "Select all" ticks the rows of its own table only (a page may show two stage tables).
  window.addEventListener(
    "change",
    event => {
      const all = event.target.closest?.("[data-shipment-select-all]");
      const body = all?.closest("table")?.querySelector("tbody[data-list-body]");
      if (!body) return;
      event.stopImmediatePropagation();
      body.querySelectorAll("tr:not([hidden]) [data-shipment-select]").forEach(box => (box.checked = all.checked));
      const list = lists.get(body.dataset.listBody);
      if (list) bulkBar(list);
    },
    true,
  );
  window.addEventListener("change", event => {
    if (!event.target.matches?.("[data-shipment-select]")) return;
    const list = listOfElement(event.target);
    if (list) bulkBar(list);
  });

  // The page's own client-side filter (01.js) would hide server results (a phone number isn't in the
  // row's text): list tables are filtered by the server only.
  const baseApply = applyShipmentFilters;
  applyShipmentFilters = function () {
    if (document.querySelector("#mainContent [data-list] tbody[data-list-body]")) return;
    baseApply();
  };

  // ── live patches ──

  const busyList = list => {
    const host = hostOf(list);
    if (!host) return false;
    if (host.querySelector("[data-shipment-select]:checked, details.df-more[open]")) return true;
    const active = document.activeElement;
    return !!active && host.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName) && active.type !== "checkbox";
  };
  function softReload(list) {
    if (busyList(list) || $("modalBackdrop")?.classList.contains("open")) return void (list.pending = true);
    clearTimeout(list.softTimer);
    list.softTimer = setTimeout(() => void load(list, { soft: true }), 600);
  }
  setInterval(() => {
    for (const list of visibleLists()) if (list.pending && !list.loading) softReload(list);
  }, 3000);

  /** Changed parcels (live events): their rows are redrawn, rows that left a list go, newcomers reload the first page. */
  function patch(parcels, created = new Set()) {
    for (const list of visibleLists()) {
      const host = hostOf(list);
      let reload = false;
      for (const p of parcels) {
        const id = p.trackingId;
        const at = list.ids.indexOf(id);
        const belongs = fits(list, p);
        const tr = host.querySelector(`tbody[data-list-body] tr[data-shipment-id="${CSS.escape(id)}"]`);
        if (at >= 0) {
          const ticked = !!tr?.querySelector("[data-shipment-select]:checked");
          if (belongs === false && !ticked) {
            list.ids.splice(at, 1);
            tr?.remove();
            continue;
          }
          const row = rowFor(id);
          if (tr && row) {
            if (ticked) row.querySelector("[data-shipment-select]").checked = true;
            tr.replaceWith(row);
          }
        } else if (!list.filters.q && (belongs === true || (belongs === null && created.has(id)))) reload = true;
      }
      if (!list.ids.length) paint(list);
      else footer(list);
      if (reload) softReload(list);
    }
  }

  /** Every tracking ID the list's server filter matches (up to `cap`), paging through GET /parcels. */
  async function matchingIds(list, cap) {
    const ids = [];
    let cursor = null;
    do {
      const params = query(list);
      params.set("limit", "200");
      if (cursor) params.set("cursor", cursor);
      const page = await DF.api(`/parcels?${params}`);
      ids.push(...page.items.map(p => p.trackingId));
      cursor = page.nextCursor;
    } while (cursor && ids.length < cap);
    return { ids: [...new Set(ids)].slice(0, cap), capped: ids.length > cap || !!cursor };
  }

  /**
   * What a print button prints: the ticked rows, else every parcel the table's search and filters
   * match on the server (not only the loaded pages), up to `cap` (the PDF limit; `capped` says so).
   */
  async function printIds(cap) {
    const sync = Ops.printIds?.() || { ids: [], ticked: false };
    if (sync.ticked) return { ...sync, capped: sync.ids.length > cap };
    const body = document.querySelector("#mainContent tbody[data-list-body]");
    const list = body && lists.get(body.dataset.listBody);
    if (!list) return { ...sync, capped: false };
    if (!list.cursor) return { ids: list.ids.slice(0, cap), ticked: false, capped: list.ids.length > cap };
    return { ...(await matchingIds(list, cap)), ticked: false };
  }

  Ops.lists = {
    define,
    printIds,
    main,
    panel,
    mount: id => lists.has(id) && mount(lists.get(id)),
    get: id => lists.get(id),
    patch,
    /** After an action: the next render reloads every list. */
    invalidate: () => lists.forEach(list => (list.stale = true)),
    /** Reloads the lists on screen (keeping what is shown until the rows arrive). */
    reloadVisible: () => visibleLists().forEach(list => softReload(list)),
    /** Parcels the lists on screen show (bridge-nav.js keeps only these in the browser). */
    shownIds: () => visibleLists().flatMap(list => list.ids),
    /** Forgets lists that are not on screen (a new view or tab). */
    forgetHidden: () => {
      for (const [id, list] of lists) if (!hostOf(list)) lists.delete(id);
    },
  };

  // ───────────── bulk Accept & assign (New orders) ─────────────

  const tickedIds = list => qa("tbody[data-list-body] [data-shipment-select]:checked", hostOf(list) || document.createElement("div")).map(b => b.dataset.shipmentSelect);
  function bulkBar(list) {
    if (!list.cfg.bulkAccept) return;
    const host = hostOf(list);
    if (!host || !Ops.can("dispatch")) return;
    let button = host.querySelector("#bulkAccept");
    if (!button) {
      const tools = host.querySelector(".table-tools") || host.querySelector(".panel-heading");
      tools.insertAdjacentHTML("afterbegin", `<button class="button button-sm button-primary" type="button" id="bulkAccept" data-bulk-accept="${esc(list.id)}" hidden>Accept & assign</button>`);
      button = host.querySelector("#bulkAccept");
    }
    const n = tickedIds(list).length;
    button.hidden = !n;
    button.style.display = n ? "" : "none"; // .button sets display, so [hidden] alone doesn't hide it
    button.textContent = `Accept & assign (${n})`;
  }

  window.addEventListener(
    "click",
    event => {
      const button = event.target.closest?.("[data-bulk-accept]");
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const list = lists.get(button.dataset.bulkAccept);
      if (list) openBulkAccept(list);
    },
    true,
  );

  function openBulkAccept(list) {
    if (!Ops.require("dispatch", "assign riders")) return;
    const parcels = tickedIds(list).map(Ops.apiParcel).filter(Boolean);
    const ready = parcels.filter(p => p.status === "PENDING_CONFIRMATION" && p.intake !== "DROP_OFF");
    const skipped = parcels.length - ready.length;
    if (!ready.length) return void showToast("None of the ticked orders can be accepted here: drop-offs are received at their hub.");
    const ui = Ops.ui;
    Ops.dialog("bulkAccept", {
      title: `Accept & assign · ${ready.length} order${ready.length === 1 ? "" : "s"}`,
      description: `Each order is accepted and given to the rider for pickup, one at a time: the same action as the row's "Accept & assign rider".${skipped ? ` ${skipped} ticked order${skipped === 1 ? " is" : "s are"} skipped (awaiting drop-off or no longer waiting).` : ""}`,
      submit: `Accept & assign ${ready.length}`,
      fields:
        ui.field("bulkRider", "Pickup rider", `<select id="bulkRider" required>${DF.state.riders?.length ? Ops.riderOptions() : `<option value="">No active riders</option>`}</select>`, true) +
        `<div class="field full"><p class="panel-subtitle" id="bulkProgress" aria-live="polite" style="margin:0">${esc(ready.map(p => p.trackingId).slice(0, 6).join(", "))}${ready.length > 6 ? ` and ${ready.length - 6} more` : ""}</p></div>`,
      context: { trackingIds: ready.map(p => p.trackingId), listId: list.id },
    });
  }

  Ops.submitters = Ops.submitters || {};
  Ops.submitters.bulkAccept = async button => {
    const rider = (DF.state.riders || []).find(r => r.id === $("bulkRider").value);
    if (!rider) throw new Error("Choose an active rider.");
    const ids = modalContext.trackingIds;
    const listId = modalContext.listId;
    const progress = $("bulkProgress");
    $("bulkRider").disabled = true;
    $("modalCancel").disabled = true;
    const failed = [];
    let done = 0;
    for (const [i, id] of ids.entries()) {
      progress.textContent = `Assigning ${i + 1} of ${ids.length}… ${done} done${failed.length ? `, ${failed.length} not assigned` : ""}`;
      button.textContent = `Assigning ${i + 1} / ${ids.length}`;
      try {
        await DF.api(`/parcels/${encodeURIComponent(id)}/assign-pickup`, { method: "POST", body: { riderId: rider.id } });
        done++;
      } catch (error) {
        failed.push({ id, message: DF.describe(error) });
      }
    }
    $("modalCancel").disabled = false;
    const summary = `${done} order${done === 1 ? "" : "s"} accepted and assigned to ${rider.code} · ${rider.name}${failed.length ? `; ${failed.length} not assigned` : ""}.`;
    $("modalDescription").textContent = summary;
    $("modalFields").innerHTML = `<div class="field full" id="bulkResult"><p class="panel-subtitle" style="margin:0 0 8px"><span class="status status-good">${esc(`${done} assigned`)}</span>${failed.length ? ` <span class="status status-bad">${esc(`${failed.length} not assigned`)}</span>` : ""}</p>${
      failed.length
        ? `<div class="table-scroll" style="max-height:240px;overflow:auto"><table><thead><tr><th>ORDER</th><th>WHY NOT</th></tr></thead><tbody>${failed.map(f => `<tr data-bulk-failed="${esc(f.id)}"><td class="tracking">${esc(f.id)}</td><td style="white-space:normal">${esc(f.message)}</td></tr>`).join("")}</tbody></table></div>`
        : ""
    }</div>`;
    $("modalSubmit").textContent = "Done";
    modalContext = { kind: "bulkAcceptDone" };
    showToast(summary);
    const list = lists.get(listId);
    if (list) {
      qa("[data-shipment-select]:checked, [data-shipment-select-all]", hostOf(list) || document.createElement("div")).forEach(box => (box.checked = false));
      bulkBar(list);
    }
    await Promise.all([Ops.loadOverview?.(), Ops.loadStageCounts()]).catch(() => undefined);
    if (list && hostOf(list)) void load(list, { soft: true });
  };
  Ops.submitters.bulkAcceptDone = async () => closeModal();
})();
