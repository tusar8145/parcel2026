export default function SiteHeader() {
  return (
    <header className="header">
      {" "}
      <div className="shell nav">
        {" "}
        <a className="brand" href="#" aria-label="Delivery Fast home">
          <span className="brand-mark">
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
          </span>
          <span className="brand-word">
            {"delivery "}
            <span>fast</span>
          </span>
        </a>{" "}
        <nav className="nav-links" id="navLinks" aria-label="Main navigation">
          <a href="#services">Services</a>
          <a href="/pricing" data-route="pricing">
            Pricing
          </a>
          <a href="#partners">Partner with us</a>
          <a href="#faq">Help</a>
          <a href="/signup" data-route="signup" style={{ color: "var(--green)", fontWeight: "750" }}>
            Sign up
          </a>
        </nav>{" "}
        <div className="nav-actions">
          <button className="button button-quiet" data-open="login">
            Log in
          </button>
          <button className="button button-primary" data-open="request">
            {"Send a parcel "}
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 10h12m-5-5 5 5-5 5" />
            </svg>
          </button>
          <button className="menu-button" id="menuButton" aria-label="Open navigation" aria-expanded="false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
        </div>{" "}
      </div>{" "}
    </header>
  );
}
