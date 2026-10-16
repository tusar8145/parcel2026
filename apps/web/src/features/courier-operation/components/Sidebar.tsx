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
        <div className="nav-group">
          <div className="nav-label">Command center</div>{" "}
          <button className="nav-item active" data-page="Overview">
            <svg fill="none" stroke="currentColor" strokeWidth="1.7">
              <use href="#i-grid" />
            </svg>
            Live overview
          </button>{" "}
          <button className="nav-item" data-page="Shipments">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-box" />
            </svg>
            Shipments<span className="nav-count">1,284</span>
          </button>{" "}
          <button className="nav-item" data-page="Dispatch">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-route" />
            </svg>
            {"Dispatch & routes"}
            <span className="nav-count">18</span>
          </button>{" "}
          <button className="nav-item" data-page="Exceptions">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-alert" />
            </svg>
            Exceptions<span className="nav-count">12</span>
          </button>{" "}
          <button className="nav-item" data-page="Returns">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-box" />
            </svg>
            {"Returns (RTO)"}
          </button>{" "}
          <button className="nav-item" data-page="Scheduled pickups">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-clock" />
            </svg>
            {"Scheduled pickups"}
          </button>{" "}
        </div>{" "}
        <div className="nav-group">
          <div className="nav-label">Service operations</div>{" "}
          <button className="nav-item" data-page="Customer parcels">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-box" />
            </svg>
            Customer parcels
          </button>{" "}
          <button className="nav-item" data-page="E-commerce operations">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-box" />
            </svg>
            E-commerce operations
          </button>{" "}
          <button className="nav-item" data-page="Document operations">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-pin" />
            </svg>
            Document operations
          </button>{" "}
          <button className="nav-item" data-page="CN stock">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-box" />
            </svg>
            CN stock
          </button>{" "}
        </div>{" "}
        <div className="nav-group">
          <div className="nav-label">Network</div>{" "}
          <button className="nav-item" data-page="Riders">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-users" />
            </svg>
            {"Riders & fleet"}
          </button>{" "}
          <button className="nav-item" data-page="Hubs">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-pin" />
            </svg>
            {"Hubs & zones"}
          </button>{" "}
          <button className="nav-item" data-page="Linehaul">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-truck" />
            </svg>
            Linehaul
          </button>{" "}
          <button className="nav-item" data-page="Merchants">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-users" />
            </svg>
            Merchant accounts
          </button>{" "}
        </div>{" "}
        <div className="nav-group">
          <div className="nav-label">Business</div>{" "}
          <button className="nav-item" data-page={"COD & finance"}>
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-wallet" />
            </svg>
            {"COD & finance"}
          </button>{" "}
          <button className="nav-item" data-page="Analytics">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-chart" />
            </svg>
            {"Analytics & SLA"}
          </button>{" "}
          <button className="nav-item" data-page="Reports">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-download" />
            </svg>
            Reports
          </button>{" "}
          <button className="nav-item" data-page="Settings">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-settings" />
            </svg>
            Admin settings
          </button>{" "}
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
