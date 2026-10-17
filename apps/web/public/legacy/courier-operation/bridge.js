/*
 * Courier Operations on the API, part 1: the parcel rows and parcel actions.
 *
 * - Parcel tables (New orders, All parcels, every stage, the Today feed, Hub desk "At my hub") are
 *   server-paged lists from GET /parcels (about 100 rows a page, "Load more", server-side search and
 *   filters; bridge-lists.js). The browser keeps only the parcels on screen (DF.parcels.cache, merged
 *   with Ops.upsertParcels); the page's sample shipments are dropped.
 * - Counters come from GET /ops/overview and GET /ops/stage-counts (computed in the database). Live
 *   updates arrive as parcel.created / parcel.updated events: changed parcels are re-fetched one by
 *   one and patch their rows and the counts (no page redraw); a slow safety refresh reloads the counts.
 * - Actions (assign, status, cancel, exceptions, corrections, notes) call the parcel endpoints; the
 *   API enforces roles and hub scope and its message is shown on refusal.
 *
 * bridge-pages.js adds the page-specific views (overview counters, dispatch, riders, hubs,
 * merchants, COD, analytics, settings) and bookings. Shared helpers live on window.DFOps.
 */
(() => {
  const DF = window.DF;
  const PARCELS_KEY = "deliveryfast-customer-parcels";
  const ROLE_LABEL = { SUPER_ADMIN: "Super admin", OPS_MANAGER: "Operations manager", HUB_OPERATOR: "Hub operator", FINANCE: "Finance", SUPPORT_AGENT: "Support agent" };
  const $ = id => document.getElementById(id);
  const esc = value => courierEscape(value);

  // ───────────── shared helpers (also used by bridge-pages.js) ─────────────

  const Ops = (window.DFOps = {
    overview: null,
    me: null,
    catalog: null,
    /** Stage counts (GET /ops/stage-counts) for the scope on screen; bridge-lists.js loads them. */
    stageCountsData: null,
    prepare: {},
    enhance: {},
    modals: {},
    cache: {},
  });

  Ops.esc = esc;
  Ops.money = n => `৳ ${Number(n || 0).toLocaleString("en-BD", { maximumFractionDigits: 2 })}`;
  Ops.num = n => Number(n || 0).toLocaleString("en-US");
  Ops.when = iso => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
  Ops.dayKey = iso => {
    const d = iso ? new Date(iso) : new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  Ops.ago = iso => {
    if (!iso) return "";
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 48 * 60) return `${Math.round(minutes / 60)} hr ago`;
    return `${Math.round(minutes / 1440)} days ago`;
  };
  Ops.page = () => {
    const text = $("breadcrumbPage").textContent;
    return text === "Live overview" ? "Overview" : text === "Hubs & zones" ? "Hubs" : text;
  };
  Ops.apiParcel = id => DF.parcels.byTrackingId(id);
  Ops.can = permission => !!Ops.me?.can?.[permission];
  Ops.roleName = () => ROLE_LABEL[DF.auth.user.roles.find(r => ROLE_LABEL[r])] || "Your role";
  /** Says why an action isn't available, before calling the API. */
  Ops.require = (permission, action) => {
    if (!Ops.me || Ops.can(permission)) return true;
    showToast(`${Ops.roleName()} accounts can't ${action}.`);
    return false;
  };
  Ops.hubById = id => DF.state.hubs.find(h => h.id === id);
  Ops.hubByName = name => DF.state.hubs.find(h => h.name.toLowerCase() === String(name || "").trim().toLowerCase());
  /** Hubs this person works at (hub operators), else null for the whole network. */
  Ops.myHubs = () => (Ops.me?.hubIds ? DF.state.hubs.filter(h => Ops.me.hubIds.includes(h.id)) : null);
  Ops.inMyHubs = hubId => !Ops.me?.hubIds || Ops.me.hubIds.includes(hubId);

  /** Asks which hub (a hub select in the console dialog), defaulting to the operator's own hub. Resolves the hub, or undefined. */
  Ops.pickHub = (question, hubs = DF.state.hubs, preferred) =>
    new Promise(resolve => {
      if (!hubs.length) return resolve(void showToast("No hubs are configured yet."));
      if (hubs.length === 1) return resolve(hubs[0]);
      let chosen;
      Ops.form({
        title: "Choose a hub",
        description: question,
        submit: "Continue",
        fields: [{ id: "hubId", label: "Hub", type: "select", required: true, value: preferred?.id || hubs[0].id, options: hubs.map(h => ({ value: h.id, label: h.code ? `${h.name} (${h.code})` : h.name })) }],
        onSubmit: async v => {
          chosen = hubs.find(h => h.id === v.hubId);
          return "";
        },
      });
      // Resolves when the dialog closes (chosen, or undefined when cancelled).
      const backdrop = $("modalBackdrop");
      const watch = new MutationObserver(() => {
        if (backdrop.classList.contains("open")) return;
        watch.disconnect();
        resolve(chosen);
      });
      watch.observe(backdrop, { attributes: true, attributeFilter: ["class"] });
    });

  /**
   * Cached background load: returns the last value at once and refreshes it when older than
   * maxAge; when new data arrives for the page on screen, that page re-renders.
   */
  Ops.lazy = (key, loader, maxAge = 30000) => {
    const entry = Ops.cache[key];
    if (entry && (entry.loading || Date.now() - entry.at < maxAge)) return entry.value;
    const page = Ops.rendering || Ops.page();
    Ops.cache[key] = { ...(entry || {}), loading: true, at: entry?.at || 0 };
    loader()
      .then(value => {
        const changed = JSON.stringify(value) !== JSON.stringify(entry?.value);
        Ops.cache[key] = { value, at: Date.now(), loading: false };
        if (changed && Ops.page() === page) Ops.rerender();
      })
      .catch(error => {
        Ops.cache[key] = { value: entry?.value, at: Date.now(), loading: false, error };
        if (Ops.page() === page) Ops.rerender();
        if (error?.status !== 403) console.error(`Delivery Fast: ${key} could not be loaded`, error);
      });
    return entry?.value;
  };
  Ops.lazyError = key => Ops.cache[key]?.error;
  Ops.invalidate = (...keys) => keys.forEach(k => Ops.cache[k] && (Ops.cache[k].at = 0));

  // ───────────── loading ─────────────

  async function loadOverview() {
    Ops.overview = await DF.api("/ops/overview");
    Ops.me = Ops.overview.me;
  }
  Ops.loadOverview = loadOverview;

  /**
   * After an action or a reconnect: counters, then the page on screen redrawn with its lists
   * reloaded from the server (bridge-lists.js). Nothing else is reloaded.
   */
  Ops.refresh = async () => {
    await Promise.all([loadOverview(), Ops.loadStageCounts?.()]);
    Ops.lists?.invalidate();
    Ops.rerender();
  };

  /** Called with the changed parcels after Ops.upsertParcels (the drawer repaints, counts follow). */
  Ops.onParcels = [];
  const shipmentIndex = new Map();

  /**
   * Merges parcels from the API into the browser's set (DF.parcels.cache) and the page's shipment
   * rows (`shipments`), without redrawing anything; returns them.
   */
  Ops.upsertParcels = items => {
    if (!items?.length) return [];
    const byId = new Map(DF.parcels.cache.map((p, i) => [p.trackingId, i]));
    for (const p of items) {
      const i = byId.get(p.trackingId);
      if (i === undefined) {
        byId.set(p.trackingId, DF.parcels.cache.length);
        DF.parcels.cache.push(p);
      } else DF.parcels.cache[i] = p;
      const row = toShipment(p);
      const known = shipmentIndex.get(p.trackingId);
      const at = known ? shipments.indexOf(known) : -1;
      if (at >= 0) shipments[at] = row;
      else shipments.push(row);
      shipmentIndex.set(p.trackingId, row);
    }
    for (const fn of Ops.onParcels) {
      try {
        fn(items);
      } catch (error) {
        console.error(error);
      }
    }
    return items;
  };

  /** Keeps only these parcels in the browser (the lists on screen and the open drawer). */
  Ops.keepParcels = keep => {
    const wanted = new Set(keep);
    DF.parcels.cache = DF.parcels.cache.filter(p => wanted.has(p.trackingId));
    syncShipments();
  };

  // ───────────── API parcels → the page's shipment rows ─────────────

  const lineOf = p => (!p.merchant ? "Customer parcels" : p.merchant.type === "BANKING_FINANCIAL" ? "Documents" : "E-commerce");
  function serviceOf(p, line) {
    if (line === "Customer parcels") return "Customer parcel";
    if (line === "Documents") return `Document ${p.serviceLevelLabel.toLowerCase()}`;
    return Number(p.codAmount) > 0 ? "Cash on delivery" : `${p.serviceLevelLabel} parcel`;
  }
  /** A drop-off booking waiting for the sender to bring it to the hub (never needs a pickup rider). */
  const awaitingDropOff = p => p.status === "PENDING_CONFIRMATION" && p.intake === "DROP_OFF";
  Ops.awaitingDropOff = awaitingDropOff;
  function riderOf(p) {
    if (awaitingDropOff(p)) return `Drop-off · ${p.dropOffHub?.name || "hub"}`;
    const pickup = p.pickupRider?.label;
    const delivery = p.deliveryRider?.label;
    switch (p.status) {
      case "PENDING_CONFIRMATION":
        return "Unassigned";
      case "PICKUP_ASSIGNED":
      case "PICKUP_CONFIRMED":
      case "PICKED_UP":
        return pickup || "Unassigned";
      case "AT_HUB":
      case "IN_TRANSIT":
        return delivery || "Unassigned";
      case "EXCEPTION":
        return delivery || pickup || "Unassigned";
      case "RETURN_SCHEDULED":
        return "Return to sender";
      case "RETURNED":
        return "Returned to sender";
      case "PICKUP_CANCELLED":
        return "—";
      default:
        return delivery || pickup || "Unassigned";
    }
  }
  function slaOf(p, rider) {
    const promised = p.estimatedDeliveryAt ? new Date(p.estimatedDeliveryAt).getTime() : null;
    switch (p.status) {
      case "DELIVERED":
        return promised && p.deliveredAt && new Date(p.deliveredAt).getTime() > promised ? "Late" : "Met";
      case "PICKUP_CANCELLED":
        return "Cancelled";
      case "RETURNED":
        return "Returned";
      case "RETURN_SCHEDULED":
        return "Return scheduled";
      case "EXCEPTION":
        return "At risk";
      case "PENDING_CONFIRMATION":
        return awaitingDropOff(p) ? "Awaiting drop-off" : "Awaiting review";
    }
    if (promised && promised < Date.now()) return "At risk";
    if (rider === "Unassigned") return "Assign now";
    if (p.status === "PICKUP_ASSIGNED" || p.status === "PICKUP_CONFIRMED") return "Pickup scheduled";
    return "On track";
  }
  function toShipment(p) {
    const line = lineOf(p);
    const rider = riderOf(p);
    return {
      id: p.trackingId,
      merchant: p.merchant?.name || p.sender.name,
      senderPhone: DF.localPhone(p.sender.phone),
      recipient: p.recipient.name,
      recipientPhone: DF.localPhone(p.recipient.phone),
      destination: p.delivery.label,
      service: serviceOf(p, line),
      serviceCategory: line,
      serviceLevel: p.serviceLevelLabel,
      created: Ops.when(p.createdAt),
      pickupDate: Ops.dayKey(p.createdAt),
      updatedAt: Ops.when(p.updatedAt),
      statusUpdatedAt: Ops.dayKey(p.updatedAt),
      rider,
      pickupRider: p.pickupRider?.label || "",
      status: p.statusLabel,
      sla: slaOf(p, rider),
      hub: p.currentHub?.name,
      deliveryFee: p.charges.total,
      codAmount: p.codAmount,
      codFee: p.charges.codFee,
      item: p.contents || "",
      documentType: line === "Documents" ? p.contents || "Business document" : undefined,
      weight: p.weightKg != null ? `${p.weightKg} kg` : "",
      pickupAddress: p.pickup.label,
      pickedUpAt: p.pickedUpAt ? Ops.when(p.pickedUpAt) : "",
      attempts: p.attemptCount,
      history: p.events.map(e => `${Ops.when(e.at)} · ${e.title}${e.location ? ` · ${e.location}` : ""}`),
      _api: p,
    };
  }
  Ops.toShipment = toShipment;

  /** Replaces the page's shipments (samples, demo CNs, stale rows) with the API's parcels. */
  function syncShipments() {
    shipments.splice(0, shipments.length, ...DF.parcels.cache.map(toShipment));
    shipmentIndex.clear();
    for (const row of shipments) shipmentIndex.set(row.id, row);
  }
  /** The page's row for a tracking ID (fast lookup). */
  Ops.shipment = id => shipmentIndex.get(id);
  // The original pages call this by name after storage changes.
  window.syncWebsiteCustomerParcels = syncShipments;

  // ───────────── rendering ─────────────

  const FILTER_IDS = ["shipmentSearch", "statusFilter", "shipmentDateField", "shipmentDateFrom", "shipmentDateTo", "merchantFilter", "productFilter", "hubSearch", "genericSearch"];
  let pendingRender = false;

  /** The person is typing, has rows selected or a dialog open: don't redraw under them. */
  function busy() {
    const active = document.activeElement;
    if (active && active !== document.body && $("mainContent").contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName) && active.type !== "checkbox") return true;
    if ($("modalBackdrop").classList.contains("open") || $("generatedCNDialog")?.open || $("courierHistoryBackdrop")) return true;
    // Ticked rows or an open "More" menu.
    return !!document.querySelector("#shipmentBody [data-shipment-select]:checked, #mainContent details.df-more[open]");
  }

  /** Re-renders the page on screen, keeping search and filter values. */
  Ops.rerender = (force = false) => {
    if (!force && busy()) return void (pendingRender = true);
    pendingRender = false;
    const values = Object.fromEntries(FILTER_IDS.map(id => [id, $(id)?.value]).filter(([, v]) => v));
    render(Ops.page());
    for (const [id, value] of Object.entries(values)) {
      const el = $(id);
      if (!el || (el.tagName === "SELECT" && ![...el.options].some(o => o.value === value))) continue;
      el.value = value;
    }
    if ($("shipmentBody") && Object.keys(values).length) applyShipmentFilters();
    for (const id of ["hubSearch", "genericSearch"]) if (values[id]) $(id)?.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const flushPending = () => setTimeout(() => pendingRender && Ops.rerender(), 50);
  document.addEventListener("focusout", flushPending);
  document.addEventListener("change", e => e.target.matches?.("[data-shipment-select],[data-shipment-select-all]") && flushPending());
  document.addEventListener("toggle", e => e.target.matches?.("details.df-more") && !e.target.open && flushPending(), true);

  /**
   * Pages the bridges add (Linehaul, CN stock, Reports…): Ops.pages[name] = { render() → HTML },
   * drawn in #mainContent with the console's own classes; Ops.enhance[name] still runs after.
   */
  Ops.pages = {};
  function renderAddedPage(page) {
    $("breadcrumbPage").textContent = page;
    document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.page === page));
    $("sidebar").classList.remove("open");
    $("mainContent").innerHTML = Ops.pages[page].render();
    attachTableSearch();
  }

  const baseRender = render;
  render = function (page) {
    if (page === "Hubs & zones") page = "Hubs";
    if (page === "Live overview") page = "Overview";
    Ops.rendering = page; // the breadcrumb still names the previous page until baseRender runs
    // A redraw of the page on screen (e.g. a live parcel update) keeps the field being typed or
    // scanned into: its text, caret and focus (the receive desk's scan box, searches…).
    const active = document.activeElement;
    const typing =
      page === Ops.page() && active?.id && $("mainContent").contains(active) && /^(INPUT|TEXTAREA)$/.test(active.tagName) && !/^(checkbox|radio|file)$/.test(active.type)
        ? { id: active.id, value: active.value, caret: active.selectionStart }
        : null;
    try {
      Ops.prepare[page]?.(page);
    } catch (error) {
      console.error(`Delivery Fast: ${page} data could not be prepared`, error);
    }
    if (Ops.pages[page]) renderAddedPage(page);
    else baseRender(page);
    try {
      Ops.enhance["*"]?.(page);
      Ops.enhance[page]?.(page);
    } catch (error) {
      console.error(`Delivery Fast: ${page} could not be updated`, error);
    }
    Ops.rendering = null;
    const again = typing && $(typing.id);
    if (again && again !== active && document.activeElement !== again) {
      if (again.value !== typing.value) again.value = typing.value;
      again.focus();
      try {
        again.setSelectionRange(typing.caret, typing.caret);
      } catch {}
    }
  };

  // ───────────── parcel rows ─────────────
  // The page's shipment table markup (01.js shipmentRows) without the status dropdowns (the next
  // action and the drawer cover those actions) and with condensed cells; the last column (the next
  // action, Details, More) stays pinned on the right while the table scrolls sideways.

  const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  shipmentRows = function (rows) {
    const body = rows
      .map(s => {
        const id = esc(s.id);
        const line = serviceCategory(s);
        const sub = [line, s.service, s.created].filter(Boolean).join(" · ");
        const customer = line === "Customer parcels" ? ` · Sender pays ৳${Number(s.deliveryFee) || 0}${Number(s.codAmount) ? ` · COD ৳${Number(s.codAmount)}` : ""}` : "";
        const merchant = s.merchant || "Merchant not set";
        const recipient = s.recipient || "Recipient not set";
        const destination = s.destination || "Address not set";
        const actions = [
          `<button class="button button-sm" data-track="${id}">History</button>`,
          `<button class="button button-sm" data-generated-edit="${id}">Edit details</button>`,
          line === "Customer parcels" && isPendingCustomerPickup(s)
            ? `<button class="button button-sm" data-customer-confirm="${id}">Accept & assign rider</button><button class="button button-sm" data-customer-cancel="${id}">Cancel request</button>`
            : "",
          s.status === "Exception" || s.sla === "At risk" ? ` <button class="button button-sm" data-exception="${id}">Review</button>` : "",
        ].join("");
        return `<tr data-shipment-id="${id}"><td><input type="checkbox" data-shipment-select="${id}" aria-label="Select ${id}"></td><td class="tracking">${id}<span class="subcell"><span title="${esc(sub + customer)}">${esc(cut(sub + customer, 64))}</span></span></td><td title="${esc(`${merchant} → ${recipient}`)}"><strong style="color:#455265;font-weight:600">${esc(cut(merchant, 30))}</strong><span class="subcell">${esc(cut(recipient, 30))}</span></td><td title="${esc(destination)}">${esc(cut(destination, 34))}</td><td title="${esc(s.rider)}">${esc(cut(String(s.rider || ""), 28))}</td><td>${statusPill(esc(s.status))}</td><td>${statusPill(esc(s.sla))}</td><td>${actions}</td></tr>`;
      })
      .join("");
    return `<div class="table-scroll"><table class="df-parcels"><thead><tr><th><input type="checkbox" data-shipment-select-all aria-label="Select visible shipments"></th><th>CN / TRACKING ID</th><th>MERCHANT / RECIPIENT</th><th>DESTINATION</th><th>RIDER</th><th>STATUS</th><th>SLA</th><th></th></tr></thead><tbody id="shipmentBody">${body}</tbody></table></div>`;
  };
  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="dfRowStyles">
