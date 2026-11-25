"use client";

/**
 * The website's header (new design): a dark top bar (contact, "Track your package", log in) and the main bar (logo,
 * menu with a Help drop-down, merchant buttons). The page scripts (public/legacy/website/01.js) rely on
 * #navLinks, #menuButton and `.nav-actions` holding [data-open="login"] / [data-open="request"]: kept here.
 */
import { useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { usePathname } from "next/navigation";
import BrandMark from "../components/BrandMark";

/** The menu item each page belongs to. */
const PAGES: [RegExp, string][] = [
  [/^\/services/, "services"],
  [/^\/pricing/, "pricing"],
  [/^\/(partners|merchant|become-a-rider|become-a-franchise)/, "partners"],
  [/^\/(help|track|support|privacy|terms)/, "help"],
  [/^\/about/, "about"],
  [/^\/$/, "home"],
];
const menuItem = (path: string) => PAGES.find(([re]) => re.test(path))?.[1] ?? "";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const Chevron = () => (
  <svg className="chev" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="m6 8 4 4 4-4" />
  </svg>
);

/**
 * One session check at a time: the refresh token is rotated on every refresh, so two at once would race (React runs
 * effects twice in development; Merchant Dashboard can ask while the header is asking).
 */
let refreshing: Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> | null = null;
function refreshOnce() {
  refreshing ??= fetch("/api/v1/auth/refresh", { method: "POST", credentials: "same-origin", headers: { "x-df-client": "web" } })
    .then(async r => {
      const body: unknown = r.ok ? await r.json().catch(() => null) : null;
      return { ok: r.ok, status: r.status, json: async () => body };
    })
    .finally(() => setTimeout(() => (refreshing = null), 1000));
  return refreshing;
}

export default function Header({ legacy = false, logo }: { legacy?: boolean; logo?: { url: string; alt: string } | null }) {
  // The selected menu item, drawn by the server (no late highlight); the effect below moves it afterwards.
  const pathname = usePathname();
  const [first] = useState(() => menuItem(pathname));
  const current = (key: string) => (key === first ? ("page" as const) : undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  const [customer, setCustomer] = useState(false);
  /** Signed in at all (any role): known on the home page from the session check below; undefined until then. */
  const [signedIn, setSignedIn] = useState<boolean | undefined>(undefined);
  const [code, setCode] = useState("");
  const closeMenu = () => {
    if (!legacy) setMenuOpen(false);
  };

  // Signed in as a customer: "My account" instead of "Log in" (the page scripts do this on the other pages).
  useEffect(() => {
    if (legacy) return;
    let active = true;
    (async () => {
      try {
        const response = await refreshOnce();
        if (response.status === 401) {
          if (active) setSignedIn(false);
          return;
        }
        if (!response.ok) return;
        const result: unknown = await response.json();
        if (!isRecord(result) || !isRecord(result.user) || !Array.isArray(result.user.roles)) return;
        const panel = result.user.panel;
        if (active) {
          setSignedIn(true);
          setCustomer(result.user.roles.includes("CUSTOMER") && (!panel || panel === "/account"));
        }
      } catch {
        /* stays "Log in" */
      }
    })();
    return () => {
      active = false;
    };
  }, [legacy]);

  /**
   * Merchant Dashboard: signed out → the log-in page (after signing in it opens the person's own panel); signed in →
   * the merchant panel. On the other pages the page scripts hold the session (DF.auth.user); asked here if unknown.
   */
  const openDashboard = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const df = (window as unknown as { DF?: { auth?: { user?: unknown } } }).DF;
    let known: boolean | undefined = df?.auth && document.documentElement.classList.contains("legacy-ready") ? !!df.auth.user : signedIn;
    if (known === undefined) {
      try {
        known = (await refreshOnce()).ok;
      } catch {
        known = false;
      }
    }
    window.location.assign(known ? "/merchant/" : "/login");
  };

  // The menu item of the page you are on is selected (aria-current); every item has its own page. The page scripts
  // change pages without a reload, so their history changes are followed too.
  useEffect(() => {
    const nav = document.getElementById("navLinks");
    if (!nav) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const key = menuItem(location.pathname);
        nav.querySelectorAll<HTMLElement>("[data-nav]").forEach(a => (a.dataset.nav === key ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
      });
    };
    const later = () => setTimeout(update, 60);
    const { pushState, replaceState } = history;
    history.pushState = function (...args) {
      pushState.apply(this, args);
      later();
    };
    history.replaceState = function (...args) {
      replaceState.apply(this, args);
      later();
    };
    update();
    window.addEventListener("popstate", later);
    window.addEventListener("hashchange", later);
    document.addEventListener("click", later);
    return () => {
      history.pushState = pushState;
      history.replaceState = replaceState;
      window.removeEventListener("popstate", later);
      window.removeEventListener("hashchange", later);
      document.removeEventListener("click", later);
      cancelAnimationFrame(frame);
    };
  }, []);

  const track = (event: FormEvent) => {
    event.preventDefault();
    const value = code.trim().toUpperCase().replace(/\s+/g, "");
    if (value) window.location.assign(`/track/${encodeURIComponent(value)}`);
  };

  return (
    <header className="header v2-header">
      <div className="v2-topbar">
        <div className="shell v2-topbar-row">
          <div className="v2-contact">
            <a href="tel:+8801969921122">
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z" />
              </svg>
              <span>01969 921122</span>
            </a>
            <a href="mailto:info@deliveryfast.com.bd">
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm9 7.2L4.4 7H4v.6l8 5.4 8-5.4V7h-.4z" />
              </svg>
              <span>info@deliveryfast.com.bd</span>
            </a>
            <a className="v2-hide-md" href="https://www.google.com/maps/search/?api=1&query=House-6%20Road-2A%20Banani%2C%20Dhaka-1213" target="_blank" rel="noopener">
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2a7 7 0 0 1 7 7c0 5.2-7 13-7 13S5 14.2 5 9a7 7 0 0 1 7-7zm0 4.5A2.5 2.5 0 1 0 12 11.5 2.5 2.5 0 0 0 12 6.5z" />
              </svg>
              <span>House-6 Road -2A Banani, Dhaka-1213</span>
            </a>
          </div>
          <div className="v2-topbar-tools">
            <form className="v2-quick-track" onSubmit={track} role="search">
              <label htmlFor="v2Track">Track your package:</label>
              <input id="v2Track" value={code} onChange={e => setCode(e.target.value)} placeholder="PP-260914-1042" aria-label="Tracking number" />
              <button type="submit" aria-label="Track">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                  <circle cx="10.5" cy="10.5" r="6.5" />
                  <path d="m15.5 15.5 5 5" />
                </svg>
              </button>
            </form>
            <span className="v2-sep" aria-hidden="true" />
            {/* .nav-actions: the page scripts turn "Log in" into "My account" once a customer signs in. */}
            <div className="nav-actions v2-account">
              <a className="button button-quiet" href={customer ? "/account" : "/login"} data-open={customer ? undefined : "login"}>
                {customer ? "My account" : "Log in"}
              </a>
              <a className="v2-signup" href="/signup" data-route="signup">
                Sign up
              </a>
            </div>
          </div>
        </div>
      </div>
      <div className="shell nav">
        <a className="brand" href="/" aria-label="Delivery Fast home">
          <span className="brand-mark">
            <BrandMark logo={logo} />
          </span>
          <span className="brand-word">
            {"delivery "}
            <span>fast</span>
          </span>
        </a>
        <nav className={`nav-links${!legacy && menuOpen ? " open" : ""}`} id="navLinks" aria-label="Main navigation" onClick={closeMenu}>
          <a className="v2-home" href="/" data-nav="home" aria-current={current("home")}>
            Home
          </a>
          <a href="/services" data-nav="services" aria-current={current("services")}>
            Services
          </a>
          <a href="/pricing" data-route="pricing" data-nav="pricing" aria-current={current("pricing")}>
            Pricing
          </a>
          <a href="/partners" data-nav="partners" aria-current={current("partners")}>
            Partner with us
          </a>
          <div className="v2-drop">
            <a href="/help" data-nav="help" aria-current={current("help")}>
              Help <Chevron />
            </a>
            <div className="v2-drop-menu">
              <a href="/help">Help &amp; FAQs</a>
              <a href="/track" data-route="tracking">
                Track a parcel
              </a>
              <a href="/support" data-route="support">
                Customer support
              </a>
              <a href="/privacy">Privacy Policy</a>
              <a href="/terms">Terms of Service</a>
            </div>
          </div>
          <a href="/about" data-nav="about" aria-current={current("about")}>
            About us
          </a>
        </nav>
        <div className="v2-cta">
          <a className="button v2-outline" href="/login" title="Merchants sign in here (also customers, riders and staff)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M4 9h16l-1.5-5h-13zM5 9v11h14V9M9 20v-6h6v6" />
            </svg>
            Merchant Login
          </a>
          <a className="button button-primary v2-yellow" href="/merchant/" title="The merchant panel (log in first if you aren't signed in)" onClick={e => void openDashboard(e)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
            Merchant Dashboard
          </a>
          <button className="menu-button" id="menuButton" aria-label="Open navigation" aria-expanded={!legacy && menuOpen} onClick={legacy ? undefined : () => setMenuOpen(open => !open)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}
