/** The original pages (internal names the page scripts use) and their old labels. */
const LEGACY_PAGES: [string, string][] = [
  ["Overview", "Live overview"],
  ["Shipments", "Shipments"],
  ["Dispatch", "Dispatch & routes"],
  ["Exceptions", "Exceptions"],
  ["Returns", "Returns (RTO)"],
  ["Scheduled pickups", "Scheduled pickups"],
  ["Customer parcels", "Customer parcels"],
  ["E-commerce operations", "E-commerce operations"],
  ["Banking & Financial operations", "Banking & Financial operations"],
  ["CN stock", "CN stock"],
  ["Riders", "Riders & fleet"],
  ["Hubs", "Hubs & zones"],
  ["Linehaul", "Linehaul"],
  ["Merchants", "Merchant accounts"],
  ["COD & finance", "COD & finance"],
  ["Analytics", "Analytics & SLA"],
  ["Reports", "Reports"],
  ["Settings", "Admin settings"],
];

/** One menu item: data-nav names the view; data-stage-count holds the live count of a journey stage. */
function NavItem({ nav, icon, label, step, count, active }: { nav: string; icon: string; label: string; step?: string; count?: boolean; active?: boolean }) {
  return (
    <button type="button" className={active ? "nav-item active" : "nav-item"} data-nav={nav}>
      <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
        <use href={`#i-${icon}`} />
      </svg>
      {step ? (
        <span className="nav-step" aria-hidden="true" style={{ minWidth: 16, color: "#a0a9b6", fontSize: 12, fontWeight: 600 }}>
          {step}
        </span>
      ) : null}
      {label}
      {count ? <span className="nav-count" data-stage-count={nav} /> : null}
    </button>
  );
}

export default function Sidebar() {
  return (
    <aside className="sidebar" id="sidebar">
      {" "}
      <div className="brand">
        <div className="brand-mark">
          <svg
            viewBox="0 0 32 32"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
          >
            <path d="m12 3 4-2 4 2v5l-4 2-4-2V3Z" stroke="#fcc118" strokeWidth="1.8" />
            <path d="m12 3 4 2 4-2m-4 2v5" stroke="#fcc118" strokeWidth="1.4" />
            <path d="M16 10v2" />
            <rect x="5" y="12" width="22" height="13" rx="4" />
            <path d="M9 17h14" stroke="#fcc118" strokeWidth="1.5" />
            <circle cx="12" cy="20" r="1.2" fill="#fcc118" stroke="none" />
            <circle cx="20" cy="20" r="1.2" fill="#fcc118" stroke="none" />
            <path d="M11 25v2m10-2v2" />
            <circle cx="10" cy="28" r="2" fill="currentColor" stroke="none" />
            <circle cx="22" cy="28" r="2" fill="currentColor" stroke="none" />
          </svg>
        </div>
        <div className="brand-name">
          {"delivery "}
          <span>fast</span>
        </div>
      </div>{" "}
      <button className="company-switch" id="companySwitch">
        <span className="company-avatar">DF</span>
        <span className="company-info">
          <strong>Delivery Fast</strong>
          <small>Operations console</small>
        </span>
        <span className="switch-chevron">⌄</span>
      </button>{" "}
      <nav id="navigation">
        {" "}
        {/* Courier Operations navigation, organised around the parcel journey. Each item opens a
            view (public/legacy/courier-operation/bridge-nav.js) drawn by the original page
            renderers; the counts are the parcels at that stage, kept live. */}
        <div className="nav-group" data-nav-group="today">
          <NavItem nav="Today" icon="grid" label="Today" active />
        </div>{" "}
        <div className="nav-group" data-nav-group="journey">
          <div className="nav-label">Parcel journey</div>
          <NavItem nav="New orders" icon="box" step="1" label="New orders" count />
          <NavItem nav="Pickup" icon="clock" step="2" label="Pickup" count />
          <NavItem nav="Hub desk" icon="pin" step="3" label="Hub desk" count />
          <NavItem nav="Transfers" icon="truck" step="4" label="Transfers" count />
          <NavItem nav="Delivery" icon="route" step="5" label="Delivery" count />
          <NavItem nav="Problems" icon="alert" step="6" label="Problems" count />
          <NavItem nav="Returns" icon="box" step="7" label="Returns" count />
        </div>{" "}
        <div className="nav-group" data-nav-group="money">
          <div className="nav-label">Money</div>
          <NavItem nav="COD & settlement" icon="wallet" step="8" label="COD & settlement" />
        </div>{" "}
        <div className="nav-group" data-nav-group="find">
          <div className="nav-label">{"Find & report"}</div>
          <NavItem nav="All parcels" icon="search" label="All parcels" />
          <NavItem nav="Reports" icon="chart" label="Reports" />
        </div>{" "}
        <div className="nav-group" data-nav-group="manage">
          <div className="nav-label">Manage</div>
          <NavItem nav="Riders" icon="users" label="Riders" />
          <NavItem nav="Merchants" icon="users" label="Merchants" />
          <NavItem nav="Hubs & zones" icon="pin" label="Hubs & zones" />
          <NavItem nav="CN stock" icon="box" label="CN stock" />
          <NavItem nav="Settings" icon="settings" label="Settings" />
        </div>{" "}
        {/* The original page buttons, kept hidden: the page scripts mark the page on screen
            here (".nav-item.active", "[data-page=Hubs].active") and write their badges. */}
        <div className="nav-group" id="legacyNav" hidden aria-hidden="true">
          {LEGACY_PAGES.map(([page, label]) => (
            <button key={page} type="button" className={page === "Overview" ? "nav-item active" : "nav-item"} data-page={page} tabIndex={-1}>
              {label}
              {["Shipments", "Dispatch", "Exceptions"].includes(page) ? <span className="nav-count" /> : null}
            </button>
          ))}
        </div>{" "}
      </nav>{" "}
      <div className="sidebar-bottom">
        <div className="support-card">
          <strong>Operations support</strong>
          <p>Need help with a hub, rider, or merchant shipment?</p>
          <button data-toast="Operations support is ready in the full product.">Contact support ↗</button>
        </div>
        <div className="user-profile">
          <div className="avatar">AM</div>
          <div className="profile-meta">
            <strong>Alex Morgan</strong>
            <small>Network administrator</small>
          </div>
          <span style={{ color: "#98a2ae" }}>···</span>
        </div>
      </div>{" "}
    </aside>
  );
}
