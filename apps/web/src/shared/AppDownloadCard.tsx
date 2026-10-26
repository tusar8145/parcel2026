import { MOBILE_APPS, type MobileApp } from "@/shared/mobileApps";

/** Panels' sidebar: download the Android app (APK) for merchants or riders. */
export default function AppDownloadCard({ app }: { app: MobileApp }) {
  const a = MOBILE_APPS[app];
  return (
    <a
      className="app-card"
      href={a.href}
      download={a.fileName}
      style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 2px 10px", padding: "11px 12px", border: "1px solid #e1e7fb", borderRadius: 10, background: "#fff", color: "inherit", textDecoration: "none" }}
    >
      <span aria-hidden="true" style={{ display: "grid", placeItems: "center", flex: "none", width: 34, height: 34, borderRadius: 9, background: "#2f55c9", color: "#fff" }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <rect x="6" y="2" width="12" height="20" rx="2.5" />
          <path d="M12 7v7m-3-3 3 3 3-3M10 18h4" />
        </svg>
      </span>
      <span style={{ minWidth: 0 }}>
        <strong style={{ display: "block", fontSize: 13 }}>{app === "rider" ? "Get the rider app" : "Get the Android app"}</strong>
        <small style={{ color: "#667085", fontSize: 12 }}>{`APK · v${a.version} · ${a.sizeMb} MB`}</small>
      </span>
    </a>
  );
}
