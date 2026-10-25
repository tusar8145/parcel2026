/*
 * Super admin › Admin users & roles: the page's sections in tabs — Administrators (directory, role cards, your
 * sign-in security) · Approvals (changes waiting for a second super admin, with the pending count) · Roles &
 * permissions (matrix, custom roles) · Support access. Only shows / hides the sections 01.js and
 * bridge-security.js draw (they redraw them after every action; the chosen tab stays); nothing else changes.
 */
(() => {
  const main = document.getElementById("mainContent");
  if (!main) return;
  const TABS = [
    ["admins", "Administrators"],
    ["approvals", "Approvals"],
    ["roles", "Roles & permissions"],
    ["support", "Support access"],
  ];
  let tab = "admins";
  try {
    tab = sessionStorage.getItem("df-admin-tab") || "admins";
  } catch {}

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="adminTabStyles">
[data-admin-tab-off]{display:none!important}
.admin-tabs{display:inline-flex;gap:4px;flex-wrap:wrap;margin:0 0 14px;padding:4px;border-radius:11px;background:#eef1f5;max-width:100%}
.admin-tabs .button{border:0;background:transparent;color:#556274;padding:7px 13px;border-radius:8px;font-size:13px;font-weight:600;box-shadow:none}
.admin-tabs .button:hover{background:#e3e7ee;color:#1d2939}
.admin-tabs .button.button-primary{background:#fff;color:#2f55c9;box-shadow:0 1px 2px rgba(16,24,40,.08),0 1px 3px rgba(16,24,40,.06)}
.admin-tabs .admin-tab-n{display:inline-block;min-width:18px;height:18px;margin-left:6px;padding:0 5px;border-radius:999px;background:#f04438;color:#fff;font-size:11px;line-height:18px;text-align:center}
#dfSecurity > section:first-child{margin-top:0!important}
</style>`,
  );

  const onPage = () => main.querySelector(".page-heading h1")?.textContent.trim() === "Admin users & roles";
  const title = el => el.querySelector(".panel-title")?.textContent.trim() || "";

  /** Which tab a section belongs to; null = always shown. */
  function tabOf(el) {
    if (el.matches(".page-heading, .admin-tabs, #dfSecurity")) return null;
    if (el.matches(".callout, .setting-grid") || el.querySelector("#adminBody, [data-sec-my-mfa]")) return "admins";
    if (el.id === "dfChanges") return "approvals";
    if (el.id === "dfMatrix" || title(el) === "Custom roles") return "roles";
    if (el.querySelector("#dfSupportForm") || title(el) === "Support access") return "support";
    return null;
  }

  /** Changes still waiting for a second super admin. */
  const pending = () => [...main.querySelectorAll("#dfChanges tbody tr")].filter(tr => /^Pending/.test(tr.cells[2]?.textContent.trim() || "")).length;

  function apply() {
    if (!onPage()) return;
    const heading = main.querySelector(".page-heading");
    let bar = main.querySelector(".admin-tabs");
    if (!bar && heading) {
      heading.insertAdjacentHTML("afterend", `<div class="admin-tabs" role="tablist" aria-label="Admin users & roles"></div>`);
      bar = main.querySelector(".admin-tabs");
    }
    if (bar) {
      const n = pending();
      // Redraw only when the tab or the count changed (a redraw is itself a change this observer sees).
      const key = `${tab}|${n}`;
      if (bar.dataset.drawn !== key) {
        bar.dataset.drawn = key;
        bar.innerHTML = TABS.map(([k, label]) => `<button type="button" role="tab" class="button button-sm${k === tab ? " button-primary" : ""}" data-admin-tab="${k}" aria-selected="${k === tab}">${label.replace("&", "&amp;")}${k === "approvals" && n ? `<span class="admin-tab-n">${n}</span>` : ""}</button>`).join("");
      }
    }
    const sections = [...main.children, ...(main.querySelector("#dfSecurity")?.children || [])];
    for (const el of sections) {
      const t = tabOf(el);
      const off = t !== null && t !== tab;
      if (off !== el.hasAttribute("data-admin-tab-off")) el.toggleAttribute("data-admin-tab-off", off);
    }
  }

  // The page and its sections are redrawn often (loads, saves, approvals): tab them again each time.
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
    const button = event.target instanceof Element ? event.target.closest("[data-admin-tab]") : null;
    if (!button) return;
    tab = button.dataset.adminTab;
    try {
      sessionStorage.setItem("df-admin-tab", tab);
    } catch {}
    apply();
  });
})();
