import { MOBILE_APPS, type MobileApp } from "@/shared/mobileApps";

const APPS: { app: MobileApp; name: string; who: string }[] = [
  { app: "merchant", name: "Merchant app", who: "For merchants: book parcels, track them, and see COD and payments." },
  { app: "rider", name: "Rider app", who: "For riders: pickups, deliveries, delivery proof and cash." },
  { app: "operations", name: "Operations app", who: "For hub and operations staff: receive, scan, dispatch and deliver." },
];

/** /apps: anyone with the link can download the three Android apps (APKs in public/downloads). */
export default function Page() {
  return (
    <main className="ap">
      <style>{CSS}</style>
      <header className="ap-head">
        <strong>{"Paira Express"}</strong>
        <span>{"Android apps"}</span>
      </header>
      {APPS.map(({ app, name, who }) => {
        const a = MOBILE_APPS[app];
        return (
          <section className="ap-card" key={app}>
            <span className="ap-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <rect x="6" y="2" width="12" height="20" rx="2.5" />
                <path d="M10 18h4" />
              </svg>
            </span>
            <div className="ap-text">
              <h2>{name}</h2>
              <p>{who}</p>
              <small>{`Android · v${a.version} · ${a.sizeMb} MB`}</small>
            </div>
            <a className="ap-btn" href={a.href} download={a.fileName}>
              {"Download"}
            </a>
          </section>
        );
      })}
      <p className="ap-note">{"On the phone, open the downloaded file to install it. If Android asks, allow installing apps from this browser."}</p>
    </main>
  );
}

const CSS = `
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f4f6fa;color:#1d2939}
.ap{max-width:640px;margin:0 auto;padding:16px 16px 40px;display:grid;gap:12px}
.ap-head{display:grid;gap:2px;background:#2f62e3;color:#fff;border-radius:12px;padding:14px 16px}.ap-head strong{font-size:18px}.ap-head span{font-size:14px;opacity:.9}
.ap-card{display:flex;align-items:center;gap:14px;background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:16px}
.ap-icon{display:grid;place-items:center;flex:none;width:44px;height:44px;border-radius:11px;background:#2f55c9;color:#fff}
.ap-text{flex:1;min-width:0}.ap-text h2{margin:0 0 4px;font-size:16px}.ap-text p{margin:0 0 4px;color:#475467;font-size:14px;line-height:1.45}.ap-text small{color:#667085;font-size:12.5px}
.ap-btn{flex:none;padding:10px 16px;border-radius:10px;background:#12a150;color:#fff;font-weight:600;text-decoration:none}
.ap-note{margin:4px 2px 0;color:#667085;font-size:13px;line-height:1.5}
@media (max-width:480px){.ap-card{flex-wrap:wrap}.ap-btn{width:100%;text-align:center}}
`;
