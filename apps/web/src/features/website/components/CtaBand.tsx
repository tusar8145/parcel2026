/** The last call before the footer (theme.css .cta-band). */
export default function CtaBand() {
  return (
    <section className="cta-band">
      <div className="shell cta-box">
        <div>
          <p className="eyebrow">Ready when you are</p>
          <h2>{"Let's get your first parcel moving."}</h2>
          <p>Book a pickup or create an account to follow your deliveries.</p>
        </div>
        <div className="cta-actions">
          <a className="button button-primary" href="/request" data-open="request">
            Request a parcel pickup
          </a>
          <a className="button" href="/signup" data-open="signup">
            Create an account
          </a>
        </div>
      </div>
    </section>
  );
}
