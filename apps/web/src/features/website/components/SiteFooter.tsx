import BrandMark from "./BrandMark";

export default function SiteFooter() {
  return (
    <footer className="footer">
      <div className="shell">
        <div className="footer-grid">
          <div className="footer-brand">
            <a className="brand" href="/" aria-label="Delivery Fast home">
              <span className="brand-mark" style={{ width: 46, height: 46 }}>
                <BrandMark />
              </span>
              <span className="brand-word">
                {"delivery "}
                <span>fast</span>
              </span>
            </a>
            <p>Getting the things that matter where they need to be, across Bangladesh.</p>
          </div>
          <div className="footer-col">
            <strong>{"Send & receive"}</strong>
            <a href="#services">Our services</a>
            <a href="/pricing" data-route="pricing">
              Delivery prices
            </a>
            <a href="/track" data-route="tracking">
              Track a parcel
            </a>
            <a href="/request" data-route="request">
              Request a pickup
            </a>
          </div>
          <div className="footer-col">
            <strong>Partner with us</strong>
            <a href="/merchant" data-route="merchant">
              For merchants
            </a>
            <a href="/become-a-rider" data-route="rider">
              For riders
            </a>
            <a href="/become-a-franchise" data-route="franchise">
              Franchise opportunities
            </a>
          </div>
          <div className="footer-col">
            <strong>Delivery Fast</strong>
            <a href="#faq">{"Help & FAQs"}</a>
            <a href="/support" data-route="support">
              Customer support
            </a>
            <a href="/login" data-route="login">
              Log in
            </a>
            <a href="/signup" data-route="signup">
              Create an account
            </a>
            <a href="/privacy">Privacy Policy</a>
            <a href="/terms">Terms of Service</a>
            <a href="/privacy#cookies" data-cookie-settings="1">
              Cookie settings
            </a>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© 2026 Delivery Fast. Demo website for presentation purposes.</span>
          <span>
            {"Built for Bangladesh · "}
            <a href="/courier-operation">Operations demo</a>
          </span>
        </div>
      </div>
    </footer>
  );
}
