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
        <div className="hero-art" aria-label="Illustration of a Delivery Fast delivery van arriving at a home">
          {" "}
          <div className="art-sun" />
          <div className="art-path" />
          <div className="art-hill" />
          <div className="art-hill two" />{" "}
          <div className="art-building">
            <div className="building-door" />
          </div>{" "}
          <div className="art-box" />{" "}
          <div className="art-van">
            <div className="van-body" />
            <div className="van-nose" />
            <div className="van-window" />
            <div className="van-logo">delivery fast</div>
            <i className="wheel one" />
            <i className="wheel two" />
          </div>{" "}
          <div className="float-tag tag-top">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M20 7 10 17l-5-5" />
              <circle cx="12" cy="12" r="9" />
            </svg>
            <span>
              <strong>Pickup confirmed</strong>
              <small>Your rider is on the way</small>
            </span>
          </div>{" "}
          <div className="float-tag tag-bottom">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M3 7h11v11H3zM14 11h4l3 3v4h-7z" />
              <circle cx="7.5" cy="19" r="1.5" />
              <circle cx="17.5" cy="19" r="1.5" />
            </svg>
            <span>
              <strong>All the way, tracked</strong>
              <small>From pickup to doorstep</small>
            </span>
          </div>{" "}
        </div>{" "}
      </div>{" "}
    </section>
  );
}
