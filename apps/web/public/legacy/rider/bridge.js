/*
 * Connects the rider app to the API.
 * - Pickup queue and deliveries (GET /rider/tasks): pickup outcomes (deliver directly / hand
 *   to a hub / exception) and deliveries with proof (recipient code, signature or photo),
 *   COD and failed attempts.
 * - Overview, My route, Earnings, Performance and Settings from GET /rider/summary (today's,
 *   this week's and this month's work), GET /rider/cash (COD in hand), GET /rider/earnings
 *   (the real earnings ledger, plan and payouts) and GET /rider/handover-requests.
 * - Scan page: pickup, "Mark out for delivery" (POST /rider/parcels/:id/start-delivery),
 *   delivery, exception and return-to-hub; recent scans are the rider's own tracking events.
 * - Task actions go through DFOffline.send (offline.js): run at once when online, otherwise
 *   queued with an Idempotency-Key and synced later (bridge-pwa.js shows the queue).
 * - Delivery proof carries the capture time and GPS fix, stamped onto the image (bridge-proof.js).
 * - "Request cash handover": POST /rider/handover-requests; the hub completes it.
 * - Shift chip / toggle: POST /rider/shift/check-in | check-out (attendance), PATCH /rider/me/status for breaks.
 */
(() => {
  const DF = window.DF;
  const $ = id => document.getElementById(id);
  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const page = () => $("breadcrumbPage").textContent;
  const apiParcel = id => DF.parcels.byTrackingId(id);
  const deliveryTask = id => DF.rider.tasks.deliveries.find(p => p.trackingId === id);
  const pickupTask = id => DF.rider.tasks.pickups.find(p => p.trackingId === id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const money = n => `৳ ${Number(n || 0).toLocaleString("en-BD", { maximumFractionDigits: 2 })}`;
  const setText = (el, text) => el && (el.textContent = text);
  const longDate = () => new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const when = iso => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
  const time = iso => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const sameDay = iso => new Date(iso).toDateString() === new Date().toDateString();

  const rider = DF.auth.user.rider;
  const state = { summary: null, cash: null, status: null, earnings: null, handovers: [] };
  DF.riderState = state; // read by the other rider bridges
  const statusPillFor = text => pill(text); // the page's own status pill
  const VEHICLE = { MOTORBIKE: "Motorcycle", BICYCLE: "Bicycle", VAN: "Van", ON_FOOT: "On foot" };

  DF.showSignedInUser("Verified rider");
  const chip = document.querySelector(".rider-info");
  if (chip) {
    chip.querySelector("strong").textContent = DF.auth.user.name;
    chip.querySelector("small").textContent = `Rider ID · ${rider?.code ?? "—"}`;
    const avatar = document.querySelector(".rider-chip .avatar");
    if (avatar) avatar.textContent = document.querySelector(".user-profile .avatar")?.textContent ?? "";
  }

  // ───────────── the rider's tasks as the page's rows ─────────────

  const lineOf = p => (!p.merchant ? "Customer parcel" : p.merchant.type === "BANKING_FINANCIAL" ? "Document delivery" : "E-commerce parcel");
  const windowOf = p => {
    if (!p.estimatedDeliveryAt) return "As assigned";
    return sameDay(p.estimatedDeliveryAt) ? `By ${time(p.estimatedDeliveryAt)}` : `By ${when(p.estimatedDeliveryAt)}`;
  };
  const byPromise = (a, b) => String(a.estimatedDeliveryAt || "9").localeCompare(String(b.estimatedDeliveryAt || "9"));

  /** Fills the page's delivery list (overview, route, earnings) from the API. */
  function syncDeliveries() {
    // On-demand first (service packages), then by promise.
    const rows = [...DF.rider.tasks.deliveries].sort((a, b) => Number(!!b.onDemand) - Number(!!a.onDemand) || byPromise(a, b)).map(p => ({
      id: p.trackingId,
      recipient: p.recipient.name || "Recipient",
      phone: DF.localPhone(p.recipient.phone),
      address: p.delivery.label,
      street: [p.delivery.street, p.delivery.area].filter(Boolean).join(", "),
      zone: p.delivery.zone,
      type: [lineOf(p), p.onDemand ? "On-demand" : "", p.openBox ? "Open box allowed" : ""].filter(Boolean).join(" · "),
      time: windowOf(p),
      status: p.status === "ASSIGNED" ? "Ready for delivery" : p.statusLabel,
      cod: Number(p.codAmount) > 0 ? money(p.codAmount) : "Prepaid",
      codAmount: Number(p.codAmount) || 0,
    }));
    deliveries.splice(0, deliveries.length, ...rows);
    const set = (name, n) => {
      const badge = q(`#navigation [data-page="${name}"] .nav-count`);
      if (badge) badge.textContent = String(n);
    };
    set("My route", rows.length + DF.rider.tasks.pickups.length);
    set("Deliveries", rows.length);
    set("Pickup queue", DF.rider.tasks.pickups.length);
  }

  // The list pages read the rider's tasks from storage; the sample rows are dropped.
  pageConfig.Deliveries.rows = [];
  pageConfig["Pickup queue"].rows = [];
  pickupJobs.length = 0;
  // A pickup confirmed by operations is still the rider's to collect.
  const baseReadRecords = readCustomerParcelRecords;
  readCustomerParcelRecords = function () {
    return baseReadRecords().map(r => (r.status === "Pickup confirmed" && pickupTask(r.trackingId) ? { ...r, status: "Pickup assigned" } : r));
  };

  // ───────────── loading ─────────────

  /** GET with an offline copy (DFOffline keeps the last answer for reading without a connection). */
  const read = (name, path) => (window.DFOffline ? window.DFOffline.cached(name, () => DF.api(path)) : DF.api(path));

  async function loadSummary() {
    const [summary, cash, earnings, handovers] = await Promise.all([
      read("summary", "/rider/summary"),
      read("cash", "/rider/cash"),
      read("earnings", "/rider/earnings").catch(error => (console.error("Delivery Fast: earnings could not be loaded", error), state.earnings)),
      read("handovers", "/rider/handover-requests").catch(() => state.handovers),
    ]);
    state.summary = summary;
    state.cash = cash;
    state.earnings = earnings;
    state.handovers = handovers || [];
    state.status = summary.rider.status;
    updateShiftChip();
    document.dispatchEvent(new CustomEvent("df:rider-status", { detail: { status: state.status } }));
  }

  const modalOpen = () => $("actionModal").classList.contains("open");
  const typing = () => {
    const el = document.activeElement;
    return el && $("mainContent").contains(el) && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
  };
  let pending = false;
  function rerender(force = false) {
    if (!force && (modalOpen() || typing())) return void (pending = true);
    pending = false;
    render(page());
  }
  const baseCloseModal = closeModal;
  closeModal = function () {
    baseCloseModal();
    if (pending) setTimeout(() => rerender(), 0);
  };

  async function refresh() {
    await Promise.all([DF.rider.reload(), loadSummary()]);
    syncDeliveries();
    rerender();
  }
  DF.riderRefresh = refresh;
  // Live: new assignments, changes by operations, pay and cash events (plus a slow safety poll).
  DF.live(["parcel.updated", "parcel.created", "rider.earnings", "rider.payout", "cod.handover_request", "rider.kyc"], refresh, { fallbackMs: 60_000 });

  window.addEventListener(
    "storage",
    event => {
      if (event.key !== "deliveryfast-customer-parcels") return;
      event.stopImmediatePropagation();
      syncDeliveries();
      rerender();
    },
    true,
  );

  // ───────────── shift status ─────────────

  function updateShiftChip() {
    const el = $("shiftChip");
    if (!el) return;
    const s = state.status;
    el.innerHTML = s === "ONLINE" ? "<i></i> Shift active" : s === "ON_BREAK" ? "<i></i> On break" : "<i></i> Off shift";
    el.style.background = s === "ONLINE" ? "" : "var(--amber-soft)";
    el.style.color = s === "ONLINE" ? "" : "var(--amber)";
    setText($("shiftToggle"), s === "ONLINE" ? "End shift" : "Start shift");
  }

  async function setShift(status, message) {
    try {
      // Starting / ending the shift records attendance (POST /rider/shift/check-in | check-out, which
      // also set the status); breaks and an already-open / closed shift just change the status.
      const shift = status === "ONLINE" && state.status !== "ON_BREAK" ? "check-in" : status === "OFFLINE" ? "check-out" : null;
      let updated = null;
      if (shift)
        try {
          await DF.api(`/rider/shift/${shift}`, { method: "POST", body: {} });
          updated = { status };
        } catch (error) {
          if (!["ALREADY_CHECKED_IN", "NOT_CHECKED_IN"].includes(error?.code)) throw error;
        }
      updated ??= await DF.api("/rider/me/status", { method: "PATCH", body: { status } });
      state.status = updated.status;
      if (state.summary) state.summary.rider.status = updated.status;
      updateShiftChip();
      document.dispatchEvent(new CustomEvent("df:rider-status", { detail: { status: state.status } }));
      rerender(true);
      showToast(message);
    } catch (error) {
      showToast(DF.describe(error));
    }
  }

  window.addEventListener(
    "click",
    event => {
      if (!event.target.closest("#shiftToggle") || state.status === "ONLINE") return;
      event.stopImmediatePropagation();
      void setShift("ONLINE", "Shift started. Dispatch can now see you as available.");
    },
    true,
  );

  // ───────────── earnings (GET /rider/earnings: the rider's earnings ledger) ─────────────

  const LINES = [
    { key: "ecommerce", label: "E-commerce" },
    { key: "document", label: "Documents" },
    { key: "parcel", label: "Customer parcels" },
  ];
  const MODE = { PER_PARCEL: "per parcel", MONTHLY_SALARY: "monthly salary", BOTH: "per parcel + salary" };
  const PAYOUT = { DRAFT: "Being prepared", APPROVED: "Approved", PAID: "Paid", CANCELLED: "Cancelled" };
  const todayLines = () => (state.earnings?.items || []).filter(e => sameDay(e.earnedAt));
  /** Today's pay from the ledger, in the shape the page's earnings widgets read. */
  function realEarnings() {
    const e = state.earnings;
    const lines = todayLines();
    const services = LINES.map(line => {
      const rows = lines.filter(l => l.type === "DELIVERY" && l.serviceLine === line.key);
      return { ...line, count: rows.length, perParcel: e?.plan.rates[line.key] ?? 0, delivery: rows.reduce((n, l) => n + l.amount, 0), salary: 0, monthlySalary: 0 };
    });
    const salary = e?.salaryToday || 0;
    const delivery = e?.today.delivery.amount || 0;
    const pickup = e?.today.pickup.amount || 0;
    const incentive = (e?.today.incentive.amount || 0) + (e?.today.deduction.amount || 0);
    return { services, tier: e?.plan.name || "—", completed: e?.today.delivery.count || 0, delivery, salary, pickup, incentive, today: (e?.totals.today || 0) + salary };
  }
  riderPlanEarnings = realEarnings;

  // ───────────── views ─────────────

  queuePreview = function () {
    const next = deliveries[0];
    const list = deliveries
      .slice(0, 3)
      .map(
        (d, i) =>
          `<div class="queue-item"><div class="stop-marker">${i + 1}</div><div class="queue-copy"><strong>${esc(d.recipient)}</strong><span>${esc(d.address)}</span></div><div class="queue-detail"><strong>${esc(d.time)}</strong><small>${esc(d.id)}</small></div></div>`,
      )
      .join("");
    if (!next) return `<div class="queue-list"><div class="empty-state">No deliveries assigned right now.</div></div>`;
    return `<div class="queue-list">${list}</div><div class="next-stop"><div class="next-label">NEXT DELIVERY · STOP 1 OF ${deliveries.length}</div><div class="next-address">${esc(next.street || next.address)}</div><div class="next-meta">${esc(next.recipient)} · ${icon("box")} ${esc(next.type)} · ${next.codAmount ? `${esc(next.cod)} COD` : "Prepaid"}</div><div class="next-actions"><button class="button button-primary button-sm" data-action="arrive">I'm here</button><button class="button button-sm" data-action="navigate">Navigate ↗</button></div></div>`;
  };

  const setMetrics = items => {
    const box = q("#mainContent .metrics");
    if (box) box.innerHTML = items.map(m => metric(...m)).join("");
  };
  const panelTitled = re => qa("#mainContent .panel").find(p => re.test(q(".panel-title", p)?.textContent || ""));
  const hubName = () => state.summary?.rider.hub?.name || "your hub";
  const initials = () => q(".user-profile .avatar")?.textContent || "";

  function routeMapLabels() {
    setText(q("#mainContent .pin-start span"), initials());
    setText(q("#mainContent .label-start"), `You · ${state.summary?.rider.zone || hubName()}`);
    const next = deliveries[0];
    const stop = q("#mainContent .label-stop");
    if (stop) stop.textContent = next ? `Next · ${next.zone}` : "No stops yet";
  }

  const enhance = {
    Overview() {
      const s = state.summary;
      if (!s) return;
      const first = DF.auth.user.name.split(/\s+/)[0];
      setText(q("#mainContent .page-heading .eyebrow"), `${longDate()} · ${s.rider.zone || hubName()}`);
      const h1 = q("#mainContent .page-heading h1");
      if (h1) h1.innerHTML = `Ready for the road, ${esc(first)} <span style="font-size:19px">👋</span>`;
      setText(q("#mainContent .page-heading .subtitle"), state.status === "ONLINE" ? "Your shift is underway. Here’s your delivery plan for today." : "You’re off shift. Start your shift when you’re ready to ride.");
      updateShiftChip();
      const pay = riderPlanEarnings();
      const total = s.today.delivered + s.today.openDeliveries;
      const next = deliveries.find(d => d.codAmount);
      setMetrics([
        ["Deliveries today", String(total), "truck", `${s.today.delivered} completed`, `of ${total} assigned`],
        ["Pickup stops", String(s.today.openPickups), "box", `${s.today.pickupsCompleted} collected`, "pickups today"],
        ["COD to collect", money(s.today.codToCollect), "wallet", next ? `${next.cod} next` : "nothing due", "cash on delivery"],
        ["Today's earnings", money(pay.today), "chart", `${pay.completed} deliveries`, "earned today"],
      ]);
      const route = panelTitled(/^Route overview$/);
      setText(q(".panel-subtitle", route || document.createElement("div")), `${deliveries.length + s.today.openPickups} stops remaining · ${hubName()}`);
      routeMapLabels();
      const earnings = panelTitled(/^Earnings snapshot$/);
      if (earnings) {
        const e = state.earnings;
        const rows = qa(".earnings-row", earnings);
        if (rows[0]) setText(q("span", rows[0]), `Delivery earnings · ${pay.completed} deliver${pay.completed === 1 ? "y" : "ies"}${pay.salary ? ` + salary ${money(pay.salary)}` : ""}`);
        if (rows[0]) setText(q("strong", rows[0]), money(pay.delivery + pay.salary));
        if (rows[1]) setText(q("span", rows[1]), `Pickup fees · ${e?.today.pickup.count ?? 0} stop${e?.today.pickup.count === 1 ? "" : "s"}`);
        if (rows[2]) setText(q("span", rows[2]), "Incentives & adjustments");
        setText(q(".panel-subtitle", earnings), e ? `Your plan · ${e.plan.name} · ${MODE[e.plan.mode] || ""}` : "Earnings will appear once loaded");
        setText(q(".cash-banner strong", earnings), money(state.cash?.inHand));
      }
    },
    "My route"() {
      const s = state.summary;
      const pickups = DF.rider.tasks.pickups.length;
      const title = panelTitled(/^Today's route/);
      if (title) {
        setText(q(".panel-title", title), `Today's route · ${deliveries.length + pickups} stops`);
        setText(q(".panel-subtitle", title), `${hubName()} · ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}`);
        const foot = qa(".map-footer span", title);
        setText(foot[0], `${deliveries.length} deliveries · ${pickups} pickups`);
        setText(foot[1], s ? `${s.today.delivered} delivered today` : "");
      }
      routeMapLabels();
    },
    Earnings() {
      const s = state.summary;
      if (!s) return;
      const e = state.earnings;
      const pay = riderPlanEarnings();
      const change = s.week.previousWeekDelivered ? Math.round(((s.week.delivered - s.week.previousWeekDelivered) / s.week.previousWeekDelivered) * 1000) / 10 : null;
      setMetrics([
        ["Today's earnings", money(pay.today), "wallet", `${pay.completed} deliveries`, "earned today"],
        ["Incentives", money(pay.incentive), "chart", e?.today.incentive.count ? `${e.today.incentive.count} today` : "none today", "incl. adjustments"],
        ["COD collected", money(state.cash?.inHand), "box", `${state.cash?.collections.length ?? 0} shipments`, "handover due"],
        ["This week", money(e?.totals.week), "chart", change == null ? `${s.week.delivered} deliveries` : `${change >= 0 ? "↑" : "↓"} ${Math.abs(change)}%`, change == null ? "earned" : "deliveries vs. last week"],
      ]);
      const breakdown = panelTitled(/^Today's earnings breakdown$/);
      if (breakdown) {
        setText(q(".panel-subtitle", breakdown), e ? `Plan · ${e.plan.name} · ${MODE[e.plan.mode] || ""} · recorded as you complete each task` : "Earnings couldn't be loaded");
        const list = q("div[style*='margin-top:12px']", breakdown);
        const lines = todayLines();
        if (list)
          list.innerHTML =
            lines
              .map(l => `<div class="earnings-row"><span>${esc(l.description)} · ${esc(time(l.earnedAt))}</span><strong>${money(l.amount)}</strong></div>`)
              .join("") +
              (pay.salary ? `<div class="earnings-row"><span>Salary accrued today · ${money(e.plan.monthlySalary)} a month</span><strong>${money(pay.salary)}</strong></div>` : "") ||
            `<div class="earnings-row"><span>No completed tasks yet today</span><strong>${money(0)}</strong></div>`;
        setText(q(".earnings-total span", breakdown), "Today's earnings");
        setText(q(".earnings-total strong", breakdown), money(pay.today));
      }
      const cashPanel = panelTitled(/^Cash reconciliation$/);
      if (cashPanel) {
        setText(q(".cash-banner strong", cashPanel), money(state.cash?.inHand));
        qa(".earnings-row", cashPanel).forEach(r => r.remove());
        const rows = (state.cash?.collections || [])
          .map(c => `<div class="earnings-row"><span>Cash collected · ${esc(c.trackingId)} · ${esc(time(c.collectedAt))}</span><strong>${money(c.amount)}</strong></div>`)
          .join("");
        q(".cash-banner", cashPanel).insertAdjacentHTML("afterend", rows || `<div class="earnings-row"><span>No COD cash to hand over</span><strong>${money(0)}</strong></div>`);
        const pending = state.handovers.find(h => h.status === "PENDING");
        const button = q('[data-action="handover"]', cashPanel);
        if (pending && button) {
          button.insertAdjacentHTML(
            "beforebegin",
            `<div class="earnings-row" id="dfHandoverPending"><span>Handover requested at ${esc(pending.hub.name)} · ${esc(when(pending.createdAt))}<small style="display:block;color:#8a94a3">Hand ${money(pending.amount)} to the hub cashier. They confirm it in Courier Operations.</small></span>${pill("Pending")}</div>`,
          );
          button.outerHTML = `<button class="button" style="width:100%;margin-top:15px" data-df-cancel-handover="${esc(pending.id)}">Cancel handover request</button>`;
        } else if (button && !(state.cash?.inHand > 0)) button.disabled = true;
      }
      payPanel();
    },
    Performance() {
      const s = state.summary;
      if (!s) return;
      const pct = v => (v == null ? "—" : `${v}%`);
      setMetrics([
        ["On-time rate", pct(s.month.onTimeRate), "chart", `${s.month.delivered} delivered`, "this month"],
        ["Successful delivery", pct(s.month.successRate), "check", `${s.month.attempts} attempts`, "this month"],
        ["Customer rating", "—", "users", "not collected yet", "this month"],
        ["Completed stops", String(s.month.completedStops), "truck", `${s.month.pickups} pickups`, "this month"],
      ]);
      const overview = panelTitled(/^Performance overview$/);
      if (overview) {
        setText(q(".panel-subtitle", overview), `${s.rider.zone || hubName()} · this month`);
        const values = [s.month.onTimeRate, s.month.successRate, null];
        qa(".progress-label strong", overview).forEach((el, i) => setText(el, i === 2 ? "Not collected" : pct(values[i])));
        qa("div[style*='height:100%']", overview).forEach((bar, i) => (bar.style.width = `${values[i] ?? 0}%`));
      }
      const recognition = panelTitled(/^Recent recognition$/);
      if (recognition) {
        qa(".activity", recognition).forEach(a => a.remove());
        recognition.insertAdjacentHTML(
          "beforeend",
          `<div class="activity"><span class="activity-icon">${icon("chart")}</span><div class="activity-copy"><strong>On-time streak</strong> · ${s.onTimeStreak} deliveries in a row<small>Latest deliveries</small></div></div><div class="activity"><span class="activity-icon">${icon("check")}</span><div class="activity-copy"><strong>This week</strong> · ${s.week.delivered} deliveries<small>${s.week.previousWeekDelivered} last week</small></div></div>`,
        );
      }
    },
    Settings() {
      const s = state.summary;
      if (!s) return;
      const values = {
        "Rider name": DF.auth.user.name,
        "Rider ID": s.rider.code,
        "Service zone": s.rider.zone || "—",
        Vehicle: VEHICLE[s.rider.vehicle] || s.rider.vehicle,
        "Preferred service zone": s.rider.zone || "—",
        "App version": "1.0",
      };
      for (const row of qa("#mainContent .earnings-row")) {
        const label = q("span", row)?.textContent;
        if (label in values) setText(q("strong", row), values[label]);
        if (label === "Verification") {
          const pill = q(".status", row);
          if (pill) pill.outerHTML = statusPillFor(s.rider.active ? "Verified" : "Inactive");
        }
        if (label === "Service zone" && s.rider.hub) setText(q("strong", row), `${s.rider.zone || "—"} · ${s.rider.hub.name}`);
      }
    },
    Deliveries: listPage,
    "Pickup queue": listPage,
    "Scan parcel"() {
      for (const note of qa("#mainContent .panel-subtitle")) if (/frontend demo/.test(note.textContent)) note.textContent = "Type the tracking ID, or scan its barcode with a scanner in keyboard mode.";
      const history = $("scanHistory");
      if (!history) return;
      const recent = state.summary?.recent || [];
      history.innerHTML =
        recent
          .map(
            e =>
              `<div class="activity"><span class="activity-icon">${icon(e.status === "DELIVERED" ? "check" : e.status === "OUT_FOR_DELIVERY" ? "scan" : "box")}</span><div class="activity-copy"><strong>${esc(e.trackingId)}</strong> · ${esc(e.title)}<small>${esc([when(e.at), e.location].filter(Boolean).join(" · "))}</small></div></div>`,
          )
          .join("") || `<div class="empty-state">No scans recorded yet.</div>`;
    },
  };
  /** Earnings page: balance and payouts (finance pays them; the rider gets an SMS when paid). */
  function payPanel() {
    const e = state.earnings;
    if (!e) return;
    const payouts =
      e.payouts
        .map(
          p =>
            `<div class="activity"><span class="activity-icon">${icon(p.status === "PAID" ? "check" : "wallet")}</span><div class="activity-copy"><strong>${esc(p.number)}</strong> · ${money(p.amount)} · <span class="status ${p.status === "PAID" ? "status-delivered" : p.status === "CANCELLED" ? "status-failed" : p.status === "APPROVED" ? "status-assigned" : "status-pending"}">${esc(PAYOUT[p.status] || p.status)}</span><small>${esc(new Date(p.periodStart).toLocaleDateString("en-US", { month: "short", day: "numeric" }))} – ${esc(new Date(new Date(p.periodEnd).getTime() - 1).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }))} · ${p.earnings} lines${p.paidAt ? ` · paid ${esc(when(p.paidAt))}${p.paymentMethod ? ` by ${esc(p.paymentMethod.replace("_", " ").toLowerCase())}` : ""}` : ""}</small></div></div>`,
        )
        .join("") || `<div class="empty-state">No payouts yet. Finance prepares payouts from your unpaid earnings.</div>`;
    $("mainContent").insertAdjacentHTML(
      "beforeend",
      `<div class="layout" id="dfPayPanels" style="margin-top:14px"><section class="panel"><div class="panel-heading"><div><h2 class="panel-title">Pay summary</h2><p class="panel-subtitle">${esc(e.plan.name)} plan · ${esc(MODE[e.plan.mode] || "")}${e.plan.source === "manual" ? "" : " · from the rider plans"}</p></div></div><div style="margin-top:12px"><div class="earnings-row"><span>This week</span><strong>${money(e.totals.week)}</strong></div><div class="earnings-row"><span>This month</span><strong>${money(e.totals.month)}</strong></div><div class="earnings-row"><span>Rates · e-commerce / documents / parcels</span><strong>${money(e.plan.rates.ecommerce)} / ${money(e.plan.rates.document)} / ${money(e.plan.rates.parcel)}</strong></div>${e.plan.pickupRate ? `<div class="earnings-row"><span>Pickup rate</span><strong>${money(e.plan.pickupRate)}</strong></div>` : ""}${e.plan.monthlySalary ? `<div class="earnings-row"><span>Monthly salary</span><strong>${money(e.plan.monthlySalary)}</strong></div>` : ""}<div class="earnings-row"><span>Paid to date</span><strong>${money(e.totals.paidToDate)}</strong></div></div><div class="earnings-total"><span>Not yet paid out</span><strong>${money(e.totals.unpaid)}</strong></div></section><section class="panel"><div class="panel-heading"><div><h2 class="panel-title">Payouts</h2><p class="panel-subtitle">Prepared and approved by finance, then paid to you</p></div></div>${payouts}</section></div>`,
    );
  }

  function listPage(name) {
    const rows = qa("#tableBody tr").length;
    setText(q("#mainContent .table-panel .panel-subtitle"), `${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} · ${rows} stop${rows === 1 ? "" : "s"}`);
    const foot = q("#mainContent .table-panel > div:last-child");
    if (foot) foot.textContent = rows ? `Showing all ${rows} ${name === "Deliveries" ? "deliveries" : "pickups"} assigned to you` : `No ${name === "Deliveries" ? "deliveries" : "pickups"} assigned to you right now`;
  }

  const baseRender = render;
  render = function (name) {
    baseRender(name);
    try {
      enhance[name]?.(name);
    } catch (error) {
      console.error(`Delivery Fast: ${name} could not be updated`, error);
    }
  };

  // ───────────── dialogs ─────────────

  // Real hubs and the real delivery-code hint in the dialogs.
  const originalOpenModal = window.openModal;
  window.openModal = function (type, id) {
    document.querySelectorAll("[data-parcel-flags]").forEach(el => el.remove());
    originalOpenModal(type, id);
    const hubSelect = $("pickupHub");
    if (hubSelect && DF.state.hubs.length) {
      hubSelect.innerHTML = DF.state.hubs.map(h => `<option value="${h.id}">${esc(h.name)}</option>`).join("");
      if (state.summary?.rider.hub) hubSelect.value = state.summary.rider.hub.id;
    }
    // Service packages: only the proof methods active for this parcel (OTP needs the delivery code
    // message), and the parcel's flags (open box, on-demand).
    const parcel = apiParcel(id);
    const method = $("proofMethod");
    if (type === "delivery" && parcel && method && Array.isArray(parcel.proofMethods)) {
      const label = { OTP: "OTP", SIGNATURE: "Signature", PHOTO: "Photo" };
      const allowed = parcel.proofMethods.map(m => label[m]).filter(Boolean);
      for (const option of [...method.options]) if (!allowed.includes(option.value || option.textContent)) option.remove();
      method.dispatchEvent(new Event("change"));
      const flags = [parcel.openBox ? "Open box allowed: the recipient may open and check before paying." : "", parcel.onDemand ? "On-demand: top priority." : ""].filter(Boolean);
      if (flags.length) $("modalDescription").insertAdjacentHTML("afterend", `<p class="form-feedback" data-parcel-flags style="color:#0f7a4f;font-weight:600">${esc(flags.join(" "))}</p>`);
    }
    const otp = $("deliveryOtp");
    if (otp && apiParcel(id)) {
      otp.placeholder = "4-digit code from the recipient";
      const hint = otp.parentElement.querySelector("small");
      const devCode = deliveryTask(id)?.devDeliveryCode;
      if (hint) hint.textContent = devCode ? `Development code: ${devCode}` : "The recipient received this code by SMS.";
    }
    if (type === "handover") {
      const amount = $("handoverAmount");
      if (amount) {
        amount.value = String(state.cash?.inHand ?? 0);
        amount.readOnly = true;
      }
      const hub = $("handoverHub");
      if (hub && DF.state.hubs.length) {
        hub.innerHTML = DF.state.hubs.map(h => `<option value="${h.id}">${esc(h.name)}</option>`).join("");
        if (state.summary?.rider.hub) hub.value = state.summary.rider.hub.id;
      }
      $("modalDescription").textContent = `The hub is told you're bringing ${money(state.cash?.inHand)} (${state.cash?.collections.length ?? 0} collection${state.cash?.collections.length === 1 ? "" : "s"}). The cashier counts it and confirms the handover.`;
      $("modalFields").insertAdjacentHTML("beforeend", `<div class="field full"><label for="handoverNote">Note for the cashier (optional)</label><textarea id="handoverNote" maxlength="300" placeholder="e.g. Arriving around 6 PM"></textarea></div>`);
      const pending = state.handovers.find(h => h.status === "PENDING");
      if (pending) $("modalDescription").textContent = `You already asked ${pending.hub.name} to receive ${money(pending.amount)}. Cancel that request on the Earnings page to choose another hub.`;
    }
  };

  const queuedText = id => `${id}: saved on this phone. It syncs automatically when you're back online.`;

  async function submit(work, success) {
    const button = $("submitAction");
    const feedback = $("proofFeedback");
    const activeId = activeAction?.id;
    if (button) button.disabled = true;
    try {
      const outcome = await work();
      closeModal();
      await refresh().catch(error => console.warn("Delivery Fast: refresh after an update failed", error));
      showToast(outcome?.queued ? queuedText(activeId) : success);
    } catch (error) {
      const message = DF.describe(error);
      if (feedback) feedback.textContent = message;
      else showToast(message);
    } finally {
      if (button) button.disabled = false;
    }
  }

  /** A photo as a JPEG data URL, at most 1600 px wide, to keep uploads small. */
  function photoDataUrl(file) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(image.src);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      image.onerror = () => reject(new Error("That photo couldn't be read. Try another image."));
      image.src = URL.createObjectURL(file);
    });
  }

  /** Task updates: sent now, or queued on the phone with an Idempotency-Key when offline. */
  const post = (id, path, body) => {
    const request = { path: `/rider/parcels/${encodeURIComponent(id)}/${path}`, method: "POST", body, trackingId: id, op: path };
    return window.DFOffline ? window.DFOffline.send(request) : DF.api(request.path, { method: "POST", body }).then(result => ({ queued: false, result }));
  };

  window.addEventListener(
    "submit",
    event => {
      if (event.target.id !== "actionForm" || !activeAction) return;
      const { type, id } = activeAction;

      if (type === "shift") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeModal();
        return void setShift("OFFLINE", "Shift ended. Thanks for riding with Delivery Fast.");
      }
      if (type === "handover") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const hub = DF.state.hubs.find(h => h.id === $("handoverHub")?.value);
        if (!hub) return void showToast("Choose the hub you're handing the cash to.");
        if (!(state.cash?.inHand > 0)) return void (closeModal(), showToast("You have no COD cash to hand over."));
        if (navigator.onLine === false) return void showToast("You're offline. Request the handover when you're connected, or hand the cash over at the hub counter.");
        const note = $("handoverNote")?.value.trim() || undefined;
        return void submit(
          async () => {
            const request = await DF.api("/rider/handover-requests", { method: "POST", body: { hubId: hub.id, note }, headers: { "Idempotency-Key": `handover-${crypto.randomUUID?.() ?? Date.now()}` } });
            state.handovers = [request, ...state.handovers.filter(h => h.id !== request.id)];
          },
          `Handover requested: take ${money(state.cash.inHand)} to the cashier at ${hub.name}. They'll confirm it when they count the cash.`,
        );
      }
      if (type === "arrive") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeModal();
        return;
      }
      if ((type !== "pickup" && type !== "delivery") || !apiParcel(id)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const parcel = apiParcel(id);

      if (type === "pickup") {
        const outcome = $("pickupOutcome").value;
        const note = $("pickupNote").value.trim() || undefined;
        if (outcome.includes("submit to hub")) {
          const hubId = $("pickupHub").value;
          const hub = DF.state.hubs.find(h => h.id === hubId);
          return void submit(() => post(id, "pickup", { outcome: "COLLECTED_TO_HUB", hubId, note }), `${id}: pickup completed and handed to ${hub?.name ?? "the hub"}.`);
        }
        if (outcome === "Pickup exception")
          return void submit(() => post(id, "pickup", { outcome: "EXCEPTION", note: note || "Pickup could not be completed." }), `${id}: pickup exception sent to dispatch.`);
        return void submit(() => post(id, "pickup", { outcome: "COLLECTED_DELIVER_DIRECT", note }), `${id}: picked up and out for delivery.`);
      }

      const outcome = $("outcome").value;
      const note = $("recipientNote")?.value.trim() || undefined;
      if (outcome === "Delivered successfully") {
        const method = $("proofMethod").value;
        return void submit(async () => {
          let proof;
          // When and where the proof was taken (device clock + GPS), also stamped onto the image.
          const capture = DF.proof ? await DF.proof.capture() : { capturedAt: new Date().toISOString() };
          const stamp = { trackingId: id, rider: rider?.code, capture };
          if (method === "OTP") {
            const otp = $("deliveryOtp").value.trim();
            if (!/^\d{4,6}$/.test(otp)) throw new Error("Enter the recipient's 4–6 digit delivery code.");
            proof = { method: "OTP", otp };
          }
          if (method === "Signature") {
            if (!proofCanvasDirty) throw new Error("Capture the recipient's signature before completing delivery.");
            const canvas = $("signatureCanvas");
            proof = { method: "SIGNATURE", image: DF.proof ? await DF.proof.stampCanvas(canvas, stamp) : canvas.toDataURL("image/png") };
          }
          if (method === "Photo") {
            const file = $("deliveryPhoto").files[0];
            if (!file) throw new Error("Upload the physical-signature photo to complete delivery.");
            proof = { method: "PHOTO", image: DF.proof ? await DF.proof.stampPhoto(file, stamp) : await photoDataUrl(file) };
          }
          const cod = Number(parcel.codAmount) || 0;
          if (cod > 0 && !confirm(`Confirm you collected ৳${cod.toLocaleString("en-BD")} cash from the recipient.`)) throw new Error("Collect the COD amount before completing the delivery.");
          return post(id, "delivery", { outcome: "DELIVERED", receivedBy: parcel.recipient.name || "Recipient", proof, codCollected: cod, note, capture });
        }, `${id} delivered. ${method} proof saved with time and location.`);
      }

      const reason = $("failureReason").value;
      const next = $("nextStep").value;
      if (!reason || !next) return void ($("proofFeedback").textContent = "Choose a failure reason and the next action.");
      const toHub = outcome === "Return to hub" || next === "Return to hub";
      const failureNote = [$("failureNote")?.value.trim(), note].filter(Boolean).join(" — ") || undefined;
      return void submit(
        () => post(id, "delivery", { outcome: "FAILED", reason, nextAction: toHub ? "RETURN_TO_HUB" : "RETRY", note: failureNote }),
        `${id}: ${reason} · ${toHub ? "returned to hub" : "another attempt scheduled"}.`,
      );
    },
    true,
  );

  // Cancel a pending cash handover request (Earnings page).
  window.addEventListener(
    "click",
    event => {
      const button = event.target.closest("[data-df-cancel-handover]");
      if (!button) return;
      event.stopImmediatePropagation();
      if (!confirm("Cancel your cash handover request?")) return;
      button.disabled = true;
      DF.api(`/rider/handover-requests/${encodeURIComponent(button.dataset.dfCancelHandover)}/cancel`, { method: "POST" })
        .then(async () => {
          await refresh().catch(() => undefined);
          showToast("Handover request cancelled.");
        })
        .catch(error => {
          button.disabled = false;
          showToast(DF.describe(error));
        });
    },
    true,
  );

  // ───────────── stop actions: arrive, navigate, refresh ─────────────

  const mapsUrl = address => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${address}, Bangladesh`)}`;
  window.addEventListener(
    "click",
    event => {
      const action = event.target.closest("[data-action]");
      if (action?.dataset.action === "arrive") {
        event.stopImmediatePropagation();
        const next = deliveries[0];
        if (!next) return void showToast("You have no delivery stops right now.");
        return void openModal("delivery", next.id);
      }
      if (action?.dataset.action === "navigate") {
        event.stopImmediatePropagation();
        const next = deliveries[0] || DF.rider.tasks.pickups[0];
        if (!next) return void showToast("You have no stops to navigate to.");
        const address = next.address || next.pickup?.label;
        window.open(mapsUrl(address), "_blank", "noopener");
        return void showToast(`Opening directions to ${address}…`);
      }
      if (event.target.closest('[data-toast="Route updated just now."]')) {
        event.stopImmediatePropagation();
        refresh()
          .then(() => showToast("Route updated just now."))
          .catch(error => showToast(DF.describe(error)));
      }
    },
    true,
  );

  // ───────────── scan page ─────────────

  const RETURN_REASON = {
    "Recipient did not answer the phone": "Unable to contact recipient",
    "Recipient phone switched off": "Unable to contact recipient",
    "Recipient unavailable at address": "Recipient unavailable",
    "Recipient refused the parcel": "Recipient refused",
    "Incorrect or incomplete address": "Incorrect address",
  };

  window.addEventListener(
    "submit",
    event => {
      if (event.target.id !== "scanForm") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const id = $("trackingInput").value.trim().toUpperCase();
      const action = $("scanAction").value;
      const delivery = deliveryTask(id);
      const pickup = pickupTask(id);
      if (!delivery && !pickup) return void showToast(`${id || "That parcel"} isn't assigned to you. Check the tracking ID or ask dispatch.`);
      const done = message => async outcome => {
        await refresh().catch(() => undefined);
        showToast(outcome?.queued ? queuedText(id) : message);
      };
      const fail = error => showToast(DF.describe(error));

      if (action === "Confirm parcel pickup") {
        if (!pickup) return void showToast(`${id} was already collected. Use “Mark out for delivery” or “Confirm delivery”.`);
        return void openModal("pickup", id);
      }
      if (!delivery) return void showToast(`Collect ${id} first: choose “Confirm parcel pickup”.`);
      if (action === "Mark out for delivery") {
        if (delivery.status === "OUT_FOR_DELIVERY") return void showToast(`${id} is already out for delivery.`);
        return void post(id, "start-delivery").then(done(`${id} is out for delivery. The recipient has their delivery code.`)).catch(fail);
      }
      if (action === "Confirm delivery") return void openModal("delivery", id);
      if (action === "Report delivery exception") {
        openModal("delivery", id);
        const outcome = $("outcome");
        outcome.value = "Failed delivery";
        outcome.dispatchEvent(new Event("change"));
        return;
      }
      // Return to hub
      const note = $("scanReturnNote").value.trim();
      if (!note) {
        $("scanReturnNote").focus();
        return void showToast("Write a return reason before recording this parcel.");
      }
      const category = $("scanReturnReason").value;
      const reason = RETURN_REASON[category] || "Other";
      post(id, "delivery", { outcome: "FAILED", reason, nextAction: "RETURN_TO_HUB", note: [category, note].filter(Boolean).join(": ") })
        .then(done(`${id} returned to ${hubName()} · ${note}`))
        .catch(fail);
    },
    true,
  );

  // ───────────── start ─────────────

  syncDeliveries();
  DF.bridgeReady = (async () => {
    try {
      await loadSummary();
    } catch (error) {
      console.error("Delivery Fast: rider summary could not be loaded", error);
    }
    syncDeliveries();
    render(page());
  })();
})();
