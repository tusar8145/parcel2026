import BrandMark from "../components/BrandMark";
import { SITE_CACHE_TAG } from "../siteContent";

type Social = Partial<Record<"facebook" | "instagram" | "linkedin" | "youtube" | "whatsapp", string>>;

/** The company's social links (Super admin › Branding & company); none set: the column says where to follow later. */
async function socialLinks(): Promise<Social> {
  try {
    const res = await fetch(`${process.env.API_ORIGIN ?? "http://localhost:4000"}/api/v1/branding`, { next: { tags: [SITE_CACHE_TAG], revalidate: 300 }, signal: AbortSignal.timeout(3000) });
    if (res.ok) return ((await res.json()) as { social?: Social }).social ?? {};
  } catch {}
  return {};
}

const ICONS: Record<keyof Social, string> = {
  facebook: "M14 8h3V4h-3c-2.8 0-4.5 1.8-4.5 4.6V11H7v4h2.5v9h4v-9h3l.5-4h-3.5V8.8c0-.5.3-.8 1-.8z",
  linkedin: "M5 9h3.5v11H5zM6.8 3.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM10.5 9H14v1.6c.5-.9 1.7-1.9 3.5-1.9 3.6 0 4 2.4 4 5.4V20H18v-5.2c0-1.3 0-2.9-1.8-2.9s-2.1 1.4-2.1 2.8V20h-3.6z",
  youtube: "M22 8.2a3 3 0 0 0-2.1-2.1C18 5.6 12 5.6 12 5.6s-6 0-7.9.5A3 3 0 0 0 2 8.2 31 31 0 0 0 1.6 12 31 31 0 0 0 2 15.8a3 3 0 0 0 2.1 2.1c1.9.5 7.9.5 7.9.5s6 0 7.9-.5a3 3 0 0 0 2.1-2.1c.4-1.2.4-3.8.4-3.8s0-2.6-.4-3.8zM10 15.1V8.9l5.2 3.1z",
  instagram: "M12 7.2a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6zm0 7.9a3.1 3.1 0 1 1 0-6.2 3.1 3.1 0 0 1 0 6.2zM17 5.8a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2zM12 3c-2.4 0-2.7 0-3.7.1-3.3.2-5 1.8-5.2 5.2C3 9.3 3 9.6 3 12s0 2.7.1 3.7c.2 3.3 1.8 5 5.2 5.2 1 .1 1.3.1 3.7.1s2.7 0 3.7-.1c3.3-.2 5-1.8 5.2-5.2.1-1 .1-1.3.1-3.7s0-2.7-.1-3.7c-.2-3.3-1.8-5-5.2-5.2C14.7 3 14.4 3 12 3z",
  whatsapp: "M12 2.5a9.5 9.5 0 0 0-8.2 14.3L2.5 21.5l4.8-1.3A9.5 9.5 0 1 0 12 2.5zm5.3 13.4c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .1-3.2-.8-2.7-1.1-4.4-3.9-4.5-4.1-.1-.2-1.1-1.4-1.1-2.7s.7-1.9.9-2.2c.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.4.6-.4.4c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.8-1c.2-.3.4-.2.7-.1l2 1c.3.1.5.2.5.3.1.1.1.7-.1 1.4z",
};

export default async function Footer() {
  const social = await socialLinks();
  const links = (Object.keys(ICONS) as (keyof Social)[]).filter(k => social[k]?.trim());
  return (
    <footer className="footer v2-footer">
      <div className="shell">
        <div className="footer-grid">
          <div className="footer-brand">
            <a className="brand" href="/" aria-label="Delivery Fast home">
              <span className="brand-mark">
                <BrandMark light />
              </span>
              <span className="brand-word">
                {"delivery "}
                <span>fast</span>
              </span>
            </a>
            <p>Getting the things that matter where they need to be, across Bangladesh.</p>
          </div>
          <div className="footer-col">
            <strong>Quick Links</strong>
            <a href="/">Home</a>
            <a href="/about">About us</a>
            <a href="/track" data-route="tracking">
              Track a parcel
            </a>
            <a href="/pricing" data-route="pricing">
              Delivery prices
            </a>
            <a href="/request" data-route="request">
              Request a pickup
            </a>
            <a href="/services">Our services</a>
          </div>
          <div className="footer-col">
            <strong>Partner with us</strong>
            <a href="/partners">Partnership options</a>
            <a href="/merchant" data-route="merchant">
              For merchants
            </a>
            <a href="/become-a-rider" data-route="rider">
              For riders
            </a>
            <a href="/become-a-franchise" data-route="franchise">
              Franchise opportunities
            </a>
            <a href="/login" data-route="login">
              Log in
            </a>
            <a href="/signup" data-route="signup">
              Create an account
            </a>
          </div>
          <div className="footer-col">
            <strong>Help</strong>
            <a href="/help">Help &amp; FAQs</a>
            <a href="/support" data-route="support">
              Customer support
            </a>
            <a href="/privacy">Privacy Policy</a>
            <a href="/terms">Terms of Service</a>
            <a href="/privacy#cookies" data-cookie-settings="1">
              Cookie settings
            </a>
          </div>
          <div className="footer-col v2-branches">
            <strong>Our Branches</strong>
            <span>Tejgaon I/A, Dhaka</span>
            <span>Banani, Dhaka</span>
          </div>
          <div className="footer-col footer-contact">
            <strong>Contact Us</strong>
            <a href="tel:+8801969921122">01969 921122</a>
            <a href="mailto:info@deliveryfast.com.bd">info@deliveryfast.com.bd</a>
            <a href="https://www.google.com/maps/search/?api=1&query=House-6%20Road-2A%20Banani%2C%20Dhaka-1213" target="_blank" rel="noopener">
              House-6 Road -2A Banani, Dhaka-1213
            </a>
            {links.length ? (
              <div className="v2-social" aria-label="Follow us">
                {links.map(k => (
                  <a key={k} href={social[k]} target="_blank" rel="noopener" aria-label={k[0].toUpperCase() + k.slice(1)}>
                    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d={ICONS[k]} />
                    </svg>
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className="footer-bottom">
          <span>© 2026 Delivery Fast. All rights reserved.</span>
          <span>
            Built for Bangladesh · <a href="/classic">Classic website</a>
          </span>
        </div>
      </div>
    </footer>
  );
}
