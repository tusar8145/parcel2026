import BrandMark from "./BrandMark";

export default function SiteFooter() {
  return (
    <footer className="footer">
      <div className="shell">
        <div className="footer-grid">
          <div className="footer-brand">
            <a className="brand" href="/" aria-label="Paira Express home">
              <span className="brand-mark" style={{ width: 46, height: 46 }}>
                <BrandMark />
              </span>
              <span className="brand-word">
                {"paira "}
                <span>express</span>
              </span>
            </a>
            <p>Getting the things that matter where they need to be, across Bangladesh.</p>
            <div className="footer-col footer-contact" style={{ marginTop: 18 }}>
              <strong>Contact Us</strong>
              <a href="tel:+8801969921122">01969 921122</a>
              <a href="mailto:info@pairaexpress.com.bd">info@pairaexpress.com.bd</a>
              <a href="https://www.google.com/maps/search/?api=1&query=House-6%20Road-2A%20Banani%2C%20Dhaka-1213" target="_blank" rel="noopener">
                House-6 Road -2A Banani, Dhaka-1213
              </a>
            </div>
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
            <strong>Paira Express</strong>
            <a href="/about">About us</a>
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
          <span>© 2026 Paira Express. All rights reserved.</span>
          <span>Built for Bangladesh</span>
        </div>
      </div>
    </footer>
  );
}
