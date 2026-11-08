/**
 * The frame of every page: the menu (Workspace / Manage / Support, with the classic panel's counts), the workspace
 * card (members of several merchants switch here), the top bar (search, notifications) and the signed-in person.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@panel/lib/api";
import { useAuth } from "@panel/lib/auth";
import { useConnection, useLive } from "@panel/lib/events";
import { ago, num } from "@panel/lib/format";
import { Icon } from "@panel/ui/Icon";
import { confirm, openForm } from "@panel/ui/dialogs";
import { toast, toastError } from "@panel/ui/toast";
import { useMerchant } from "@/lib/merchant";
import { GROUP_LABEL, labelOf, legacyPath, PAGES, slugOf } from "./nav";
import { GlobalSearch } from "@/features/parcels/GlobalSearch";

export default function Shell({ children, crumb }: { children: ReactNode; crumb: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setMenuOpen(false), [pathname]);
  return (
    <div className="shell" data-menu={menuOpen ? "open" : "closed"}>
      <Sidebar />
      <div className="scrim" onClick={() => setMenuOpen(false)} />
      <div className="main">
        <Topbar crumb={crumb} onMenu={() => setMenuOpen(o => !o)} />
        <main className="content" id="main">
          {children}
        </main>
      </div>
    </div>
  );
}

interface Stats {
  parcels: { byStatus: Record<string, number>; awaitingPickup: number };
}

/** The menu's counts: New requests and Pickup requests from GET /merchants/me/stats, open support tickets. */
function useCounts() {
  const m = useMerchant();
  const stats = useQuery({ queryKey: ["m", "stats", "nav"], queryFn: () => api<Stats>(`/merchants/me/stats?period=7d${m.q("&")}`), staleTime: 30_000 });
  const qc = useQueryClient();
  const tickets = useQuery({ queryKey: ["support", "mine", "count"], queryFn: () => api<{ items: { statusLabel?: string; status?: string }[] }>("/support/tickets?limit=200"), staleTime: 60_000, retry: false });
  useLive(["ticket.updated", "ticket.created"], () => void qc.invalidateQueries({ queryKey: ["support"] }), { fallbackMs: 300_000 });
  const by = stats.data?.parcels.byStatus ?? {};
  const open = (tickets.data?.items ?? []).filter(t => !["Resolved", "Closed"].includes(t.statusLabel ?? "") && !["RESOLVED", "CLOSED"].includes(t.status ?? "")).length;
  return {
    "New requests": stats.data ? (by.PENDING_CONFIRMATION ?? 0) + (by.PICKUP_ASSIGNED ?? 0) + (by.PICKUP_CONFIRMED ?? 0) : null,
    "Pickup requests": stats.data ? stats.data.parcels.awaitingPickup : null,
    Support: tickets.data ? open : null,
  } as Record<string, number | null>;
}

