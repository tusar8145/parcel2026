import type { WebsiteFaq } from "@paira-express/shared";

/** The questions are edited in Super admin › Website settings. */
export default function FaqSection({ faqs }: { faqs: WebsiteFaq[] }) {
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
          {faqs.map(faq => (
            <details className="faq-item" key={faq.id}>
              <summary>{faq.question}</summary>
              <p>{faq.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
