/**
 * The frame around every view: the menu (journey order, live counts, by role), the top bar (find a parcel or
 * the hub that serves a place, live state, notifications with operations alerts) and the parcel drawer (?parcel=).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@panel/lib/api";
import { useAuth } from "@panel/lib/auth";
import { useConnection, useLive } from "@panel/lib/events";
import { ago, num } from "@panel/lib/format";
import { useOps } from "@/lib/ops";
import { Icon } from "@panel/ui/Icon";
import { toastError } from "@panel/ui/toast";
import { confirm } from "@panel/ui/dialogs";
import { Select } from "@panel/ui/Select";
import { PARCEL_PERIODS, type ParcelPeriod } from "@/lib/ops";
import { allowedViews, financeFirst, GROUP_LABEL, JOURNEY, pathFor, VIEWS, type ViewDef } from "./nav";
import { internalLink } from "./links";
import { PhoneScannerButton } from "@/features/scan/PhoneScanner";
import { openShareFiles } from "@/features/account/ShareFiles";
import GlobalSearch from "@/features/parcels/GlobalSearch";

const CHIP = { live: "Live", connecting: "Connecting…", offline: "Offline · retrying" };

export default function Shell({ children, crumb }: { children: ReactNode; crumb: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMenuOpen(false), [location.pathname]);
  // Another menu page: the page fades and rises in (app/motion.css); another tab of the same page: nothing moves.
  // Paths are /ops/<page>/<tab>.
  const content = useRef<HTMLElement>(null);
  const lastView = useRef<string | null>(null);
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const view = location.pathname.split("/").filter(Boolean)[0] ?? "";
    const restart = (node: Element, cls: string) => {
      node.classList.remove(cls);
      void (node as HTMLElement).offsetWidth;
      node.classList.add(cls);
    };
    const sameView = lastView.current === view;
    lastView.current = view;
    // A tab change on the same page has no effect.
    if (!sameView) restart(el, "page-in");
  }, [location.pathname]);
  return (
    <div className="shell" data-menu={menuOpen ? "open" : "closed"}>
      <Sidebar />
      <div className="scrim" onClick={() => setMenuOpen(false)} />
      <div className="main">
        <Topbar crumb={crumb} onMenu={() => setMenuOpen(o => !o)} />
        <main className="content" id="main" ref={content}>
          {children}
        </main>
      </div>
    </div>
  );
}

function useMenuCounts() {
  const ops = useOps();
  const { me } = ops;
  const qc = useQueryClient();
  const workQueue = useQuery({
    queryKey: ["work-queue", "nav", ops.period.since ?? "all"],
    queryFn: () => api<{ tasks: { count?: number }[] }>(`/work-queue${ops.period.since ? `?createdSince=${encodeURIComponent(ops.period.since)}` : ""}`),
    enabled: !!me,
    staleTime: 30_000,
    retry: false,
  });
  const cash = !!me?.can.receiveCash;
  const money = !!me && ((me.can.manageFinance && me.can.financeStaff) || (!!ops.menu.centralHubId && cash && (!me.hubIds || me.hubIds.includes(ops.menu.centralHubId))));
  const accounts = useQuery({
    queryKey: ["accounts", "nav-count", cash, money],
    queryFn: async () => {
      const empty = { items: [] as unknown[] };
      const [slips, transit, pending] = await Promise.all([
        cash ? api<{ items: unknown[] }>("/cash/slips?status=OPEN") : empty,
        money ? api<{ items: unknown[] }>("/cash/transfers?status=IN_TRANSIT") : empty,
        money ? api<{ items: unknown[] }>("/payments?status=PENDING") : empty,
      ]);
      return slips.items.length + transit.items.length + pending.items.length;
    },
    enabled: !!me && (cash || money),
    staleTime: 30_000,
    retry: false,
  });
  // Merchants: address changes waiting for approval (merchant:address).
  const addressRequests = useQuery({
    queryKey: ["merchants", "address-requests"],
    queryFn: () => api<{ items: unknown[] }>("/merchant-address-requests"),
    enabled: !!me?.can.merchantAddress,
    staleTime: 20_000,
    retry: false,
  });
  useLive(["merchant.address_request", "merchant.updated"], () => void qc.invalidateQueries({ queryKey: ["merchants", "address-requests"] }));
  useLive(["parcel.created", "parcel.updated"], () => void qc.invalidateQueries({ queryKey: ["work-queue", "nav"] }), { debounceMs: 3000 });
  useLive(["account.updated", "cash.slip", "cash.transfer"], () => void qc.invalidateQueries({ queryKey: ["accounts"] }));
  const stages = ops.stageCounts?.stages;
  return (v: ViewDef): number | null => {
    if (v.stage) return stages ? Number(stages[v.stage]) || 0 : null;
    if (v.count === "workQueue") return workQueue.data ? workQueue.data.tasks.reduce((n, t) => n + (t.count || 0), 0) : null;
    if (v.count === "accounts") return accounts.data || null;
    if (v.id === "Merchants") return addressRequests.data?.items.length || null;
    return null;
  };
}

function Sidebar() {
  const ops = useOps();
  const { user, logout, hasRole } = useAuth();
  const allowed = allowedViews(ops.menu);
  // Open support tickets, once the Support page has loaded them (shared/support.js counted them the same way).
  const qc = useQueryClient();
  const ticketsKey = ["support", "tickets", user?.id];
  const tickets = useQuery<{ statusLabel: string }[]>({ queryKey: ticketsKey, queryFn: () => qc.getQueryData<{ statusLabel: string }[]>(ticketsKey) ?? [], enabled: false });
  const openTickets = (tickets.data ?? []).filter(t => !["Resolved", "Closed"].includes(t.statusLabel)).length;
  const countOf = useMenuCounts();
  // The open page's menu item stays in sight (a page opened by link may sit below the fold); otherwise the menu
  // keeps where it was scrolled.
  const nav = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    const t = setTimeout(() => nav.current?.querySelector<HTMLElement>(".nav-item.active")?.scrollIntoView({ block: "nearest" }), 50);
    return () => clearTimeout(t);
  }, [pathname]);
  // The selected item's box slides from item to item (app/motion.css .nav-indicator).
  const track = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ top: 0, left: 0, width: 0, height: 0, shown: false, ready: false });
  useLayoutEffect(() => {
    const host = track.current;
    if (!host) return;
    const place = () => {
      const el = host.querySelector<HTMLElement>('.nav-item[aria-current="page"]');
      if (!el) return setBox(b => ({ ...b, shown: false }));
      const h = host.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      setBox(b => ({ top: r.top - h.top, left: r.left - h.left, width: r.width, height: r.height, shown: true, ready: b.shown || b.ready }));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(host);
    return () => ro.disconnect();
  }, [pathname]);
  const groups = (["today", "journey", "queue", "money", "find", "manage"] as const).filter(g => VIEWS.some(v => v.group === g && allowed.has(v.id)));
  if (financeFirst(ops.menu.roles)) groups.sort((a, b) => (a === "money" ? -1 : b === "money" ? 1 : 0));
  const initials = (user?.name || "?")
    .split(/\s+/)
    .map(p => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const signOut = async () => {
    if (await confirm({ title: "Sign out?", message: `Sign out ${user?.name ?? "this account"} on this device?`, ok: "Sign out" })) await logout();
  };
  return (
    <aside className="sidebar" aria-label="Main menu">
      <div className="brand">
        <img src={`${import.meta.env.BASE_URL}logo.png`} alt="Delivery Fast" width={528} height={100} />
        <small>{ops.myHubs?.length ? `Operations console · ${ops.myHubs.map(h => h.name).join(", ")}` : "Operations console"}</small>
      </div>
      <nav className="nav" ref={nav}>
        <div className="nav-track" ref={track}>
        <div className={`nav-indicator${box.shown ? " shown" : ""}${box.ready ? " ready" : ""}`} aria-hidden="true" style={{ transform: `translate(${box.left}px, ${box.top}px)`, width: box.width, height: box.height }} />
        {groups.map(g => (
          <div className="nav-group" key={g}>
            {GROUP_LABEL[g] ? <div className="nav-label">{GROUP_LABEL[g]}</div> : null}
            {VIEWS.filter(v => v.group === g && allowed.has(v.id)).map(v => {
              const n = countOf(v);
              return (
                <NavLink key={v.id} to={pathFor(v.id)} className={`nav-item${v.step ? " journey" : ""}`}>
                  <Icon name={v.icon} />
                  {v.step ? <span className="nav-step" aria-hidden="true">{v.step}</span> : null}
                  <span>{v.label}</span>
                  {n != null && (v.stage || n > 0) ? <span className={`nav-count${v.id === "Merchants" ? " amber" : ""}`} title={v.id === "Merchants" ? `${num(n)} address change${n === 1 ? "" : "s"} to approve` : `${num(n)} waiting`}>{num(n)}</span> : null}
                </NavLink>
              );
            })}
          </div>
        ))}
        <div className="nav-group">
          <div className="nav-label">Help</div>
          <NavLink to="/support" className="nav-item">
            <Icon name="message" />
            <span>Support tickets</span>
            {openTickets ? (
              <span className="nav-count" title={`${num(openTickets)} open`}>
                {num(openTickets)}
              </span>
            ) : null}
          </NavLink>
        </div>
        </div>
        {/* At the end of the menu (they scroll with it), like the super admin panel's "Open operations console". */}
        <div className="nav-extras">
          {hasRole("SUPER_ADMIN") ? (
            <a className="foot-link" href="/admin" title="Back to the super admin panel">
              <Icon name="lock" />
              <span>Open admin console ↗</span>
            </a>
          ) : null}
          {/* "Get the apps": /apps lists the Merchant, Rider and Operations APKs. */}
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
          {/* Like the other panels: clicking your name asks to sign out. */}
          <button type="button" className="profile-button" title="Sign out" onClick={signOut}>
            <span className="avatar">{initials}</span>
            <span className="profile-meta">
              <strong>{user?.name}</strong>
              <small>{ops.myHubs?.length ? `${ops.roleName} · ${ops.myHubs.map(h => h.name).join(", ")}` : ops.roleName}</small>
            </span>
          </button>
          <button type="button" className="button ghost sm icon" title="Sign out" aria-label="Sign out" onClick={signOut}>
            <Icon name="logout" />
          </button>
        </div>
      </div>
    </aside>
  );
}

