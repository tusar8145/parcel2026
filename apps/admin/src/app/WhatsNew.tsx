/**
 * The menu's foot: the version (top of CHANGELOG.md, read at build time) and "What's new": every version's changes,
 * newest first, with a version list and a search.
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@panel/ui/Icon";

const RELEASES = typeof __APP_RELEASES__ === "undefined" ? [] : __APP_RELEASES__;

export default function WhatsNew() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return RELEASES.map(r => ({ ...r, changes: t ? r.changes.filter(c => c.toLowerCase().includes(t)) : r.changes })).filter(r => (!picked || r.version === picked) && (!t || r.changes.length || r.version.includes(t)));
  }, [q, picked]);
  if (!RELEASES.length) return null;
  const current = RELEASES[0];

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", gap: 8, padding: "0 4px", fontSize: 12, color: "var(--faint)" }}>
        <span>{`Delivery Fast v${current.version}`}</span>
        <button type="button" className="link-button" style={{ fontSize: 12 }} onClick={() => setOpen(true)}>
          {"What's new"}
        </button>
      </div>
      {open
        ? createPortal(
            <div role="presentation" onMouseDown={e => e.target === e.currentTarget && setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 1001, display: "grid", placeItems: "center", padding: 16, background: "rgba(16, 24, 40, 0.45)" }}>
              <section role="dialog" aria-modal="true" aria-labelledby="whatsNewTitle" style={{ display: "flex", flexDirection: "column", width: "min(880px, 100%)", height: "min(720px, 92vh)", borderRadius: 14, background: "var(--surface, #fff)", boxShadow: "0 24px 64px rgba(16, 24, 40, 0.28)", overflow: "hidden" }}>
                <header className="row" style={{ gap: 12, padding: "16px 20px", borderBottom: "1px solid var(--line)" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h2 id="whatsNewTitle" style={{ margin: 0, fontSize: 18 }}>{"What's new"}</h2>
                    <small className="faint">{`${RELEASES.length} versions · current v${current.version} (${current.date})`}</small>
                  </div>
                  <input className="input sm" type="search" placeholder="Search changes…" aria-label="Search changes" value={q} onChange={e => setQ(e.target.value)} style={{ width: 220 }} />
                  <button type="button" className="button ghost icon sm" aria-label="Close" onClick={() => setOpen(false)}>
                    <Icon name="x" />
                  </button>
                </header>
                <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "150px minmax(0, 1fr)" }}>
                  <nav aria-label="Versions" style={{ overflowY: "auto", borderRight: "1px solid var(--line)", padding: 8, display: "grid", alignContent: "start", gap: 2 }}>
                    <button type="button" className={`nav-item${picked === null ? " active" : ""}`} aria-current={picked === null ? "page" : undefined} onClick={() => setPicked(null)} style={{ minHeight: 30, padding: "5px 9px" }}>
                      All versions
                    </button>
                    {RELEASES.map(r => (
                      <button key={r.version} type="button" className="nav-item" aria-current={picked === r.version ? "page" : undefined} onClick={() => setPicked(r.version)} style={{ minHeight: 30, padding: "5px 9px", display: "flex", justifyContent: "space-between" }}>
                        <span>{`v${r.version}`}</span>
                        <small className="faint">{r.date.slice(5)}</small>
                      </button>
                    ))}
                  </nav>
                  <div style={{ overflowY: "auto", padding: "4px 22px 22px" }}>
                    {shown.map((r, i) => (
                      <article key={r.version} style={{ paddingTop: 16 }}>
                        <h3 className="row" style={{ gap: 8, margin: "0 0 6px", fontSize: 15 }}>
                          {`v${r.version}`}
                          {r.version === current.version ? <span className="pill good">Current</span> : null}
                          <small className="faint" style={{ marginLeft: "auto", fontWeight: 500 }}>{r.date}</small>
                        </h3>
                        <ul style={{ margin: 0, paddingLeft: 18, color: "var(--ink-2)", lineHeight: 1.5 }}>
                          {r.changes.map((c, j) => (
                            <li key={j} style={{ margin: "4px 0" }}>{c}</li>
                          ))}
                        </ul>
                        {i < shown.length - 1 ? <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "16px 0 0" }} /> : null}
                      </article>
                    ))}
                    {!shown.length ? <p className="faint" style={{ marginTop: 24 }}>No change matches the search.</p> : null}
                  </div>
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
