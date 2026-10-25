/*
 * Super admin › Platform activity, in tabs:
 *   Live now          visitors on the website right now and their pages, page views per minute (30 min),
 *                     the latest parcels tracked (GET /analytics/live, every 10 s while open)
 *   Website traffic   the period's visits, lookups, merchants, riders and the traffic chart (bridge-period.js,
 *                     bridge-security.js, bridge.js draw these; the period picker belongs to this tab)
 *   Parcel tracking   parcels tracked on the website: today, yesterday, this / last week, this / last month,
 *                     last 30 days, this year, all time (GET /analytics/tracking/summary) and the parcels
 *                     tracked in chosen dates, a page at a time (GET /analytics/tracking/parcels); the
 *                     latest scans (Tracking history) below
 *   Merchants & riders, User activity   the page's other sections
 * The existing sections are only shown / hidden; the page redraws them often, the chosen tab stays.
 */
(() => {
  const DF = window.DF;
  const main = document.getElementById("mainContent");
  if (!DF || !main) return;
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const num = n => Number(n || 0).toLocaleString("en-US");
  const today = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
  const dhakaDate = iso => new Date(new Date(iso).getTime() + 6 * 3600_000).toISOString().slice(0, 10);
  const time = iso => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Dhaka" }) : "—");
  const clock = iso => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Dhaka" });
  const ago = iso => {
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : time(iso);
  };

  const TABS = [
    ["live", "Live now"],
    ["traffic", "Website traffic"],
    ["tracking", "Parcel tracking"],
    ["people", "Merchants & riders"],
    ["activity", "User activity"],
  ];
  const PERIODS = [
    ["today", "Today"],
    ["yesterday", "Yesterday"],
    ["thisWeek", "This week"],
    ["lastWeek", "Last week"],
    ["thisMonth", "This month"],
    ["lastMonth", "Last month"],
    ["last30Days", "Last 30 days"],
    ["thisYear", "This year"],
    ["allTime", "All time"],
  ];
  const S = {
    tab: "live",
    live: null,
    liveError: "",
    summary: null,
    list: { period: "today", from: today(), to: today(), q: "", page: 1, limit: 25, data: null, error: "", loading: false },
  };
  try {
    S.tab = sessionStorage.getItem("df-activity-tab") || "live";
  } catch {}

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="paStyles">
[data-pa-off]{display:none!important}
#mainContent[data-pa-tab]:not([data-pa-tab="traffic"]) .page-heading .df-period{display:none!important}
.activity-two-col:has(> [data-pa-off]){grid-template-columns:1fr!important}
.pa-tabs{display:inline-flex;gap:4px;flex-wrap:wrap;margin:0 0 16px;padding:4px;border-radius:11px;background:#eef1f5;max-width:100%}
.pa-tabs .button{border:0;background:transparent;color:#556274;padding:7px 13px;border-radius:8px;font-size:13px;font-weight:600;box-shadow:none;display:inline-flex;align-items:center;gap:6px}
.pa-tabs .button:hover{background:#e3e7ee;color:#1d2939}
.pa-tabs .button.button-primary{background:#fff;color:#2f55c9;box-shadow:0 1px 2px rgba(16,24,40,.08),0 1px 3px rgba(16,24,40,.06)}
.pa-dot{width:8px;height:8px;border-radius:50%;background:#12b76a;box-shadow:0 0 0 0 #12b76a88;animation:paPulse 1.6s infinite}
@keyframes paPulse{0%{box-shadow:0 0 0 0 #12b76a88}70%{box-shadow:0 0 0 7px #12b76a00}100%{box-shadow:0 0 0 0 #12b76a00}}
.pa{display:grid;gap:16px;margin-bottom:16px}
.pa-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.pa-card{border:1px solid #e6e9ef;border-radius:14px;padding:14px 16px;background:#fff;display:grid;gap:4px;text-align:left;font:inherit;color:inherit}
.pa-card small{color:#667085;font-size:12px;font-weight:650}
.pa-card strong{font-size:24px;line-height:1.15}
.pa-card span{color:#667085;font-size:12px}
.pa-card.hero{background:linear-gradient(135deg,#ecfdf3,#fff);border-color:#abefc6}
.pa-card.hero strong{font-size:34px;color:#067647;display:flex;align-items:center;gap:10px}
button.pa-card{cursor:pointer}
button.pa-card:hover{border-color:#b2c5f5}
button.pa-card.on{border-color:#2f55c9;box-shadow:0 0 0 2px #2f55c933;background:#f5f8ff}
.pa-grid{display:grid;grid-template-columns:1.4fr 1fr;gap:16px}
@media(max-width:980px){.pa-grid{grid-template-columns:1fr}}
.pa .panel{margin:0;border-radius:14px}
.pa-bars{display:flex;align-items:flex-end;gap:3px;height:130px;padding:10px 16px 4px}
.pa-bars i{flex:1;background:#c7d7fe;border-radius:3px 3px 0 0;min-height:2px}
.pa-bars i.now{background:#2f55c9}
.pa-axis{display:flex;justify-content:space-between;padding:0 16px 12px;color:#98a2b3;font-size:11px}
.pa-list{display:grid;gap:8px;padding:6px 16px 16px}
.pa-row{display:grid;grid-template-columns:minmax(0,1fr) 120px 40px;gap:10px;align-items:center;font-size:13px}
.pa-row .track{height:8px;border-radius:99px;background:#eef1f5;overflow:hidden}
.pa-row .track i{display:block;height:100%;background:#2f55c9;border-radius:99px}
.pa-empty{padding:16px;color:#667085;font-size:13px}
.pa-filters{display:flex;gap:10px;flex-wrap:wrap;align-items:end}
.pa-filters label{display:grid;gap:4px;font-size:12px;font-weight:600;color:#475467}
.pa-filters input,.pa-filters select{height:36px;border:1px solid #e6e9ef;border-radius:9px;padding:0 10px;font:inherit;font-size:13px;background:#fff}
.pa-pager{display:flex;gap:8px;align-items:center;justify-content:flex-end;padding:12px 16px;border-top:1px solid #eef0f4;font-size:13px;color:#475467}
.pa-pill{display:inline-flex;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:700;background:#f2f4f7;color:#344054;white-space:nowrap}
.pa-pill.good{background:#ecfdf3;color:#067647}.pa-pill.blue{background:#eff4ff;color:#2f55c9}.pa-pill.bad{background:#fef3f2;color:#b42318}
.pa table td.num,.pa table th.num{text-align:right;font-variant-numeric:tabular-nums}
.pa .sub{display:block;color:#667085;font-size:12px}
</style>`,
  );

  const onPage = () => main.querySelector(".page-heading h1")?.textContent.trim() === "Platform activity";
  const title = el => el.querySelector(".panel-title")?.textContent.trim() || "";

  /** Which tab one of the page's own blocks belongs to; null = always shown. */
  function tabOf(el) {
    if (el.id === "paLive") return "live";
    if (el.id === "paTracking") return "tracking";
    if (el.matches(".metrics")) return "traffic";
    if (el.querySelector(".traffic-bars")) return "traffic";
    if (el.querySelector("#platformActivityEvents")) return "activity";
    if (["Merchant last activity", "Rider activity"].includes(title(el))) return "people";
    if (title(el) === "Tracking history") return "tracking";
    return null;
  }
  const statusPill = s => `<span class="pa-pill ${/Delivered/.test(s) ? "good" : /Return|Cancel|Fail|Exception|Deleted/.test(s) ? "bad" : "blue"}">${esc(s)}</span>`;

  // ───────────── Live now ─────────────
  function liveHtml() {
    const l = S.live;
    if (!l) return `<div class="panel pa-empty">${esc(S.liveError || "Loading live traffic…")}</div>`;
    const last30 = l.perMinute.reduce((a, m) => a + m.pageviews, 0);
    const max = Math.max(1, ...l.perMinute.map(m => m.pageviews));
    const bars = l.perMinute.map((m, i) => `<i class="${i === l.perMinute.length - 1 ? "now" : ""}" style="height:${Math.max(2, Math.round((m.pageviews / max) * 100))}%" title="${esc(clock(m.minute))} · ${num(m.pageviews)} page views"></i>`).join("");
    const pagesMax = Math.max(1, ...l.pages.map(p => p.visitors));
    const pages = l.pages.length
      ? l.pages.map(p => `<div class="pa-row"><span title="${esc(p.path)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.path)}</span><span class="track"><i style="width:${Math.round((p.visitors / pagesMax) * 100)}%"></i></span><strong style="text-align:right">${num(p.visitors)}</strong></div>`).join("")
      : `<div class="pa-empty" style="padding:4px 0">Nobody is on the website right now.</div>`;
    const lookups = l.recentLookups.length
      ? `<table><thead><tr><th>Parcel</th><th>Status</th><th>How</th><th>When</th></tr></thead><tbody>${l.recentLookups
          .map(r => `<tr><td><strong>${esc(r.trackingId || "—")}</strong></td><td>${statusPill(r.status)}</td><td>${r.via === "link" ? "SMS link" : "Searched"}</td><td title="${esc(time(r.at))}">${esc(ago(r.at))}</td></tr>`)
          .join("")}</tbody></table>`
      : `<div class="pa-empty">No parcel has been tracked on the website yet.</div>`;
    return `<div class="pa">
      <div class="pa-cards">
        <div class="pa-card hero"><small>Visitors on the website now</small><strong><i class="pa-dot"></i>${num(l.online)}</strong><span>updated ${esc(clock(l.at))} · every 10 s</span></div>
        <div class="pa-card"><small>Page views · last 30 min</small><strong>${num(last30)}</strong><span>${num(l.perMinute.at(-1)?.pageviews)} this minute</span></div>
        <div class="pa-card"><small>Parcels tracked · last hour</small><strong>${num(l.lookupsLastHour)}</strong><span>on the website</span></div>
        <div class="pa-card"><small>Today so far</small><strong>${num(l.today.visits)}</strong><span>visits · ${num(l.today.pageviews)} page views · ${num(l.today.trackingLookups)} lookups</span></div>
      </div>
      <div class="pa-grid">
        <section class="panel"><div class="panel-heading"><div><h2 class="panel-title">Page views per minute</h2><p class="panel-subtitle">The last 30 minutes · the newest minute in dark blue</p></div></div><div class="pa-bars" role="img" aria-label="Page views per minute, last 30 minutes: ${num(last30)}">${bars}</div><div class="pa-axis"><span>${esc(clock(l.perMinute[0].minute))}</span><span>${esc(clock(l.perMinute[15].minute))}</span><span>now</span></div></section>
        <section class="panel"><div class="panel-heading"><div><h2 class="panel-title">Pages open right now</h2><p class="panel-subtitle">${num(l.online)} visitor${l.online === 1 ? "" : "s"} · by page</p></div></div><div class="pa-list">${pages}</div></section>
      </div>
      <section class="panel table-panel"><div class="panel-heading"><div><h2 class="panel-title">Latest parcels tracked</h2><p class="panel-subtitle">Tracking lookups on the website, newest first · all of them in Parcel tracking</p></div><button class="button button-sm" data-pa-tab="tracking">Open Parcel tracking</button></div><div class="table-scroll">${lookups}</div></section>
      <p class="panel-subtitle" style="margin:0">Visitors who accepted analytics cookies are counted (an open tab says it is there every 30 seconds; nothing about the visitor is stored). Bots are left out.</p>
    </div>`;
  }

  // ───────────── Parcel tracking ─────────────
  function trackingHtml() {
    const s = S.summary;
    const L = S.list;
    const cards = PERIODS.map(([key, label]) => {
      const p = s?.periods[key];
      return `<button type="button" class="pa-card${L.period === key ? " on" : ""}" data-pa-period="${key}"><small>${label}</small><strong>${p ? num(p.parcels) : "…"}</strong><span>${p ? `parcels · ${num(p.lookups)} lookup${p.lookups === 1 ? "" : "s"}` : "loading"}</span></button>`;
    }).join("");
    const d = L.data;
    const rows = (d?.items || [])
      .map(
        r => `<tr><td><a href="/track/${encodeURIComponent(r.trackingId)}" target="_blank" rel="noopener"><strong>${esc(r.trackingId)}</strong></a><span class="sub">booked ${esc(time(r.bookedAt))}</span></td><td>${esc(r.sender || "—")}</td><td>${esc(r.recipient || "—")}<span class="sub">${esc(r.destination)}</span></td><td>${statusPill(r.status)}</td><td class="num"><strong>${num(r.lookups)}</strong>${r.fromLink ? `<span class="sub">${num(r.fromLink)} by SMS link</span>` : ""}</td><td>${esc(time(r.firstAt))}</td><td>${esc(time(r.lastAt))}<span class="sub">${esc(ago(r.lastAt))}</span></td></tr>`,
      )
      .join("");
    const empty = L.error ? esc(L.error) : L.loading || !d ? "Loading…" : L.q ? "No tracked parcel matches." : "No parcel was tracked on the website in these dates.";
    const pager = d
      ? `<div class="pa-pager"><span style="margin-right:auto">${num(d.total)} parcel${d.total === 1 ? "" : "s"} · ${num(d.lookups)} lookup${d.lookups === 1 ? "" : "s"}</span><label style="display:flex;gap:6px;align-items:center">Rows<select id="paLimit" style="height:30px;border:1px solid #e6e9ef;border-radius:8px">${[25, 50, 100].map(n => `<option${n === L.limit ? " selected" : ""}>${n}</option>`).join("")}</select></label><button class="button button-sm" data-pa-page="${d.page - 1}" ${d.page <= 1 ? "disabled" : ""}>‹ Previous</button><span>Page ${num(d.page)} of ${num(d.pages)}</span><button class="button button-sm" data-pa-page="${d.page + 1}" ${d.page >= d.pages ? "disabled" : ""}>Next ›</button></div>`
      : "";
    return `<div class="pa">
      <div class="pa-cards">${cards}</div>
      <section class="panel table-panel">
        <div class="panel-heading" style="align-items:flex-end;gap:12px;flex-wrap:wrap"><div><h2 class="panel-title">Parcels tracked on the website</h2><p class="panel-subtitle">Each parcel once, with how often it was tracked · latest first · choose a card above or your own dates</p></div>
          <form class="pa-filters" id="paFilters"><label>From<input type="date" id="paFrom" value="${esc(L.from)}"></label><label>To<input type="date" id="paTo" value="${esc(L.to)}"></label><label>Search<input type="search" id="paQ" placeholder="Tracking ID, sender, recipient" value="${esc(L.q)}"></label><button class="button button-sm button-primary" type="submit">Show</button></form></div>
        <div class="table-scroll"><table><thead><tr><th>Parcel</th><th>Sender</th><th>Recipient</th><th>Status now</th><th class="num">Times tracked</th><th>First tracked</th><th>Last tracked</th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="empty-state">${empty}</td></tr>`}</tbody></table></div>
        ${pager}
      </section>
    </div>`;
  }

  // ───────────── frame ─────────────
  function ensure() {
    if (!onPage()) return;
    main.dataset.paTab = S.tab;
    const heading = main.querySelector(".page-heading");
    let bar = main.querySelector(".pa-tabs");
    if (!bar && heading) {
      heading.insertAdjacentHTML("afterend", `<div class="pa-tabs" role="tablist" aria-label="Platform activity"></div><div id="paLive"></div><div id="paTracking"></div>`);
      bar = main.querySelector(".pa-tabs");
      paintLive();
      paintTracking();
      startLive();
      if (!S.summary) void loadSummary();
      if (!S.list.data && !S.list.loading) void loadList();
    }
    if (bar && bar.dataset.drawn !== S.tab) {
      bar.dataset.drawn = S.tab;
      bar.innerHTML = TABS.map(([k, label]) => `<button type="button" role="tab" class="button button-sm${k === S.tab ? " button-primary" : ""}" data-pa-tab="${k}" aria-selected="${k === S.tab}">${k === "live" ? `<i class="pa-dot"></i>` : ""}${label.replace("&", "&amp;")}</button>`).join("");
    }
    const blocks = [...main.children].flatMap(el => (el.matches(".activity-two-col") ? [...el.children] : [el]));
    for (const el of blocks) {
      const t = tabOf(el);
      const off = t !== null && t !== S.tab;
      if (off !== el.hasAttribute("data-pa-off")) el.toggleAttribute("data-pa-off", off);
    }
  }
  const paintLive = () => {
    const box = document.getElementById("paLive");
    if (box) box.innerHTML = liveHtml();
  };
  const paintTracking = () => {
    const box = document.getElementById("paTracking");
    if (box) box.innerHTML = trackingHtml();
  };

  async function loadLive() {
    try {
      S.live = await DF.api("/analytics/live");
      S.liveError = "";
    } catch (error) {
      S.liveError = DF.describe(error);
    }
    paintLive();
  }
  let timer = null;
  function startLive() {
    void loadLive();
    if (timer) return;
    timer = setInterval(() => {
      if (!onPage()) return void (clearInterval(timer), (timer = null));
      if (S.tab === "live" && document.visibilityState === "visible") void loadLive();
    }, 10_000);
  }
  async function loadSummary() {
    try {
      S.summary = await DF.api("/analytics/tracking/summary");
    } catch {}
    paintTracking();
  }
  async function loadList() {
    const L = S.list;
    L.loading = true;
    L.error = "";
    try {
      const qs = new URLSearchParams({ from: L.from, to: L.to, page: String(L.page), limit: String(L.limit), ...(L.q ? { q: L.q } : {}) });
      L.data = await DF.api(`/analytics/tracking/parcels?${qs}`);
    } catch (error) {
      L.error = DF.describe(error);
      L.data = null;
    }
    L.loading = false;
    paintTracking();
  }
  /** A summary card → its dates for the list. */
  function usePeriod(key) {
    const p = S.summary?.periods[key];
    const L = S.list;
    L.period = key;
    L.from = p?.from ? dhakaDate(p.from) : "2020-01-01";
    L.to = p?.to ? dhakaDate(new Date(new Date(p.to).getTime() - 1).toISOString()) : today();
    L.page = 1;
    void loadList();
  }

  // The page and its sections are redrawn often (period changes, live counts): tab them again each time.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      ensure();
    });
  }).observe(main, { childList: true, subtree: true });

  main.addEventListener("click", event => {
    const t = event.target instanceof Element ? event.target : null;
    if (!t || !onPage()) return;
    let el;
    if ((el = t.closest("[data-pa-tab]"))) {
      S.tab = el.dataset.paTab;
      try {
        sessionStorage.setItem("df-activity-tab", S.tab);
      } catch {}
      if (S.tab === "live") void loadLive();
      if (S.tab === "tracking") void loadSummary();
      return ensure();
    }
    if ((el = t.closest("[data-pa-period]"))) return usePeriod(el.dataset.paPeriod);
    if ((el = t.closest("[data-pa-page]")) && !el.disabled) {
      S.list.page = Number(el.dataset.paPage);
      return void loadList();
    }
  });
  main.addEventListener("submit", event => {
    if (event.target?.id !== "paFilters") return;
    event.preventDefault();
    const L = S.list;
    L.from = document.getElementById("paFrom").value || today();
    L.to = document.getElementById("paTo").value || L.from;
    if (L.to < L.from) L.to = L.from;
    L.q = document.getElementById("paQ").value.trim();
    L.period = PERIODS.find(([key]) => {
      const p = S.summary?.periods[key];
      return p?.from && dhakaDate(p.from) === L.from && (p.to ? dhakaDate(new Date(new Date(p.to).getTime() - 1).toISOString()) : today()) === L.to;
    })?.[0] || "";
    L.page = 1;
    void loadList();
  });
  main.addEventListener("change", event => {
    if (event.target?.id !== "paLimit") return;
    S.list.limit = Number(event.target.value) || 25;
    S.list.page = 1;
    void loadList();
  });
})();