function Topbar({ crumb, onMenu }: { crumb: string; onMenu: () => void }) {
  const state = useConnection();
  const ops = useOps();
  return (
    <header className="topbar">
      <button type="button" className="button ghost icon menu-toggle" aria-label="Open the menu" onClick={onMenu}>
        <Icon name="menu" />
      </button>
      <div className="crumb">
        Delivery Fast <span aria-hidden="true">/</span> <strong>{crumb}</strong>
      </div>
      <div className="top-actions">
        <PeriodPicker />
        {ops.me && ops.can("dispatch") ? (
          <button type="button" className="button sm" aria-haspopup="dialog" title="Receive files from a phone or another computer (QR code)" onClick={() => void openShareFiles()}>
            <Icon name="upload" />
            <span className="hide-sm">Share files</span>
          </button>
        ) : null}
        <PhoneScannerButton />
        <span className="live-chip" data-state={state} role="status" aria-live="polite" title={state === "live" ? "Live updates are on: changes by others appear without reloading" : "Live updates are reconnecting; lists refresh when the connection is back"}>
          <i />
          <span>{CHIP[state]}</span>
        </span>
        <GlobalSearch />
        <Bell />
      </div>
    </header>
  );
}

/** Which parcels every list and count shows (booked in the last 30 days…); remembered in this browser. A search still finds older parcels. */
function PeriodPicker() {
  const { period } = useOps();
  return (
    <Select className="select sm" searchable={false} icon="clock" value={period.value} onChange={e => period.set(e.target.value as ParcelPeriod)} aria-label="Parcels booked in" title="Lists and counts show parcels booked in this period. Searching by ID finds older parcels too." style={{ width: 150 }}>
      {PARCEL_PERIODS.map(p => (
        <option key={p.value} value={p.value}>
          {p.label}
        </option>
      ))}
    </Select>
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

/** The bell: unread count, latest notifications, and live operations alerts (breached SLAs, open problems). */
function Bell() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const ops = useOps();
  const count = useQuery({ queryKey: ["notifications", "count"], queryFn: () => api<{ unread: number }>("/me/notifications/count"), staleTime: 30_000 });
  const latest = useQuery({ queryKey: ["notifications", "latest"], queryFn: () => api<{ items: Notification[] }>("/me/notifications?limit=8"), enabled: open });
  const breached = useQuery({
    queryKey: ["sla", "breached"],
    queryFn: () => api<{ items: { id: string; leg: string; dueAt: string; parcel: { trackingId: string; zone?: string; hub?: { name: string }; rider?: string } }[] }>("/sla/alerts?level=BREACHED&open=true&limit=6"),
    enabled: open,
    retry: false,
  });
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
  const d = (ops.stageCounts?.detail || {}) as Record<string, number>;
  const counts: [string, number, string, string?][] = (
    [
      ["Exceptions to resolve", d.exceptions, "Problems", "Exceptions"],
      ["Late or at risk of being late", d.slaRisk, "Problems", "SLA late-risk"],
      ["Failed deliveries to retry", d.failed, "Problems", "Failed delivery"],
      ["Waiting for a delivery rider", d.deliveryWaiting, "Delivery"],
    ] as [string, number, string, string?][]
  ).filter(([, n]) => Number(n) > 0);

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
              {breached.data?.items.length || counts.length ? (
                <>
                  <div className="menu-sep" />
                  <div className="section-title" style={{ margin: "6px 8px 2px" }}>
                    Operations alerts{breached.data?.items.length ? " · SLA breached first" : ""}
                  </div>
                  {breached.data?.items.map(a => (
                    <button key={a.id} type="button" className="menu-item" onClick={() => (setOpen(false), navigate({ search: `?parcel=${encodeURIComponent(a.parcel.trackingId)}` }))}>
                      <span className="grow">
                        <strong>
                          {a.parcel.trackingId} · {a.leg === "PICKUP" ? "pickup" : "delivery"} overdue
                        </strong>
                        <small className="faint" style={{ display: "block" }}>{[a.parcel.zone, a.parcel.hub?.name, a.parcel.rider].filter(Boolean).join(" · ")}</small>
                      </span>
                      <small className="faint nowrap">due {ago(a.dueAt)}</small>
                    </button>
                  ))}
                  {counts.map(([label, n, view, tab]) => (
                    <button key={label} type="button" className="menu-item" onClick={() => (setOpen(false), navigate(pathFor(view, tab)))}>
                      <span className="grow">{label}</span>
                      <strong>{num(n)}</strong>
                    </button>
                  ))}
                </>
              ) : null}
              <div className="menu-sep" />
              <button type="button" className="menu-item" style={{ justifyContent: "center", color: "var(--primary)", fontWeight: 600 }} onClick={() => (setOpen(false), navigate("/notifications"))}>
                See all notifications{unread ? ` (${unread} unread)` : ""}
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export { JOURNEY };
