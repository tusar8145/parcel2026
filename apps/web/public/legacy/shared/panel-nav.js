/*
 * Page addresses for the panels whose menu is `#navigation [data-page]` buttons: super admin, both merchant
 * panels and the rider app (Courier Operations has its own views and tabs in courier-operation/bridge-nav.js).
 * Loaded last. Connects the panel's renderer to DF.nav (shared/api.js):
 *
 *   /super-admin?page=approval-center · /super-admin?page=import-settings&tab=e-commerce
 *   /ecommerce-merchant?page=payments · /banking-merchant?page=billing · /rider?page=scan-parcel
 *   ?page=notifications (every panel) · ?page=support&ticket=<number> · ?parcel=<tracking ID> (merchant panels: the
 *   parcel drawer, shared/merchant-parcel.js; kept in the address while it is open)
 *
 * Slugs are the kebab-case page names (a few use their menu label); old names (?page=Scan%20parcel) still
 * work and are rewritten. Tabs inside a page are its buttons with the attribute in TABS: the tab on screen
 * (TABS[page].detect, watched as the page redraws) is in the address, a change is a history entry, and a
 * deep link clicks the button once the page has drawn it.
 */
(() => {
  const DF = window.DF;
  if (!DF?.nav || DF.nav.panel) return;
  const app = document.body.dataset.app;
  const CONFIG = {
    "super-admin": { panel: "Super admin", renderer: "showPage" },
    "ecommerce-merchant": { panel: "E-commerce merchant", renderer: "renderPage" },
    "banking-merchant": { panel: "Banking & Financial merchant", renderer: "renderPage" },
    rider: { panel: "Rider", renderer: "render" },
  }[app];
  if (!CONFIG) return;
  const $ = id => document.getElementById(id);

  /** Pages whose slug isn't their internal name (the menu label reads better). */
  const SLUGS = {
    "super-admin": { Approvals: "approval-center", "Platform settings": "global-notifications", "Pricing & catalogs": "catalogs-and-locations" },
    // Merchant panels: the Payments page is Balance (shared/merchant-balance.js); old Payments / Billing links open it.
    "ecommerce-merchant": { Payments: "balance" },
    "banking-merchant": { Payments: "balance" },
  }[app] || {};
  const ALIASES = { Payments: ["Payments", "Billing", "Billing & invoices"] };
  /** Tabs inside pages: the buttons' attribute and their values (value, label, slug). */
  const TABS = {
    "super-admin": {
      "Import settings": {
        attr: "data-import-tab",
        detect: () => document.querySelector('#mainContent [data-import-tab][aria-selected="true"]')?.dataset.importTab || null,
        list: [
          ["customer", "Customer parcel template", "customer"],
          ["ecommerce", "E-commerce template", "e-commerce"],
          ["document", "Banking & Financial template", "banking-and-financial"],
        ],
      },
      // SMS, Email & Push (super-admin/bridge-notifications.js).
      Integrations: {
        attr: "data-int-tab",
        detect: () => document.querySelector('#mainContent [data-int-tab][aria-selected="true"]')?.dataset.intTab || null,
        list: [
          ["settings", "Channels & limits", "channels-and-limits"],
          ["messages", "Recent messages", "recent-messages"],
          ["gateways", "Gateway Settings", "gateway-settings"],
          ["push", "Push notifications", "push-notifications"],
        ],
      },
      "Service plans": {
        attr: "data-pkg-segment",
        detect: () => document.querySelector('#mainContent [data-pkg-segment][aria-pressed="true"]')?.dataset.pkgSegment || null,
        list: [
          ["CUSTOMER", "Customer", "customer"],
          ["ECOMMERCE", "E-commerce", "e-commerce"],
          ["BANKING_FINANCIAL", "Banking & Financial", "banking-and-financial"],
        ],
      },
    },
    // Scan parcel's action sections (rider/bridge-scan.js; its own ?scan= link still works).
    rider: {
      "Scan parcel": {
        attr: "data-df-scan-section",
        detect: () => document.querySelector("#dfScanSession")?.dataset.section || null,
        list: [
          ["pickup", "Pickup from merchant", "pickup"],
          ["handover", "Hand over at hub", "handover"],
          ["start", "Start deliveries", "start"],
          ["deliver", "Deliver", "deliver"],
          ["failed", "Failed delivery / return to hub", "failed"],
          ["return", "Return to merchant", "return"],
        ],
      },
    },
  }[app] || {};

  const labelOf = button => [...button.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(" ").replace(/\s+/g, " ").trim();
  function pages() {
    const list = [...document.querySelectorAll("#navigation [data-page]")].map(b => {
      const name = b.dataset.page;
      const label = labelOf(b) || name;
      const tabs = TABS[name];
      return {
        name,
        label,
        slug: SLUGS[name] || DF.nav.slug(name),
        aliases: [label, ...(app.endsWith("-merchant") ? ALIASES[name] || [] : [])],
        tabs: tabs?.list.map(([value, tabLabel, slug]) => ({ name: value, label: tabLabel, slug })),
      };
    });
    if (!list.some(p => p.name === "Notifications")) list.push({ name: "Notifications", slug: "notifications" });
    if (window.DFMerchantPanel?.locked?.()) list.push({ name: "Account verification", slug: "verification" });
    if (!list.some(p => p.name === "Support")) list.push({ name: "Support", slug: "support" });
    return list;
  }

  const tabState = {};
  let page = null;
  let renderedAt = 0;

  /** Clicks a tab button once the page has drawn it (async pages draw after loading). */
  function clickTab(pageName, value) {
    const def = TABS[pageName];
    if (!def) return;
    const started = Date.now();
    const attempt = () => {
      if (page !== pageName) return;
      const button = document.querySelector(`#mainContent [${def.attr}="${CSS.escape(value)}"]`);
      if (button) {
        if (def.detect ? def.detect() !== value : !button.classList.contains("button-primary")) button.click();
        tabState[pageName] = value;
        DF.nav.entered(pageName, value);
        return;
      }
      if (Date.now() - started < 6000) setTimeout(attempt, 150);
    };
    attempt();
  }

  // Pages whose tab shows in the markup (detect): the address follows what is on screen.
  const main = $("mainContent");
  if (main && Object.values(TABS).some(t => t.detect))
    new MutationObserver(() => {
      const def = page && TABS[page];
      if (!def?.detect) return;
      const value = def.detect();
      const before = tabState[page] ?? null;
      if (before === value) return;
      tabState[page] = value;
      // The page's first tab appearing (its data just loaded) isn't a move of its own.
      DF.nav.entered(page, value, { replace: before === null && Date.now() - renderedAt < 2500 });
      if (new URLSearchParams(location.search).has("scan")) DF.nav.setParam("scan", null);
    }).observe(main, { childList: true, subtree: true });

  // A tab click: the bridge redraws first (capture phase), then the address follows.
  document.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !page || !TABS[page]) return;
    const button = target.closest(`#mainContent [${TABS[page].attr}]`);
    if (!button) return;
    const value = button.getAttribute(TABS[page].attr);
    if (tabState[page] === value) return;
    tabState[page] = value;
    DF.nav.entered(page, value);
  });

  function install() {
    const base = window[CONFIG.renderer];
    if (typeof base !== "function") return;
    window[CONFIG.renderer] = function (next, ...rest) {
      const result = base.call(this, next, ...rest);
      // A merchant panel that isn't active draws "Account verification" instead of other pages: the address follows the screen.
      const shown = window.DFMerchantPanel?.state?.page;
      if (shown && shown !== next && window.DFMerchantPanel?.locked?.()) {
        page = shown;
        renderedAt = Date.now();
        DF.nav.entered(shown, null, { replace: true });
        return result;
      }
      page = next;
      renderedAt = Date.now();
      if (TABS[next]?.detect) tabState[next] = TABS[next].detect();
      DF.nav.entered(next, TABS[next] ? (tabState[next] ?? null) : null);
      return result;
    };
    const merchant = app.endsWith("-merchant");
    const want = DF.nav.start({
      panel: CONFIG.panel,
      home: "Overview",
      pages,
      open(next, tab) {
        window[CONFIG.renderer](next);
        if (tab) clickTab(next, tab);
      },
      openTicket: number => window.DFSupport?.open(number),
      // Merchant panels: the parcel drawer when the panel has one, else Shipments filtered to it.
      openParcel: merchant
        ? id => {
            const drawer = window.DFMerchantParcel;
            if (drawer?.open) return drawer.id === id ? undefined : drawer.open(id);
            window[CONFIG.renderer]("Shipments");
            const search = $("tableSearch");
            if (search) {
              search.value = id;
              search.dispatchEvent(new Event("input", { bubbles: true }));
            }
          }
        : undefined,
    });
    if (want) {
      window[CONFIG.renderer](want.page);
      if (want.tab) clickTab(want.page, want.tab);
    } else {
      page = window.DFMerchantPanel?.locked?.()
        ? window.DFMerchantPanel.state.page
        : document.querySelector("#navigation .nav-item.active")?.dataset.page || $("breadcrumbPage")?.textContent || "Overview";
      DF.nav.entered(page, null);
    }
    DF.nav.extras();
  }

  // The merchant parcel drawer (shared/merchant-parcel.js) is part of the address while it is open.
  window.addEventListener("dfm:parcel", event => DF.nav.setParam("parcel", event.detail?.trackingId || null));

  // After the bridges have started (they draw the first page once their data is in, and wrap the renderer).
  Promise.resolve(DF.bridgeReady)
    .catch(() => undefined)
    .then(() => new Promise(resolve => setTimeout(resolve, 0)))
    .then(install);
})();
