export default function SiteFooter() {
  return (
    <footer className="footer">
      <div className="shell">
        <div className="footer-grid">
          <div className="footer-brand">
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
            <a href="/franchise" data-route="franchise">
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
