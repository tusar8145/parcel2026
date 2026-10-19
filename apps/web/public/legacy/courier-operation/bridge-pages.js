/*
 * Courier Operations on the API, part 2: the pages' counters, reports and forms.
 *
 * Each page keeps its original markup; Ops.prepare[page] puts real rows into the page's
 * data before it renders and Ops.enhance[page] replaces sample figures afterwards.
 *   Overview, Shipments, Exceptions, service lines  GET /ops/overview, GET /ops/stage-counts (the tables: bridge-lists.js)
 *   Dispatch & routes                               GET /ops/dispatch + stage counts (Pickup / Delivery metrics)
 *   Riders & fleet (report, run sheets)             GET /ops/rider-report
 *   Hubs & zones                                    only the parts of the tab on screen (Ops.hubPart): receive
 *                                                   desk (bridge-intake.js), At my hub (bridge-nav.js), counter
 *                                                   (bridge-collect.js), register / zones / routes (bridge-hubs.js,
 *                                                   bridge-network.js)
 *   Merchant accounts                               GET /ops/merchants
 *   COD & finance                                   bridge-finance.js
 *   Analytics & SLA                                 GET /ops/analytics
 *   Admin settings                                  GET /catalog (managed in super admin)
 *   New shipment                                    POST /ops/parcels: a merchant or a walk-in sender (Excel import: bridge-imports.js)
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  const $ = id => document.getElementById(id);
  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = Ops.esc;
  const setText = (el, text) => el && (el.textContent = text);
  const pct = v => (v == null ? "—" : `${v}%`);
  const longDate = () => new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const panelTitled = title => qa("#mainContent .panel").find(p => q(".panel-title", p)?.textContent === title);
  const setMetrics = items => {
    const box = q("#mainContent .metrics");
    if (box) box.innerHTML = items.map(m => metric(m[0], m[1], m[2], m[3], m[4])).join("");
  };
  const registerText = (subtitle, footer) => {
    setText(q("#mainContent .table-panel .panel-heading .panel-subtitle"), subtitle);
    const foot = q("#mainContent .table-panel > div:last-child");
    if (foot && /sample|demo/i.test(foot.textContent)) foot.textContent = footer;
  };
  const refreshButton = (toastText, done) =>
    window.addEventListener(
      "click",
      event => {
        if (!event.target.closest(`[data-toast="${toastText}"]`)) return;
        event.stopImmediatePropagation();
        Ops.invalidate("dispatch");
        Ops.refresh()
          .then(() => showToast(done))
          .catch(error => showToast(DF.describe(error)));
      },
      true,
    );

  // ───────────── live overview ─────────────

  /** The illustrated map stays decorative; its caption shows the real rider count. */
  const mapTag = () => Ops.overview && setText(q("#mainContent .map-tag.tag-zone"), `Network · ${Ops.num(Ops.overview.riders.online)} riders on shift`);

  Ops.enhance.Overview = () => {
    const o = Ops.overview;
    if (!o) return;
    const s = o.shipments;
    setText(q("#mainContent .page-heading .eyebrow"), `${longDate()} · Network operations`);
    const change = s.createdYesterday ? Math.round(((s.createdToday - s.createdYesterday) / s.createdYesterday) * 1000) / 10 : null;
    const pts = o.onTime.monthRate != null && o.onTime.previousMonthRate != null ? Math.round((o.onTime.monthRate - o.onTime.previousMonthRate) * 10) / 10 : null;
    setMetrics([
      ["Shipments today", Ops.num(s.createdToday), "box", change == null ? `${Ops.num(s.createdYesterday)} yesterday` : `${change >= 0 ? "↑" : "↓"} ${Math.abs(change)}%`, change == null ? "booked today" : "vs. yesterday"],
      ["Out for delivery", Ops.num(s.outForDelivery), "truck", `${o.riders.withOpenTasks} riders active`, `across ${o.hubs.length} hubs`],
      ["On-time delivery", pct(o.onTime.monthRate), "clock", pts == null ? `${Ops.num(o.onTime.monthDelivered)} delivered` : `${pts >= 0 ? "↑" : "↓"} ${Math.abs(pts)} pts`, "this month"],
      ["Active riders", Ops.num(o.riders.online), "users", `of ${Ops.num(o.riders.total)} riders`, "on shift now"],
      ["Open exceptions", Ops.num(s.exceptions), "alert", `${Ops.num(s.atRisk)} SLA at risk`, "needs attention"],
    ]);
    mapTag();

    const list = q("#mainContent .alert-list");
    if (list) {
      list.innerHTML =
        o.alerts
          .map(a => {
            const when = a.kind === "sla" ? `due ${Ops.when(a.at)}` : a.kind === "cod" ? Ops.ago(a.at) : a.at ? Ops.ago(a.at) : "";
            const text = a.text;
            const action = a.action.exception ? `data-exception="${esc(a.action.exception)}"` : `data-page-link="${esc(a.action.page)}"`;
            return `<div class="alert-item"><span class="alert-icon${a.tone === "red" ? " red" : ""}">${icon(a.icon)}</span><div class="alert-copy"><strong>${esc(a.title)}</strong>${esc(text)}<small>${esc([a.meta, when].filter(Boolean).join(" · "))}</small></div><button class="button button-sm alert-action" ${action}>${esc(a.action.label)}</button></div>`;
          })
          .join("") || `<div class="empty-state">No priority alerts right now.</div>`;
      setText(q(".panel-heading .status", list.closest(".panel")), `${o.alerts.length} open`);
    }
  };
  refreshButton("Live network view refreshed.", "Live network view refreshed.");

  // ───────────── shipments, exceptions, service lines ─────────────

  Ops.enhance.Shipments = () => {
    const s = Ops.overview?.shipments;
    if (s) qa("#mainContent .stats-mini .mini-card strong").forEach((el, i) => setText(el, Ops.num([s.inTransit + s.outForDelivery, s.atHub, s.exceptions][i])));
    setText(q("#mainContent .table-panel .panel-subtitle"), "Every parcel, newest first · 100 a page · search and filters run on the server");
  };

  // Problems: the stage's own numbers (GET /ops/stage-counts), the same on every tab.
  Ops.enhance.Exceptions = () => {
    const cards = qa("#mainContent .stats-mini .mini-card");
    [
      ["Open exceptions", "detail.exceptions"],
      ["SLA at risk", "detail.slaRisk"],
      ["Awaiting action", "stages.problems"],
    ].forEach(([label, key], i) => {
      if (!cards[i]) return;
      setText(q("span", cards[i]), label);
      const strong = q("strong", cards[i]);
      if (strong) strong.innerHTML = Ops.countSpan(key);
    });
    if (cards[2]) cards[2].title = "Exceptions, failed deliveries and orders with details missing";
  };

  // Service-line tabs of All parcels: the table is the register; the active count is the line's.
  function enhanceServiceLine(page) {
    const key = page === "Customer parcels" ? "customer" : page === "E-commerce operations" ? "ecommerce" : "documents";
    q("#mainContent .metrics")?.remove();
    const active = Ops.overview?.serviceLines?.[key];
    setText(q("#mainContent .table-panel .panel-subtitle"), `${active == null ? "" : `${Ops.num(active)} active · `}newest first · 100 a page · search and filters run on the server`);
    // Booking buttons (New shipment form, bookings below): walk-in senders on Customer parcels, the category's name elsewhere.
    const heading = q("#mainContent .page-heading .heading-actions");
    if (!heading) return;
    if (page === "Customer parcels") {
      const link = q('a[href="/#/request"]', heading);
      if (link && Ops.can("dispatch")) link.outerHTML = `<button class="button button-primary" type="button" data-action="newWalkIn">${icon("plus")} New walk-in order</button>`;
    } else {
      const button = q('[data-action="newDocument"], [data-action="newDomestic"], [data-action="newEcommerce"]', heading);
      if (button) button.innerHTML = `${icon("plus")} New ${page === "E-commerce operations" ? "e-commerce order" : "Banking & Financial order"}`;
    }
  }
  for (const page of ["Customer parcels", "E-commerce operations", "Banking & Financial operations"]) Ops.enhance[page] = enhanceServiceLine;

  // ───────────── dispatch & routes ─────────────

  const loadDispatch = () => (Ops.can("readRiders") ? Ops.lazy("dispatch", () => DF.api("/ops/dispatch"), 20000) : null);

  // Pickup and Delivery (bridge-nav.js tabs): the stage's own numbers first, then rider capacity.
  Ops.enhance.Dispatch = () => {
    mapTag();
    const d = loadDispatch();
    const pickup = Ops.tabMode === "pickup";
    const stage = pickup
      ? [
          ["Waiting for a pickup rider", "detail.pickupWaiting", "box", "accepted orders", "need a rider"],
          ["Being picked up", "detail.pickingUp", "truck", "with pickup riders", "on the way to the hub"],
        ]
      : [
          ["Waiting for a delivery rider", "detail.deliveryWaiting", "box", "at the hub", Ops.scope?.hubIds() ? "your hub" : "network wide"],
          ["Out with delivery riders", "detail.delivery", "truck", "assigned or out", "for delivery"],
        ];
    setMetrics([
      ...stage.map(([label, key, ico, trend, note]) => [label, Ops.countSpan(key), ico, trend, note]),
      ...(d
        ? [
            ["Riders available", Ops.num(d.riders.available), "users", `${Ops.num(d.riders.onShift)} on shift`, `of ${Ops.num(d.riders.total)} riders`],
            pickup
              ? ["Avg. stops / rider", String(d.avgStopsPerRoute), "route", "assigned today", "per active route"]
              : ["Routes active", Ops.num(d.routesActive), "route", `${Ops.num(d.routesNeedReview)} need review`, Ops.me?.hubIds ? "your hub" : "network wide"],
          ]
        : []),
    ]);

    // "Rebalance routes" only reloaded the figures: it is "Refresh".
    const refresh = q('#mainContent [data-toast="Route plan refreshed."]');
    if (refresh) refresh.textContent = "↻ Refresh";
    // The route roster (rider workloads) belongs to Delivery; Pickup shows the pickup tables only.
    if (pickup) panelTitled("Active route roster")?.remove();
    const roster = q("tbody", panelTitled("Active route roster") || document.createElement("div"));
    if (roster) {
      const error = Ops.lazyError("dispatch");
      roster.innerHTML = !Ops.can("readRiders")
        ? `<tr><td colspan="6" class="empty-state">Rider workloads are available to dispatch staff.</td></tr>`
        : !d
          ? `<tr><td colspan="6" class="empty-state">${error ? esc(DF.describe(error)) : "Loading rider workloads…"}</td></tr>`
          : d.roster
              .map(
                r =>
                  `<tr><td>${esc(r.rider.label)}</td><td>${esc(r.rider.zone || r.rider.hub?.name || "—")}</td><td>${r.assignedToday}</td><td>${r.completed}</td><td>${r.remaining}</td><td>${statusPill(r.health)}</td></tr>`,
              )
              .join("") || `<tr><td colspan="6" class="empty-state">No riders at your hub yet.</td></tr>`;
    }
  };
  refreshButton("Route plan refreshed.", "Rider workloads and stage figures refreshed.");

  // ───────────── riders & fleet ─────────────

  const riderStatusLabel = r => (!r.active ? "Inactive" : r.status === "ONLINE" ? (r.openDeliveries ? "On route" : "Available") : r.status === "ON_BREAK" ? "On break" : "Off shift");
  const VEHICLE = { MOTORBIKE: "Motorcycle", BICYCLE: "Bicycle", VAN: "Van", ON_FOOT: "On foot" };
  const reportKey = () => `riders:${riderReportState.from}|${riderReportState.to}`;
  const riderReport = () =>
    Ops.can("readRiders")
      ? Ops.lazy(reportKey(), () => DF.api(`/ops/rider-report?from=${riderReportState.from}&to=${riderReportState.to}`), 30000)
      : null;

  Ops.prepare.Riders = () => {
    const report = riderReport();
    genericPages.Riders.rows = (report?.riders || []).map(r => [
      `${r.code} · ${r.name}`,
      r.zone || r.hub?.name || "—",
      VEHICLE[r.vehicle] || r.vehicle,
      "—",
      String(r.openDeliveries),
      "—",
      riderStatusLabel(r),
    ]);
  };

  // The report, run sheets and export read the API's report for the chosen dates.
  riderReportData = function () {
    const report = Ops.cache[reportKey()]?.value;
    const rows = (report?.riders || []).map(r => ({
      id: r.code,
      name: r.name,
      zone: r.zone || r.hub?.name || "—",
      status: `${riderStatusLabel(r)}${r.hub ? ` · ${r.hub.name}` : ""}`,
      picked: r.picked,
      counts: r.counts,
      records: r.records.map(p => ({ id: p.trackingId, merchant: p.merchant, recipient: p.recipient, destination: p.destination, service: p.service, status: p.status, pickedUpAt: p.pickedUpAt, codAmount: p.codAmount })),
    }));
    return riderReportState.rider ? rows.filter(r => r.id === riderReportState.rider) : rows;
  };

  // Run sheet: a PDF of the rider's assigned work for the day (GET /documents/run-sheet/:rider), keyed on
  // today's assignments rather than the report's pickup dates, in route order with COD and signatures.
  printRiderRunSheet = function (riderId) {
    const day = riderReportState.to && riderReportState.to <= Ops.dayKey(new Date()) ? riderReportState.to : Ops.dayKey(new Date());
    return Ops.printPdf(`/documents/run-sheet/${encodeURIComponent(riderId)}?date=${day}`, { title: "Preparing the run sheet…" });
  };

  Ops.enhance.Riders = () => {
    for (const button of document.querySelectorAll("#mainContent [data-run-sheet]")) {
      button.disabled = false;
      button.textContent = "Run sheet (PDF)";
      button.title = "Today's assigned deliveries and pickups for this rider, in route order, with COD and signature lines";
    }
    const error = Ops.lazyError(reportKey());
    if (!Ops.can("readRiders") || error) {
      const body = q("#mainContent tbody");
      if (body) body.innerHTML = `<tr><td colspan="5" class="empty-state">${Ops.can("readRiders") ? esc(DF.describe(error)) : "Rider reports are available to operations and support staff."}</td></tr>`;
    }
  };

  // ───────────── hubs & zones ─────────────
  // The page is one heading; each tab adds only its own part (Ops.hubPart, set by bridge-nav.js):
  // the receive desk, the counter, "At my hub", or the register, zones and routes. The old scan form,
  // manual receive form, hub-to-hub transfer form, transfer report and network setup are gone: the
  // receive desk handles every arrival and transfers go through bags and manifests (Transfers).

  Ops.hubPart = Ops.hubPart || null;
  hubOperationsPage = function () {
    const manage = Ops.hubPart === "manage";
    return `<div class="page-heading"><div><p class="eyebrow">${manage ? "Network setup · hubs, zones and routes" : "Hub operations · parcels at the hub"}</p><h1>Hub operations</h1><p class="subtitle">${manage ? "Hub register (with capacity), delivery zones and routes." : "Receive arrivals, work the parcels at your hub and hand parcels to receivers."}</p></div><div class="heading-actions"></div></div>`;
  };

  // ───────────── merchant accounts ─────────────

  const MERCHANT_STATUS = { ACTIVE: "Active", PENDING_REVIEW: "Review", SUSPENDED: "Suspended" };
  const loadMerchants = () => Ops.lazy("merchants", () => DF.api("/ops/merchants"), 60000);
  // The COD cycle is the merchant's real settlement schedule (finance); other roles don't see the column.
  const CYCLE = { MANUAL: "Manual", DAILY: "Daily", WEEKLY: "Weekly", BIWEEKLY: "Every two weeks" };
  const loadSchedules = () => (Ops.can("financeStaff") ? Ops.lazy("fin-schedules", () => DF.api("/finance/settlement-schedules"), 60000) : null);
  Ops.prepare.Merchants = () => {
    const schedules = loadSchedules();
    const showCycle = Ops.can("financeStaff");
    // Service packages replaced service plans: the column shows the package each merchant books with.
    genericPages.Merchants.cols = ["MERCHANT", "ACCOUNT ID", "PACKAGE", "PICKUP & HUB", "SHIPMENTS MTD", ...(showCycle ? ["COD CYCLE"] : []), "ACCOUNT OWNER", "STATUS"];
    const cycleOf = m => {
      if (!schedules) return Ops.lazyError("fin-schedules") ? "—" : "…";
      const s = schedules.find(x => x.merchant.id === m.id);
      return s ? `${CYCLE[s.cycle] || s.cycle}${s.weekdayLabel ? ` · ${s.weekdayLabel}` : ""}` : "Manual";
    };
    genericPages.Merchants.rows = (loadMerchants() || []).map(m => [
      `${m.name} · ${m.type === "BANKING_FINANCIAL" ? "Banking & Financial" : "E-commerce"}`,
      m.code,
      m.package ? `${m.package.name}${m.package.isDefault ? " (default)" : ""}` : "Default package",
      // Structured pickup (zone, district), the derived serving hub and the handover; older free text is flagged.
      `${m.pickupZone || m.pickupArea}, ${m.pickupDistrict}${m.pickupZone ? "" : " (address not completed)"} · ${m.pickupHub ? m.pickupHub.name : "no hub"}${m.handover === "HUB_DROP" ? " · drops at hub" : ""}`,
      Ops.num(m.parcelsThisMonth),
      ...(showCycle ? [cycleOf(m)] : []),
      m.contactName,
      MERCHANT_STATUS[m.status] || m.status,
    ]);
  };
  Ops.enhance.Merchants = () => {
    const rows = genericPages.Merchants.rows.length;
    const error = Ops.lazyError("merchants");
    registerText(error ? DF.describe(error) : "Live accounts · shipments booked this month", `Showing ${rows} merchant account${rows === 1 ? "" : "s"}`);
  };

  // COD & finance: see bridge-finance.js (finance, support and partner-applications area).

  // ───────────── analytics & SLA ─────────────

  const loadAnalytics = () => Ops.lazy("analytics", () => DF.api("/ops/analytics"), 60000);
  Ops.prepare.Analytics = () => {
    const a = loadAnalytics();
    const fmt = (v, unit) => (v == null ? "—" : unit === "%" ? `${v}%` : `${v} hrs`);
    genericPages.Analytics.rows = (a?.rows || []).map(r => {
      const delta = r.month != null && r.previousMonth != null ? Math.round((r.month - r.previousMonth) * 10) / 10 : null;
      const trend = delta == null ? "—" : `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(delta)} ${r.unit === "%" ? "pts" : "hrs"}`;
      const value = r.month ?? r.today;
      const ok = value != null && (r.better === "higher" ? value >= r.target : value <= r.target);
      const close = value != null && (r.better === "higher" ? value >= r.target * 0.95 : value <= r.target * 1.25);
      return [r.label, `${r.better === "higher" ? "≥" : "≤"} ${r.target}${r.unit === "%" ? "%" : " hrs"}`, fmt(r.today, r.unit), fmt(r.month, r.unit), fmt(r.previousMonth, r.unit), trend, value == null ? "No data" : ok ? "Healthy" : close ? "Monitor" : "At risk"];
    });
  };
  Ops.enhance.Analytics = () => {
    const a = Ops.cache.analytics?.value;
    const error = Ops.lazyError("analytics");
    registerText(error ? DF.describe(error) : "Live service levels · this month compared with last month", a ? `Based on ${Ops.num(a.samples.month.delivered)} deliveries and ${Ops.num(a.samples.month.pickups)} pickups this month` : "Loading service levels…");
  };

  // ───────────── admin settings ─────────────

  // Settings: a short list of where each setting really lives (the read-only table overflowed and its
  // "Manage" buttons only jumped away). Two-step verification is the one personal setting here.
  Ops.prepare.Settings = () => void (genericPages.Settings.rows = []);
  function settingsCards() {
    const superAdmin = DF.auth.hasRole?.("SUPER_ADMIN");
    const allowed = Ops.allowedViews?.() || new Set();
    const c = Ops.catalog;
    const zones = c ? Object.values(c.zonesByDistrict).flat().length : null;
    const admin = (page, label) => (superAdmin ? `<a class="button button-sm" href="/super-admin?page=${encodeURIComponent(page)}">${esc(label)}</a>` : `<span class="subcell">Managed by super admins</span>`);
    const cards = [
      ["Two-step verification", "Protect your own sign-in with an authenticator app code.", DF.mfa?.manage ? `<button class="button button-sm button-primary" type="button" data-action="mfa">Two-step verification</button>` : ""],
      ["Hubs & zones", `${DF.state.hubs.length} active hubs${zones ? ` · ${zones} catalog zones` : ""}. Hub register, which hub serves each delivery zone, and routes.`, admin("Hubs & zones", "Open in super admin")],
      ["SLA policies", "Pickup and delivery due times per service level and route.", allowed.has("Reports") ? `<button class="button button-sm" type="button" data-settings-open="Reports" data-settings-tab="Analytics & SLA">Open SLA policies</button>` : ""],
      ["Service plans & pricing", "Service packages, district prices, COD fee and booking rules.", admin("Service plans", "Open in super admin")],
      ["Notifications", "SMS and email texts, switches and gateways.", admin("Platform settings", "Open in super admin")],
      ["Roles & access", "Staff accounts, roles and permissions.", admin("Admin users", "Open in super admin")],
    ];
    return `<section class="panel" id="settingsCards"><div class="panel-heading"><div><h2 class="panel-title">Where to change things</h2><p class="panel-subtitle">Network settings live where they are used; platform settings are in the super admin console.</p></div></div><div style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));padding:0 16px 16px">${cards
      .map(([title, text, action]) => `<article class="mini-card" style="display:grid;gap:8px;align-content:start;padding:14px;border:1px solid var(--line);border-radius:10px" data-settings-card="${esc(title)}"><strong style="font-size:14px">${esc(title)}</strong><span style="color:#647184;font-size:13px">${esc(text)}</span><div>${action}</div></article>`)
      .join("")}</div></section>`;
  }
  Ops.enhance.Settings = () => {
    // The card list replaces the register table (and its heading Export).
    q("#mainContent .table-panel")?.remove();
    qa('#mainContent .page-heading [data-action="export"]').forEach(b => b.remove());
    $("settingsCards")?.remove();
    const heading = q("#mainContent .page-heading");
    if (heading) heading.insertAdjacentHTML("afterend", settingsCards());
    else $("mainContent").insertAdjacentHTML("beforeend", settingsCards());
  };
  window.addEventListener(
    "click",
    event => {
      const open = event.target.closest?.("[data-settings-open]");
      if (!open) return;
      event.stopImmediatePropagation();
      Ops.navigate(open.dataset.settingsOpen, open.dataset.settingsTab || 0);
      if (open.dataset.settingsTab === "Analytics & SLA") setTimeout(() => $("slaPolicies")?.scrollIntoView({ behavior: "smooth", block: "start" }), 300);
    },
    true,
  );

  // ───────────── bookings by operations (New shipment) ─────────────
  //
  // One form for every sender (POST /ops/parcels):
  //   E-commerce / Banking & Financial merchant  sender and pickup from the merchant's profile, its package
  //   Walk-in sender (customer parcel)           sender name / phone and pickup address typed here, no
  //                                              merchant, the Customer default package
  // Order: sender → recipient → delivery address → parcel (product, weight, contents) → service (one
  // first-mile select with its drop-off hub, one last-mile select, Service, COD + amount, open box,
  // messages) → live price (the same quote body as the booking, product included). Inline errors
  // (DF.validate.field) and +880 phone fields (DF.phoneInput). After booking the parcel's drawer opens
  // (Print label there).

  const LINE_LABEL = { ecommerce: "E-commerce merchant", banking: "Banking & Financial merchant", walkin: "Walk-in sender (customer parcel)" };
  const BOOKING_KINDS = { newShipment: "", newEcommerce: "ecommerce", newDomestic: "banking", newDocument: "banking", newWalkIn: "walkin" };
  const LINE_PAGE = { ecommerce: "E-commerce operations", banking: "Banking & Financial operations", walkin: "Customer parcels" };
  const LINE_TITLE = { ecommerce: "Create e-commerce order", banking: "Create Banking & Financial order", walkin: "Create walk-in order" };
  const booking = { line: "ecommerce", pkg: null, pkgKey: "", checks: [], quoteSeq: 0 };
  const svcApi = () => window.DFOrderServices;
  const lineNow = () => $("bkLine")?.value || booking.line;
  const merchantsFor = line => (Ops.cache.merchants?.value || []).filter(m => m.status === "ACTIVE" && (line === "banking") === (m.type === "BANKING_FINANCIAL"));
  const bookingMerchant = () => (Ops.cache.merchants?.value || []).find(m => m.id === $("bkMerchant")?.value);
  const shown = el => !!el && !el.closest(".field")?.hidden;

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="dfBookingStyles">
      #modalFields.form-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
      #modalFields [hidden]{display:none!important}
      #modalFields .field{min-width:0}
      #modalFields .field>select,#modalFields .field>input:not([type=checkbox]):not([type=radio]),#modalFields .df-phone{width:100%;max-width:100%;min-width:0;box-sizing:border-box}
      #modalFields .df-phone input{min-width:0}
      #modalFields .df-bk-section{margin:4px 0 -4px;padding-top:10px;border-top:1px solid var(--line);color:#8792a2;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
      #modalFields .df-bk-section:first-child{margin-top:0;padding-top:0;border-top:0}
      #modalFields .df-svc-checks label{display:flex;align-items:center;gap:7px;color:#3c4859;font-size:13px}
      #modalFields details label{color:#3c4859;font-weight:400}
      #modalBackdrop .modal{max-height:calc(100vh - 40px);overflow-y:auto}
      #modalFields .df-req>label::after{content:" *";color:#c2410c;font-weight:700}
      @media(max-width:560px){#modalFields.form-grid{grid-template-columns:minmax(0,1fr)}#modalBackdrop{padding:10px}#modalBackdrop .modal{padding:16px}}
    </style>`,
  );

  const bkField = (id, label, control, { full = false, cls = "", hidden = false } = {}) => `<div class="field${full ? " full" : ""}${cls ? ` ${cls}` : ""}"${hidden ? " hidden" : ""}><label for="${id}">${esc(label)}</label>${control}</div>`;
  const bkSection = (title, cls = "") => `<div class="field full df-bk-section${cls ? ` ${cls}` : ""}">${esc(title)}</div>`;
  const placeSelect = id => `<select id="${id}"><option value="">Loading…</option></select>`;

  function bookingFields(fixed) {
    const line = fixed || "ecommerce";
    const lineSelect = fixed
      ? ""
      : bkField("bkLine", "Booking for", `<select id="bkLine">${Object.entries(LINE_LABEL).map(([v, l]) => `<option value="${v}" ${v === line ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`, { full: true });
    return [
      bkSection(fixed === "walkin" ? "Booking" : "Account"),
      lineSelect,
      bkField("bkMerchant", "Merchant account", `<select id="bkMerchant"></select><small id="bkMerchantPickup" style="color:#64748b;font-size:12px"></small>`, { full: true, cls: "df-bk-merchant" }),
      // The service first: it decides which addresses are needed (drop at hub: no sender address; Hub Pickup: no street).
      bkSection("Service"),
      `<div id="bkServices" style="display:contents"></div>`,
      bkSection("Sender", "df-bk-walkin"),
      `<p class="field full df-bk-walkin" id="bkDropNote" hidden style="margin:-4px 0 0;color:#64748b;font-size:12.5px">Dropped at the hub: the sender's address is optional. A return comes back to the drop-off hub for the sender to collect.</p>`,
      bkField("bkSenderName", "Sender name", `<input id="bkSenderName" maxlength="120" autocomplete="off" placeholder="Walk-in sender's name">`, { cls: "df-bk-walkin" }),
      bkField("bkSenderPhone", "Sender phone", `<input id="bkSenderPhone">`, { cls: "df-bk-walkin" }),
      bkField("bkPickupDistrict", "Sender district", placeSelect("bkPickupDistrict"), { cls: "df-bk-walkin" }),
      bkField("bkPickupZone", "Sender zone", placeSelect("bkPickupZone"), { cls: "df-bk-walkin" }),
      bkField("bkPickupArea", "Sender area (optional)", placeSelect("bkPickupArea"), { cls: "df-bk-walkin" }),
      bkField("bkPickupStreet", "Sender address (pickup and returns)", `<input id="bkPickupStreet" maxlength="200" placeholder="House, road, flat">`, { cls: "df-bk-walkin" }),
      bkSection("Recipient"),
      bkField("bkRecipient", "Recipient name", `<input id="bkRecipient" maxlength="120" autocomplete="off" placeholder="Recipient name">`),
      bkField("bkPhone", "Recipient phone", `<input id="bkPhone">`),
      bkSection("Delivery address"),
      bkField("bkDistrict", "District", placeSelect("bkDistrict")),
      bkField("bkZone", "Zone", placeSelect("bkZone")),
      bkField("bkArea", "Area (optional)", placeSelect("bkArea")),
      bkField("bkStreet", "Street address", `<input id="bkStreet" maxlength="200" placeholder="House, road, flat">`, { full: true }),
      bkSection("Parcel"),
      bkField("bkSvcProduct", "Product (optional)", `<select id="bkSvcProduct"><option value="">No product (Regular)</option></select>`),
      bkField("bkWeight", "Weight (kg)", `<input id="bkWeight" type="number" min="0.01" max="50" step="0.1" value="0.5" inputmode="decimal">`, { cls: "df-bk-weight" }),
      bkField("bkContents", "Contents (optional)", `<input id="bkContents" maxlength="120">`),
      bkField("bkRef", "Order reference (optional)", `<input id="bkRef" maxlength="80">`),
      bkField("bkCn", "Pre-printed CN (optional)", `<input id="bkCn" maxlength="24" autocomplete="off" placeholder="Label from CN stock">`),
      `<div class="field full" id="bkPrice" aria-live="polite" style="font-size:13px;color:#637083"></div>`,
    ].join("");
  }

  /** Delivery / sender places from the catalog (active only): "Choose …" first, nothing preselected. */
  function cascade(prefix) {
    const c = Ops.catalog;
    const S = svcApi();
    if (!c || !S) return;
    const d = $(`${prefix}District`);
    const z = $(`${prefix}Zone`);
    const a = $(`${prefix}Area`);
    if (d && d.options.length <= 1) S.fill(d, c.districts || [], "Choose district");
    S.fill(z, c.zonesByDistrict?.[d?.value] || [], d?.value ? "Choose zone" : "Choose the district first");
    const areas = c.areasByZone?.[z?.value] || [];
    S.fill(a, areas, z?.value ? (areas.length ? "Choose area (optional)" : "No areas listed") : "Choose the zone first");
  }
  function cascadeAreas(prefix) {
    const c = Ops.catalog;
    const areas = c?.areasByZone?.[$(`${prefix}Zone`)?.value] || [];
    svcApi()?.fill($(`${prefix}Area`), areas, $(`${prefix}Zone`)?.value ? (areas.length ? "Choose area (optional)" : "No areas listed") : "Choose the zone first");
  }

  /** Shows the sender fields of the chosen line (merchant account, or the walk-in sender) and the weight (not Banking). */
  function applyLine() {
    const line = lineNow();
    booking.line = line;
    const walkIn = line === "walkin";
    for (const el of qa("#modalFields .df-bk-merchant")) el.hidden = walkIn;
    for (const el of qa("#modalFields .df-bk-walkin")) el.hidden = !walkIn;
    const weight = q("#modalFields .df-bk-weight");
    if (weight) weight.hidden = line === "banking";
    const contents = $("bkContents");
    if (contents) {
      contents.closest(".field").querySelector("label").textContent = line === "banking" ? "Item description (optional)" : "Contents (optional)";
      contents.placeholder = line === "banking" ? "e.g. Credit card for account ending 4821" : "e.g. 2 T-shirts";
    }
    $("modalTitle").textContent = LINE_TITLE[line] || "Create order";
    $("modalDescription").textContent = walkIn
      ? "Books a customer parcel for a walk-in sender (no merchant): picked up from the sender's address or dropped off at a hub. Priced with the Customer default package."
      : "Books the parcel for a merchant: picked up by a rider from the merchant's registered address, or dropped off at a hub. The price comes from the merchant's service package.";
    fillMerchants();
  }

  function fillMerchants() {
    const select = $("bkMerchant");
    if (!select) return;
    const line = lineNow();
    if (line === "walkin") return;
    const keep = select.value;
    // Every merchant belongs to the hub serving its pickup address; hub managers book for their hub's merchants.
    const mine = Ops.myHubs()?.map(h => h.id);
    const list = merchantsFor(line).filter(m => !mine || (m.pickupHub && mine.includes(m.pickupHub.id)));
    select.innerHTML = Ops.cache.merchants?.value
      ? `<option value="">${list.length ? "Choose the merchant" : mine ? "No active merchants of your hub for this category" : "No active merchants for this category"}</option>${list.map(m => `<option value="${m.id}">${esc(`${m.name} · ${m.code} · ${m.pickupHub?.name || "no hub"}`)}</option>`).join("")}`
      : `<option value="">Loading merchants…</option>`;
    select.value = list.some(m => m.id === keep) ? keep : list.length === 1 ? list[0].id : "";
    svcApi()?.searchable(select, { label: "merchants" });
  }

  /** The service chosen on the form (first / last mile…), once the package is loaded. */
  const serviceNow = () => (booking.pkg && svcApi() ? svcApi().read(booking.pkg, "bkSvc") : {});

  /** Red * on the fields the current choices make required; the sender's address is optional for a drop-off. */
  function markRequired() {
    const line = lineNow();
    const svc = serviceNow();
    const walkIn = line === "walkin";
    const drop = svc.firstMile === "HUB_DROP";
    const need = {
      bkMerchant: !walkIn,
      bkSenderName: walkIn,
      bkSenderPhone: walkIn,
      bkPickupDistrict: walkIn && !drop,
      bkPickupZone: walkIn && !drop,
      bkPickupStreet: walkIn && !drop,
      bkRecipient: true,
      bkPhone: true,
      bkDistrict: true,
      bkZone: true,
      bkStreet: svc.lastMile !== "HUB_COLLECT",
      bkWeight: line !== "banking",
      bkSvcDropHub: drop,
      bkSvcCodAmount: !!svc.cod,
    };
    for (const [id, on] of Object.entries(need)) $(id)?.closest(".field")?.classList.toggle("df-req", on);
    const street = $("bkPickupStreet")?.closest(".field")?.querySelector("label");
    if (street) street.textContent = drop ? "Sender address (optional)" : "Sender address (pickup and returns)";
    const delivery = $("bkStreet")?.closest(".field")?.querySelector("label");
    if (delivery) delivery.textContent = svc.lastMile === "HUB_COLLECT" ? "Street address (optional for Hub Pickup)" : "Street address";
    const note = $("bkDropNote");
    if (note) note.hidden = !(walkIn && drop);
  }

  /** Inline checks for the form's own fields; the package fields add theirs when they load. */
  function bookingChecks() {
    const rule = (id, fn) => {
      const el = $(id);
      return el ? DF.validate.field(el, () => (shown(el) ? fn(el.value.trim(), el) : "")) : null;
    };
    const required = message => v => (v ? "" : message);
    // Drop at hub: the sender's address is optional; Hub Pickup: the recipient's street is.
    const unlessDropOff = message => v => (v || serviceNow().firstMile === "HUB_DROP" ? "" : message);
    const list = [
      rule("bkMerchant", required("Choose the merchant account")),
      rule("bkSenderName", required("Enter the sender's name")),
      rule("bkPickupDistrict", unlessDropOff("Choose the sender's district")),
      rule("bkPickupZone", unlessDropOff("Choose the sender's zone")),
      rule("bkPickupStreet", unlessDropOff("Enter the sender's address")),
      rule("bkRecipient", required("Enter the recipient's name")),
      rule("bkDistrict", required("Choose the delivery district")),
      rule("bkZone", required("Choose the delivery zone")),
      rule("bkStreet", v => (v || serviceNow().lastMile === "HUB_COLLECT" ? "" : "Enter the street address")),
      rule("bkWeight", v => (!v ? "Enter the weight" : !(Number(v) >= 0.01) ? "At least 0.01 kg" : Number(v) > 50 ? "At most 50 kg" : "")),
      rule("bkCn", v => (!v || /^[A-Za-z]{2,4}-\d{6}-[0-9A-Za-z]{4,8}$/.test(v) ? "" : "Enter the consignment number printed on the label")),
    ].filter(Boolean);
    // The +880 phone fields check themselves (DF.phoneInput); a blur shows their message.
    const phones = ["bkSenderPhone", "bkPhone"].map(id => $(id)).filter(Boolean);
    return () => {
      let ok = list.map(check => check(true)).every(Boolean);
      for (const input of phones) {
        if (!shown(input)) continue;
        input.dispatchEvent(new Event("blur"));
        if (DF.phoneProblem(input.value)) ok = false;
      }
      return ok;
    };
  }

  async function openBooking(kind) {
    if (!Ops.require("dispatch", "book shipments")) return;
    const fixed = BOOKING_KINDS[kind];
    booking.line = fixed || (Ops.page?.() === "Customer parcels" ? "walkin" : Ops.page?.() === "Banking & Financial operations" ? "banking" : "ecommerce");
    booking.pkg = null;
    booking.pkgKey = "";
    modalContext = { kind: "booking", line: booking.line };
    $("modalSubmit").textContent = "Book order";
    $("modalFields").innerHTML = bookingFields(fixed);
    if ($("bkLine")) $("bkLine").value = booking.line;
    // Inline validation replaces the browser's checks (closeModal turns them back on).
    $("modalForm").noValidate = true;
    const modal = q("#modalBackdrop .modal");
    if (modal) modal.style.maxWidth = "min(680px, calc(100vw - 20px))";
    DF.phoneInput($("bkSenderPhone"));
    DF.phoneInput($("bkPhone"));
    DF.scanner?.attach($("bkCn"), { title: "Scan the CN label" });
    cascade("bk");
    cascade("bkPickup");
    applyLine();
    markRequired();
    booking.checks = [bookingChecks()];
    $("modalBackdrop").classList.add("open");
    void loadBookingPackage();
    if (!Ops.cache.merchants?.value) {
      try {
        Ops.cache.merchants = { value: await DF.api("/ops/merchants"), at: Date.now(), loading: false };
      } catch (error) {
        showToast(DF.describe(error));
      }
      fillMerchants();
      void loadBookingPackage();
    }
  }
  for (const kind of Object.keys(BOOKING_KINDS)) Ops.modals[kind] = () => openBooking(kind);
  // Customer parcels: the page's "New website pickup" link becomes the walk-in booking.
  window.addEventListener(
    "click",
    event => {
      const button = event.target.closest?.('[data-action="newWalkIn"]');
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void openBooking("newWalkIn");
    },
    true,
  );

  // ───────────── the sender's service package on the booking form (shared/order-services.js) ─────────────
  async function loadBookingPackage() {
    const S = svcApi();
    const box = $("bkServices");
    if (!box || !S) return;
    const line = lineNow();
    const merchantId = line === "walkin" ? "" : $("bkMerchant")?.value;
    const key = line === "walkin" ? "walkin" : merchantId;
    if (key === booking.pkgKey && booking.pkg) return;
    booking.pkg = null;
    booking.pkgKey = key;
    booking.checks = booking.checks.slice(0, 1);
    box.innerHTML = "";
    $("bkSvcProduct").innerHTML = `<option value="">No product (Regular)</option>`;
    $("bkPrice").textContent = key ? "Loading the service package…" : "Choose the merchant account to see its services and price.";
    if (!key) return;
    try {
      const view = await S.load(line === "walkin" ? "/packages/effective?segment=CUSTOMER" : `/packages/effective?merchantId=${encodeURIComponent(merchantId)}`);
      if (booking.pkgKey !== key || !$("bkServices")) return;
      booking.pkg = view;
      // Products of the category (active, with their type); the package's choices only.
      const product = $("bkSvcProduct");
      product.innerHTML = S.productOptions(view);
      const hubs = Ops.myHubs() || DF.state.hubs;
      box.innerHTML = S.block(view, { prefix: "bkSvc", fieldClass: "field", hubs, codAmount: true, codChecked: false, productSelect: "bkSvcProduct" });
      booking.checks.push(S.checks("bkSvc"));
      S.sync("bkSvc");
      markRequired();
      bookingQuote();
    } catch (error) {
      $("bkPrice").textContent = DF.describe(error);
    }
  }

  /** Under the merchant select: where the sender / pickup defaults come from (the merchant's primary pickup location). */
  function showMerchantPickup() {
    const box = $("bkMerchantPickup");
    const m = bookingMerchant();
    if (!box) return;
    box.textContent = m
      ? `Picks up from ${[m.pickupAddress, m.pickupZone && m.pickupArea === m.pickupZone ? "" : m.pickupArea, m.pickupZone, m.pickupDistrict].filter(Boolean).join(", ")} · ${m.pickupContactName || m.contactName} ${m.pickupContactPhone || m.contactPhone || ""}${m.pickupHub ? ` · hub ${m.pickupHub.name}` : ""}`
      : "";
  }

  /** The quote body: the same places and choices the booking sends (product included, so the price matches). */
  function bookingQuoteBody() {
    const line = lineNow();
    const svc = svcApi().read(booking.pkg, "bkSvc");
    const merchant = bookingMerchant();
    // A walk-in drop-off may have no sender address: it's priced from the drop-off hub.
    const dropHub = svc.firstMile === "HUB_DROP" ? (DF.state.hubs || []).find(h => h.id === svc.dropHubId) : null;
    const pickup =
      line === "walkin"
        ? $("bkPickupDistrict").value || !dropHub
          ? { pickupDistrict: $("bkPickupDistrict").value, pickupZone: $("bkPickupZone").value || undefined, pickupArea: $("bkPickupArea").value || undefined }
          : { pickupDistrict: dropHub.district, pickupZone: dropHub.zone || undefined }
        : { pickupDistrict: merchant?.pickupDistrict, pickupZone: merchant?.pickupZone || undefined };
    const { cod, codAmount, notifications, ...choices } = svc;
    return {
      ...(line === "walkin" ? {} : { merchantId: $("bkMerchant").value }),
      ...pickup,
      deliveryDistrict: $("bkDistrict").value,
      deliveryZone: $("bkZone").value,
      ...($("bkArea").value ? { deliveryArea: $("bkArea").value } : {}),
      ...(line === "banking" ? {} : { weightKg: Number($("bkWeight").value) || 0.5 }),
      codAmount: line === "banking" ? 0 : codAmount || 0,
      ...choices,
    };
  }

  let bookingQuoteTimer = null;
  function bookingQuote() {
    clearTimeout(bookingQuoteTimer);
    bookingQuoteTimer = setTimeout(async () => {
      const out = $("bkPrice");
      if (!out || !booking.pkg) return;
      const body = bookingQuoteBody();
      if (!body.pickupDistrict || !body.deliveryDistrict) {
        out.textContent = lineNow() === "walkin" && !body.pickupDistrict ? "Choose the sender's district and the delivery district to see the price." : "Choose the delivery district to see the price.";
        return;
      }
      const seq = ++booking.quoteSeq;
      try {
        const quote = await DF.api("/packages/quote", { method: "POST", body });
        if (seq === booking.quoteSeq) out.innerHTML = svcApi().breakdown(quote);
      } catch (error) {
        if (seq === booking.quoteSeq) out.textContent = DF.describe(error);
      }
    }, 300);
  }

  window.addEventListener("change", event => {
    if (modalContext.kind !== "booking" || !event.target.closest?.("#modalFields")) return;
    const id = event.target.id;
    if (id === "bkLine") {
      applyLine();
      markRequired();
      return void loadBookingPackage();
    }
    if (id === "bkMerchant") return void (showMerchantPickup(), loadBookingPackage());
    if (id === "bkDistrict" || id === "bkPickupDistrict") cascade(id === "bkDistrict" ? "bk" : "bkPickup");
    if (id === "bkZone" || id === "bkPickupZone") cascadeAreas(id === "bkZone" ? "bk" : "bkPickup");
    svcApi()?.sync("bkSvc");
    markRequired();
    bookingQuote();
  });
  window.addEventListener("input", event => {
    if (modalContext.kind === "booking" && ["bkWeight", "bkSvcCodAmount"].includes(event.target.id)) bookingQuote();
  });

  window.addEventListener(
    "submit",
    event => {
      if (event.target.id !== "modalForm" || modalContext.kind !== "booking") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const valid = booking.checks.map(check => check()).every(Boolean);
      if (!valid) {
        q("#modalFields [aria-invalid=true]")?.focus();
        return void showToast("Check the highlighted fields.");
      }
      if (!booking.pkg) return void showToast(lineNow() === "walkin" ? "The Customer package is still loading. Try again in a moment." : "Choose the merchant account.");
      const line = lineNow();
      const merchant = line === "walkin" ? null : bookingMerchant();
      const { cod, codAmount = 0, firstMile, dropHubId, ...choices } = svcApi().read(booking.pkg, "bkSvc");
      const dropOff = firstMile === "HUB_DROP";
      const pickupArea = $("bkPickupArea").value || undefined;
      const body = {
        ...(merchant
          ? { merchantId: merchant.id }
          : {
              sender: { name: $("bkSenderName").value.trim(), phone: $("bkSenderPhone").value.trim() },
              ...(dropOff && !$("bkPickupStreet").value.trim()
                ? {}
                : { pickup: { category: "HOME", street: $("bkPickupStreet").value.trim(), area: pickupArea, zone: $("bkPickupZone").value, district: $("bkPickupDistrict").value } }),
            }),
        // Drop at hub is the hub drop-off intake (the hub receive desk expects it); other first miles go as chosen.
        intake: dropOff ? "DROP_OFF" : "PICKUP",
        ...(dropOff ? { dropOffHubId: dropHubId } : { firstMile }),
        recipient: { name: $("bkRecipient").value.trim(), phone: $("bkPhone").value.trim() },
        delivery: { category: "HOME", street: $("bkStreet").value.trim(), area: $("bkArea").value || undefined, zone: $("bkZone").value, district: $("bkDistrict").value },
        type: line === "banking" ? "DOCUMENT" : line === "ecommerce" ? "ECOMMERCE" : "PARCEL",
        // Banking & Financial has no weight in pricing: the API needs one, 0.5 kg (the included weight).
        weightKg: line === "banking" ? 0.5 : Number($("bkWeight").value),
        codAmount: line === "banking" ? 0 : codAmount,
        ...choices,
        contents: $("bkContents").value.trim() || undefined,
        merchantOrderRef: $("bkRef").value.trim() || undefined,
        cn: $("bkCn")?.value.trim().toUpperCase() || undefined,
      };
      const button = $("modalSubmit");
      button.disabled = true;
      DF.api("/ops/parcels", { method: "POST", body })
        .then(async parcel => {
          closeModal();
          await Ops.refresh().catch(() => undefined);
          Ops.upsertParcels?.([parcel]);
          render(LINE_PAGE[line]);
          // The new parcel's drawer: its details, price breakdown and "Print label".
          Ops.drawer?.open(parcel.trackingId);
          const who = parcel.merchant?.name || `${parcel.sender?.name || body.sender?.name} (walk-in)`;
          const next = parcel.intake === "DROP_OFF" ? `${parcel.statusLabel.toLowerCase()} at ${parcel.dropOffHub?.name || "the hub"}. Print the label from the parcel panel.` : "Assign a pickup rider in Dispatch.";
          showToast(`${parcel.trackingId} booked for ${who} · charge ৳${parcel.charges.total} · ${next}`);
        })
        .catch(error => showToast(DF.describe(error)))
        .finally(() => (button.disabled = false));
    },
    true,
  );

  // Excel / CSV import: shared/importer.js (one import engine for merchants and operations), wired in bridge-imports.js.
})();