const initialsOf = (name?: string | null) =>
  (name || "?")
    .split(/\s+/)
    .map(p => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

function Sidebar() {
  const { user, logout } = useAuth();
  const m = useMerchant();
  const counts = useCounts();
  const nav = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    const t = setTimeout(() => nav.current?.querySelector<HTMLElement>(".nav-item.active")?.scrollIntoView({ block: "nearest" }), 50);
    return () => clearTimeout(t);
  }, [pathname]);
  const signOut = async () => {
    if (await confirm({ title: "Sign out?", message: `Sign out ${user?.name ?? "this account"} on this device?`, ok: "Sign out" })) await logout();
  };
  const switchWorkspace = async () => {
    if (m.workspaces.length < 2) return toast(`You're viewing the ${m.merchant.name} workspace (${m.merchant.code}).`);
    const v = await openForm({
      title: "Switch workspace",
      submit: "Switch",
      fields: [{ id: "id", label: "Workspace", type: "select", value: m.merchant.id, options: m.workspaces.map(w => ({ value: w.id, label: `${w.name} (${w.code})` })) }],
    });
    const chosen = v && m.workspaces.find(w => w.id === v.id);
    if (chosen && chosen.id !== m.merchant.id) m.switchTo(chosen);
  };
  const groups = (["workspace", "manage", "help"] as const).map(g => ({ g, pages: PAGES.filter(p => p.group === g) }));
  return (
    <aside className="sidebar" aria-label="Main menu">
      <div className="brand">
        <img src={`${import.meta.env.BASE_URL}logo.png`} alt="Delivery Fast" width={528} height={100} />
        <small>{m.panel.typeLabel}</small>
      </div>
      <button type="button" className="workspace-card" onClick={() => void switchWorkspace()} title={`${m.merchant.name} · ${m.merchant.code}`}>
        <span className="avatar">{initialsOf(m.merchant.name)}</span>
        <span className="workspace-meta">
          <strong>{m.merchant.name}</strong>
          <small>
            {m.merchant.code}
            {m.workspaces.length > 1 ? " · switch" : ""}
          </small>
        </span>
      </button>
      <nav className="nav" ref={nav}>
        {groups.map(({ g, pages }) => (
          <div className="nav-group" key={g}>
            <div className="nav-label">{GROUP_LABEL[g]}</div>
            {pages.map(p => {
              const n = counts[p.id];
              return (
                <NavLink key={p.id} to={`/${slugOf(p, m.doc)}`} className="nav-item">
                  <Icon name={p.icon} />
                  <span>{labelOf(p, m.doc)}</span>
                  {n ? (
                    <span className="nav-count" title={`${num(n)} ${p.id === "Support" ? "open" : "waiting"}`}>
                      {num(n)}
                    </span>
                  ) : null}
                </NavLink>
              );
            })}
          </div>
        ))}
        <div className="nav-group">
          <a className="nav-item" href={`${m.panel.classic}?classic=1`} title="The previous merchant panel (same data)" onClick={() => (document.cookie = "df-classic-merchant=1; path=/; SameSite=Lax")}>
            <Icon name="external" />
            <span>Classic panel</span>
          </a>
        </div>
        <div className="nav-extras">
          <a className="app-card" href="/apps" target="_blank" rel="noopener" title="Download the Android apps">
            <span className="app-card-icon" aria-hidden="true">
              <Icon name="phoneScan" size={18} />
            </span>
            <span className="app-card-text">
              <strong>Get the apps ↗</strong>
              <small>Merchant · Rider · Operations</small>
            </span>
          </a>
        </div>
      </nav>
      <div className="sidebar-foot">
        <div className="profile">
          <button type="button" className="profile-button" title="Sign out" onClick={() => void signOut()}>
            <span className="avatar">{initialsOf(user?.name)}</span>
            <span className="profile-meta">
              <strong>{user?.name}</strong>
              <small>{m.isOwner ? m.panel.ownerLabel : m.panel.staffLabel}</small>
            </span>
          </button>
          <button type="button" className="button ghost sm icon" title="Sign out" aria-label="Sign out" onClick={() => void signOut()}>
            <Icon name="logout" />
          </button>
        </div>
      </div>
    </aside>
  );
}

const CHIP = { live: "Live", connecting: "Connecting…", offline: "Reconnecting…" } as const;

function Topbar({ crumb, onMenu }: { crumb: string; onMenu: () => void }) {
  const state = useConnection();
  const m = useMerchant();
  return (
    <header className="topbar">
      <button type="button" className="button ghost icon menu-toggle" aria-label="Open the menu" onClick={onMenu}>
        <Icon name="menu" />
      </button>
      <div className="crumb">
        {m.merchant.name} <span aria-hidden="true">/</span> <strong>{crumb}</strong>
      </div>
      <div className="top-actions">
        <span className="live-chip" data-state={state} role="status" aria-live="polite" title={state === "live" ? "Live updates are on: changes appear without reloading" : "Live updates are reconnecting; lists refresh when the connection is back"}>
          <i />
          <span>{CHIP[state]}</span>
        </span>
        <GlobalSearch />
        <Bell />
      </div>
    </header>
  );
}

interface Notification {
  id: string;
  title: string;
  body?: string | null;
  link?: string | null;
  readAt?: string | null;
  createdAt: string;
}

