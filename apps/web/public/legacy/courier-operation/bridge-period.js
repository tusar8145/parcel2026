/*
 * Courier Operations: the period filter (shared/period.js, DF.period) on the overview pages.
 *
 *   Today              metrics row = the period's figures (GET /ops/stage-counts?from&to[&forHubIds]
 *                      `metrics`: booked, picked up, delivered, COD collected, success rate, SLA met,
 *                      with the previous period for trends); the stage cards and the "Live now" row
 *                      (waiting for a rider, out for delivery, riders on shift, exceptions, COD with
 *                      riders) stay live and are labelled so. Default: Today.
 *   Reports › Analytics & SLA   the first figures column is the period (GET /ops/analytics?from&to
 *                      `period`), beside this month and last month. Default: Today.
 *
 * The chosen period shows in each page's subtitle ("This week · 17–18 Oct") and in the URL
 * (?period=…, or from/to), so a shared link opens the same period. Loaded last (after bridge-nav.js):
 * it draws after the navigation has laid the page out.
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops || !DF.period) return;
  const $ = id => document.getElementById(id);
  const q = (selector, root = document) => root.querySelector(selector);
  const esc = Ops.esc;
  const pct = v => (v == null ? "—" : `${v}%`);

  const periods = {
    Overview: DF.period.control("ops-today", { defaultKey: "today", onChange: () => Ops.rerender(true) }),
    Analytics: DF.period.control("ops-analytics", { defaultKey: "today", onChange: () => Ops.rerender(true) }),
  };
  Ops.periods = periods;

  /** The period control in the page heading's actions (made when the page has none). */
  function mountIn(period) {
    const heading = q("#mainContent .page-heading");
    if (!heading) return;
    let actions = q(".heading-actions", heading);
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "heading-actions";
      const loose = [...heading.children].filter(el => el.matches("button, a.button"));
      heading.append(actions);
      loose.forEach(el => actions.append(el));
    }
    period.mount(actions, "afterbegin");
  }
  /** "This week · 17–18 Oct · <rest>" as the page subtitle. */
  function subtitle(period, rest) {
    const sub = q("#mainContent .page-heading .subtitle");
    if (!sub) return;
    sub.textContent = `${period.text()}${rest ? ` · ${rest}` : ""}`;
    sub.dataset.periodSubtitle = "";
  }
  /** "↑ 12.5%" / "↓ 3 pts" against the previous period. */
  const change = (now, before) => (before ? `${now >= before ? "↑" : "↓"} ${Math.abs(Math.round(((now - before) / before) * 1000) / 10)}%` : now ? "new" : "—");
  const points = (now, before) => (now == null || before == null ? null : `${now >= before ? "↑" : "↓"} ${Math.abs(Math.round((now - before) * 10) / 10)} pts`);

  // ───────────── Today ─────────────

  const hubKey = () => (Ops.scope?.hubIds?.() || []).join(",");
  const todayMetrics = () => {
    const hubs = hubKey();
    const query = periods.Overview.query();
    return Ops.lazy(`period-today:${hubs}:${query}`, () => DF.api(`/ops/stage-counts?${query}${hubs ? `&forHubIds=${hubs}` : ""}`), 20000);
  };

  function today() {
    const period = periods.Overview;
    mountIn(period);
    const s = period.get();
    subtitle(period, "the figures follow the period; stage cards and “Live now” are right now");
    const data = todayMetrics();
    const m = data?.metrics;
    const box = q("#mainContent .metrics");
    if (box) {
      box.dataset.periodMetrics = s.key;
      box.setAttribute("aria-label", `Figures for ${s.text}`);
      box.innerHTML = [
        ["Booked", m ? Ops.num(m.booked) : "—", "box", m ? change(m.booked, m.previous.booked) : "", m ? s.versus : s.words, "booked"],
        ["Picked up", m ? Ops.num(m.pickedUp) : "—", "truck", m ? change(m.pickedUp, m.previous.pickedUp) : "", m ? s.versus : s.words, "pickedUp"],
        ["Delivered", m ? Ops.num(m.delivered) : "—", "check", m ? `${Ops.num(m.returned)} returned` : "", s.words, "delivered"],
        ["COD collected", m ? Ops.money(m.codCollected) : "—", "wallet", m ? `${Ops.num(m.codCollections)} collection${m.codCollections === 1 ? "" : "s"}` : "", s.words, "codCollected"],
        ["Success · SLA met", m ? `${pct(m.successRate)} · ${pct(m.slaMetRate)}` : "—", "clock", m ? points(m.slaMetRate, m.previous.slaMetRate) || `${Ops.num(m.slaSample)} with a promise` : "", "delivered vs returned · on time", "rates"],
      ]
        .map(([label, value, ico, trend, note, key]) => metric(label, value, ico, trend, note).replace('<article class="metric"', `<article class="metric" data-period-metric="${key}"`))
        .join("");
    }
    liveRow();
    const cards = $("stageCards");
    if (cards && !$("stageCardsNote")) cards.insertAdjacentHTML("beforebegin", `<p class="df-period-note" id="stageCardsNote" style="margin:0 0 6px">Now · parcels in each stage right now (not affected by the period)</p>`);
    if (box && !$("periodMetricsNote")) box.insertAdjacentHTML("beforebegin", `<p class="df-period-note" id="periodMetricsNote" style="margin:0 0 6px"></p>`);
    const note = $("periodMetricsNote");
    if (note) note.textContent = `${s.text}${Ops.scope?.hubIds?.() ? " · your hub" : ""}`;
    const error = Ops.lazyError(`period-today:${hubKey()}:${period.query()}`);
    if (error && box) box.insertAdjacentHTML("afterbegin", `<p class="df-period-error" style="grid-column:1/-1">${esc(DF.describe(error))}</p>`);
  }

  /** The live counts the old metrics row had, kept "now" and labelled so. */
  function liveRow() {
    const o = Ops.overview;
    const anchor = $("stageCards") || q("#mainContent .metrics");
    if (!o || !anchor) return;
    const s = o.shipments;
    let row = $("todayLiveNow");
    if (!row) {
      anchor.insertAdjacentHTML("afterend", `<p class="df-period-note" id="todayLiveNow" style="margin:-4px 0 12px" aria-live="polite"></p>`);
      row = $("todayLiveNow");
    }
    const parts = [
      `<span data-live-now="unassigned">${Ops.num(s.unassigned)} waiting for a rider</span>`,
      `<span data-live-now="outForDelivery">${Ops.num(s.outForDelivery)} out for delivery</span>`,
      `<span data-live-now="riders">${Ops.num(o.riders.online)} of ${Ops.num(o.riders.total)} riders on shift</span>`,
      `<span data-live-now="exceptions">${Ops.num(s.exceptions)} open exception${s.exceptions === 1 ? "" : "s"} · ${Ops.num(s.atRisk)} SLA at risk</span>`,
      o.cash ? `<span data-live-now="cash">${Ops.money(o.cash.withRiders)} COD with riders</span>` : "",
    ].filter(Boolean);
    row.innerHTML = `Live now · ${parts.join(" · ")}`;
  }

  // Parcel changes: the period's figures follow (the counts and overview reload in bridge.js).
  DF.live(
    ["parcel.updated", "parcel.created"],
    () => {
      if (Ops.page() !== "Overview") return;
      Ops.invalidate(`period-today:${hubKey()}:${periods.Overview.query()}`);
      Ops.rerender();
    },
    { debounceMs: 3000, fallbackMs: 180_000 },
  );

  // ───────────── Reports › Analytics & SLA ─────────────

  const analyticsKey = () => `analytics:${periods.Analytics.query()}`;
  const loadAnalytics = () => Ops.lazy(analyticsKey(), () => DF.api(`/ops/analytics?${periods.Analytics.query()}`), 60000);
  // Replaces bridge-pages.js's version: the first figures column is the chosen period.
  Ops.prepare.Analytics = () => {
    const a = loadAnalytics();
    const s = periods.Analytics.get();
    const cfg = genericPages.Analytics;
    cfg.cols = ["SERVICE LEVEL", "TARGET", s.label.toUpperCase(), "THIS MONTH", "PREVIOUS MONTH", "TREND", "HEALTH"];
    const fmt = (v, unit) => (v == null ? "—" : unit === "%" ? `${v}%` : `${v} hrs`);
    cfg.rows = (a?.rows || []).map(r => {
      const delta = r.month != null && r.previousMonth != null ? Math.round((r.month - r.previousMonth) * 10) / 10 : null;
      const trend = delta == null ? "—" : `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(delta)} ${r.unit === "%" ? "pts" : "hrs"}`;
      const value = r.period ?? r.month;
      const ok = value != null && (r.better === "higher" ? value >= r.target : value <= r.target);
      const close = value != null && (r.better === "higher" ? value >= r.target * 0.95 : value <= r.target * 1.25);
      return [r.label, `${r.better === "higher" ? "≥" : "≤"} ${r.target}${r.unit === "%" ? "%" : " hrs"}`, fmt(r.period, r.unit), fmt(r.month, r.unit), fmt(r.previousMonth, r.unit), trend, value == null ? "No data" : ok ? "Healthy" : close ? "Monitor" : "At risk"];
    });
  };
  function analytics() {
    const period = periods.Analytics;
    mountIn(period);
    const s = period.get();
    subtitle(period, "service levels for this period, this month and last month");
    const a = Ops.cache[analyticsKey()]?.value;
    const error = Ops.lazyError(analyticsKey());
    const sub = q("#mainContent .table-panel .panel-heading .panel-subtitle");
    if (sub) sub.textContent = error ? DF.describe(error) : `${s.text} · compared with this month and last month`;
    const foot = q("#mainContent .table-panel > div:last-child");
    if (foot && a?.samples?.period) foot.textContent = `${s.text}: based on ${Ops.num(a.samples.period.delivered)} deliveries and ${Ops.num(a.samples.period.pickups)} pickups`;
    const th = [...document.querySelectorAll("#mainContent .table-panel thead th")][2];
    if (th) th.dataset.periodColumn = s.key;
  }

  // ───────────── drawing ─────────────

  const DRAW = { Overview: today, Analytics: analytics };
  const innerRender = render;
  render = function (page) {
    // Before the page's data is prepared (Analytics loads for the period).
    const target = page === "Live overview" ? "Overview" : page;
    if (periods[target]) periods[target].activate();
    innerRender(page);
    const current = Ops.page();
    const draw = DRAW[current];
    if (!draw) return;
    try {
      periods[current].activate();
      draw();
    } catch (error) {
      console.error(`Paira Express: the ${current} period could not be drawn`, error);
    }
  };
  // The page on screen when this script loads (bridge-nav.js has already drawn it).
  if (DRAW[Ops.page()]) Ops.rerender(true);
})();
