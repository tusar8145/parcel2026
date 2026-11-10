/**
 * The frame of every page: the classic super admin menu (groups and the collapsible Notification / Operational /
 * Location settings), the top bar (merchant search, notifications) and the signed-in person; the Operations
 * console is one click away at the bottom of the menu, as in the classic panel.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@panel/lib/api";
import { useAuth } from "@panel/lib/auth";
import { useConnection, useLive } from "@panel/lib/events";
import { ago } from "@panel/lib/format";
import { Icon } from "@panel/ui/Icon";
import { confirm } from "@panel/ui/dialogs";
import { toastError } from "@panel/ui/toast";
import { GROUPS, legacyPath, PAGES, type PageDef } from "./nav";
import { useMerchants } from "@/lib/admin";

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

const initialsOf = (name?: string | null) =>
  (name || "?")
    .split(/\s+/)
    .map(p => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

/** Applications waiting for review (the classic menu's Registrations / Approval center counts). */
function useCounts(): Record<string, number | null> {
  const merchants = useMerchants();
  const n = merchants.data ? merchants.data.filter(m => m.status === "PENDING_REVIEW").length : null;
  return { Registrations: n, Approvals: n };
}

function Sidebar() {
  const { user, logout } = useAuth();
  const counts = useCounts();
  const nav = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  const activeSub = PAGES.find(p => `/${p.slug}` === pathname)?.sub;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (activeSub) setOpen(o => ({ ...o, [activeSub]: true }));
    const t = setTimeout(() => nav.current?.querySelector<HTMLElement>(".nav-item.active")?.scrollIntoView({ block: "nearest" }), 50);
    return () => clearTimeout(t);
  }, [pathname, activeSub]);
  const signOut = async () => {
    if (await confirm({ title: "Sign out?", message: `Sign out ${user?.name ?? "this account"} on this device?`, ok: "Sign out" })) await logout();
  };
  const item = (p: PageDef) => {
    const n = counts[p.id];
    return (
      <NavLink key={p.id} to={`/${p.slug}`} className="nav-item">
        <Icon name={p.icon} />
        <span>{p.label}</span>
        {n != null ? <span className="nav-count">{n}</span> : null}
      </NavLink>
    );
  };
  return (
    <aside className="sidebar" aria-label="Main menu">
      <div className="brand">
        <img src={`${import.meta.env.BASE_URL}logo.png`} alt="Delivery Fast" width={528} height={100} />
        <small>Platform administration</small>
      </div>
      <nav className="nav" ref={nav}>
        {GROUPS.map(g => {
          const pages = PAGES.filter(p => p.group === g.id);
          const seen = new Set<string>();
          return (
            <div className="nav-group" key={g.id}>
              <div className="nav-label">{g.label}</div>
              {pages.map(p => {
                if (!p.sub) return item(p);
                if (seen.has(p.sub)) return null;
                seen.add(p.sub);
                const sub = p.sub;
                const children = pages.filter(x => x.sub === sub);
                const isOpen = open[sub] ?? false;
                return (
                  <div key={sub} className="nav-sub">
                    <button type="button" className={`nav-item nav-sub-toggle${children.some(c => `/${c.slug}` === pathname) ? " has-active" : ""}`} aria-expanded={isOpen} onClick={() => setOpen(o => ({ ...o, [sub]: !isOpen }))}>
                      <Icon name={sub === "Location settings" ? "pin" : sub === "Notification settings" ? "bell" : sub === "Messaging" ? "message" : "settings"} />
                      <span>{sub}</span>
                      <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={14} />
                    </button>
                    {isOpen ? <div className="nav-sub-items">{children.map(item)}</div> : null}
                  </div>
                );
              })}
            </div>
          );
        })}
        <div className="nav-extras">
          <a className="foot-link" href="/ops/" title="Open operations console" style={{ padding: "6px 8px", fontSize: 11.5, gap: 6 }}>
            <Icon name="truck" size={14} />
            <span>Open operations console ↗</span>
          </a>
        </div>
      </nav>
      <div className="sidebar-foot">
        <div className="profile">
          <button type="button" className="profile-button" title="Sign out" onClick={() => void signOut()}>
            <span className="avatar">{initialsOf(user?.name)}</span>
            <span className="profile-meta">
              <strong>{user?.name}</strong>
              <small>Super administrator</small>
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
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  /** A merchant by name, code or owner: its directory (E-commerce or Banking & Financial), filtered to it. */
  const find = (text: string) => {
    const t = text.toLowerCase();
    const list = qc.getQueryData<{ name: string; code: string; contactName?: string; type: string }[]>(["admin", "merchants"]) ?? [];
    const hit = list.find(m => [m.name, m.code, m.contactName].some(v => String(v ?? "").toLowerCase().includes(t)));
    navigate(`/${hit?.type === "BANKING_FINANCIAL" ? "banking-and-financial-merchants" : "e-commerce-merchants"}?q=${encodeURIComponent(text)}`);
  };
  return (
    <header className="topbar">
      <button type="button" className="button ghost icon menu-toggle" aria-label="Open the menu" onClick={onMenu}>
        <Icon name="menu" />
      </button>
      <div className="crumb">
        Delivery Fast platform <span aria-hidden="true">/</span> <strong>{crumb}</strong>
      </div>
      <div className="top-actions">
        <span className="live-chip" data-state={state} role="status" aria-live="polite">
          <i />
          <span>{CHIP[state]}</span>
        </span>
        <div className="search">
          <Icon name="search" />
          <input
            className="input"
            type="search"
            placeholder="Search merchants..."
            aria-label="Search merchants"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => {
              if (e.key !== "Enter" || !q.trim()) return;
              find(q.trim());
            }}
          />
        </div>
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

/** "/super-admin?page=registrations" (a notification's link) → "/registrations" inside this panel. */
export function internalLink(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link, location.origin);
  } catch {
    return null;
  }
  if (url.origin !== location.origin) return null;
  if (url.pathname.startsWith("/admin")) return url.pathname.slice(6) + url.search || "/";
  if (url.pathname !== "/super-admin") return null;
  const page = url.searchParams.get("page");
  const keep = new URLSearchParams();
  const tab = url.searchParams.get("tab");
  if (tab) keep.set("tab", tab);
  return `${(page && legacyPath(page)) || "/overview"}${keep.toString() ? `?${keep}` : ""}`;
}

function Bell() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
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
    const inside = internalLink(n.link);
    if (inside) navigate(inside);
    else location.assign(n.link);
  }
  const rect = button.current?.getBoundingClientRect();
  return (
    <>
      <button ref={button} type="button" className="button ghost icon bell-button" aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(o => !o)} style={{ position: "relative" }}>
        <Icon name="bell" />
        {unread ? <span style={{ position: "absolute", top: 2, right: 0, minWidth: 17, padding: "0 4px", borderRadius: 9, background: "var(--bad)", color: "#fff", font: "700 10px/15px var(--font)" }}>{unread > 99 ? "99+" : unread}</span> : null}
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
