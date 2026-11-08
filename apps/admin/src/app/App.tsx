/**
 * Routes: /admin/<page> (the classic ?page= slugs); old links (?page=…&tab=…) are translated. Each page loads on
 * demand. Only super admins may open the panel (PANEL_ROLES["super-admin"]).
 */
import { lazy, Suspense, useEffect, type ComponentType, type LazyExoticComponent } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { useAuth } from "@panel/lib/auth";
import { DialogHost } from "@panel/ui/dialogs";
import { Toasts } from "@panel/ui/toast";
import { Loading } from "@panel/ui/kit";
import Login from "@panel/ui/Login";
import Shell from "./Shell";
import { legacyPath, pageBySlug } from "./nav";
import { Classic } from "./Classic";

const Notifications = lazy(() => import("@/pages/Notifications"));
/** The pages rebuilt so far, by menu id; the others open in the classic panel. */
const PAGES: Record<string, LazyExoticComponent<ComponentType<{ tab?: string }>>> = {
  Overview: lazy(() => import("@/pages/Overview")),
  Registrations: lazy(() => import("@/pages/Registrations")),
  Approvals: lazy(() => import("@/pages/Registrations")),
  "E-commerce merchants": lazy(() => import("@/pages/Merchants").then(m => ({ default: m.EcommerceMerchants }))),
  "Banking & Financial merchants": lazy(() => import("@/pages/Merchants").then(m => ({ default: m.BankingMerchants }))),
  Franchises: lazy(() => import("@/pages/Franchises")),
  "Service plans": lazy(() => import("@/pages/ServicePlans")),
  "Rider plans": lazy(() => import("@/pages/RiderPlans")),
  "Audit log": lazy(() => import("@/pages/AuditLog")),
  "Platform activity": lazy(() => import("@/pages/PlatformActivity")),
  "Admin users": lazy(() => import("@/pages/AdminUsers")),
  "Parcel notifications": lazy(() => import("@/pages/NotificationMessages").then(m => ({ default: m.ParcelNotifications }))),
  "Platform settings": lazy(() => import("@/pages/NotificationMessages").then(m => ({ default: m.GlobalNotifications }))),
  "Channels & limits": lazy(() => import("@/pages/ChannelsLimits")),
  "Recent messages": lazy(() => import("@/pages/RecentMessages")),
  "Push notifications": lazy(() => import("@/pages/Integrations").then(m => ({ default: m.PushNotifications }))),
  "Integration settings": lazy(() => import("@/pages/Integrations")),
  "Website settings": lazy(() => import("@/pages/WebsiteSettings")),
  "Return reasons": lazy(() => import("@/pages/CatalogList").then(m => ({ default: m.ReturnReasons }))),
  "Receiver relations": lazy(() => import("@/pages/CatalogList").then(m => ({ default: m.ReceiverRelations }))),
  Products: lazy(() => import("@/pages/Products")),
  "Invoice settings": lazy(() => import("@/pages/InvoiceSettings")),
  Address: lazy(() => import("@/pages/Address")),
  "Hubs & zones": lazy(() => import("@/pages/HubsZones")),
  "Import settings": lazy(() => import("@/pages/ImportSettings")),
  "System guide": lazy(() => import("@/pages/SystemGuide")),
};

export default function App() {
  const { state, user, hasRole } = useAuth();
  if (state.status === "loading") return <Centered spinner />;
  if (state.status === "offline") return <Offline />;
  if (state.status === "signed-out") return <Login product="Super admin" heading="Sign in to Super admin" />;
  if (!hasRole("SUPER_ADMIN")) return <Login product="Super admin" heading="Sign in to Super admin" notAllowed={`${user?.name}, your account isn't a super admin account. Sign in with a super admin account.`} />;
  return (
    <>
      <Router />
      <DialogHost />
      <Toasts />
    </>
  );
}

function Centered({ spinner }: { spinner?: boolean }) {
  return <div className="center-page">{spinner ? <div className="spinner" role="status" aria-label="Loading" /> : null}</div>;
}

function Offline() {
  const { retry } = useAuth();
  return (
    <div className="center-page">
      <div className="auth-card">
        <h1>Can't reach Delivery Fast</h1>
        <p>Check the internet connection, then try again.</p>
        <button className="button primary" onClick={retry}>
          Try again
        </button>
      </div>
    </div>
  );
}

function Router() {
  const location = useLocation();
  const navigate = useNavigate();
  // Old links: ?page=<classic page>[&tab=…].
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const page = params.get("page");
    if (!page) return;
    const path = legacyPath(page);
    params.delete("page");
    params.delete("period");
    navigate({ pathname: path ?? location.pathname, search: params.toString() ? `?${params}` : "" }, { replace: true });
  }, [location.search, location.pathname, navigate]);
  const first = location.pathname.split("/")[1];
  const page = pageBySlug(first);
  const crumb = first === "notifications" ? "Notifications" : page?.id === "Overview" ? "Overview" : page?.id === "Registrations" || page?.id === "Approvals" ? "Merchant approvals" : (page?.label ?? "");
  return (
    <Shell crumb={crumb}>
      <Suspense fallback={<Loading rows={6} />}>
        <Routes>
          <Route path="/" element={<Navigate to={{ pathname: "/overview", search: location.search }} replace />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/:page" element={<PageRoute />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}

function PageRoute() {
  const { page: slug } = useParams();
  const page = pageBySlug(slug);
  if (!page) return <Navigate to="/overview" replace />;
  const Page = PAGES[page.id];
  const tab = new URLSearchParams(location.search).get("tab") || undefined;
  return Page ? <Page key={page.id} tab={tab} /> : <Classic id={page.id} />;
}
