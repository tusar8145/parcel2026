/*
 * Super admin › Platform settings: "Accounts" (GET / PUT /accounts/config, POST /accounts/cutover).
 *
 * - Central hub: hubs send the cash they receive from riders to this hub; only cash that reached it is
 *   settled with merchants and customers (Courier Operations › Accounts).
 * - Move existing parcels into Accounts (once, safe to repeat): delivered / returned parcels get their
 *   account lines (not those already settled or invoiced the old way); cash already at hubs is placed.
 */
(() => {
  const DF = window.DF;
  if (!DF) return;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  // The Platform settings page (internal name "Global notifications"; older builds "Platform settings").
  const PAGES = ["Global notifications", "Platform settings"];
  const state = { hubs: null, central: undefined, error: "", saving: false, moving: false, moved: null };

  function markup() {
    const loaded = state.hubs && state.central !== undefined;
    const body = !loaded
      ? `<p class="panel-subtitle" style="margin-top:12px">${esc(state.error || "Loading…")}</p>`
      : `<form id="dfAccountsForm" class="config-form" style="margin-top:12px;display:grid;gap:12px">
          <label style="display:grid;gap:6px;max-width:420px"><strong>Central hub</strong><select name="centralHubId" style="height:38px;border:1px solid var(--line,#e9edf2);border-radius:9px;padding:0 10px">
            <option value="">— Not set —</option>${state.hubs.map(h => `<option value="${esc(h.id)}"${state.central === h.id ? " selected" : ""}>${esc(h.name)}${h.code ? ` (${esc(h.code)})` : ""}</option>`).join("")}
          </select><small style="color:#667085">Hubs send riders' cash here (Accounts › Hub transfers). Only cash that reached it is settled with merchants and customers.</small></label>
          <div class="modal-actions" style="justify-content:flex-start"><button class="button button-primary" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save central hub"}</button></div>
        </form>
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line,#e9edf2);display:grid;gap:8px">
          <strong>Move existing parcels into Accounts</strong>
          <small style="color:#667085">Once, after choosing the central hub (safe to repeat). Delivered and returned parcels get their account lines; parcels already settled or invoiced the old way are left as they were; cash already received at hubs becomes that hub's cash.</small>
          <div><button type="button" class="button" data-df-accounts-cutover ${state.moving ? "disabled" : ""}>${state.moving ? "Moving…" : "Move existing parcels"}</button></div>
          ${state.moved ? `<small style="color:#067647">Done: ${state.moved.parcels} parcel(s) added, ${state.moved.skippedSettledOrInvoiced} already settled / invoiced left out, ${state.moved.cashPlaced} cash record(s) placed at hubs.</small>` : ""}
        </div>`;
    return `<section class="panel" id="dfAccountsSettings" style="margin-top:14px"><div class="panel-heading"><div><h2 class="panel-title">Accounts</h2><p class="panel-subtitle">Merchants' and customers' money in Courier Operations › Accounts</p></div></div>${body}</section>`;
  }

  function paint() {
    if (!PAGES.includes($("breadcrumbPage")?.textContent)) return;
    const main = $("mainContent");
    if (!main) return;
    const existing = $("dfAccountsSettings");
    if (existing) existing.outerHTML = markup();
    else main.insertAdjacentHTML("beforeend", markup());
  }

  async function load() {
    try {
      const [hubs, cfg] = await Promise.all([DF.api("/hubs"), DF.api("/accounts/config")]);
      state.hubs = (Array.isArray(hubs) ? hubs : hubs.items || []).filter(h => h.type !== "FRANCHISE");
      state.central = cfg.centralHub?.id ?? null;
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
        if (PAGES.includes(next)) {
          paint();
          void load();
        }
      } catch (error) {
        console.error("Accounts settings panel failed", error);
      }
    };

  window.addEventListener(
    "submit",
    async event => {
      if (event.target?.id !== "dfAccountsForm") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const centralHubId = event.target.elements.centralHubId.value || null;
      state.saving = true;
      paint();
      try {
        const cfg = await DF.api("/accounts/config", { method: "PUT", body: { centralHubId } });
        state.central = cfg.centralHub?.id ?? null;
        showToast(cfg.centralHub ? `${cfg.centralHub.name} is the central hub.` : "No central hub set.");
      } catch (error) {
        showToast(DF.describe(error));
      } finally {
        state.saving = false;
        paint();
      }
    },
    true,
  );
  window.addEventListener(
    "click",
    async event => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-df-accounts-cutover]")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      state.moving = true;
      paint();
      try {
        state.moved = await DF.api("/accounts/cutover", { method: "POST" });
        showToast(`${state.moved.parcels} parcel(s) moved into Accounts.`);
      } catch (error) {
        showToast(DF.describe(error));
      } finally {
        state.moving = false;
        paint();
      }
    },
    true,
  );
})();
