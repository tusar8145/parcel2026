/**
 * The frame around every view: the menu (journey order, live counts, by role), the top bar (find a parcel or
 * the hub that serves a place, live state, notifications with operations alerts) and the parcel drawer (?parcel=).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useConnection, useLive } from "@/lib/events";
import { ago, num } from "@/lib/format";
import { useOps } from "@/lib/ops";
import { Icon } from "@/ui/Icon";
import { toast, toastError } from "@/ui/toast";
import { confirm } from "@/ui/dialogs";
import { Select } from "@/ui/Select";
import { PARCEL_PERIODS, type ParcelPeriod } from "@/lib/ops";
import { allowedViews, financeFirst, GROUP_LABEL, JOURNEY, pathFor, VIEWS, type ViewDef } from "./nav";
import { chooseClassic, internalLink } from "./links";
import { findParcels, useCatalog } from "@/features/parcels/search";
import { focusScanBox } from "@/features/scan/scanner";
import { PhoneScannerButton } from "@/features/scan/PhoneScanner";
import { openShareFiles } from "@/features/account/ShareFiles";

const CHIP = { live: "Live", connecting: "Connecting…", offline: "Offline · retrying" };

export default function Shell({ children, crumb }: { children: ReactNode; crumb: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMenuOpen(false), [location.pathname]);
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

function useMenuCounts() {
  const ops = useOps();
  const { me } = ops;
  const qc = useQueryClient();
  const workQueue = useQuery({
    queryKey: ["work-queue", "nav"],
    queryFn: () => api<{ tasks: { count?: number }[] }>("/work-queue"),
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
        <small>Operations console</small>
      </div>
      <nav className="nav" ref={nav}>
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
          <a className="nav-item" href="/courier-operation?classic=1" title="The previous Operations console (same data)" onClick={chooseClassic}>
            <Icon name="external" />
            <span>Classic console</span>
          </a>
        </div>
        {/* At the end of the menu (they scroll with it), like the super admin panel's "Open courier operations console". */}
        <div className="nav-extras">
          {hasRole("SUPER_ADMIN") ? (
            <a className="foot-link" href="/super-admin" title="Back to the super admin panel">
              <Icon name="lock" />
              <span>Open super admin console ↗</span>
            </a>
          ) : null}
          {/* Same as the classic console's "Get the apps" card: /apps lists the Merchant, Rider and Operations APKs. */}
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
              <small>{ops.roleName}</small>
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
        {ops.me && ops.can("dispatch") ? (
          <button type="button" className="button sm" aria-haspopup="dialog" title="Receive files from a phone or another computer (QR code)" onClick={() => void openShareFiles()}>
            <Icon name="upload" />
            <span className="hide-sm">Share files</span>
          </button>
        ) : null}
        <PeriodPicker />
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

/** Tracking ID, CN or phone (typed or scanned) + Enter → the parcel drawer; a zone or area → the hub that serves it. */
function GlobalSearch() {
  const [, setParams] = useSearchParams();
  const [value, setValue] = useState("");
  const [places, setPlaces] = useState<{ district: string; zone: string; area?: string; hub: { name: string } | null }[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const catalog = useCatalog();
  const { hubs } = useOps();
  const seq = useRef(0);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "F2" && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        if (!focusScanBox()) toast("No scan box on this page.");
        return;
      }
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !t.isContentEditable && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);

  useEffect(() => {
    const text = value.trim();
    const mine = ++seq.current;
    if (text.length < 3 || /\d/.test(text) || !catalog) return setPlaces(null);
    const t = text.toLowerCase();
    const found: { district: string; zone: string; area?: string }[] = [];
    for (const district of catalog.districts || []) for (const zone of catalog.zonesByDistrict?.[district] || []) if (zone.toLowerCase().includes(t)) found.push({ district, zone });
    for (const district of catalog.districts || [])
      for (const zone of catalog.zonesByDistrict?.[district] || [])
        for (const area of catalog.areasByZone?.[zone] || []) if (area.toLowerCase().includes(t) && !found.some(p => p.zone === zone && p.district === district && !p.area)) found.push({ district, zone, area });
    const top = found.slice(0, 6);
    if (!top.length) return setPlaces(null);
    const timer = setTimeout(async () => {
      const withHubs = await Promise.all(
        top.map(async p => {
          let hub: { name: string } | null = null;
          try {
            const page = await api<{ items: { name: string; hub?: { name: string } | null }[] }>(`/zones?limit=20&district=${encodeURIComponent(p.district)}&q=${encodeURIComponent(p.zone)}`);
            hub = page.items.find(z => z.name.toLowerCase() === p.zone.toLowerCase() && z.hub)?.hub ?? null;
          } catch {
            /* fall back to the hubs' own zones */
          }
          hub ??= hubs.find(h => h.active !== false && h.district === p.district && (h.zone || "").toLowerCase() === p.zone.toLowerCase()) ?? null;
          return { ...p, hub };
        }),
      );
      if (mine === seq.current) setPlaces(withHubs);
    }, 250);
    return () => clearTimeout(timer);
  }, [value, catalog, hubs]);

  const rect = input.current?.getBoundingClientRect();
  return (
    <div className="search">
      <Icon name="search" />
      <input
        ref={input}
        type="search"
        placeholder="Tracking ID, CN, phone or zone…"
        aria-label="Find a parcel by tracking ID, CN or phone (type or scan, then Enter), or type a zone or area to see the hub that serves it"
        autoComplete="off"
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={() => setTimeout(() => setPlaces(null), 200)}
        onKeyDown={e => {
          if (e.key === "Escape") setPlaces(null);
          if (e.key !== "Enter") return;
          e.preventDefault();
          const raw = value.trim();
          if (!raw) return;
          setPlaces(null);
          findParcels(raw)
            .then(found => {
              if (!found.length) return toast(`No parcel found for “${raw}”.`);
              setParams(p => {
                p.set("parcel", found[0].trackingId);
                if (found.length > 1) p.set("matches", found.slice(0, 20).map(f => f.trackingId).join(","));
                else p.delete("matches");
                return p;
              });
              input.current?.select();
            })
            .catch(toastError);
        }}
      />
      {places && rect
        ? createPortal(
            <div className="menu" role="listbox" aria-label="Which hub serves this place" style={{ top: rect.bottom + 8, left: Math.max(12, rect.right - 380), width: "min(380px, calc(100vw - 24px))" }}>
              <div className="section-title" style={{ margin: "4px 8px" }}>
                Which hub serves it
              </div>
              {places.map(p => (
                <div key={`${p.district}|${p.zone}|${p.area}`} className="menu-item" role="option" aria-selected="false" style={{ justifyContent: "space-between", cursor: "default" }}>
                  <span>
                    <strong>{p.area || p.zone}</strong>
                    <br />
                    <small className="faint">{p.area ? `${p.zone}, ${p.district}` : p.district}</small>
                  </span>
                  <span style={{ textAlign: "right" }}>
                    {p.hub ? (
                      <>
                        {p.hub.name}
                        <br />
                        <small className="faint">serves this zone</small>
                      </>
                    ) : (
                      <small className="faint">No hub set for this zone</small>
                    )}
                  </span>
                </div>
              ))}
              <p className="faint" style={{ margin: "6px 8px", fontSize: 12 }}>
                Enter still searches parcels (tracking ID, CN or phone).
              </p>
            </div>,
            document.body,
          )
        : null}
    </div>
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
