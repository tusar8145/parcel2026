export default function Topbar() {
  return (
    <header className="topbar">
      {" "}
      <button className="mobile-menu" id="mobileMenu" aria-label="Open navigation">
        <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8">
          <use href="#i-menu" />
        </svg>
      </button>{" "}
      <div className="breadcrumb">
        {"Meridian Bank PLC "}
        <span style={{ padding: "0 7px", color: "#c0c7d0" }}>/</span> <strong id="breadcrumbPage">Overview</strong>
      </div>{" "}
      <div className="top-actions">
        {" "}
        <div className="search-wrap">
          <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8">
            <use href="#i-search" />
          </svg>
          <input
            className="top-search"
            id="globalSearch"
            placeholder="Search anything..."
            aria-label="Search anything"
          />
        </div>{" "}
        <button className="icon-button" id="notificationButton" aria-label="Notifications">
          <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
            <use href="#i-bell" />
          </svg>
          <i className="notification-dot" />
        </button>{" "}
        <div className="profile-avatar" title="Farhana Ahmed">
          FA
        </div>{" "}
      </div>{" "}
    </header>
  );
}
