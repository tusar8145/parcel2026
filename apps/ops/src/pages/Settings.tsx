/**
 * Settings (bridge-pages.js settingsCards, bridge-guide.js): where each setting really lives. Two-step verification
 * is the one personal setting here; the system guide opens in a dialog; platform settings link to super admin.
 */
import { useNavigate } from "react-router";
import { useAuth } from "@panel/lib/auth";
import { useOps } from "@/lib/ops";
import { Button, PageHeading, Panel } from "@panel/ui/kit";
import { allowedViews, pathFor } from "@/app/nav";
import { useCatalog } from "@/features/parcels/search";
import { manageMfa } from "@/features/account/Mfa";
import { openSystemGuide } from "@/features/account/SystemGuide";

export default function Settings() {
  const ops = useOps();
  const { hasRole } = useAuth();
  const navigate = useNavigate();
  const catalog = useCatalog();
  const superAdmin = hasRole("SUPER_ADMIN");
  const allowed = allowedViews(ops.menu);
  const zones = catalog ? Object.values(catalog.zonesByDistrict).flat().length : null;
  const hubs = ops.hubs.filter(h => h.active !== false).length;
  const admin = (page: string, label: string) =>
    superAdmin ? (
      <a className="button sm" href={`/admin?page=${encodeURIComponent(page)}`}>
        {label}
      </a>
    ) : (
      <span className="faint" style={{ fontSize: 12.5 }}>
        Managed by super admins
      </span>
    );
  const cards: [string, string, React.ReactNode, boolean?][] = [
    [
      "System guide",
      "Numbers (PP, MR, HS, ST…), the parcel lifecycle and its SMS / email / push, money steps and roles.",
      <Button size="sm" variant="primary" onClick={() => void openSystemGuide()}>
        Open the guide
      </Button>,
      true,
    ],
    [
      "Two-step verification",
      "Protect your own sign-in with an authenticator app code.",
      <Button size="sm" variant="primary" onClick={() => void manageMfa()}>
        Two-step verification
      </Button>,
    ],
    ["Hubs & zones", `${hubs} active hubs${zones ? ` · ${zones} catalog zones` : ""}. Hub register, which hub serves each delivery zone, and routes.`, admin("Hubs & zones", "Open in super admin")],
    [
      "SLA policies",
      "Pickup and delivery due times per service level and route.",
      allowed.has("Reports") ? (
        <Button size="sm" onClick={() => navigate(pathFor("Reports", "Analytics & SLA"))}>
          Open SLA policies
        </Button>
      ) : null,
    ],
    ["Service plans & pricing", "Service packages, district prices, COD fee and booking rules.", admin("Service plans", "Open in super admin")],
    ["Notifications", "SMS and email texts, switches and gateways.", admin("Platform settings", "Open in super admin")],
    ["Roles & access", "Staff accounts, roles and permissions.", admin("Admin users", "Open in super admin")],
  ];
  return (
    <>
      <PageHeading eyebrow="Network operations" title="Settings" subtitle="Network settings live where they are used; platform settings are in the super admin console." />
      <Panel title="Where to change things" subtitle="Network settings live where they are used; platform settings are in the super admin console.">
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", padding: 16 }}>
          {cards.map(([title, text, action, highlight]) => (
            <article
              key={title}
              style={{
                display: "grid",
                gap: 8,
                alignContent: "start",
                padding: 14,
                border: `1px solid ${highlight ? "#b2c5f5" : "var(--line)"}`,
                borderRadius: 10,
                background: highlight ? "#f5f8ff" : "var(--surface)",
              }}
            >
              <strong style={{ fontSize: 14 }}>{title}</strong>
              <span className="muted" style={{ fontSize: 13 }}>
                {text}
              </span>
              <div>{action}</div>
            </article>
          ))}
        </div>
      </Panel>
    </>
  );
}
