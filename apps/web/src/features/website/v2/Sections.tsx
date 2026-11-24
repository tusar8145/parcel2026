/**
 * Home page sections of the new design: services (with pictures, public/website/service-*.webp) and the partner
 * banner (merchants, riders, franchises).
 */
const Arrow = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M4 10h12m-5-5 5 5-5 5" />
  </svg>
);

export function Services() {
  return (
    <section className="section v2-services" id="services">
      <div className="shell v2-services-grid">
        <div className="v2-services-copy">
          <p className="eyebrow">One delivery partner, more possibilities</p>
          <h2>{"Whatever needs to get there, we'll get it moving."}</h2>
          <p>Thoughtful delivery for growing shops, busy people, and everything important in between.</p>
          <a className="button button-primary" href="/services">
            Explore all services <Arrow />
          </a>
        </div>
        <div className="services">
          <article className="service-card">
            <img src="/website/service-ecommerce.webp" alt="" width="640" height="220" loading="lazy" />
            <h3>E-commerce delivery</h3>
            <p>Reliable order delivery, cash on delivery, and easy returns for online businesses of every size.</p>
            <a className="text-link" href="/merchant">
              Grow your online shop <Arrow />
            </a>
          </article>
          <article className="service-card">
            <img src="/website/service-documents.webp" alt="" width="640" height="196" loading="lazy" />
            <h3>Documents, handled with care</h3>
            <p>Secure, trackable delivery for contracts, certificates, and other important paperwork.</p>
            <a className="text-link" href="/pricing" data-route="pricing">
              See document rates <Arrow />
            </a>
          </article>
          <article className="service-card">
            <img src="/website/service-parcels.webp" alt="" width="640" height="192" loading="lazy" />
            <h3>Customer parcels</h3>
            <p>Send gifts, essentials, and everyday parcels between cities. Senders pay delivery costs, with optional COD collection for a fee.</p>
            <a className="text-link" href="/pricing" data-route="pricing">
              Get a delivery estimate <Arrow />
            </a>
          </article>
        </div>
      </div>
    </section>
  );
}

export function Partners() {
  return (
    <section className="v2-partners" id="partners">
      <div className="shell v2-partner-banner">
        <div className="v2-partner-art" aria-hidden="true">
          <svg viewBox="0 0 220 90" fill="none">
            <path d="M28 58c30 18 62 22 92 8s52-10 70 6" stroke="#fff" strokeWidth="2.4" strokeDasharray="6 7" strokeLinecap="round" />
            <path d="M28 8a17 17 0 0 1 17 17c0 13-17 31-17 31S11 38 11 25A17 17 0 0 1 28 8z" fill="#fbb51b" />
            <circle cx="28" cy="25" r="6" fill="#14284b" />
            <path d="m168 50 26-12 26 12v26l-26 12-26-12z" fill="#e7a14b" />
            <path d="m168 50 26 12 26-12M194 62v26" stroke="#b9772c" strokeWidth="2" />
            <path d="m181 44 26 12" stroke="#f7d9a8" strokeWidth="5" />
          </svg>
        </div>
        <div className="v2-partner-copy">
          <p className="v2-partner-kicker">Come build something good</p>
          <h2>
            <em>{"There's a place for you"}</em> on the delivery journey.
          </h2>
          <p>Run a business, ride a route, or build a local delivery operation with Delivery Fast.</p>
          <p className="v2-partner-more">
            <a href="/become-a-rider" data-open="rider">
              Ride with us
            </a>
            <span aria-hidden="true">·</span>
            <a href="/become-a-franchise" data-open="franchise">
              Open a franchise hub
            </a>
          </p>
        </div>
        <a className="button button-primary" href="/merchant" data-open="merchant">
          Become a merchant <Arrow />
        </a>
      </div>
      {/* The three ways in, as before (merchant, rider, franchise). */}
      <div className="shell partners v2-partner-cards">
        <article className="partner-card">
          <h3>Become a merchant</h3>
          <p>
            Choose an e-commerce merchant account for shop parcels, or a Banking &amp; Financial merchant account for secure deliveries from banks, fintechs, and other organizations.
          </p>
          <a className="text-link" href="/merchant" data-open="merchant">
            Start a merchant application <Arrow />
          </a>
        </article>
        <article className="partner-card">
          <h3>Ride with us</h3>
          <p>Choose shifts that work for you, deliver in your area, and get support on every route.</p>
          <a className="text-link" href="/become-a-rider" data-open="rider">
            Apply to become a rider <Arrow />
          </a>
        </article>
        <article className="partner-card">
          <h3>Open a franchise hub</h3>
          <p>Operate locally with your team: manage a hub, riders, merchant service, and delivery in your territory.</p>
          <a className="text-link" href="/become-a-franchise" data-open="franchise">
            Explore franchise partnership <Arrow />
          </a>
        </article>
      </div>
    </section>
  );
}
