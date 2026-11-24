/**
 * The home page's first screen (new design): the heading and actions beside a soft dot grid (no photo), a strip
 * with an example of a tracked parcel, and the four figures with icons. Still, no animation.
 */
const Check = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
    <path d="m5 10.5 3.2 3.2L15 7" />
  </svg>
);

export default function Hero() {
  return (
    <>
      <section className="hero v2-hero">
        <div className="v2-hero-photo" aria-hidden="true" />
        <div className="shell v2-hero-copy">
          <p className="eyebrow">Bangladesh, delivered better</p>
          <h1>
            Good things
            <br />
            {"are "}
            <em>on the way.</em>
          </h1>
          <p className="hero-copy">{"From your next online order to the documents that just can't wait. Pickups, tracking, and delivery made refreshingly simple."}</p>
          <div className="hero-actions">
            <a className="button button-primary" href="/request" data-open="request">
              {"Request a pickup "}
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M4 10h12m-5-5 5 5-5 5" />
              </svg>
            </a>
            <a className="button v2-outline" href="/track" data-route="tracking">
              <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M6 4.5v11l9-5.5z" />
              </svg>
              Track a parcel
            </a>
          </div>
          <div className="proof">
            <div className="avatars" aria-hidden="true">
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
          </div>
        </div>
      </section>
      {/* An example of a parcel being followed. */}
      <section className="shell v2-track-strip" aria-label="Example: a parcel followed from pickup to delivery">
        <div className="v2-ts-id">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2a7 7 0 0 1 7 7c0 5.2-7 13-7 13S5 14.2 5 9a7 7 0 0 1 7-7zm0 4.5A2.5 2.5 0 1 0 12 11.5 2.5 2.5 0 0 0 12 6.5z" />
          </svg>
          <span>
            <small>Tracking number</small>
            <strong>PP-260914-1042</strong>
          </span>
        </div>
        <div className="v2-ts-status">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M2 6h12v10H2zM14 10h4.5l3.5 3.5V16h-8z" />
            <circle cx="6" cy="18" r="2" />
            <circle cx="17.5" cy="18" r="2" />
          </svg>
          <span>
            <strong>Out for delivery</strong>
            <small>
              From Gulshan, Dhaka <b aria-hidden="true">→</b> To Agrabad, Chattogram
            </small>
          </span>
        </div>
        <ol className="v2-ts-steps">
          <li className="done">
            <i>
              <Check />
            </i>
            Pickup confirmed
          </li>
          <li className="done">
            <i>
              <Check />
            </i>
            Picked up
          </li>
          <li className="done">
            <i>
              <Check />
            </i>
            Out for delivery
          </li>
          <li>
            <i>
              <Check />
            </i>
            Delivered
          </li>
        </ol>
        <div className="v2-ts-eta">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M3 10h18M8 3v4M16 3v4M8 14h2M14 14h2M8 17h2" />
          </svg>
          <span>
            <small>Estimated delivery</small>
            <strong>
              Today, <em>by 6:00 PM</em>
            </strong>
          </span>
        </div>
      </section>
      <section className="stat-strip v2-stats" aria-label="Delivery Fast at a glance">
        <div className="shell stats">
          <div className="stat">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2a7 7 0 0 1 7 7c0 5.2-7 13-7 13S5 14.2 5 9a7 7 0 0 1 7-7zm0 4.5A2.5 2.5 0 1 0 12 11.5 2.5 2.5 0 0 0 12 6.5z" />
            </svg>
            <span>
              <strong>64</strong>
              <span>districts within reach</span>
            </span>
          </div>
          <div className="stat">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M3 21V9l6-3v15zM10 21V3l11 4v14zm3-12h2v2h-2zm4 0h2v2h-2zm-4 4h2v2h-2zm4 0h2v2h-2zM5 11h2v2H5zm0 4h2v2H5z" />
            </svg>
            <span>
              <strong>1.2k+</strong>
              <span>businesses on board</span>
            </span>
          </div>
          <div className="stat">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5zm-1.2 13.6L7 11.8l1.4-1.4 2.4 2.4 4.8-4.8L17 9.4z" />
            </svg>
            <span>
              <strong>98.6%</strong>
              <span>successful delivery rate</span>
            </span>
          </div>
          <div className="stat">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M7 2h2v2h6V2h2v2h3a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3zM5 9v10h14V9zm2 2h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2zm-8 4h2v2H7zm4 0h2v2h-2z" />
            </svg>
            <span>
              <strong>Every day</strong>
              <span>here when you need us</span>
            </span>
          </div>
        </div>
      </section>
    </>
  );
}
