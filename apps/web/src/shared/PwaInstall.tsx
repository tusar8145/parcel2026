"use client";

import { useEffect, useState } from "react";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export default function PwaInstall() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    setInstalled(standalone);

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPrompt);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPrompt(null);
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
        if ("caches" in window) void caches.keys().then(names => names.filter(n => n.startsWith("delivery-fast-static-")).forEach(n => void caches.delete(n)));
      }
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) return null;

  const install = async () => {
    if (!prompt) {
      setShowHelp(true);
      return;
    }
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome !== "accepted") setPrompt(null);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void install()}
        style={{ position: "fixed", right: 12, bottom: 12, zIndex: 1000, padding: "6px 9px", border: "1px solid #e9edf2", borderRadius: 6, background: "#fff", color: "#7b8796", fontFamily: "inherit", fontSize: 12, fontWeight: 500, lineHeight: 1.2, cursor: "pointer" }}
        aria-label="Install Paira Express app"
      >
        Install app
      </button>
      {showHelp ? (
        <div
          role="presentation"
          onMouseDown={event => event.target === event.currentTarget && setShowHelp(false)}
          style={{ position: "fixed", inset: 0, zIndex: 1001, display: "grid", placeItems: "center", padding: 16, background: "#17203366" }}
        >
          <section role="dialog" aria-modal="true" aria-labelledby="dfInstallTitle" style={{ width: "min(420px, 100%)", padding: 22, borderRadius: 14, background: "#fff", color: "#182230", boxShadow: "0 16px 48px #17203333", font: "14px/1.5 system-ui, sans-serif" }}>
            <h2 id="dfInstallTitle" style={{ margin: "0 0 8px", fontSize: 18 }}>Install Paira Express</h2>
            <p style={{ margin: "0 0 16px" }}>Open your browser menu and choose “Install app” or “Add to Home Screen”.</p>
            <button type="button" onClick={() => setShowHelp(false)} style={{ padding: "8px 12px", border: 0, borderRadius: 7, background: "#1f2937", color: "#fff", font: "600 14px system-ui, sans-serif", cursor: "pointer" }}>
              Close
            </button>
          </section>
        </div>
      ) : null}
    </>
  );
}
