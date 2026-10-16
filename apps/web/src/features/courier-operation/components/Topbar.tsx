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
        <strong id="breadcrumbPage">Live overview</strong>
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
          <input id="globalSearch" className="top-search" placeholder="Track shipment..." aria-label="Track shipment" />
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
