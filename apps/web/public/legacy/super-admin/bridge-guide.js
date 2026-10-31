/*
 * Super admin › System guide: what the platform's numbers mean, the parcel lifecycle and its notifications, money steps, roles, and where
 * things are changed (shared/system-guide.js, GET /guide).
 */
(() => {
  const DF = window.DF;
  if (!DF?.systemGuide) return;
  const PAGE = "System guide";
  // The base renderer (01.js) draws unknown pages from its `generic` table: give it an empty entry.
  try {
    if (typeof generic === "object" && !generic[PAGE]) generic[PAGE] = { desc: "System guide", cols: [], rows: [] };
  } catch {}
  const baseShowPage = window.showPage;
  window.showPage = showPage = function (page) { // eslint-disable-line no-global-assign, no-undef -- the page's own showPage (01.js)
    baseShowPage(page);
    if (page !== PAGE) return;
    const main = document.getElementById("mainContent");
    main.innerHTML = `<div class="page-heading"><div><p class="eyebrow">Platform control · reference</p><h1>System guide</h1><p class="subtitle">What the numbers (PP, MR, HS…) mean, the parcel lifecycle and its SMS / email / push, money steps, roles, and where each setting is changed.</p></div></div><div id="sgHost"></div>`;
    void DF.systemGuide.mount(document.getElementById("sgHost"));
  };
})();
