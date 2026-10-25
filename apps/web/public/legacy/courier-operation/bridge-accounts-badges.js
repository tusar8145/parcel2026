/*
 * Courier Operations › Accounts: a badge on each tab with what waits there — how many and the money involved
 * (GET /accounts/tab-counts) — so staff know where to click without opening every tab. Hovering a badge says
 * what it counts. Only decorates the tab bar bridge-nav.js draws; the tabs and pages work as before.
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops) return;
  const esc = Ops.esc;
  /** bridge-nav.js tab id → the key in /accounts/tab-counts. */
  const TABS = ["E-commerce", "Financial", "Customer", "Rider cash", "Hub transfers", "Rider pay", "Franchise"];
  /** ৳ amounts short enough for a tab: ৳850 · ৳12.4k · ৳3.2L (lakh) · ৳1.1Cr. */
  const short = n => {
    const v = Math.abs(Number(n) || 0);
    const f = (x, s) => `৳${(Math.round(x * 10) / 10).toLocaleString("en-US")}${s}`;
    return v >= 1e7 ? f(v / 1e7, "Cr") : v >= 1e5 ? f(v / 1e5, "L") : v >= 1e3 ? f(v / 1e3, "k") : `৳${Math.round(v).toLocaleString("en-US")}`;
  };

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="accTabBadgeStyles">
.df-tabs .acc-tb{display:inline-flex;align-items:center;gap:4px;margin-left:6px;vertical-align:1px}
.df-tabs .acc-tb-n{min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:#f04438;color:#fff;font-size:11px;font-weight:700;line-height:18px;text-align:center}
.df-tabs .acc-tb-a{font-size:11.5px;font-weight:650;color:#667085}
.df-tabs .button.button-primary .acc-tb-a{color:#2f55c9}
</style>`,
  );

  let counts = null;
  let loadedAt = 0;
  let loading = null;

  const bar = () => document.querySelector('#mainContent .df-tabs[aria-label="Accounts"]');

  function paint() {
    const el = bar();
    if (!el || !counts) return;
    for (const tab of TABS) {
      const button = el.querySelector(`[data-nav-tab="${CSS.escape(tab)}"]`);
      if (!button) continue;
      button.querySelector(".acc-tb")?.remove();
      const c = counts[tab];
      if (!c) continue;
      button.title = c.hint || "";
      if (!c.count && !c.amount) continue;
      button.insertAdjacentHTML("beforeend", `<span class="acc-tb" data-acc-badge="${esc(tab)}">${c.count ? `<span class="acc-tb-n">${c.count > 99 ? "99+" : c.count}</span>` : ""}${c.amount ? `<span class="acc-tb-a">${esc(short(c.amount))}</span>` : ""}</span>`);
    }
  }

  async function load(force = false) {
    if (!force && counts && Date.now() - loadedAt < 15_000) return paint();
    if (loading) return loading;
    loading = DF.api("/accounts/tab-counts")
      .then(c => {
        counts = c;
        loadedAt = Date.now();
        paint();
      })
      .catch(() => {})
      .finally(() => (loading = null));
    return loading;
  }

  // The tab bar is redrawn on every render: badge it again each time it appears.
  new MutationObserver(() => {
    const el = bar();
    if (!el || el.dataset.accBadged) return;
    el.dataset.accBadged = "1";
    paint();
    void load();
  }).observe(document.getElementById("mainContent") || document.body, { childList: true, subtree: true });

  // Money moved: fresh counts (when Accounts is on screen; otherwise on the next visit).
  DF.live?.(
    ["account.updated", "cash.slip", "cash.transfer", "parcel.updated"],
    () => {
      loadedAt = 0;
      if (bar()) void load(true);
    },
    { debounceMs: 3000, fallbackMs: 120_000 },
  );
})();
