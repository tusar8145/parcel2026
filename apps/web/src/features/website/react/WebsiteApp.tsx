"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { df } from "./df";
import LoginView from "./LoginView";
import SignupView from "./SignupView";
import PartnerView from "./PartnerView";
import ProfileView, { VerifyEmailView } from "./ProfileView";
import AddressesView from "./AddressesView";
import BookingView from "./BookingView";
import TrackingView from "./TrackingView";
import CookieConsent from "./CookieConsent";

/**
 * Views of the website rendered by React. The page scripts' router (public/legacy/website/01.js)
 * still draws the frame (back link, heading, customer sidebar); for these routes it leaves
 * a `[data-react-view]` placeholder that React fills through a portal.
 */
const VIEWS: Record<string, (param?: string) => ReactNode> = {
  login: () => <LoginView />,
  signup: () => <SignupView />,
  merchant: () => <PartnerView kind="merchant" />,
  rider: () => <PartnerView kind="rider" />,
  franchise: () => <PartnerView kind="franchise" />,
  profile: () => <ProfileView />,
  addresses: () => <AddressesView />,
  request: () => <BookingView />,
  tracking: param => <TrackingView param={param} />,
  "verify-email": () => <VerifyEmailView />,
};

// Registered as soon as this module loads, before the page scripts render their first view.
if (typeof window !== "undefined") window.DFReact = { owns: route => route in VIEWS };

interface Mounted {
  el: Element;
  route: string;
  param?: string;
}

function routeTitle(legacy: string): string | undefined {
  try {
    const table = JSON.parse(document.getElementById("dfRoutes")?.textContent || "{}") as { routes?: { legacy: string; title: string }[] };
    return table.routes?.find(r => r.legacy === legacy)?.title;
  } catch {
    return undefined;
  }
}

export default function WebsiteApp() {
  const [mounted, setMounted] = useState<Mounted | null>(null);

  useEffect(() => {
    const find = () => {
      const el = document.querySelector("[data-react-view]");
      setMounted(current => {
        if (!el) return null;
        if (current?.el === el) return current;
        const [, param] = (window as unknown as { DF?: { route?: { path(): string } } }).DF?.route?.path().split("/") ?? [];
        return { el, route: (el as HTMLElement).dataset.reactView!, param: param ? decodeURIComponent(param) : undefined };
      });
    };
    const observer = new MutationObserver(find);
    observer.observe(document.body, { childList: true, subtree: true });
    find();
    // Opened directly on a React route (e.g. /login): the page scripts may have drawn their own
    // form before this module registered DFReact. Draw the route again so React takes it over.
    const w = window as unknown as { renderRoute?: () => void; DF?: { route?: { path(): string } } };
    const redraw = () => {
      const route = w.DF?.route?.path().split("/")[0] ?? "";
      if (route in VIEWS && !document.querySelector("[data-react-view]") && document.querySelector("#pageView, #routeForm")) w.renderRoute?.();
    };
    if (document.documentElement.classList.contains("legacy-ready")) redraw();
    else {
      const ready = new MutationObserver(() => {
        if (!document.documentElement.classList.contains("legacy-ready")) return;
        ready.disconnect();
        redraw();
      });
      ready.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    }
    return () => observer.disconnect();
  }, []);

  // Route-level touches the page scripts don't know about.
  useEffect(() => {
    const onRoute = () => {
      const path = df()?.route?.path() ?? "";
      if (path === "services") {
        const title = routeTitle("services");
        if (title) document.title = title;
        requestAnimationFrame(() => document.getElementById("services")?.scrollIntoView({ behavior: "smooth" }));
      }
    };
    window.addEventListener("df:route", onRoute);
    // First load: once the page scripts have rendered.
    const ready = new MutationObserver(() => {
      if (document.documentElement.classList.contains("legacy-ready")) {
        ready.disconnect();
        onRoute();
      }
    });
    ready.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      window.removeEventListener("df:route", onRoute);
      ready.disconnect();
    };
  }, []);

  // On server-only pages (privacy, terms) the home page's sections aren't here: in-page links go home.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!document.querySelector("main[data-static-page]")) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href^="#"]') as HTMLAnchorElement | null;
      if (!anchor || anchor.hash.startsWith("#/")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      location.assign(anchor.getAttribute("href") === "#" ? "/" : `/${anchor.hash}`);
    };
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, []);

  const view = mounted ? VIEWS[mounted.route] : undefined;
  return (
    <>
      {mounted && view ? createPortal(<div key={mounted.param ?? ""}>{view(mounted.param)}</div>, mounted.el) : null}
      <CookieConsent />
    </>
  );
}
