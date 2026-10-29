import BrandMark from "@/shared/BrandMark";
import AppDownloadCard from "@/shared/AppDownloadCard";

export default function Sidebar() {
  return (
    <aside className="sidebar" id="sidebar">
      {" "}
      <div className="brand">
        {" "}
        <div className="brand-mark">
          <BrandMark size={40} />
        </div>{" "}
        <div className="brand-name">
          {"paira "}
          <span>express</span>
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
            Delivery requests<span className="nav-count">24</span>
          </button>{" "}
          <button className="nav-item" data-page="Shipments">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-truck" />
            </svg>
            Delivery tracking<span className="nav-count">18</span>
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
            Product catalogue
          </button>{" "}
        </div>{" "}
        <div className="nav-group">
          {" "}
          <div className="nav-label">Manage</div>{" "}
          <button className="nav-item" data-page="Payments">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-wallet" />
            </svg>
            Balance
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
        <AppDownloadCard app="merchant" />
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
