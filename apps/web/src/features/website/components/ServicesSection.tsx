export default function ServicesSection() {
  return (
    <section className="section" id="services">
      {" "}
      <div className="shell">
        <div className="section-heading">
          <p className="eyebrow">One delivery partner, more possibilities</p>
          <h2>
            Whatever needs to get there,
            <br />
            {"we'll get it moving."}
          </h2>
          <p>Thoughtful delivery for growing shops, busy people, and everything important in between.</p>
        </div>{" "}
        <div className="services">
          {" "}
          <article className="service-card">
            <div className="service-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="m3 7 9-4 9 4-9 4-9-4Z" />
                <path d="M3 7v10l9 4 9-4V7M12 11v10" />
              </svg>
            </div>
            <h3>E-commerce delivery</h3>
            <p>Reliable order delivery, cash on delivery, and easy returns for online businesses of every size.</p>
            <a className="text-link" href="#partners">
              {"Grow your online shop "}
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M4 10h12m-5-5 5 5-5 5" />
              </svg>
            </a>
          </article>{" "}
          <article className="service-card">
            <div className="service-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M6 3h9l4 4v14H6z" />
                <path d="M14 3v5h5M9 13h7m-7 4h7" />
              </svg>
            </div>
            <h3>Documents, handled with care</h3>
            <p>Secure, trackable delivery for contracts, certificates, and other important paperwork.</p>
            <a className="text-link" href="/pricing" data-route="pricing">
              {"See document rates "}
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M4 10h12m-5-5 5 5-5 5" />
              </svg>
            </a>
          </article>{" "}
          <article className="service-card">
            <div className="service-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M3 7h11v11H3zM14 11h4l3 3v4h-7z" />
                <circle cx="7.5" cy="19" r="1.5" />
                <circle cx="17.5" cy="19" r="1.5" />
              </svg>
            </div>
            <h3>Customer parcels</h3>
            <p>
              Send gifts, essentials, and everyday parcels between cities. Senders pay delivery costs, with optional COD
              collection for a fee.
            </p>
            <a className="text-link" href="/pricing" data-route="pricing">
              {"Get a delivery estimate "}
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M4 10h12m-5-5 5 5-5 5" />
              </svg>
            </a>
          </article>{" "}
        </div>{" "}
      </div>{" "}
    </section>
  );
}
