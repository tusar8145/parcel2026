import BrandMark from "./BrandMark";

export default function SiteHeader() {
  return (
    <header className="header">
      {" "}
      <div className="shell nav">
        {" "}
        <a className="brand" href="#" aria-label="Delivery Fast home">
          <span className="brand-mark" style={{ width: 46, height: 46 }}>
            <BrandMark />
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
