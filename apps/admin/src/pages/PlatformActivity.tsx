/**
 * Platform activity (01.js + bridge.js + bridge-security.js + bridge-period.js + bridge-activity.js), in tabs:
 *   Live now            visitors on the website now and their pages, page views per minute (30 min), the latest
 *                       parcels tracked (GET /analytics/live, every 10 s while open)
 *   Website traffic     the period (default Last 7 days): visits, lookups, active merchants, riders on shift (now),
 *                       the traffic chart and sources (GET /analytics/traffic?from&to)
 *   Parcel tracking     parcels tracked per period (GET /analytics/tracking/summary) and the parcels tracked in chosen
 *                       dates, a page at a time (GET /analytics/tracking/parcels); the latest parcels (Tracking history)
 *   Merchants & riders  each merchant's last activity; riders on shift today
 *   User activity       recent events from merchants, riders, the website and admins (the audit log)
 */
import { useState, type FormEvent } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { PeriodSelect, usePeriod } from "@panel/lib/period";
import { Icon } from "@panel/ui/Icon";
import { Button, Metric, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { Select } from "@panel/ui/Select";
import { auditKind, auditScope, auditSource, auditTitle, change, num, SERVICES, STATUS_LABEL, when, useMerchants, useOverview, useStaff, type AuditEntry } from "@/lib/admin";

type Tab = "live" | "traffic" | "tracking" | "people" | "activity";
const TAB_KEY = "df-activity-tab";
const TABS: [Tab, string][] = [
  ["live", "Live now"],
  ["traffic", "Website traffic"],
  ["tracking", "Parcel tracking"],
  ["people", "Merchants & riders"],
  ["activity", "User activity"],
];
const today = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
const dhakaDate = (iso: string) => new Date(new Date(iso).getTime() + 6 * 3600_000).toISOString().slice(0, 10);
const time = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Dhaka" }) : "—");
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Dhaka" });
const ago = (iso: string) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : time(iso);
};
const statusTone = (s: string) => (/Delivered/.test(s) ? "good" : /Return|Cancel|Fail|Exception|Deleted/.test(s) ? "bad" : undefined);
const Dot = () => <i style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#12b76a", boxShadow: "0 0 0 3px #12b76a33" }} />;

export default function PlatformActivity() {
  const [tab, setTabState] = useState<Tab>(() => {
    try {
      return (sessionStorage.getItem(TAB_KEY) as Tab) || "live";
    } catch {
      return "live";
    }
  });
  const setTab = (t: Tab) => {
    setTabState(t);
    try {
      sessionStorage.setItem(TAB_KEY, t);
    } catch {
      /* storage blocked */
    }
  };
  const period = usePeriod("admin-activity", "last_7_days");
  return (
    <>
      <PageHeading
        eyebrow="Platform insights · First-party analytics"
        title="Platform activity"
        subtitle={tab === "traffic" ? `${period.text} · website traffic, tracking lookups and active merchants for this period; riders on shift is now` : "A cross-platform view of merchant usage, website traffic, tracking events, rider operations, and user activity."}
        actions={tab === "traffic" ? <PeriodSelect period={period} /> : null}
      />
      <div className="seg-tabs" role="tablist" aria-label="Platform activity" style={{ marginBottom: 16 }}>
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {id === "live" ? <Dot /> : null}
            {label}
          </button>
        ))}
      </div>
      {tab === "live" ? <Live openTracking={() => setTab("tracking")} /> : tab === "traffic" ? <Traffic period={period} /> : tab === "tracking" ? <Tracking /> : tab === "people" ? <People /> : <UserActivity />}
    </>
  );
}

