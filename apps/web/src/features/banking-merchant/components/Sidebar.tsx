export default function Sidebar() {
  return (
    <aside className="sidebar" id="sidebar">
      {" "}
      <div className="brand">
        {" "}
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
        </div>{" "}
        <div className="brand-name">
          {"delivery "}
          <span>fast</span>
        </div>{" "}
      </div>{" "}
      <div className="workspace-switch">
        {" "}
        <div className="workspace-avatar">MB</div>{" "}
        <div className="workspace-meta">
          <strong>Meridian Bank PLC</strong>
          <small>Banking & Financial merchant</small>
        </div>{" "}
        <span style={{ color: "#99a3af", fontSize: "14px" }}>⌄</span>{" "}
      </div>{" "}
      <nav id="navigation">
        {" "}
        <div className="nav-group">
          {" "}
          <div className="nav-label">Workspace</div>{" "}
          <button className="nav-item active" data-page="Overview">
            <svg fill="none" stroke="currentColor" strokeWidth="1.7">
              <use href="#i-grid" />
            </svg>
            Overview
          </button>{" "}
          <button className="nav-item" data-page="Orders">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-orders" />
            </svg>
            Document requests<span className="nav-count">24</span>
          </button>{" "}
          <button className="nav-item" data-page="Shipments">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-truck" />
            </svg>
            Document tracking<span className="nav-count">18</span>
          </button>{" "}
          <button className="nav-item" data-page="Pickup requests">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-pin" />
            </svg>
            Pickup requests<span className="nav-count">6</span>
          </button>{" "}
          <button className="nav-item" data-page="Customers">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-users" />
            </svg>
            {"Recipients & branches"}
          </button>{" "}
          <button className="nav-item" data-page="Products">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-tag" />
            </svg>
            Document catalogue
          </button>{" "}
        </div>{" "}
        <div className="nav-group">
          {" "}
          <div className="nav-label">Manage</div>{" "}
          <button className="nav-item" data-page="Payments">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-wallet" />
            </svg>
            Payments
          </button>{" "}
          <button className="nav-item" data-page="Billing">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-wallet" />
            </svg>
            {"Billing & invoices"}
          </button>{" "}
          <button className="nav-item" data-page="Reports">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-chart" />
            </svg>
            Reports
          </button>{" "}
          <button className="nav-item" data-page={"API & Webhooks"}>
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-settings" />
            </svg>
            {"API & Webhooks"}
          </button>{" "}
          <button className="nav-item" data-page="Settings">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-settings" />
            </svg>
            Settings
          </button>{" "}
        </div>{" "}
      </nav>{" "}
      <div className="sidebar-bottom">
        {" "}
        <div className="help-card">
          <strong>Need a hand?</strong>
          <p>Our merchant success team is here to help you grow.</p>
          <button data-toast="Support center is ready in the full product.">Visit help center ↗</button>
        </div>{" "}
        <div className="user-profile">
          <div className="profile-avatar">FA</div>{" "}
          <div className="profile-meta">
            <strong>Farhana Ahmed</strong>
            <small>Corporate operations</small>
          </div>
          <span style={{ color: "#98a2ae" }}>···</span>
        </div>{" "}
      </div>{" "}
    </aside>
  );
}
