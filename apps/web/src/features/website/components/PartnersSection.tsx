export default function PartnersSection() {
  return (
    <section className="section" id="partners">
      {" "}
      <div className="shell">
        <div className="section-heading">
          <p className="eyebrow">Come build something good</p>
          <h2>
            {"There's a place for you"}
            <br />
            on the delivery journey.
          </h2>
          <p>Run a business, ride a route, or build a local delivery operation with Delivery Fast.</p>
        </div>
        <div className="partners">
          {" "}
          <article className="partner-card">
            <div className="service-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M3 10h18M5 10l1-6h12l1 6M5 10v10h14V10M9 20v-6h6v6" />
                <path d="M3 10a2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0" />
              </svg>
            </div>
            <h3>Become a merchant</h3>
            <p>
              Choose an e-commerce merchant account for shop parcels, or a Banking & Financial merchant account for secure
              deliveries from banks, fintechs, and other organizations.
            </p>
            <a className="button" href="/merchant" data-open="merchant">
              Start a merchant application
            </a>
          </article>{" "}
          <article className="partner-card">
            <div className="service-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <circle cx="12" cy="5" r="2" />
                <path d="m9 22 2-7-3-3 2-4h4l3 5-4 2 2 7M8 12l-4 3m11-5 4 1" />
              </svg>
            </div>
            <h3>Ride with us</h3>
            <p>Choose shifts that work for you, deliver in your area, and get support on every route.</p>
            <a className="button" href="/become-a-rider" data-open="rider">
              Apply to become a rider
            </a>
          </article>{" "}
          <article className="partner-card highlight">
            <div className="service-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M3 21h18M5 21V7l7-4 7 4v14M9 11h2m2 0h2m-6 4h2m2 0h2m-4 6v-4h2v4" />
              </svg>
            </div>
            <h3>Open a franchise hub</h3>
            <p>
              Operate locally with your team: manage a hub, riders, merchant service, and delivery in your territory.
            </p>
            <a className="button button-primary" href="/become-a-franchise" data-open="franchise">
              Explore franchise partnership
            </a>
          </article>{" "}
        </div>
      </div>{" "}
    </section>
  );
}
