import BrandMark from "@/shared/BrandMark";

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
          <BrandMark size={40} />
        </div>
        <div className="brand-name">
          {"delivery "}
          <span>fast</span>
        </div>
      </div>{" "}
      {/* A brand label (there is one company to show; nothing to switch). */}
      <div className="company-switch" id="companySwitch" style={{ cursor: "default" }}>
        <span className="company-avatar">DF</span>
        <span className="company-info">
          <strong>Delivery Fast</strong>
          <small>Operations console</small>
        </span>
      </div>{" "}
      <nav id="navigation">
        {" "}
        {/* Courier Operations navigation, organised around the parcel journey. Each item opens a
            view (public/legacy/courier-operation/bridge-nav.js) drawn by the original page
            renderers; the counts are the parcels at that stage, kept live. */}
        <div className="nav-group" data-nav-group="today">
          <NavItem nav="Today" icon="grid" label="Today" active />
        </div>{" "}
        <div className="nav-group" data-nav-group="queue">
          <NavItem nav="New orders" icon="box" label="New orders" count />
          <NavItem nav="All parcels" icon="search" label="All parcels" />
          <NavItem nav="Work queue" icon="queue" label="Parcel queue" count />
          <NavItem nav="Scan desk" icon="box" label="Scan desk" />
        </div>{" "}
        <div className="nav-group" data-nav-group="journey">
          <div className="nav-label">Parcel journey</div>
          <NavItem nav="Pickup" icon="clock" label="Pickup" count />
          <NavItem nav="Hub desk" icon="pin" label="Hub desk" count />
          <NavItem nav="Transfers" icon="truck" label="Transfers" count />
          <NavItem nav="Delivery" icon="route" label="Delivery" count />
          <NavItem nav="Problems" icon="alert" label="Problems" count />
          <NavItem nav="Returns" icon="box" label="Returns" count />
        </div>{" "}
        <div className="nav-group" data-nav-group="money">
          <div className="nav-label">Money</div>
          <NavItem nav="COD & settlement" icon="wallet" label="COD & settlement" count />
        </div>{" "}
        <div className="nav-group" data-nav-group="find">
          <div className="nav-label">{"Find & report"}</div>
          <NavItem nav="Reports" icon="chart" label="Reports" />
        </div>{" "}
        <div className="nav-group" data-nav-group="manage">
          <div className="nav-label">Manage</div>
          <NavItem nav="Riders" icon="users" label="Riders" />
          <NavItem nav="Merchants" icon="users" label="Merchants" />
          <NavItem nav="CN stock" icon="box" label="CN stock" />
          <NavItem nav="Settings" icon="settings" label="Settings" />
        </div>{" "}
        {/* The original page buttons, kept hidden: the page scripts mark the page on screen
            here (".nav-item.active", "[data-page=Hubs].active"). Badges are on the journey menu. */}
        <div className="nav-group" id="legacyNav" hidden aria-hidden="true">
          {LEGACY_PAGES.map(([page, label]) => (
            <button key={page} type="button" className={page === "Overview" ? "nav-item active" : "nav-item"} data-page={page} tabIndex={-1}>
              {label}
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
