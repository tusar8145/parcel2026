import { parseAbout, type WebsitePage } from "@delivery-fast/shared";
import { Block } from "./AboutPage";

/**
 * /privacy and /terms. Their text is edited in Super admin › Website settings (GET /website, in ABOUT_FORMAT);
 * until it is, the site's own working draft shows with its notice.
 */
export function LegalPage({ page, edited }: { page: WebsitePage; edited: boolean }) {
  const blocks = parseAbout(page.body);
  return (
    <section className="route-view legal-view">
      <div className="route-shell">
        <a className="route-back" href="/">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M16 10H4m5 5-5-5 5-5" />
          </svg>
          {"Back to home"}
        </a>
        <div className="route-intro">
          <p className="eyebrow">{"Legal"}</p>
          <h1>{page.title}</h1>
          <p>{page.intro}</p>
        </div>
        <article className="route-card legal-doc" style={{ lineHeight: 1.65 }}>
          {edited ? null : (
            <p role="note" style={{ margin: "0 0 18px", padding: "10px 14px", borderRadius: 10, background: "#fff7e0", border: "1px solid #f0dca0" }}>
              <strong>{"Draft for legal review. "}</strong>
              {"This text is a working draft prepared for Delivery Fast and has not yet been approved by counsel."}
            </p>
          )}
          {blocks.map((block, i) => (
            <Block key={i} block={block} first={i === 0} />
          ))}
        </article>
      </div>
    </section>
  );
}
