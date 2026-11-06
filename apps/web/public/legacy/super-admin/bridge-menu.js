/*
 * Super admin menu: the collapsible groups, and the pages that show one part of a larger page.
 *
 *   Groups   Notification settings · Operational settings · Location settings: a click opens or closes
 *            them; the group of the page on screen is always open; the choice is remembered in this browser.
 *   Parts    Return reasons, Receiver relations and Address each show their part of the catalog page
 *            ("Pricing & catalogs" in 02.js, bridge.js and bridge-geo.js, whose saves and redraws stay as they
 *            were). Old links to that page open Address.
 */
(() => {
  const $ = id => document.getElementById(id);
  const nav = $("navigation");
  if (!nav) return;
  const STORE = "pairaexpress-admin-menu";
  const CATALOG = "Pricing & catalogs";
  const PARTS = {
    "Return reasons": { eyebrow: "Operational settings", subtitle: "The reasons offered on return forms.", heading: "Return reasons" },
    "Receiver relations": { eyebrow: "Operational settings", subtitle: "Who received a delivery, as chosen by riders, the hub desk and Collect from hub.", heading: "Receiver relations" },
    Address: { eyebrow: "Location settings", subtitle: "Districts, zones and areas. Every address form follows this list." },
  };

  // ── groups ──

  let open = new Set();
  try {
    open = new Set(JSON.parse(localStorage.getItem(STORE) || "[]"));
  } catch {}
  const save = () => {
    try {
      localStorage.setItem(STORE, JSON.stringify([...open]));
    } catch {}
  };
  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="dfMenuCss">.nav-sub-toggle{width:100%}.nav-sub-arrow{margin-left:auto;font-size:10px;color:#98a2b3}.nav-sub-items{margin:2px 0 4px 16px;padding-left:8px;border-left:1px solid var(--line,#e4e7ec)}.nav-sub-items[hidden]{display:none}.nav-sub-items .nav-item svg{display:none}</style>`,
  );
  function setOpen(sub, value) {
    sub.querySelector(".nav-sub-items").hidden = !value;
    const toggle = sub.querySelector(".nav-sub-toggle");
    toggle.setAttribute("aria-expanded", String(value));
    toggle.querySelector(".nav-sub-arrow").textContent = value ? "▲" : "▼";
  }
  const subs = [...nav.querySelectorAll("[data-nav-sub]")];
  for (const sub of subs) {
    const items = sub.querySelector(".nav-sub-items");
    items.id = `navSub-${sub.dataset.navSub}`;
    sub.querySelector(".nav-sub-toggle").setAttribute("aria-controls", items.id);
    setOpen(sub, open.has(sub.dataset.navSub));
  }
  nav.addEventListener("click", event => {
    const toggle = event.target.closest?.(".nav-sub-toggle");
    if (!toggle) return;
    const sub = toggle.closest("[data-nav-sub]");
    const value = toggle.getAttribute("aria-expanded") !== "true";
    setOpen(sub, value);
    if (value) open.add(sub.dataset.navSub);
    else open.delete(sub.dataset.navSub);
    save();
  });

  /** The menu follows the page: its item is marked, and its group opens. */
  function follow(page) {
    nav.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.page === page));
    const sub = nav.querySelector(`[data-page="${CSS.escape(page)}"]`)?.closest("[data-nav-sub]");
    if (sub) setOpen(sub, true);
  }

  // ── parts of the catalog page ──

  /** Shows what follows one <strong> title in the operational panel, and hides the rest. */
  function onlyList(panel, title) {
    let showing = false;
    for (const el of panel.children) {
      if (el.classList.contains("panel-heading")) continue;
      if (el.tagName === "STRONG") showing = el.textContent.trim() === title;
      el.style.display = showing && el.tagName !== "STRONG" ? "" : "none";
    }
  }
  function showPart(page) {
    const main = $("mainContent");
    const part = PARTS[page];
    const operational = main.querySelector('[data-catalog-form="returnReasons"]')?.closest("section");
    const address = [...main.querySelectorAll(".panel-title")].find(t => t.textContent.trim() === "Delivery address hierarchy")?.closest("section");
    if (operational) operational.hidden = page === "Address";
    if (address) address.hidden = page !== "Address";
    // One panel on the page: it takes the whole width.
    for (const panel of [operational, address]) if (panel) panel.style.gridColumn = "1 / -1";
    if (operational && part.heading) {
      onlyList(operational, part.heading);
      operational.querySelector(".panel-title").textContent = part.heading;
      operational.querySelector(".panel-subtitle").textContent = part.subtitle;
    }
    const heading = main.querySelector(".page-heading");
    if (heading) {
      heading.querySelector(".eyebrow").textContent = part.eyebrow;
      heading.querySelector("h1").textContent = page;
      heading.querySelector(".subtitle").textContent = part.subtitle;
    }
    const crumb = $("breadcrumbPage");
    if (crumb) crumb.textContent = page;
  }

  let part = null;
  const base = window.showPage;
  window.showPage = showPage = function (page) {
    // A save on a part redraws the catalog page: stay on the part. Old links open Address.
    if (page === CATALOG) page = part || "Address";
    part = PARTS[page] ? page : null;
    base(part ? CATALOG : page);
    if (part) showPart(part);
    follow(page);
  };
  window.addEventListener("df:admin-page", event => follow(event.detail));
  // Later redraws of the catalog page's panels (bridge-geo.js) stay within the part.
  new MutationObserver(() => {
    if (!part) return;
    const stray = [...$("mainContent").querySelectorAll(".page-heading h1")].find(h => h.textContent.trim() !== part);
    if (stray) showPart(part);
  }).observe($("mainContent"), { childList: true });
})();