.df-parcels th:last-child,.df-parcels td:last-child{position:sticky;right:0;z-index:1;background:#fff;box-shadow:-10px 0 10px -10px #1720332e}
.df-parcels th:last-child{background:#fafbfd}
.df-parcels tr:hover td:last-child{background:#fff}
.df-parcels td:first-child,.df-parcels th:first-child{width:34px}
.df-parcels td:last-child .df-row-actions{flex-wrap:nowrap}
.df-parcels td:last-child:has(details[open]){z-index:50}
</style>`,
  );

  const baseCloseModal = closeModal;
  closeModal = function () {
    baseCloseModal();
    flushPending();
  };

  // The parcel list changed (poll or after an action): rebuild rows, then redraw.
  window.addEventListener(
    "storage",
    event => {
      if (event.key !== PARCELS_KEY) return;
      event.stopImmediatePropagation();
      syncShipments();
      Ops.rerender();
    },
    true,
  );

  /** Runs an API action, refreshes the data and reports the outcome. */
  Ops.act = async (work, success) => {
    try {
      const result = await (typeof work === "function" ? work() : work);
      await Ops.refresh().catch(() => undefined);
      if (success) showToast(typeof success === "function" ? success(result) : success);
      return result;
    } catch (error) {
      showToast(DF.describe(error));
      await Ops.refresh().catch(() => undefined);
      return undefined;
    }
  };
  Ops.setStatus = (id, body, success) => {
    const parcel = Ops.apiParcel(id);
    return Ops.act(DF.api(`/parcels/${encodeURIComponent(id)}/status`, { method: "POST", body: { expectedVersion: parcel?.version, ...body } }), success);
  };

  // ───────────── rider assignment ─────────────

  const PICKUP_STAGE = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];
  const isPickupAssignment = p => PICKUP_STAGE.includes(p.status) || (p.status === "EXCEPTION" && !p.pickedUpAt && !p.currentHub);

  /** Active riders as <option>s: the operator's own hub first, online before offline. */
  function riderOptions() {
    const mine = new Set((Ops.me?.hubIds || []).filter(Boolean));
    const rank = r => (mine.size && !mine.has(r.hub?.id) ? 2 : 0) + (r.status === "ONLINE" ? 0 : 1);
    return [...DF.state.riders]
      .sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code))
      .map(r => {
        const state = r.status === "ONLINE" ? "" : ` (${r.status.toLowerCase().replace("_", " ")})`;
        const load = r.openTasks ? ` · ${r.openTasks} open` : "";
        return `<option value="${r.id}">${esc(`${r.code} · ${r.name} · ${r.hub?.name || r.zone || "No hub"}${load}`)}${state}</option>`;
      })
      .join("");
  }

  Ops.riderOptions = riderOptions;

  function fillAssignDialog(shipmentId) {
    const riders = $("assignRider");
    if (riders) riders.innerHTML = DF.state.riders.length ? riderOptions() : `<option value="">No active riders</option>`;
    const select = $("assignShipment");
    if (!select) return;
    select.querySelector('option[value="PP-28512"]')?.remove(); // placeholder in the original dialog
    const parcel = shipmentId && Ops.apiParcel(shipmentId);
    if (parcel && ![...select.options].some(o => o.value === shipmentId))
      select.insertAdjacentHTML("afterbegin", `<option value="${esc(shipmentId)}">${esc(`${shipmentId} · ${parcel.delivery.label}`)}</option>`);
    if (!select.options.length) select.innerHTML = `<option value="">No shipments are waiting for a rider</option>`;
    if (parcel) select.value = shipmentId;
  }

  async function refreshRiders() {
    if (!Ops.can("readRiders")) return;
    try {
      DF.state.riders = await DF.api("/riders?active=true");
      if ($("modalBackdrop").classList.contains("open") && modalContext.kind === "assign") {
        const chosen = $("assignRider")?.value;
        $("assignRider").innerHTML = riderOptions();
        if (chosen) $("assignRider").value = chosen;
      }
    } catch {}
  }

  function fillExceptionDialog(id) {
    const parcel = Ops.apiParcel(id);
    if (!parcel) return;
    const last = [...parcel.events].reverse().find(e => !e.internal) || parcel.events.at(-1);
    $("modalDescription").textContent = `${parcel.statusLabel} · ${parcel.recipient.name || "Recipient not set"}, ${parcel.delivery.zone || "destination not set"}${last ? ` · Last update: ${last.title}${last.description ? ` — ${last.description}` : ""}` : ""}`;
  }

  const previousOpenModal = openModal;
  openModal = function (kind, shipmentId) {
    if (Ops.modals[kind]) return Ops.modals[kind](shipmentId);
    previousOpenModal(kind, shipmentId);
    if (kind === "assign") {
      fillAssignDialog(shipmentId);
      void refreshRiders();
    }
    if (kind === "exception") fillExceptionDialog(shipmentId);
  };

  window.addEventListener(
    "submit",
    event => {
      if (event.target.id !== "modalForm") return;
      const kind = modalContext.kind;
      if (kind === "assign") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const id = $("assignShipment").value;
        const parcel = Ops.apiParcel(id);
        if (!parcel) return void showToast("Choose a shipment to assign.");
        if (!Ops.require("dispatch", "assign riders")) return;
        const riderId = $("assignRider").value;
        const rider = DF.state.riders.find(r => r.id === riderId);
        if (!rider) return void showToast("Choose an active rider.");
        const priority = $("assignPriority")?.value;
        const pickup = isPickupAssignment(parcel);
        closeModal();
        void Ops.act(
          DF.api(`/parcels/${encodeURIComponent(id)}/${pickup ? "assign-pickup" : "assign-delivery"}`, {
            method: "POST",
            body: { riderId, note: priority && priority !== "Standard" ? `Dispatch priority: ${priority}` : undefined },
          }),
          `${id} assigned to ${rider.code} · ${rider.name} for ${pickup ? "pickup" : "delivery"}.`,
        );
      }
      if (kind === "exception") {
        const id = modalContext.shipmentId;
        const parcel = Ops.apiParcel(id);
        if (!parcel) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!Ops.require("dispatch", "resolve exceptions")) return;
        const resolution = $("resolution").value;
        const note = [resolution, $("resolutionNote")?.value.trim()].filter(Boolean).join(" — ");
        closeModal();
        resolveException(parcel, resolution, note);
      }
    },
    true,
  );

  function resolveException(parcel, resolution, note) {
    const id = parcel.trackingId;
    if (/contact recipient/i.test(resolution))
      return void Ops.act(DF.api(`/parcels/${encodeURIComponent(id)}/notes`, { method: "POST", body: { note } }), `${id}: follow-up recorded on the parcel timeline.`);
    if (/return/i.test(resolution)) return void Ops.setStatus(id, { status: "RETURN_SCHEDULED", note }, `${id}: return to sender scheduled.`);
    if (/hub/i.test(resolution)) {
      const known = parcel.currentHub && Ops.hubById(parcel.currentHub.id);
      return void Promise.resolve(known || Ops.pickHub(`Which hub should receive ${id}?`, Ops.myHubs() || DF.state.hubs)).then(hub => {
        if (hub) void Ops.setStatus(id, { status: "AT_HUB", hubId: hub.id, note }, `${id}: routed to ${hub.name}.`);
      });
    }
    // Another attempt: a parcel waiting at a hub needs a delivery rider first.
    if (["AT_HUB", "IN_TRANSIT"].includes(parcel.status)) {
      showToast(`Assign a delivery rider for the next attempt on ${id}.`);
      return void openModal("assign", id);
    }
    void Ops.setStatus(id, { status: "RETRY_SCHEDULED", note }, `${id}: another delivery attempt scheduled.`);
  }
  Ops.resolveException = resolveException;

  // ───────────── customer parcel controls in the shipment rows ─────────────

  window.addEventListener(
    "click",
    event => {
      const cancel = event.target.closest("[data-customer-cancel]");
      if (!cancel || !Ops.apiParcel(cancel.dataset.customerCancel)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!Ops.require("dispatch", "cancel pickup requests")) return;
      const id = cancel.dataset.customerCancel;
      void Ops.prompt({ title: `Cancel pickup request ${id}?`, message: "The customer is told the pickup is cancelled. This can't be undone.", label: "Reason for the customer", multiline: true, maxLength: 300, confirm: "Cancel pickup", cancel: "Keep it", danger: true }).then(reason => {
        if (reason === null) return;
        void Ops.act(DF.api(`/parcels/${encodeURIComponent(id)}/cancel`, { method: "POST", body: { reason: reason || undefined } }), `${id}: pickup request cancelled.`);
      });
    },
    true,
  );

  // ───────────── tracking history ─────────────
  // "Track" opens the parcel drawer (bridge-parcel.js): its tracking history, notes, messages and actions
  // replace the separate history dialog.

  const baseHistory = courierTrackingHistory;
  courierTrackingHistory = function (id) {
    if (!Ops.apiParcel(id) || !Ops.drawer) return baseHistory(id);
    Ops.drawer.open(id);
  };

  // ───────────── corrections to a booked parcel ─────────────

  function openParcelEditor(parcel) {
    Ops.form({
      title: `Edit parcel · ${parcel.trackingId}`,
      description: `${parcel.statusLabel} · ${parcel.merchant?.name || parcel.sender.name} → ${parcel.delivery.zone}, ${parcel.delivery.district}. Price-affecting details (zones, weight, COD) can't change after booking. Every change is recorded on the parcel's timeline.`,
      submit: "Save parcel details",
      wide: true,
      fields: [
        { id: "recipient", label: "Recipient name", value: parcel.recipient.name, required: true, maxLength: 120 },
        { id: "recipientPhone", label: "Recipient phone", type: "phone", value: DF.localPhone(parcel.recipient.phone), required: true },
        { id: "street", label: "Street address", value: parcel.delivery.street, required: true, maxLength: 200 },
        { id: "area", label: "Area / landmark", value: parcel.delivery.area, maxLength: 120 },
        { id: "instructions", label: "Delivery instructions", value: parcel.instructions || "", maxLength: 500, full: true },
        { id: "note", label: "Reason for the change", maxLength: 500, full: true, placeholder: "e.g. Recipient confirmed a new phone number" },
      ],
      validate: { recipient: v => (v.length < 2 ? "At least 2 characters" : "") },
      onSubmit: async v => {
        const fresh = Ops.apiParcel(parcel.trackingId) || parcel;
        const body = {
          recipient: { name: v.recipient, phone: v.recipientPhone },
          delivery: { street: v.street, area: v.area },
          instructions: v.instructions,
          note: v.note || undefined,
          expectedVersion: fresh.version,
        };
        await DF.api(`/parcels/${encodeURIComponent(parcel.trackingId)}`, { method: "PATCH", body });
        await Ops.refresh().catch(() => undefined);
        return `${parcel.trackingId} details saved.`;
      },
    });
  }

  window.addEventListener(
    "click",
    event => {
      const edit = event.target.closest("[data-generated-edit]");
      if (!edit) return;
      const parcel = Ops.apiParcel(edit.dataset.generatedEdit);
      if (!parcel) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!Ops.require("dispatch", "edit parcel details")) return;
      if (["DELIVERED", "PICKUP_CANCELLED", "RETURNED"].includes(parcel.status)) return void showToast(`${parcel.trackingId} is ${parcel.statusLabel.toLowerCase()}; its details can no longer change.`);
      // Imported orders with details missing ("Needs info") are completed (and re-priced) by shared/importer.js.
      if (parcel.incomplete && window.DFImport) return void window.DFImport.complete(parcel, { forOps: true, onDone: () => Ops.refresh().catch(() => undefined) });
      openParcelEditor(parcel);
    },
    true,
  );

  // ───────────── consignment numbers ─────────────
  // "Generate CNs" opens CN stock (pre-allocated batches, bridge-cn.js); "Print labels" (the
  // original "Print generated CNs" button) is handled by bridge-intake.js.

  window.addEventListener(
    "click",
    event => {
      if (event.target.closest("#generateCNs")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        // Pre-printed consignment numbers are allocated in batches on the CN stock page.
        render("CN stock");
      }
    },
    true,
  );

  // ───────────── notifications ─────────────
  // (The top-bar search is bridge-parcel.js: tracking ID, CN or phone → the parcel drawer.)

  // The bell lists real alerts (bridge-desk.js).

  // ───────────── live updates ─────────────
  // A changed parcel is re-fetched on its own and patches its rows in the lists on screen
  // (bridge-lists.js) and the drawer; many changes at once (a truck departing) reload the lists.
  // Counters follow a little later. A reconnect reloads counters and lists; a slow safety poll
  // reloads the counters only.

  const changedIds = new Set();
  const createdIds = new Set();
  let liveTimer = null;
  let countersTimer = null;
  async function applyChanges() {
    const ids = [...changedIds];
    const created = new Set(createdIds);
    changedIds.clear();
    createdIds.clear();
    if (ids.length > 25) return void Ops.lists?.reloadVisible();
    const results = await Promise.allSettled(ids.map(id => DF.api(`/parcels/${encodeURIComponent(id)}`)));
    const fresh = results.filter(r => r.status === "fulfilled").map(r => r.value);
    if (!fresh.length) return;
    Ops.upsertParcels(fresh);
    Ops.lists?.patch(fresh, created);
  }
  const refreshCounters = async () => {
    await Promise.all([loadOverview(), Ops.loadStageCounts?.()]);
    // Today shows the overview's figures and alerts: redraw it (no long tables there).
    if (Ops.page() === "Overview") Ops.rerender();
  };
  const onParcel = (data, type) => {
    if (!data?.id) return;
    changedIds.add(data.id);
    if (type === "parcel.created") createdIds.add(data.id);
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => void applyChanges().catch(() => undefined), 500);
    clearTimeout(countersTimer);
    countersTimer = setTimeout(() => void refreshCounters().catch(() => undefined), 2500);
  };
  Ops.liveParcels = () => {
    DF.events.on("parcel.updated", onParcel);
    DF.events.on("parcel.created", onParcel);
    // After a gap in the event stream anything may have changed: counters and the lists on screen.
    DF.events.on("reconnect", () => {
      if (document.visibilityState !== "visible") return;
      void refreshCounters().catch(() => undefined);
      Ops.lists?.reloadVisible();
    });
    // Slow safety refresh in case an event was missed: the counts only.
    DF.poll(refreshCounters, 180_000);
  };

  // ───────────── start ─────────────

  DF.showSignedInUser(Ops.roleName());
  // Sample data the API replaces: shown empty until real data loads.
  for (const page of ["Riders", "Merchants", "COD & finance", "Analytics", "Settings"]) if (genericPages[page]) genericPages[page].rows = [];
  hubTransferEvents.length = 0;
  riderReportState.from = riderReportState.to = Ops.dayKey();
  syncShipments();

  DF.bridgeReady = (async () => {
    const [overview, catalog] = await Promise.allSettled([loadOverview(), DF.api("/catalog")]);
    if (catalog.status === "fulfilled") Ops.catalog = catalog.value;
    if (overview.status === "rejected") showToast(DF.describe(overview.reason));
    // Stage counts follow the person's scope ("my hub" for hub operators), known from the overview.
    await Ops.loadStageCounts?.().catch(() => undefined);
    const role = document.querySelector(".user-profile small");
    if (role && Ops.me?.hubs?.length) role.textContent = `${Ops.roleName()} · ${Ops.me.hubs.map(h => h.name).join(", ")}`;
    Ops.ready = true; // the lists on screen may load now (they wait for the person's scope)
    render(Ops.page());
  })();
  Ops.liveParcels();
  // Geography changes in super admin: zone / area lists and hub forms use the new catalog.
  DF.events.on("catalog.updated", () => DF.api("/catalog").then(c => (Ops.catalog = c)).catch(() => undefined));
})();
