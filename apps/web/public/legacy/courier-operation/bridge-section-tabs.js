/*
 * Long Courier Operations pages split into tabs by task (bridge-nav.js gives each tab its part, Ops.hubPart). The
 * page scripts still draw every section; each one is recognised by its title, tagged with its tab (again after
 * every redraw), and CSS shows the current tab's. Sections without a known title show on every tab, the counters
 * stay on top, and a tab with nothing for this person (e.g. finance-only sections) is hidden.
 *   Transfers (Linehaul)   Send · Receive · On the road · Issues · Vehicles
 *   COD & settlement       Cash from riders · Franchise · Settlements & payouts · Invoices & accounts
 *   Riders                 Riders · Shifts & attendance · Verification
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops) return;
  const main = document.getElementById("mainContent");
  if (!main) return;

  const PAGES = {
    Linehaul: {
      parts: ["send", "receive", "road", "issues", "vehicles"],
      sections: {
        "Bag up parcels": "send",
        "Trips & manifests": "send",
        Bags: "send",
        "Receive transfers": "receive",
        "Inbound transfers": "receive",
        "Vehicles on the road": "road",
        "Parcels in transit between hubs": "road",
        Discrepancies: "issues",
        Vehicles: "vehicles",
      },
      buttons: { "bulk-transfer": "send", "transfer-history": "send", "new-trip": "send", "new-bag": "send", "vehicles-jump": "none" },
      guide: {
        send: `<h2 class="panel-title">How to send parcels to another hub</h2><p class="panel-subtitle">One bag per destination hub. Single parcels can also go from Scan desk → Transfer out.</p></div></div><ol class="sec-steps">
          <li><b>1</b><div><strong>Bag the parcels</strong><small>New bag (or open one), choose the destination hub, scan the parcels into it.</small></div></li>
          <li><b>2</b><div><strong>Seal the bag</strong><small>Seal bag, type the seal number and print the bag label.</small></div></li>
          <li><b>3</b><div><strong>Plan a trip, load bags</strong><small>Plan trip (to the same hub) → Manifest → scan each sealed bag's label.</small></div></li>
          <li><b>4</b><div><strong>Depart</strong><small>When the truck leaves: Depart. Every parcel goes in transit; the other hub receives the bags.</small></div></li>
        </ol>`,
        receive: `<h2 class="panel-title">Receiving a truck</h2><p class="panel-subtitle">Scan each bag's label to receive the whole bag (or open it and scan the parcels one by one). Type the seal number to check it. Missing and extra parcels are recorded on Issues. Single parcels can also be received on Scan desk → Receive entry.</p></div></div>`,
      },
    },
    "COD & finance": {
      parts: ["cash", "franchise", "settlements", "accounts"],
      sections: {
        "Rider cash on hand": "cash",
        "Cash handover requests": "cash",
        "COD & finance register": "cash",
        "Recent cash handovers": "cash",
        "Franchise deposits": "franchise",
        "Franchise commission invoices": "franchise",
        "Settlement approvals": "settlements",
        "Automatic settlement schedule": "settlements",
        "Rider payouts": "settlements",
        "Delivery-charge invoices · VAT": "accounts",
        "Refunds, claims and weight disputes": "accounts",
        "Bank / bKash reconciliation": "accounts",
        "Ledger · trial balance": "accounts",
      },
      buttons: {},
      // The action first: the riders' cash to receive, then what was received.
      order: ["Cash handover requests", "Rider cash on hand", "COD & finance register"],
      guide: {
        cash: `<h2 class="panel-title">Cash from riders</h2><p class="panel-subtitle">Riders hand the cash they collected to the hub. Count it and press Receive cash on the rider; the handover appears under the register below.</p></div></div>`,
      },
    },
    Riders: {
      parts: ["riders", "shifts", "kyc"],
      sections: {
        "Rider pickup & status report": "riders",
        "Assigned shipment list": "riders",
        "Today's shift roster": "shifts",
        "Shift schedules": "shifts",
        "Attendance report": "shifts",
        "Recent check-ins": "shifts",
        "Rider verification": "kyc",
      },
      // The report's counters belong to the Riders tab.
      metrics: "riders",
      buttons: {},
      guide: {},
    },
  };
  const ALL_PARTS = [...new Set(Object.values(PAGES).flatMap(p => p.parts))];

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="dfSectionTabs">${ALL_PARTS.map(p => `#mainContent[data-sec-part="${p}"] [data-sec]:not([data-sec="${p}"]){display:none!important}`).join("")}
      #mainContent[data-sec-part] [data-sec-pair]{grid-template-columns:minmax(0,1fr)!important}
      .sec-steps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0;padding:0 16px 16px;list-style:none}
      .sec-steps li{display:flex;gap:10px;align-items:flex-start;padding:12px;border:1px solid var(--line,#e9edf2);border-radius:10px;background:#fafbfd}
      .sec-steps b{flex:none;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:#3766e8;color:#fff;font-size:12px}
      .sec-steps strong{display:block;font-size:13px}
      .sec-steps small{display:block;margin-top:2px;color:#667085;font-size:12px;line-height:1.4}
      @media(max-width:900px){.sec-steps{grid-template-columns:minmax(0,1fr)}}
    </style>`,
  );

  const configNow = () => PAGES[Ops.page()] || null;
  /** A section's tab: its title, exactly or (titles with a changing tail like "Ledger · trial balance 2026-10") by start. */
  const partOf = (cfg, title) => cfg.sections[title] ?? Object.entries(cfg.sections).find(([t]) => title.startsWith(t))?.[1];

  /** Tags the page's sections and heading buttons with their tab. */
  function tag() {
    const cfg = configNow();
    if (!cfg) return;
    for (const panel of main.querySelectorAll("section.panel, .panel")) {
      if (panel.dataset.sec) continue;
      const title = panel.querySelector(".panel-title")?.textContent?.trim();
      const part = title && partOf(cfg, title);
      if (!part) continue;
      panel.dataset.sec = part;
      // Two sections side by side: one column when only one shows.
      const parent = panel.parentElement;
      if (parent && parent !== main && getComputedStyle(parent).display === "grid") parent.dataset.secPair = "1";
    }
    if (cfg.metrics) for (const m of main.querySelectorAll(".metrics, .metric-grid, .stats-grid")) if (!m.dataset.sec) m.dataset.sec = cfg.metrics;
    if (cfg.order) {
      const panels = cfg.order.map(t => [...main.querySelectorAll("section.panel, .panel")].find(p => p.querySelector(".panel-title")?.textContent?.trim() === t)).filter(Boolean);
      for (let i = 1; i < panels.length; i++) {
        const prev = panels[i - 1];
        if (prev.compareDocumentPosition(panels[i]) & Node.DOCUMENT_POSITION_PRECEDING) prev.after(panels[i]);
        else if (prev.nextElementSibling !== panels[i] && prev.parentElement === panels[i].parentElement) prev.after(panels[i]);
      }
    }
    for (const button of main.querySelectorAll(".page-heading [data-lh]")) if (!button.dataset.sec && cfg.buttons[button.dataset.lh]) button.dataset.sec = cfg.buttons[button.dataset.lh];
    hideEmptyTabs(cfg);
  }

  /** Tabs with no section for this person are hidden (e.g. finance-only tabs for operations). */
  function hideEmptyTabs(cfg) {
    const view = Ops.views && Object.entries(Ops.views).find(([, v]) => v.tabs?.some(t => t.page === Ops.page() && cfg.parts.includes(t.part)));
    if (!view) return;
    for (const t of view[1].tabs) {
      const button = main.querySelector(`[data-nav-tab="${CSS.escape(t.id)}"]`);
      if (!button) continue;
      const has = !!main.querySelector(`[data-sec="${t.part}"]`) || !!cfg.guide[t.part];
      // The tab bar's CSS overrides [hidden]: hide by style.
      button.style.display = !has && t.part !== Ops.hubPart ? "none" : "";
    }
  }
  new MutationObserver(() => tag()).observe(main, { childList: true, subtree: true });

  for (const page of Object.keys(PAGES)) {
    const base = Ops.enhance[page];
    Ops.enhance[page] = (...args) => {
      base?.(...args);
      if (Ops.page() !== page) return;
      const cfg = PAGES[page];
      const part = cfg.parts.includes(Ops.hubPart) ? Ops.hubPart : null;
      if (part) main.dataset.secPart = part;
      else delete main.dataset.secPart;
      document.getElementById("secGuide")?.remove();
      const guide = part && cfg.guide[part];
      if (guide) {
        const anchor = main.querySelector(".metrics, .metric-grid, .stats-grid") || main.querySelector(".page-heading");
        anchor?.insertAdjacentHTML("afterend", `<section class="panel" id="secGuide" data-sec="${part}"><div class="panel-heading"><div>${guide}</section>`);
      }
      tag();
    };
  }
  // Other pages: no tab filter.
  const baseStar = Ops.enhance["*"];
  Ops.enhance["*"] = page => {
    baseStar?.(page);
    if (!PAGES[page]) delete main.dataset.secPart;
  };
})();
