/*
 * Connects the two merchant panels (ecommerce-merchant, banking-merchant) to the API.
 * Loaded after the original page scripts; each panel's bridge.js calls
 * DFMerchantPanel.start({...}) with its differences.
 *
 * - Workspace and signed-in user from GET /merchants/me (members of several merchants
 *   choose one; a merchant opened in the other panel is sent to the right one).
 * - Orders, shipments, pickups, recipients and COD rows from GET /parcels (this merchant),
 *   replacing the sample arrays the page scripts render (sampleOrders, pageData).
 * - Dashboard counters and the orders chart from GET /merchants/me/stats.
 * - Booking through POST /parcels with an Idempotency-Key (Excel/CSV batches: shared/importer.js),
 *   priced on the server; the form shows POST /merchants/me/quote as a preview.
 * - Cancel, tracking history, labels and invoices from real parcels.
 * - Invoices (GET /invoices), settlements (GET /settlements), API keys, webhooks,
 *   profile, payout account and team (/merchants/me/...).
 *
 * The page scripts keep rendering; this file swaps their data and handles their actions
 * in capture-phase listeners on window, which run before the original handlers.
 */
(() => {
  const DF = window.DF;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const PARCEL_CAP = 1000; // newest parcels kept in the browser; counters come from the server
  const PAGE_SIZE = 25;
  const AWAITING_PICKUP = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];
  const IN_TRANSIT = ["PICKED_UP", "AT_HUB", "IN_TRANSIT", "ASSIGNED", "OUT_FOR_DELIVERY"];
  const NEEDS_ATTENTION = ["EXCEPTION", "RETRY_SCHEDULED", "RETURN_SCHEDULED"];
  const TERMINAL = ["DELIVERED", "PICKUP_CANCELLED", "RETURNED"];
  const TYPE_LABEL = { ECOMMERCE: "E-commerce parcel", DOCUMENT: "Document delivery", PARCEL: "Domestic parcel", FRAGILE: "Fragile parcel" };
  const WEBHOOK_EVENTS = [
    "pickup.requested",
    "pickup.scheduled",
    "pickup.completed",
    "pickup.cancelled",
    "pickup.missed",
    "shipment.status_updated",
    "shipment.out_for_delivery",
    "shipment.delivered",
    "shipment.delivery_failed",
    "shipment.cancelled",
    "shipment.return_requested",
    "shipment.return_scheduled",
    "shipment.returned",
    "shipment.return_received",
    "cod.settled",
    "invoice.issued",
  ];
  const API_KEY_SCOPES = [
    ["parcels:read", "Read parcels and tracking"],
    ["parcels:write", "Book parcels (single and imports)"],
    ["parcels:cancel", "Cancel parcels"],
    ["returns:write", "Request returns"],
    ["webhooks:manage", "Manage webhooks"],
  ];
  const MERCHANT_STATUS = { ACTIVE: "Active", PENDING_REVIEW: "Pending review", INFO_REQUESTED: "Information requested", REJECTED: "Not approved", SUSPENDED: "Suspended" };
  const KYC_STATUS = { NOT_SUBMITTED: "Not submitted", PENDING: "Under review", APPROVED: "Verified", REJECTED: "Not approved" };
  const PAYOUT_LABEL = { BKASH: "bKash", NAGAD: "Nagad", BANK: "Bank account" };
  const COD_STATE = { WITH_RIDER: "With rider", AT_HUB: "At hub · processing", SETTLED: "Paid" };
  const SETTLEMENT_STATUS = { DRAFT: "Pending approval", APPROVED: "Approved · processing", PAID: "Paid" };
  /** Pages whose content comes from parcels (re-rendered when the data changes). */
  const DATA_PAGES = new Set(["Overview", "Orders", "Shipments", "Pickup requests", "Customers", "Payments", "Reports", "Settings", "Billing"]);

  const S = {
    cfg: null,
    merchant: null,
    workspaces: [],
    catalog: null,
    stats: null,
    period: "7d",
    parcels: [],
    truncated: false,
    signature: "",
    invoices: [],
    settlements: [],
    keys: null,
    webhooks: null,
    members: null,
    integrationError: null,
    revealed: null,
    returnPercent: null,
    page: "Overview",
    pageNo: 1,
    dirty: false,
  };
  const byId = id => S.parcels.find(p => p.trackingId === id);
  const isOwner = () => S.merchant?.myRole === "MERCHANT_OWNER";
  const q = (sep = "?") => (S.merchant ? `${sep}merchantId=${S.merchant.id}` : "");

  // ───────────── not active ─────────────
  //
  // Until the merchant account is active (under review, information requested, not approved, suspended) the panel
  // is a single screen, "Account verification" (shared/merchant-verification.js): the status, business
  // verification uploads, messages from Delivery Fast and the read-only profile. No menu, search or bell; every
  // page asked for (menu, address, link) opens that screen. The API refuses the rest (MERCHANT_NOT_ACTIVE).
  const VERIFY_PAGE = "Account verification";
  const locked = () => !!S.merchant && S.merchant.status !== "ACTIVE";
  const applyLock = () => document.body.classList.toggle("df-merchant-locked", locked());

  // ───────────── formatting ─────────────

  const taka = n => `৳ ${(Math.round(Number(n || 0) * 100) / 100).toLocaleString("en-BD")}`;
  const timeOf = d => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  function when(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000);
    if (sameDay(d, now)) return `Today, ${timeOf(d)}`;
    if (sameDay(d, yesterday)) return `Yesterday, ${timeOf(d)}`;
    const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
    return d.getFullYear() === now.getFullYear() ? `${date}, ${timeOf(d)}` : date;
  }
  const shortWhen = iso => {
    if (!iso) return "—";
    const d = new Date(iso);
    return sameDay(d, new Date()) ? timeOf(d) : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  const dateOnly = iso => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
  /** Local calendar date as YYYY-MM-DD (what the page's date filters compare). */
  const dayKey = iso => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  function ago(iso) {
    const d = new Date(iso);
    const minutes = Math.round((Date.now() - d.getTime()) / 60_000);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    if (minutes < 24 * 60 && sameDay(d, new Date())) return `${Math.round(minutes / 60)} hour${Math.round(minutes / 60) === 1 ? "" : "s"} ago`;
    if (sameDay(d, new Date(Date.now() - 86_400_000))) return `Yesterday at ${timeOf(d)}`;
    return when(iso);
  }
  /** +8801712345678 -> +880 1712-345678 */
  const phone = p => {
    const m = String(p || "").match(/^\+880(\d{4})(\d{6})$/);
    return m ? `+880 ${m[1]}-${m[2]}` : p || "";
  };
  const initials = name =>
    String(name || "?")
      .split(/\s+/)
      .filter(Boolean)
      .map(part => part[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();
  const pct = (n, digits = 1) => (n === null || n === undefined ? "—" : `${Number(n).toFixed(digits)}%`);
  function trend(current, previous) {
    if (!previous) return { text: "", down: false };
    const change = ((current - previous) / previous) * 100;
    return { text: `${change >= 0 ? "↑" : "↓"} ${Math.abs(change).toFixed(1)}%`, down: change < 0 };
  }
  const shortAddress = p => [p.area, p.zone, p.district].filter(Boolean).join(", ");

  // Older bookings carried these two fields inside `instructions`; they are real parcel fields now.
  const META = { relation: "Receiver relationship", branch: "Origin branch" };
  function parseInstructions(text) {
    const out = {};
    for (const [key, label] of Object.entries(META)) {
      const match = String(text || "").match(new RegExp(`${label}: ([^·]+)`));
      if (match) out[key] = match[1].trim();
    }
    return out;
  }
  /** Receiver relationship and origin branch: the parcel fields, else the legacy text in instructions. */
  function metaOf(p) {
    const legacy = parseInstructions(p.instructions);
    return { relation: p.receiverRelation || legacy.relation || "", branch: p.originBranchCode || legacy.branch || "" };
  }
  /** Documents store "Document type — item" in `contents`. */
  const splitContents = contents => {
    const [type, item] = String(contents || "").split(" — ");
    return [type || "", item || type || ""];
  };

  // ───────────── parcels → the page's record shapes ─────────────

  function billedInvoice(p) {
    if (!p.deliveredAt || p.cod) return null;
    const t = new Date(p.deliveredAt).getTime();
    return S.invoices.find(i => i.status !== "VOID" && (i.trackingIds ? i.trackingIds.includes(p.trackingId) : new Date(i.periodStart).getTime() <= t && t < new Date(i.periodEnd).getTime())) || null;
  }

  function toOrder(p) {
    const doc = p.type === "DOCUMENT";
    const meta = metaOf(p);
    const [documentType, documentItem] = doc ? splitContents(p.contents) : ["", ""];
    const value = p.codAmount > 0 ? p.codAmount : p.declaredValue || 0;
    const c = p.charges;
    const returnPercent = S.returnPercent ?? 50;
    return {
      id: p.trackingId,
      // Imported orders may still miss recipient details ("Needs info").
      name: p.recipient.name || "Recipient not set",
      initials: initials(p.recipient.name || "?"),
      phone: phone(p.recipient.phone),
      item: doc ? documentType || "Business document" : p.contents || TYPE_LABEL[p.type],
      type: TYPE_LABEL[p.type] || "Domestic parcel",
      date: when(p.createdAt),
      pickupDate: dayKey(p.createdAt),
      statusUpdatedAt: dayKey(p.updatedAt),
      updatedAt: dayKey(p.updatedAt),
      amount: S.cfg.document ? taka(c.total) : taka(value),
      status: p.statusLabel,
      address: p.delivery.label,
      recipientRelation: meta.relation || "",
      service: p.serviceLevelLabel,
      weight: doc ? null : p.weightKg,
      documentType: doc ? documentType : "",
      packaging: p.packaging || "",
      product: doc ? documentItem : p.contents || "",
      deliveryFee: c.total,
      declaredValue: p.declaredValue || 0,
      chargeBreakdown: { base: c.base, weight: c.weight, service: c.service, cod: c.codFee, discount: c.discount, return: Math.ceil((c.total * returnPercent) / 100), total: c.total },
      branchCode: meta.branch || "",
      referenceNo: p.merchantOrderRef || "",
      billedInvoiceId: billedInvoice(p)?.number || "",
    };
  }

  const lastEvent = p => p.events[p.events.length - 1];
  function toShipmentRow(p) {
    const doc = p.type === "DOCUMENT";
    const event = lastEvent(p);
    return [
      p.trackingId,
      p.recipient.name,
      doc ? splitContents(p.contents)[0] || "Business document" : TYPE_LABEL[p.type],
      [p.delivery.zone, p.delivery.district].filter(Boolean).join(", "),
      event ? `${event.title} · ${shortWhen(event.at)}` : shortWhen(p.updatedAt),
      p.statusLabel,
    ];
  }

  function pickupStatus(p) {
    if (AWAITING_PICKUP.includes(p.status) || p.status === "PICKUP_CANCELLED") return p.statusLabel;
    if (p.status === "EXCEPTION" && !p.pickedUpAt) return p.statusLabel;
    return "Picked up";
  }
  function toPickupRow(p) {
    const doc = p.type === "DOCUMENT";
    const meta = metaOf(p);
    return [
      p.trackingId,
      S.cfg.document ? meta.branch || p.sender.name : p.sender.name,
      shortAddress(p.pickup),
      doc ? "1 document" : "1 parcel",
      when(p.createdAt),
      pickupStatus(p),
    ];
  }

  function customerRows() {
    const groups = new Map();
    for (const p of S.parcels) {
      if (p.status === "PICKUP_CANCELLED" || !p.recipient.phone) continue;
      const g = groups.get(p.recipient.phone) || { name: p.recipient.name, phone: p.recipient.phone, count: 0, value: 0, last: p.createdAt, lastDelivered: null, branch: "" };
      g.count++;
      g.value += p.codAmount > 0 ? p.codAmount : p.declaredValue || 0;
      if (p.createdAt > g.last) g.last = p.createdAt;
      if (p.deliveredAt && (!g.lastDelivered || p.deliveredAt > g.lastDelivered)) g.lastDelivered = p.deliveredAt;
      if (!g.branch) g.branch = metaOf(p).branch;
      groups.set(p.recipient.phone, g);
    }
    const rows = [...groups.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
    return S.cfg.document
      ? rows.map(g => [g.name, phone(g.phone), String(g.count), g.branch || "—", g.lastDelivered ? when(g.lastDelivered) : "Not delivered yet", "Active"])
      : rows.map(g => [g.name, phone(g.phone), String(g.count), taka(g.value), when(g.last), "Active"]);
  }

  /** Payments › quick filter: "all" | "payout" | "cod" | "invoice". */
  const PAY_KINDS = [
    ["all", "All"],
    ["payout", "Payouts"],
    ["cod", "Cash on delivery"],
    ["invoice", "Invoices"],
  ];
  function paymentRows() {
    const kind = S.payKind || "all";
    const rows = [];
    if (!S.cfg.document) {
      for (const p of S.parcels) {
        if (!p.cod) continue;
        const settlement = p.cod.state === "SETTLED" ? "Settled" : "Pending settlement";
        rows.push({ kind: "cod", at: p.cod.collectedAt, row: [settlement, p.trackingId, "Cash on delivery", when(p.cod.collectedAt), taka(p.cod.amount), COD_STATE[p.cod.state] || p.cod.state] });
      }
      for (const s of S.settlements)
        rows.push({ kind: "payout", at: s.paidAt || s.createdAt, row: [s.number, `${s.collectionCount} order${s.collectionCount === 1 ? "" : "s"}`, "Merchant payout", when(s.paidAt || s.createdAt), taka(s.netPayable), SETTLEMENT_STATUS[s.status] || s.status] });
    }
    for (const i of S.invoices) {
      const status = i.status === "PAID" ? "Paid" : i.status === "VOID" ? "Void (cancelled)" : i.overdue ? "Overdue" : "Pending payment";
      rows.push({
        kind: "invoice",
        at: i.paidAt || i.issuedAt,
        row: [i.status === "PAID" ? "Invoice payment" : "Invoice issued", i.number, S.cfg.document ? "Corporate account billing" : "Delivery invoice", when(i.paidAt || i.issuedAt), taka(i.subtotal), status],
      });
    }
    return rows
      .filter(r => kind === "all" || r.kind === kind)
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .map(r => r.row);
  }

  /**
   * Payments page: the summary cards fill the row, a real quick filter (All · Payouts · Cash on delivery ·
   * Invoices) instead of the placeholder Filter button, and (e-commerce) where payouts are paid.
   */
  function decoratePayments() {
    const main = $("mainContent");
    const metrics = main.querySelector(".metrics");
    if (metrics) metrics.style.gridTemplateColumns = "repeat(auto-fit,minmax(220px,1fr))";
    const placeholder = main.querySelector(".page-table-panel .table-tools button[data-toast]");
    const kinds = S.cfg.document ? PAY_KINDS.filter(([k]) => k !== "payout" && k !== "cod") : PAY_KINDS;
    if (placeholder && kinds.length > 2)
      placeholder.outerHTML = `<div class="df-pay-kinds" role="group" aria-label="Show">${kinds
        .map(([k, label]) => `<button type="button" class="button button-sm${(S.payKind || "all") === k ? " button-primary" : ""}" data-df-pay-kind="${k}" aria-pressed="${(S.payKind || "all") === k}">${esc(label)}</button>`)
        .join("")}</div>`;
    else placeholder?.remove();
    // Where COD payouts go (e-commerce owners): the payout account, changed from here too.
    if (!S.cfg.document && isOwner() && metrics && !$("dfPaidTo")) {
      const a = S.merchant?.payoutAccount;
      const text = a
        ? `<strong>${esc(PAYOUT_LABEL[a.method] || a.method)} · ••••${esc(String(a.accountNumber).slice(-4))}</strong><span>${esc(a.accountName)}${a.bankName ? ` · ${esc(a.bankName)}` : ""}${a.routingNumber ? ` · routing ${esc(a.routingNumber)}` : ""}</span>`
        : `<strong>No payout account yet</strong><span>Add one so finance can pay your COD to you.</span>`;
      metrics.insertAdjacentHTML(
        "afterend",
        `<section class="panel df-paid-to${a ? "" : " df-paid-to-missing"}" id="dfPaidTo"><div class="df-paid-to-icon" aria-hidden="true">৳</div><div class="df-paid-to-copy"><small>You're paid to</small>${text}</div><button type="button" class="button${a ? "" : " button-primary"}" data-df-payout-edit>${a ? "Change" : "Add payout account"}</button></section>`,
      );
    }
  }

  function settingsRows() {
    const m = S.merchant;
    // The service package in force (GET /packages/me); prices and services come from it.
    const pk = S.pkg?.package;
    const plan = pk ? `${pk.name} · version ${pk.version}${pk.isDefault ? " (default)" : ""}` : "Your service package";
    const payout = m.payoutAccount
      ? `${PAYOUT_LABEL[m.payoutAccount.method] || m.payoutAccount.method} · ••••${String(m.payoutAccount.accountNumber).slice(-4)} · ${m.payoutAccount.accountName}`
      : "Not set · add one to receive COD payouts";
    const team = S.members ? `${S.members.length} team member${S.members.length === 1 ? "" : "s"} · ${new Set(S.members.map(x => x.role)).size} role(s)` : isOwner() ? "Loading…" : "Managed by workspace owners";
    const activeKeys = S.keys ? S.keys.filter(k => !k.revokedAt).length : 0;
    const integrations = S.keys || S.webhooks ? `${activeKeys} active API key${activeKeys === 1 ? "" : "s"} · ${S.webhooks?.length ?? 0} webhook${S.webhooks?.length === 1 ? "" : "s"}` : "API keys and webhooks";
    // Structured address (pickup zone, district); older free-text addresses ask to be completed.
    const where = m.addressComplete === false ? `${m.pickupArea}, ${m.pickupDistrict} · complete your address` : `${m.pickup?.zone || m.pickupArea}, ${m.pickupDistrict}${m.pickupHub ? ` · hub ${m.pickupHub.name}` : ""}`;
    const profile = [S.cfg.document ? "Corporate account" : "Store profile", `${m.name} · ${where}`, dateOnly(m.updatedAt), "Manage"];
    const rows = [profile];
    if (S.cfg.document) rows.push(["Billing profile", "Monthly consolidated invoices · due 15 days after issue", "—", "Manage"]);
    else rows.push(["Payout account", payout, "—", "Manage"]);
    rows.push(["Service package", plan, "—", "Manage"]);
    rows.push(["Business verification", `${KYC_STATUS[m.kyc?.status] || "Not submitted"}${m.kyc?.status === "REJECTED" && m.kyc.rejectionReason ? ` · ${m.kyc.rejectionReason}` : " · trade license, owner NID and payout proof"}`, dateOnly(m.kyc?.reviewedAt || m.kyc?.submittedAt), "Manage"]);
    rows.push(["Notification settings", `SMS updates to ${phone(m.contactPhone)} · choose which messages you get`, "—", "Manage"]);
    rows.push(["Team & permissions", team, "—", "Manage"]);
    rows.push(["API & integrations", integrations, "—", "Manage"]);
    return rows;
  }

  /** Puts the API data where the page scripts read it. */
  function applyData() {
    const st = S.stats;
    const orders = S.parcels.map(toOrder);
    sampleOrders.length = 0;
    sampleOrders.push(...orders);
    pageData.Orders.rows = sampleOrders;
    for (const key of Object.keys(merchantTrackingEvents)) delete merchantTrackingEvents[key];

    pageData.Shipments.rows = S.parcels.filter(p => p.status !== "PICKUP_CANCELLED").map(toShipmentRow);
    pageData.Shipments.stats = [
      ["In transit", String(st?.parcels.inTransit ?? 0)],
      [S.cfg.document ? "Delivered this month" : "Delivered today", String(S.cfg.document ? st?.thisMonth.delivered ?? 0 : st?.today.delivered ?? 0)],
      ["Needs attention", String(st?.parcels.needsAttention ?? 0)],
    ];

    pageData["Pickup requests"].rows = S.parcels.map(toPickupRow);
    const scheduled = S.parcels.filter(p => ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED"].includes(p.status)).length;
    pageData["Pickup requests"].stats = [
      ["Awaiting pickup", String(st?.parcels.awaitingPickup ?? 0)],
      ["Rider assigned", String(scheduled)],
      ["Collected today", String(st?.today.pickedUp ?? 0)],
      // Booked for hub drop-off: the merchant brings these to the hub (never counted as awaiting pickup).
      ["Awaiting drop-off", String(st?.parcels.awaitingDropOff ?? 0)],
    ];

    pageData.Customers.rows = customerRows();
    const branches = new Set(S.parcels.map(p => metaOf(p).branch).filter(Boolean)).size;
    pageData.Customers.stats = S.cfg.document
      ? [["Origin branches", String(branches)], ["Active receivers", String(st?.customers.total ?? 0)], ["New this month", String(st?.customers.newThisMonth ?? 0)]]
      : [["Total customers", (st?.customers.total ?? 0).toLocaleString("en-BD")], ["New this month", String(st?.customers.newThisMonth ?? 0)], ["Repeat customers", pct(st?.customers.repeatRate, 0)]];

    const money = st?.money;
    pageData.Payments.rows = paymentRows();
    pageData.Payments.stats = S.cfg.document
      ? [
          ["Outstanding invoices", money ? `${money.invoices.outstandingCount} · ${taka(money.invoices.outstanding)}` : "—"],
          ["Paid this quarter", money ? taka(money.invoices.paidThisQuarter) : "—"],
          ["Next due date", money?.invoices.nextDueAt ? dateOnly(money.invoices.nextDueAt) : "None"],
        ]
      : [
          ["Payout pending", money ? taka(money.cod.readyToSettle.net + money.payouts.pendingApproval + money.payouts.awaitingPayment) : "—"],
          ["COD not yet settled", money ? taka(money.cod.withRiders + money.cod.atHubs) : "—"],
          ["Last payout", money?.payouts.lastPaid ? `${taka(money.payouts.lastPaid.amount)} · ${dateOnly(money.payouts.lastPaid.paidAt)}` : "None yet"],
        ];

    if (st)
      pageData.Reports.stats = S.cfg.document
        ? [["Delivery charges", taka(st.thisMonth.deliveryCharges)], ["Documents this month", st.thisMonth.created.toLocaleString("en-BD")], ["Delivery success", pct(st.thisMonth.deliverySuccessRate)]]
        : [["Gross sales", taka(st.thisMonth.codValue)], ["Orders this month", st.thisMonth.created.toLocaleString("en-BD")], ["Delivery success", pct(st.thisMonth.deliverySuccessRate)]];

    if (S.merchant) {
      pageData.Settings.rows = settingsRows();
      const connected = (S.keys ? S.keys.filter(k => !k.revokedAt).length : 0) + (S.webhooks?.length ?? 0);
      pageData.Settings.stats = [
        [S.cfg.document ? "Account status" : "Store status", MERCHANT_STATUS[S.merchant.status] || S.merchant.status],
        [S.cfg.document ? "Branch users" : "Team members", S.members ? String(S.members.length) : "—"],
        [S.cfg.document ? "Connected systems" : "Connected apps", String(connected)],
      ];
    }

    if (S.cfg.document && typeof documentBills !== "undefined") documentBills = S.invoices.map(toBill);
    updateNavCounts();
  }

  function toBill(i) {
    const start = new Date(i.periodStart);
    const end = new Date(new Date(i.periodEnd).getTime() - 1);
    const period = `${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })}–${end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
    return {
      id: i.number,
      _id: i.id,
      period,
      issued: dateOnly(i.issuedAt),
      due: dateOnly(i.dueAt),
      shipmentCount: i.lineCount,
      subtotal: i.subtotal,
      tax: 0,
      total: i.subtotal,
      status: i.status === "PAID" ? "Paid" : i.status === "VOID" ? "Void" : i.overdue ? "Overdue" : "Due",
      paidOn: i.paidAt ? dateOnly(i.paidAt) : undefined,
      lineItems: [],
    };
  }

  function updateNavCounts() {
    const st = S.stats;
    const set = (page, n) => {
      const badge = document.querySelector(`#navigation [data-page="${page}"] .nav-count`);
      if (!badge) return;
      badge.textContent = String(n ?? 0);
      badge.hidden = !n;
    };
    if (!st) return;
    const open = st.parcels.total - st.parcels.delivered - st.parcels.cancelled - (st.parcels.byStatus.RETURNED ?? 0);
    set("Orders", open);
    set("Shipments", st.parcels.inTransit);
    set("Pickup requests", st.parcels.awaitingPickup);
  }

  // ───────────── loading ─────────────

  async function loadParcels() {
    const all = [];
    let cursor = null;
    do {
      const page = await DF.api(`/parcels?limit=200${q("&")}${cursor ? `&cursor=${cursor}` : ""}`);
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor && all.length < PARCEL_CAP);
    S.truncated = !!cursor;
    const signature = all.map(p => `${p.id}:${p.version}:${p.updatedAt}:${p.cod?.state ?? ""}`).join("|");
    const changed = signature !== S.signature;
    S.parcels = all;
    S.signature = signature;
    return changed;
  }

  /**
   * The dashboard period (shared/period.js): Today … This month (default) … a custom range, in the URL
   * (?period=…) and remembered per panel. Booked / delivered / returned, COD, payable, success rate
   * and the chart follow it (GET /merchants/me/stats?from&to → `range`); "In transit" and the
   * delivery overview stay live.
   */
  function periodCtl() {
    if (!DF.period || !S.cfg) return null;
    if (!S.periodCtl)
      S.periodCtl = DF.period.control(`merchant-${S.cfg.document ? "banking" : "ecommerce"}-overview`, {
        defaultKey: "this_month",
        onChange: () =>
          loadStats()
            .then(() => S.page === "Overview" && patchDashboard())
            .catch(error => showToast(DF.describe(error))),
      });
    return S.periodCtl;
  }

  async function loadStats() {
    const period = periodCtl();
    if (period && (!S.page || S.page === "Overview")) period.activate();
    const next = await DF.api(`/merchants/me/stats?period=${S.period}${q("&")}${period ? `&${period.query()}` : ""}`);
    const changed = JSON.stringify({ ...next, generatedAt: 0 }) !== JSON.stringify({ ...(S.stats || {}), generatedAt: 0 });
    S.stats = next;
    return changed;
  }

  async function loadFinance() {
    if (!isOwner()) return false;
    const [invoices, settlements] = await Promise.all([
      DF.api(`/invoices?limit=200${q("&")}`).catch(() => ({ items: [] })),
      S.cfg.document ? Promise.resolve({ items: [] }) : DF.api(`/settlements?limit=200${q("&")}`).catch(() => ({ items: [] })),
    ]);
    const changed = JSON.stringify([invoices.items, settlements.items]) !== JSON.stringify([S.invoices, S.settlements]);
    S.invoices = invoices.items;
    S.settlements = settlements.items;
    return changed;
  }

  async function loadIntegrations() {
    if (!isOwner()) return;
    const results = await Promise.allSettled([
      DF.api(`/merchants/me/api-keys?limit=200${q("&")}`),
      DF.api(`/merchants/me/webhooks${q()}`),
      DF.api(`/merchants/me/members?limit=200${q("&")}`),
    ]);
    S.keys = results[0].status === "fulfilled" ? results[0].value.items : null;
    S.integrationError = results[0].status === "rejected" ? DF.describe(results[0].reason) : null;
    S.webhooks = results[1].status === "fulfilled" ? results[1].value.items : S.webhooks;
    S.members = results[2].status === "fulfilled" ? results[2].value.items : S.members;
  }

  /** The service package in force, for Settings (the order form loads it too). */
  async function loadPackage() {
    const key = () => (S.pkg?.package ? `${S.pkg.package.versionId}` : "");
    const before = key();
    S.pkg = window.DFOrderServices ? await window.DFOrderServices.load("/packages/me") : await DF.api("/packages/me");
    return key() !== before;
  }

  /** Reloads everything and re-renders the current page if anything changed. */
  async function refresh({ force = false } = {}) {
    const results = await Promise.allSettled([loadParcels(), loadStats(), loadFinance(), loadPackage()]);
    const changed = results.some(r => r.status === "fulfilled" && r.value);
    if (changed || force) {
      applyData();
      S.dirty = true;
    }
    if (S.dirty) rerender();
  }

  async function resolveMerchant() {
    let wanted = null;
    try {
      wanted = new URLSearchParams(location.search).get("merchant") || sessionStorage.getItem("deliveryfast-merchant-workspace");
    } catch {}
    try {
      const me = await DF.api(`/merchants/me${wanted ? `?merchantId=${encodeURIComponent(wanted)}` : ""}`);
      S.workspaces = [me];
      return me;
    } catch (error) {
      if (wanted && error.status === 403) {
        try {
          sessionStorage.removeItem("deliveryfast-merchant-workspace");
        } catch {}
        return resolveMerchant();
      }
      if (error.code !== "MERCHANT_REQUIRED") throw error;
      const ids = error.details?.merchantIds || [];
      S.workspaces = (await Promise.all(ids.map(id => DF.api(`/merchants/me?merchantId=${id}`).catch(() => null)))).filter(Boolean);
      return S.workspaces.find(m => m.type === S.cfg.type) || S.workspaces[0];
    }
  }

  // ───────────── identity ─────────────

  function showIdentity() {
    const m = S.merchant;
    const user = DF.auth.user;
    DF.showSignedInUser(m ? (m.myRole === "MERCHANT_OWNER" ? S.cfg.ownerLabel : S.cfg.staffLabel) : "Delivery Fast staff");
    const userInitials = initials(user?.name);
    for (const avatar of document.querySelectorAll(".user-profile .profile-avatar, .topbar .profile-avatar")) avatar.textContent = userInitials;
    const topAvatar = document.querySelector(".topbar .profile-avatar");
    if (topAvatar && user) topAvatar.title = user.name;
    if (!m) return;
    const switcher = document.querySelector(".workspace-switch");
    if (switcher) {
      switcher.querySelector(".workspace-avatar").textContent = initials(m.name);
      switcher.querySelector(".workspace-meta strong").textContent = m.name;
      switcher.querySelector(".workspace-meta small").textContent = S.cfg.typeLabel;
      switcher.title = `${m.name} · ${m.code}`;
    }
    const crumb = document.querySelector(".breadcrumb");
    if (crumb?.firstChild?.nodeType === Node.TEXT_NODE) crumb.firstChild.textContent = `${m.name} `;
    document.title = document.title.replace(/Northstar Store|Meridian Bank PLC/g, m.name);
  }


  // ───────────── rendering ─────────────

  const FILTER_IDS = ["tableSearch", "merchantDateField", "merchantDateFrom", "merchantDateTo", "merchantStatusFilter", "merchantProductFilter", "documentBillSearch"];

  /** Re-renders the current page, keeping search, filters, selection and the table page. */
  function rerender() {
    if (!DATA_PAGES.has(S.page)) return void (S.dirty = false);
    const active = document.activeElement;
    // Don't redraw under someone typing; the next poll catches up.
    if (active && $("mainContent").contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName) && !FILTER_IDS.includes(active.id)) return;
    const values = Object.fromEntries(FILTER_IDS.map(id => [id, $(id)?.value]).filter(([, v]) => v));
    const checked = [...document.querySelectorAll("#tableBody [data-merchant-select]:checked")].map(input => input.dataset.merchantSelect);
    const pageNo = S.pageNo;
    const scroll = window.scrollY;
    const focused = active?.id && FILTER_IDS.includes(active.id) ? active.id : null;
    renderPage(S.page);
    for (const [id, value] of Object.entries(values)) {
      const field = $(id);
      if (!field) continue;
      field.value = value;
      field.dispatchEvent(new Event(field.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    }
    for (const id of checked) {
      const box = document.querySelector(`#tableBody [data-merchant-select="${CSS.escape(id)}"]`);
      if (box) box.checked = true;
    }
    S.pageNo = pageNo;
    paginate();
    if (focused) $(focused)?.focus();
    window.scrollTo(0, scroll);
    S.dirty = false;
  }

  function afterRender(page) {
    const main = $("mainContent");
    if (page === "Overview") return patchDashboard();
    const subtitle = main.querySelector(".page-table-panel .panel-heading p.panel-subtitle");
    const live = ["Orders", "Shipments", "Pickup requests", "Customers", "Payments", "Settings"].includes(page);
    if (subtitle && live) subtitle.textContent = `Live data · updated ${timeOf(new Date())}${S.truncated && ["Orders", "Shipments", "Pickup requests"].includes(page) ? ` · newest ${PARCEL_CAP.toLocaleString("en-BD")} shown` : ""}`;
    const body = $("tableBody");
    if (body && live && !body.children.length) {
      const columns = main.querySelectorAll(".page-table-panel thead th").length || 6;
      const message = {
        Orders: S.cfg.document ? "No delivery requests yet. Create one with “New delivery request”." : "No orders yet. Create your first order or import a batch.",
        Shipments: "No shipments yet.",
        "Pickup requests": "No pickup requests yet. Every order you create is collected from your pickup address.",
        Customers: S.cfg.document ? "No recipients yet." : "No customers yet.",
        Payments: isOwner() ? "No payments yet. COD collections, payouts and invoices appear here." : "Payments are visible to workspace owners.",
      }[page];
      if (message) body.innerHTML = `<tr class="df-empty"><td colspan="${columns}" class="empty-state">${esc(message)}</td></tr>`;
    }
    if (page === "Orders") {
      addCancelButtons();
      markIncomplete();
    }
    if (page === "Payments") {
      markReceipts();
      decoratePayments();
    }
    // Billing (Banking & Financial): the summary cards fill the row.
    if (page === "Billing") {
      const metrics = main.querySelector(".metrics");
      if (metrics) metrics.style.gridTemplateColumns = "repeat(auto-fit,minmax(220px,1fr))";
    }
    if (live) {
      S.pageNo = 1;
      paginate();
    }
  }

  function addCancelButtons() {
    for (const row of document.querySelectorAll("#tableBody tr[data-merchant-record-id]")) {
      const p = byId(row.dataset.merchantRecordId);
      const cell = row.querySelector("[data-merchant-history]")?.parentElement;
      if (!p || !cell || !p.canCancel) continue;
      cell.insertAdjacentHTML("beforeend", ` <button type="button" class="button button-sm" data-df-cancel="${esc(p.trackingId)}">Cancel</button>`);
    }
  }

  /** Client-side pages over the rows the filters left visible (filters use [hidden]). */
  function paginate() {
    const body = $("tableBody");
    const footer = document.querySelector(".page-table-panel .table-footer");
    if (!body || !footer) return;
    const rows = [...body.querySelectorAll("tr")].filter(r => !r.classList.contains("df-empty"));
    const visible = rows.filter(r => !r.hidden);
    const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
    S.pageNo = Math.min(Math.max(1, S.pageNo), pages);
    const start = (S.pageNo - 1) * PAGE_SIZE;
    for (const row of rows) row.style.display = "";
    visible.forEach((row, i) => (row.style.display = i >= start && i < start + PAGE_SIZE ? "" : "none"));
    const label = footer.querySelector(":scope > span");
    const noun = { Orders: S.cfg.document ? "delivery requests" : "orders", "Pickup requests": "pickup requests" }[S.page] || S.page.toLowerCase();
    if (label) label.textContent = visible.length ? `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, visible.length)} of ${visible.length.toLocaleString("en-BD")} ${noun}` : `No matching ${noun}`;
    const nav = footer.querySelector(".pagination");
    if (!nav) return;
    const first = Math.max(1, Math.min(S.pageNo - 1, pages - 2));
    const numbers = Array.from({ length: Math.min(3, pages) }, (_, i) => first + i);
    nav.innerHTML =
      `<button class="page-btn" data-df-page="${S.pageNo - 1}" ${S.pageNo === 1 ? "disabled" : ""} aria-label="Previous page">‹</button>` +
      numbers.map(n => `<button class="page-btn${n === S.pageNo ? " current" : ""}" data-df-page="${n}">${n}</button>`).join("") +
      `<button class="page-btn" data-df-page="${S.pageNo + 1}" ${S.pageNo === pages ? "disabled" : ""} aria-label="Next page">›</button>`;
  }

  // ───────────── dashboard ─────────────

  function patchDashboard() {
    const main = $("mainContent");
    const st = S.stats;
    const now = new Date();
    const user = DF.auth.user;
    const hour = now.getHours();
    const heading = main.querySelector(".page-heading");
    if (heading) {
      heading.querySelector(".eyebrow").textContent = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
      const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
      heading.querySelector("h1").innerHTML = `${greeting}, ${esc(String(user?.name || "").split(/\s+/)[0])} <span style="font-size:20px">${hour < 17 ? "☀️" : "🌙"}</span>`;
      const dateButton = heading.querySelector(".date-button");
      const period = periodCtl();
      if (period) {
        // The period select replaces the static date button.
        if (dateButton) dateButton.style.display = "none";
        period.mount(heading.querySelector(".heading-actions"), "afterbegin");
        const sub = heading.querySelector(".subtitle");
        if (sub) sub.textContent = `${period.text()} · ${S.cfg.document ? "documents" : "orders"}, deliveries and COD in this period; "now" figures are live`;
      } else if (dateButton) {
        const label = now.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        dateButton.dataset.toast = `Showing today, ${now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} (Dhaka time).`;
        dateButton.innerHTML = `${icon("calendar")} Today, ${esc(label)} <span style="color:#a0a9b5">⌄</span>`;
      }
    }
    if (!st) return;
    const metrics = main.querySelector(".metrics");
    if (st.range && periodCtl()) return patchPeriodDashboard(main, st, metrics);
    const card = (label, value, iconName, foot, t) => metricCard(label, value, iconName, foot, t?.text || "").replace('<span class="trend">', `<span class="trend"${t?.down ? ' style="color:var(--red)"' : ""}>`);
    const success = st.thisMonth.deliverySuccessRate;
    const successTrend = success !== null && st.lastMonth.deliverySuccessRate !== null ? { text: `${success >= st.lastMonth.deliverySuccessRate ? "↑" : "↓"} ${Math.abs(success - st.lastMonth.deliverySuccessRate).toFixed(1)} pts`, down: success < st.lastMonth.deliverySuccessRate } : null;
    if (metrics) {
      const createdTrend = trend(st.thisMonth.created, st.lastMonth.created);
      metrics.innerHTML = S.cfg.document
        ? card("Documents this month", st.thisMonth.created.toLocaleString("en-BD"), "orders", st.lastMonth.created ? "vs. last month" : "across all branches", createdTrend) +
          card("In transit", String(st.parcels.inTransit), "truck", "secure consignments") +
          card("Unbilled charges", st.money ? taka(st.money.unbilled.charges) : "—", "wallet", st.money ? "ready for monthly bill" : "visible to owners", st.money ? { text: `${st.money.unbilled.parcels} consignment${st.money.unbilled.parcels === 1 ? "" : "s"}` } : null) +
          card("Delivery success", pct(success), "chart", "delivered vs. returned this month", successTrend)
        : card("Total orders", st.thisMonth.created.toLocaleString("en-BD"), "orders", st.lastMonth.created ? "vs. last month" : "this month", createdTrend) +
          card("In transit", String(st.parcels.inTransit), "truck", "on the way to customers") +
          card("Gross sales", taka(st.thisMonth.codValue), "wallet", st.lastMonth.codValue ? "vs. last month" : "COD order value this month", trend(st.thisMonth.codValue, st.lastMonth.codValue)) +
          card("Delivery success", pct(success), "chart", "delivered vs. returned this month", successTrend);
    }
    const period = $("chartPeriod");
    if (period) period.value = { "7d": "Last 7 days", "30d": "Last 30 days", year: "This year" }[S.period];
    drawChart(main.querySelector("svg.chart"), st.series);

    const summary = main.querySelectorAll(".dispatch-summary strong");
    const values = [st.today.shipments, st.today.delivered, st.parcels.needsAttention];
    summary.forEach((el, i) => (el.textContent = String(values[i] ?? 0)));
    const completion = st.today.completionRate ?? 0;
    const progress = main.querySelector(".progress-label strong");
    if (progress) progress.textContent = `${Math.round(completion)}%`;
    const fill = main.querySelector(".progress-fill");
    if (fill) fill.style.width = `${Math.min(100, completion)}%`;
    const rows = main.querySelectorAll(".dispatch-row:not([data-df-dropoff]) strong");
    [st.parcels.inTransit, st.today.delivered, st.parcels.awaitingPickup, st.parcels.needsAttention].forEach((n, i) => rows[i] && (rows[i].textContent = String(n)));
    dropOffRow(main, st.parcels.awaitingDropOff ?? 0);

    // Recent orders: the row menu opens the order's details.
    const recent = main.querySelectorAll(".content-grid .table-panel tbody tr");
    recent.forEach((row, i) => {
      const button = row.querySelector(".row-menu");
      if (button && sampleOrders[i]) {
        button.dataset.merchantHistory = sampleOrders[i].id;
        button.setAttribute("aria-label", `Details for ${sampleOrders[i].id}`);
      }
    });
    const recentBody = main.querySelector(".content-grid .table-panel tbody");
    if (recentBody && !recent.length) recentBody.innerHTML = `<tr><td colspan="6" class="empty-state">${S.cfg.document ? "No delivery requests yet." : "No orders yet."}</td></tr>`;
    const activity = main.querySelector(".activity-list");
    if (activity) activity.innerHTML = activityItems();
  }

  /** The dashboard for the chosen period (st.range), with the live figures labelled "now". */
  function patchPeriodDashboard(main, st, metrics) {
    const r = st.range;
    const p = periodCtl().get();
    const prev = r.previous;
    const card = (label, value, iconName, foot, t, key) =>
      metricCard(label, value, iconName, foot, t?.text || "")
        .replace('<span class="trend">', `<span class="trend"${t?.down ? ' style="color:var(--red)"' : ""}>`)
        .replace('<article class="metric"', `<article class="metric" data-period-metric="${key}"`);
    const pts = (now, before) => (now === null || before === null || before === undefined ? null : { text: `${now >= before ? "↑" : "↓"} ${Math.abs(now - before).toFixed(1)} pts`, down: now < before });
    const noun = S.cfg.document ? "Documents" : "Orders";
    const owner = r.money;
    const first =
      card(`${noun} booked`, r.created.toLocaleString("en-BD"), "orders", prev.created ? p.versus : p.words, trend(r.created, prev.created), "created") +
      card("Delivered", r.delivered.toLocaleString("en-BD"), "truck", prev.delivered ? p.versus : p.words, trend(r.delivered, prev.delivered), "delivered") +
      card("Returned", r.returned.toLocaleString("en-BD"), "box", `${r.cancelled} cancelled · ${p.words}`, null, "returned") +
      card("Delivery success", pct(r.deliverySuccessRate), "chart", "delivered vs. returned", pts(r.deliverySuccessRate, prev.deliverySuccessRate), "success");
    const transit = card("In transit", String(st.parcels.inTransit), "truck", "now · live", null, "inTransit");
    const second = S.cfg.document
      ? card("Delivery charges", taka(r.deliveryCharges), "wallet", `documents booked ${p.words}`, trend(r.deliveryCharges, prev.deliveryCharges), "charges") +
        card("Unbilled charges", st.money ? taka(st.money.unbilled.charges) : "—", "wallet", st.money ? "now · ready for monthly bill" : "visible to owners", st.money ? { text: `${st.money.unbilled.parcels} consignment${st.money.unbilled.parcels === 1 ? "" : "s"}` } : null, "unbilled") +
        card("Picked up", r.pickedUp.toLocaleString("en-BD"), "pin", p.words, null, "pickedUp") +
        transit
      : owner
        ? card("COD collected", taka(owner.codCollected), "wallet", `${owner.collections} collection${owner.collections === 1 ? "" : "s"} · ${p.words}`, trend(owner.codCollected, prev.money?.codCollected), "codCollected") +
          card("Payable to you", taka(owner.payable), "wallet", `COD less ${taka(owner.chargesOnCollected)} charges`, null, "payable") +
          card("Paid out", taka(owner.paidOut), "check", `${owner.payouts} payout${owner.payouts === 1 ? "" : "s"} · ${p.words}`, null, "paidOut") +
          transit
        : card("Gross sales", taka(r.codValue), "wallet", `COD order value · ${p.words}`, trend(r.codValue, prev.codValue), "codValue") +
          card("Delivery charges", taka(r.deliveryCharges), "wallet", p.words, null, "charges") +
          card("Picked up", r.pickedUp.toLocaleString("en-BD"), "pin", p.words, null, "pickedUp") +
          transit;
    if (metrics) {
      metrics.innerHTML = first;
      metrics.dataset.periodMetrics = p.key;
      let more = main.querySelector("#dfPeriodMore");
      if (!more) {
        metrics.insertAdjacentHTML("afterend", `<div class="metrics" id="dfPeriodMore"></div>`);
        more = main.querySelector("#dfPeriodMore");
      }
      more.innerHTML = second;
    }
    // The chart follows the period (by hour for one day, by day, by month for long ranges).
    const chartSelect = $("chartPeriod");
    if (chartSelect) chartSelect.style.display = "none";
    const chart = main.querySelector("svg.chart");
    const chartSub = chart?.closest(".panel")?.querySelector(".panel-subtitle");
    if (chartSub) chartSub.textContent = `${noun} per ${r.series.bucket} · ${p.text} vs. the previous period`;
    drawChart(chart, r.series);

    const overview = main.querySelector(".dispatch-summary")?.closest(".panel");
    const overviewSub = overview?.querySelector(".panel-subtitle");
    if (overviewSub) overviewSub.textContent = "Live now · not affected by the period";
    const summary = main.querySelectorAll(".dispatch-summary strong");
    const values = [st.today.shipments, st.today.delivered, st.parcels.needsAttention];
    summary.forEach((el, i) => (el.textContent = String(values[i] ?? 0)));
    const completion = st.today.completionRate ?? 0;
    const progress = main.querySelector(".progress-label strong");
    if (progress) progress.textContent = `${Math.round(completion)}%`;
    const fill = main.querySelector(".progress-fill");
    if (fill) fill.style.width = `${Math.min(100, completion)}%`;
    const rows = main.querySelectorAll(".dispatch-row:not([data-df-dropoff]) strong");
    [st.parcels.inTransit, st.today.delivered, st.parcels.awaitingPickup, st.parcels.needsAttention].forEach((n, i) => rows[i] && (rows[i].textContent = String(n)));
    dropOffRow(main, st.parcels.awaitingDropOff ?? 0);
    main.querySelectorAll(".content-grid .table-panel tbody tr").forEach((row, i) => {
      const button = row.querySelector(".row-menu");
      if (button && sampleOrders[i]) {
        button.dataset.merchantHistory = sampleOrders[i].id;
        button.setAttribute("aria-label", `Details for ${sampleOrders[i].id}`);
      }
    });
    const recentBody = main.querySelector(".content-grid .table-panel tbody");
    if (recentBody && !recentBody.children.length) recentBody.innerHTML = `<tr><td colspan="6" class="empty-state">${S.cfg.document ? "No delivery requests yet." : "No orders yet."}</td></tr>`;
    const activity = main.querySelector(".activity-list");
    if (activity) activity.innerHTML = activityItems();
  }

  /** "Awaiting drop-off" in the dashboard pipeline, after "Pickup scheduled" (drop-offs never wait for a pickup rider). */
  function dropOffRow(main, count) {
    const list = main.querySelector(".dispatch-list");
    if (!list) return;
    let row = list.querySelector("[data-df-dropoff]");
    if (!row) {
      row = document.createElement("div");
      row.className = "dispatch-row";
      row.dataset.dfDropoff = "";
      row.innerHTML = `<span class="dispatch-label"><i style="background:#7c5cc4"></i>Awaiting drop-off</span><strong></strong>`;
      const anchor = list.querySelectorAll(".dispatch-row")[2];
      if (anchor) anchor.after(row);
      else list.append(row);
    }
    row.querySelector("strong").textContent = String(count);
  }

  function activityItems() {
    const items = [];
    for (const p of S.parcels.slice(0, 50))
      for (const e of p.events) items.push({ at: e.at, p, e });
    items.sort((a, b) => (a.at < b.at ? 1 : -1));
    const iconFor = status => (status === "DELIVERED" || IN_TRANSIT.includes(status) ? "truck" : AWAITING_PICKUP.includes(status) ? "pin" : "box");
    const rows = items.slice(0, 4).map(({ p, e }) => {
      const text = e.status === "DELIVERED" ? `<strong>${esc(p.trackingId)}</strong> was delivered to ${esc(p.recipient.name)}` : e.status === "PENDING_CONFIRMATION" ? `<strong>New ${S.cfg.document ? "document request" : "order"}</strong> for ${esc(p.recipient.name)}` : `<strong>${esc(p.trackingId)}</strong> · ${esc(e.title)}`;
      const place = e.status === "PENDING_CONFIRMATION" ? taka(S.cfg.document ? p.charges.total : p.codAmount || p.declaredValue || 0) : e.location || p.delivery.zone;
      return { at: e.at, html: `<div class="activity-item"><span class="activity-icon">${icon(iconFor(e.status))}</span><div class="activity-copy">${text}<small>${esc(ago(e.at))} · ${esc(place)}</small></div></div>` };
    });
    const paid = S.stats?.money?.payouts.lastPaid;
    if (paid && !S.cfg.document) rows.push({ at: paid.paidAt, html: `<div class="activity-item"><span class="activity-icon">${icon("wallet")}</span><div class="activity-copy"><strong>Payout completed</strong> — ${taka(paid.amount)}<small>${esc(ago(paid.paidAt))} · ${esc(paid.number)}</small></div></div>` });
    const paidInvoice = S.invoices.find(i => i.status === "PAID");
    if (paidInvoice && S.cfg.document) rows.push({ at: paidInvoice.paidAt, html: `<div class="activity-item"><span class="activity-icon">${icon("wallet")}</span><div class="activity-copy"><strong>Monthly invoice paid</strong> — ${taka(paidInvoice.subtotal)}<small>${esc(ago(paidInvoice.paidAt))} · ${esc(paidInvoice.number)}</small></div></div>` });
    rows.sort((a, b) => (a.at < b.at ? 1 : -1));
    return rows.slice(0, 4).map(r => r.html).join("") || `<div class="empty-state">No activity yet. New orders and delivery updates appear here.</div>`;
  }

  function drawChart(svg, series) {
    if (!svg || !series) return;
    const left = 45;
    const right = 690;
    const top = 20;
    const bottom = 170;
    const n = series.current.length;
    const peak = Math.max(4, ...series.current, ...series.previous);
    // Four equal whole-number steps.
    const rough = peak / 4;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const max = 4 * ([1, 2, 2.5, 5, 10].map(f => f * magnitude).find(v => v >= rough && Number.isInteger(v)) || Math.ceil(rough));
    const x = i => (n === 1 ? left : left + (i * (right - left)) / (n - 1));
    const y = v => bottom - (v / max) * (bottom - top);
    const path = values => {
      const pts = values.map((v, i) => [x(i), y(v)]);
      if (pts.length < 2) return `M${pts[0][0]} ${pts[0][1]}`;
      const clamp = v => Math.min(bottom, Math.max(top, v));
      let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
      for (let i = 0; i < pts.length - 1; i++) {
        const [p0, p1, p2, p3] = [pts[i - 1] || pts[i], pts[i], pts[i + 1], pts[i + 2] || pts[i + 1]];
        const c1 = [p1[0] + (p2[0] - p0[0]) / 6, clamp(p1[1] + (p2[1] - p0[1]) / 6)];
        const c2 = [p2[0] - (p3[0] - p1[0]) / 6, clamp(p2[1] - (p3[1] - p1[1]) / 6)];
        d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
      }
      return d;
    };
    const ticks = [1, 0.75, 0.5, 0.25, 0].map(f => ({ value: Math.round(max * f * 10) / 10, y: y(max * f) }));
    svg.querySelector(".chart-grid").innerHTML = ticks.map(t => `<line x1="${left}" y1="${t.y}" x2="${right}" y2="${t.y}"/>`).join("");
    // At most ~7 day labels; the last point is always labelled.
    const every = n > 12 ? Math.ceil(n / 7) : 1;
    const shown = [];
    for (let i = 0; i < n; i += every) shown.push(i);
    if (shown[shown.length - 1] !== n - 1) {
      if (n - 1 - shown[shown.length - 1] < every * 0.6) shown.pop();
      shown.push(n - 1);
    }
    const xLabels = shown
      .map(i => ({ label: series.labels[i], i }))
      .map(({ label, i }) => `<text x="${x(i)}" y="187" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">${esc(label)}</text>`);
    svg.querySelector(".chart-labels").innerHTML = ticks.map(t => `<text x="38" y="${t.y + 3}" text-anchor="end">${t.value}</text>`).join("") + xLabels.join("");
    const line = path(series.current);
    svg.querySelector(".chart-line").setAttribute("d", line);
    svg.querySelector(".chart-area").setAttribute("d", `${line} L${right} ${bottom} L${left} ${bottom}Z`);
    svg.querySelector(".chart-line-secondary").setAttribute("d", path(series.previous));
    const point = svg.querySelector(".chart-point");
    point.setAttribute("cx", x(n - 1));
    point.setAttribute("cy", y(series.current[n - 1]));
    const what = S.cfg.document ? "Documents" : "Orders";
    svg.setAttribute("aria-label", `${what} per ${series.bucket}: ${series.labels.map((l, i) => `${l} ${series.current[i]}`).join(", ")}`);
  }

  // ───────────── details, history and cancel ─────────────

  /** A dialog in the page's tracking-history style; Escape closes it (page script). */
  function dialog(title, subtitle, body, width = 540) {
    $("merchantHistoryBackdrop")?.remove();
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="merchantHistoryBackdrop" role="dialog" aria-modal="true" aria-labelledby="merchantHistoryTitle" style="position:fixed;inset:0;z-index:100;background:#14203380;display:grid;place-items:center;padding:18px"><section style="width:min(${width}px,100%);max-height:85vh;overflow:auto;background:#fff;border-radius:12px;padding:20px;box-shadow:0 24px 70px #10182840"><header style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start"><div><h2 id="merchantHistoryTitle" style="margin:0;font-size:18px">${esc(title)}</h2><p style="margin:6px 0;color:#778293">${subtitle}</p></div><button type="button" id="closeMerchantHistory" aria-label="Close" class="button">×</button></header><div id="dfDialogBody">${body}</div></section></div>`,
    );
    const backdrop = $("merchantHistoryBackdrop");
    $("closeMerchantHistory").addEventListener("click", () => backdrop.remove());
    backdrop.addEventListener("click", event => event.target === backdrop && backdrop.remove());
    return backdrop;
  }
  const closeDialog = () => $("merchantHistoryBackdrop")?.remove();
  const detail = (label, value) => `<div><small style="color:#758195;display:block;font-size:11px;letter-spacing:.06em;text-transform:uppercase">${esc(label)}</small><strong style="font-size:13px;font-weight:600">${esc(value || "—")}</strong></div>`;

  function showParcel(p) {
    const order = toOrder(p);
    const doc = p.type === "DOCUMENT";
    const events = [...p.events].reverse();
    const grid = [
      detail("Recipient", [p.recipient.name, phone(p.recipient.phone)].filter(Boolean).join(" · ") || "Not set yet"),
      detail("Deliver to", p.delivery.label),
      detail("Service", `${p.serviceLevelLabel}${doc ? "" : ` · ${p.weightKg} kg`}`),
      detail(doc ? "Document" : "Item", doc ? [order.documentType, order.product !== order.documentType ? order.product : ""].filter(Boolean).join(" · ") : order.item),
      detail(doc ? "Declared value" : "Cash to collect (COD)", taka(doc ? p.declaredValue : p.codAmount)),
      detail("Delivery charge", `${taka(p.charges.total)}${p.charges.discount ? ` (plan discount ${taka(p.charges.discount)})` : ""}`),
      detail(doc ? "Reference" : "Order reference", p.merchantOrderRef),
      detail(p.deliveryRider ? "Delivery rider" : "Pickup rider", (p.deliveryRider || p.pickupRider)?.label || "Not assigned yet"),
      detail("Current hub", p.currentHub?.name),
      detail(p.deliveredAt ? "Delivered" : "Estimated delivery", when(p.deliveredAt || p.estimatedDeliveryAt)),
    ];
    if (order.branchCode) grid.push(detail("Origin branch", order.branchCode));
    if (order.recipientRelation) grid.push(detail("Receiver relationship", order.recipientRelation));
    if (p.proof) grid.push(detail("Proof of delivery", `${{ OTP: "Recipient code", SIGNATURE: "Signature", PHOTO: "Photo" }[p.proof.method] || p.proof.method} · received by ${p.proof.receivedBy || p.recipient.name}`));
    if (p.cancelReason) grid.push(detail("Cancellation reason", p.cancelReason));
    // Partial delivery: the cash actually collected, and the return order bringing back the rest.
    if (p.partialDelivery)
      grid.unshift(
        detail(
          "Partial delivery",
          `The recipient kept part of the order and paid ${taka(p.partialDelivery.codCollected)}${p.partialDelivery.codAmount ? ` of ${taka(p.partialDelivery.codAmount)}` : ""}.${p.partialDelivery.returnOrders.length ? ` The rest comes back as ${p.partialDelivery.returnOrders.map(r => r.trackingId).join(", ")}.` : ""}${p.partialDelivery.note ? ` ${p.partialDelivery.note}` : ""}`,
        ).replace("<div>", `<div data-df-partial style="grid-column:1/-1;padding:8px 10px;border-radius:8px;background:#fef6e7;color:#8a5a0b">`),
      );
    if (p.returnOf) grid.unshift(detail("Return order", `Brings back what the recipient didn't keep on ${p.returnOf} (partial delivery). Return charge: ${p.returnInfo?.chargeWaived ? "none" : taka(p.returnInfo?.charge)}.`).replace("<div>", `<div style="grid-column:1/-1">`));
    const timeline = events
      .map(
        (e, index) =>
          `<li style="position:relative;margin-left:8px;padding:0 0 18px 25px;border-left:${index === events.length - 1 ? "0" : "1px solid #dfe5ee"}"><span style="position:absolute;left:-6px;top:2px;width:11px;height:11px;border-radius:50%;background:${index === 0 ? "#3766e8" : "#cbd5e1"}"></span><strong>${esc(e.title)}</strong><div style="margin-top:3px;color:#647184">${esc([e.description, e.location].filter(Boolean).join(" · "))}</div><small style="display:block;margin-top:4px;color:#99a3af">${esc(when(e.at))}</small></li>`,
      )
      .join("");
    const complete = p.incomplete && EDITABLE_INCOMPLETE.includes(p.status) ? `<button type="button" class="button button-primary" data-df-complete="${esc(p.trackingId)}">Complete details</button>` : "";
    // Failed delivery attempts (GET /parcels/:id: failedAttempts, lastFailedAttempt, returnedAfterFailure).
    if (p.failedAttempts > 0 && !["DELIVERED", "PICKUP_CANCELLED"].includes(p.status)) {
      const last = p.lastFailedAttempt;
      const where = p.returnedAfterFailure ? `, back at ${p.currentHub?.name || "the hub"}` : p.status === "RETRY_SCHEDULED" ? ", another attempt is scheduled" : "";
      const text = `Delivery failed ×${p.failedAttempts}${where}${last?.reason ? ` · Last reason: ${last.reason} (${when(last.at)})` : ""}`;
      grid.unshift(detail("Delivery attempts", text).replace("<div>", `<div data-df-failure="${p.failedAttempts}" style="grid-column:1/-1;padding:8px 10px;border-radius:8px;background:#fef3f2;color:#b42318">`));
    }
    // Out for delivery with "Live rider location" (package): the rider's latest position (GET /parcels/:id liveDelivery).
    const live = liveRow(p);
    if (live) grid.unshift(live);
    if (p.incomplete) grid.unshift(detail("Needs info",`Missing ${(p.missingLabels || []).join(", ")}. It won't go out for delivery until the recipient's name, phone, address and destination are all filled in.`));
    // Shipping label (PDF in a new tab) while the parcel is still on its way; cancel / complete when allowed.
    const label = TERMINAL.includes(p.status) ? "" : `<button type="button" class="button" data-df-label="${esc(p.trackingId)}">Print label (PDF)</button>`;
    const actions = p.canCancel || complete || label ? `<div class="modal-actions" style="margin-top:0;flex-wrap:wrap">${label}${complete}${p.canCancel ? `<button type="button" class="button" data-df-cancel="${esc(p.trackingId)}">${doc ? "Cancel request" : "Cancel order"}</button>` : ""}</div>` : "";
    dialog(
      `Tracking history · ${p.trackingId}`,
      `${esc(p.recipient.name)} · ${statusPill(p.statusLabel)}`,
      `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:14px 0 4px;padding:12px;background:#f7f9fc;border-radius:10px">${grid.join("")}</div><ol style="list-style:none;margin:18px 0 0;padding:0">${timeline}</ol>${actions}`,
    );
  }

  /**
   * The delivery rider's live position while out for delivery (only when the parcel's package has
   * "Live rider location"; the API hides fixes older than 15 minutes and everything after delivery).
   */
  function liveRow(p) {
    const live = p.liveDelivery;
    if (!live || p.status !== "OUT_FOR_DELIVERY" || !live.locationStatus) return "";
    const loc = live.location;
    const mins = loc ? Math.floor((loc.ageSeconds || 0) / 60) : 0;
    const text = loc
      ? `Rider ${live.rider.name} · updated ${mins < 1 ? "just now" : `${mins} min ago`}`
      : live.locationStatus === "STALE"
        ? `Rider ${live.rider.name} · location not updated for over ${live.staleAfterMinutes || 15} minutes`
        : live.locationStatus === "OFF_SHIFT"
          ? `Rider ${live.rider.name} · not sharing a location right now`
          : `Rider ${live.rider.name} · waiting for the rider's location`;
    const link = loc ? ` <a data-df-live-map href="https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=16/${loc.lat}/${loc.lng}" target="_blank" rel="noopener" style="font-size:13px;font-weight:600">Open map ↗</a>` : "";
    return `<div data-df-live="${esc(live.locationStatus)}" style="grid-column:1/-1;padding:8px 10px;border-radius:8px;background:#ecfdf3;color:#05603a"><small style="color:#758195;display:block;font-size:11px;letter-spacing:.06em;text-transform:uppercase">Live rider location</small><strong style="font-size:13px;font-weight:600">${esc(text)}</strong>${link}</div>`;
  }

  // While a parcel's details are open and it's out for delivery: refresh the live position on each
  // rider fix (parcel.rider_location) and every minute.
  let liveOpen = null;
  async function refreshLive() {
    const id = liveOpen;
    const box = document.querySelector("#merchantHistoryBackdrop [data-df-live]");
    if (!id || !box) return void (liveOpen = null);
    try {
      const p = await DF.api(`/parcels/${encodeURIComponent(id)}`);
      const html = liveRow(p);
      const current = document.querySelector("#merchantHistoryBackdrop [data-df-live]");
      if (current && liveOpen === id) html ? (current.outerHTML = html) : current.remove();
    } catch {}
  }
  DF.events?.on("parcel.rider_location", data => void (liveOpen && (!data?.id || data.id === liveOpen) && refreshLive()));
  setInterval(() => liveOpen && document.visibilityState === "visible" && void refreshLive(), 60_000);

  async function openHistory(id) {
    let p = byId(id);
    // List rows don't carry the live position: load the parcel when it's out for delivery.
    if (p && p.status === "OUT_FOR_DELIVERY") p = await DF.api(`/parcels/${encodeURIComponent(id)}`).catch(() => p);
    if (!p) {
      try {
        p = await DF.api(`/parcels/${encodeURIComponent(id)}`);
      } catch (error) {
        return showToast(DF.describe(error));
      }
    }
    showParcel(p);
    liveOpen = p.liveDelivery?.locationStatus ? p.trackingId : null;
  }

  async function cancelParcel(id) {
    const p = byId(id);
    const reason = await DF.prompt({ title: `Cancel ${id}?`, message: p ? `The pickup for ${p.recipient.name} won't be collected. This can't be undone.` : "The pickup won't be collected. This can't be undone.", label: "Reason", multiline: true, maxLength: 300, confirm: "Cancel shipment", cancel: "Keep it", danger: true });
    if (reason === null) return;
    try {
      await DF.api(`/parcels/${encodeURIComponent(id)}/cancel`, { method: "POST", body: { reason: reason || undefined } });
      closeDialog();
      await refresh({ force: true });
      showToast(`${id} cancelled. The pickup won't be collected.`);
    } catch (error) {
      showToast(DF.describe(error));
      await refresh({ force: true }).catch(() => undefined);
    }
  }

  // ───────────── booking ─────────────

  const option = (value, label = value, selected = false) => `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;
  /** The page's region lists (03.js) follow the live catalog; the form fills its selects from S.catalog. */
  function narrowRegions() {
    const c = S.catalog;
    if (!c || typeof merchantRegions === "undefined") return;
    merchantRegions.district = c.districts;
    merchantRegions.zone = [];
    merchantRegions.area = [];
  }
  const zonesOf = district => S.catalog?.zonesByDistrict?.[district] || [];
  const areasOf = zone => S.catalog?.areasByZone?.[zone] || [];
  /** The catalog zone of the merchant's pickup address (structured since 2026-10-18; older text is guessed). */
  function pickupZone() {
    const m = S.merchant;
    if (m.pickup?.zone) return m.pickup.zone;
    const zones = zonesOf(m.pickupDistrict);
    return zones.find(z => z === m.pickupArea || areasOf(z).includes(m.pickupArea) || String(m.pickupAddress).toLowerCase().includes(z.toLowerCase())) || zones[0] || m.pickupArea;
  }

  // District → zone → area: "Choose …" placeholders, nothing preselected, long lists searchable.
  const fillPlace = (select, values, placeholder) => window.DFOrderServices?.fill(select, values, placeholder);
  function cascadeZones() {
    const district = $("merchantDistrict")?.value;
    fillPlace($("merchantZone"), zonesOf(district), district ? "Choose zone" : "Choose the district first");
    cascadeAreas();
  }
  function cascadeAreas() {
    const zone = $("merchantZone")?.value;
    const areas = areasOf(zone);
    fillPlace($("merchantArea"), areas, zone ? (areas.length ? "Choose area (optional)" : "No areas listed") : "Choose the zone first");
  }

  // The order dialog: no horizontal overflow on phones (390 px) and long forms scroll inside it.
  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="dfOrderFormStyles">
      #orderModal .modal{max-width:min(680px,100%);max-height:calc(100vh - 32px);overflow-y:auto;box-sizing:border-box}
      #orderModal .form-grid,#orderModal .order-extra-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
      #orderModal #orderExtraFields.df-ord-laid{display:contents}
      #orderModal [hidden]{display:none!important}
      #orderModal .df-ord-section{grid-column:1/-1;margin:4px 0 -4px;padding-top:10px;border-top:1px solid var(--line);color:#8792a2;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
      #orderModal .df-ord-section:first-child{margin-top:0;padding-top:0;border-top:0}
      #orderModal .df-ord-slot{display:contents}
      #orderModal .df-req>label::after{content:" *";color:#c2410c;font-weight:700}
      #orderModal #merchantPriceHint{grid-column:1/-1}
      #orderModal .form-field{min-width:0}
      #orderModal .form-field>select,#orderModal .form-field>input:not([type=checkbox]),#orderModal .df-phone{width:100%;max-width:100%;min-width:0;box-sizing:border-box}
      #orderModal .df-phone input{min-width:0}
      #orderModal .df-svc-checks label{color:#3c4859}
      @media(max-width:560px){#orderModal.modal-backdrop{padding:10px}#orderModal .modal{padding:16px}#orderModal .form-grid,#orderModal .order-extra-grid{grid-template-columns:minmax(0,1fr)}}
    </style>`,
  );

  /**
   * The order form laid out like Courier Operations › New order (courier-operation/bridge-pages.js):
   * Service (first / last mile, Service, COD, open box, messages, pickup time) → Recipient → Delivery
   * address (the full address first: district / zone / area are picked from it, DF.autoPlace) → Parcel
   * (catalogue, product, weight, value, reference, contents, pre-printed CN) → price. Fields keep their
   * ids; the merchant-only ones (catalogue, pickup time, value, address category) sit in their section.
   * Runs once per page, when the fields exist; merchant-features.js fills the slots later.
   */
  function layoutOrderForm() {
    const grid = document.querySelector("#orderForm .form-grid");
    const extra = $("orderExtraFields");
    if (!grid || !extra || extra.dataset.laid) return;
    const doc = !!S.cfg.document;
    const field = id => $(id)?.closest(".form-field") || null;
    const section = title => Object.assign(document.createElement("div"), { className: "form-field full df-ord-section", textContent: title });
    const slot = id => Object.assign(document.createElement("div"), { className: "df-ord-slot", id });
    const make = html => {
      const box = document.createElement("div");
      box.innerHTML = html.trim();
      return box.firstElementChild;
    };
    // New fields the API takes from merchants too: what is inside, and a pre-printed label (CN stock).
    const contents = make(`<div class="form-field"><label for="merchantContents">${doc ? "Item description (optional)" : "Contents (optional)"}</label><input id="merchantContents" maxlength="120"></div>`);
    const cn = make(`<div class="form-field"><label for="merchantCn">Pre-printed CN (optional)</label><input id="merchantCn" maxlength="24" autocomplete="off" placeholder="Label from your CN stock"></div>`);
    // The full address is typed first; district / zone / area follow it.
    const street = $("deliveryAddress");
    if (street) {
      street.placeholder = doc ? "e.g. Level 5, Tower 2, Road 11, Gulshan 2, Dhaka" : "e.g. Flat 4B, House 22, Road 7, Block C, Banani, Dhaka";
      const label = street.closest(".form-field")?.querySelector("label");
      if (label) label.textContent = "Full address";
    }
    const order = [
      section("Service"),
      $("dfOrderServices"),
      slot("dfoPickupSlot"),
      section("Recipient"),
      field("customerName"),
      field("customerPhone"),
      section("Delivery address"),
      field("deliveryAddress"),
      field("merchantDistrict"),
      field("merchantZone"),
      field("merchantArea"),
      field("merchantAddressType"),
      section("Parcel"),
      slot("dfoCatalogSlot"),
      field("merchantProduct"),
      field("merchantWeight"),
      field("orderAmount"),
      field("merchantReferenceNo"),
      contents,
      cn,
      $("merchantPriceHint"),
    ].filter(Boolean);
    // A catalogue picker or pickup time added before the layout goes into its slot.
    const early = { dfoCatalogSlot: field("dffCatalogPick"), dfoPickupSlot: field("dffPickupWindow") };
    extra.replaceChildren(...order);
    for (const [id, el] of Object.entries(early)) if (el) $(id)?.append(el);
    $("deliveryAddress")?.closest(".form-field")?.classList.add("full");
    extra.classList.add("df-ord-laid");
    extra.dataset.laid = "1";
    grid.prepend(extra);
    DF.scanner?.attach?.($("merchantCn"), { title: "Scan the CN label" });
  }

  /** The * on fields required now (same rules as the operations form). */
  function markRequired() {
    const svc = S.pkg ? window.DFOrderServices?.read(S.pkg, "merchantSvc") : {};
    const required = {
      customerName: true,
      customerPhone: true,
      deliveryAddress: true,
      merchantDistrict: true,
      merchantZone: true,
      merchantWeight: true,
      merchantSvcDropHub: svc?.firstMile === "HUB_DROP",
      merchantSvcCodAmount: !!$("merchantSvcCod")?.checked,
    };
    for (const [id, on] of Object.entries(required)) $(id)?.closest(".form-field")?.classList.toggle("df-req", !!on);
  }

  /** Inline errors (DF.validate) and the +880 phone field; set up once, when the fields exist. */
  function wireOrderForm(form) {
    if (form.dfCheck) return;
    DF.phoneInput($("customerPhone"));
    const rules = {
      customerName: v => (v.trim() ? "" : "Enter the recipient's name"),
      merchantDistrict: v => (v ? "" : "Choose the delivery district"),
      merchantZone: v => (v ? "" : "Choose the delivery zone"),
      deliveryAddress: v => (v.trim() ? "" : "Enter the street address"),
      orderAmount: v => (!v || Number(v) >= 0 ? "" : "Enter a value of ৳0 or more"),
      merchantCn: v => (!v.trim() || /^[A-Za-z]{2,4}-\d{6}-[0-9A-Za-z]{4,8}$/.test(v.trim()) ? "" : "Enter the consignment number printed on the label"),
    };
    if ($("merchantWeight")) rules.merchantWeight = v => (!String(v).trim() ? "Enter the weight" : !(Number(v) >= 0.01) ? "At least 0.01 kg" : Number(v) > 50 ? "At most 50 kg" : "");
    const own = DF.validate(form, rules);
    const phone = $("customerPhone");
    form.dfCheck = () => {
      let ok = own();
      phone.dispatchEvent(new Event("blur")); // the phone field shows its own message
      if (DF.phoneProblem(phone.value)) ok = false;
      if (S.svcCheck && !S.svcCheck()) ok = false;
      if (!ok) form.querySelector("[aria-invalid=true]")?.focus();
      return ok;
    };
  }

  function prepareOrderForm() {
    const form = $("orderForm");
    layoutOrderForm();
    if (form) wireOrderForm(form);
    if (!S.merchant || !S.catalog) return;
    const district = $("merchantDistrict");
    if (district && !district.dataset.df) {
      fillPlace(district, S.catalog.districts, "Choose district");
      district.dataset.df = "1";
      cascadeZones();
    }
    for (const id of ["customerPhone"]) $(id)?.setAttribute("autocomplete", "tel-national");
    void prepareServices();
    void updateQuote();
  }

  /**
   * The service package's choices on the order form (shared/order-services.js): only what the
   * merchant's package offers (first / last mile, Service, COD + amount, open box, messages), and the
   * category's products (active, with their type).
   */
  async function prepareServices() {
    const services = window.DFOrderServices;
    if (!services) return;
    try {
      S.pkg = await services.load("/packages/me");
    } catch {
      return;
    }
    const box = $("dfOrderServices");
    if (!box || !S.pkg) return;
    if (box.dataset.pkg !== S.pkg.package.versionId) {
      box.innerHTML = services.block(S.pkg, { prefix: "merchantSvc", productSelect: "merchantProduct", codAmount: true, codChecked: true });
      box.dataset.pkg = S.pkg.package.versionId;
      S.svcCheck = services.checks("merchantSvc");
    }
    const product = $("merchantProduct");
    if (product && product.dataset.pkg !== S.pkg.package.versionId) {
      // Optional: the product's type (Regular, Document, Books) prices the order; none = Regular.
      product.innerHTML = services.productOptions(S.pkg);
      product.dataset.pkg = S.pkg.package.versionId;
    }
    services.sync("merchantSvc");
    markRequired();
    void updateQuote();
  }

  /** The order form as a POST /parcels body. */
  function orderBody() {
    const m = S.merchant;
    const doc = !!S.cfg.document;
    const value = Number($("orderAmount")?.value) || 0;
    const area = $("merchantArea")?.value || undefined;
    // Service package choices (first / last mile, Service, COD + amount, open box, product, messages).
    const svc = S.pkg ? window.DFOrderServices.read(S.pkg, "merchantSvc") : {};
    const { cod, codAmount, ...choices } = svc;
    return {
      ...choices,
      sender: { name: m.name, phone: m.pickupContactPhone || m.contactPhone },
      pickup: { category: "Office", street: m.pickupAddress, area: (m.pickup?.zone ? m.pickup.area : m.pickupArea) || undefined, zone: pickupZone(), district: m.pickupDistrict, ...(m.pickup?.lat != null ? { lat: m.pickup.lat, lng: m.pickup.lng } : {}) },
      recipient: { name: $("customerName").value.trim(), phone: $("customerPhone").value.trim() },
      delivery: { category: $("merchantAddressType")?.value || (doc ? "Office" : "Home"), street: $("deliveryAddress").value.trim(), area, zone: $("merchantZone").value, district: $("merchantDistrict").value },
      type: doc ? "DOCUMENT" : "ECOMMERCE",
      // Banking & Financial has no weight in pricing: the API needs one, 0.5 kg (the included weight).
      weightKg: doc ? 0.5 : Number($("merchantWeight")?.value) || 0.5,
      declaredValue: value || undefined,
      // Cash on delivery: the separate COD amount, only when the package offers COD and it is ticked.
      codAmount: doc ? 0 : codAmount || 0,
      merchantOrderRef: $("merchantReferenceNo")?.value.trim() || undefined,
      contents: $("merchantContents")?.value.trim() || undefined,
      cn: $("merchantCn")?.value.trim().toUpperCase() || undefined,
      // Pickup time window chosen in the form (merchant-features.js), when offered.
      pickupWindow: window.DFMerchantFeatures?.pickupWindow?.() || undefined,
      saveAddresses: false,
    };
  }

  let quoteTimer = null;
  let quoteSeq = 0;
  function updateQuote() {
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(async () => {
      const hint = $("merchantPriceHint");
      if (!hint || !S.merchant) return;
      if (!$("merchantDistrict")?.value) return void (hint.textContent = "Choose the delivery district to see the price from your service package.");
      const body = orderBody();
      const seq = ++quoteSeq;
      try {
        // The same places and choices the booking sends (product included), so the price matches the booked one.
        const quote = await DF.api(`/merchants/me/quote${q()}`, {
          method: "POST",
          body: {
            pickupDistrict: body.pickup.district,
            pickupZone: body.pickup.zone,
            pickupArea: body.pickup.area,
            deliveryDistrict: body.delivery.district,
            ...(body.delivery.zone ? { deliveryZone: body.delivery.zone } : {}),
            ...(body.delivery.area ? { deliveryArea: body.delivery.area } : {}),
            ...(S.cfg.document ? {} : { weightKg: body.weightKg }),
            codAmount: body.codAmount,
            ...(S.pkg ? { firstMile: body.firstMile, dropHubId: body.dropHubId, lastMile: body.lastMile, collectHubId: body.collectHubId, speed: body.speed, openBox: body.openBox, product: body.product } : {}),
          },
        });
        if (seq !== quoteSeq) return;
        S.returnPercent = quote.returnPercent;
        hint.innerHTML = window.DFOrderServices.breakdown(quote) || `Estimated delivery charge ${taka(quote.totalCharge)}.`;
      } catch (error) {
        // A choice the package doesn't allow (e.g. Express outside the same district) explains itself.
        if (seq === quoteSeq) hint.textContent = error instanceof DF.ApiError && error.status === 422 ? DF.describe(error) : "Delivery charges use your service package and are confirmed when you create the order.";
      }
    }, 250);
  }

  /** One key per distinct request: a retry of the same form reuses it, so it can't book twice. */
  let pendingBooking = null;
  const newKey = () => `web-${(crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^\w-]/g, "")}`;

  async function submitOrder(form) {
    const button = form.querySelector('button[type="submit"]');
    if (form.dfCheck && !form.dfCheck()) return showToast("Check the highlighted fields.");
    const body = orderBody();
    const json = JSON.stringify(body);
    if (!pendingBooking || pendingBooking.json !== json) pendingBooking = { json, key: newKey() };
    button.disabled = true;
    try {
      const parcel = await DF.api(`/parcels${q()}`, { method: "POST", body, headers: { "Idempotency-Key": pendingBooking.key } });
      pendingBooking = null;
      form.reset();
      for (const select of form.querySelectorAll("select[data-df]")) delete select.dataset.df;
      for (const el of form.querySelectorAll("[aria-invalid=true]")) el.setAttribute("aria-invalid", "false");
      for (const msg of form.querySelectorAll(".df-field-error")) msg.textContent = "";
      closeOrderModal();
      await refresh({ force: true });
      showToast(`${S.cfg.document ? "Request" : "Order"} ${parcel.trackingId} created · delivery charge ${taka(parcel.charges.total)}.`);
      // The new order's details, with "Print label (PDF)".
      showParcel(parcel);
    } catch (error) {
      // A definite answer means this attempt is over; a lost connection may retry with the same key.
      if (error instanceof DF.ApiError && error.status < 500) pendingBooking = null;
      showToast(DF.describe(error));
    } finally {
      button.disabled = false;
    }
  }

  // ───────────── batch import (shared/importer.js) ─────────────

  const IMPORT_TONES = { good: "status-delivered", warn: "status-pending", bad: "status-failed", info: "status-transit" };
  /** Statuses in which the merchant may still complete an incomplete order (before pickup). */
  const EDITABLE_INCOMPLETE = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];
  const NEEDS_INFO = "__needs_info";

  function importConfig(extra = {}) {
    return {
      kind: S.cfg.document ? "document" : "ecommerce",
      merchantId: S.merchant?.id,
      // Drop at hub: the merchant's own hub (the one serving its pickup area) is chosen by default.
      hubId: S.merchant?.pickupHub?.id || undefined,
      noun: S.cfg.document ? "consignments" : "orders",
      tones: IMPORT_TONES,
      printLabels: (ids, job) => void printImportLabels(ids, job),
      onDone: () => refresh({ force: true }).catch(() => undefined),
      ...extra,
    };
  }

  /** Labels of an import's orders as a PDF in a new tab (its booking batch when it has one). */
  function printImportLabels(ids, job) {
    const format = window.DFPrint.labelFormat();
    if (job?.batch?.id) return window.DFPrint.open(`/documents/labels?batchId=${job.batch.id}&format=${format}`, { title: "Preparing labels…" });
    return window.DFPrint.labels(ids, format);
  }

  document.addEventListener(
    "click",
    event => {
      const el = event.target instanceof Element ? event.target.closest("[data-df-pay-kind], [data-df-payout-edit]") : null;
      if (!el) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (el.matches("[data-df-payout-edit]")) return void openPayout();
      S.payKind = el.dataset.dfPayKind;
      pageData.Payments.rows = paymentRows();
      renderPage("Payments");
    },
    true,
  );
  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="dfPaymentsStyles">
      .df-pay-kinds{display:inline-flex;gap:3px;padding:3px;border-radius:9px;background:#eef1f5}
      .df-pay-kinds .button{border:0;background:transparent;color:#556274;box-shadow:none}
      .df-pay-kinds .button.button-primary{background:#fff;color:#2f55c9;box-shadow:0 1px 2px rgba(16,24,40,.08)}
      .df-paid-to{display:flex;align-items:center;gap:14px;margin:0 0 15px}
      .df-paid-to-icon{flex:none;width:42px;height:42px;border-radius:12px;display:grid;place-items:center;background:var(--green-soft,#e8f7f0);color:var(--green,#16845b);font-size:20px;font-weight:700}
      .df-paid-to-missing .df-paid-to-icon{background:var(--amber-soft,#fff5df);color:var(--amber,#b87913)}
      .df-paid-to-copy{flex:1;display:grid;gap:2px;min-width:0}
      .df-paid-to-copy small{color:#8792a2;font-size:12px;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
      .df-paid-to-copy strong{font-size:15px}
      .df-paid-to-copy span{color:#667085;font-size:13px}
      @media(max-width:560px){.df-paid-to{flex-wrap:wrap}.df-paid-to .button{width:100%}}
    </style>`,
  );

  /** Payments: a paid payout with a receipt photo (taken by finance when paying) gets "Receipt photo". */
  function markReceipts() {
    // Paid payouts: the settlement statement (PDF: parcels, COD, charges, net, where it was paid) and the receipt photo.
    const byNumber = new Map(S.settlements.filter(s => s.status === "PAID").map(s => [s.number, s]));
    for (const row of document.querySelectorAll("#tableBody tr")) {
      const s = byNumber.get(row.cells[0]?.textContent?.trim());
      if (!s || row.querySelector("[data-df-statement]")) continue;
      row.cells[0].insertAdjacentHTML(
        "beforeend",
        `<span style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"><button type="button" class="button button-sm" data-df-statement="${esc(s.id)}" title="The settlement statement: parcels, COD, delivery charges and the amount paid">Statement (PDF)</button>${
          s.paymentProof ? `<button type="button" class="button button-sm" data-df-receipt="${esc(s.id)}" title="Photo of the bank / bKash payment receipt">Receipt photo</button>` : ""
        }</span>`,
      );
    }
  }
  document.addEventListener(
    "click",
    event => {
      const el = event.target instanceof Element ? event.target.closest("[data-df-statement]") : null;
      if (!el) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.DFPrint?.open(`/documents/settlement/${encodeURIComponent(el.dataset.dfStatement)}`, { title: "Preparing the settlement statement…" });
    },
    true,
  );
  document.addEventListener(
    "click",
    event => {
      const el = event.target instanceof Element ? event.target.closest("[data-df-receipt]") : null;
      if (!el) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const tab = window.open("", "_blank");
      DF.apiRaw(`/settlements/${encodeURIComponent(el.dataset.dfReceipt)}/payment-proof`)
        .then(r => r.blob())
        .then(blob => {
          const url = URL.createObjectURL(blob);
          if (tab) tab.location.href = url;
          else window.open(url, "_blank");
        })
        .catch(error => (tab?.close(), showToast(DF.describe(error))));
    },
    true,
  );

  /** Orders page: a "Needs info" badge, a Complete button, the status filter option and the import history button. */
  function markIncomplete() {
    for (const row of document.querySelectorAll("#tableBody tr[data-merchant-record-id]")) {
      const p = byId(row.dataset.merchantRecordId);
      if (!p?.incomplete || row.querySelector("[data-df-needs]")) continue;
      const statusCell = [...row.cells].reverse().find(td => td.querySelector(".status"));
      statusCell?.insertAdjacentHTML("beforeend", ` <span class="status status-pending" data-df-needs title="${esc(`Missing: ${(p.missingLabels || []).join(", ")} (needed before delivery)`)}">Needs info</span>`);
      const cell = row.querySelector("[data-merchant-history]")?.parentElement;
      if (cell && EDITABLE_INCOMPLETE.includes(p.status)) cell.insertAdjacentHTML("beforeend", ` <button type="button" class="button button-sm" data-df-complete="${esc(p.trackingId)}">Complete</button>`);
    }
    // Returned to the merchant and not confirmed yet: "Confirm return received" in the row (merchant-features.js handles it).
    for (const row of document.querySelectorAll("#tableBody tr[data-merchant-record-id]")) {
      const p = byId(row.dataset.merchantRecordId);
      if (!p || p.status !== "RETURNED" || p.returnInfo?.receivedAt || row.querySelector("[data-dff-return-received]")) continue;
      const cell = row.querySelector("[data-merchant-history]")?.parentElement;
      cell?.insertAdjacentHTML("beforeend", ` <button type="button" class="button button-sm button-primary" data-dff-return-received="${esc(p.trackingId)}">Confirm return received</button>`);
    }
    const select = $("merchantStatusFilter");
    if (select && !select.querySelector(`option[value="${NEEDS_INFO}"]`)) {
      const n = S.parcels.filter(p => p.incomplete).length;
      select.insertAdjacentHTML("beforeend", `<option value="${NEEDS_INFO}">Needs info${n ? ` (${n})` : ""}</option>`);
    }
    // Orders toolbar: no Excel template / Import history buttons (both are inside the import dialog).
    $("merchantBulkTemplate")?.remove();
    $("merchantImportHistory")?.remove();
  }

  // ───────────── bills and statements ─────────────

  /** Delivered prepaid parcels not covered by an issued invoice (COD parcels are settled from cash). */
  const unbilledParcels = (from, to) =>
    S.parcels.filter(p => p.status === "DELIVERED" && !p.cod && !billedInvoice(p) && (!from || new Date(p.deliveredAt) >= from) && (!to || new Date(p.deliveredAt) < to));

  /** Pro-forma statement of delivered prepaid parcels not yet invoiced, as a PDF in a new tab. */
  function printStatement(params) {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
    return window.DFPrint.open(`/documents/statement${query.size ? `?${query}` : ""}`, { title: "Preparing the statement…" });
  }

  async function billWithLines(bill) {
    const invoice = await DF.api(`/invoices/${bill._id}`);
    return {
      ...bill,
      lineItems: invoice.lines.map(line => {
        const p = byId(line.trackingId);
        const o = p ? toOrder(p) : null;
        return { trackingId: line.trackingId, documentType: o?.documentType || line.description, branchCode: o?.branchCode || "", referenceNo: o?.referenceNo || "", service: p?.serviceLevelLabel || line.description, charge: line.amount };
      }),
    };
  }

  function billingMonths() {
    const now = new Date();
    return [0, 1, 2].map(back => {
      const start = new Date(now.getFullYear(), now.getMonth() - back, 1);
      return { value: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`, label: `${start.toLocaleDateString("en-US", { month: "long", year: "numeric" })}${back ? "" : " · current period"}`, start, end: new Date(start.getFullYear(), start.getMonth() + 1, 1) };
    });
  }

  /** Corporate billing page (document panel), on real invoices. */
  function realBillingPage() {
    const m = S.merchant;
    const money = S.stats?.money;
    const bills = documentBills;
    const actions = bill =>
      `<div class="billing-actions"><button type="button" class="button button-sm" data-bill-view="${esc(bill.id)}">View / print</button><button type="button" class="button button-sm" data-bill-download="${esc(bill.id)}">Download</button></div>`;
    const body = !isOwner()
      ? `<tr><td colspan="8" class="empty-state">Invoices are visible to workspace owners.</td></tr>`
      : bills.map(bill => `<tr data-document-bill="${esc(bill.id)}"><td><strong>${esc(bill.id)}</strong></td><td>${esc(bill.period)}</td><td>${esc(bill.issued)}</td><td>${esc(bill.due)}</td><td>${bill.shipmentCount}</td><td><strong>${taka(bill.total)}</strong></td><td>${statusPill(bill.status)}</td><td>${actions(bill)}</td></tr>`).join("") ||
        `<tr><td colspan="8" class="empty-state">No invoices yet. Delivery Fast issues one for each month with delivered consignments.</td></tr>`;
    return `<div class="page-heading"><div><p class="eyebrow">Corporate finance · ${esc(m?.name)}</p><h1>Billing & invoices</h1><p class="subtitle">Review delivery charges, preview the charges not yet invoiced, and track invoice settlement.</p></div><div class="heading-actions"><select id="documentBillingPeriod" class="select-small" aria-label="Billing period">${billingMonths().map(month => option(month.value, month.label)).join("")}</select><button class="button button-primary" id="generateDocumentBill">${icon("plus")} Preview unbilled charges</button></div></div>
      <div class="metrics">${metricCard("Outstanding balance", money ? taka(money.invoices.outstanding) : "—", "wallet", money ? `${money.invoices.outstandingCount} unpaid invoice(s)` : "visible to owners", money?.invoices.overdueCount ? `${money.invoices.overdueCount} overdue` : "Due")}${metricCard("Delivered, not billed", String(money?.unbilled.parcels ?? "—"), "box", money ? `${taka(money.unbilled.charges)} in charges` : "visible to owners", "Ready")}${metricCard("Invoices", String(S.invoices.length), "chart", "issued to this account", "")}</div>
      <section class="panel billing-note"><div><strong>Corporate billing account</strong><p>${esc(m?.name)} · ${esc(m?.code)} · Monthly consolidated billing · Due 15 days after issue</p></div><span class="status status-blue">Tax handled per contract</span></section>
      <section class="panel table-panel page-table-panel"><div class="panel-heading"><div><h2 class="panel-title">Invoices & statements</h2><p class="panel-subtitle">Invoices consolidate delivered document consignments; billed consignments are excluded from future bills.</p></div><div class="table-tools"><input class="table-search" id="documentBillSearch" placeholder="Search invoice ID..." aria-label="Search invoices"><button class="button button-sm" id="exportDocumentBills">${icon("download")} Export</button></div></div>
      <div class="table-scroll"><table><thead><tr><th>INVOICE</th><th>BILLING PERIOD</th><th>ISSUED</th><th>DUE DATE</th><th>DOCUMENTS</th><th>AMOUNT</th><th>STATUS</th><th>ACTIONS</th></tr></thead><tbody id="documentBillRows">${body}</tbody></table></div>
      <div class="table-footer"><span>${S.invoices.length} invoice(s) · Live billing data</span><span>Payments are recorded by Delivery Fast finance when your transfer arrives.</span></div></section>
      <div class="layout billing-lower"><section class="panel"><div class="panel-heading"><div><h2 class="panel-title">How monthly billing works</h2><p class="panel-subtitle">A predictable finance workflow for multi-branch institutions</p></div></div><ol class="billing-steps"><li>Delivery Fast issues one invoice per closed month for delivered consignments not previously invoiced.</li><li>Review each tracking ID, document type, origin branch, and internal reference.</li><li>Print or download the statement and route it through your finance approval process.</li><li>Pay by bank transfer quoting the invoice number; the status changes to Paid once finance records it.</li></ol></section><section class="panel"><h2 class="panel-title">Billing controls</h2><div class="billing-controls"><span>Billing frequency<strong>Monthly, consolidated</strong></span><span>Payment terms<strong>Due 15 days from issue</strong></span><span>Invoice currency<strong>BDT · ৳</strong></span><span>Service package<strong>${esc(S.pkg?.package?.name || "Banking & Financial default")}</strong></span></div></section></div>`;
  }

  // ───────────── API & webhooks ─────────────

  function realApiPage() {
    const m = S.merchant;
    const base = `${location.origin}/api/v1`;
    const activeKeys = (S.keys || []).filter(k => !k.revokedAt && (!k.expiresAt || new Date(k.expiresAt) > new Date()));
    const doc = S.cfg.document;
    const example = {
      create: `curl -X POST ${base}/parcels \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -H "Idempotency-Key: ${doc ? "CARD-2026-0012" : "order-1001"}" \\\n  -d '${JSON.stringify({
        sender: { name: m?.name, phone: String(m?.contactPhone || "").replace(/^\+88/, "") },
        pickup: { category: "Office", street: m?.pickupAddress, area: m?.pickupArea, zone: m ? pickupZone() : "Banani", district: m?.pickupDistrict },
        recipient: { name: doc ? "Ayesha Rahman" : "Sophie Williams", phone: "01712345678" },
        delivery: { category: doc ? "Office" : "Home", street: "House 7, Road 2", zone: "Dhanmondi", district: "Dhaka Central" },
        type: doc ? "DOCUMENT" : "ECOMMERCE",
        serviceLevel: doc ? "Express" : "Regular",
        weightKg: doc ? 0.5 : 1,
        ...(doc ? { packaging: "Security pouch", contents: "Cheque book", codAmount: 0 } : { contents: "Everyday Tote Bag", codAmount: 2450 }),
        merchantOrderRef: doc ? "CARD-2026-0012" : "ORDER-1001",
      })}'`,
      status: `curl -H "Authorization: Bearer YOUR_API_KEY" \\\n  ${base}/parcels/PP-261015-0001`,
      list: `curl -H "Authorization: Bearer YOUR_API_KEY" \\\n  "${base}/parcels?status=OUT_FOR_DELIVERY&limit=50&cursor=NEXT_CURSOR"`,
      cancel: `curl -X POST ${base}/parcels/PP-261015-0001/cancel \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"reason":"Customer cancelled the order"}'`,
      webhook: `POST https://your-domain.com/webhooks/delivery-fast HTTP/1.1\nContent-Type: application/json\nUser-Agent: DeliveryFast-Webhooks/1.0\nX-DeliveryFast-Event: shipment.status_updated\nX-DeliveryFast-Delivery: 0199f0c2-7b1e-7d4a-9c55-3f1a2b4c5d6e\nX-DeliveryFast-Signature: t=1791977880,v1=HMAC_SHA256_HEX\n\n{"id":"0199f0c2-7b1e-7d4a-9c55-3f1a2b4c5d6e","event":"shipment.status_updated","createdAt":"2026-10-15T11:42:00.000Z","data":{"trackingId":"PP-261015-0001","merchantOrderRef":"${doc ? "CARD-2026-0012" : "ORDER-1001"}","from":"AT_HUB","status":"OUT_FOR_DELIVERY","statusLabel":"Out for delivery","at":"2026-10-15T11:42:00.000Z"}}`,
      verify: `// Node.js: verify before trusting the body (use the raw request body)\nconst [t, v1] = header.split(",").map(part => part.split("=")[1]);\nconst expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(\`\${t}.\${rawBody}\`).digest("hex");\nconst valid = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected))\n  && Math.abs(Date.now() / 1000 - Number(t)) < 300;`,
      requested: `{"id":"…","event":"pickup.requested","createdAt":"2026-10-15T09:12:00.000Z","data":{"trackingId":"PP-261015-0001","merchantOrderRef":"${doc ? "CARD-2026-0012" : "ORDER-1001"}","totalCharge":120}}`,
    };
    const owner = isOwner();
    const revealed = S.revealed;
    const secretBox = kind =>
      revealed?.kind === kind
        ? `<div class="form-field full" style="margin-top:14px"><label>${esc(revealed.label)} <span class="status status-pending">Shown once</span></label><pre class="api-code" id="dfRevealedSecret">${esc(revealed.value)}</pre><small>${esc(revealed.message)}</small><div style="display:flex;gap:8px;margin-top:8px"><button type="button" class="button button-sm" data-df-copy="#dfRevealedSecret">Copy</button><button type="button" class="button button-sm" data-df-dismiss>I've stored it</button></div></div>`
        : "";
    const keyRows = (S.keys || [])
      .map(k => {
        const expired = k.expiresAt && new Date(k.expiresAt) <= new Date();
        const status = k.revokedAt ? "Revoked" : expired ? "Expired" : "Active";
        const scopes = k.scopes?.length ? k.scopes.map(x => `<code>${esc(x)}</code>`).join(" ") : "<small>Full access</small>";
        return `<tr><td><strong>${esc(k.name)}</strong><div class="panel-subtitle" style="margin-top:3px">${scopes}</div></td><td><code>${esc(k.prefix)}…</code></td><td>${esc(when(k.createdAt))}</td><td>${esc(k.lastUsedAt ? when(k.lastUsedAt) : "Never")}</td><td>${esc(k.expiresAt ? dateOnly(k.expiresAt) : "No expiry")}</td><td>${statusPill(status === "Revoked" ? "Revoked (inactive)" : status)}</td><td>${status === "Active" ? `<button type="button" class="button button-sm" data-df-revoke="${esc(k.id)}">Revoke</button>` : ""}</td></tr>`;
      })
      .join("");
    const keysPanel = !owner
      ? `<p class="panel-subtitle" style="margin:14px 0 0">Only workspace owners can create and revoke API keys.</p>`
      : S.integrationError
        ? `<p class="panel-subtitle" style="margin:14px 0 0">${esc(S.integrationError)}</p>`
        : `${secretBox("key")}<form id="dfApiKeyForm" class="form-grid" style="margin-top:14px"><div class="form-field"><label for="dfApiKeyName">Key name</label><input id="dfApiKeyName" required minlength="2" maxlength="80" placeholder="e.g. Shopify production"></div><div class="form-field"><label for="dfApiKeyExpiry">Expires (optional)</label><input id="dfApiKeyExpiry" type="date"></div><fieldset class="form-field full" style="border:0;padding:0;margin:0"><legend style="font-size:13px;font-weight:600;margin-bottom:6px">Permissions</legend>${API_KEY_SCOPES.map(([value, label]) => `<label style="display:inline-flex;gap:6px;align-items:center;margin:4px 14px 4px 0;color:#536174;font-size:13px"><input type="checkbox" name="dfApiKeyScope" value="${value}" ${["parcels:read", "parcels:write"].includes(value) ? "checked" : ""}> ${esc(label)} <code>${value}</code></label>`).join("")}<small style="display:block">Give each integration only what it needs.</small></fieldset>${S.merchant?.kyc?.status !== "APPROVED" ? `<p class="panel-subtitle full" style="margin:0">API keys may need verified business documents. <a href="#" data-df-open-kyc>Business verification</a></p>` : ""}<div class="form-field full" style="flex-direction:row;align-items:center;gap:10px;flex-wrap:wrap"><button type="submit" class="button button-primary">Create API key</button><span class="panel-subtitle">The full key is shown once. Delivery Fast stores only a hash.</span></div></form>
          <div class="table-scroll" style="margin-top:14px"><table><thead><tr><th>NAME</th><th>KEY</th><th>CREATED</th><th>LAST USED</th><th>EXPIRES</th><th>STATUS</th><th></th></tr></thead><tbody>${keyRows || `<tr><td colspan="7" class="empty-state">No API keys yet.</td></tr>`}</tbody></table></div>`;
    const hooks = S.webhooks || [];
    const hookItems = hooks
      .map(
        h =>
          `<div data-df-hook-item="${esc(h.id)}" style="border:1px solid var(--line);border-radius:10px;padding:12px;margin-top:12px"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><div style="min-width:0"><strong style="font-size:13px;word-break:break-all">${esc(h.url)}</strong><div class="panel-subtitle" style="margin-top:4px">${h.events.map(e => `<code>${esc(e)}</code>`).join(" · ")}</div></div>${statusPill(h.active ? "Active" : "Inactive")}</div><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px"><button type="button" class="button button-sm" data-df-hook-test="${esc(h.id)}">Send test</button><button type="button" class="button button-sm" data-df-hook-deliveries="${esc(h.id)}">Deliveries</button><button type="button" class="button button-sm" data-df-hook-rotate="${esc(h.id)}">Rotate secret</button><button type="button" class="button button-sm" data-df-hook-toggle="${esc(h.id)}">${h.active ? "Pause" : "Resume"}</button><button type="button" class="button button-sm" data-df-hook-delete="${esc(h.id)}">Remove</button></div></div>`,
      )
      .join("");
    const webhookPanel = !owner
      ? `<p class="panel-subtitle" style="margin:14px 0 0">Only workspace owners can configure webhooks.</p>`
      : `${secretBox("webhook")}${hookItems}<form id="dfWebhookForm" style="margin-top:14px"><div class="form-field"><label for="dfWebhookUrl">${hooks.length ? "Add another endpoint" : "HTTPS endpoint URL"}</label><input id="dfWebhookUrl" type="url" required placeholder="https://your-domain.com/webhooks/delivery-fast"><small>Must be a public HTTPS address in production. Up to 5 endpoints.</small></div><fieldset style="border:0;padding:0;margin:14px 0"><legend style="font-size:13px;font-weight:600;margin-bottom:8px">Subscribe to events</legend>${WEBHOOK_EVENTS.map(name => `<label style="display:flex;gap:8px;align-items:center;margin:8px 0;color:#536174;font-size:13px"><input type="checkbox" name="dfWebhookEvent" value="${name}" ${["pickup.requested", "shipment.status_updated"].includes(name) ? "checked" : ""}> <code>${name}</code></label>`).join("")}</fieldset><button type="submit" class="button button-primary">Save webhook</button></form>`;
    return `<div class="page-heading"><div><p class="eyebrow">Developer tools</p><h1>API & Webhooks</h1><p class="subtitle">Book parcels and track them from your ${doc ? "business systems" : "store"} with the Delivery Fast API.</p></div>${statusPill(activeKeys.length ? `${activeKeys.length} active API key${activeKeys.length === 1 ? "" : "s"}` : "No API keys yet")}</div>
      <div class="metrics">${metricCard("API version", "v1", "settings", "Versioned REST API", "stable")}${metricCard("Authentication", "Bearer", "users", "API key in Authorization header", "HTTPS")}${metricCard("Webhook signing", "HMAC-SHA256", "bell", "Verify every event signature", "signed")}</div>
      <section class="panel" style="margin-bottom:14px"><div class="panel-heading"><div><h2 class="panel-title">API keys</h2><p class="panel-subtitle">Server-to-server credentials for ${esc(m?.name)} · ${esc(m?.code)}</p></div>${statusPill(m?.status === "ACTIVE" ? "Active" : "Pending account approval")}</div>${keysPanel}</section>
      <div class="api-layout"><section class="panel"><div class="panel-heading"><div><h2 class="panel-title">API reference</h2><p class="panel-subtitle">REST over HTTPS · JSON request and response bodies · <a href="/api/docs" target="_blank" rel="noopener">full OpenAPI reference ↗</a></p></div><span class="status status-blue">Base URL · ${esc(base)}</span></div>
        <div class="form-grid" style="margin-top:16px"><div class="form-field full"><label>Authentication</label><pre class="api-code">Authorization: Bearer YOUR_API_KEY&#10;Content-Type: application/json&#10;Idempotency-Key: unique-request-id</pre></div>
        <div class="form-field full"><label>Book a ${doc ? "document consignment" : "parcel"} <span class="status status-good">POST /parcels · 201 Created</span></label><pre class="api-code">${esc(example.create)}</pre><small>The server prices the parcel from your service package. Keep the Idempotency-Key stable when retrying: a repeat returns the original parcel. merchantOrderRef must be unique (409 if it was already booked).</small></div>
        <div class="form-field full"><label>Get status and tracking history <span class="status status-blue">GET /parcels/{trackingId}</span></label><pre class="api-code">${esc(example.status)}</pre><small>Includes status, charges, COD and the full event history.</small></div>
        <div class="form-field full"><label>List parcels <span class="status status-blue">GET /parcels</span></label><pre class="api-code">${esc(example.list)}</pre><small>Newest first. Filter by status, q (tracking ID, order reference, name or phone), from and to; pass the returned nextCursor for the next page.</small></div>
        <div class="form-field full"><label>Cancel before pickup is confirmed <span class="status status-blue">POST /parcels/{trackingId}/cancel</span></label><pre class="api-code">${esc(example.cancel)}</pre></div></div><div style="margin-top:14px"><h3 style="font-size:14px;margin:0 0 10px">Example responses</h3><div class="form-grid">
        <div class="form-field"><label>Booked · 201 Created</label><pre class="api-code">{"trackingId":"PP-261015-0001","status":"PENDING_CONFIRMATION","statusLabel":"Pending operations confirmation","charges":{"base":120,"weight":0,"service":0,"codFee":25,"discount":9.6,"total":135.4},"canCancel":true,…}</pre></div>
        <div class="form-field"><label>List · 200 OK</label><pre class="api-code">{"items":[{"trackingId":"PP-261015-0001","status":"OUT_FOR_DELIVERY",…}],"nextCursor":null}</pre></div>
        <div class="form-field"><label>Validation error · 422</label><pre class="api-code">{"error":{"code":"VALIDATION_FAILED","message":"Check the highlighted fields","details":[{"path":"recipient.phone","message":"…"}],"requestId":"…"}}</pre></div>
        <div class="form-field"><label>Duplicate order · 409</label><pre class="api-code">{"error":{"code":"DUPLICATE_ORDER_REF","message":"Order ORDER-1001 was already booked as PP-261015-0001","details":{"trackingId":"PP-261015-0001"},"requestId":"…"}}</pre></div></div><p class="panel-subtitle" style="margin:12px 0 0">Every error has the same shape. Handle 401 (invalid or revoked key), 404 (unknown tracking ID), 409 (duplicate or idempotency conflict), 422 (validation and business rules), 429 (rate limit) and retry 5xx responses with the same Idempotency-Key.</p></div>
      </section><section class="panel"><div class="panel-heading"><div><h2 class="panel-title">Webhooks</h2><p class="panel-subtitle">Receive pickup and shipment status events.</p></div>${statusPill(hooks.length ? "Configured" : "Not configured")}</div>${webhookPanel}
        <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line)"><h3 style="margin:0 0 7px;font-size:13px">Webhook delivery guidance</h3><ul style="margin:0;padding-left:18px;color:#697587;font-size:12px;line-height:1.7"><li>Respond with HTTP 2xx within 10 seconds; process work asynchronously.</li><li>Verify <code>X-DeliveryFast-Signature</code> (HMAC-SHA256 of <code>t.body</code>) with your signing secret and the raw body.</li><li>Deduplicate using the delivery <code>id</code>; delivery is at least once.</li><li>Failed deliveries are retried with backoff; events may arrive out of order.</li><li>Return 2xx for events you safely ignore.</li></ul></div>
      </section></div>
      <section class="panel" style="margin-top:14px"><div class="panel-heading"><div><h2 class="panel-title">Webhook payloads</h2><p class="panel-subtitle">Every event shares one signed envelope.</p></div></div><div class="form-grid" style="margin-top:12px"><div class="form-field"><label>Shipment status update event</label><pre class="api-code">${esc(example.webhook)}</pre></div><div class="form-field"><label>Pickup requested event (body)</label><pre class="api-code">${esc(example.requested)}</pre><label style="margin-top:12px">Verifying the signature</label><pre class="api-code">${esc(example.verify)}</pre></div></div></section>`;
  }

  async function integrationAction(work, success, { reload = true } = {}) {
    try {
      const result = await work();
      if (reload) await loadIntegrations();
      applyData();
      if (S.page === "API & Webhooks" || S.page === "Settings") renderPage(S.page);
      if (success) showToast(typeof success === "function" ? success(result) : success);
      return result;
    } catch (error) {
      showToast(DF.describe(error));
      return null;
    }
  }

  async function showDeliveries(id) {
    const hook = (S.webhooks || []).find(h => h.id === id);
    try {
      const page = await DF.api(`/merchants/me/webhooks/${id}/deliveries?limit=25${q("&")}`);
      const rows = page.items
        .map(d => `<tr><td><code>${esc(d.event)}</code></td><td>${statusPill(d.state === "SUCCEEDED" ? "Delivered" : d.state === "FAILED" ? "Failed" : "Pending")}</td><td>${d.attempts}</td><td>${esc(d.responseCode ?? "—")}</td><td>${esc(when(d.createdAt))}</td><td style="max-width:180px;word-break:break-word">${esc(d.lastError || "")}</td></tr>`)
        .join("");
      dialog(
        "Webhook deliveries",
        esc(hook?.url || ""),
        `<div class="table-scroll"><table><thead><tr><th>EVENT</th><th>STATE</th><th>TRIES</th><th>HTTP</th><th>CREATED</th><th>LAST ERROR</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="empty-state">No deliveries yet. Send a test to check your endpoint.</td></tr>`}</tbody></table></div>`,
        720,
      );
    } catch (error) {
      showToast(DF.describe(error));
    }
  }

  // ───────────── settings ─────────────

  const field = (id, label, value, attrs = "") => `<div class="form-field"><label for="${id}">${esc(label)}</label><input id="${id}" value="${esc(value ?? "")}" ${attrs}></div>`;

  /** The address change waiting for approval (or the last decision), at the top of the profile dialog. */
  async function showAddressRequest() {
    const box = $("dfAddressRequest");
    if (!box) return;
    const r = (await DF.api(`/merchants/me/address-request${q()}`).catch(() => null))?.request || null;
    S.addressRequest = r;
    const tone = { PENDING: ["#fff8e6", "#f5d48a"], APPROVED: ["#effaf5", "#bfe3d5"], REJECTED: ["#fff3ee", "#f3b8a0"] };
    const active = S.merchant.status === "ACTIVE";
    if (!r || (r.status !== "PENDING" && r.decidedAt && Date.now() - new Date(r.decidedAt).getTime() > 14 * 864e5)) {
      box.innerHTML = active ? `<p style="margin:10px 0 0;color:#64748b;font-size:12.5px">Changes to your business or pickup address are checked by Delivery Fast before they apply.</p>` : "";
      return;
    }
    const [bg, border] = tone[r.status] || tone.PENDING;
    const title = r.status === "PENDING" ? "Address change waiting for approval" : r.status === "APPROVED" ? "Address change approved" : "Address change not approved";
    const hub = r.hubChanges ? ` · pickups move from ${esc(r.previousHub?.name || "no hub")} to ${esc(r.proposedHub?.name || "no hub yet")}` : "";
    box.innerHTML = `<div id="dfAddressRequestBox" data-status="${esc(r.status)}" role="status" style="margin-top:12px;padding:10px 12px;border-radius:10px;border:1px solid ${border};background:${bg};font-size:13px;line-height:1.5"><strong>${esc(title)}</strong><div>New pickup address: ${esc(r.proposed?.pickup || "—")}${hub}</div>${
      r.status === "REJECTED" && r.note ? `<div>Reason: ${esc(r.note)}</div>` : ""
    }${r.status === "PENDING" ? `<div style="color:#64748b">Sent ${esc(new Date(r.createdAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}. Your current address stays until it's approved.</div><button type="button" class="button button-sm" data-df-cancel-address style="margin-top:6px">Cancel this change</button>` : ""}</div>`;
  }

  function openProfile() {
    const m = S.merchant;
    const A = window.DFMerchantAddress;
    const backdrop = dialog(
      S.cfg.document ? "Corporate account" : "Store profile",
      `${esc(m.name)} · ${esc(m.code)}`,
      `<form id="dfProfileForm" novalidate><div id="dfAddressRequest"></div><div class="form-grid" style="margin-top:12px">${field("dfContactName", "Contact name", m.contactName, "required minlength=2")}${field("dfContactPhone", "Contact phone", String(m.contactPhone || "").replace(/^\+880/, ""), "required")}${field("dfContactEmail", "Contact email", m.contactEmail, 'type="email"')}${A ? A.formHtml(m) : ""}</div><div class="modal-actions"><button type="button" class="button" data-df-close>Cancel</button><button type="submit" class="button button-primary">Save changes</button></div></form>`,
      720,
    );
    const form = backdrop.querySelector("form");
    void showAddressRequest();
    DF.phoneInput($("dfContactPhone"));
    const address = A ? A.wire(form, m, S.catalog) : null;
    const own = DF.validate(form, { dfContactName: v => (v.trim().length < 2 ? "Enter the contact name" : ""), dfContactEmail: v => (v.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim()) ? "Enter a valid email address" : "") });
    form.dfAddress = address;
    form.dfCheck = () => [own(), address ? address.check() : true].every(Boolean);
  }

  function openPayout() {
    const p = S.merchant.payoutAccount || {};
    dialog(
      "Payout account",
      "Where your COD settlements are paid. We text your contact phone whenever it changes.",
      `<form id="dfPayoutForm"><div class="form-grid" style="margin-top:12px"><div class="form-field"><label for="dfPayoutMethod">Method</label><select id="dfPayoutMethod">${Object.entries(PAYOUT_LABEL).map(([v, l]) => option(v, l, p.method === v)).join("")}</select></div>${field("dfPayoutNumber", "Account / wallet number", p.accountNumber, "required")}${field("dfPayoutName", "Account name", p.accountName, "required minlength=2")}<div class="form-field" data-df-bank>${`<label for="dfPayoutBank">Bank name</label><input id="dfPayoutBank" value="${esc(p.bankName || "")}">`}</div><div class="form-field" data-df-bank><label for="dfPayoutBranch">Branch (optional)</label><input id="dfPayoutBranch" value="${esc(p.branch || "")}"></div><div class="form-field" data-df-bank><label for="dfPayoutRouting">Routing number (optional)</label><input id="dfPayoutRouting" inputmode="numeric" maxlength="11" placeholder="9 digits, e.g. 225261725" value="${esc(p.routingNumber || "")}"></div></div><div class="modal-actions">${S.merchant.payoutAccount ? '<button type="button" class="button" data-df-remove-payout>Remove</button>' : ""}<button type="button" class="button" data-df-close>Cancel</button><button type="submit" class="button button-primary">Save payout account</button></div></form>`,
    );
    const sync = () => document.querySelectorAll("[data-df-bank]").forEach(el => (el.hidden = $("dfPayoutMethod").value !== "BANK"));
    $("dfPayoutMethod").addEventListener("change", sync);
    sync();
  }

  function openTeam() {
    const members = S.members || [];
    const rows = members
      .map(x => `<tr><td><strong>${esc(x.name)}</strong><div class="customer-phone">${esc(phone(x.phone))}${x.email ? ` · ${esc(x.email)}` : ""}</div></td><td>${x.role === "MERCHANT_OWNER" ? "Owner" : "Staff"}</td><td>${esc(x.lastLoginAt ? when(x.lastLoginAt) : "Not yet")}</td><td>${x.userId === DF.auth.user?.id ? "<small>You</small>" : `<button type="button" class="button button-sm" data-df-member-remove="${esc(x.id)}">Remove</button>`}</td></tr>`)
      .join("");
    dialog(
      "Team & permissions",
      "Owners manage billing, API keys and the team. Staff create and track orders.",
      `<div class="table-scroll"><table><thead><tr><th>MEMBER</th><th>ROLE</th><th>LAST SIGN-IN</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="empty-state">No members.</td></tr>`}</tbody></table></div><form id="dfMemberForm"><div class="form-grid" style="margin-top:14px">${field("dfMemberName", "Name", "", "required minlength=2")}${field("dfMemberPhone", "Mobile number", "", 'required placeholder="01XXX-XXXXXX"')}<div class="form-field"><label for="dfMemberRole">Role</label><select id="dfMemberRole">${option("MERCHANT_STAFF", "Staff")}${option("MERCHANT_OWNER", "Owner")}</select></div></div><div class="modal-actions"><button type="button" class="button" data-df-close>Close</button><button type="submit" class="button button-primary">Invite member</button></div></form>`,
      640,
    );
  }

  function settingsAction(name) {
    if (/billing/i.test(name)) return renderPage("Billing");
    if (/profile|corporate account/i.test(name)) return isOwner() ? openProfile() : showToast("Only workspace owners can change the profile.");
    if (/payout/i.test(name)) return isOwner() ? openPayout() : showToast("Only workspace owners can change the payout account.");
    if (/team/i.test(name)) {
      if (!isOwner()) return showToast("Only workspace owners can manage the team.");
      return void loadIntegrations().then(openTeam);
    }
    if (/api/i.test(name)) return renderPage("API & Webhooks");
    if (/plan|package/i.test(name)) return showToast("Service packages are assigned by Delivery Fast. Contact your account manager to change your package.");
    if (/verification/i.test(name)) return window.DFMerchantFeatures ? window.DFMerchantFeatures.openKyc() : showToast("Business verification is loading. Try again in a moment.");
    if (/notification/i.test(name)) return window.DFMerchantFeatures ? window.DFMerchantFeatures.openNotifications() : showToast(`Delivery SMS go to ${phone(S.merchant.contactPhone)}.`);
  }

  async function submitForm(form) {
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    const done = async (work, success) => {
      try {
        await work();
        closeDialog();
        S.merchant = await DF.api(`/merchants/me${q()}`);
        showIdentity();
        await loadIntegrations();
        applyData();
        renderPage(S.page);
        showToast(success);
      } catch (error) {
        showToast(DF.describe(error));
      } finally {
        if (button) button.disabled = false;
      }
    };
    if (form.id === "dfProfileForm") {
      if (form.dfCheck && !form.dfCheck()) {
        if (button) button.disabled = false;
        return form.querySelector("[aria-invalid=true]")?.focus();
      }
      const email = $("dfContactEmail").value.trim();
      const address = form.dfAddress ? form.dfAddress.body() : {};
      try {
        const before = S.merchant.pickupHub?.id || null;
        const pendingBefore = S.addressRequest?.status === "PENDING" ? S.addressRequest.id : null;
        const saved = await DF.api(`/merchants/me${q()}`, { method: "PATCH", body: { contactName: $("dfContactName").value.trim(), contactPhone: $("dfContactPhone").value.trim(), contactEmail: email || null, ...address } });
        S.addressRequest = saved.addressRequest || null;
        // Active merchants: a changed address waits for Delivery Fast's approval (the hub follows it once approved).
        if (saved.addressRequest?.status === "PENDING" && saved.addressRequest.id !== pendingBefore)
          return done(async () => {}, `Profile saved. Your address change was sent to Delivery Fast for approval${saved.addressRequest.hubChanges ? ` (pickups would move to ${saved.addressRequest.proposedHub?.name || "another hub"})` : ""}; until then your current address stays.`);
        const hubNote = (saved.pickupHub?.id || null) !== before ? (saved.pickupHub ? ` Your pickups are now served by ${saved.pickupHub.name}.` : " No hub serves the new pickup area yet; operations will assign one.") : "";
        return done(async () => {}, `Profile saved.${hubNote}`);
      } catch (error) {
        // Field errors (business.zone, pickupContactPhone…) appear under their fields.
        const details = Array.isArray(error?.details) ? error.details : [];
        let shown = false;
        for (const d of details) {
          const input = d.path === "contactPhone" ? $("dfContactPhone") : d.path === "contactName" ? $("dfContactName") : d.path === "contactEmail" ? $("dfContactEmail") : form.dfAddress?.fieldFor(d.path);
          const box = input && (input.closest(".df-phone") || input).nextElementSibling;
          if (box?.classList.contains("df-field-error")) {
            box.textContent = d.message;
            input.setAttribute("aria-invalid", "true");
            input.style.borderColor = "#c2410c";
            if (!shown) input.focus();
            shown = true;
          }
        }
        if (!shown) showToast(DF.describe(error));
        if (button) button.disabled = false;
        return;
      }
    }
    if (form.id === "dfPayoutForm") {
      const method = $("dfPayoutMethod").value;
      const payoutAccount = { method, accountNumber: $("dfPayoutNumber").value.trim(), accountName: $("dfPayoutName").value.trim(), ...(method === "BANK" ? { bankName: $("dfPayoutBank").value.trim(), branch: $("dfPayoutBranch").value.trim() || undefined, routingNumber: $("dfPayoutRouting").value.trim() || undefined } : {}) };
      return done(() => DF.api(`/merchants/me${q()}`, { method: "PATCH", body: { payoutAccount } }), "Payout account saved. We've texted your contact phone about the change.");
    }
    if (form.id === "dfMemberForm") {
      try {
        const result = await DF.api(`/merchants/me/members${q()}`, { method: "POST", body: { name: $("dfMemberName").value.trim(), phone: $("dfMemberPhone").value.trim(), role: $("dfMemberRole").value } });
        await loadIntegrations();
        applyData();
        openTeam();
        if (S.page === "Settings") renderPage("Settings");
        showToast(result.invited ? `${result.member.name} was invited by SMS.` : `${result.member.name} was added to the team.`);
      } catch (error) {
        showToast(DF.describe(error));
      } finally {
        if (button) button.disabled = false;
      }
    }
  }

  // ───────────── wiring ─────────────

  function install() {
    // Real pages in place of the sample-data versions (called by name from the page scripts).
    // Long JSON examples wrap instead of widening the page.
    window.merchantApiDocsPage = () => realApiPage().replaceAll('<pre class="api-code"', '<pre class="api-code" style="white-space:pre-wrap;overflow-wrap:anywhere"');
    window.merchantTrackingHistory = id => void openHistory(id);
    if (S.cfg.document) window.documentBillingPage = realBillingPage;
    // Order modal: real places, service levels and the price preview.
    const openModal = window.openOrderModal;
    window.openOrderModal = function () {
      openModal();
      prepareOrderForm();
    };
    const filters = window.applyMerchantOrderFilters;
    window.applyMerchantOrderFilters = function () {
      // "Needs info": the page's filters, then only incomplete orders.
      const select = $("merchantStatusFilter");
      if (select?.value === NEEDS_INFO) {
        select.value = "";
        try {
          filters();
        } finally {
          select.value = NEEDS_INFO;
        }
        for (const row of document.querySelectorAll("#tableBody tr[data-merchant-record-id]")) if (!byId(row.dataset.merchantRecordId)?.incomplete) row.hidden = true;
      } else filters();
      S.pageNo = 1;
      paginate();
    };
    const render = window.renderPage;
    window.renderPage = function (page) {
      if (locked()) page = VERIFY_PAGE;
      if (page !== S.page && S.revealed) S.revealed = null; // secrets are shown once
      S.page = page;
      render(page);
      afterRender(page);
    };

    window.addEventListener("click", onClick, true);
    window.addEventListener("submit", onSubmit, true);
    window.addEventListener("change", onChange, true);
    window.addEventListener("input", event => {
      if (event.target.closest?.("#orderForm")) updateQuote();
    });
    // Runs after the page's own search handler hid the non-matching rows.
    window.addEventListener("input", event => {
      if (event.target.id === "tableSearch") {
        S.pageNo = 1;
        paginate();
      }
    });
    window.addEventListener("keydown", onSearchKey, true);
  }

  function stop(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onClick(event) {
    const t = event.target;
    if (!(t instanceof Element)) return;
    const hit = selector => t.closest(selector);
    let el;
    if ((el = hit("[data-df-page]"))) {
      stop(event);
      S.pageNo = Number(el.dataset.dfPage);
      return paginate();
    }
    if (hit(".pagination .page-btn")) return stop(event);
    if ((el = hit("[data-df-label]"))) {
      stop(event);
      return void window.DFPrint?.labels([el.dataset.dfLabel], window.DFPrint.labelFormat());
    }
    if ((el = hit("[data-df-cancel]"))) {
      stop(event);
      return void cancelParcel(el.dataset.dfCancel);
    }
    if (hit(".user-profile")) {
      stop(event);
      const user = DF.auth.user;
      if (user) void DF.confirm({ title: "Sign out?", message: `Sign out ${user.name} on this device?`, confirm: "Sign out" }).then(ok => ok && DF.auth.logout().then(() => (location.href = "/#/login")));
      return;
    }
    if (hit(".workspace-switch")) {
      stop(event);
      if (S.workspaces.length < 2) return showToast(S.merchant ? `You're viewing the ${S.merchant.name} workspace (${S.merchant.code}).` : "This account isn't a member of a merchant workspace.");
      void DF.choose({ title: "Switch workspace", label: "Workspace", value: S.merchant?.id, confirm: "Switch", options: S.workspaces.map(w => ({ value: w.id, label: `${w.name} (${w.code})` })) }).then(id => {
        const chosen = S.workspaces.find(w => w.id === id);
        if (!chosen || chosen.id === S.merchant?.id) return;
        try {
          sessionStorage.setItem("deliveryfast-merchant-workspace", chosen.id);
        } catch {}
        location.href = chosen.type === "BANKING_FINANCIAL" ? "/banking-merchant" : "/ecommerce-merchant";
      });
      return;
    }
    // The bell (#notificationButton) belongs to shared/notifications.js, which handles it first.
    if ((el = hit("#mainContent .page-table-panel button[data-toast]")) && S.page === "Settings") {
      stop(event);
      return settingsAction(el.closest("tr")?.cells[0]?.textContent || "");
    }
    if (hit("#generateMerchantBill")) {
      stop(event);
      if (!isOwner()) return showToast("Billing is visible to workspace owners.");
      const parcels = unbilledParcels().filter(p => p.type !== "DOCUMENT");
      if (!parcels.length) return showToast("No delivered prepaid parcels are waiting to be invoiced.");
      void printStatement({ line: "ecommerce" });
      return;
    }
    if (hit("#generateDocumentBill")) {
      stop(event);
      if (!isOwner()) return showToast("Billing is visible to workspace owners.");
      const month = billingMonths().find(m => m.value === $("documentBillingPeriod")?.value) || billingMonths()[0];
      const parcels = unbilledParcels(month.start, month.end);
      if (!parcels.length) return showToast(`No delivered, unbilled consignments in ${month.label.replace(" · current period", "")}.`);
      const last = new Date(month.end.getTime() - 86_400_000);
      const day = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      void printStatement({ from: day(month.start), to: day(last) });
      return;
    }
    if ((el = hit("[data-bill-view], [data-bill-download]"))) {
      stop(event);
      const id = el.dataset.billView || el.dataset.billDownload;
      const bill = documentBills.find(b => b.id === id);
      if (!bill) return;
      if (el.dataset.billView) return void window.DFPrint.open(`/documents/finance-invoice/${bill._id}`, { title: "Preparing the invoice…" });
      void billWithLines(bill)
        .then(full => {
          csvDownload(`${full.id}.csv`, documentBillCsv(full));
          showToast(`${full.id} downloaded as CSV.`);
        })
        .catch(error => showToast(DF.describe(error)));
      return;
    }
    if (hit("[data-bill-paid]")) {
      stop(event);
      return showToast("Payments are recorded by Delivery Fast finance once your transfer arrives.");
    }
    if (hit("#exportDocumentBills")) {
      stop(event);
      const rows = [["Invoice ID", "Billing period", "Issued", "Due", "Documents", "Subtotal", "Tax", "Total", "Status"], ...documentBills.map(b => [b.id, b.period, b.issued, b.due, b.shipmentCount, b.subtotal, b.tax, b.total, b.status])];
      csvDownload(`${S.merchant.code.toLowerCase()}-invoices.csv`, rows.map(row => row.map(value => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n"));
      return showToast("Invoice register downloaded as CSV.");
    }
    // Excel import: shared/importer.js (the same engine as Courier Operations).
    if (hit("#merchantBulkTemplate")) {
      stop(event);
      return void window.DFImport?.template(importConfig());
    }
    if (hit("#merchantBulkImport")) {
      stop(event);
      return void window.DFImport?.open(importConfig());
    }
    if (hit("#merchantImportHistory")) {
      stop(event);
      return void window.DFImport?.history(importConfig());
    }
    if ((el = hit("[data-df-complete]"))) {
      stop(event);
      const p = byId(el.dataset.dfComplete);
      closeDialog();
      if (p) window.DFImport?.complete(p, { tones: IMPORT_TONES, onDone: () => refresh({ force: true }).catch(() => undefined) });
      return;
    }
    if (hit("#merchantPrint")) {
      stop(event);
      const format = $("merchantPrintFormat").value;
      if (format === "shipments") return void merchantPrintShipmentList();
      // Print what the filters and selection show, not every order.
      const ids = merchantSelectedOrders().map(order => order.id);
      if (!ids.length) return showToast("No filtered or selected orders are available to print.");
      return void window.DFPrint.format(format, ids, { title: S.cfg.document ? "Consignment list" : "Order list" });
    }
    if ((el = hit("#exportButton")) && ["Pickup requests", "Customers", "Products", "Payments", "Settings"].includes(S.page)) {
      stop(event);
      const data = pageData[S.page];
      const csv = [data.columns, ...data.rows].map(row => row.map(value => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n");
      csvDownload(`${S.merchant?.code.toLowerCase() || "delivery-fast"}-${S.page.toLowerCase().replaceAll(" ", "-")}.csv`, csv);
      return showToast(`${data.rows.length} ${S.page.toLowerCase()} row(s) exported.`);
    }
    // API & webhooks
    if ((el = hit("[data-df-copy]"))) {
      stop(event);
      const text = document.querySelector(el.dataset.dfCopy)?.textContent || "";
      return void navigator.clipboard?.writeText(text).then(
        () => showToast("Copied to the clipboard."),
        () => showToast("Copy is unavailable; select the text and copy it manually."),
      );
    }
    if (hit("[data-df-dismiss]")) {
      stop(event);
      S.revealed = null;
      return renderPage(S.page);
    }
    if ((el = hit("[data-df-revoke]"))) {
      stop(event);
      const key = (S.keys || []).find(k => k.id === el.dataset.dfRevoke);
      const keyId = el.dataset.dfRevoke;
      return void DF.confirm({ title: `Revoke “${key?.name}”?`, message: "Integrations using this API key stop working immediately.", confirm: "Revoke key", danger: true }).then(ok => ok && integrationAction(() => DF.api(`/merchants/me/api-keys/${keyId}${q()}`, { method: "DELETE" }), `API key “${key?.name}” revoked.`));
    }
    if ((el = hit("[data-df-hook-test]"))) {
      stop(event);
      return void integrationAction(() => DF.api(`/merchants/me/webhooks/${el.dataset.dfHookTest}/test${q()}`, { method: "POST" }), "Test event queued. Check Deliveries for the result.", { reload: false });
    }
    if ((el = hit("[data-df-hook-deliveries]"))) {
      stop(event);
      return void showDeliveries(el.dataset.dfHookDeliveries);
    }
    if ((el = hit("[data-df-hook-rotate]"))) {
      stop(event);
      const hookId = el.dataset.dfHookRotate;
      return void DF.confirm({ title: "Rotate the signing secret?", message: "Deliveries are signed with the new secret right away; update your server first.", confirm: "Rotate secret", danger: true }).then(
        ok =>
          ok &&
          integrationAction(async () => {
            const result = await DF.api(`/merchants/me/webhooks/${hookId}/rotate-secret${q()}`, { method: "POST" });
            S.revealed = { kind: "webhook", label: "New signing secret", value: result.secret, message: result.message };
            return result;
          }, "Signing secret rotated."),
      );
    }
    if ((el = hit("[data-df-hook-toggle]"))) {
      stop(event);
      const hook = (S.webhooks || []).find(h => h.id === el.dataset.dfHookToggle);
      return void integrationAction(() => DF.api(`/merchants/me/webhooks/${hook.id}${q()}`, { method: "PATCH", body: { active: !hook.active } }), hook.active ? "Webhook paused." : "Webhook resumed.");
    }
    if ((el = hit("[data-df-hook-delete]"))) {
      stop(event);
      const hookId = el.dataset.dfHookDelete;
      return void DF.confirm({ title: "Remove this webhook endpoint?", message: "Pending deliveries to it are dropped.", confirm: "Remove webhook", danger: true }).then(ok => ok && integrationAction(() => DF.api(`/merchants/me/webhooks/${hookId}${q()}`, { method: "DELETE" }), "Webhook removed."));
    }
    // Settings dialogs
    if (hit("[data-df-cancel-address]")) {
      stop(event);
      return void DF.api(`/merchants/me/address-request/cancel${q()}`, { method: "POST" }).then(
        () => (showToast("Address change cancelled."), showAddressRequest()),
        error => showToast(DF.describe(error)),
      );
    }
    if (hit("[data-df-close]")) {
      stop(event);
      return closeDialog();
    }
    if (hit("[data-df-remove-payout]")) {
      stop(event);
      return void DF.confirm({ title: "Remove the payout account?", message: "COD settlements can't be paid until you add one.", confirm: "Remove account", danger: true }).then(ok => ok && DF.api(`/merchants/me${q()}`, { method: "PATCH", body: { payoutAccount: null } })
        .then(async merchant => {
          S.merchant = merchant;
          closeDialog();
          applyData();
          renderPage(S.page);
          showToast("Payout account removed.");
        })
        .catch(error => showToast(DF.describe(error))));
    }
    if ((el = hit("[data-df-member-remove]"))) {
      stop(event);
      const member = (S.members || []).find(x => x.id === el.dataset.dfMemberRemove);
      const memberId = el.dataset.dfMemberRemove;
      return void DF.confirm({ title: `Remove ${member?.name}?`, message: `They lose access to ${S.merchant.name} and are signed out right away.`, confirm: "Remove member", danger: true }).then(ok => ok && DF.api(`/merchants/me/members/${memberId}${q()}`, { method: "DELETE" })
        .then(async () => {
          await loadIntegrations();
          applyData();
          openTeam();
          if (S.page === "Settings") renderPage("Settings");
          showToast(`${member?.name} was removed.`);
        })
        .catch(error => showToast(DF.describe(error))));
    }
  }

  function onSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.id === "orderForm") {
      stop(event);
      if (!S.merchant) return showToast("This account isn't a member of a merchant workspace.");
      return void submitOrder(form);
    }
    if (form.id === "dfApiKeyForm") {
      stop(event);
      const expiry = $("dfApiKeyExpiry").value;
      const scopes = [...form.querySelectorAll('input[name="dfApiKeyScope"]:checked')].map(input => input.value);
      if (!scopes.length) return showToast("Choose at least one permission for the key.");
      return void integrationAction(async () => {
        const result = await DF.api(`/merchants/me/api-keys${q()}`, { method: "POST", body: { name: $("dfApiKeyName").value.trim(), scopes, expiresAt: expiry ? new Date(`${expiry}T23:59:59`).toISOString() : undefined } });
        S.revealed = { kind: "key", label: `API key · ${result.name}`, value: result.key, message: result.message };
        return result;
      }, result => `API key “${result.name}” created. Copy it now.`);
    }
    if (form.id === "dfWebhookForm") {
      stop(event);
      const events = [...form.querySelectorAll('input[name="dfWebhookEvent"]:checked')].map(input => input.value);
      if (!events.length) return showToast("Choose at least one webhook event.");
      return void integrationAction(async () => {
        const result = await DF.api(`/merchants/me/webhooks${q()}`, { method: "POST", body: { url: $("dfWebhookUrl").value.trim(), events } });
        S.revealed = { kind: "webhook", label: "Signing secret", value: result.secret, message: result.message };
        return result;
      }, "Webhook saved. Store the signing secret now.");
    }
    if (["dfProfileForm", "dfPayoutForm", "dfMemberForm"].includes(form.id)) {
      stop(event);
      return void submitForm(form);
    }
  }

  function onChange(event) {
    const t = event.target;
    if (t.id === "merchantBulkFile") {
      stop(event);
      const file = t.files?.[0];
      t.value = "";
      if (file) void window.DFImport?.open(importConfig({ file }));
      return;
    }
    if (t.id === "merchantDistrict") cascadeZones();
    if (t.id === "merchantZone") cascadeAreas();
    if (t.closest?.("#dfOrderServices") || t.id === "merchantProduct") {
      window.DFOrderServices?.sync("merchantSvc");
      markRequired();
    }
    if (t.closest?.("#orderForm")) updateQuote();
    if (t.id === "chartPeriod") {
      S.period = { "Last 7 days": "7d", "Last 30 days": "30d", "This year": "year" }[t.value] || "7d";
      void loadStats()
        .then(() => drawChart(document.querySelector("#mainContent svg.chart"), S.stats.series))
        .catch(error => showToast(DF.describe(error)));
    }
  }

  function onSearchKey(event) {
    if (event.key !== "Enter" || event.target.id !== "globalSearch") return;
    // The top search and parcel drawer (shared/merchant-parcel.js) handle it when loaded.
    if (window.DFMerchantParcel) return;
    const query = event.target.value.trim();
    if (!query) return;
    const lower = query.toLowerCase();
    const digits = query.replace(/\D/g, "");
    const match = S.parcels.find(p => p.trackingId.toLowerCase() === lower || (p.merchantOrderRef || "").toLowerCase() === lower || (digits.length >= 10 && p.recipient.phone.endsWith(digits.slice(-10))));
    // A tracking ID (PP-261015-7K3QF; older ones PP-261015-1001) opens its history even when it isn't on the loaded page.
    if (match || /^[A-Z]{2,4}-\d{6}-[0-9A-Z]{4,8}$/i.test(query)) {
      stop(event);
      return void openHistory(match ? match.trackingId : query.toUpperCase());
    }
    if (S.parcels.some(p => p.recipient.name.toLowerCase().includes(lower))) {
      stop(event);
      renderPage("Orders");
      const search = $("tableSearch");
      search.value = query;
      search.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  // ───────────── start ─────────────

  async function boot() {
    install();
    try {
      S.merchant = await resolveMerchant();
    } catch (error) {
      S.merchant = null;
      if (error.status !== 403) console.error("Merchant workspace could not be loaded", error);
    }
    if (S.merchant && S.merchant.type !== S.cfg.type) {
      location.replace(S.merchant.type === "BANKING_FINANCIAL" ? "/banking-merchant" : "/ecommerce-merchant");
      return new Promise(() => {}); // stay hidden while navigating
    }
    showIdentity();
    S.catalog = await DF.api("/catalog").catch(() => null);
    if (S.catalog) {
      // The order form fills district → zone → area from the live catalog (prepareOrderForm, cascadeZones).
      narrowRegions();
      // Products: only the package's parcel products (prepareServices), never the booking catalog.
    }
    // Geography changes in super admin (new / renamed / deactivated places) reach the order form at once.
    DF.events.on("catalog.updated", async () => {
      const fresh = await DF.api("/catalog").catch(() => null);
      if (!fresh) return;
      S.catalog = fresh;
      narrowRegions();
      // The next time the order form opens it lists the fresh places.
      if ($("merchantDistrict")) delete $("merchantDistrict").dataset.df;
    });
    if (!S.merchant) {
      S.stats = emptyStats();
      applyEmpty();
      renderPage("Overview");
      showToast("This account isn't a member of a merchant workspace.");
      return;
    }
    applyLock();
    if (locked()) {
      // Not active: the verification screen only (it loads its own data); approval reloads into the full panel.
      renderPage(VERIFY_PAGE);
      DF.live(["merchant.updated"], () => window.DFMerchantVerification?.reload());
      return;
    }
    await Promise.allSettled([loadParcels(), loadStats(), loadFinance(), loadIntegrations(), loadPackage()]);
    applyData();
    renderPage("Overview");
    // Live updates (server events + reconnect + slow safety poll) instead of fast polling.
    DF.live(["parcel.updated", "parcel.created"], () => refresh());
    // The account itself: suspended (or otherwise no longer active) → the verification screen at once.
    DF.live(["merchant.updated"], async () => {
      const fresh = await DF.api(`/merchants/me${q()}`).catch(() => null);
      if (fresh && fresh.status !== "ACTIVE") return void location.reload();
      if (fresh) S.merchant = fresh;
      return refresh();
    });
  }

  /** Zero counters for an account without a workspace (e.g. a super admin opening the panel). */
  function emptyStats() {
    const month = { created: 0, codValue: 0, declaredValue: 0, deliveryCharges: 0, delivered: 0, returned: 0, deliverySuccessRate: null };
    const labels = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - (6 - i) * 86_400_000).toLocaleDateString("en-US", { month: "short", day: "2-digit" }));
    return {
      parcels: { total: 0, byStatus: {}, awaitingPickup: 0, awaitingDropOff: 0, inTransit: 0, needsAttention: 0, delivered: 0, cancelled: 0, returned: 0 },
      today: { created: 0, pickedUp: 0, delivered: 0, shipments: 0, completionRate: null },
      thisMonth: month,
      lastMonth: month,
      series: { period: "7d", bucket: "day", labels, current: labels.map(() => 0), previous: labels.map(() => 0) },
      customers: { total: 0, newThisMonth: 0, repeat: 0, repeatRate: null },
      money: null,
    };
  }

  function applyEmpty() {
    sampleOrders.length = 0;
    for (const page of ["Shipments", "Pickup requests", "Customers", "Payments"]) pageData[page].rows = [];
    updateNavCounts();
    if (S.cfg.document && typeof documentBills !== "undefined") documentBills = [];
  }

  window.DFMerchantPanel = {
    start(cfg) {
      S.cfg = cfg;
      DF.bridgeReady = boot().catch(error => {
        console.error("Merchant panel could not start", error);
        showToast(DF.describe(error));
      });
    },
    /** For tests, debugging and merchant-features.js. */
    state: S,
    refresh: () => refresh({ force: true }),
    reloadMerchant: async () => {
      S.merchant = await DF.api(`/merchants/me${q()}`);
      applyData();
      if (S.page === "Settings") renderPage("Settings");
      return S.merchant;
    },
    openHistory: id => openHistory(id),
    byId,
    dialog,
    closeDialog,
    merchantQuery: q,
    /** True while the merchant account isn't active: only the "Account verification" screen is open. */
    locked,
  };

  // The address holds the full address: its district / zone / area are picked from it (shared/api.js DF.autoPlace).
  window.DF?.autoPlace?.({ street: "deliveryAddress", district: "merchantDistrict", zone: "merchantZone", area: "merchantArea" });
})();
