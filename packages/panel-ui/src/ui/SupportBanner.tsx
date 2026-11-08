/**
 * The bar across the page while support access is on (legacy/shared/api.js supportBanner): "Viewing as <name>
 * (read-only) · ends in 12 min", who opened it, and End. When it ends (End, the time running out, or ended by an
 * administrator elsewhere) the page is covered and the tab closes.
 */
import { useEffect, useState } from "react";
import { supportAccess, type SessionUser } from "../lib/api";

export function SupportBanner({ user, ended, onEnd }: { user: SessionUser | null; ended: string | null; onEnd: () => void }) {
  const info = supportAccess();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (ended) setTimeout(() => window.close(), 800);
  }, [ended]);
  // Room under the page for the bar, so it never hides the last rows.
  useEffect(() => {
    document.body.style.paddingBottom = "64px";
    return () => void (document.body.style.paddingBottom = "");
  }, []);
  const imp = user?.impersonation || {};
  const full = imp.readOnly === false;
  const minutes = info ? Math.max(1, Math.ceil((info.expiresAt - Date.now()) / 60000)) : 0;
  const style: React.CSSProperties = {
    position: "fixed",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 2147483000,
    display: "flex",
    gap: 12,
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
    padding: "10px 16px",
    background: "#7c2d12",
    color: "#fff",
    font: "600 13px/1.4 system-ui, sans-serif",
    boxShadow: "0 -2px 12px rgba(0,0,0,.25)",
    ...(ended ? { top: 0, flexDirection: "column", fontSize: 16 } : {}),
  };
  if (ended)
    return (
      <div role="status" style={style}>
        <span>{ended}</span>
        <small style={{ fontWeight: 400, opacity: 0.85 }}>You can close this tab.</small>
      </div>
    );
  if (!info || !user) return null;
  return (
    <div role="status" style={style}>
      <span>{`Viewing as ${user.name} (${full ? "full access" : "read-only"}) · ends in ${minutes} min`}</span>
      <small style={{ fontWeight: 400, opacity: 0.85 }}>{`Opened by ${imp.adminName || "an administrator"} · every action is recorded${full ? "" : " · changes are blocked"}`}</small>
      <button type="button" title="End this session and close the tab" onClick={onEnd} style={{ border: "1px solid #fff", background: "transparent", color: "#fff", borderRadius: 6, padding: "4px 12px", font: "inherit", cursor: "pointer" }}>
        End
      </button>
    </div>
  );
}