// ───────────── Live now ─────────────
interface LiveData {
  at: string;
  online: number;
  perMinute: { minute: string; pageviews: number }[];
  pages: { path: string; visitors: number }[];
  lookupsLastHour: number;
  today: { visits: number; pageviews: number; trackingLookups: number };
  recentLookups: { trackingId?: string | null; status: string; via: string; at: string }[];
}
function Live({ openTracking }: { openTracking: () => void }) {
  const q = useQuery({ queryKey: ["admin", "analytics-live"], queryFn: () => api<LiveData>("/analytics/live"), refetchInterval: () => (document.visibilityState === "visible" ? 10_000 : false) });
  const l = q.data;
  if (!l) return <div className="panel panel-body faint">{q.error ? describe(q.error) : "Loading live traffic…"}</div>;
  const last30 = l.perMinute.reduce((a, m) => a + m.pageviews, 0);
  const max = Math.max(1, ...l.perMinute.map(m => m.pageviews));
  const pagesMax = Math.max(1, ...l.pages.map(p => p.visitors));
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="metrics" style={{ margin: 0 }}>
        <Metric label="Visitors on the website now" value={<span className="row" style={{ gap: 10, color: "#067647" }}><Dot />{num(l.online)}</span>} foot={`updated ${clock(l.at)}`} note="every 10 s" />
        <Metric label="Page views · last 30 min" value={num(last30)} foot={`${num(l.perMinute.at(-1)?.pageviews)} this minute`} />
        <Metric label="Parcels tracked · last hour" value={num(l.lookupsLastHour)} foot="on the website" />
        <Metric label="Today so far" value={num(l.today.visits)} foot={`visits · ${num(l.today.pageviews)} page views`} note={`${num(l.today.trackingLookups)} lookups`} />
      </div>
      <div className="grid-main">
        <Panel title="Page views per minute" subtitle="The last 30 minutes · the newest minute in dark blue">
          <div role="img" aria-label={`Page views per minute, last 30 minutes: ${num(last30)}`} style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 130, padding: "10px 16px 4px" }}>
            {l.perMinute.map((m, i) => (
              <i key={m.minute} title={`${clock(m.minute)} · ${num(m.pageviews)} page views`} style={{ flex: 1, minHeight: 2, height: `${Math.max(2, Math.round((m.pageviews / max) * 100))}%`, background: i === l.perMinute.length - 1 ? "var(--primary)" : "#c7d7fe", borderRadius: "3px 3px 0 0" }} />
            ))}
          </div>
          <div className="row faint" style={{ justifyContent: "space-between", padding: "0 16px 12px", fontSize: 11 }}>
            <span>{clock(l.perMinute[0].minute)}</span>
            <span>{clock(l.perMinute[Math.min(15, l.perMinute.length - 1)].minute)}</span>
            <span>now</span>
          </div>
        </Panel>
        <Panel title="Pages open right now" subtitle={`${num(l.online)} visitor${l.online === 1 ? "" : "s"} · by page`}>
          <div className="panel-body" style={{ display: "grid", gap: 8 }}>
            {l.pages.length ? (
              l.pages.map(p => (
                <div key={p.path} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 120px 40px", gap: 10, alignItems: "center", fontSize: 13 }}>
                  <span title={p.path} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.path}
                  </span>
                  <span style={{ height: 8, borderRadius: 99, background: "var(--surface-3, #eef1f5)", overflow: "hidden" }}>
                    <i style={{ display: "block", height: "100%", width: `${Math.round((p.visitors / pagesMax) * 100)}%`, background: "var(--primary)", borderRadius: 99 }} />
                  </span>
                  <strong style={{ textAlign: "right" }}>{num(p.visitors)}</strong>
                </div>
              ))
            ) : (
              <p className="faint" style={{ margin: 0 }}>
                Nobody is on the website right now.
              </p>
            )}
          </div>
        </Panel>
      </div>
      <Panel
        title="Latest parcels tracked"
        subtitle="Tracking lookups on the website, newest first · all of them in Parcel tracking"
        tools={
          <Button size="sm" onClick={openTracking}>
            Open Parcel tracking
          </Button>
        }
      >
        {l.recentLookups.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Parcel</th>
                  <th>Status</th>
                  <th>How</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {l.recentLookups.map((r, i) => (
                  <tr key={i}>
                    <td className="strong">{r.trackingId || "—"}</td>
                    <td>
                      <Pill tone={statusTone(r.status)}>{r.status}</Pill>
                    </td>
                    <td>{r.via === "link" ? "SMS link" : "Searched"}</td>
                    <td title={time(r.at)}>{ago(r.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="panel-body faint">No parcel has been tracked on the website yet.</p>
        )}
      </Panel>
      <p className="faint" style={{ margin: 0 }}>
        Visitors who accepted analytics cookies are counted (an open tab says it is there every 30 seconds; nothing about the visitor is stored). Bots are left out.
      </p>
    </div>
  );
}

// ───────────── Website traffic ─────────────
interface Traffic {
  period: { visits: number; pageviews: number; trackingLookups: number };
  previousPeriod: { visits: number; trackingLookups: number };
  hourlyScope?: string;
  hourly: { hour: string; visits: number; pageviews: number }[];
  daily: { day: string; visits: number; pageviews: number }[];
  sources: { key: string; count: number }[];
}
function Traffic({ period }: { period: ReturnType<typeof usePeriod> }) {
  const t = useQuery({ queryKey: ["admin", "traffic", period.query], queryFn: () => api<Traffic>(`/analytics/traffic?${period.query}`), placeholderData: keepPreviousData });
  const o = useOverview(period.query);
  const now = useOverview();
  const d = t.data;
  const hourly = d?.hourlyScope === "day";
  let points: { label: string; visits: number; pageviews: number }[] = [];
  if (d) {
    if (hourly) points = d.hourly.map(h => ({ label: new Date(h.hour).toLocaleTimeString("en-US", { timeZone: "Asia/Dhaka", hour: "numeric" }), visits: h.visits, pageviews: h.pageviews }));
    else if (d.daily.length > 62) {
      const months = new Map<string, { label: string; visits: number; pageviews: number }>();
      for (const x of d.daily) {
        const key = x.day.slice(0, 7);
        const m = months.get(key) || { label: new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }), visits: 0, pageviews: 0 };
        m.visits += x.visits;
        m.pageviews += x.pageviews;
        months.set(key, m);
      }
      points = [...months.values()];
    } else points = d.daily.map(x => ({ label: new Date(`${x.day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }), visits: x.visits, pageviews: x.pageviews }));
  }
  const max = Math.max(1, ...points.map(p => p.visits));
  const every = Math.max(1, Math.ceil(points.length / 7));
  const total = d ? d.sources.reduce((a, x) => a + x.count, 0) : 0;
  const r = now.data?.riders;
  const activeToday = now.data ? now.data.merchantActivity.filter(a => a.lastParcelAt && new Date(a.lastParcelAt) >= new Date(now.data!.periodStarts.today)).length : 0;
  return (
    <>
      <div className="metrics">
        <Metric label="Website visits" icon="chart" value={d ? num(d.period.visits) : "—"} foot={d ? change(d.period.visits, d.previousPeriod.visits) : ""} note={d ? `${num(d.period.pageviews)} page views · ${period.words}` : ""} />
        <Metric label="Tracking lookups" icon="search" value={d ? num(d.period.trackingLookups) : "—"} foot={d ? change(d.period.trackingLookups, d.previousPeriod.trackingLookups) : ""} note={period.words} />
        <Metric label="Active merchants" icon="box" value={o.data?.period ? num(o.data.period.activeMerchants) : "—"} foot={o.data?.period ? `${num(o.data.period.bookings)} bookings` : `${activeToday} active today`} note={`booked ${period.words}`} />
        <Metric label="Riders on shift" icon="truck" value={r ? num(r.online + r.onBreak) : "—"} foot={r ? `${num(r.online)} currently online` : ""} note="rider activity · now" />
      </div>
      <Panel title="Website traffic" subtitle={`Visits across the public site · ${hourly ? `${period.text}, by hour` : period.text}`} tools={d ? <Pill>{`${num(d.period.visits)} visits`}</Pill> : null}>
        <div className="panel-body">
          <div role="img" aria-label={`Website visits by ${hourly ? "hour" : points.length === d?.daily.length ? "day" : "month"}, ${period.text}: ${num(d?.period.visits)} in total`} style={{ display: "flex", alignItems: "flex-end", gap: points.length > 31 ? 2 : 4, height: 150 }}>
            {points.map((p, i) => (
              <span key={i} title={`${p.label} · ${num(p.visits)} visits · ${num(p.pageviews)} page views`} style={{ flex: 1, height: `${Math.max(4, Math.round((p.visits / max) * 100))}%`, background: "var(--primary)", opacity: 0.8, borderRadius: "4px 4px 0 0" }} />
            ))}
          </div>
          <div className="row faint" style={{ justifyContent: "space-between", fontSize: 11, marginTop: 6 }}>
            {points.filter((_, i) => i % every === 0 || i === points.length - 1).map((p, i) => (
              <span key={i}>{p.label}</span>
            ))}
          </div>
          <div style={{ display: "grid", gap: 8, marginTop: 16, maxWidth: 520 }}>
            {(["direct", "search", "social", "referral"] as const).map(key => {
              const count = d?.sources.find(x => x.key === key)?.count || 0;
              const share = total ? Math.round((count / total) * 100) : 0;
              return (
                <div key={key} style={{ display: "grid", gridTemplateColumns: "90px 1fr 44px", gap: 10, alignItems: "center", fontSize: 13 }}>
                  <span>{{ direct: "Direct", search: "Search", social: "Social", referral: "Referral" }[key]}</span>
                  <span style={{ height: 8, borderRadius: 99, background: "var(--surface-3, #eef1f5)", overflow: "hidden" }}>
                    <i style={{ display: "block", height: "100%", width: `${share}%`, background: "var(--primary)" }} />
                  </span>
                  <strong style={{ textAlign: "right" }}>{share}%</strong>
                </div>
              );
            })}
          </div>
        </div>
      </Panel>
      <p className="faint">Website traffic comes from the site's own page-view counts (no cookies, bots excluded). Merchant, rider, tracking and user activity are live.</p>
    </>
  );
}

// ───────────── Parcel tracking ─────────────
const PERIODS: [string, string][] = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["thisWeek", "This week"],
  ["lastWeek", "Last week"],
  ["thisMonth", "This month"],
  ["lastMonth", "Last month"],
  ["last30Days", "Last 30 days"],
  ["thisYear", "This year"],
  ["allTime", "All time"],
];
interface Summary {
  periods: Record<string, { parcels: number; lookups: number; from?: string | null; to?: string | null }>;
}
interface TrackedList {
  items: { trackingId: string; bookedAt: string; sender?: string; recipient?: string; destination: string; status: string; lookups: number; fromLink?: number; firstAt: string; lastAt: string }[];
  total: number;
  lookups: number;
  page: number;
  pages: number;
}
interface ParcelRow {
  trackingId: string;
  sender: { name: string };
  statusLabel: string;
  delivery: { label: string };
  updatedAt: string;
  pickupRider?: { label?: string } | null;
  deliveryRider?: { label?: string } | null;
}
function Tracking() {
  const summary = useQuery({ queryKey: ["admin", "tracking-summary"], queryFn: () => api<Summary>("/analytics/tracking/summary") });
  const [L, setL] = useState({ period: "today", from: today(), to: today(), q: "", page: 1, limit: 25 });
  const [draft, setDraft] = useState({ from: L.from, to: L.to, q: "" });
  const list = useQuery({
    queryKey: ["admin", "tracking-list", L.from, L.to, L.q, L.page, L.limit],
    queryFn: () => api<TrackedList>(`/analytics/tracking/parcels?${new URLSearchParams({ from: L.from, to: L.to, page: String(L.page), limit: String(L.limit), ...(L.q ? { q: L.q } : {}) })}`),
    placeholderData: keepPreviousData,
  });
  const latest = useQuery({ queryKey: ["admin", "parcels-latest"], queryFn: async () => (await api<{ items: ParcelRow[] }>("/parcels?limit=50")).items });
  const choose = (key: string) => {
    const p = summary.data?.periods[key];
    const from = p?.from ? dhakaDate(p.from) : "2020-01-01";
    const to = p?.to ? dhakaDate(new Date(new Date(p.to).getTime() - 1).toISOString()) : today();
    setL({ ...L, period: key, from, to, page: 1 });
    setDraft({ ...draft, from, to });
  };
  function submit(e: FormEvent) {
    e.preventDefault();
    const from = draft.from || today();
    let to = draft.to || from;
    if (to < from) to = from;
    const period =
      PERIODS.find(([key]) => {
        const p = summary.data?.periods[key];
        return p?.from && dhakaDate(p.from) === from && (p.to ? dhakaDate(new Date(new Date(p.to).getTime() - 1).toISOString()) : today()) === to;
      })?.[0] || "";
    setL({ ...L, period, from, to, q: draft.q.trim(), page: 1 });
  }
  const d = list.data;
  const empty = list.error ? describe(list.error) : list.isLoading ? "Loading…" : L.q ? "No tracked parcel matches." : "No parcel was tracked on the website in these dates.";
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        {PERIODS.map(([key, label]) => {
          const p = summary.data?.periods[key];
          return (
            <button key={key} type="button" className="metric" onClick={() => choose(key)} style={L.period === key ? { borderColor: "var(--primary)", boxShadow: "0 0 0 2px var(--primary-soft)" } : undefined}>
              <div className="metric-head">
                <span>{label}</span>
              </div>
              <div className="metric-value">{p ? num(p.parcels) : "…"}</div>
              <div className="metric-foot">
                <span>{p ? `parcels · ${num(p.lookups)} lookup${p.lookups === 1 ? "" : "s"}` : "loading"}</span>
              </div>
            </button>
          );
        })}
      </div>
      <Panel
        title="Parcels tracked on the website"
        subtitle="Each parcel once, with how often it was tracked · latest first · choose a card above or your own dates"
        tools={
          <form className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }} onSubmit={submit}>
            <label className="field">
              <span>From</span>
              <input className="input sm" type="date" value={draft.from} onChange={e => setDraft({ ...draft, from: e.target.value })} />
            </label>
            <label className="field">
              <span>To</span>
              <input className="input sm" type="date" value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })} />
            </label>
            <label className="field">
              <span>Search</span>
              <input className="input sm" type="search" placeholder="Tracking ID, sender, recipient" value={draft.q} onChange={e => setDraft({ ...draft, q: e.target.value })} />
            </label>
            <Button type="submit" size="sm" variant="primary">
              Show
            </Button>
          </form>
        }
        footer={
          d ? (
            <>
              <span>{`${num(d.total)} parcel${d.total === 1 ? "" : "s"} · ${num(d.lookups)} lookup${d.lookups === 1 ? "" : "s"}`}</span>
              <span className="row" style={{ gap: 8 }}>
                <label className="row" style={{ gap: 6 }}>
                  Rows
                  <Select className="select sm" value={L.limit} onChange={e => setL({ ...L, limit: Number(e.target.value) || 25, page: 1 })}>
                    {[25, 50, 100].map(n => (
                      <option key={n}>{n}</option>
                    ))}
                  </Select>
                </label>
                <Button size="sm" disabled={d.page <= 1} onClick={() => setL({ ...L, page: d.page - 1 })}>
                  ‹ Previous
                </Button>
                <span>
                  Page {num(d.page)} of {num(d.pages)}
                </span>
                <Button size="sm" disabled={d.page >= d.pages} onClick={() => setL({ ...L, page: d.page + 1 })}>
                  Next ›
                </Button>
              </span>
            </>
          ) : null
        }
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Parcel</th>
                <th>Sender</th>
                <th>Recipient</th>
                <th>Status now</th>
                <th className="num">Times tracked</th>
                <th>First tracked</th>
                <th>Last tracked</th>
              </tr>
            </thead>
            <tbody>
              {(d?.items ?? []).map(r => (
                <tr key={r.trackingId}>
                  <td>
                    <a href={`/track/${encodeURIComponent(r.trackingId)}`} target="_blank" rel="noopener">
                      <strong>{r.trackingId}</strong>
                    </a>
                    <span className="sub">booked {time(r.bookedAt)}</span>
                  </td>
                  <td>{r.sender || "—"}</td>
                  <td>
                    {r.recipient || "—"}
                    <span className="sub">{r.destination}</span>
                  </td>
                  <td>
                    <Pill tone={statusTone(r.status)}>{r.status}</Pill>
                  </td>
                  <td className="num">
                    <strong>{num(r.lookups)}</strong>
                    {r.fromLink ? <span className="sub">{num(r.fromLink)} by SMS link</span> : null}
                  </td>
                  <td>{time(r.firstAt)}</td>
                  <td>
                    {time(r.lastAt)}
                    <span className="sub">{ago(r.lastAt)}</span>
                  </td>
                </tr>
              ))}
              {!d?.items.length ? (
                <tr>
                  <td colSpan={7} className="faint" style={{ textAlign: "center" }}>
                    {empty}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="Tracking history" subtitle="Latest scans and public lookup activity across parcel types" tools={<Pill>{`${(latest.data ?? []).slice(0, 12).length} recent records`}</Pill>}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Tracking ID</th>
                <th>Merchant / sender</th>
                <th>Rider</th>
                <th>Status</th>
                <th>Last location</th>
                <th>Last update</th>
              </tr>
            </thead>
            <tbody>
              {(latest.data ?? []).slice(0, 12).map(p => (
                <tr key={p.trackingId}>
                  <td className="strong">{p.trackingId}</td>
                  <td>{p.sender?.name}</td>
                  <td>{p.deliveryRider?.label || p.pickupRider?.label || "—"}</td>
                  <td>
                    <Pill tone={statusTone(p.statusLabel)}>{p.statusLabel}</Pill>
                  </td>
                  <td>{p.delivery?.label}</td>
                  <td>{when(p.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

// ───────────── Merchants & riders ─────────────
interface Rider {
  id: string;
  code: string;
  name: string;
  status: string;
  active: boolean;
  hub?: { name: string } | null;
  zone?: string | null;
  openTasks?: number;
}
const SHIFT: Record<string, string> = { ONLINE: "Online", ON_BREAK: "On break", OFFLINE: "Offline" };
function People() {
  const merchants = useMerchants();
  const overview = useOverview();
  const riders = useQuery({ queryKey: ["admin", "riders"], queryFn: () => api<Rider[]>("/riders"), refetchInterval: 30_000 });
  const OPEN = ["PENDING_REVIEW", "INFO_REQUESTED", "REJECTED"];
  const accounts = (merchants.data ?? []).filter(m => !OPEN.includes(m.status));
  const act = (id: string) => overview.data?.merchantActivity.find(a => a.merchantId === id);
  const today = (id: string) => overview.data?.riderActivity.find(r => r.riderId === id);
  const active = (riders.data ?? []).filter(r => r.active);
  return (
    <>
      <Panel title="Merchant last activity" subtitle="Latest sign-in or workspace action for each merchant" tools={<Pill>{`${accounts.length} merchant accounts`}</Pill>}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Merchant</th>
                <th>Last user</th>
                <th>Recent action</th>
                <th>Last activity</th>
                <th>Account</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map(m => {
                const a = act(m.id);
                return (
                  <tr key={m.id}>
                    <td>
                      <span className="strong">{m.name}</span>
                      <span className="sub">
                        {m.code} · {SERVICES[m.type]}
                      </span>
                    </td>
                    <td>{m.contactName}</td>
                    <td>{`${num(a?.parcelsThisMonth)} shipments this month`}</td>
                    <td>{a?.lastParcelAt ? when(a.lastParcelAt) : "No parcels yet"}</td>
                    <td>
                      <Pill>{STATUS_LABEL[m.status]}</Pill>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
      <div style={{ height: 16 }} />
      <Panel title="Rider activity" subtitle="Current shift and latest delivery or pickup event" tools={overview.data ? <Pill>{`${num(overview.data.riders.active)} riders active`}</Pill> : null}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Rider</th>
                <th>Shift</th>
                <th>Last location</th>
                <th>Last event</th>
                <th>Today</th>
              </tr>
            </thead>
            <tbody>
              {active.map(r => {
                const t = today(r.id);
                const shift = SHIFT[r.status] || r.status;
                return (
                  <tr key={r.id}>
                    <td>
                      <span className="strong">{r.name}</span>
                      <span className="sub">{r.code}</span>
                    </td>
                    <td>
                      <Pill tone={shift === "Online" ? "good" : shift === "On break" ? "warn" : undefined}>{shift}</Pill>
                    </td>
                    <td>{[r.hub?.name, r.zone].filter(Boolean).join(" · ") || "No hub"}</td>
                    <td>{`${num(r.openTasks)} open tasks`}</td>
                    <td>{`${num(t?.deliveredToday)} deliveries · ${num(t?.pickedUpToday)} pickups`}</td>
                  </tr>
                );
              })}
              {riders.data && !active.length ? (
                <tr>
                  <td colSpan={5} className="faint" style={{ textAlign: "center" }}>
                    No active riders.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

// ───────────── User activity ─────────────
const KIND_ICON = { merchant: "box", rider: "truck", tracking: "search", website: "users", admin: "settings" } as const;
function UserActivity() {
  const audit = useQuery({ queryKey: ["admin", "audit", "latest"], queryFn: () => api<{ items: AuditEntry[] }>("/audit-logs?limit=100"), refetchInterval: 30_000 });
  const merchants = useMerchants();
  const staff = useStaff();
  const [kind, setKind] = useState("");
  const [search, setSearch] = useState("");
  const events = (audit.data?.items ?? []).slice(0, 12).map(a => {
    const k = auditKind(a);
    return { id: a.id, kind: k, actor: a.actorLabel || "System", action: `${auditTitle(a).replace(/^./, c => c.toLowerCase())} · ${auditScope(a, { merchants: merchants.data, staff: staff.data })}`, time: when(a.createdAt), source: auditSource(a) };
  });
  const q = search.toLowerCase();
  const shown = events.filter(e => (!kind || e.kind === kind) && `${e.actor} ${e.action} ${e.source} ${e.time}`.toLowerCase().includes(q));
  return (
    <Panel
      title="Platform user activity"
      subtitle="Recent events from merchant, rider, website, and admin users"
      tools={
        <>
          <Select className="select sm" aria-label="Filter activity type" value={kind} onChange={e => setKind(e.target.value)}>
            <option value="">All activity</option>
            <option value="merchant">Merchants</option>
            <option value="rider">Riders</option>
            <option value="tracking">Tracking</option>
            <option value="website">Website & customers</option>
            <option value="admin">Platform admins</option>
          </Select>
          <input className="input sm" type="search" placeholder="Search activities..." aria-label="Search platform activity" value={search} onChange={e => setSearch(e.target.value)} />
        </>
      }
      footer={<span>Showing {events.length} recent events</span>}
    >
      <div className="panel-body" style={{ display: "grid", gap: 0 }}>
        {shown.map(e => (
          <div key={e.id} className="row" style={{ gap: 10, alignItems: "flex-start", padding: "9px 0", borderBottom: "1px solid var(--line)" }}>
            <span className="avatar" style={{ width: 28, height: 28 }}>
              <Icon name={KIND_ICON[e.kind as keyof typeof KIND_ICON]} size={14} />
            </span>
            <span className="grow">
              <strong>{e.actor}</strong> {e.action}
              <small className="faint" style={{ display: "block" }}>
                {e.source}
              </small>
            </span>
            <small className="faint nowrap">{e.time}</small>
          </div>
        ))}
        {!shown.length ? <p className="faint">{audit.isLoading ? "Loading…" : "No activity."}</p> : null}
      </div>
    </Panel>
  );
}
