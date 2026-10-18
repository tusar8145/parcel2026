/*
 * Super admin › Rider plans: "Rider location interval" (GET / PUT /settings/location).
 *
 * How often the rider app sends a rider's position while on shift — and how often a phone sharing a
 * linehaul vehicle's position sends it — when nothing moves: every 2, 5 (default) or 10 minutes; a move
 * of at least the movement threshold sends one at once. Browsers only send while the app is open in the
 * foreground; true background tracking would need a native app.
 */
(() => {
  const DF = window.DF;
  if (!DF) return;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const PAGE = "Rider plans";
  const state = { settings: null, error: "", saving: false };
  let check = null;
  const metersRule = value => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 25 && n <= 1000 ? "" : "Enter 25 to 1000 metres.";
  };

  function markup() {
    const s = state.settings;
    const body = !s
      ? `<p class="panel-subtitle" style="margin-top:12px">${esc(state.error || "Loading…")}</p>`
      : `<form id="dfLocationSettingsForm" class="config-form" novalidate><div class="form-grid"><label>Rider location interval<select name="intervalMinutes" id="dfLocationInterval">${[2, 5, 10]
          .map(n => `<option value="${n}" ${s.intervalMinutes === n ? "selected" : ""}>Every ${n} minutes${n === s.defaults?.intervalMinutes ? " (default)" : ""}</option>`)
          .join("")}</select></label><label>Movement threshold (metres)<input name="movementMeters" id="dfLocationMeters" type="number" min="25" max="1000" step="5" value="${esc(s.movementMeters)}" required></label></div>
        <p class="panel-subtitle" style="margin:8px 0 0">Riders on shift send their position on this interval and at once after moving this far. Phones sharing a linehaul vehicle's location use the same settings. Positions older than ${esc(s.staleAfterMinutes)} minutes show as "last known". Browsers only send while the rider app is open on the screen; background tracking would need a native app.</p>
        <div class="modal-actions"><button class="button button-primary" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save location settings"}</button></div></form>`;
    return `<section class="panel" id="dfLocationSettings" style="margin-top:14px"><div class="panel-heading"><div><h2 class="panel-title">Rider location</h2><p class="panel-subtitle">How often riders' (and shared vehicles') positions update on the maps</p></div></div>${body}</section>`;
  }

  function paint() {
    if ($("breadcrumbPage")?.textContent !== PAGE) return;
    const main = $("mainContent");
    if (!main) return;
    const existing = $("dfLocationSettings");
    if (existing) existing.outerHTML = markup();
    else main.insertAdjacentHTML("beforeend", markup());
    const form = $("dfLocationSettingsForm");
    check = form && DF.validate ? DF.validate(form, { dfLocationMeters: metersRule }) : null;
  }

  async function load() {
    try {
      state.settings = await DF.api("/settings/location");
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
        console.error("Location settings panel failed", error);
      }
    };

  window.addEventListener(
    "submit",
    async event => {
      if (event.target?.id !== "dfLocationSettingsForm") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const form = event.target;
      const intervalMinutes = Number(form.elements.intervalMinutes.value);
      const movementMeters = Math.round(Number(form.elements.movementMeters.value));
      if (check ? !check() : metersRule(form.elements.movementMeters.value)) return void form.elements.movementMeters.focus();
      state.saving = true;
      paint();
      try {
        state.settings = await DF.api("/settings/location", { method: "PUT", body: { intervalMinutes, movementMeters } });
        showToast(`Rider location: every ${intervalMinutes} minutes or after ${movementMeters} m.`);
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
