/*
 * Connects the rider app to the API.
 * - Pickup queue and deliveries (GET /rider/tasks): pickup outcomes (deliver directly / hand
 *   to a hub / exception) and deliveries with proof (recipient code, signature or photo),
 *   COD and failed attempts.
 * - Overview, My route, Earnings, Performance and Settings from GET /rider/summary (today's,
 *   this week's and this month's work), GET /rider/cash (COD in hand), GET /rider/earnings
 *   (the real earnings ledger, plan and payouts) and GET /rider/my-cash (cash to hand over, the slip).
 * - Start delivery (Deliveries list button, scan page "Mark out for delivery", scan section "Start
 *   deliveries"): POST /rider/parcels/:id/start-delivery sends the recipient a fresh delivery code by
 *   SMS. Assignment sends none, so the OTP proof only appears once the delivery has started.
 * - Scan page: pickup, "Mark out for delivery" (POST /rider/parcels/:id/start-delivery),
 *   delivery, exception and return-to-hub; recent scans are the rider's own tracking events.
 * - Task actions go through DFOffline.send (offline.js): run at once when online, otherwise
 *   queued with an Idempotency-Key and synced later (bridge-pwa.js shows the queue).
 * - Delivery proof carries the capture time and GPS fix, stamped onto the image (bridge-proof.js).
 * - My cash (Earnings): one tap makes a handover slip of all the cash held (POST /rider/my-cash/slip); the
 *   hub scans its barcode and counts the cash (Courier Operations › Accounts › Rider cash).
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

  // The original stylesheet lost its section-title rule (a broken line swallowed it and the subtitle rule after it):
  // every panel's title showed as a large default heading. Restored here, with the money panels' spacing.
  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="dfRiderPanelStyles">
      .panel-title{margin:0;font-size:15px;font-weight:650;color:#182230}
      .panel-subtitle{margin:5px 0 0;color:#96a0ad;font-size:13px;font-weight:400}
      #dfPayPanels{margin-top:0!important}
    </style>`,
  );
  const setText = (el, text) => el && (el.textContent = text);
  const longDate = () => new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const when = iso => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
  const time = iso => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const sameDay = iso => new Date(iso).toDateString() === new Date().toDateString();

  const rider = DF.auth.user.rider;
  const state = { summary: null, cash: null, status: null, earnings: null, myCash: null, returnRuns: [] };
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
      street: DF.addressText(p.delivery.street, p.delivery.area),
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
    const [summary, cash, earnings, myCash] = await Promise.all([
      read("summary", "/rider/summary"),
      read("cash", "/rider/cash"),
      read("earnings", "/rider/earnings").catch(error => (console.error("Delivery Fast: earnings could not be loaded", error), state.earnings)),
      read("myCash", "/rider/my-cash").catch(() => state.myCash),
    ]);
    state.summary = summary;
    state.cash = cash;
    state.earnings = earnings;
    state.myCash = myCash || null;
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
  window.addEventListener("df:rider-hubs", () => rerender());
  const baseCloseModal = closeModal;
  closeModal = function () {
    baseCloseModal();
    if (pending) setTimeout(() => rerender(), 0);
  };

  /** Return runs assigned to the rider (planned or out for return): Home › Assigned returns. */
  async function loadReturns() {
    try {
      state.returnRuns = (await DF.api("/rider/return-runs")).items || [];
    } catch {
      // Keep the last list (offline).
    }
  }

  async function refresh() {
    await Promise.all([DF.rider.reload(), loadSummary(), loadReturns()]);
    syncDeliveries();
    rerender();
  }
  DF.riderRefresh = refresh;
  // Live: new assignments, changes by operations, pay and cash events (plus a slow safety poll).
  DF.live(["parcel.updated", "parcel.created", "rider.earnings", "rider.payout", "cash.slip", "rider.kyc"], refresh, { fallbackMs: 60_000 });

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

  /**
   * Home › "Assigned returns": the return runs the hub gave this rider (Scan desk › Return rider assign),
   * each with its merchant and parcels; "Return now" opens Scan › Return to merchant on that run.
   */
  function returnsCard() {
    const runs = state.returnRuns || [];
    q("#dfReturnsCard")?.remove();
    if (!runs.length) return;
    const anchor = q("#mainContent .metrics") || q("#mainContent .page-heading");
    if (!anchor) return;
    const rows = runs
      .map(
        r => `<div class="alert-item" data-return-run="${esc(r.id)}"><div class="alert-copy"><strong>${esc(r.merchant.name)} · ${r.parcels.length} parcel${r.parcels.length === 1 ? "" : "s"}</strong>${esc(r.merchant.address || "")}<small>${esc(r.number)} · ${r.status === "OUT_FOR_RETURN" ? "Out for return" : "Assigned to you"}${r.merchant.phone ? ` · ${esc(r.merchant.phone)}` : ""}</small></div><button type="button" class="button button-sm button-primary alert-action" data-return-now="${esc(r.id)}">Return now</button></div>`,
      )
      .join("");
    anchor.insertAdjacentHTML(
      "afterend",
      `<section class="panel" id="dfReturnsCard" style="margin:12px 0"><div class="panel-heading"><div><h2 class="panel-title">Assigned returns</h2><p class="panel-subtitle">Take these back to the merchants. Scan each parcel the merchant takes back.</p></div><span class="status status-warn">${runs.reduce((n, r) => n + r.parcels.length, 0)} to return</span></div><div class="alert-list">${rows}</div></section>`,
    );
  }
  window.addEventListener(
    "click",
    event => {
      const button = event.target instanceof Element ? event.target.closest("[data-return-now]") : null;
      if (!button || !DF.scanSections) return;
      event.preventDefault();
      const runId = button.dataset.returnNow;
      void Promise.resolve(DF.scanSections.open("return")).then(() => {
        const S = DF.scanSections.state;
        if (S?.key === "return" && S.ctx) {
          S.ctx.runId = runId;
          S.ctx.checked = new Set();
          const select = document.getElementById("dfScanRun");
          if (select) {
            select.value = runId;
            select.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
      });
    },
    true,
  );

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
      returnsCard();
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
      if (cashPanel) myCashPanel(cashPanel);
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
    // Not started yet: a "Start delivery" button, and the recipient's code is still to come.
    if (name !== "Deliveries") return;
    for (const button of qa("#tableBody [data-delivery]")) {
      const task = deliveryTask(button.dataset.delivery);
      if (!task || task._queued || !["ASSIGNED", "RETRY_SCHEDULED"].includes(task.status)) continue;
      button.insertAdjacentHTML("beforebegin", `<button class="button button-sm button-primary" style="margin-right:6px" data-df-start="${esc(task.trackingId)}">Start delivery</button>`);
      const usesCode = !Array.isArray(task.proofMethods) || task.proofMethods.includes("OTP");
      const hint = task.status === "ASSIGNED" ? "Code will be sent when you start the delivery" : "A new code is sent when you start the delivery again";
      if (usesCode) button.closest("tr")?.querySelector("td.tracking")?.insertAdjacentHTML("beforeend", `<span class="subcell" data-df-code-hint>${esc(hint)}</span>`);
    }
  }

  // "Start delivery": out for delivery, and the recipient gets a fresh delivery code by SMS.
  window.addEventListener(
    "click",
    event => {
      const button = event.target.closest("[data-df-start]");
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const id = button.dataset.dfStart;
      const fromDialog = !!button.closest("#actionModal");
      button.disabled = true;
      post(id, "start-delivery")
        .then(async outcome => {
          if (modalOpen()) closeModal();
          await refresh().catch(() => undefined);
          showToast(outcome?.queued ? `${queuedText(id)} The delivery code is sent when it syncs.` : `${id} is out for delivery. Delivery code sent to the recipient.`);
          // Started from the delivery screen: reopen it, now with the code field.
          if (fromDialog && !outcome?.queued) openModal("delivery", id);
        })
        .catch(error => {
          button.disabled = false;
          showToast(DF.describe(error));
        });
    },
    true,
  );

  // ───────────── call the recipient ─────────────
  // The recipient's number with a call button (tel:) wherever a delivery is listed, and in its dialog.
  // A number printed masked on the label (019***545) can't be called: shown as is, without the button.
  const CALL_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>`;
  const callable = phone => !!phone && !String(phone).includes("*") && /\d{10,}/.test(String(phone).replace(/\D/g, ""));
  const telOf = phone => `tel:${String(phone).startsWith("+") ? phone : `+880${String(phone).replace(/\D/g, "").replace(/^(880|0)/, "")}`}`;
  function callLink(apiPhone) {
    if (!apiPhone) return "";
    const shown = DF.localPhone(apiPhone);
    if (!callable(apiPhone)) return `<span class="df-call" data-df-call-masked style="display:inline-flex;align-items:center;gap:5px;color:#647184;font-size:12px">${esc(shown)} · can't be called</span>`;
    return `<a class="df-call" href="${esc(telOf(apiPhone))}" data-df-call style="display:inline-flex;align-items:center;gap:5px;margin-top:4px;padding:4px 9px;border-radius:999px;background:#e9f7ef;color:#0f7a3d;font-size:12px;font-weight:600;text-decoration:none" aria-label="Call ${esc(shown)}">${CALL_ICON}${esc(shown)}</a>`;
  }
  function addCallLinks() {
    const byId = new Map((DF.rider?.tasks?.deliveries || []).map(p => [p.trackingId, p]));
    for (const cell of document.querySelectorAll("#mainContent td.tracking")) {
      const id = cell.firstChild?.textContent?.trim();
      const p = id && byId.get(id);
      const recipient = cell.parentElement?.querySelector(".recipient");
      if (!p || !recipient || recipient.parentElement.querySelector(".df-call")) continue;
      recipient.parentElement.insertAdjacentHTML("beforeend", `<div>${callLink(p.recipient?.phone)}</div>`);
    }
    // Home: the next stops (matched by recipient name and address, as the page lists them).
    const list = [...byId.values()];
    for (const item of document.querySelectorAll("#mainContent .queue-item")) {
      if (item.querySelector(".df-call")) continue;
      const name = item.querySelector(".queue-copy strong")?.textContent?.trim();
      const p = list.find(x => (x.recipient?.name || "Recipient") === name);
      if (p) item.querySelector(".queue-copy")?.insertAdjacentHTML("beforeend", callLink(p.recipient?.phone));
    }
  }

  const baseRender = render;
  render = function (name) {
    baseRender(name);
    try {
      enhance[name]?.(name);
    } catch (error) {
      console.error(`Delivery Fast: ${name} could not be updated`, error);
    }
    try {
      addCallLinks();
    } catch (error) {
      console.error("Delivery Fast: call buttons could not be added", error);
    }
  };

  // ───────────── dialogs ─────────────

  // Receiver relations (GET /delivery/receiver-relations), loaded once; Self is first and the default.
  const relations = { list: null };
  const relationOptions = () => (relations.list || ["Self"]).map(r => `<option value="${esc(r)}">${esc(r === "Self" ? "Self (the recipient)" : r)}</option>`).join("");
  async function loadRelations() {
    try {
      relations.list = (await DF.api("/delivery/receiver-relations")).relations;
    } catch {
      relations.list = ["Self"];
    }
    const select = $("dfRelation");
    if (select) {
      const chosen = select.value;
      select.innerHTML = relationOptions();
      if (relations.list.includes(chosen)) select.value = chosen;
    }
  }

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
    // The delivery code reaches the recipient only when the delivery starts: no OTP proof before that.
    const task = deliveryTask(id);
    if (type === "delivery" && task && method && !task.deliveryCodeSent) {
      const otpOption = [...method.options].find(o => (o.value || o.textContent) === "OTP");
      if (otpOption) {
        otpOption.remove();
        method.dispatchEvent(new Event("change"));
        const queued = !!task._queued && task.status === "OUT_FOR_DELIVERY";
        const text = queued ? "The delivery code is sent to the recipient when your start syncs." : "Start the delivery first; the code is sent to the recipient then.";
        const start = queued ? "" : ` <button type="button" class="button button-sm button-primary" data-df-start="${esc(id)}">Start delivery</button>`;
        $("modalDescription").insertAdjacentHTML("afterend", `<p class="form-feedback" data-parcel-flags data-df-start-hint style="color:#b87913;font-weight:600">${esc(text)}${start}</p>`);
      }
    }
    // The delivery dialog: call the recipient from it.
    if (type === "delivery" && parcel?.recipient?.phone && !document.querySelector("[data-df-call-dialog]"))
      $("modalDescription")?.insertAdjacentHTML("afterend", `<p data-parcel-flags data-df-call-dialog style="margin:6px 0 0">${esc(parcel.recipient.name || "Recipient")} · ${callLink(parcel.recipient.phone)}</p>`);
    // Who received it, as related to the recipient (super admin's Receiver relations; Self by default).
    const proofBox = $("proofFields");
    if (type === "delivery" && parcel && proofBox && !$("dfRelationBox")) {
      proofBox.insertAdjacentHTML("afterend", `<div class="field full" id="dfRelationBox" data-parcel-flags><label for="dfRelation">Received by</label><select id="dfRelation">${relationOptions()}</select></div>`);
      if (!relations.list) void loadRelations();
    }
    // Partial delivery: the recipient keeps part of the order; the rider enters the cash actually collected.
    // Merchant orders only: what the recipient didn't keep goes back to the merchant.
    if (type === "delivery" && parcel && parcel.merchant && proofBox && !$("dfPartialBox")) {
      const cod = Number(parcel.codAmount) || 0;
      ($("dfRelationBox") || proofBox).insertAdjacentHTML(
        "afterend",
        `<div class="field full" id="dfPartialBox" data-parcel-flags><label style="display:flex;align-items:center;gap:8px;font-weight:600"><input type="checkbox" id="dfPartial" style="width:auto"> Partial delivery (the recipient kept only part of the order)</label><div id="dfPartialCash" hidden style="margin-top:8px"><label for="dfCashCollected">Cash collected (৳)${cod ? ` · COD ৳${cod.toLocaleString("en-BD")}` : ""}</label><input id="dfCashCollected" type="number" min="0" max="${cod}" step="1" inputmode="numeric" placeholder="What the recipient paid"><small>What they didn't keep goes back to the sender: hand it in at the hub.</small></div></div>`,
      );
    }
    const otp = $("deliveryOtp");
    if (otp && apiParcel(id)) {
      otp.placeholder = "4-digit code from the recipient";
      const hint = otp.parentElement.querySelector("small");
      const devCode = deliveryTask(id)?.devDeliveryCode;
      if (hint) hint.textContent = devCode ? `Development code: ${devCode}` : "The recipient received this code by SMS.";
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

  document.addEventListener("change", event => {
    if (event.target?.id === "dfPartial") {
      const box = $("dfPartialCash");
      if (box) box.hidden = !event.target.checked;
      if (event.target.checked) $("dfCashCollected")?.focus();
    }
    if (event.target?.id === "outcome") for (const box of [$("dfPartialBox"), $("dfRelationBox")]) if (box) box.hidden = event.target.value !== "Delivered successfully";
  });

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
          if (!method) throw new Error("Start the delivery first; the code is sent to the recipient then.");
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
          // Partial delivery: the cash actually collected (0 … COD); the rest goes back on a return order.
          if ($("dfPartial")?.checked) {
            const raw = $("dfCashCollected")?.value.trim() ?? "";
            const cash = Number(raw);
            if (raw === "" || !(cash >= 0)) throw new Error("Enter the cash collected for the partial delivery.");
            if (cash > cod) throw new Error(`The cash collected can be at most the COD amount (৳${cod.toLocaleString("en-BD")}).`);
            if (!(await DF.confirm({ title: "Partial delivery?", message: `Confirm you collected ৳${cash.toLocaleString("en-BD")}${cod ? ` of ৳${cod.toLocaleString("en-BD")}` : ""}. What the recipient didn't keep goes back to the sender: bring it to the hub.`, confirm: "Yes, partly delivered", cancel: "Not yet" })))
              throw new Error("Check the cash collected before completing the partial delivery.");
            return post(id, "delivery", { outcome: "DELIVERED", receivedBy: parcel.recipient.name || "Recipient", receiverRelation: $("dfRelation")?.value || "Self", proof, codCollected: cash, partial: true, note, capture });
          }
          if (cod > 0 && !(await DF.confirm({ title: "Cash collected?", message: `Confirm you collected ৳${cod.toLocaleString("en-BD")} cash from the recipient.`, confirm: `Yes, ৳${cod.toLocaleString("en-BD")} collected`, cancel: "Not yet" }))) throw new Error("Collect the COD amount before completing the delivery.");
          return post(id, "delivery", { outcome: "DELIVERED", receivedBy: parcel.recipient.name || "Recipient", receiverRelation: $("dfRelation")?.value || "Self", proof, codCollected: cod, note, capture });
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

  // ───────────── My cash: the cash to hand over and the handover slip (Earnings › Cash reconciliation) ─────────────
  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="dfMyCashStyles">
.mc{display:grid;gap:12px}
.mc-total{border-radius:16px;padding:16px;background:linear-gradient(135deg,#1d3fae,#2f55c9);color:#fff;display:grid;gap:4px}
.mc-total small{opacity:.85;font-size:12px;font-weight:600;letter-spacing:.02em}
.mc-total strong{font-size:30px;font-weight:800;line-height:1.1}
.mc-total span{opacity:.9;font-size:12.5px}
.mc-slip{border:2px dashed #2f55c9;border-radius:16px;padding:14px;display:grid;gap:8px;background:#f5f8ff}
.mc-slip .no{font-family:ui-monospace,monospace;font-size:20px;font-weight:800;letter-spacing:.06em;color:#1d3fae}
.mc-slip p{margin:0;color:#475467;font-size:13px}
.mc-list{display:grid;border:1px solid #e6e9ef;border-radius:12px;overflow:hidden}
.mc-row{display:flex;justify-content:space-between;gap:10px;padding:10px 12px;border-bottom:1px solid #f0f2f5;font-size:13px}
.mc-row:last-child{border-bottom:0}
.mc-row small{display:block;color:#8a94a3}
.mc-btns{display:grid;gap:8px}
.mc-btn{width:100%;height:46px;border-radius:12px;border:1px solid #d0d5dd;background:#fff;font:inherit;font-weight:700;font-size:15px;color:#344054}
.mc-btn.primary{background:#2f55c9;border-color:#2f55c9;color:#fff}
.mc-btn:disabled{opacity:.5}
.mc-due{padding:10px 12px;border-radius:12px;background:#fef3f2;color:#b42318;font-size:13px}
</style>`,
  );
  function myCashPanel(panel) {
    const c = state.myCash;
    const title = q(".panel-title", panel)?.outerHTML || `<h2 class="panel-title">Cash reconciliation</h2>`;
    if (!c) return void (panel.innerHTML = `${title}<p class="panel-subtitle">Loading your cash…</p>`);
    const slip = c.slip;
    const rows = c.parcels
      .map(p => `<div class="mc-row"><span><strong>${esc(p.trackingId)}</strong><small>${esc(p.recipient || "")} · ${esc(time(p.collectedAt))}${p.partial ? " · partial" : ""}</small></span><strong>${money(p.amount)}</strong></div>`)
      .join("");
    panel.innerHTML = `${title}<div class="mc" id="dfMyCash">
      <div class="mc-total"><small>TO HAND OVER AT THE HUB</small><strong>${money(c.total)}</strong><span>${c.parcels.length} COD parcel${c.parcels.length === 1 ? "" : "s"}${c.due ? ` · includes ${money(c.due)} you still owe` : ""}</span></div>
      ${c.dues.length ? `<div class="mc-due">You owe ${money(c.due)} from ${c.dues.map(d => esc(d.source)).join(", ")}: it's added to your next slip.</div>` : ""}
      ${
        slip
          ? `<div class="mc-slip"><p>Your handover slip</p><div class="no">${esc(slip.number)}</div><p><strong>${money(slip.expected)}</strong> · ${slip.parcels} parcel${slip.parcels === 1 ? "" : "s"}${slip.hub ? ` · ${esc(slip.hub.name)}` : ""}</p><p>Show the slip at the hub: they scan its barcode and count the cash.</p>${c.slipOutdated ? `<p style="color:#b54708"><strong>You collected more cash since:</strong> update the slip.</p>` : ""}</div>
             <div class="mc-btns"><button type="button" class="mc-btn primary" data-df-slip="show" data-number="${esc(slip.number)}">Show slip with barcode</button>${c.slipOutdated ? `<button type="button" class="mc-btn" data-df-slip="make">Update slip</button>` : ""}<button type="button" class="mc-btn" data-df-slip="cancel">Cancel slip</button></div>`
          : `<div class="mc-btns"><button type="button" class="mc-btn primary" data-df-slip="make" ${c.total > 0 ? "" : "disabled"}>${c.total > 0 ? "Make handover slip" : "No cash to hand over"}</button></div>`
      }
      ${rows ? `<div class="mc-list">${rows}</div>` : ""}
    </div>`;
  }
  window.addEventListener(
    "click",
    event => {
      const button = event.target instanceof Element ? event.target.closest("[data-df-slip]") : null;
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const action = button.dataset.dfSlip;
      if (action === "show") return void window.DFPrint?.open(`/documents/cash-slip/${encodeURIComponent(button.dataset.number)}`, { title: "Preparing your slip…" });
      if (navigator.onLine === false) return void showToast("You're offline. Make the slip when you're connected.");
      const run = async () => {
        button.disabled = true;
        try {
          if (action === "make") {
            const slip = await DF.api("/rider/my-cash/slip", { method: "POST" });
            showToast(`Slip ${slip.number}: hand ${money(slip.expected)} to the hub.`);
          } else {
            await DF.api("/rider/my-cash/slip/cancel", { method: "POST" });
            showToast("Slip cancelled. You keep the cash until you make a new one.");
          }
          await refresh().catch(() => undefined);
        } catch (error) {
          button.disabled = false;
          showToast(DF.describe(error));
        }
      };
      if (action === "cancel") return void DF.confirm({ title: "Cancel your handover slip?", message: "You keep the cash and can make a new slip later.", confirm: "Cancel slip", cancel: "Keep it", danger: true }).then(ok => ok && run());
      void run();
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
        return void post(id, "start-delivery").then(done(`${id} is out for delivery. Delivery code sent to the recipient.`)).catch(fail);
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
  render(page());
  DF.bridgeReady = Promise.resolve();
  void Promise.all([
    DF.rider.reload().catch(error => console.error("Delivery Fast: rider tasks could not be loaded", error)),
    loadSummary().catch(error => console.error("Delivery Fast: rider summary could not be loaded", error)),
  ]).then(() => {
    syncDeliveries();
    render(page());
  });
})();
