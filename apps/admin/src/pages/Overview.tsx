/**
 * Platform overview (01.js overview + bridge.js + bridge-period.js): the period (default This month) drives GMV,
 * bookings, revenue, active merchants and deliveries against the previous period, and the bookings chart; merchant
 * accounts, the approval queue and admins are now. Registration approvals, recently updated merchants (Active ·
 * Suspended · All) and the latest privileged activity.
 */
import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@panel/lib/api";
import { useLive } from "@panel/lib/events";
import { PeriodSelect, usePeriod } from "@panel/lib/period";
import { Icon } from "@panel/ui/Icon";
import { Button, Metric, PageHeading, Panel, Pill, Tabs } from "@panel/ui/kit";
import { toast } from "@panel/ui/toast";
import { auditKind, auditScope, auditTitle, change, contactOf, initials, num, packageLabel, SERVICES, STATUS_LABEL, taka, when, useMerchants, useOverview, useStaff, type AuditEntry, type PeriodFigures } from "@/lib/admin";
import { manageMerchant } from "@/features/merchants";

const OPEN = ["PENDING_REVIEW", "INFO_REQUESTED"];
const AUDIT_ICON = { merchant: "check", rider: "truck", tracking: "search", website: "users", admin: "settings" } as const;

export default function Overview() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const period = usePeriod("admin-overview", "this_month");
  const now = useOverview();
  const figures = useOverview(period.query);
  const merchants = useMerchants();
  const staff = useStaff();
  const audit = useQuery({ queryKey: ["admin", "audit", "latest"], queryFn: () => api<{ items: AuditEntry[] }>("/audit-logs?limit=100"), staleTime: 30_000, refetchInterval: 30_000 });
  const [tab, setTab] = useState<"active" | "suspended" | "all">("active");
  useLive(["parcel.created", "parcel.updated", "merchant.updated"], () => void qc.invalidateQueries({ queryKey: ["admin", "overview"] }), { debounceMs: 5000, fallbackMs: 120_000 });

  const o = now.data;
  const p: PeriodFigures | undefined = figures.data?.period;
  const list = merchants.data ?? [];
  const pending = list.filter(m => OPEN.includes(m.status));
  const accounts = list.filter(m => !OPEN.includes(m.status) && m.status !== "REJECTED");
  const shown = accounts.filter(m => (tab === "active" ? m.status === "ACTIVE" : tab === "suspended" ? m.status !== "ACTIVE" : true));
  const activity = (id: string) => o?.merchantActivity.find(a => a.merchantId === id);
  const groups = o ? Object.values(o.staff.byRole).filter(Boolean).length : 0;
  const today = new Date().toLocaleDateString("en-US", { timeZone: "Asia/Dhaka", weekday: "long", month: "long", day: "numeric", year: "numeric" });

  return (
    <>
      <PageHeading
        eyebrow={`Platform governance · ${today}`}
        title="Super admin overview"
        subtitle={`${period.text} · bookings, revenue and merchant growth for this period; accounts, approvals and admins are now`}
        actions={
          <>
            <PeriodSelect period={period} />
            <Button
              onClick={async () => {
                await qc.invalidateQueries({ queryKey: ["admin"] });
                toast("Platform dashboard refreshed.");
              }}
            >
              ↻ Refresh
            </Button>
            <Button variant="primary" icon="check" onClick={() => navigate("/registrations")}>
              Review registrations
            </Button>
          </>
        }
      />
      <div className="metrics">
        <Metric label="Merchant accounts" icon="box" value={o ? num(o.merchants.active + o.merchants.suspended) : "—"} foot={p ? `${num(p.newMerchants)} new` : o ? `${num(o.merchants.newThisMonth)} new` : ""} note={`${period.words} · accounts now`} />
        <Metric label="Awaiting approval" icon="sheet" value={merchants.data ? num(pending.length) : "—"} foot={`${pending.length} need review`} note="registration queue" onClick={() => navigate("/registrations")} />
        <Metric label="Active platform admins" icon="users" value={o ? num(o.staff.active) : "—"} foot={`${groups} role group${groups === 1 ? "" : "s"}`} note="staff accounts" />
        <Metric label="Platform GMV" icon="chart" value={p ? taka(p.gmv) : "—"} foot={p ? change(p.gmv, p.previous.gmv) : ""} note={`COD + charges · ${period.words}`} />
      </div>
      <div className="metrics">
        <Metric label="Bookings" icon="check" value={p ? num(p.bookings) : "—"} foot={p ? change(p.bookings, p.previous.bookings) : ""} note={period.versus} />
        <Metric label="Revenue" icon="chart" value={p ? taka(p.charges) : "—"} foot={p ? change(p.charges, p.previous.charges) : ""} note={`delivery charges · ${period.words}`} />
        <Metric label="Active merchants" icon="box" value={p ? num(p.activeMerchants) : "—"} foot={p ? change(p.activeMerchants, p.previous.activeMerchants) : ""} note={`booked ${period.words}`} />
        <Metric label="Delivered" icon="check" value={p ? num(p.delivered) : "—"} foot={p ? change(p.delivered, p.previous.delivered) : ""} note={period.words} />
      </div>
      <div className="grid-main" style={{ marginBottom: 16 }}>
        <Panel title="Bookings" subtitle={`Parcels booked per ${p?.series.bucket || "day"} · ${period.text} vs. the previous period`}>
          <div className="panel-body">{p ? <BookingsChart series={p.series} text={period.text} /> : <div className="skeleton" style={{ height: 150 }} />}</div>
        </Panel>
        <Panel
          title="Registration approvals"
          subtitle="New businesses requesting platform access"
          tools={
            <Button size="sm" onClick={() => navigate("/registrations")}>
              View queue
            </Button>
          }
        >
          <div className="panel-body">
            {pending.length ? (
              pending.slice(0, 4).map(r => (
                <div key={r.id} className="row" style={{ gap: 10, padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
                  <span className="avatar">{initials(r.name)}</span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <strong style={{ display: "block" }}>{r.name}</strong>
                    <small className="faint">
                      {r.type === "BANKING_FINANCIAL" ? "Banking & Financial merchant" : "E-commerce"} · {r.pickup?.zone ? `${r.pickup.zone}, ${r.pickupDistrict}` : r.pickupDistrict} · {r.code}
                    </small>
                  </span>
                  <small className="faint nowrap">{when(r.createdAt).split(",")[0]}</small>
                </div>
              ))
            ) : (
              <p className="faint" style={{ textAlign: "center", margin: "40px 0" }}>
                All merchant registrations have been reviewed.
              </p>
            )}
          </div>
        </Panel>
      </div>
      <div className="grid-main">
        <Panel
          title="Recently updated merchants"
          subtitle="Account status and service packages"
          tools={
            <Button size="sm" onClick={() => navigate("/e-commerce-merchants")}>
              Manage merchants
            </Button>
          }
        >
          <div style={{ padding: "12px 16px 10px" }}>
            <Tabs
              label="Accounts"
              value={tab}
              onChange={setTab}
              tabs={[
                { id: "active", label: "Active", count: accounts.filter(m => m.status === "ACTIVE").length },
                { id: "suspended", label: "Suspended", count: accounts.filter(m => m.status !== "ACTIVE").length },
                { id: "all", label: "All", count: accounts.length },
              ]}
            />
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th>Owner</th>
                  <th>Package</th>
                  <th className="num">Shipments MTD</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, 4).map(m => (
                  <tr key={m.id}>
                    <td>
                      <span className="strong">{m.name}</span>
                      <span className="sub">
                        {m.code} · {SERVICES[m.type]}
                      </span>
                    </td>
                    <td>
                      {m.contactName}
                      <span className="sub">{contactOf(m)}</span>
                    </td>
                    <td>{packageLabel(m)}</td>
                    <td className="num">{num(activity(m.id)?.parcelsThisMonth)}</td>
                    <td>
                      <Pill>{STATUS_LABEL[m.status]}</Pill>
                    </td>
                    <td>
                      <Button size="sm" onClick={() => void manageMerchant(m, x => navigate(`/service-plans?tab=${x.type === "BANKING_FINANCIAL" ? "banking" : "e-commerce"}&merchant=${x.code}`))}>
                        Manage
                      </Button>
                    </td>
                  </tr>
                ))}
                {!shown.length ? (
                  <tr>
                    <td colSpan={6} className="faint">
                      {merchants.isLoading ? "Loading…" : "No merchant accounts here."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel
          title="Privileged activity"
          subtitle="Latest platform and admin events"
          tools={
            <Button size="sm" onClick={() => navigate("/audit-log")}>
              Full audit log
            </Button>
          }
        >
          <div className="panel-body">
            {(audit.data?.items ?? []).slice(0, 3).map(a => (
              <div key={a.id} className="row" style={{ gap: 10, alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
                <span className="avatar" style={{ width: 28, height: 28 }}>
                  <Icon name={AUDIT_ICON[auditKind(a) as keyof typeof AUDIT_ICON]} size={14} />
                </span>
                <span>
                  <strong>{auditTitle(a)}</strong> <span className="faint">· {auditScope(a, { merchants: list, staff: staff.data })}</span>
                  <small className="faint" style={{ display: "block" }}>
                    {when(a.createdAt)} · {a.actorLabel || "System"}
                  </small>
                </span>
              </div>
            ))}
            {audit.data && !audit.data.items.length ? <p className="faint">No activity yet.</p> : null}
          </div>
        </Panel>
      </div>
    </>
  );
}

function BookingsChart({ series, text }: { series: PeriodFigures["series"]; text: string }) {
  const W = 680;
  const H = 160;
  const left = 45;
  const right = 665;
  const top = 17;
  const bottom = 130;
  const { current, previous, labels } = series;
  const n = current.length;
  const max = Math.max(4, ...current, ...previous);
  const x = (i: number) => (n === 1 ? left : left + (i * (right - left)) / (n - 1));
  const y = (v: number) => bottom - (v / max) * (bottom - top);
  const path = (values: number[]) => values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const every = Math.max(1, Math.ceil(n / 7));
  const total = current.reduce((a, b) => a + b, 0);
  return (
    <div>
      <div className="row" style={{ gap: 14, fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>
        <span className="row" style={{ gap: 6 }}>
          <i style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--primary)", display: "inline-block" }} /> Bookings
        </span>
        <span className="row" style={{ gap: 6 }}>
          <i style={{ width: 8, height: 8, borderRadius: "50%", background: "#c5cdd8", display: "inline-block" }} /> Previous period
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Bookings per ${series.bucket}, ${text}: ${num(total)} in total`} style={{ width: "100%", height: "auto" }}>
        <defs>
          <linearGradient id="adminFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#1d5fd0" stopOpacity=".13" />
            <stop offset="100%" stopColor="#1d5fd0" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[1, 0.66, 0.33].map(f => (
          <g key={f}>
            <line x1={40} x2={670} y1={y(max * f)} y2={y(max * f)} stroke="var(--line)" />
            <text x={2} y={y(max * f) + 3} fontSize="11" fill="var(--faint)">
              {num(Math.round(max * f))}
            </text>
          </g>
        ))}
        <path d={`${path(current)} L${right} ${bottom} L${left} ${bottom}Z`} fill="url(#adminFill)" />
        <path d={path(previous)} fill="none" stroke="#c5cdd8" strokeWidth="2" strokeDasharray="5 4" />
        <path d={path(current)} fill="none" stroke="var(--primary)" strokeWidth="2" />
        {labels.map((l, i) =>
          i % every === 0 || i === n - 1 ? (
            <text key={i} x={x(i)} y={148} fontSize="11" fill="var(--faint)" textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>
              {l}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}
