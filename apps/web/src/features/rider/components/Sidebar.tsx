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
      </div>{" "}
    </aside>
  );
}
