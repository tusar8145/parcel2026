export default function Topbar() {
  return (
    <header className="topbar">
      <button className="mobile-menu" id="mobileMenu" aria-label="Open navigation">
        <svg fill="none" stroke="currentColor" strokeWidth="1.8">
          <use href="#i-menu" />
        </svg>
      </button>
      <div className="breadcrumb">
        {"Delivery Fast "}
        <span style={{ padding: "0 7px", color: "#c0c7d0" }}>/</span>
        <strong id="breadcrumbLabel">Today</strong>
        {/* The page scripts' own page name (internal; bridge-nav.js shows the menu label above). */}
        <strong id="breadcrumbPage" hidden>
          Live overview
        </strong>
      </div>
      <div className="top-actions">
        <span className="live-chip">
          <i />
          {" Network live"}
        </span>
        <div className="search-wrap">
          <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8">
            <use href="#i-search" />
          </svg>
          <input
            id="globalSearch"
            className="top-search"
            placeholder="Tracking ID, CN or phone…"
            aria-label="Find a parcel by tracking ID, CN or phone (type or scan, then Enter)"
            autoComplete="off"
          />
        </div>
        <button className="icon-button" id="notifications" aria-label="Notifications">
          <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
            <use href="#i-bell" />
          </svg>
          <i className="notification-dot" />
        </button>
        <div className="avatar">AM</div>
      </div>
    </header>
  );
}
