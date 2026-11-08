/**
 * Routes: /ops/<view>/<tab> (slugs of the menu names), ?parcel= opens the drawer anywhere. Old links
 * (?page=…&tab=… from notifications and bookmarks) are translated. Each view is loaded on demand.
 */
import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { useAuth, OPS_ROLES } from "@/lib/auth";
import { OpsProvider, useOps } from "@/lib/ops";
import { DialogHost } from "@/ui/dialogs";
import { Toasts } from "@/ui/toast";
import { Loading } from "@/ui/kit";
import Login from "./Login";
import Shell from "./Shell";
import { allowedViews, legacyPath, pathFor, tabBySlug, viewBySlug, type ViewDef } from "./nav";
import { Classic } from "./Classic";
import ParcelDrawer from "@/features/parcels/ParcelDrawer";

const Today = lazy(() => import("@/pages/Today"));
const Dispatch = lazy(() => import("@/pages/Dispatch"));
const Parcels = lazy(() => import("@/pages/ParcelPages").then(m => ({ default: m.ParcelRoutes })));
const StagePages = lazy(() => import("@/pages/StagePages"));
const ScanDesk = lazy(() => import("@/pages/ScanDesk"));
const WorkQueue = lazy(() => import("@/pages/WorkQueue"));
const Transfers = lazy(() => import("@/pages/Transfers"));
const Returns = lazy(() => import("@/pages/Returns"));
const Accounts = lazy(() => import("@/pages/Accounts"));
const Reports = lazy(() => import("@/pages/Reports"));
const Riders = lazy(() => import("@/pages/Riders"));
const Merchants = lazy(() => import("@/pages/Merchants"));
const CnStock = lazy(() => import("@/pages/CnStock"));
const Settings = lazy(() => import("@/pages/Settings"));
const Support = lazy(() => import("@/pages/Support"));
const Notifications = lazy(() => import("@/pages/Notifications"));
const ScheduledPickups = lazy(() => import("@/pages/Returns").then(m => ({ default: m.ScheduledPickups })));

export default function App() {
  const { state, user, hasRole } = useAuth();
  if (state.status === "loading")
    return (
      <div className="center-page">
        <div className="spinner" role="status" aria-label="Loading" />
      </div>
    );
  if (state.status === "offline") return <Offline />;
  if (state.status === "signed-out") return <Login />;
  if (!hasRole(...OPS_ROLES)) return <Login notAllowed={`${user?.name}, your account isn't an operations account. Sign in with a staff account.`} />;
  return (
    <OpsProvider>
      <Router />
      <ParcelDrawer />
      <DialogHost />
      <Toasts />
    </OpsProvider>
  );
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
  // Old links: ?page=<name>[&tab=…][&parcel=…].
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const page = params.get("page");
    if (!page) return;
    const path = legacyPath(page, params.get("tab"));
    params.delete("page");
    params.delete("tab");
    if (path) navigate({ pathname: path, search: params.toString() ? `?${params}` : "" }, { replace: true });
  }, [location.search, navigate]);

  // One frame (menu, top bar) for every page: it stays mounted, so the menu keeps its scroll position.
  const first = location.pathname.split("/")[1];
  const crumb = first === "notifications" ? "Notifications" : first === "support" ? "Support tickets" : viewBySlug(first)?.label ?? "";
  return (
    <Shell crumb={crumb}>
      <Suspense fallback={<Loading rows={6} />}>
        <Routes>
          <Route path="/" element={<Navigate to={{ pathname: "/today", search: location.search }} replace />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/support" element={<Support />} />
          <Route path="/:view/:tab?" element={<ViewRoute />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}

function ViewRoute() {
  const { view: viewSlug, tab: tabSlug } = useParams();
  const ops = useOps();
  const view = viewBySlug(viewSlug);
  if (!view) return <Navigate to="/today" replace />;
  const allowed = allowedViews(ops.menu);
  // Before the overview arrives the menu can't tell; once it does, a hidden view sends people to their first one.
  if (ops.me && !allowed.has(view.id)) return <Navigate to={pathFor([...allowed][0] || "Today")} replace />;
  const visibleTabs = view.tabs.filter(t => !t.show || t.show(ops.menu));
  const tab = tabBySlug(view, tabSlug) ?? visibleTabs[0] ?? view.tabs[0];
  return <View view={view} tab={tab.id} />;
}

function View({ view, tab }: { view: ViewDef; tab: string }) {
  switch (view.id) {
    case "Today":
      return <Today />;
    case "New orders":
    case "All parcels":
    case "Problems":
      return <Parcels view={view.id} tab={tab} />;
    case "Pickup":
      return tab === "Scheduled pickups" ? <ScheduledPickups tab={tab} /> : <Dispatch mode="pickup" tab={tab} />;
    case "Delivery":
      return <Dispatch mode="delivery" />;
    case "Scan desk":
      return <ScanDesk tab={tab} />;
    case "Work queue":
      return <WorkQueue />;
    case "Hub desk":
      return <StagePages view={view} tab={tab} />;
    case "Transfers":
      return <Transfers tab={tab} />;
    case "Returns":
      return <Returns />;
    case "Accounts":
      return <Accounts tab={tab} />;
    case "Reports":
      return <Reports tab={tab} />;
    case "Riders":
      return <Riders tab={tab} />;
    case "Merchants":
      return <Merchants />;
    case "CN stock":
      return <CnStock />;
    case "Settings":
      return <Settings />;
    default:
      return <Classic view={view} tab={tab} page={view.id} />;
  }
}
