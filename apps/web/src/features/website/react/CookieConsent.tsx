"use client";

import { useEffect, useState } from "react";

/**
 * Cookie consent. Essential storage (sign-in cookie, security) is always on; analytics
 * (anonymous page views, POST /analytics/pageview) only after the visitor agrees.
 * The choice is kept in this browser for 12 months.
 */
export const CONSENT_KEY = "deliveryfast-cookie-consent";
const MAX_AGE_MS = 365 * 86_400_000;

type Consent = { analytics: boolean; at: string };

export function readConsent(): Consent | null {
  try {
    const value = JSON.parse(localStorage.getItem(CONSENT_KEY) || "null") as Consent | null;
    if (!value || typeof value.analytics !== "boolean" || Date.now() - Date.parse(value.at) > MAX_AGE_MS) return null;
    return value;
  } catch {
    return null;
  }
}

let lastSent = "";
/** Anonymous page view (path + referrer), only with consent; failures are ignored. */
function pageView() {
  if (!readConsent()?.analytics) return;
  const path = location.pathname;
  if (path === lastSent) return;
  // Only the first view of this page load can come from another site; later in-app route
  // changes are internal (sent with this site as referrer, so they don't count as new visits).
  const referrer = lastSent ? location.origin : document.referrer ? new URL(document.referrer).origin : undefined;
  lastSent = path;
  // Tracking links carry private tokens; only the path is sent, never the query.
  void fetch("/api/v1/analytics/pageview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, referrer }),
    keepalive: true,
  }).catch(() => undefined);
}

/** This tab's random id for "visitors online now" (sessionStorage: gone when the tab closes). */
function tabId() {
  try {
    let id = sessionStorage.getItem("df-tab-id");
    if (!id) sessionStorage.setItem("df-tab-id", (id = `t${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`));
    return id;
  } catch {
    return null;
  }
}

/** "Still here" every 30 s while the tab is visible, only with consent (Platform activity › Live now). */
function ping() {
  if (document.visibilityState !== "visible" || !readConsent()?.analytics) return;
  const sid = tabId();
  if (!sid) return;
  void fetch("/api/v1/analytics/ping", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sid, path: location.pathname }),
    keepalive: true,
  }).catch(() => undefined);
}

export default function CookieConsent() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(!readConsent());
    pageView();
    const onRoute = () => pageView();
    const reopen = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.("[data-cookie-settings]")) {
        e.preventDefault();
        setOpen(true);
      }
    };
    const onVisible = () => ping();
    ping();
    const heartbeat = setInterval(ping, 30_000);
    window.addEventListener("df:route", onRoute);
    window.addEventListener("df:route", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("click", reopen);
    return () => {
      clearInterval(heartbeat);
      window.removeEventListener("df:route", onRoute);
      window.removeEventListener("df:route", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("click", reopen);
    };
  }, []);

  const choose = (analytics: boolean) => {
    try {
      localStorage.setItem(CONSENT_KEY, JSON.stringify({ analytics, at: new Date().toISOString() }));
    } catch {}
    setOpen(false);
    if (analytics) {
      pageView();
      ping();
    }
  };

  if (!open) return null;
  return (
    <div
      className="df-cookie-consent"
      role="dialog"
      aria-live="polite"
      aria-label="Cookie preferences"
      style={{
        position: "fixed",
        zIndex: 60,
        left: 16,
        right: 16,
        bottom: 16,
        maxWidth: 720,
        margin: "0 auto",
        padding: "16px 18px",
        display: "flex",
        gap: 14,
        alignItems: "center",
        flexWrap: "wrap",
        background: "#fff",
        border: "1px solid #dfe8e2",
        borderRadius: 14,
        boxShadow: "0 18px 40px #0f2b2022",
        fontSize: 14,
        color: "var(--ink, #12221d)",
      }}
    >
      <p style={{ flex: "1 1 320px", margin: 0 }}>
        {"We use essential cookies to keep you signed in and secure. With your permission we also count anonymous page views to improve the site. "}
        <a href="/privacy#cookies" style={{ color: "var(--green, #087e67)", fontWeight: 700 }}>
          Privacy Policy
        </a>
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="button button-quiet" type="button" data-cookie-choice="essential" onClick={() => choose(false)}>
          Essential only
        </button>
        <button className="button button-primary" type="button" data-cookie-choice="all" onClick={() => choose(true)}>
          Accept analytics
        </button>
      </div>
    </div>
  );
}
