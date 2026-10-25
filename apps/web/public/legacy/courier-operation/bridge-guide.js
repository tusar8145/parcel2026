/*
 * Courier Operations › Settings: a "System guide" card that opens the guide (numbers, parcel statuses, money
 * steps, roles; shared/system-guide.js, GET /guide) in a dialog, read-only.
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF?.systemGuide || !Ops) return;
  const baseSettings = Ops.enhance.Settings;
  Ops.enhance.Settings = (...args) => {
    baseSettings?.(...args);
    const grid = document.querySelector("#settingsCards > div:last-child");
    if (!grid || grid.querySelector('[data-settings-card="System guide"]')) return;
    grid.insertAdjacentHTML(
      "afterbegin",
      `<article class="mini-card" style="display:grid;gap:8px;align-content:start;padding:14px;border:1px solid #b2c5f5;border-radius:10px;background:#f5f8ff" data-settings-card="System guide"><strong style="font-size:14px">System guide</strong><span style="color:#647184;font-size:13px">What the numbers (PP, MR, HS, ST…), parcel statuses, money steps and roles mean.</span><div><button class="button button-sm button-primary" type="button" data-guide-open>Open the guide</button></div></article>`,
    );
  };
  function open() {
    document.getElementById("sgDialog")?.remove();
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="sgDialog" role="dialog" aria-modal="true" aria-labelledby="sgDialogTitle" style="position:fixed;inset:0;z-index:100;background:#14203380;display:grid;place-items:center;padding:18px"><section style="width:min(1180px,100%);max-height:92vh;overflow:auto;background:#f6f8fb;border-radius:16px;padding:18px 20px"><div style="display:flex;justify-content:space-between;align-items:start;gap:12px;margin-bottom:12px"><div><h2 id="sgDialogTitle" style="margin:0;font-size:19px">System guide</h2><p style="margin:3px 0 0;color:#667085;font-size:13px">Numbers, parcel statuses, money flow, roles and where things are changed.</p></div><button type="button" class="button button-sm" data-guide-close aria-label="Close">✕</button></div><div id="sgDialogHost"></div></section></div>`,
    );
    void DF.systemGuide.mount(document.getElementById("sgDialogHost"));
  }
  window.addEventListener(
    "click",
    event => {
      const t = event.target instanceof Element ? event.target : null;
      if (t?.closest("[data-guide-open]")) {
        event.stopImmediatePropagation();
        return open();
      }
      if (t?.closest("[data-guide-close]")) document.getElementById("sgDialog")?.remove();
    },
    true,
  );
  document.addEventListener("keydown", event => event.key === "Escape" && document.getElementById("sgDialog")?.remove());
})();
