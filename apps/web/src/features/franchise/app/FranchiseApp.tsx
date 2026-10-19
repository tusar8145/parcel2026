"use client";

import { useCallback, useEffect, useState } from "react";
import BrandMark from "@/shared/BrandMark";
import { ToastProvider, api, describe, df, errorCode, type Me } from "./ui";
import Overview from "./Overview";
import Parcels from "./Parcels";
import WalkIn from "./WalkIn";
import Riders from "./Riders";
import Money from "./Money";

const PAGES = [
  { slug: "overview", label: "Overview", icon: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" },
  { slug: "parcels", label: "Parcels", icon: "m12 3 9 5-9 5-9-5 9-5Zm-9 5v9l9 5 9-5V8M12 13v9" },
  { slug: "walk-in", label: "Walk-in booking", icon: "M12 5v14M5 12h14" },
  { slug: "riders", label: "Riders", icon: "M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM17 3.2a4 4 0 0 1 0 7.6M21 21v-2a4 4 0 0 0-3-3.87" },
  { slug: "money", label: "Money & invoices", icon: "M4 5h15a2 2 0 0 1 2 2v12H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h13M21 10h-5a2 2 0 0 0 0 4h5" },
] as const;
type Slug = (typeof PAGES)[number]["slug"];

const pageFromUrl = (): Slug => {
  const p = new URLSearchParams(location.search).get("page");
  return (PAGES.find(x => x.slug === p)?.slug ?? "overview") as Slug;
};

function Logo() {
  return <BrandMark size={36} />;
}

/** The franchise panel: one account per franchise hub (Role FRANCHISE). */
export default function FranchiseApp() {
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [blocked, setBlocked] = useState<{ title: string; text: string } | null>(null);
  const [page, setPage] = useState<Slug>("overview");
  const [menu, setMenu] = useState(false);

  // Start once api.js has restored the session (html.legacy-ready).
  useEffect(() => {
    const root = document.documentElement;
    const start = () => setReady(true);
    if (root.classList.contains("legacy-ready")) return start();
    const observer = new MutationObserver(() => root.classList.contains("legacy-ready") && (observer.disconnect(), start()));
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  const loadMe = useCallback(async () => {
    try {
      setMe(await api<Me>("/franchise/me"));
      setBlocked(null);
    } catch (e) {
      setBlocked(
        errorCode(e) === "FRANCHISE_SUSPENDED"
          ? { title: "This franchise is suspended", text: "The franchise panel is closed while the franchise is suspended. Contact Delivery Fast support to resolve it." }
          : { title: "The franchise panel couldn't open", text: describe(e) },
      );
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    setPage(pageFromUrl());
    void loadMe();
    const onPop = () => setPage(pageFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [ready, loadMe]);

  const go = (slug: Slug) => {
    setPage(slug);
    setMenu(false);
    const url = new URL(location.href);
    url.searchParams.set("page", slug);
    url.searchParams.delete("tab");
    history.pushState(null, "", url);
    window.scrollTo(0, 0);
  };
  const label = PAGES.find(p => p.slug === page)?.label ?? "Overview";
  useEffect(() => {
    if (me) document.title = `${label} · ${me.name} · Delivery Fast Franchise`;
  }, [label, me]);

  const signOut = async () => {
    const ok = df().confirm ? await df().confirm!({ title: "Sign out?", message: "You can sign in again at any time.", confirm: "Sign out" }) : true;
    if (!ok) return;
    await df().auth.logout();
    location.href = "/login";
  };

  if (!ready) return null;
  if (blocked)
    return (
      <div className="fr-blocked" id="frBlocked">
        <h1>{blocked.title}</h1>
        <p>{blocked.text}</p>
        <button type="button" className="fr-btn" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    );
  if (!me) return <div className="fr-loading">Loading your franchise…</div>;

  return (
    <ToastProvider>
      <aside className={`fr-sidebar${menu ? " open" : ""}`} id="frSidebar">
        <div className="fr-brand">
          <Logo />
          <b>
            {"delivery "}
            <span>fast</span>
          </b>
        </div>
        <div className="fr-workspace">
          <small>Franchise hub</small>
          <strong id="frName">{me.name}</strong>
          <span>{`${me.hub.name} · ${me.code}`}</span>
          <span style={{ marginTop: 6 }}>
            <span className="fr-tag">Franchise</span>
          </span>
        </div>
        <nav className="fr-nav" aria-label="Franchise">
          {PAGES.map(p => (
            <button key={p.slug} type="button" data-page={p.slug} aria-current={page === p.slug ? "page" : undefined} onClick={() => go(p.slug)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={p.icon} />
              </svg>
              {p.label}
            </button>
          ))}
        </nav>
        <button type="button" className="fr-signout" onClick={() => void signOut()}>
          Sign out
        </button>
      </aside>
      <main className="fr-main">
        <header className="fr-topbar">
          <button type="button" className="fr-menu" aria-label="Open menu" onClick={() => setMenu(m => !m)}>
            ☰
          </button>
          <span className="crumb">
            {`${me.hub.name} / `}
            <b id="frCrumb">{label}</b>
          </span>
        </header>
        <div className="fr-content" id="frContent">
          {page === "overview" ? <Overview me={me} go={go} /> : null}
          {page === "parcels" ? <Parcels me={me} /> : null}
          {page === "walk-in" ? <WalkIn me={me} /> : null}
          {page === "riders" ? <Riders me={me} onRatesSaved={loadMe} /> : null}
          {page === "money" ? <Money me={me} /> : null}
        </div>
      </main>
    </ToastProvider>
  );
}
