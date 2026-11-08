import AppVersion from "@/shared/AppVersion";
import BrandMark from "@/shared/BrandMark";

export default function Sidebar() {
  return (
    <aside className="sidebar" id="sidebar">
      {" "}
      <div className="brand">
        <div className="brand-mark">
          <BrandMark size={200} />
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
          <div className="nav-label">Merchant management</div>
          <button className="nav-item" data-page="E-commerce merchants">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-building" />
            </svg>
            E-commerce merchants
          </button>
          <button className="nav-item" data-page="Banking & Financial merchants">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-building" />
            </svg>
            Banking & Financial merchants
          </button>
          <button className="nav-item" data-page="Service plans">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-settings" />
            </svg>
            {"Service plans & pricing"}
          </button>
        </div>
        <div className="nav-group">
          <div className="nav-label">{"Rider setup & pricing"}</div>
          <button className="nav-item" data-page="Rider plans">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-wallet" />
            </svg>
            Rider earning plans
          </button>
        </div>
        <div className="nav-group">
          <div className="nav-label">Monitoring</div>
          <button className="nav-item" data-page="Platform activity">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-chart" />
            </svg>
            Platform activity
          </button>
          <button className="nav-item" data-page="Audit log">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-clipboard" />
            </svg>
            {"Audit & security log"}
          </button>
        </div>
        <div className="nav-group">
          <div className="nav-label">Platform control</div>
          <button className="nav-item" data-page="Admin users">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-users" />
            </svg>
            {"Admin users & roles"}
          </button>
          <div className="nav-sub" data-nav-sub="notifications">
            <button type="button" className="nav-item nav-sub-toggle" aria-expanded="false">
              <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-plug" />
            </svg>
              {"Notification settings"}
              <span className="nav-sub-arrow" aria-hidden="true" />
            </button>
            <div className="nav-sub-items" hidden>
          <button className="nav-item" data-page="Parcel notifications">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-settings" />
            </svg>
            Parcel notifications
          </button>
          <button className="nav-item" data-page="Platform settings">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-settings" />
            </svg>
            Global notifications
          </button>
          <button className="nav-item" data-page={"Channels & limits"}>
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-plug" />
            </svg>
            {"Channel & limits"}
          </button>
          <button className="nav-item" data-page={"Push notifications"}>
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-plug" />
            </svg>
            {"Push notifications"}
          </button>
          <button className="nav-item" data-page={"Recent messages"}>
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-plug" />
            </svg>
            {"Recent messages"}
          </button>
            </div>
          </div>
          <button className="nav-item" data-page={"Website settings"}>
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-settings" />
            </svg>
            {"Website & branding"}
          </button>
          <div className="nav-sub" data-nav-sub="operational">
            <button type="button" className="nav-item nav-sub-toggle" aria-expanded="false">
              <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-box" />
            </svg>
              {"Operational settings"}
              <span className="nav-sub-arrow" aria-hidden="true" />
            </button>
            <div className="nav-sub-items" hidden>
          <button className="nav-item" data-page={"Return reasons"}>
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-box" />
            </svg>
            {"Return reasons"}
          </button>
          <button className="nav-item" data-page={"Receiver relations"}>
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-box" />
            </svg>
            {"Receiver relations"}
          </button>
          <button className="nav-item" data-page={"Products"}>
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-box" />
            </svg>
            {"Products"}
          </button>
          <button className="nav-item" data-page="Invoice settings">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-clipboard" />
            </svg>
            {"Invoice settings"}
          </button>
          <button className="nav-item" data-page="Import settings">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-box" />
            </svg>
            {"Import Template settings"}</button>
            </div>
          </div>
          <div className="nav-sub" data-nav-sub="location">
            <button type="button" className="nav-item nav-sub-toggle" aria-expanded="false">
              <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-box" />
            </svg>
              {"Location settings"}
              <span className="nav-sub-arrow" aria-hidden="true" />
            </button>
            <div className="nav-sub-items" hidden>
          <button className="nav-item" data-page={"Address"}>
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-box" />
            </svg>
            {"Address"}
          </button>
          <button className="nav-item" data-page={"Hubs & zones"}>
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-box" />
            </svg>
            {"Hubs & zones"}
          </button>
            </div>
          </div>
          <button className="nav-item" data-page={"Integration settings"}>
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-plug" />
            </svg>
            {"Integration settings"}
          </button>
          <button className="nav-item" data-page="System guide">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-clipboard" />
            </svg>
            System guide
          </button>
        </div>{" "}{" "}
      </nav>{" "}
      <div className="sidebar-bottom">
        <a className="ops-link" href="/courier-operation">
          <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
            <use href="#i-truck" />
          </svg>
          {" Open operations console ↗"}
        </a>
        <a className="ops-link" href="/admin/">
          <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
            <use href="#i-settings" />
          </svg>
          {" Open the new super admin panel ↗"}
        </a>
        <div className="admin-profile">
          <div className="avatar">AM</div>
          <div className="profile-meta">
            <strong>Alex Morgan</strong>
            <small>Super administrator</small>
          </div>
          <span style={{ color: "#98a2ae" }}>···</span>
        </div>
        <AppVersion />
      </div>{" "}
    </aside>
  );
}
