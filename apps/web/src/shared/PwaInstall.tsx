"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

/** The browser's install offer, kept from page load so the button can use it whenever it mounts. */
let installPrompt: InstallPrompt | null = null;
let installed = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(l => l());
const subscribe = (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener));

/** Every page: makes the site installable (service worker) and keeps the browser's install offer. No button of its own. */
export default function PwaInstall() {
  useEffect(() => {
    installed =
      window.matchMedia("(display-mode: standalone)").matches ||
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    notify();

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      installPrompt = event as InstallPrompt;
      notify();
    };
    const onInstalled = () => {
      installed = true;
      installPrompt = null;
      notify();
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);

    if ("serviceWorker" in navigator && window.isSecureContext) {
      if (process.env.NODE_ENV === "production") {
        void navigator.serviceWorker.register("/app-sw.js", { scope: "/" }).catch(error => {
          console.warn("Paira Express: the app could not be made installable", error);
        });
      } else {
        // Development: a cached copy would hide edits to public/legacy. Remove one left from earlier.
        void navigator.serviceWorker.getRegistrations().then(registrations => {
          for (const r of registrations) if (r.active?.scriptURL.endsWith("/app-sw.js")) void r.unregister();
        });
        if ("caches" in window) void caches.keys().then(names => names.filter(n => n.startsWith("paira-express-static-") || n.startsWith("delivery-fast-static-") /* before the rename */).forEach(n => void caches.delete(n)));
      }
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  return null;
}

/** A computer's browser (mouse or trackpad, not a phone or tablet): phones get the Android apps instead. */
function isComputer() {
  const ua = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  if (ua.userAgentData?.mobile) return false;
  if (/Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent)) return false;
  return window.matchMedia("(pointer: fine)").matches;
}

/** Courier Operations' sidebar: install the console as a desktop app. Shown only in a computer's browser, in place (not floating). */
export function InstallAppButton() {
  const [computer, setComputer] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const state = useSyncExternalStore(
    subscribe,
    () => (installed ? "installed" : installPrompt ? "prompt" : "help"),
    () => "installed",
  );
  useEffect(() => setComputer(isComputer()), []);

  if (!computer || state === "installed") return null;

  const install = async () => {
    if (!installPrompt) return setShowHelp(true);
    const prompt = installPrompt;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome !== "accepted") {
      installPrompt = null;
      notify();
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void install()}
        style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "calc(100% - 4px)", margin: "0 2px 10px", padding: "8px 12px", border: "1px solid #e1e7fb", borderRadius: 10, background: "#fff", color: "#344054", fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
        aria-label="Install Paira Express as an app on this computer"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M8 20h8M12 16v4M12 7v5m-2.5-2.5L12 12l2.5-2.5" />
        </svg>
        {"Install app"}
      </button>
      {showHelp ? (
        <div
          role="presentation"
          onMouseDown={event => event.target === event.currentTarget && setShowHelp(false)}
          style={{ position: "fixed", inset: 0, zIndex: 1001, display: "grid", placeItems: "center", padding: 16, background: "#17203366" }}
        >
          <section role="dialog" aria-modal="true" aria-labelledby="dfInstallTitle" style={{ width: "min(420px, 100%)", padding: 22, borderRadius: 14, background: "#fff", color: "#182230", boxShadow: "0 16px 48px #17203333", font: "14px/1.5 system-ui, sans-serif" }}>
            <h2 id="dfInstallTitle" style={{ margin: "0 0 8px", fontSize: 18 }}>{"Install Paira Express"}</h2>
            <p style={{ margin: "0 0 16px" }}>{"Open your browser menu and choose “Install app” (or the install icon in the address bar)."}</p>
            <button type="button" onClick={() => setShowHelp(false)} style={{ padding: "8px 12px", border: 0, borderRadius: 7, background: "#1f2937", color: "#fff", font: "600 14px system-ui, sans-serif", cursor: "pointer" }}>
              {"Close"}
            </button>
          </section>
        </div>
      ) : null}
    </>
  );
}
