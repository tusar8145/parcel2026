export default function Topbar() {
  return (
    <header className="topbar">
      <button className="mobile-menu" id="mobileMenu" aria-label="Open navigation">
        <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" width="16" height="16">
          <use href="#i-menu" />
        </svg>
      </button>{" "}
      <div className="breadcrumb">
        {"Rider workspace "}
        <span style={{ padding: "0 7px", color: "#c0c7d0" }}>/</span> <strong id="breadcrumbPage">Overview</strong>
      </div>{" "}
      <div className="top-actions">
        <span className="shift-chip" id="shiftChip">
          <i />
          {" Shift active"}
        </span>
        <button className="icon-button" id="notificationButton" aria-label="Notifications">
          <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
            <use href="#i-bell" />
          </svg>
          <i className="notification-dot" />
        </button>
        <div className="avatar">JR</div>
      </div>{" "}
    </header>
  );
}
