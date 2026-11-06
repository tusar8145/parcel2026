/*
 * Super admin › Rider earning plans: the layout. The page script (03.js) still draws the plan form and the
 * assignment table and saves them; this arranges what it draws, every time it draws it:
 *
 *   Delivery type   Customer parcels · E-commerce · Documents
 *   At a glance     active riders, the most used plan, riders on the plan chosen
 *   Tabs            Earning plans (a card per plan; the chosen plan's form below) · Rider assignments
 *                   (searchable) · Rider location (bridge-location.js)
 *
 * The cards and buttons set the form's own Delivery type and Plan fields, so the page script's handlers do the work.
 */
(() => {
  const PAGE = "Rider plans";
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const TABS = [
    ["plans", "Earning plans"],
    ["assignments", "Rider assignments"],
    ["location", "Rider location"],
  ];
  const MODE = { perParcel: "Per parcel", monthlySalary: "Monthly salary", both: "Salary + per parcel" };
  const S = { tab: new URLSearchParams(location.search).get("section") || "plans", query: "" };
  if (!TABS.some(([key]) => key === S.tab)) S.tab = "plans";

  const css = `.rp-tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:12px 0 16px}
    .rp-tier{display:grid;gap:4px;padding:13px 14px;border:1px solid var(--line);border-radius:10px;background:var(--surface,#fff);color:var(--ink);font:inherit;text-align:left;cursor:pointer}
    .rp-tier:hover{border-color:var(--blue)}
    .rp-tier[aria-pressed="true"]{border-color:var(--blue);background:var(--blue-soft);box-shadow:inset 0 0 0 1px var(--blue)}
    .rp-tier:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
    .rp-tier strong{font-size:14px}.rp-tier b{font-size:18px}.rp-tier span,.rp-tier small{color:#667283;font-size:12px}
    #mainContent[data-rp-tab] .config-layout{grid-template-columns:minmax(0,1fr);margin-top:0}
    #mainContent[data-rp-tab]:not([data-rp-tab="plans"]) #rpPlansPanel,#mainContent[data-rp-tab]:not([data-rp-tab="assignments"]) #rpAssignmentsPanel,#mainContent[data-rp-tab]:not([data-rp-tab="location"]) #dfLocationSettings{display:none}
    #dfLocationSettings{margin-top:0!important}`;

  const plansData = () => window.DFServicePlans;
  const riderIds = () => (plansData()?.riderRows || []).map(row => row[0]);

  /** How many riders are on a plan for a delivery type (riders with no choice are on Growth, as the table shows). */
  function ridersOn(type, tier) {
    const assigned = plansData()?.riderPlanAssignments || {};
    return riderIds().filter(id => (assigned[id]?.[type] || "Growth") === tier).length;
  }

  const hideField = input => {
    const label = input?.closest("label");
    if (label) label.style.display = "none";
  };

  /** Only the amounts this earning model uses are asked for (the other keeps its value). */
  function followMode(form) {
    const mode = form.elements.mode.value;
    form.elements.perParcel.closest("label").style.display = mode === "monthlySalary" ? "none" : "";
    form.elements.monthlySalary.closest("label").style.display = mode === "perParcel" ? "none" : "";
  }

  function arrange() {
    const main = $("mainContent");
    const form = $("riderPlanEditor");
    if (!main || !form) return;
    window.DFPackages?.styles();
    if (!$("rpCss")) document.head.insertAdjacentHTML("beforeend", `<style id="rpCss">${css}</style>`);
    const plans = plansData()?.riderPlans || {};
    const type = form.elements.serviceType.value;
    const tier = form.elements.planTier.value;
    const typeLabel = form.elements.serviceType.selectedOptions[0]?.textContent || "";
    const tiers = [...form.elements.planTier.options].map(o => o.value);
    main.dataset.rpTab = S.tab;

    const planPanel = form.closest("section");
    planPanel.id = "rpPlansPanel";
    const assignPanel = [...main.querySelectorAll(".panel-title")].find(t => t.textContent.trim() === "Rider plan assignments")?.closest("section");
    if (assignPanel) assignPanel.id = "rpAssignmentsPanel";

    // Heading, delivery type, the plan at a glance and the tabs.
    const subtitle = main.querySelector(".page-heading .subtitle");
    if (subtitle) subtitle.textContent = "Choose a delivery type, set what each plan pays, then give riders their plans.";
    const types = [...form.elements.serviceType.options];
    const busiest = tiers.map(name => [name, ridersOn(type, name)]).sort((a, b) => b[1] - a[1])[0];
    const tile = (label, value, hint) => `<article class="svp-tile"><span>${esc(label)}</span><strong>${esc(value)}</strong>${hint ? `<small>${esc(hint)}</small>` : ""}</article>`;
    main.querySelector(".page-heading").insertAdjacentHTML(
      "afterend",
      `<div class="svp-segments" role="group" aria-label="Delivery type" id="rpTypes">${types.map(o => `<button type="button" class="svp-segment" data-rp-type="${esc(o.value)}" aria-pressed="${o.value === type}">${esc(o.textContent)}</button>`).join("")}</div>
       <section class="svp-summary" aria-label="${esc(typeLabel)} at a glance">${tile("Active riders", riderIds().length.toLocaleString("en-US"), "")}${tile("Most used plan", busiest?.[1] ? busiest[0] : "None yet", busiest?.[1] ? `${busiest[1].toLocaleString("en-US")} rider${busiest[1] === 1 ? "" : "s"}` : "")}${tile(`On ${tier}`, ridersOn(type, tier).toLocaleString("en-US"), typeLabel)}</section>
       <div class="svp-tabs" role="tablist" aria-label="Rider earning sections">${TABS.map(([key, label]) => `<button type="button" role="tab" class="svp-tab" data-rp-tab="${key}" aria-selected="${S.tab === key}" tabindex="${S.tab === key ? 0 : -1}">${esc(label)}</button>`).join("")}</div>`,
    );

    // A card per plan; the chosen plan's form below.
    planPanel.querySelector(".panel-title").textContent = `${typeLabel} plans`;
    planPanel.querySelector(".panel-subtitle").textContent = "Each delivery type has its own plans. Choose one to change what it pays.";
    const money = n => `৳${Number(n || 0).toLocaleString("en-BD")}`;
    form.insertAdjacentHTML(
      "beforebegin",
      `<div class="rp-tiers" role="group" aria-label="Plans">${tiers
        .map(name => {
          const plan = plans[type]?.[name] || {};
          const rate = plan.mode === "monthlySalary" ? `${money(plan.monthlySalary)}/month` : `${money(plan.perParcel)}/parcel`;
          const extra = plan.mode === "both" ? `${money(plan.monthlySalary)}/month too` : MODE[plan.mode] || "";
          const riders = ridersOn(type, name);
          return `<button type="button" class="rp-tier" data-rp-tier="${esc(name)}" aria-pressed="${name === tier}"><strong>${esc(name)}</strong><b>${esc(rate)}</b><span>${esc(extra)}</span><small>${riders.toLocaleString("en-US")} rider${riders === 1 ? "" : "s"}</small></button>`;
        })
        .join("")}</div>`,
    );
    hideField(form.elements.serviceType);
    hideField(form.elements.planTier);
    followMode(form);

    // Riders can be searched.
    const heading = assignPanel?.querySelector(".panel-heading");
    if (heading && !$("rpRiderSearch")) heading.insertAdjacentHTML("beforeend", `<input class="table-search" id="rpRiderSearch" type="search" placeholder="Search riders" aria-label="Search riders" value="${esc(S.query)}">`);
    filterRiders();
  }

  function filterRiders() {
    const q = S.query.trim().toLowerCase();
    for (const row of document.querySelectorAll("#rpAssignmentsPanel tbody tr")) {
      const who = [row.cells[0], row.cells[1]].map(cell => cell?.textContent || "").join(" ").toLowerCase();
      row.hidden = !!q && !who.includes(q);
    }
  }

  function keepTabInAddress() {
    const url = new URL(location.href);
    if (S.tab === "plans") url.searchParams.delete("section");
    else url.searchParams.set("section", S.tab);
    if (url.href !== location.href) history.replaceState(history.state, "", url);
  }

  /** Sets one of the form's own fields: the page script redraws the page for it. */
  function choose(name, value) {
    const select = $("riderPlanEditor")?.elements[name];
    if (!select || select.value === value) return;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  document.addEventListener("click", event => {
    const t = event.target;
    if (!(t instanceof Element)) return;
    const type = t.closest("[data-rp-type]");
    if (type) return choose("serviceType", type.dataset.rpType);
    const tier = t.closest("[data-rp-tier]");
    if (tier) return choose("planTier", tier.dataset.rpTier);
    const tab = t.closest("button[data-rp-tab]");
    if (!tab) return;
    S.tab = tab.dataset.rpTab;
    $("mainContent").dataset.rpTab = S.tab;
    for (const button of document.querySelectorAll("button[data-rp-tab]")) {
      const on = button.dataset.rpTab === S.tab;
      button.setAttribute("aria-selected", String(on));
      button.tabIndex = on ? 0 : -1;
    }
    keepTabInAddress();
  });
  document.addEventListener("keydown", event => {
    const tab = event.target.closest?.("button[data-rp-tab]");
    if (!tab || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const tabs = [...document.querySelectorAll("button[data-rp-tab]")];
    const next = tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    event.preventDefault();
    next.click();
    next.focus();
  });
  document.addEventListener("input", event => {
    if (event.target.id !== "rpRiderSearch") return;
    S.query = event.target.value;
    filterRiders();
  });
  document.addEventListener("change", event => {
    if (event.target.name === "mode" && event.target.form?.id === "riderPlanEditor") followMode(event.target.form);
  });

  const base = window.showPage;
  window.showPage = showPage = function (page) {
    const main = $("mainContent");
    if (page !== PAGE) delete main.dataset.rpTab;
    base(page);
    if (page === PAGE) arrange();
  };
})();
