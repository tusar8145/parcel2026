/*
 * Super admin › E-commerce merchants, Banking & Financial merchants, Franchises: the list in tabs by account
 * status — Active (opens first) · Suspended (and any other status the list shows) · All, each with its count. Only shows /
 * hides the rows the pages draw (01.js, bridge.js, bridge-merchants.js, bridge-franchise.js); the search box
 * and the status filter (with its import options) keep working inside the chosen tab. The pages redraw often;
 * each page keeps its chosen tab.
 */
(() => {
  const main = document.getElementById("mainContent");
  if (!main) return;
  /** The lists' table bodies (merchant pages: 02.js segment directory; Franchises: bridge-franchise.js). */
  const LISTS = ["#segmentMerchantBody", "#merchantBody", "#frTable tbody"];
  const FIXED = ["Active", "Suspended"];
  const chosen = {};
  try {
    Object.assign(chosen, JSON.parse(sessionStorage.getItem("df-status-tabs") || "{}"));
  } catch {}

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="statusTabStyles">
tr[data-st-off]{display:none!important}
.st-tabs{display:inline-flex;gap:4px;flex-wrap:wrap;margin:0 16px 12px;padding:4px;border-radius:11px;background:#eef1f5;max-width:calc(100% - 32px)}
.st-tabs .button{border:0;background:transparent;color:#556274;padding:7px 13px;border-radius:8px;font-size:13px;font-weight:600;box-shadow:none}
.st-tabs .button:hover{background:#e3e7ee;color:#1d2939}
.st-tabs .button.button-primary{background:#fff;color:#2f55c9;box-shadow:0 1px 2px rgba(16,24,40,.08),0 1px 3px rgba(16,24,40,.06)}
.st-tabs .st-n{display:inline-block;min-width:20px;margin-left:6px;padding:0 6px;border-radius:999px;background:#dfe4ec;color:#344054;font-size:11px;line-height:18px;text-align:center}
.st-tabs .button-primary .st-n{background:#e0e8ff;color:#2f55c9}
#segmentMerchantStatus{display:none}
</style>`,
  );

  const pageName = () => main.querySelector(".page-heading h1")?.textContent.trim() || "";
  /** A row's account status: the status pill in its STATUS cell (the cell's text otherwise). */
  const statusOf = (row, col) => {
    const cell = row.cells[col];
    return (cell?.querySelector(".status")?.textContent || cell?.textContent || "").trim();
  };

  function apply() {
    for (const selector of LISTS) {
      const body = main.querySelector(selector);
      if (!body) continue;
      // The STATUS column by its heading (bridge.js adds a HUB column to the merchant tables).
      const heads = [...(body.closest("table")?.tHead?.rows[0]?.cells || [])];
      const list = { col: heads.findIndex(th => th.textContent.trim().toUpperCase() === "STATUS") };
      if (list.col < 0) continue;
      const page = pageName();
      const rows = [...body.rows].filter(r => r.cells.length > 1 && !r.hasAttribute("data-st-empty"));
      const statuses = [...FIXED, ...new Set(rows.map(r => statusOf(r, list.col)).filter(s => s && !FIXED.includes(s)))];
      // Active first (opens first), All last.
      const tabs = [...statuses.map(s => [s, rows.filter(r => statusOf(r, list.col) === s).length]), ["All", rows.length]];
      let tab = chosen[page] || "Active";
      if (!tabs.some(([k]) => k === tab)) tab = "Active";
      const panel = body.closest(".panel");
      let bar = panel?.querySelector(".st-tabs");
      if (!bar && panel) {
        panel.querySelector(".panel-heading")?.insertAdjacentHTML("afterend", `<div class="st-tabs" role="tablist" aria-label="Account status"></div>`);
        bar = panel.querySelector(".st-tabs");
      }
      const key = `${tab}|${tabs.map(([k, n]) => `${k}:${n}`).join(",")}`;
      if (bar && bar.dataset.drawn !== key) {
        bar.dataset.drawn = key;
        bar.innerHTML = tabs
          .map(([k, n]) => `<button type="button" role="tab" class="button button-sm${k === tab ? " button-primary" : ""}" data-st-tab="${k.replace(/"/g, "&quot;")}" aria-selected="${k === tab}">${k.replace(/&/g, "&amp;").replace(/</g, "&lt;")}<span class="st-n">${n}</span></button>`)
          .join("");
      }
      for (const row of rows) {
        const off = tab !== "All" && statusOf(row, list.col) !== tab;
        if (off !== row.hasAttribute("data-st-off")) row.toggleAttribute("data-st-off", off);
      }
      // Nothing in this tab: say so (a row of its own, not counted).
      const empty = body.querySelector("tr[data-st-empty]");
      const none = rows.length > 0 && !rows.some(r => !r.hasAttribute("data-st-off"));
      if (none && !empty) body.insertAdjacentHTML("beforeend", `<tr data-st-empty><td colspan="${body.closest("table")?.rows[0]?.cells.length || 7}" class="empty-state">No ${tab.toLowerCase()} accounts.</td></tr>`);
      else if (!none && empty) empty.remove();
    }
  }

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      apply();
    });
  }).observe(main, { childList: true, subtree: true });

  main.addEventListener("click", event => {
    const button = event.target instanceof Element ? event.target.closest("[data-st-tab]") : null;
    if (!button) return;
    chosen[pageName()] = button.dataset.stTab;
    try {
      sessionStorage.setItem("df-status-tabs", JSON.stringify(chosen));
    } catch {}
    apply();
  });
})();
