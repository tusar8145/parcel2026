"use client";

import { useEffect, useState } from "react";

interface Release {
  version: string;
  date: string;
  changes: string[];
}

/** From CHANGELOG.md at build time (next.config.ts). */
const VERSION = process.env.APP_VERSION ?? "";
const RELEASES: Release[] = JSON.parse(process.env.APP_RELEASES ?? "[]");

/** Every panel's sidebar, at the bottom: the version, and "What's new" with the latest changelog notes. */
export default function AppVersion() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!VERSION) return null;
  return (
    <>
      <div className="app-version" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, margin: "10px 4px 0", color: "#98a2b3", fontSize: 12 }}>
        <span>{`Paira Express v${VERSION}`}</span>
        <button type="button" onClick={() => setOpen(true)} style={{ padding: 0, border: 0, background: "none", color: "#2f55c9", font: "inherit", fontWeight: 600, cursor: "pointer" }}>
          {"What's new"}
        </button>
      </div>
      {open ? (
        <div
          role="presentation"
          onMouseDown={event => event.target === event.currentTarget && setOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 1001, display: "grid", placeItems: "center", padding: 16, background: "#17203366" }}
        >
          <section role="dialog" aria-modal="true" aria-labelledby="dfWhatsNewTitle" style={{ display: "flex", flexDirection: "column", width: "min(520px, 100%)", maxHeight: "min(640px, 90vh)", borderRadius: 14, background: "#fff", color: "#182230", boxShadow: "0 16px 48px #17203333", font: "14px/1.5 system-ui, sans-serif", textAlign: "left" }}>
            <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "18px 22px 12px", borderBottom: "1px solid #eaecf0" }}>
              <h2 id="dfWhatsNewTitle" style={{ margin: 0, fontSize: 18 }}>{"What's new"}</h2>
              <button type="button" aria-label="Close" onClick={() => setOpen(false)} style={{ width: 30, height: 30, border: 0, borderRadius: 7, background: "#f2f4f7", color: "#475467", fontSize: 18, lineHeight: 1, cursor: "pointer" }}>
                {"×"}
              </button>
            </header>
            <div style={{ overflowY: "auto", padding: "6px 22px 20px" }}>
              {RELEASES.map((release, i) => (
                <article key={release.version} style={{ paddingTop: 14 }}>
                  <h3 style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "0 0 6px", fontSize: 15 }}>
                    {`v${release.version}`}
                    {i === 0 ? <span style={{ padding: "1px 7px", borderRadius: 10, background: "#e8eefc", color: "#2f55c9", fontSize: 11, fontWeight: 650 }}>{"Current"}</span> : null}
                    <small style={{ marginLeft: "auto", color: "#98a2b3", fontSize: 12, fontWeight: 500 }}>{release.date}</small>
                  </h3>
                  <ul style={{ margin: 0, paddingLeft: 18, color: "#475467" }}>
                    {release.changes.map((change, j) => (
                      <li key={j} style={{ margin: "3px 0" }}>{change}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
