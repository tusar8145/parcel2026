/*
 * Super admin: the period filter (shared/period.js, DF.period) on the dashboards.
 *
 *   Overview            GET /admin/overview?from&to `period` (default This month): platform GMV, bookings,
 *                       revenue (delivery charges), active and new merchants, with the previous period of
 *                       the same length; the "Merchant growth" chart becomes bookings per hour / day /
 *                       month against the previous period. Accounts, the approval queue and admins are now.
 *   Platform activity   GET /analytics/traffic?from&to (default Last 7 days): website visits and tracking
 *                       lookups for the period vs the previous one, sources, and the traffic chart (the
 *                       day's hours for one day, otherwise days, or months for long ranges); active
 *                       merchants from /admin/overview `period`. Riders on shift is now.
 *
 * The chosen period shows in the page subtitle ("This week · 17–18 Oct") and the URL (?period=…).
 * Loaded after bridge-security.js; it draws after the other bridges have decorated the page.
 */
(() => {
  const DF = window.DF;
  if (!DF?.period) return;
  const num = n => Number(n || 0).toLocaleString("en-US");
  const taka = n => `৳ ${Number(n || 0).toLocaleString("en-BD", { maximumFractionDigits: 0 })}`;
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const q = selector => document.querySelector(`#mainContent ${selector}`);
  const change = (now, before) => (before ? `${now >= before ? "↑" : "↓"} ${Math.abs(((now - before) / before) * 100).toFixed(1)}%` : now ? "new" : "—");

  let page = "Overview";
  const periods = {
    Overview: DF.period.control("admin-overview", { defaultKey: "this_month", onChange: () => redraw() }),
    "Platform activity": DF.period.control("admin-activity", { defaultKey: "last_7_days", onChange: () => redraw() }),
  };
  window.DFSuperAdminPeriods = periods;

  // ───────────── data (per period, cached briefly) ─────────────

  const cache = new Map();
  function load(url, maxAge = 30_000) {
    const hit = cache.get(url);
    if (hit && (hit.loading || Date.now() - hit.at < maxAge)) return hit.value;
    cache.set(url, { ...(hit || {}), loading: true, at: hit?.at || 0 });
    DF.api(url)
      .then(value => {
        cache.set(url, { value, at: Date.now() });
        if (periods[page]) redraw();
      })
      .catch(error => {
        cache.set(url, { value: hit?.value, at: Date.now(), error });
        if (error?.status !== 403) console.error("Paira Express: period figures could not be loaded", error);
      });
    return hit?.value;
  }
  const overviewFor = period => load(`/admin/overview?${period.query()}`);
  const trafficFor = period => load(`/analytics/traffic?${period.query()}`);

  // ───────────── drawing ─────────────

  function setMetric(index, label, value, trend, note, root = "#mainContent .metrics") {
    const metric = document.querySelectorAll(`${root} .metric`)[index];
    if (!metric) return;
    if (label) metric.querySelector(".metric-head span").textContent = label;
    metric.querySelector(".metric-value").textContent = value;
    const foot = metric.querySelectorAll(".metric-foot span");
    if (foot[0]) foot[0].textContent = trend;
    if (foot[1]) foot[1].textContent = note;
  }
  function mount(period) {
    const heading = q(".page-heading");
    if (!heading) return;
    let actions = heading.querySelector(".heading-actions");
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "heading-actions";
      heading.append(actions);
    }
    period.mount(actions, "afterbegin");
  }
  function subtitle(period, rest) {
    const sub = q(".page-heading .subtitle");
    if (sub) sub.textContent = `${period.text()} · ${rest}`;
  }

  function overview() {
    const period = periods.Overview;
    mount(period);
    const s = period.get();
    subtitle(period, "bookings, revenue and merchant growth for this period; accounts, approvals and admins are now");
    const p = overviewFor(period)?.period;
    const box = q(".metrics");
    if (box) box.dataset.periodMetrics = s.key;
    if (p) {
      const merchantsNow = document.querySelectorAll("#mainContent .metrics .metric")[0]?.querySelector(".metric-value")?.textContent;
      setMetric(0, "Merchant accounts", merchantsNow || "—", `${num(p.newMerchants)} new`, `${s.words} · accounts now`);
      setMetric(3, "Platform GMV", taka(p.gmv), change(p.gmv, p.previous.gmv), `COD + charges · ${s.words}`);
    }
    // Second row: the period's bookings, revenue and merchants.
    let more = document.getElementById("adminPeriodMetrics");
    if (!more && box) {
      box.insertAdjacentHTML("afterend", `<div class="metrics" id="adminPeriodMetrics">${["Bookings", "Revenue", "Active merchants", "Delivered"].map(label => metric(label, "—", label === "Revenue" ? "chart" : label === "Active merchants" ? "building" : "check", "", "")).join("")}</div>`);
      more = document.getElementById("adminPeriodMetrics");
    }
    if (more && p) {
      const root = "#adminPeriodMetrics";
      setMetric(0, "Bookings", num(p.bookings), change(p.bookings, p.previous.bookings), s.versus, root);
      setMetric(1, "Revenue", taka(p.charges), change(p.charges, p.previous.charges), `delivery charges · ${s.words}`, root);
      setMetric(2, "Active merchants", num(p.activeMerchants), change(p.activeMerchants, p.previous.activeMerchants), `booked ${s.words}`, root);
      setMetric(3, "Delivered", num(p.delivered), change(p.delivered, p.previous.delivered), s.words, root);
      more.dataset.periodMetrics = s.key;
    }
    bookingsChart(p, s);
  }

  /** "Merchant growth & registrations" → bookings in the period vs the previous period. */
  function bookingsChart(p, s) {
    const svg = q("svg.chart");
    const panel = svg?.closest(".panel");
    if (!svg || !panel) return;
    const title = panel.querySelector(".panel-title");
    if (title) title.textContent = "Bookings";
    const sub = panel.querySelector(".panel-subtitle");
    if (sub) sub.textContent = `Parcels booked per ${p?.series.bucket || "day"} · ${s.text} vs. the previous period`;
    const select = document.getElementById("overviewPeriod");
    if (select) select.style.display = "none";
    const legend = panel.querySelectorAll(".chart-legend .legend-item");
    if (legend[0]) legend[0].lastChild.textContent = "Bookings";
    if (legend[1]) legend[1].lastChild.textContent = "Previous period";
    if (!p) return;
    const { current, previous, labels } = p.series;
    const left = 45;
    const right = 665;
    const top = 17;
    const bottom = 130;
    const n = current.length;
    const max = Math.max(4, ...current, ...previous);
    const x = i => (n === 1 ? left : left + (i * (right - left)) / (n - 1));
    const y = v => bottom - (v / max) * (bottom - top);
    const path = values => values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
    const line = path(current);
    svg.querySelector(".chart-line")?.setAttribute("d", line);
    svg.querySelector(".chart-area")?.setAttribute("d", `${line} L${right} ${bottom} L${left} ${bottom}Z`);
    svg.querySelector(".chart-previous")?.setAttribute("d", path(previous));
    const every = Math.max(1, Math.ceil(n / 7));
    const ticks = [1, 0.66, 0.33].map(f => `<text x="2" y="${(y(max * f) + 3).toFixed(1)}">${num(Math.round(max * f))}</text>`).join("");
    const xs = labels.map((label, i) => (i % every === 0 || i === n - 1 ? `<text x="${x(i).toFixed(1)}" y="148" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">${esc(label)}</text>` : "")).join("");
    const labelsBox = svg.querySelector(".chart-labels");
    if (labelsBox) labelsBox.innerHTML = ticks + xs;
    svg.setAttribute("aria-label", `Bookings per ${p.series.bucket}, ${s.text}: ${num(current.reduce((a, b) => a + b, 0))} in total`);
  }

  function activity() {
    const period = periods["Platform activity"];
    mount(period);
    const s = period.get();
    subtitle(period, "website traffic, tracking lookups and active merchants for this period; riders on shift is now");
    const t = trafficFor(period);
    const o = overviewFor(period);
    const box = q(".metrics");
    if (box) box.dataset.periodMetrics = s.key;
    if (t) {
      setMetric(0, "Website visits", num(t.period.visits), change(t.period.visits, t.previousPeriod.visits), `${num(t.period.pageviews)} page views · ${s.words}`);
      setMetric(1, "Tracking lookups", num(t.period.trackingLookups), change(t.period.trackingLookups, t.previousPeriod.trackingLookups), s.words);
      trafficChart(t, s);
    }
    if (o?.period) setMetric(2, "Active merchants", num(o.period.activeMerchants), `${num(o.period.bookings)} bookings`, `booked ${s.words}`);
    const riders = document.querySelectorAll("#mainContent .metrics .metric")[3];
    const riderNote = riders?.querySelectorAll(".metric-foot span")[1];
    if (riderNote && !/now/.test(riderNote.textContent)) riderNote.textContent = `${riderNote.textContent} · now`;
  }

  function trafficChart(t, s) {
    const bars = q(".traffic-bars");
    if (!bars) return;
    const panel = bars.closest(".panel");
    const hourly = t.hourlyScope === "day";
    // Hours of the day, days, or months for long periods.
    let points;
    if (hourly) points = t.hourly.map(h => ({ label: new Date(h.hour).toLocaleTimeString("en-US", { timeZone: "Asia/Dhaka", hour: "numeric" }), visits: h.visits, pageviews: h.pageviews }));
    else if (t.daily.length > 62) {
      const months = new Map();
      for (const d of t.daily) {
        const key = d.day.slice(0, 7);
        const m = months.get(key) || { label: new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }), visits: 0, pageviews: 0 };
        m.visits += d.visits;
        m.pageviews += d.pageviews;
        months.set(key, m);
      }
      points = [...months.values()];
    } else points = t.daily.map(d => ({ label: new Date(`${d.day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }), visits: d.visits, pageviews: d.pageviews }));
    const max = Math.max(1, ...points.map(p => p.visits));
    bars.style.gap = points.length > 31 ? "2px" : "";
    bars.innerHTML = points.map(p => `<span class="traffic-bar" style="height:${Math.max(4, Math.round((p.visits / max) * 100))}%" data-value="${p.visits}" title="${esc(p.label)} · ${num(p.visits)} visits · ${num(p.pageviews)} page views"></span>`).join("");
    bars.setAttribute("aria-label", `Website visits by ${hourly ? "hour" : points.length === t.daily.length ? "day" : "month"}, ${s.text}: ${num(t.period.visits)} in total`);
    const labels = q(".traffic-labels");
    if (labels) {
      const every = Math.max(1, Math.ceil(points.length / 7));
      labels.innerHTML = points.filter((_, i) => i % every === 0 || i === points.length - 1).map(p => `<span>${esc(p.label)}</span>`).join("");
    }
    const sub = panel?.querySelector(".panel-subtitle");
    if (sub) sub.textContent = `Visits across the public site · ${hourly ? `${s.text}, by hour` : s.text}`;
    const tag = panel?.querySelector(".panel-heading .activity-tag");
    if (tag) tag.textContent = `${num(t.period.visits)} visits`;
    const list = q(".activity-source-list");
    if (list) {
      const total = t.sources.reduce((a, x) => a + x.count, 0);
      const names = { direct: "Direct", search: "Search", social: "Social", referral: "Referral" };
      list.innerHTML = ["direct", "search", "social", "referral"]
        .map(key => {
          const count = t.sources.find(x => x.key === key)?.count || 0;
          const share = total ? Math.round((count / total) * 100) : 0;
          return `<div class="source-row"><span>${names[key]}</span><span class="source-track"><i style="width:${share}%"></i></span><strong>${share}%</strong></div>`;
        })
        .join("");
    }
  }

  const DRAW = { Overview: overview, "Platform activity": activity };
  function decorate() {
    const draw = DRAW[page];
    if (!draw) return;
    try {
      draw();
    } catch (error) {
      console.error(`Paira Express: the ${page} period could not be drawn`, error);
    }
  }
  /** Redraws the page on screen (its own bridges first, then the period figures). */
  function redraw() {
    if (!periods[page]) return;
    const active = document.activeElement;
    // Not while a custom date is being picked.
    if (active?.closest?.(".df-period") && active.type === "date") return void decorate();
    window.showPage(page);
  }

  const baseShowPage = window.showPage;
  window.showPage = showPage = function (next) {
    if (periods[next]) periods[next].activate();
    baseShowPage(next);
    page = next;
    decorate();
  };

  // New bookings and deliveries: the figures follow (the other bridges poll their own data).
  DF.live(
    ["parcel.created", "parcel.updated"],
    () => {
      if (!periods[page]) return;
      cache.clear();
      decorate();
    },
    { debounceMs: 5000, fallbackMs: 120_000 },
  );

  // The page on screen when this loads (the start-up page is shown after the data arrives).
  (DF.bridgeReady || Promise.resolve()).then(() => {
    const current = document.querySelector("#navigation .nav-item.active")?.dataset.page;
    if (current && periods[current]) window.showPage(current);
  });
})();
