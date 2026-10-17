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
 *   New shipment                                    POST /ops/parcels (Excel import: bridge-imports.js)
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
    genericPages.Merchants.cols = ["MERCHANT", "ACCOUNT ID", "PACKAGE", "SHIPMENTS MTD", ...(showCycle ? ["COD CYCLE"] : []), "ACCOUNT OWNER", "STATUS"];
    const cycleOf = m => {
      if (!schedules) return Ops.lazyError("fin-schedules") ? "—" : "…";
      const s = schedules.find(x => x.merchant.id === m.id);
      return s ? `${CYCLE[s.cycle] || s.cycle}${s.weekdayLabel ? ` · ${s.weekdayLabel}` : ""}` : "Manual";
    };
    genericPages.Merchants.rows = (loadMerchants() || []).map(m => [
      `${m.name} · ${m.type === "BANKING_FINANCIAL" ? "Banking & Financial" : "E-commerce"}`,
      m.code,
      m.package ? `${m.package.name}${m.package.isDefault ? " (default)" : ""}` : "Default package",
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
      ["Hubs & zones", `${DF.state.hubs.length} active hubs${zones ? ` · ${zones} catalog zones` : ""}. Hub register, capacity, delivery zones and routes.`, allowed.has("Hubs & zones") ? `<button class="button button-sm" type="button" data-settings-open="Hubs & zones">Open Hubs & zones</button>` : ""],
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

  // ───────────── bookings by operations ─────────────

  const BOOKING_KINDS = { newShipment: "", newEcommerce: "E-commerce", newDomestic: "Documents", newDocument: "Documents" };
  const merchantsFor = line =>
    (Ops.cache.merchants?.value || []).filter(m => m.status === "ACTIVE" && (!line || (line === "Documents") === (m.type === "BANKING_FINANCIAL")));

  function fillZones() {
    const c = Ops.catalog;
    const district = $("bkDistrict")?.value;
    if (!c || !$("bkZone")) return;
    $("bkZone").innerHTML = (c.zonesByDistrict[district] || []).map(z => `<option>${esc(z)}</option>`).join("");
  }
  function fillMerchants() {
    const line = $("bkLine")?.value || modalContext.line;
    const select = $("bkMerchant");
    if (!select) return;
    const list = merchantsFor(line);
    select.innerHTML = list.length ? list.map(m => `<option value="${m.id}">${esc(`${m.name} · ${m.code}`)}</option>`).join("") : `<option value="">${Ops.cache.merchants ? "No active merchants for this service line" : "Loading merchants…"}</option>`;
    const cod = $("bkCod");
    if (cod) {
      cod.disabled = line === "Documents";
      if (line === "Documents") cod.value = "0";
    }
  }

  async function openBooking(kind) {
    if (!Ops.require("dispatch", "book shipments")) return;
    const fixed = BOOKING_KINDS[kind];
    const c = Ops.catalog;
    modalContext = { kind: "booking", line: fixed || "E-commerce" };
    $("modalTitle").textContent = fixed === "Documents" ? "Create document shipment" : fixed ? "Create e-commerce shipment" : "Create shipment";
    $("modalDescription").textContent = "Books the parcel for a merchant: picked up by a rider from the merchant's registered address, or dropped off at a hub by the merchant. The price comes from the merchant's service package either way.";
    $("modalSubmit").textContent = "Book shipment";
    const levels = Object.entries(c?.serviceLevels || { REGULAR: "Regular", SAME_DAY: "Same day", EXPRESS: "Express" });
    $("modalFields").innerHTML = `${fixed ? "" : `<div class="field"><label for="bkLine">Service line</label><select id="bkLine"><option>E-commerce</option><option>Documents</option></select></div>`}<div class="field ${fixed ? "full" : ""}"><label for="bkMerchant">Merchant / account</label><select id="bkMerchant" required></select></div><div class="field"><label for="bkRecipient">Recipient name</label><input id="bkRecipient" required maxlength="120" placeholder="Recipient name"></div><div class="field"><label for="bkPhone">Recipient phone</label><input id="bkPhone" required inputmode="tel" placeholder="01XXXXXXXXX"></div><div class="field"><label for="bkDistrict">District</label><select id="bkDistrict">${(c?.districts || []).map(d => `<option>${esc(d)}</option>`).join("")}</select></div><div class="field"><label for="bkZone">Zone</label><select id="bkZone"></select></div><div class="field full"><label for="bkStreet">Street address</label><input id="bkStreet" required maxlength="200" placeholder="House, road, flat"></div><div class="field"><label for="bkArea">Area / landmark (optional)</label><input id="bkArea" maxlength="120"></div><div class="field"><label for="bkLevel">Service level</label><select id="bkLevel">${levels.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select></div><div class="field"><label for="bkWeight">Weight (kg)</label><input id="bkWeight" type="number" min="0.1" max="50" step="0.1" value="1" required></div><div class="field"><label for="bkCod">COD amount (৳)</label><input id="bkCod" type="number" min="0" step="1" value="0"></div><div class="field"><label for="bkContents">${fixed === "Documents" ? "Document type" : "Contents"}</label><input id="bkContents" maxlength="120" placeholder="${fixed === "Documents" ? "e.g. Contract" : "e.g. Clothing"}"></div><div class="field"><label for="bkRef">Order reference (optional)</label><input id="bkRef" maxlength="80"></div><div class="field"><label for="bkCn">Pre-printed CN (optional)</label><input id="bkCn" maxlength="24" autocomplete="off" placeholder="Label from CN stock"></div>${Ops.intake ? Ops.intake.fields("bk") : ""}<div id="bkServices" style="display:contents"></div><div class="field full" id="bkPrice" aria-live="polite" style="font-size:13px;color:#637083"></div>`;
    Ops.intake?.wire("bk");
    DF.scanner?.attach($("bkCn"), { title: "Scan the CN label" });
    $("bkDistrict")?.addEventListener("change", fillZones);
    $("bkLine")?.addEventListener("change", fillMerchants);
    fillZones();
    fillMerchants();
    void loadBookingPackage();
    $("modalBackdrop").classList.add("open");
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

  // ───────────── the merchant's service package on the booking form (shared/order-services.js) ─────────────
  let bookingPkg = null;
  async function loadBookingPackage() {
    const merchantId = $("bkMerchant")?.value;
    const box = $("bkServices");
    if (!box || !window.DFOrderServices) return;
    bookingPkg = null;
    box.innerHTML = "";
    if (!merchantId) return;
    try {
      const view = await window.DFOrderServices.load(`/packages/effective?merchantId=${encodeURIComponent(merchantId)}`);
      if ($("bkMerchant")?.value !== merchantId) return;
      bookingPkg = view;
      box.innerHTML = window.DFOrderServices.block(view, { prefix: "bkSvc", firstMile: false, product: true });
      // The package choices make the form taller than small screens: the modal scrolls.
      const modal = box.closest(".modal");
      if (modal) Object.assign(modal.style, { maxHeight: "calc(100vh - 40px)", overflowY: "auto" });
      // COD only when the package offers it; the service level follows the Service choice.
      const cod = $("bkCod");
      if (cod && !view.options.cod) cod.value = "0";
      if (cod) cod.closest(".field").hidden = !view.options.cod;
      const level = $("bkLevel")?.closest(".field");
      if (level) level.hidden = true;
      window.DFOrderServices.sync("bkSvc");
      bookingQuote();
    } catch (error) {
      showToast(DF.describe(error));
    }
  }
  let bookingQuoteTimer = null;
  function bookingQuote() {
    clearTimeout(bookingQuoteTimer);
    bookingQuoteTimer = setTimeout(async () => {
      const out = $("bkPrice");
      if (!out || !bookingPkg || !$("bkZone")?.value) return;
      const merchant = (Ops.cache.merchants?.value || []).find(m => m.id === $("bkMerchant").value);
      const svc = window.DFOrderServices.read(bookingPkg, "bkSvc");
      let intake = { intake: "PICKUP" };
      try {
        intake = Ops.intake ? Ops.intake.read("bk") : intake;
      } catch {}
      try {
        const quote = await DF.api("/packages/quote", {
          method: "POST",
          body: {
            merchantId: $("bkMerchant").value,
            pickupDistrict: merchant?.pickupDistrict || $("bkDistrict").value,
            pickupZone: merchant?.pickupZone || merchant?.pickupArea || $("bkZone").value,
            deliveryDistrict: $("bkDistrict").value,
            deliveryZone: $("bkZone").value,
            weightKg: Number($("bkWeight").value) || 1,
            codAmount: bookingPkg.options.cod && svc.cod ? Number($("bkCod").value) || 0 : 0,
            ...(intake.intake === "DROP_OFF" && intake.dropOffHubId ? { dropOffHubId: intake.dropOffHubId } : svc.firstMile ? { firstMile: svc.firstMile } : {}),
            lastMile: svc.lastMile,
            ...(svc.collectHubId ? { collectHubId: svc.collectHubId } : {}),
            speed: svc.speed,
            openBox: svc.openBox,
          },
        });
        out.innerHTML = window.DFOrderServices.breakdown(quote);
      } catch (error) {
        out.textContent = DF.describe(error);
      }
    }, 300);
  }
  window.addEventListener("change", event => {
    if (modalContext.kind !== "booking" || !event.target.closest?.("#modalFields")) return;
    if (event.target.id === "bkMerchant" || event.target.id === "bkLine") return void setTimeout(loadBookingPackage);
    window.DFOrderServices?.sync("bkSvc");
    bookingQuote();
  });
  window.addEventListener("input", event => {
    if (modalContext.kind === "booking" && event.target.closest?.("#modalFields")) bookingQuote();
  });

  window.addEventListener(
    "submit",
    event => {
      if (event.target.id !== "modalForm" || modalContext.kind !== "booking") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const line = $("bkLine")?.value || modalContext.line;
      const merchantId = $("bkMerchant").value;
      if (!merchantId) return void showToast("Choose the merchant account.");
      const area = $("bkArea").value.trim();
      let intake;
      try {
        intake = Ops.intake ? Ops.intake.read("bk") : { intake: "PICKUP" };
      } catch (error) {
        return void showToast(error.message);
      }
      const body = {
        merchantId,
        intake: intake.intake,
        dropOffHubId: intake.dropOffHubId,
        recipient: { name: $("bkRecipient").value.trim(), phone: $("bkPhone").value.trim() },
        delivery: { category: "HOME", street: $("bkStreet").value.trim(), area: area || undefined, zone: $("bkZone").value, district: $("bkDistrict").value },
        type: line === "Documents" ? "DOCUMENT" : "ECOMMERCE",
        serviceLevel: $("bkLevel").value,
        weightKg: Number($("bkWeight").value),
        codAmount: line === "Documents" ? 0 : Number($("bkCod").value) || 0,
        // The merchant's service package choices (last mile, speed + handling, open box, product, messages).
        ...(bookingPkg ? bookingChoices(intake) : {}),
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
          render(line === "Documents" ? "Banking & Financial operations" : "E-commerce operations");
          if (parcel.intake === "DROP_OFF") {
            showToast(`${parcel.trackingId} booked for ${parcel.merchant?.name} · charge ৳${parcel.charges.total} · ${parcel.statusLabel.toLowerCase()}.`);
            Ops.labels?.open([parcel.trackingId], { title: "Print the label", description: `${parcel.trackingId} · stick the label on the parcel, then receive it at ${parcel.dropOffHub?.name || "the hub"}.` });
          } else showToast(`${parcel.trackingId} booked for ${parcel.merchant?.name} · charge ৳${parcel.charges.total}. Assign a pickup rider in Dispatch.`);
        })
        .catch(error => showToast(DF.describe(error)))
        .finally(() => (button.disabled = false));
    },
    true,
  );

  function bookingChoices(intake) {
    const { cod, firstMile, ...svc } = window.DFOrderServices.read(bookingPkg, "bkSvc");
    return { ...svc, ...(intake.intake !== "DROP_OFF" && firstMile ? { firstMile } : {}), ...(cod ? {} : { codAmount: 0 }) };
  }

  // Excel / CSV import: shared/importer.js (one import engine for merchants and operations), wired in bridge-imports.js.
})();
