export default function Hero() {
  return (
    <section className="hero">
      {" "}
      <div className="shell hero-grid">
        {" "}
        <div>
          {" "}
          <p className="eyebrow">
            <i />
            {" Bangladesh, delivered better"}
          </p>{" "}
          <h1>
            Good things
            <br />
            {"are "}
            <em>on the way.</em>
          </h1>{" "}
          <p className="hero-copy">
            {
              "From your next online order to the documents that just can't wait. Pickups, tracking, and delivery made refreshingly simple."
            }
          </p>{" "}
          <div className="hero-actions">
            <a className="button button-primary" href="/request" data-open="request">
              {"Request a pickup "}
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M4 10h12m-5-5 5 5-5 5" />
              </svg>
            </a>
            <a className="button" href="/track" data-route="tracking">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
                <circle cx="8.5" cy="8.5" r="5.5" />
                <path d="m13 13 4 4" />
              </svg>
              {" Track a parcel"}
            </a>
          </div>{" "}
          <div className="proof">
            <div className="avatars">
              <span>NA</span>
              <span>RK</span>
              <span>SM</span>
              <span>+</span>
            </div>
            <span>
              <strong>Trusted by 1,200+ businesses</strong>
              <br />
              and thousands of happy receivers
            </span>
          </div>{" "}
        </div>{" "}
        {/* A still example of a parcel being followed (theme.css .hero-card): no animation. */}
        <div className="hero-visual" aria-label="Example: a parcel followed from pickup to delivery">
          <div className="hero-card">
            <div className="hero-card-head">
              <span>
                <small>Tracking number</small>
                <strong>PP-260914-1042</strong>
              </span>
              <span className="hero-badge">Out for delivery</span>
            </div>
            <div className="hero-route">
              <span>
                <small>From</small>
                <strong>Gulshan, Dhaka</strong>
              </span>
              <i aria-hidden="true">→</i>
              <span>
                <small>To</small>
                <strong>Agrabad, Chattogram</strong>
              </span>
            </div>
            <ol className="hero-steps">
              <li className="done">
                <strong>Pickup confirmed</strong>
                <small>Rider on the way</small>
              </li>
              <li className="done">
                <strong>Picked up</strong>
                <small>Parcel collected</small>
              </li>
              <li className="done current">
                <strong>Out for delivery</strong>
                <small>Rider heading to you</small>
              </li>
              <li>
                <strong>Delivered</strong>
                <small>Handed over at the door</small>
              </li>
            </ol>
          </div>
          <div className="hero-chip">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
              <circle cx="12" cy="12" r="8.5" />
              <path d="M12 7.5V12l3 2" />
            </svg>
            <span>
              <strong>Estimated delivery</strong>
              <small>Today, by 6:00 PM</small>
            </span>
          </div>
        </div>{" "}
      </div>{" "}
    </section>
  );
}
