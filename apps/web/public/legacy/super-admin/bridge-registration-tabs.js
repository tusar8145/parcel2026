/*
 * Super admin › Registrations: the review queue in tabs — To review (pending and more information requested) ·
 * Rejected · Approved · All, each with its count. Only shows / hides the queue's rows (01.js and bridge.js draw
 * them; the search box keeps working inside the chosen tab); the page redraws often, the chosen tab stays.
 */
(() => {
  const main = document.getElementById("mainContent");
  if (!main) return;
  const TABS = [
    ["review", "To review", s => s === "Pending review" || s === "More information requested"],
    ["rejected", "Rejected", s => s === "Rejected"],
    ["approved", "Approved", s => s === "Approved"],
    ["all", "All", () => true],
  ];
  let tab = "review";
  try {
    tab = sessionStorage.getItem("df-registration-tab") || "review";
  } catch {}

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="regTabStyles">
#registrationBody tr[data-reg-off]{display:none!important}
.reg-tabs{display:inline-flex;gap:4px;flex-wrap:wrap;margin:0 16px 12px;padding:4px;border-radius:11px;background:#eef1f5;max-width:calc(100% - 32px)}
.reg-tabs .button{border:0;background:transparent;color:#556274;padding:7px 13px;border-radius:8px;font-size:13px;font-weight:600;box-shadow:none}
.reg-tabs .button:hover{background:#e3e7ee;color:#1d2939}
.reg-tabs .button.button-primary{background:#fff;color:#2f55c9;box-shadow:0 1px 2px rgba(16,24,40,.08),0 1px 3px rgba(16,24,40,.06)}
.reg-tabs .reg-n{display:inline-block;min-width:20px;margin-left:6px;padding:0 6px;border-radius:999px;background:#dfe4ec;color:#344054;font-size:11px;line-height:18px;text-align:center}
.reg-tabs .button-primary .reg-n{background:#e0e8ff;color:#2f55c9}
#registrationFilter{display:none}
</style>`,
  );

  /** A row's status: the STATUS column (6th). */
  const statusOf = row => row.cells[5]?.textContent.trim() || "";

  function apply() {
    const body = document.getElementById("registrationBody");
    if (!body) return;
    const rows = [...body.rows].filter(r => r.cells.length > 1 && !r.hasAttribute("data-reg-empty"));
    const panel = body.closest(".panel");
    let bar = panel?.querySelector(".reg-tabs");
    if (!bar && panel) {
      panel.querySelector(".panel-heading")?.insertAdjacentHTML("afterend", `<div class="reg-tabs" role="tablist" aria-label="Applications"></div>`);
      bar = panel.querySelector(".reg-tabs");
    }
    const counts = TABS.map(([, , match]) => rows.filter(r => match(statusOf(r))).length);
    const key = `${tab}|${counts.join(",")}`;
    if (bar && bar.dataset.drawn !== key) {
      bar.dataset.drawn = key;
      bar.innerHTML = TABS.map(([k, label], i) => `<button type="button" role="tab" class="button button-sm${k === tab ? " button-primary" : ""}" data-reg-tab="${k}" aria-selected="${k === tab}">${label}<span class="reg-n">${counts[i]}</span></button>`).join("");
    }
    const match = TABS.find(([k]) => k === tab)?.[2] || (() => true);
    for (const row of rows) {
      const off = !match(statusOf(row));
      if (off !== row.hasAttribute("data-reg-off")) row.toggleAttribute("data-reg-off", off);
    }
    const label = TABS.find(([k]) => k === tab)?.[1];
    // Nothing in this tab: say so (a row of its own, not counted).
    const empty = body.querySelector("tr[data-reg-empty]");
    const none = !rows.some(r => !r.hasAttribute("data-reg-off"));
    if (none && !empty) body.insertAdjacentHTML("beforeend", `<tr data-reg-empty><td colspan="7" class="empty-state">No ${tab === "all" ? "" : `${label.toLowerCase()} `}applications.</td></tr>`);
    else if (!none && empty) empty.remove();
    const sub = panel?.querySelector(".panel-subtitle");
    if (sub && label) {
      const text = tab === "all" ? "Every merchant application" : tab === "review" ? "Applications waiting for a decision" : `${label} applications`;
      if (sub.textContent !== text) sub.textContent = text;
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
    const button = event.target instanceof Element ? event.target.closest("[data-reg-tab]") : null;
    if (!button) return;
    tab = button.dataset.regTab;
    try {
      sessionStorage.setItem("df-registration-tab", tab);
    } catch {}
    apply();
  });
})();
