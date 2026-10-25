/*
 * Courier Operations › Merchants: the register in tabs by merchant type — E-commerce (opens first) ·
 * Banking & Financial · All, each with its count. Only shows / hides the rows bridge-pages.js draws (the
 * MERCHANT cell ends with "· E-commerce" / "· Banking & Financial"); the search box and the hub filter keep
 * working inside the chosen tab, and the chosen tab stays through the page's redraws.
 */
(() => {
  const main = document.getElementById("mainContent");
  if (!main) return;
  const TABS = [
    ["E-commerce", t => /·\s*E-commerce$/.test(t)],
    ["Banking & Financial", t => /·\s*Banking & Financial$/.test(t)],
    ["All", () => true],
  ];
  let tab = "E-commerce";
  try {
    tab = sessionStorage.getItem("df-ops-merchant-tab") || tab;
  } catch {}

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="opsMerchantTabStyles">
tr[data-mt-off]{display:none!important}
.mt-tabs{display:inline-flex;gap:4px;flex-wrap:wrap;margin:0 16px 12px;padding:4px;border-radius:11px;background:#eef1f5;max-width:calc(100% - 32px)}
.mt-tabs .button{border:0;background:transparent;color:#556274;padding:7px 13px;border-radius:8px;font-size:13px;font-weight:600;box-shadow:none}
.mt-tabs .button:hover{background:#e3e7ee;color:#1d2939}
.mt-tabs .button.button-primary{background:#fff;color:#2f55c9;box-shadow:0 1px 2px rgba(16,24,40,.08),0 1px 3px rgba(16,24,40,.06)}
.mt-tabs .mt-n{display:inline-block;min-width:20px;margin-left:6px;padding:0 6px;border-radius:999px;background:#dfe4ec;color:#344054;font-size:11px;line-height:18px;text-align:center}
.mt-tabs .button-primary .mt-n{background:#e0e8ff;color:#2f55c9}
</style>`,
  );

  const onPage = () => main.querySelector(".page-heading h1")?.textContent.trim() === "Merchants" && /Merchants register/.test(main.querySelector(".table-panel .panel-title")?.textContent || "");
  const typeText = row => row.cells[0]?.textContent.trim() || "";

  function apply() {
    if (!onPage()) return;
    const panel = main.querySelector(".table-panel");
    const body = panel?.querySelector("tbody");
    if (!body) return;
    const rows = [...body.rows].filter(r => r.cells.length > 1 && !r.hasAttribute("data-mt-empty"));
    const counts = TABS.map(([, match]) => rows.filter(r => match(typeText(r))).length);
    let bar = panel.querySelector(".mt-tabs");
    if (!bar) {
      panel.querySelector(".panel-heading")?.insertAdjacentHTML("afterend", `<div class="mt-tabs" role="tablist" aria-label="Merchant type"></div>`);
      bar = panel.querySelector(".mt-tabs");
    }
    const key = `${tab}|${counts.join(",")}`;
    if (bar && bar.dataset.drawn !== key) {
      bar.dataset.drawn = key;
      bar.innerHTML = TABS.map(([k], i) => `<button type="button" role="tab" class="button button-sm${k === tab ? " button-primary" : ""}" data-mt-tab="${k.replace(/&/g, "&amp;")}" aria-selected="${k === tab}">${k.replace(/&/g, "&amp;")}<span class="mt-n">${counts[i]}</span></button>`).join("");
    }
    const match = (TABS.find(([k]) => k === tab) || TABS[0])[1];
    for (const row of rows) {
      const off = !match(typeText(row));
      if (off !== row.hasAttribute("data-mt-off")) row.toggleAttribute("data-mt-off", off);
    }
    // Nothing in this tab: say so (a row of its own, not counted).
    const empty = body.querySelector("tr[data-mt-empty]");
    const none = rows.length > 0 && !rows.some(r => !r.hasAttribute("data-mt-off"));
    if (none && !empty) body.insertAdjacentHTML("beforeend", `<tr data-mt-empty><td colspan="${body.closest("table")?.tHead?.rows[0]?.cells.length || 7}" class="empty-state">No ${tab} merchants.</td></tr>`);
    else if (!none && empty) empty.remove();
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
    const button = event.target instanceof Element ? event.target.closest("[data-mt-tab]") : null;
    if (!button) return;
    tab = button.dataset.mtTab;
    try {
      sessionStorage.setItem("df-ops-merchant-tab", tab);
    } catch {}
    apply();
  });
})();
