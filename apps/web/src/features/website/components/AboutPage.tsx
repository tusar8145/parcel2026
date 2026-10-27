import type { ReactNode } from "react";
import { DEFAULT_BRANDING, parseAbout, type AboutBlock } from "@delivery-fast/shared";

/**
 * /about: the company profile. Its text is edited in Super admin › Branding & company (GET /branding,
 * about.title / intro / body in ABOUT_FORMAT); until then it is Paira Express's own.
 */

const H2 = ({ children }: { children: ReactNode }) => <h2 style={{ margin: "30px 0 10px", fontSize: 21, letterSpacing: "-.3px" }}>{children}</h2>;
const H3 = ({ children }: { children: ReactNode }) => <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>{children}</h3>;
const card = { border: "1px solid #dfe8e2", borderRadius: 14, padding: "16px 18px", background: "#fbfdfb" } as const;
const list = { margin: "6px 0 0", paddingLeft: 20, display: "grid", gap: 6 } as const;
// Two cards a row on wide screens, one on phones.
const cards = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: 14 } as const;
const tiles = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 14 } as const;

function Block({ block, first }: { block: AboutBlock; first: boolean }) {
  switch (block.kind) {
    case "heading":
      return <H2>{block.text}</H2>;
    case "paragraph":
      return <p>{block.text}</p>;
    case "list": {
      const items = block.items.map((t, i) => <li key={i}>{t}</li>);
      return block.ordered ? <ol style={list}>{items}</ol> : <ul style={list}>{items}</ul>;
    }
    case "tiles":
      return (
        <div style={{ ...tiles, marginTop: first ? 0 : 20 }}>
          {block.items.map((t, i) => (
            <div key={i} style={{ ...card, background: "#f1f8f4" }}>
              <strong style={{ display: "block", fontSize: 28, color: "var(--green, #087e67)", lineHeight: 1.1 }}>{t.value}</strong>
              <span style={{ fontSize: 13, color: "#49605d" }}>{t.label}</span>
            </div>
          ))}
        </div>
      );
    case "cards":
      return (
        <div style={{ ...cards, marginTop: first ? 0 : 14 }}>
          {block.items.map((c, i) => (
            <div key={i} style={card}>
              <H3>{c.title}</H3>
              {c.text.map((t, j) => (
                <p key={j} style={{ margin: j ? "8px 0 0" : 0 }}>
                  {t}
                </p>
              ))}
            </div>
          ))}
        </div>
      );
  }
}

export function AboutPage({ about = DEFAULT_BRANDING.about }: { about?: { title: string; intro: string; body: string } }) {
  const blocks = parseAbout(about.body);
  return (
    <section className="route-view about-view">
      <div className="route-shell">
        <a className="route-back" href="/">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M16 10H4m5 5-5-5 5-5" />
          </svg>
          {"Back to home"}
        </a>
        <div className="route-intro">
          <p className="eyebrow">About us</p>
          <h1>{about.title}</h1>
          {about.intro ? <p>{about.intro}</p> : null}
        </div>
        <article className="route-card" style={{ lineHeight: 1.7 }}>
          {blocks.map((b, i) => (
            <Block key={i} block={b} first={i === 0} />
          ))}
        </article>
      </div>
    </section>
  );
}
