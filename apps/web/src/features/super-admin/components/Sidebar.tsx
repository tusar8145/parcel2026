import BrandMark from "@/shared/BrandMark";

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
      <button className="workspace" id="workspace">
        <span className="workspace-icon">DF</span>
        <span className="workspace-info">
          <strong>Platform administration</strong>
          <small>Super admin workspace</small>
        </span>
        <span className="workspace-caret">⌄</span>
      </button>{" "}
      <nav id="navigation">
        {" "}
        <div className="nav-group">
          <div className="nav-label">Governance</div>{" "}
          <button className="nav-item active" data-page="Overview">
            <svg fill="none" stroke="currentColor" strokeWidth="1.7">
              <use href="#i-grid" />
            </svg>
            Platform overview
          </button>{" "}
          <button className="nav-item" data-page="Registrations">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-clipboard" />
            </svg>
            Registrations
            <span className="nav-count" id="registrationCount">
              4
            </span>
          </button>{" "}
          <button className="nav-item" data-page="Approvals">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-check" />
            </svg>
            Approval center<span className="nav-count">4</span>
          </button>{" "}
        </div>{" "}
        <div className="nav-group">
          <div className="nav-label">Merchant management</div>{" "}
          <button className="nav-item" data-page="E-commerce merchants">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-building" />
            </svg>
            E-commerce merchants
          </button>{" "}
          <button className="nav-item" data-page="Banking & Financial merchants">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-building" />
            </svg>
            Banking & Financial merchants
          </button>{" "}
          <button className="nav-item" data-page="Service plans">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-settings" />
            </svg>
            {"Service plans & pricing"}
          </button>{" "}
          <button className="nav-item" data-page="Import settings">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-box" />
            </svg>
            Excel Import settings
          </button>{" "}
          <button className="nav-item" data-page="Parcel notifications">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-settings" />
            </svg>
            Parcel notifications
          </button>{" "}
        </div>{" "}
        <div className="nav-group">
          <div className="nav-label">{"Rider setup & pricing"}</div>{" "}
          <button className="nav-item" data-page="Rider plans">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-wallet" />
            </svg>
            Rider earning plans
          </button>{" "}
        </div>{" "}
        <div className="nav-group">
          <div className="nav-label">Platform control</div>{" "}
          <button className="nav-item" data-page="Platform activity">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-chart" />
            </svg>
            Platform activity
          </button>{" "}
          <button className="nav-item" data-page="Admin users">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-users" />
            </svg>
            {"Admin users & roles"}
          </button>{" "}
          <button className="nav-item" data-page="Platform settings">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-settings" />
            </svg>
            Global notifications
          </button>{" "}
          <button className="nav-item" data-page="Integrations">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-plug" />
            </svg>
            {"SMS, Email & Push"}
          </button>{" "}
          <button className="nav-item" data-page={"Pricing & catalogs"}>
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-box" />
            </svg>
            {"Shared catalogs & locations"}
          </button>{" "}
          <button className="nav-item" data-page="Audit log">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-clipboard" />
            </svg>
            {"Audit & security log"}
          </button>{" "}
          <button className="nav-item" data-page="System guide">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-clipboard" />
            </svg>
            System guide
          </button>{" "}
          <button className="nav-item" data-page={"Branding & company"}>
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-settings" />
            </svg>
            {"Branding & company"}
          </button>{" "}
        </div>{" "}
      </nav>{" "}
      <div className="sidebar-bottom">
        <a className="ops-link" href="/courier-operation">
          <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
            <use href="#i-truck" />
          </svg>
          {" Open courier operations console ↗"}
        </a>
        <div className="admin-profile">
          <div className="avatar">AM</div>
          <div className="profile-meta">
            <strong>Alex Morgan</strong>
            <small>Super administrator</small>
          </div>
          <span style={{ color: "#98a2ae" }}>···</span>
        </div>
      </div>{" "}
    </aside>
  );
}
