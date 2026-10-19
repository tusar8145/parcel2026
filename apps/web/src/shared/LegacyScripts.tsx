"use client";

import { useEffect } from "react";

declare global {
  interface Window {
    __legacyBooted?: boolean;
    DF?: { ready?: Promise<unknown>; bridgeReady?: Promise<unknown> };
  }
}

const CLIENT = "/legacy/shared/api.js";

function load(src: string, ordered: boolean) {
  return new Promise<void>(resolve => {
    const script = document.createElement("script");
    script.src = src;
    script.async = !ordered ? true : false; // ordered scripts execute in insertion order
    script.onload = script.onerror = () => resolve();
    document.body.appendChild(script);
  });
}

/**
 * Runs a page's original scripts (public/legacy/<page>/*.js) as classic scripts once
 * the server-rendered markup has hydrated. The API client (api.js) runs first and
 * restores the session and data (DF.ready) before the page scripts start, so they
 * see real data on their first render. Scripts share the global scope, like the
 * inline <script> blocks did in the original .html files.
 */
export default function LegacyScripts({ scripts }: { scripts: string[] }) {
  useEffect(() => {
    if (window.__legacyBooted) return; // React Strict Mode runs effects twice in dev
    window.__legacyBooted = true;

    // Scripts listed before api.js (e.g. the rider app's offline store) run before it boots.
    const clientIndex = scripts.indexOf(CLIENT);
    const early = clientIndex > 0 ? scripts.slice(0, clientIndex) : [];
    const rest = scripts.filter(s => s !== CLIENT && !early.includes(s));
    // Fetch page scripts while the session is being restored.
    for (const src of rest) {
      const link = document.createElement("link");
      link.rel = "preload";
      link.as = "script";
      link.href = src;
      document.head.appendChild(link);
    }

    void (async () => {
      for (const src of early) await load(src, true);
      if (scripts.includes(CLIENT)) {
        await load(CLIENT, true);
        await window.DF?.ready;
      }
      await Promise.all(rest.map(src => load(src, true)));
      // A page bridge can keep the page hidden until its own data has loaded.
      await window.DF?.bridgeReady?.catch(() => undefined);
      document.documentElement.classList.add("legacy-ready");
    })();
  }, [scripts]);

  return <span hidden data-legacy-boot />;
}
