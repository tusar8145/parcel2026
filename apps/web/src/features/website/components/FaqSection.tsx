export default function FaqSection() {
  return (
    <section className="section" id="faq">
      <div className="shell faq-grid">
        <div className="faq-copy">
          <p className="eyebrow">A little more clarity</p>
          <h2>Good to know.</h2>
          <p>Quick answers to common questions about sending and tracking your parcel.</p>
          <a className="button" href="/support" data-route="support">
            Need more help? Talk to us
          </a>
        </div>
        <div className="faq-list">
          <details className="faq-item">
            <summary>How do I track a parcel?</summary>
            <p>
              {
                "Enter the tracking ID from your booking or confirmation message in the tracking box above. You'll see the latest sample status and delivery milestones."
              }
            </p>
          </details>
          <details className="faq-item">
            <summary>Can I send a parcel without signing up?</summary>
            <p>
              Yes. Use “Request a pickup” to submit a one-time domestic parcel, document, or ecommerce shipment request.
              The demo will generate a tracking reference for you.
            </p>
          </details>
          <details className="faq-item">
            <summary>How does cash on delivery work?</summary>
            <p>
              For eligible ecommerce shipments, a rider collects the order amount from the receiver. Your final merchant
              settlement and COD terms depend on your merchant plan.
            </p>
          </details>
          <details className="faq-item">
            <summary>Do franchise partners run local operations?</summary>
            <p>
              Yes. Franchise partners operate an agreed territory, with their own local hub and team coordinating
              merchant support, parcel handling, and rider operations.
            </p>
          </details>
        </div>
      </div>
    </section>
  );
}