/** "/banking-merchant?page=orders&parcel=FD-1" (a notification's link) → "/all-requests?parcel=FD-1" inside this panel. */
export function internalLink(link: string, doc = true): string | null {
  let url: URL;
  try {
    url = new URL(link, location.origin);
  } catch {
    return null;
  }
  if (url.origin !== location.origin) return null;
  if (url.pathname.startsWith("/merchant")) return url.pathname.slice(9) + url.search || "/";
  if (url.pathname !== "/banking-merchant" && url.pathname !== "/ecommerce-merchant") return null;
  const keep = new URLSearchParams();
  for (const k of ["parcel", "ticket"]) if (url.searchParams.get(k)) keep.set(k, url.searchParams.get(k)!);
  const page = url.searchParams.get("page");
  const path = page ? legacyPath(page, doc) : "/overview";
  return `${path ?? "/overview"}${keep.toString() ? `?${keep}` : ""}`;
}

function Bell() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const m = useMerchant();
  const count = useQuery({ queryKey: ["notifications", "count"], queryFn: () => api<{ unread: number }>("/me/notifications/count"), staleTime: 30_000 });
  const latest = useQuery({ queryKey: ["notifications", "latest"], queryFn: () => api<{ items: Notification[] }>("/me/notifications?limit=8"), enabled: open });
  useLive(["notification.created", "notification.read"], () => void qc.invalidateQueries({ queryKey: ["notifications"] }), { fallbackMs: 180_000 });
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest?.(".bell-pop, .bell-button") && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const unread = count.data?.unread ?? 0;

  async function openItem(n: Notification) {
    setOpen(false);
    if (!n.readAt) await api(`/me/notifications/${n.id}/read`, { method: "POST" }).catch(() => undefined);
    void qc.invalidateQueries({ queryKey: ["notifications"] });
    if (!n.link) return;
    const inside = internalLink(n.link, m.doc);
    if (inside) navigate(inside);
    else location.assign(n.link);
  }

  const rect = button.current?.getBoundingClientRect();
  return (
    <>
      <button ref={button} type="button" className="button ghost icon bell-button" aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(o => !o)} style={{ position: "relative" }}>
        <Icon name="bell" />
        {unread ? (
          <span style={{ position: "absolute", top: 2, right: 0, minWidth: 17, padding: "0 4px", borderRadius: 9, background: "var(--bad)", color: "#fff", font: "700 10px/15px var(--font)" }}>{unread > 99 ? "99+" : unread}</span>
        ) : null}
      </button>
      {open && rect
        ? createPortal(
            <div className="menu bell-pop" role="dialog" aria-label="Notifications" style={{ top: rect.bottom + 8, left: Math.max(12, rect.right - 380), width: "min(380px, calc(100vw - 24px))", maxHeight: "75vh" }}>
              <div className="row" style={{ justifyContent: "space-between", padding: "4px 6px 8px", borderBottom: "1px solid var(--line)" }}>
                <strong style={{ color: "var(--ink)" }}>Notifications</strong>
                <button
                  type="button"
                  className="link-button"
                  disabled={!unread}
                  onClick={async () => {
                    await api("/me/notifications/read-all", { method: "POST" }).catch(toastError);
                    void qc.invalidateQueries({ queryKey: ["notifications"] });
                  }}
                >
                  Mark all read
                </button>
              </div>
              {latest.isLoading ? <div className="faint" style={{ padding: 10 }}>Loading…</div> : null}
              {latest.data?.items.length === 0 ? <div className="faint" style={{ padding: 10 }}>No notifications yet.</div> : null}
              {latest.data?.items.map(n => (
                <button key={n.id} type="button" className="menu-item" onClick={() => void openItem(n)} style={{ alignItems: "flex-start", fontWeight: n.readAt ? 450 : 620 }}>
                  {!n.readAt ? <i style={{ width: 7, height: 7, marginTop: 6, borderRadius: "50%", background: "var(--primary)", flex: "none" }} /> : <i style={{ width: 7, flex: "none" }} />}
                  <span className="grow">
                    {n.title}
                    {n.body ? <small className="faint" style={{ display: "block", fontWeight: 400 }}>{n.body}</small> : null}
                  </span>
                  <small className="faint nowrap">{ago(n.createdAt)}</small>
                </button>
              ))}
              <div className="menu-sep" />
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  setOpen(false);
                  navigate("/notifications");
                }}
              >
                See all notifications
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
