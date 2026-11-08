/**
 * Routes: /merchant/<page> (slugs of the menu names); ?parcel= opens the parcel drawer anywhere. Old links
 * (?page=<classic slug>, from notifications and bookmarks) are translated. Each page loads on demand.
 * An account that isn't active sees only "Account verification" (shared/merchant-verification.js).
 */
import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { useAuth } from "@panel/lib/auth";
import { DialogHost } from "@panel/ui/dialogs";
import { Toasts } from "@panel/ui/toast";
import { Loading } from "@panel/ui/kit";
import Login from "@panel/ui/Login";
import { MERCHANT_ROLES, MerchantProvider, useMerchant } from "@/lib/merchant";
import Shell from "./Shell";
import { labelOf, legacyPath, pageBySlug } from "./nav";
import { Classic } from "./Classic";
import ParcelDrawer from "@/features/parcels/ParcelDrawer";

const Verification = lazy(() => import("@/pages/Verification"));
const Overview = lazy(() => import("@/pages/Overview"));
const Pickups = lazy(() => import("@/pages/Pickups"));
const Recipients = lazy(() => import("@/pages/Recipients"));
const Products = lazy(() => import("@/pages/Products"));
const Balance = lazy(() => import("@/pages/Balance"));
const Reports = lazy(() => import("@/pages/Reports"));
const ApiWebhooks = lazy(() => import("@/pages/ApiWebhooks"));
const Settings = lazy(() => import("@/pages/Settings"));
const Support = lazy(() => import("@panel/pages/Support"));
const Notifications = lazy(() => import("@/pages/Notifications"));
const Services = lazy(() => import("@/pages/Services"));
const NewRequests = lazy(() => import("@/pages/Requests").then(m => ({ default: m.NewRequests })));
const AllRequests = lazy(() => import("@/pages/Requests").then(m => ({ default: m.AllRequests })));

export default function App() {
  const { state, user, hasRole } = useAuth();
  if (state.status === "loading") return <Centered spinner />;
  if (state.status === "offline") return <Offline />;
  if (state.status === "signed-out") return <Login product="Merchant panel" heading="Sign in to your merchant account" />;
  if (!hasRole(...MERCHANT_ROLES)) return <Login product="Merchant panel" heading="Sign in to your merchant account" notAllowed={`${user?.name}, your account isn't a merchant account. Sign in with your business account.`} />;
  return (
    <MerchantProvider
      fallback={s =>
        s.status === "loading" ? (
          <Centered spinner />
        ) : s.status === "none" ? (
          <Centered title="No merchant workspace" text="This account isn't a member of a merchant workspace." />
        ) : (
          <Centered title="Couldn't open your workspace" text={s.message} />
        )
      }
    >
      <Panel />
      <ParcelDrawer />
      <DialogHost />
      <Toasts />
    </MerchantProvider>
  );
}

function Panel() {
  const m = useMerchant();
  if (m.locked)
    return (
      <Suspense fallback={<Centered spinner />}>
        <Verification />
      </Suspense>
    );
  return <Router />;
}

function Centered({ spinner, title, text }: { spinner?: boolean; title?: string; text?: string }) {
  return (
    <div className="center-page">
      {spinner ? (
        <div className="spinner" role="status" aria-label="Loading" />
      ) : (
        <div className="auth-card">
          <h1>{title}</h1>
          <p>{text}</p>
          <a className="button" href="/">
            Back to the website
          </a>
        </div>
      )}
    </div>
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
  const m = useMerchant();
  const location = useLocation();
  const navigate = useNavigate();
  // Old links: ?page=<classic slug>[&parcel=…][&ticket=…].
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const page = params.get("page");
    if (!page) return;
    const path = legacyPath(page, m.doc);
    params.delete("page");
    params.delete("tab");
    params.delete("period");
    navigate({ pathname: path ?? location.pathname, search: params.toString() ? `?${params}` : "" }, { replace: true });
  }, [location.search, location.pathname, navigate, m.doc]);

  const first = location.pathname.split("/")[1];
  const crumb = first === "notifications" ? "Notifications" : (pageBySlug(first) ? labelOf(pageBySlug(first)!, m.doc) : "");
  return (
    <Shell crumb={crumb}>
      <Suspense fallback={<Loading rows={6} />}>
        <Routes>
          <Route path="/" element={<Navigate to={{ pathname: "/overview", search: location.search }} replace />} />
          <Route path="/:page" element={<PageRoute />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}

function PageRoute() {
  const { page: slug } = useParams();
  if (slug === "notifications") return <Notifications />;
  const page = pageBySlug(slug);
  if (!page) return <Navigate to="/overview" replace />;
  switch (page.id) {
    case "Overview":
      return <Overview />;
    case "Pickup requests":
      return <Pickups />;
    case "Recipients & branches":
      return <Recipients />;
    case "Product catalogue":
      return <Products />;
    case "Balance":
      return <Balance />;
    case "Reports":
      return <Reports />;
    case "API & Webhooks":
      return <ApiWebhooks />;
    case "Settings":
      return <Settings />;
    case "Support":
      return <Support inbox={false} />;
    case "Services & pricing":
      return <Services />;
    case "New requests":
      return <NewRequests />;
    case "All requests":
      return <AllRequests />;
    default:
      return <Classic id={page.id} />;
  }
}
