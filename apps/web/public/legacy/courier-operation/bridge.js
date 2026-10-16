/*
 * Courier Operations on the API, part 1: the shipment register and parcel actions.
 *
 * - Every page's shipment list (Overview feed, Shipments, Exceptions, Dispatch queue, the
 *   service-line pages and the hub register) is built from a bounded working set from
 *   GET /parcels (the newest active parcels and the last week's closed ones) plus whatever
 *   server-side search, filters and "Load more" fetched. The page's sample shipments are dropped.
 * - Counters come from GET /ops/overview (computed in the database). Live updates arrive as
 *   parcel.created / parcel.updated events: changed parcels are re-fetched one by one, with a
 *   slow safety refresh (DF.live) instead of polling.
 * - Actions (assign, status, cancel, exceptions, corrections, notes) call the parcel
 *   endpoints; the API enforces roles and hub scope and its message is shown on refusal.
 *
 * bridge-pages.js adds the page-specific views (overview counters, dispatch, riders, hubs,
 * merchants, COD, analytics, settings) and bookings. Shared helpers live on window.DFOps.
 */
(() => {
  const DF = window.DF;
  const PARCELS_KEY = "deliveryfast-customer-parcels";
  const ROLE_LABEL = { SUPER_ADMIN: "Super admin", OPS_MANAGER: "Operations manager", HUB_OPERATOR: "Hub operator", FINANCE: "Finance", SUPPORT_AGENT: "Support agent" };
  const TERMINAL = ["DELIVERED", "PICKUP_CANCELLED", "RETURNED"];
  const ACTIVE = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED", "PICKED_UP", "AT_HUB", "ASSIGNED", "IN_TRANSIT", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "RETURN_SCHEDULED", "EXCEPTION"];
  const CLOSED_DAYS = 7;
  /** The working set kept in the browser; everything else is found through server-side search. */
  const ACTIVE_CAP = 1000;
  const CLOSED_CAP = 300;
  const EXTRA_CAP = 2000;
  const $ = id => document.getElementById(id);
  const esc = value => courierEscape(value);

  // ───────────── shared helpers (also used by bridge-pages.js) ─────────────

  const Ops = (window.DFOps = {
    overview: null,
    me: null,
    catalog: null,
    /** Parcels found by search that fall outside the loaded window; kept across reloads. */
    extra: new Map(),
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

  /** Asks which hub, defaulting to the operator's own hub. */
  Ops.pickHub = (question, hubs = DF.state.hubs, preferred) => {
    if (!hubs.length) return void showToast("No hubs are configured yet.");
    if (hubs.length === 1) return hubs[0];
    const list = hubs.map((h, i) => `${i + 1}. ${h.name}`).join("\n");
    const start = Math.max(0, hubs.findIndex(h => h.id === preferred?.id)) + 1;
    const answer = prompt(`${question}\n${list}`, String(start));
    if (answer === null) return undefined;
    const hub = hubs[Number(answer) - 1];
    if (!hub) showToast("Choose a hub from the list.");
    return hub;
  };

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

  async function fetchAll(query, cap) {
    const items = [];
    let cursor = null;
    do {
      const page = await DF.api(`/parcels?limit=200${query}${cursor ? `&cursor=${cursor}` : ""}`);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor && items.length < cap);
    return items;
  }

  /** Every active parcel plus recently closed ones (and anything found by search). */
  async function loadParcels() {
    const since = new Date(Date.now() - CLOSED_DAYS * 86400000).toISOString();
    const [active, closed] = await Promise.all([fetchAll(`&status=${ACTIVE.join(",")}`, ACTIVE_CAP), fetchAll(`&status=${TERMINAL.join(",")}&from=${since}`, CLOSED_CAP)]);
    // Search results stay available, newest first, up to a bound.
    while (Ops.extra.size > EXTRA_CAP) Ops.extra.delete(Ops.extra.keys().next().value);
    const byId = new Map([...Ops.extra].map(([id, p]) => [id, p]));
    for (const p of [...active, ...closed]) byId.set(p.trackingId, p);
    for (const id of Ops.extra.keys()) Ops.extra.set(id, byId.get(id));
    const items = [...byId.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return DF.parcels.set(items);
  }

  async function loadOverview() {
    Ops.overview = await DF.api("/ops/overview");
    Ops.me = Ops.overview.me;
    updateNavCounts();
  }
  Ops.loadOverview = loadOverview;

  /** Parcels and counters; re-renders the page on screen if the parcels didn't (overview). */
  Ops.refresh = async () => {
    const [changed] = await Promise.all([loadParcels(), loadOverview()]);
    if (!changed) Ops.rerender();
  };

  // ───────────── API parcels → the page's shipment rows ─────────────

  const lineOf = p => (!p.merchant ? "Customer parcels" : p.merchant.type === "CORPORATE_DOCUMENT" ? "Documents" : "E-commerce");
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
  }
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
    return !!document.querySelector("#shipmentBody [data-shipment-select]:checked");
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
  };

  function updateNavCounts() {
    const s = Ops.overview?.shipments;
    if (!s) return;
    const set = (page, value) => {
      const badge = document.querySelector(`#navigation [data-page="${page}"] .nav-count`);
      if (badge) badge.textContent = Ops.num(value);
    };
    set("Shipments", s.active);
    set("Dispatch", s.unassigned);
    set("Exceptions", s.exceptions + s.atRisk);
  }

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
      const hub = (parcel.currentHub && Ops.hubById(parcel.currentHub.id)) || Ops.pickHub(`Which hub should receive ${id}?`, Ops.myHubs() || DF.state.hubs);
      if (!hub) return;
      return void Ops.setStatus(id, { status: "AT_HUB", hubId: hub.id, note }, `${id}: routed to ${hub.name}.`);
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
      const reason = prompt(`Cancel pickup request ${id}? Add a reason for the customer (optional):`);
      if (reason === null) return;
      void Ops.act(DF.api(`/parcels/${encodeURIComponent(id)}/cancel`, { method: "POST", body: { reason: reason.trim() || undefined } }), `${id}: pickup request cancelled.`);
    },
    true,
  );

  /** A status picked from a row's select (customer rows and the hub register). */
  Ops.changeStatus = (id, label, select) => {
    const parcel = Ops.apiParcel(id);
    const restore = () => Ops.rerender(true);
    if (!parcel) return restore();
    if (!Ops.require("dispatch", "change parcel status")) return restore();
    if (/^delivered$/i.test(label)) {
      showToast("Only the delivering rider can mark a parcel delivered, with the recipient's code, signature or photo.");
      return restore();
    }
    if (/^(pickup assigned|assigned)$/i.test(label)) {
      restore();
      return openModal("assign", id);
    }
    const body = { status: /^return to hub$/i.test(label) ? "At hub" : label };
    if (/^(at hub|return to hub)$/i.test(label)) {
      const hub = (parcel.currentHub && Ops.inMyHubs(parcel.currentHub.id) && Ops.hubById(parcel.currentHub.id)) || Ops.pickHub(`Which hub is ${id} at?`, Ops.myHubs() || DF.state.hubs);
      if (!hub) return restore();
      body.hubId = hub.id;
    }
    if (/^in transit$/i.test(label)) {
      const others = DF.state.hubs.filter(h => h.id !== parcel.currentHub?.id);
      const hub = Ops.pickHub(`${id} is in transit to which hub?`, others.length ? others : DF.state.hubs);
      if (!hub) return restore();
      body.hubId = hub.id;
    }
    if (/^exception$/i.test(label)) {
      const note = prompt(`What's wrong with ${id}? (shown to staff only)`, "");
      if (note === null) return restore();
      body.note = note.trim() || undefined;
    }
    void Ops.setStatus(id, body, `${id} updated to ${body.status}.`);
  };

  window.addEventListener(
    "change",
    event => {
      const select = event.target.closest?.("[data-customer-status]");
      if (!select || !Ops.apiParcel(select.dataset.customerStatus)) return;
      event.stopImmediatePropagation();
      Ops.changeStatus(select.dataset.customerStatus, select.value, select);
    },
    true,
  );

  // ───────────── tracking history ─────────────

  const baseHistory = courierTrackingHistory;
  courierTrackingHistory = function (id) {
    const parcel = Ops.apiParcel(id);
    if (!parcel) return baseHistory(id);
    const events = [...parcel.events].reverse();
    const markup = `<div id="courierHistoryBackdrop" role="dialog" aria-modal="true" aria-labelledby="courierHistoryTitle" style="position:fixed;inset:0;z-index:100;background:#14203380;display:grid;place-items:center;padding:18px"><section style="width:min(560px,100%);max-height:85vh;overflow:auto;background:#fff;border-radius:12px;padding:20px;box-shadow:0 24px 70px #10182840"><header style="display:flex;justify-content:space-between;gap:12px"><div><h2 id="courierHistoryTitle" style="margin:0;font-size:18px">Tracking history · ${esc(id)}</h2><p style="margin:6px 0;color:#778293">${esc(parcel.recipient.name)} · ${esc(parcel.delivery.label)} · ${esc(parcel.statusLabel)}</p></div><button type="button" id="closeCourierHistory" class="button" aria-label="Close tracking history">×</button></header><ol style="list-style:none;margin:18px 0 0;padding:0">${events
      .map(
        (e, index) =>
          `<li style="position:relative;margin-left:8px;padding:0 0 18px 25px;border-left:${index === events.length - 1 ? "0" : "1px solid #dfe5ee"}"><span style="position:absolute;left:-6px;top:2px;width:11px;height:11px;border-radius:50%;background:${index === 0 ? "#3766e8" : "#cbd5e1"}"></span><strong>${esc(e.title)}${e.internal ? " · internal" : ""}</strong><div style="margin-top:3px;color:#647184">${esc([e.location, e.description].filter(Boolean).join(" · "))}</div><small style="display:block;margin-top:4px;color:#99a3af">${esc([Ops.when(e.at), e.actor].filter(Boolean).join(" · "))}</small></li>`,
      )
      .join("")}</ol><p style="margin:0;color:#929eac;font-size:12px">Newest first. Internal entries are visible to staff only.</p></section></div>`;
    $("courierHistoryBackdrop")?.remove();
    document.body.insertAdjacentHTML("beforeend", markup);
    $("closeCourierHistory").addEventListener("click", () => {
      $("courierHistoryBackdrop").remove();
      flushPending();
    });
    $("courierHistoryBackdrop").addEventListener("click", e => {
      if (e.target.id === "courierHistoryBackdrop") {
        e.currentTarget.remove();
        flushPending();
      }
    });
  };

  // ───────────── corrections to a booked parcel ─────────────

  function openParcelEditor(parcel) {
    generatedCNDialog();
    const form = $("generatedCNForm");
    form.dataset.mode = "parcel";
    form.dataset.shipmentId = parcel.trackingId;
    $("generatedCNTitle").textContent = `Edit parcel · ${parcel.trackingId}`;
    $("generatedCNDescription").textContent = `${parcel.statusLabel} · ${parcel.merchant?.name || parcel.sender.name} → ${parcel.delivery.zone}, ${parcel.delivery.district}. Price-affecting details (zones, weight, COD) can't change after booking. Every change is recorded on the parcel's timeline.`;
    const input = (name, label, value, attrs = "") => `<label>${label}<input name="${name}" value="${esc(value ?? "")}" ${attrs}></label>`;
    $("generatedCNFields").innerHTML = `<div class="cn-dialog-grid">${input("recipient", "Recipient name", parcel.recipient.name, "required maxlength=120")}${input("recipientPhone", "Recipient phone", DF.localPhone(parcel.recipient.phone), 'required inputmode="tel"')}${input("street", "Street address", parcel.delivery.street, "required maxlength=200")}${input("area", "Area / landmark", parcel.delivery.area, "maxlength=120")}<label class="cn-span-full">Delivery instructions<input name="instructions" value="${esc(parcel.instructions || "")}" maxlength="500"></label><label class="cn-span-full">Reason for the change<input name="note" maxlength="500" placeholder="e.g. Recipient confirmed a new phone number"></label></div>`;
    $("generatedCNSubmit").textContent = "Save parcel details";
    $("generatedCNDialog").showModal();
    $("generatedCNFields").querySelector("input")?.focus();
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

  window.addEventListener(
    "submit",
    event => {
      const form = event.target;
      if (form.id !== "generatedCNForm" || form.dataset.mode !== "parcel") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const parcel = Ops.apiParcel(form.dataset.shipmentId);
      if (!parcel) return void closeGeneratedCNDialog();
      const data = new FormData(form);
      const value = key => String(data.get(key) || "").trim();
      const body = {
        recipient: { name: value("recipient"), phone: value("recipientPhone") },
        delivery: { street: value("street"), area: value("area") },
        instructions: value("instructions"),
        note: value("note") || undefined,
        expectedVersion: parcel.version,
      };
      const button = $("generatedCNSubmit");
      button.disabled = true;
      DF.api(`/parcels/${encodeURIComponent(parcel.trackingId)}`, { method: "PATCH", body })
        .then(async () => {
          closeGeneratedCNDialog();
          await Ops.refresh().catch(() => undefined);
          showToast(`${parcel.trackingId} details saved.`);
        })
        .catch(error => showToast(DF.describe(error)))
        .finally(() => (button.disabled = false));
    },
    true,
  );
  $("generatedCNDialog")?.addEventListener("close", flushPending);

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

  // ───────────── search, notifications ─────────────

  $("globalSearch").addEventListener(
    "keydown",
    async event => {
      if (event.key !== "Enter") return;
      event.stopImmediatePropagation();
      const raw = event.currentTarget.value.trim();
      if (!raw) return;
      const q = raw.toLowerCase();
      const local = shipments.find(s => s.id.toLowerCase() === q) || shipments.find(s => [s.recipient, s.merchant, s.recipientPhone].some(v => String(v || "").toLowerCase().includes(q)));
      let hit = local;
      if (!hit) {
        try {
          const page = await DF.api(`/parcels?limit=20&q=${encodeURIComponent(raw)}`);
          for (const p of page.items) Ops.extra.set(p.trackingId, p);
          if (page.items.length) {
            DF.parcels.set([...DF.parcels.cache.filter(p => !Ops.extra.has(p.trackingId)), ...page.items]);
            syncShipments();
            hit = shipments.find(s => s.id === page.items[0].trackingId);
          }
        } catch (error) {
          return void showToast(DF.describe(error));
        }
      }
      if (!hit) return void showToast(`No shipment found for “${raw}”.`);
      render("Shipments");
      const search = $("shipmentSearch");
      if (search) {
        search.value = hit.id;
        search.dispatchEvent(new Event("input"));
      }
      showToast(`${hit.id} · ${hit.status} · ${hit.destination}`);
    },
    true,
  );

  $("notifications").addEventListener(
    "click",
    event => {
      event.stopImmediatePropagation();
      const s = Ops.overview?.shipments;
      if (!s) return void showToast("Operations alerts are loading.");
      const total = s.exceptions + s.atRisk + s.unassigned;
      showToast(total ? `${total} operations alerts: ${s.exceptions} exceptions, ${s.atRisk} SLA at risk, ${s.unassigned} waiting for a rider.` : "No operations alerts right now.");
    },
    true,
  );

  // ───────────── server-side search, filters and paging ─────────────
  // The shipment pages filter the working set in the browser as before; search text, status
  // and dates also go to GET /parcels so parcels outside the working set are found, and
  // "Load more" pages through the full result with the API's cursor.

  const SHIPMENT_PAGES = { Shipments: null, Exceptions: null, "Customer parcels": "Customer parcels", "E-commerce operations": "E-commerce", "Document operations": "Documents" };
  const server = { key: "", cursor: null, loading: false, timer: null };

  function serverQuery() {
    const params = new URLSearchParams({ limit: "100" });
    const q = $("shipmentSearch")?.value.trim();
    const status = $("statusFilter")?.value;
    const byStatusDate = $("shipmentDateField")?.value === "status";
    const from = $("shipmentDateFrom")?.value;
    const to = $("shipmentDateTo")?.value;
    if (q && q.length >= 2) params.set("q", q);
    if (status === "Needs info") params.set("incomplete", "true");
    else if (status) params.set("status", status);
    if (!byStatusDate && from) params.set("from", new Date(`${from}T00:00:00`).toISOString());
    if (!byStatusDate && to) params.set("to", new Date(`${to}T23:59:59.999`).toISOString());
    return params;
  }

  /** Rebuilds the shipment table on screen without a full page render (keeps focus while typing). */
  function refreshShipmentTable() {
    const body = $("shipmentBody");
    const page = Ops.page();
    if (!body || !(page in SHIPMENT_PAGES) || page === "Exceptions") return;
    const category = SHIPMENT_PAGES[page];
    const rows = shipments.filter(s => !category || serviceCategory(s) === category);
    const checked = new Set([...body.querySelectorAll("[data-shipment-select]:checked")].map(i => i.dataset.shipmentSelect));
    body.closest(".table-scroll").outerHTML = shipmentRows(rows);
    for (const id of checked) {
      const box = document.querySelector(`#shipmentBody [data-shipment-select="${CSS.escape(id)}"]`);
      if (box) box.checked = true;
    }
    applyShipmentFilters();
    pagingFooter();
  }

  function pagingFooter() {
    const count = $("shipmentBody")?.closest(".table-panel")?.querySelector(".shipment-count");
    if (!count) return;
    count.querySelector("[data-shipments-more]")?.remove();
    if (server.key && server.cursor)
      count.insertAdjacentHTML("beforeend", ` <button class="button button-sm" type="button" data-shipments-more>${server.loading ? "Loading…" : "Load more from the server"}</button>`);
  }

  async function serverSearch(more = false) {
    const params = serverQuery();
    const key = params.toString();
    const filtered = params.has("q") || params.has("status") || params.has("from") || params.has("to");
    if (!more) server.cursor = null;
    server.key = filtered ? key : "";
    if (!filtered) return void pagingFooter();
    if (more && server.cursor) params.set("cursor", server.cursor);
    server.loading = true;
    pagingFooter();
    try {
      const page = await DF.api(`/parcels?${params}`);
      if (server.key !== key) return; // the filters changed meanwhile
      for (const p of page.items) {
        Ops.extra.delete(p.trackingId);
        Ops.extra.set(p.trackingId, p);
      }
      server.cursor = page.nextCursor;
      const fresh = new Map(page.items.map(p => [p.trackingId, p]));
      const known = new Set(DF.parcels.cache.map(p => p.trackingId));
      DF.parcels.cache = DF.parcels.cache.map(p => fresh.get(p.trackingId) || p).concat(page.items.filter(p => !known.has(p.trackingId)));
      syncShipments();
      refreshShipmentTable();
    } catch (error) {
      showToast(DF.describe(error));
    } finally {
      server.loading = false;
      pagingFooter();
    }
  }

  window.addEventListener("input", event => {
    if (event.target.id !== "shipmentSearch" || !(Ops.page() in SHIPMENT_PAGES)) return;
    clearTimeout(server.timer);
    server.timer = setTimeout(() => void serverSearch(), 350);
  });
  window.addEventListener("change", event => {
    if (!["statusFilter", "shipmentDateField", "shipmentDateFrom", "shipmentDateTo"].includes(event.target.id) || !(Ops.page() in SHIPMENT_PAGES)) return;
    void serverSearch();
  });
  window.addEventListener(
    "click",
    event => {
      if (!event.target.closest("[data-shipments-more]")) return;
      event.stopImmediatePropagation();
      if (!server.loading) void serverSearch(true);
    },
    true,
  );
  Ops.pagingFooter = pagingFooter;
  const otherEnhance = Ops.enhance["*"];
  Ops.enhance["*"] = page => {
    otherEnhance?.(page);
    if (page in SHIPMENT_PAGES) pagingFooter();
  };

  // ───────────── live updates ─────────────
  // A changed parcel is re-fetched on its own; many changes at once (a truck departing) or a
  // reconnect reload the working set. Counters follow a little later.

  const changedIds = new Set();
  let liveTimer = null;
  let countersTimer = null;
  async function applyChanges() {
    const ids = [...changedIds];
    changedIds.clear();
    if (ids.length > 25) return void (await Ops.refresh().catch(() => undefined));
    const results = await Promise.allSettled(ids.map(id => DF.api(`/parcels/${encodeURIComponent(id)}`)));
    let items = DF.parcels.cache;
    results.forEach(r => {
      if (r.status !== "fulfilled") return;
      const p = r.value;
      if (Ops.extra.has(p.trackingId)) Ops.extra.set(p.trackingId, p);
      items = items.some(x => x.trackingId === p.trackingId) ? items.map(x => (x.trackingId === p.trackingId ? p : x)) : [p, ...items];
    });
    DF.parcels.set(items); // fires the storage event: rows rebuilt and the page redrawn
  }
  const onParcel = data => {
    if (!data?.id) return;
    changedIds.add(data.id);
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => void applyChanges().catch(() => undefined), 500);
    clearTimeout(countersTimer);
    countersTimer = setTimeout(() => void loadOverview().then(() => Ops.page() === "Overview" && Ops.rerender()).catch(() => undefined), 2500);
  };
  Ops.liveParcels = () => {
    DF.events.on("parcel.updated", onParcel);
    DF.events.on("parcel.created", onParcel);
    // Reconnects and a slow safety refresh reload the working set and counters.
    DF.live([], Ops.refresh, { fallbackMs: 180_000 });
  };

  // ───────────── start ─────────────

  DF.showSignedInUser(Ops.roleName());
  // Sample data the API replaces: shown empty until real data loads.
  for (const page of ["Riders", "Merchants", "COD & finance", "Analytics", "Settings"]) if (genericPages[page]) genericPages[page].rows = [];
  hubTransferEvents.length = 0;
  riderReportState.from = riderReportState.to = Ops.dayKey();
  syncShipments();

  DF.bridgeReady = (async () => {
    const [parcels, overview, catalog] = await Promise.allSettled([loadParcels(), loadOverview(), DF.api("/catalog")]);
    if (catalog.status === "fulfilled") Ops.catalog = catalog.value;
    if (parcels.status === "rejected" || overview.status === "rejected") showToast(DF.describe(parcels.reason || overview.reason));
    const role = document.querySelector(".user-profile small");
    if (role && Ops.me?.hubs?.length) role.textContent = `${Ops.roleName()} · ${Ops.me.hubs.map(h => h.name).join(", ")}`;
    syncShipments();
    render(Ops.page());
  })();
  Ops.liveParcels();
})();
