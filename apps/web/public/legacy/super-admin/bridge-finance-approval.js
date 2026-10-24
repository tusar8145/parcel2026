/*
 * Super admin › Platform settings: "Finance approvals" (GET / PUT /finance/config settlementApproval).
 *
 * How merchant settlements (COD payouts) are approved in Courier Operations › COD & settlement:
 *   Single approval (default)  any finance user approves, the one who drafted it too.
 *   Double approval            someone other than the person who drafted it (maker-checker).
 * Only super admins can change it (the API refuses finance users).
 */
(() => {
  const DF = window.DF;
  if (!DF) return;
  const $ = id => document.getElementById(id);
  const PAGE = "Platform settings";
  const state = { mode: null, error: "", saving: false };
  const MODES = [
    ["SINGLE", "Single approval", "Any finance user approves a settlement, the person who drafted it too. Faster for a small finance team."],
    ["DOUBLE", "Double approval", "Someone other than the person who drafted it must approve (maker-checker). Safer; needs two finance users."],
  ];

  function markup() {
    const body = !state.mode
      ? `<p class="panel-subtitle" style="margin-top:12px">${state.error || "Loading…"}</p>`
      : `<form id="dfFinanceApprovalForm" class="config-form" style="margin-top:12px"><div style="display:grid;gap:10px">${MODES.map(
          ([value, label, hint]) =>
            `<label class="config-check" style="align-items:flex-start;gap:10px;padding:12px;border:1px solid ${state.mode === value ? "#b8c8ff" : "var(--line,#e9edf2)"};border-radius:10px;background:${state.mode === value ? "#f4f7ff" : "#fff"}"><input type="radio" name="settlementApproval" value="${value}" ${state.mode === value ? "checked" : ""} style="margin-top:3px"><span><strong style="display:block">${label}${value === "SINGLE" ? " (default)" : ""}</strong><small style="color:#667085">${hint}</small></span></label>`,
        ).join("")}</div>
        <div class="modal-actions"><button class="button button-primary" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save finance approvals"}</button></div></form>`;
    return `<section class="panel" id="dfFinanceApproval" style="margin-top:14px"><div class="panel-heading"><div><h2 class="panel-title">Finance approvals</h2><p class="panel-subtitle">How merchant settlements (COD payouts) are approved in Courier Operations › COD & settlement</p></div></div>${body}</section>`;
  }

  function paint() {
    if ($("breadcrumbPage")?.textContent !== PAGE) return;
    const main = $("mainContent");
    if (!main) return;
    const existing = $("dfFinanceApproval");
    if (existing) existing.outerHTML = markup();
    else main.insertAdjacentHTML("beforeend", markup());
  }

  async function load() {
    try {
      state.mode = (await DF.api("/finance/config")).settlementApproval || "SINGLE";
      state.error = "";
    } catch (error) {
      state.error = DF.describe(error);
    }
    paint();
  }

  const baseShowPage = window.showPage;
  if (typeof baseShowPage === "function")
    window.showPage = showPage = function (next) { // eslint-disable-line no-global-assign, no-undef -- the page's own showPage (01.js)
      baseShowPage(next);
      try {
        if (next === PAGE) {
          paint();
          void load();
        }
      } catch (error) {
        console.error("Finance approvals panel failed", error);
      }
    };

  window.addEventListener(
    "submit",
    async event => {
      if (event.target?.id !== "dfFinanceApprovalForm") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const mode = event.target.elements.settlementApproval.value;
      state.saving = true;
      paint();
      try {
        state.mode = (await DF.api("/finance/config", { method: "PUT", body: { settlementApproval: mode } })).settlementApproval;
        showToast(mode === "DOUBLE" ? "Settlements now need double approval (someone other than the drafter)." : "Settlements now need single approval.");
      } catch (error) {
        showToast(DF.describe(error));
      } finally {
        state.saving = false;
        paint();
      }
    },
    true,
  );

  if ($("breadcrumbPage")?.textContent === PAGE) void load();
})();
