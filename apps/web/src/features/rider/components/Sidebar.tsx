import AppVersion from "@/shared/AppVersion";
import AppDownloadCard from "@/shared/AppDownloadCard";
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
          {"paira "}
          <span>express</span>
        </div>
      </div>{" "}
      <div className="rider-chip">
        <div className="avatar">JR</div>
        <div className="rider-info">
          <strong>Jordan Rivera</strong>
          <small>Rider ID · RP-2048</small>
        </div>
        <i className="online-dot" title="Online" />
      </div>{" "}
      <nav id="navigation">
        {" "}
        <div className="nav-group">
          <div className="nav-label">My work</div>{" "}
          <button className="nav-item active" data-page="Overview">
            <svg fill="none" stroke="currentColor" strokeWidth="1.7">
              <use href="#i-grid" />
            </svg>
            Overview
          </button>{" "}
          <button className="nav-item" data-page="My route">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-route" />
            </svg>
            My route<span className="nav-count">8</span>
          </button>{" "}
          <button className="nav-item" data-page="Deliveries">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-truck" />
            </svg>
            Deliveries<span className="nav-count">8</span>
          </button>{" "}
          <button className="nav-item" data-page="Pickup queue">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-box" />
            </svg>
            Pickup queue<span className="nav-count">3</span>
          </button>{" "}
          <button className="nav-item" data-page="Scan parcel">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-scan" />
            </svg>
            Scan parcel
          </button>{" "}
        </div>{" "}
        <div className="nav-group">
          <div className="nav-label">Account</div>{" "}
          <button className="nav-item" data-page="Earnings">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-wallet" />
            </svg>
            {"Earnings & COD"}
          </button>{" "}
          <button className="nav-item" data-page="Performance">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-chart" />
            </svg>
            Performance
          </button>{" "}
          <button className="nav-item" data-page={"Help & safety"}>
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
              <use href="#i-help" />
            </svg>
            {"Help & safety"}
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
        <AppDownloadCard app="rider" />
        <div className="help-card">
          <strong>Rider support</strong>
          <p>Need help on a delivery? Our dispatch team is available during your shift.</p>
          <button data-toast="Connecting you to rider support…">Contact dispatch ↗</button>
        </div>{" "}
        <div className="user-profile">
          <div className="avatar">JR</div>
          <div className="profile-meta">
            <strong>Jordan Rivera</strong>
            <small>Verified rider · Dhaka North</small>
          </div>
          <span style={{ color: "#98a2ae" }}>···</span>
        </div>{" "}
        <AppVersion />
      </div>{" "}
    </aside>
  );
}
