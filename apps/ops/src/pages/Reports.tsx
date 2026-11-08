/**
 * Reports (bridge-reports.js, bridge-period.js analytics, bridge-pages.js Analytics, bridge-sla.js,
 * bridge-rider-report.js, bridge-hub-transfer-report.js):
 *   Reports              run a report (delivery summary, SLA by zone, COD by rider, rider performance) → table, CSV, PDF;
 *                        scan compliance; scheduled reports (emailed); recent runs (?report=<run> opens one)
 *   Analytics & SLA      service levels for the period vs this month and last month; SLA cards, alerts (acknowledge,
 *                        check now), SLA report (CSV, PDF), SLA policies (hub managers)
 *   Rider report         per rider for Dhaka days: pickups, deliveries, failures, COD collected / handed in / held,
 *                        last position, parcels, CSV
 *   Hub transfer report  parcels moved hub to hub by route and by hub, with parcels and CSV
 */
import { Select } from "@panel/ui/Select";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { saveCsv } from "@panel/lib/csv";
import { useLive } from "@panel/lib/events";
import { dayKey, localPhone, num, when } from "@panel/lib/format";
import { useOps } from "@/lib/ops";
import { PeriodSelect, usePeriod } from "@panel/lib/period";
import { Button, Metric, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { confirm, openForm, prompt } from "@panel/ui/dialogs";
import { toast } from "@panel/ui/toast";
import ViewTabs from "@/app/ViewTabs";
import { openDocument, resolveException } from "@/features/parcels/actions";
import { useParcelActions } from "@/features/parcels/useParcelActions";
import { useCatalog } from "@/features/parcels/search";
import type { Parcel } from "@/features/parcels/model";

const KINDS: Record<string, string> = { DELIVERIES: "Delivery summary", SLA: "SLA attainment by zone", COD: "COD by rider", RIDERS: "Rider performance" };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dhakaToday = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
const tk = (n: unknown) => `৳${Number(n || 0).toLocaleString("en-BD", { maximumFractionDigits: 2 })}`;
const time = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Dhaka" }) : "—");
const Compliance = ({ v }: { v: number | null | undefined }) => (v == null ? <Pill tone="neutral">—</Pill> : <Pill tone={v >= 95 ? "good" : v >= 80 ? "warn" : "bad"}>{`${v}%`}</Pill>);
const Zero = ({ v }: { v: unknown }) => (v ? <>{String(v)}</> : <span className="faint">0</span>);

export default function Reports({ tab }: { tab: string }) {
  const tabs = <ViewTabs view="Reports" tab={tab} />;
  if (tab === "Analytics & SLA") return <Analytics tabs={tabs} />;
  if (tab === "Rider report") return <RiderReport tabs={tabs} />;
  if (tab === "Hub transfer report") return <HubTransferReport tabs={tabs} />;
  return <RunReports tabs={tabs} />;
}

// ───────────── Reports ─────────────

interface ReportTable {
  title: string;
  kind: string;
  from: string;
  to: string;
  hub?: { name: string } | null;
  header: string[];
  rows: (string | number | null)[][];
}
interface Schedule {
  id: string;
  name: string;
  kind: string;
  frequency: "DAILY" | "WEEKLY";
  weekday?: number | null;
  hour: number;
  recipients: string[];
  hubId?: string | null;
  active: boolean;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
}

function RunReports({ tabs }: { tabs: ReactNode }) {
  const ops = useOps();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const hubs = ops.myHubs || ops.hubs;
  const [form, setForm] = useState({ kind: "DELIVERIES", from: dayKey(new Date(Date.now() - 6 * 86400000)), to: dayKey(), hubId: ops.myHubs?.[0]?.id || "" });
  const [result, setResult] = useState<{ run: { id: string }; table: ReportTable } | null>(null);
  const [allHubs, setAllHubs] = useState(false);
  const runs = useQuery({ queryKey: ["reports", "runs"], queryFn: async () => (await api<{ items: { id: string; kind: string; schedule?: { name: string } | null; periodStart: string; periodEnd: string; rowCount: number; status: string; createdAt: string; error?: string }[] }>("/reports/runs?limit=20")).items });
  const schedules = useQuery({ queryKey: ["reports", "schedules"], queryFn: async () => (await api<{ items: Schedule[] }>("/reports/schedules?limit=100")).items });
  const compliance = useQuery({
    queryKey: ["reports", "compliance", form.from, form.to, form.hubId],
    queryFn: () =>
      api<{
        totals: { scans: number; camera: number; refused: number; hubCompliance: number | null; riderCompliance: number | null };
        hubs: { hub: { name: string }; expected: number; scanned: number; missed: number; camera: number; compliance: number | null }[];
        riders: { rider: { label: string }; pickups: { scanned: number; expected: number }; deliveries: { scanned: number; expected: number }; compliance: number | null }[];
      }>(`/scans/compliance?from=${form.from}&to=${form.to}${form.hubId ? `&hubId=${form.hubId}` : ""}`),
  });
  const reload = () => void qc.invalidateQueries({ queryKey: ["reports"] });

  async function downloadRun(id: string) {
    const r = await api<{ kind: string; periodStart: string; csv: string }>(`/reports/runs/${id}`);
    const blob = new Blob([r.csv.startsWith("﻿") ? r.csv : `﻿${r.csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement("a"), { href: url, download: `delivery-fast-${r.kind.toLowerCase()}-${dayKey(r.periodStart)}.csv` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  // The scheduled-report email links to ?report=<run id>.
  useEffect(() => {
    const id = params.get("report");
    if (!id) return;
    void downloadRun(id).catch(e => toast(describe(e), "bad"));
    setParams(p => (p.delete("report"), p), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function scheduleDialog(x?: Schedule) {
    if (!ops.require("manageHubs", "schedule reports")) return;
    void openForm({
      title: x ? `Edit · ${x.name}` : "Schedule a report",
      description: "Recipients get an email with a link to the report (they sign in to open it).",
      submit: x ? "Save" : "Schedule",
      wide: true,
      fields: [
        { id: "name", label: "Name", required: true, maxLength: 120, value: x?.name, placeholder: "e.g. Daily delivery summary", full: true },
        ...(x ? [{ id: "kindStatic", label: "Report", type: "static" as const, value: KINDS[x.kind] }] : [{ id: "kind", label: "Report", type: "select" as const, required: true, value: "DELIVERIES", options: Object.entries(KINDS).map(([value, label]) => ({ value, label })) }]),
        { id: "frequency", label: "Frequency", type: "select", required: true, value: x?.frequency || "DAILY", options: [{ value: "DAILY", label: "Daily" }, { value: "WEEKLY", label: "Weekly" }] },
        { id: "weekday", label: "Day (weekly)", type: "select", required: true, value: String(x?.weekday ?? 0), options: DAYS.map((d, i) => ({ value: String(i), label: d })), show: v => v.frequency === "WEEKLY" },
        { id: "hour", label: "Hour (Dhaka, 0–23)", type: "number", min: 0, max: 23, required: true, value: x?.hour ?? 8 },
        { id: "hubId", label: "Hub", type: "select", value: x?.hubId || "", options: ops.hubs.map(h => ({ value: h.id, label: h.name })), hint: "Empty: the whole network." },
        { id: "active", label: "Status", type: "select", required: true, value: String(x?.active ?? true), options: [{ value: "true", label: "Active" }, { value: "false", label: "Paused" }] },
        { id: "recipients", label: "Recipients (emails, comma separated)", required: true, value: x?.recipients.join(", ") || "", full: true },
      ],
      validate: {
        name: v => (v.length < 2 ? "Name the report" : ""),
        hour: v => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 23 ? "" : "Use an hour from 0 to 23"),
        recipients: v => {
          const emails = v.split(/[,;\s]+/).filter(Boolean);
          return !emails.length ? "Add at least one email" : emails.some(e => !/^\S+@\S+\.\S+$/.test(e)) ? "Check the email addresses" : "";
        },
      },
      onSubmit: async v => {
        const weekly = v.frequency === "WEEKLY";
        const body = {
          name: v.name,
          frequency: v.frequency,
          weekday: weekly ? Number(v.weekday) : x ? null : undefined,
          hour: Number(v.hour),
          recipients: v.recipients.split(/[,;\s]+/).filter(Boolean),
          hubId: v.hubId || (x ? null : undefined),
          active: v.active === "true",
          ...(x ? {} : { kind: v.kind }),
        };
        await api(x ? `/reports/schedules/${x.id}` : "/reports/schedules", { method: x ? "PATCH" : "POST", body });
        reload();
        return `Report ${x ? "saved" : "scheduled"}.`;
      },
    });
  }

  const c = compliance.data;
  const sortedHubs = [...(c?.hubs || [])].sort((a, b) => b.expected - a.expected || a.hub.name.localeCompare(b.hub.name));
  const active = sortedHubs.filter(h => h.expected > 0 || h.scanned > 0);
  const shownHubs = allHubs ? sortedHubs : active;
  const idle = sortedHubs.length - active.length;
  const t = result?.table;
  return (
    <>
      <PageHeading
        eyebrow="Network operations · reporting"
        title="Reports"
        subtitle="Delivery, SLA, COD and rider reports as Excel-compatible CSV or printable PDF, emailed on a schedule."
        actions={
          ops.can("manageHubs") ? (
            <Button variant="primary" icon="plus" onClick={() => scheduleDialog()}>
              Schedule a report
            </Button>
          ) : null
        }
      />
      {tabs}
      <div className="stack-lg">
        <Panel title="Run a report" subtitle="Dhaka calendar days, up to 92 days at a time.">
          <form
            className="panel-body"
            style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, alignItems: "end" }}
            onSubmit={e => e.preventDefault()}
          >
            <label className="field">
              <span>Report</span>
              <Select className="select" value={form.kind} onChange={e => setForm(f => ({ ...f, kind: e.target.value }))}>
                {Object.entries(KINDS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </label>
            <label className="field">
              <span>From</span>
              <input className="input" type="date" value={form.from} onChange={e => setForm(f => ({ ...f, from: e.target.value }))} />
            </label>
            <label className="field">
              <span>To</span>
              <input className="input" type="date" value={form.to} onChange={e => setForm(f => ({ ...f, to: e.target.value }))} />
            </label>
            <label className="field">
              <span>Hub</span>
              <Select className="select" value={form.hubId} onChange={e => setForm(f => ({ ...f, hubId: e.target.value }))}>
                {ops.myHubs ? null : <option value="">Whole network</option>}
                {hubs.map(h => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </Select>
            </label>
            <Button
              variant="primary"
              type="submit"
              onClick={async () => {
                if (form.from > form.to) return toast("Choose a start date on or before the end date.");
                setResult(await api("/reports/run", { method: "POST", body: { kind: form.kind, from: form.from, to: form.to, hubId: form.hubId || undefined } }));
                reload();
              }}
            >
              Run report
            </Button>
          </form>
        </Panel>
        {t && result ? (
          <Panel
            title={t.title}
            subtitle={`${t.from} to ${t.to} · ${t.hub?.name || "Whole network"} · ${t.rows.length} row(s)`}
            tools={
              <>
                <Button size="sm" icon="download" onClick={() => saveCsv(`delivery-fast-${t.kind.toLowerCase()}-${t.from}-to-${t.to}.csv`, [t.header, ...t.rows])}>
                  Excel (CSV)
                </Button>
                <Button size="sm" icon="print" onClick={() => openDocument(`/documents/report/${result.run.id}`, { title: "Preparing the report…" })}>
                  Print / PDF
                </Button>
                <Button size="sm" onClick={() => setResult(null)}>
                  Close
                </Button>
              </>
            }
          >
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    {t.header.map(h => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.length ? (
                    t.rows.map((row, i) => (
                      <tr key={i}>
                        {row.map((v, j) => (
                          <td key={j}>{v ?? "—"}</td>
                        ))}
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={t.header.length} className="empty">
                        No data in this range.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        ) : null}
        <Panel
          title="Scan compliance"
          subtitle={c ? `${form.from} to ${form.to} · expected scans against the scans made` : compliance.isError ? describe(compliance.error) : "Loading…"}
          tools={
            idle ? (
              <Button size="sm" onClick={() => setAllHubs(a => !a)}>
                {allHubs ? "Only hubs with arrivals" : `Show all hubs (+${idle} with none)`}
              </Button>
            ) : null
          }
        >
          {c ? (
            <div className="panel-body" style={{ paddingBottom: 0 }}>
              <div className="metrics" style={{ marginBottom: 8 }}>
                <Metric label="Scans" value={num(c.totals.scans)} />
                <Metric label="By camera" value={num(c.totals.camera)} />
                <Metric label="Refused" value={num(c.totals.refused)} />
                <Metric label="Hub compliance" value={<Compliance v={c.totals.hubCompliance} />} />
                <Metric label="Rider compliance" value={<Compliance v={c.totals.riderCompliance} />} />
              </div>
            </div>
          ) : null}
          <div className="row" style={{ justifyContent: "space-between", padding: "8px 16px" }}>
            <strong>By hub · arrivals scanned</strong>
            <span className="muted">{active.length} hub(s) with arrivals</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Hub</th>
                  <th className="num">Arrivals</th>
                  <th className="num">Scanned</th>
                  <th className="num">Missed</th>
                  <th className="num">By camera</th>
                  <th>Compliance</th>
                </tr>
              </thead>
              <tbody>
                {shownHubs.length ? (
                  shownHubs.map(h => (
                    <tr key={h.hub.name}>
                      <td className="strong">{h.hub.name}</td>
                      <td className="num">{h.expected}</td>
                      <td className="num">{h.scanned}</td>
                      <td className="num">{h.missed ? <strong style={{ color: "var(--bad)" }}>{h.missed}</strong> : 0}</td>
                      <td className="num">{h.camera}</td>
                      <td>
                        <Compliance v={h.compliance} />
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="empty">
                      {c ? "No arrivals in this range." : "Loading…"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ justifyContent: "space-between", padding: "8px 16px" }}>
            <strong>By rider · pickups and deliveries scanned</strong>
            <span className="muted">{(c?.riders || []).length} rider(s)</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Rider</th>
                  <th className="num">Pickups scanned</th>
                  <th className="num">Deliveries scanned</th>
                  <th>Compliance</th>
                </tr>
              </thead>
              <tbody>
                {c?.riders.length ? (
                  c.riders.slice(0, 30).map(x => (
                    <tr key={x.rider.label}>
                      <td className="strong">{x.rider.label}</td>
                      <td className="num">{`${x.pickups.scanned}/${x.pickups.expected}`}</td>
                      <td className="num">{`${x.deliveries.scanned}/${x.deliveries.expected}`}</td>
                      <td>
                        <Compliance v={x.compliance} />
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="empty">
                      {c ? "No rider pickups or deliveries in this range." : "Loading…"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="Scheduled reports" subtitle="Emailed with a link to the report; daily reports cover yesterday, weekly ones the previous seven days">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Report</th>
                  <th>When (Dhaka)</th>
                  <th>Recipients</th>
                  <th>Hub</th>
                  <th>Last sent</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {schedules.data?.length ? (
                  schedules.data.map(x => (
                    <tr key={x.id}>
                      <td>
                        <span className="strong">{x.name}</span>
                        <span className="sub">{KINDS[x.kind]}</span>
                      </td>
                      <td>{x.frequency === "DAILY" ? `Daily at ${x.hour}:00` : `${DAYS[x.weekday ?? 0]}s at ${x.hour}:00`}</td>
                      <td>{x.recipients.join(", ")}</td>
                      <td>{ops.hubById(x.hubId)?.name || "Whole network"}</td>
                      <td>
                        {x.lastRunAt ? when(x.lastRunAt) : "Not yet"}
                        <span className="sub">next {when(x.nextRunAt)}</span>
                      </td>
                      <td>
                        <Pill tone={x.active ? "good" : "neutral"}>{x.active ? "Active" : "Inactive"}</Pill>
                      </td>
                      <td>
                        {ops.can("manageHubs") ? (
                          <div className="row-actions">
                            <Button
                              size="sm"
                              onClick={async () => {
                                const r = await api<{ status: string; error?: string }>(`/reports/schedules/${x.id}/run`, { method: "POST" });
                                toast(r.status === "OK" ? "Report sent to its recipients." : `The report failed: ${r.error}`, r.status === "OK" ? "good" : "bad");
                                reload();
                              }}
                            >
                              Send now
                            </Button>
                            <Button size="sm" onClick={() => scheduleDialog(x)}>
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={async () => {
                                if (!(await confirm({ title: "Delete this scheduled report?", message: "Its recipients stop receiving it.", ok: "Delete schedule", danger: true }))) return;
                                await api(`/reports/schedules/${x.id}`, { method: "DELETE" });
                                reload();
                                toast("Scheduled report deleted.");
                              }}
                            >
                              Delete
                            </Button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="empty">
                      {schedules.isError ? describe(schedules.error) : schedules.data ? "No scheduled reports." : "Loading…"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="Recent reports" subtitle="Kept on the server · download again as CSV">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Report</th>
                  <th>Period</th>
                  <th className="num">Rows</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.data?.length ? (
                  runs.data.map(x => (
                    <tr key={x.id}>
                      <td>
                        {KINDS[x.kind]}
                        <span className="sub">{x.schedule?.name || "On demand"}</span>
                      </td>
                      <td>{`${dayKey(x.periodStart)} to ${dayKey(new Date(new Date(x.periodEnd).getTime() - 1))}`}</td>
                      <td className="num">{x.rowCount}</td>
                      <td>
                        <Pill tone={x.status === "OK" ? "good" : "bad"}>{x.status === "OK" ? "Ready" : "Exception"}</Pill>
                      </td>
                      <td className="nowrap">{when(x.createdAt)}</td>
                      <td>
                        {x.status === "OK" ? (
                          <Button size="sm" icon="download" onClick={() => downloadRun(x.id)}>
                            CSV
                          </Button>
                        ) : (
                          x.error || ""
                        )}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="empty">
                      {runs.isError ? describe(runs.error) : runs.data ? "No reports yet." : "Loading…"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </>
  );
}

// ───────────── Analytics & SLA ─────────────

interface AnalyticsRow {
  label: string;
  target: number;
  unit: string;
  better: "higher" | "lower";
  period: number | null;
  month: number | null;
  previousMonth: number | null;
}
const HEALTH: Record<string, "good" | "warn" | "bad" | "neutral"> = { Healthy: "good", Monitor: "warn", "At risk": "bad", "No data": "neutral" };

function Analytics({ tabs }: { tabs: ReactNode }) {
  const period = usePeriod("ops-analytics");
  const a = useQuery({ queryKey: ["analytics", period.query], queryFn: () => api<{ rows: AnalyticsRow[]; samples: { period?: { delivered: number; pickups: number } } }>(`/ops/analytics?${period.query}`), staleTime: 60_000 });
  const [q, setQ] = useState("");
  const fmt = (v: number | null, unit: string) => (v == null ? "—" : unit === "%" ? `${v}%` : `${v} hrs`);
  const rows = (a.data?.rows || []).map(r => {
    const delta = r.month != null && r.previousMonth != null ? Math.round((r.month - r.previousMonth) * 10) / 10 : null;
    const trend = delta == null ? "—" : `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(delta)} ${r.unit === "%" ? "pts" : "hrs"}`;
    const value = r.period ?? r.month;
    const ok = value != null && (r.better === "higher" ? value >= r.target : value <= r.target);
    const close = value != null && (r.better === "higher" ? value >= r.target * 0.95 : value <= r.target * 1.25);
    return [r.label, `${r.better === "higher" ? "≥" : "≤"} ${r.target}${r.unit === "%" ? "%" : " hrs"}`, fmt(r.period, r.unit), fmt(r.month, r.unit), fmt(r.previousMonth, r.unit), trend, value == null ? "No data" : ok ? "Healthy" : close ? "Monitor" : "At risk"];
  });
  const header = ["Service level", "Target", period.label, "This month", "Previous month", "Trend", "Health"];
  const shown = rows.filter(r => !q || r.join(" ").toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <PageHeading
        eyebrow="Network operations"
        title="Reports"
        subtitle={`${period.text} · service levels for this period, this month and last month`}
        actions={
          <>
            <PeriodSelect period={period} />
            <Button icon="download" onClick={() => (rows.length ? saveCsv("delivery-fast-analytics.csv", [header, ...rows]) : toast("There is no export data for this view."))}>
              Export
            </Button>
          </>
        }
      />
      {tabs}
      <div className="stack-lg">
        <Panel
          title="Analytics register"
          subtitle={a.isError ? describe(a.error) : `${period.text} · compared with this month and last month`}
          tools={<input className="input sm" type="search" placeholder="Search analytics..." aria-label="Search Analytics" value={q} onChange={e => setQ(e.target.value)} style={{ width: 200 }} />}
          footer={a.data?.samples?.period ? `${period.text}: based on ${num(a.data.samples.period.delivered)} deliveries and ${num(a.data.samples.period.pickups)} pickups` : a.isLoading ? "Loading service levels…" : undefined}
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {header.map(h => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map(r => (
                  <tr key={r[0]}>
                    {r.slice(0, 6).map((v, i) => (
                      <td key={i} className={i === 0 ? "strong" : undefined}>
                        {v}
                      </td>
                    ))}
                    <td>
                      <Pill tone={HEALTH[r[6]]}>{r[6]}</Pill>
                    </td>
                  </tr>
                ))}
                {!shown.length ? (
                  <tr>
                    <td colSpan={7} className="empty">
                      {a.isLoading ? "Loading…" : "No service levels."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Panel>
        <SlaSections />
      </div>
    </>
  );
}

const LEVEL: Record<string, string> = { AT_RISK: "At risk", BREACHED: "Breached" };
const LEG: Record<string, string> = { PICKUP: "Pickup", DELIVERY: "Delivery" };
const SERVICE: Record<string, string> = { REGULAR: "Regular", SAME_DAY: "Same day", EXPRESS: "Express" };
const minutes = (m: number) => (m >= 1440 && m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? "" : "s"}` : m >= 60 && m % 60 === 0 ? `${m / 60} hr` : `${m} min`);
const pct = (v: number | null | undefined) => (v == null ? "—" : `${v}%`);

function SlaSections() {
  const qc = useQueryClient();
  useLive(["sla.updated"], () => void qc.invalidateQueries({ queryKey: ["sla"] }));
  const summary = useQuery({ queryKey: ["sla", "summary"], queryFn: () => api<{ onTrack: number; atRisk: number; breached: number; openAlerts: { atRisk: number; breached: number } }>("/sla/summary"), staleTime: 30_000 });
  const s = summary.data;
  return (
    <>
      {s ? (
        <div className="metrics" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", marginBottom: 0 }}>
          <Metric label="SLA on track" value={num(s.onTrack)} icon="check" foot="open parcels" note="within due time" />
          <Metric label="At risk" value={num(s.atRisk)} icon="clock" foot={`${num(s.openAlerts.atRisk)} unacknowledged`} note="due soon" />
          <Metric label="Breached" value={num(s.breached)} icon="alert" foot={`${num(s.openAlerts.breached)} unacknowledged`} note="past due" />
        </div>
      ) : null}
      <SlaAlerts />
      <SlaReport />
      <SlaPolicies />
    </>
  );
}

interface SlaAlert {
  id: string;
  leg: string;
  level: string;
  dueAt: string;
  parcel: { trackingId: string; statusLabel: string; serviceLevel: string; zone: string; hub?: { name: string } | null; rider?: string | null };
  resolvedAt?: string | null;
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
  note?: string | null;
}

/** SLA alerts (also on Problems › SLA late-risk, compact: no filters). */
export function SlaAlerts({ compact = false }: { compact?: boolean }) {
  const ops = useOps();
  const qc = useQueryClient();
  const actions = useParcelActions();
  const [filter, setFilter] = useState({ level: "", leg: "", open: "true" });
  const [pages, setPages] = useState(1);
  const key = JSON.stringify(filter);
  useEffect(() => setPages(1), [key]);
  const list = useQuery({
    queryKey: ["sla", "alerts", key, pages],
    queryFn: async () => {
      const items: SlaAlert[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < pages; i++) {
        const p = new URLSearchParams({ limit: "25" });
        for (const [k, v] of Object.entries(filter)) if (v) p.set(k, v);
        if (cursor) p.set("cursor", cursor);
        const page: { items: SlaAlert[]; nextCursor: string | null } = await api(`/sla/alerts?${p}`);
        items.push(...page.items);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      return { items, next: cursor };
    },
    placeholderData: prev => prev,
  });
  const reload = () => void qc.invalidateQueries({ queryKey: ["sla"] });
  const items = list.data?.items || [];
  return (
    <Panel
      title="SLA alerts"
      subtitle="Parcels at risk of missing, or past, their pickup / delivery due time · new breaches are escalated to operations"
      tools={
        compact ? null : (
          <>
            <Select className="select sm" aria-label="Level" value={filter.level} onChange={e => setFilter(f => ({ ...f, level: e.target.value }))}>
              <option value="">All levels</option>
              <option value="BREACHED">Breached</option>
              <option value="AT_RISK">At risk</option>
            </Select>
            <Select className="select sm" aria-label="Leg" value={filter.leg} onChange={e => setFilter(f => ({ ...f, leg: e.target.value }))}>
              <option value="">Pickup and delivery</option>
              <option value="PICKUP">Pickup</option>
              <option value="DELIVERY">Delivery</option>
            </Select>
            <Select className="select sm" aria-label="Open or resolved" value={filter.open} onChange={e => setFilter(f => ({ ...f, open: e.target.value }))}>
              <option value="true">Open</option>
              <option value="false">Resolved</option>
              <option value="">All</option>
            </Select>
            {ops.can("manageHubs") ? (
              <Button
                size="sm"
                onClick={async () => {
                  const r = await api<{ breached: number; atRisk: number; newAlerts: number; resolved: number }>("/sla/monitor", { method: "POST" });
                  toast(`SLA check: ${r.breached} breached, ${r.atRisk} at risk, ${r.newAlerts} new alert(s), ${r.resolved} resolved.`);
                  reload();
                }}
              >
                Check now
              </Button>
            ) : null}
          </>
        )
      }
      footer={
        <>
          <span>{`Showing ${items.length} alert(s)`}</span>
          {list.data?.next && !compact ? (
            <Button size="sm" onClick={() => setPages(n => n + 1)}>
              Load more
            </Button>
          ) : null}
        </>
      }
    >
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Parcel</th>
              <th>Leg</th>
              <th>Level</th>
              <th>Due</th>
              <th>Zone / hub</th>
              <th>Rider</th>
              <th>Acknowledged</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.length ? (
              items.map(a => (
                <tr key={a.id}>
                  <td>
                    <button type="button" className="link-button tracking" onClick={() => actions.openParcel(a.parcel.trackingId)}>
                      {a.parcel.trackingId}
                    </button>
                    <span className="sub">{`${a.parcel.statusLabel} · ${a.parcel.serviceLevel}`}</span>
                  </td>
                  <td>{LEG[a.leg]}</td>
                  <td>
                    <Pill tone={a.level === "BREACHED" ? "bad" : "warn"}>{LEVEL[a.level]}</Pill>
                  </td>
                  <td className="nowrap">{when(a.dueAt)}</td>
                  <td>
                    {a.parcel.zone}
                    <span className="sub">{a.parcel.hub?.name || "No hub"}</span>
                  </td>
                  <td>{a.parcel.rider || "Unassigned"}</td>
                  <td>
                    {a.resolvedAt ? (
                      "Resolved"
                    ) : a.acknowledgedAt ? (
                      <>
                        {a.acknowledgedBy || ""}
                        <span className="sub">{a.note || ""}</span>
                      </>
                    ) : ops.can("dispatch") ? (
                      <Button
                        size="sm"
                        onClick={async () => {
                          const note = await prompt({ title: "Acknowledge this alert", message: "Everyone watching SLA alerts sees that you are on it.", label: "What is being done?", multiline: true, required: false, ok: "Acknowledge", placeholder: "e.g. Rider called; delivering before 6 pm" });
                          if (note === null) return;
                          await api(`/sla/alerts/${a.id}/acknowledge`, { method: "POST", body: { note: note || undefined } });
                          toast("Alert acknowledged.", "good");
                          reload();
                        }}
                      >
                        Acknowledge
                      </Button>
                    ) : (
                      "Open"
                    )}
                  </td>
                  <td>
                    <Button
                      size="sm"
                      onClick={async () => {
                        const p = await api<Parcel>(`/parcels/${encodeURIComponent(a.parcel.trackingId)}`);
                        await resolveException(p, actions.ctx);
                      }}
                    >
                      Resolve
                    </Button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={8} className="empty">
                  {list.isError ? describe(list.error) : list.data ? "No SLA alerts." : "Loading SLA alerts…"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function SlaReport() {
  const ops = useOps();
  const hubs = ops.myHubs || ops.hubs;
  const [r, setR] = useState({ from: dayKey(new Date(Date.now() - 29 * 86400000)), to: dayKey(), hubId: "" });
  const q = useQuery({
    queryKey: ["sla", "report", r],
    queryFn: () =>
      api<{
        from: string;
        to: string;
        pickups: { total: number; onTime: number; rate: number | null };
        deliveries: { total: number; onTime: number; rate: number | null };
        alerts: { pickupBreached: number; deliveryBreached: number };
        byServiceLevel: { label: string; total: number; onTime: number; rate: number | null; avgLateMinutes: number | null }[];
        byZone: { zone: string; district: string; total: number; onTime: number; late: number; rate: number | null }[];
        byHub: { hub?: { name: string } | null; total: number; onTime: number; rate: number | null }[];
        byDay: { day: string; total: number; onTime: number; rate: number | null }[];
      }>(`/sla/report?from=${r.from}&to=${r.to}${r.hubId ? `&hubId=${r.hubId}` : ""}`),
    staleTime: 60_000,
  });
  const d = q.data;
  const exportCsv = () => {
    if (!d) return toast("The report is still loading.");
    const rows: unknown[][] = [["Section", "Name", "Total", "On time", "On-time %"]];
    rows.push(["Pickups", "All", d.pickups.total, d.pickups.onTime, d.pickups.rate ?? ""], ["Deliveries", "All", d.deliveries.total, d.deliveries.onTime, d.deliveries.rate ?? ""]);
    for (const l of d.byServiceLevel) rows.push(["Service level", l.label, l.total, l.onTime, l.rate ?? ""]);
    for (const z of d.byZone) rows.push(["Zone", `${z.zone}, ${z.district}`, z.total, z.onTime, z.rate ?? ""]);
    for (const h of d.byHub) rows.push(["Hub", h.hub?.name || "No hub", h.total, h.onTime, h.rate ?? ""]);
    for (const x of d.byDay) rows.push(["Day", x.day, x.total, x.onTime, x.rate ?? ""]);
    saveCsv(`delivery-fast-sla-${d.from}-to-${d.to}.csv`, rows);
  };
  const setRange = (patch: Partial<typeof r>) => {
    const next = { ...r, ...patch };
    if (next.from > next.to) return toast("Choose a start date on or before the end date.");
    setR(next);
  };
  return (
    <Panel
      title="SLA report"
      subtitle={d ? `${d.deliveries.total} deliveries and ${d.pickups.total} pickups with a due time · ${d.from} to ${d.to}` : q.isError ? describe(q.error) : "Loading…"}
      tools={
        <>
          <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
            From
            <input className="input sm" type="date" value={r.from} onChange={e => setRange({ from: e.target.value })} />
          </label>
          <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
            To
            <input className="input sm" type="date" value={r.to} onChange={e => setRange({ to: e.target.value })} />
          </label>
          {hubs.length > 1 ? (
            <Select className="select sm" aria-label="Hub" value={r.hubId} onChange={e => setRange({ hubId: e.target.value })}>
              <option value="">All hubs</option>
              {hubs.map(h => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </Select>
          ) : null}
          <Button size="sm" icon="download" onClick={exportCsv}>
            CSV
          </Button>
          <Button size="sm" icon="print" onClick={() => openDocument(`/documents/sla-report?from=${r.from}&to=${r.to}${r.hubId ? `&hubId=${r.hubId}` : ""}`, { title: "Preparing the SLA report…" })}>
            Print
          </Button>
        </>
      }
    >
      {d ? (
        <>
          <div className="mini-stats" style={{ padding: "12px 16px 0" }}>
            <div className="mini">
              <span>Pickups on time</span>
              <strong>{pct(d.pickups.rate)}</strong>
            </div>
            <div className="mini">
              <span>Deliveries on time</span>
              <strong>{pct(d.deliveries.rate)}</strong>
            </div>
            <div className="mini">
              <span>Breaches raised</span>
              <strong>{d.alerts.pickupBreached + d.alerts.deliveryBreached}</strong>
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Service level</th>
                  <th className="num">Delivered</th>
                  <th className="num">On time</th>
                  <th className="num">On-time %</th>
                  <th className="num">Avg. late by</th>
                </tr>
              </thead>
              <tbody>
                {d.byServiceLevel.length ? (
                  d.byServiceLevel.map(l => (
                    <tr key={l.label}>
                      <td>{l.label}</td>
                      <td className="num">{l.total}</td>
                      <td className="num">{l.onTime}</td>
                      <td className="num">{pct(l.rate)}</td>
                      <td className="num">{l.avgLateMinutes == null ? "—" : minutes(l.avgLateMinutes)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="empty">
                      No deliveries in this range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <table className="table">
              <thead>
                <tr>
                  <th>Delivery zone</th>
                  <th className="num">Delivered</th>
                  <th className="num">On time</th>
                  <th className="num">Late</th>
                  <th className="num">On-time %</th>
                </tr>
              </thead>
              <tbody>
                {d.byZone.length ? (
                  d.byZone.slice(0, 15).map(z => (
                    <tr key={`${z.district}|${z.zone}`}>
                      <td>
                        {z.zone}
                        <span className="sub">{z.district}</span>
                      </td>
                      <td className="num">{z.total}</td>
                      <td className="num">{z.onTime}</td>
                      <td className="num">{z.late}</td>
                      <td className="num">{pct(z.rate)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="empty">
                      No deliveries in this range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </Panel>
  );
}

interface Policy {
  id: string;
  name: string;
  serviceLevel: string;
  originDistrict?: string | null;
  originZone?: string | null;
  destDistrict?: string | null;
  destZone?: string | null;
  pickupMinutes: number;
  deliveryMinutes: number;
  atRiskMinutes: number;
  active: boolean;
}

function SlaPolicies() {
  const ops = useOps();
  const qc = useQueryClient();
  const catalog = useCatalog();
  const q = useQuery({ queryKey: ["sla", "policies"], queryFn: () => api<{ items: Policy[]; defaults?: Record<string, { pickup: number; delivery: number; deliveryOtherDistrict: number }> }>("/sla/policies?limit=200"), staleTime: 60_000 });
  const manage = ops.can("manageHubs");
  const place = (d?: string | null, z?: string | null) => (z ? `${z}, ${d}` : d || "Anywhere");
  const defaults = q.data?.defaults
    ? Object.entries(q.data.defaults)
        .map(([level, d]) => `${SERVICE[level]}: pickup ${minutes(d.pickup)}, delivery ${minutes(d.delivery)}${d.deliveryOtherDistrict !== d.delivery ? ` (${minutes(d.deliveryOtherDistrict)} to another district)` : ""}`)
        .join(" · ")
    : "";
  const reload = () => void qc.invalidateQueries({ queryKey: ["sla", "policies"] });
  const districts = (catalog?.districts || []).map(d => ({ value: d, label: d }));
  const zones = (district: string) => (catalog?.zonesByDistrict?.[district] || []).map(z => ({ value: z, label: z }));
  function dialog(x?: Policy) {
    if (!ops.require("manageHubs", "change SLA policies")) return;
    void openForm({
      title: x ? `Edit policy · ${x.name}` : "Add SLA policy",
      description: "Targets apply to new bookings. A parcel is flagged at risk this long before a target, and breached after it.",
      submit: x ? "Save policy" : "Add policy",
      wide: true,
      fields: [
        { id: "name", label: "Name", required: true, maxLength: 120, value: x?.name, full: true },
        x ? { id: "levelStatic", label: "Service level", type: "static", value: SERVICE[x.serviceLevel] } : { id: "serviceLevel", label: "Service level", type: "select", required: true, value: "REGULAR", options: Object.entries(SERVICE).map(([value, label]) => ({ value, label })) },
        { id: "active", label: "Status", type: "select", required: true, value: String(x?.active ?? true), options: [{ value: "true", label: "Active" }, { value: "false", label: "Inactive" }] },
        ...(x
          ? [{ id: "route", label: "Route", type: "static" as const, value: `${place(x.originDistrict, x.originZone)} → ${place(x.destDistrict, x.destZone)}`, full: true }]
          : [
              { id: "originDistrict", label: "From district", type: "select" as const, options: districts, hint: "Empty: any district." },
              { id: "originZone", label: "From zone", type: "select" as const, options: (v: Record<string, string>) => zones(v.originDistrict), show: (v: Record<string, string>) => !!v.originDistrict, hint: "Empty: any zone." },
              { id: "destDistrict", label: "To district", type: "select" as const, options: districts, hint: "Empty: any district." },
              { id: "destZone", label: "To zone", type: "select" as const, options: (v: Record<string, string>) => zones(v.destDistrict), show: (v: Record<string, string>) => !!v.destDistrict, hint: "Empty: any zone." },
            ]),
        { id: "pickup", label: "Pickup within (hours)", type: "number", min: 0.25, step: 0.25, required: true, value: x ? x.pickupMinutes / 60 : 4 },
        { id: "delivery", label: "Deliver within (hours)", type: "number", min: 0.25, step: 0.25, required: true, value: x ? x.deliveryMinutes / 60 : 48 },
        { id: "risk", label: "At risk (minutes before)", type: "number", min: 5, step: 5, required: true, value: x?.atRiskMinutes ?? 120 },
      ],
      validate: {
        name: v => (v.length < 2 ? "Name the policy" : ""),
        pickup: v => (Number(v) >= 0.25 ? "" : "At least 15 minutes"),
        delivery: v => (Number(v) >= 0.25 ? "" : "At least 15 minutes"),
      },
      onSubmit: async v => {
        const timing = { pickupMinutes: Math.round(Number(v.pickup) * 60), deliveryMinutes: Math.round(Number(v.delivery) * 60), atRiskMinutes: Number(v.risk), active: v.active === "true" };
        const body = x
          ? { name: v.name, ...timing }
          : { name: v.name, serviceLevel: v.serviceLevel, originDistrict: v.originDistrict || null, originZone: v.originZone || null, destDistrict: v.destDistrict || null, destZone: v.destZone || null, ...timing };
        await api(x ? `/sla/policies/${x.id}` : "/sla/policies", { method: x ? "PATCH" : "POST", body });
        reload();
        return `Policy ${x ? "saved" : "added"}. It applies to new bookings.`;
      },
    });
  }
  return (
    <Panel
      title="SLA policies"
      subtitle={`The most specific active policy for a parcel's service level and zones sets its due times at booking. Defaults: ${defaults}`}
      tools={
        manage ? (
          <Button size="sm" icon="plus" onClick={() => dialog()}>
            Add policy
          </Button>
        ) : null
      }
    >
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Policy</th>
              <th>Service</th>
              <th>Route</th>
              <th>Pickup within</th>
              <th>Deliver within</th>
              <th>At risk</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data?.items.length ? (
              q.data.items.map(x => (
                <tr key={x.id}>
                  <td className="strong">{x.name}</td>
                  <td>{SERVICE[x.serviceLevel]}</td>
                  <td>{`${place(x.originDistrict, x.originZone)} → ${place(x.destDistrict, x.destZone)}`}</td>
                  <td>{minutes(x.pickupMinutes)}</td>
                  <td>{minutes(x.deliveryMinutes)}</td>
                  <td>{`${minutes(x.atRiskMinutes)} before`}</td>
                  <td>
                    <Pill tone={x.active ? "good" : "neutral"}>{x.active ? "Active" : "Inactive"}</Pill>
                  </td>
                  <td>
                    {manage ? (
                      <div className="row-actions">
                        <Button size="sm" onClick={() => dialog(x)}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={async () => {
                            if (!(await confirm({ title: "Delete this SLA policy?", message: "Parcels already booked keep their due times.", ok: "Delete policy", danger: true }))) return;
                            await api(`/sla/policies/${x.id}`, { method: "DELETE" });
                            reload();
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={8} className="empty">
                  {q.data ? "No policies: the defaults apply." : "Loading…"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ───────────── Rider report ─────────────

interface RiderRow {
  rider: { id: string; code: string; name: string; phone?: string; hub?: { name: string } | null };
  pickups: { assigned: number; pickedUp: number };
  deliveries: { assigned: number; outForDelivery: number; delivered: number; failed: number };
  cash: { collected: number; handedIn: number; holdingNow: number };
  location?: { lat: number; lng: number; at: string } | null;
}
interface RiderParcel {
  rider: string;
  leg: string;
  trackingId: string;
  sender?: string;
  recipient?: string;
  recipientPhone?: string;
  address?: string;
  zone?: string;
  outcome: string;
  at: string;
  cod?: number;
  codDue?: number;
  status: string;
}
const PARCEL_HEAD = ["Rider", "Leg", "Tracking ID", "From", "Recipient", "Recipient phone", "Address", "Area", "Outcome", "When", "COD collected", "COD due", "Status"];
const parcelRow = (p: RiderParcel) => [p.rider, p.leg, p.trackingId, p.sender, p.recipient, p.recipientPhone || "", p.address || "", p.zone || "", p.outcome, time(p.at), p.cod || 0, p.codDue || 0, p.status];
const busy = (r: RiderRow) => !!(r.pickups.assigned || r.pickups.pickedUp || r.deliveries.assigned || r.deliveries.outForDelivery || r.deliveries.delivered || r.deliveries.failed || r.cash.collected || r.cash.handedIn || r.cash.holdingNow);
const agoShort = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

function RiderReport({ tabs }: { tabs: ReactNode }) {
  const ops = useOps();
  const qc = useQueryClient();
  const hubs = ops.myHubs || ops.hubs;
  const [f, setF] = useState({ from: dhakaToday(), to: dhakaToday(), hubId: "" });
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const qs = (extra: Record<string, string> = {}) => new URLSearchParams({ from: f.from, to: f.to, ...(f.hubId ? { hubId: f.hubId } : {}), ...extra }).toString();
  const q = useQuery({ queryKey: ["rider-report", f], queryFn: () => api<{ from: string; to: string; totals: { active: number; riders: number; pickedUp: number; pickupsAssigned: number; outForDelivery: number; deliveriesAssigned: number; delivered: number; failed: number; collected: number; handedIn: number; holdingNow: number }; items: RiderRow[] }>(`/reports/riders?${qs()}`) });
  useLive(["parcel.updated", "cash.slip"], () => void qc.invalidateQueries({ queryKey: ["rider-report"] }), { debounceMs: 4000, fallbackMs: 120_000 });
  const parcels = (riderId: string) => qc.fetchQuery({ queryKey: ["rider-report", "parcels", f, riderId], queryFn: async () => (await api<{ items: RiderParcel[] }>(`/reports/riders/parcels?${qs({ riderId })}`)).items });
  const range = f.from === f.to ? f.from : `${f.from}_to_${f.to}`;
  const set = (patch: Partial<typeof f>) => {
    const next = { ...f, ...patch };
    if (next.to < next.from) next.to = next.from;
    setOpen(null);
    setF(next);
  };
  const d = q.data;
  const t = d?.totals;
  const items = [...(d?.items || [])].sort((a, b) => Number(busy(b)) - Number(busy(a)) || b.deliveries.delivered - a.deliveries.delivered || a.rider.code.localeCompare(b.rider.code));
  const idle = items.filter(r => !busy(r)).length;
  const shown = all ? items : items.filter(busy);
  const ridersCsv = () => [
    ["Rider", "Hub", "Pickups assigned", "Picked up", "Deliveries assigned", "Out for delivery", "Delivered", "Failed", "COD collected", "Handed in", "Holding now", "Last position", "Position at"],
    ...(d?.items || []).map(r => [`${r.rider.code} · ${r.rider.name}`, r.rider.hub?.name || "", r.pickups.assigned, r.pickups.pickedUp, r.deliveries.assigned, r.deliveries.outForDelivery, r.deliveries.delivered, r.deliveries.failed, r.cash.collected, r.cash.handedIn, r.cash.holdingNow, r.location ? `${r.location.lat},${r.location.lng}` : "", r.location ? time(r.location.at) : ""]),
  ];
  return (
    <>
      <PageHeading
        eyebrow="Network operations · reporting"
        title="Reports"
        subtitle="What each rider did: pickups, deliveries and failures, the COD they collected and handed in, and where they are now."
        actions={
          <>
            <Button onClick={() => (d ? saveCsv(`rider-report-${range}.csv`, ridersCsv()) : undefined)}>Riders (CSV)</Button>
            <Button
              variant="primary"
              icon="download"
              onClick={async () => {
                if (!d) return;
                const all = (await api<{ items: RiderParcel[] }>(`/reports/riders/parcels?${qs()}`)).items;
                saveCsv(`rider-report-with-parcels-${range}.csv`, [...ridersCsv(), [], PARCEL_HEAD, ...all.map(parcelRow)]);
              }}
            >
              Download with parcels
            </Button>
          </>
        }
      />
      {tabs}
      <div className="stack-lg">
        <div className="panel panel-body row" style={{ alignItems: "end" }}>
          <label className="field">
            <span>From</span>
            <input className="input" type="date" value={f.from} onChange={e => set({ from: e.target.value || dhakaToday() })} />
          </label>
          <label className="field">
            <span>To</span>
            <input className="input" type="date" value={f.to} onChange={e => set({ to: e.target.value || dhakaToday() })} />
          </label>
          <label className="field">
            <span>Hub</span>
            <Select className="select" value={f.hubId} onChange={e => set({ hubId: e.target.value })}>
              {ops.myHubs ? null : <option value="">Whole network</option>}
              {hubs.map(h => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </Select>
          </label>
          <Button onClick={() => set({ from: dhakaToday(), to: dhakaToday() })}>Today</Button>
          <span className="muted" style={{ marginLeft: "auto" }}>
            {q.isFetching ? "Loading…" : d ? `${d.from === d.to ? d.from : `${d.from} to ${d.to}`} · Dhaka time` : ""}
          </span>
        </div>
        {q.isError ? (
          <div className="callout bad">{describe(q.error)}</div>
        ) : t ? (
          <div className="metrics" style={{ marginBottom: 0 }}>
            <Metric label="Riders working" value={t.active} foot={`of ${t.riders}`} />
            <Metric label="Pickups" value={t.pickedUp} foot={`${t.pickupsAssigned} assigned`} />
            <Metric label="Out for delivery" value={t.outForDelivery} foot={`${t.deliveriesAssigned} assigned`} />
            <Metric label="Delivered" value={<span style={{ color: "var(--good)" }}>{t.delivered}</span>} />
            <Metric label="Failed" value={<span style={{ color: "var(--bad)" }}>{t.failed}</span>} />
            <Metric label="COD collected" value={<span style={{ color: "var(--primary)" }}>{tk(t.collected)}</span>} />
            <Metric label="Handed in at hubs" value={tk(t.handedIn)} foot={`still with riders ${tk(t.holdingNow)}`} />
          </div>
        ) : null}
        <Panel
          title="Riders"
          subtitle={d ? `${items.length - idle} working${idle ? ` · ${idle} with nothing in these dates` : ""}` : ""}
          tools={
            idle ? (
              <Button size="sm" onClick={() => setAll(a => !a)}>
                {all ? "Only riders who worked" : `Show all riders (+${idle})`}
              </Button>
            ) : null
          }
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th rowSpan={2}>Rider</th>
                  <th rowSpan={2} className="num">
                    Pickups
                    <span className="sub">done / assigned</span>
                  </th>
                  <th colSpan={4} style={{ textAlign: "center" }}>
                    Deliveries
                  </th>
                  <th colSpan={3} style={{ textAlign: "center" }}>
                    Cash
                  </th>
                  <th rowSpan={2}>Location</th>
                  <th rowSpan={2} />
                </tr>
                <tr>
                  <th className="num">Assigned</th>
                  <th className="num">Out</th>
                  <th className="num">Delivered</th>
                  <th className="num">Failed</th>
                  <th className="num">Collected</th>
                  <th className="num">Handed in</th>
                  <th className="num">Holding</th>
                </tr>
              </thead>
              <tbody>
                {shown.length ? (
                  shown.map(r => (
                    <Fragment key={r.rider.id}>
                      <tr className={open === r.rider.id ? "selected" : undefined}>
                        <td>
                          <span className="strong">{`${r.rider.code} · ${r.rider.name}`}</span>
                          <span className="sub">{`${r.rider.hub?.name || ""}${r.rider.phone ? ` · ${localPhone(r.rider.phone)}` : ""}`}</span>
                        </td>
                        <td className="num">{r.pickups.assigned || r.pickups.pickedUp ? `${r.pickups.pickedUp} / ${r.pickups.assigned}` : <Zero v={0} />}</td>
                        <td className="num">
                          <Zero v={r.deliveries.assigned} />
                        </td>
                        <td className="num">
                          <Zero v={r.deliveries.outForDelivery} />
                        </td>
                        <td className="num">
                          <Zero v={r.deliveries.delivered} />
                        </td>
                        <td className="num">{r.deliveries.failed ? <strong style={{ color: "var(--bad)" }}>{r.deliveries.failed}</strong> : <Zero v={0} />}</td>
                        <td className="num">{r.cash.collected ? tk(r.cash.collected) : <Zero v={0} />}</td>
                        <td className="num">{r.cash.handedIn ? tk(r.cash.handedIn) : <Zero v={0} />}</td>
                        <td className="num">{r.cash.holdingNow ? <strong>{tk(r.cash.holdingNow)}</strong> : <Zero v={0} />}</td>
                        <td>
                          {r.location ? (
                            <>
                              <a className="button sm" href={`https://www.google.com/maps?q=${r.location.lat},${r.location.lng}`} target="_blank" rel="noopener" title={`Last position ${time(r.location.at)}`}>
                                Map
                              </a>
                              <span className="sub">{agoShort(r.location.at)}</span>
                            </>
                          ) : (
                            <span className="sub">No position</span>
                          )}
                        </td>
                        <td>
                          <div className="row-actions">
                            <Button size="sm" onClick={() => setOpen(open === r.rider.id ? null : r.rider.id)}>
                              {open === r.rider.id ? "Hide" : "Parcels"}
                            </Button>
                            <Button size="sm" onClick={async () => saveCsv(`rider-${r.rider.code}-${range}.csv`, [PARCEL_HEAD, ...(await parcels(r.rider.id)).map(parcelRow)])}>
                              CSV
                            </Button>
                          </div>
                        </td>
                      </tr>
                      {open === r.rider.id ? (
                        <tr>
                          <td colSpan={11} style={{ background: "var(--surface-2)" }}>
                            <RiderParcels load={() => parcels(r.rider.id)} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))
                ) : (
                  <tr>
                    <td colSpan={11} className="empty">
                      {q.isLoading || !d ? "Loading…" : "No rider worked in these dates."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </>
  );
}

function RiderParcels({ load }: { load: () => Promise<RiderParcel[]> }) {
  const [list, setList] = useState<RiderParcel[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => void load().then(setList, e => setError(describe(e))), [load]);
  if (error) return <div className="form-error">{error}</div>;
  if (!list) return <div className="muted">Loading parcels…</div>;
  if (!list.length) return <div className="muted">No parcels in these dates.</div>;
  return (
    <div className="table-wrap" style={{ maxHeight: 420, background: "#fff", border: "1px solid var(--line)", borderRadius: 10 }}>
      <table className="table">
        <thead>
          <tr>
            <th>Parcel</th>
            <th>Leg</th>
            <th>From</th>
            <th>Recipient</th>
            <th>Outcome</th>
            <th>When</th>
            <th className="num">COD collected</th>
          </tr>
        </thead>
        <tbody>
          {list.map((p, i) => (
            <tr key={i}>
              <td className="strong">{p.trackingId}</td>
              <td>{p.leg}</td>
              <td>{p.sender || ""}</td>
              <td>
                {p.recipient || ""}
                {p.zone ? <span className="sub">{p.zone}</span> : null}
              </td>
              <td>
                <Pill tone={/^Delivered|^Picked up/.test(p.outcome) ? "good" : /^Failed/.test(p.outcome) ? "bad" : /^Out for/.test(p.outcome) ? "info" : "neutral"}>{p.outcome}</Pill>
              </td>
              <td className="nowrap">{time(p.at)}</td>
              <td className="num">{p.cod ? tk(p.cod) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ───────────── Hub transfer report ─────────────

interface Route {
  from: { id: string; name: string; code?: string };
  to: { id: string; name: string; code?: string };
  sent: number;
  received: number;
  onTheWay: number;
  missing: number;
  avgHours: number | null;
  lastSentAt?: string | null;
}
interface TransferParcel {
  from: { name: string };
  to: { name: string };
  trackingId: string;
  sender?: string;
  recipient?: string;
  zone?: string;
  cod?: number;
  trip?: string;
  bag?: string;
  sentAt: string;
  sentBy?: string;
  receivedAt?: string;
  receivedBy?: string;
  hours?: number | null;
  state: string;
  status?: string;
}
const span = (h: number | null | undefined) => (h == null ? "—" : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round((h / 24) * 10) / 10} d`);
const TRANSFER_HEAD = ["From hub", "To hub", "Tracking ID", "Sender", "Recipient", "Area", "COD", "Trip", "Bag", "Sent at", "Sent by", "Received at", "Received by", "Hours on the road", "Transfer", "Status now"];
const transferRow = (p: TransferParcel) => [p.from.name, p.to.name, p.trackingId, p.sender, p.recipient, p.zone, p.cod, p.trip || "", p.bag || "", time(p.sentAt), p.sentBy || "", p.receivedAt ? time(p.receivedAt) : "", p.receivedBy || "", p.hours ?? "", p.state, p.status];

function HubTransferReport({ tabs }: { tabs: ReactNode }) {
  const ops = useOps();
  const qc = useQueryClient();
  const [f, setF] = useState({ from: dhakaToday(), to: dhakaToday(), fromHubId: "", toHubId: "" });
  const [view, setView] = useState<"routes" | "hubs">("routes");
  const [open, setOpen] = useState<string | null>(null);
  const qs = (extra: Record<string, string> = {}) => new URLSearchParams({ from: f.from, to: f.to, ...(f.fromHubId ? { fromHubId: f.fromHubId } : {}), ...(f.toHubId ? { toHubId: f.toHubId } : {}), ...extra }).toString();
  const q = useQuery({
    queryKey: ["hub-transfer-report", f],
    queryFn: () =>
      api<{
        from: string;
        to: string;
        totals: { sent: number; routes: number; received: number; onTheWay: number; missing: number; avgHours: number | null };
        routes: Route[];
        hubs: { hub: { id?: string; name: string; code?: string }; sentOut: number; receivedIn: number; onTheWayOut: number; onTheWayIn: number; missingOut: number }[];
      }>(`/reports/hub-transfers?${qs()}`),
  });
  useLive(["parcel.updated"], () => void qc.invalidateQueries({ queryKey: ["hub-transfer-report"] }), { debounceMs: 4000, fallbackMs: 120_000 });
  const routeKey = (r: Route) => `${r.from.id}>${r.to.id}`;
  const parcels = (r: Route) => qc.fetchQuery({ queryKey: ["hub-transfer-report", "parcels", f, routeKey(r)], queryFn: async () => (await api<{ items: TransferParcel[] }>(`/reports/hub-transfers/parcels?${qs({ fromHubId: r.from.id, toHubId: r.to.id })}`)).items });
  const range = f.from === f.to ? f.from : `${f.from}_to_${f.to}`;
  const set = (patch: Partial<typeof f>) => {
    const next = { ...f, ...patch };
    if (next.to < next.from) next.to = next.from;
    setOpen(null);
    setF(next);
  };
  const d = q.data;
  const t = d?.totals;
  const hubs = [...ops.hubs].sort((a, b) => a.name.localeCompare(b.name));
  const summaryCsv = () => [
    ["From hub", "To hub", "Sent", "Received", "On the way", "Missing", "Avg. hours on the road"],
    ...(d?.routes || []).map(r => [r.from.name, r.to.name, r.sent, r.received, r.onTheWay, r.missing, r.avgHours ?? ""]),
    [],
    ["Hub", "Sent out", "Received in", "On the way out", "On the way in", "Missing (sent)"],
    ...(d?.hubs || []).map(h => [h.hub.name, h.sentOut, h.receivedIn, h.onTheWayOut, h.onTheWayIn, h.missingOut]),
  ];
  const slug = (s?: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const hubSelect = (value: string, onChange: (v: string) => void) => (
    <Select className="select" value={value} onChange={e => onChange(e.target.value)}>
      <option value="">Any hub</option>
      {hubs.map(h => (
        <option key={h.id} value={h.id}>
          {h.name}
        </option>
      ))}
    </Select>
  );
  return (
    <>
      <PageHeading
        eyebrow="Network operations · reporting"
        title="Reports"
        subtitle="Parcels moved from hub to hub: how many each hub sent and received, what is still on the way, and what went missing."
        actions={
          <>
            <Button onClick={() => d && saveCsv(`hub-transfer-report-${range}.csv`, summaryCsv())}>Summary (CSV)</Button>
            <Button
              variant="primary"
              icon="download"
              onClick={async () => {
                if (!d) return;
                const all = (await api<{ items: TransferParcel[] }>(`/reports/hub-transfers/parcels?${qs()}`)).items;
                saveCsv(`hub-transfer-report-with-parcels-${range}.csv`, [...summaryCsv(), [], TRANSFER_HEAD, ...all.map(transferRow)]);
              }}
            >
              Download with parcels
            </Button>
          </>
        }
      />
      {tabs}
      <div className="stack-lg">
        <div className="panel panel-body row" style={{ alignItems: "end" }}>
          <label className="field">
            <span>From</span>
            <input className="input" type="date" value={f.from} onChange={e => set({ from: e.target.value || dhakaToday() })} />
          </label>
          <label className="field">
            <span>To</span>
            <input className="input" type="date" value={f.to} onChange={e => set({ to: e.target.value || dhakaToday() })} />
          </label>
          <label className="field">
            <span>From hub</span>
            {hubSelect(f.fromHubId, v => set({ fromHubId: v }))}
          </label>
          <Button title="Swap from and to" onClick={() => set({ fromHubId: f.toHubId, toHubId: f.fromHubId })}>
            ⇄
          </Button>
          <label className="field">
            <span>To hub</span>
            {hubSelect(f.toHubId, v => set({ toHubId: v }))}
          </label>
          <Button onClick={() => set({ from: dhakaToday(), to: dhakaToday() })}>Today</Button>
          {f.fromHubId || f.toHubId ? <Button onClick={() => set({ fromHubId: "", toHubId: "" })}>Clear hubs</Button> : null}
          <span className="muted" style={{ marginLeft: "auto" }}>
            {q.isFetching ? "Loading…" : d ? `${d.from === d.to ? d.from : `${d.from} to ${d.to}`} · Dhaka time` : ""}
          </span>
        </div>
        {q.isError ? (
          <div className="callout bad">{describe(q.error)}</div>
        ) : t ? (
          <div className="metrics" style={{ marginBottom: 0 }}>
            <Metric label="Sent" value={<span style={{ color: "var(--primary)" }}>{t.sent}</span>} foot={`${t.routes} route${t.routes === 1 ? "" : "s"}`} />
            <Metric label="Received" value={<span style={{ color: "var(--good)" }}>{t.received}</span>} />
            <Metric label="Still on the way" value={t.onTheWay} foot="of those sent" />
            <Metric label="Missing" value={<span style={{ color: "var(--bad)" }}>{t.missing}</span>} foot="not in the bag on arrival" />
            <Metric label="Avg. time on the road" value={span(t.avgHours)} />
          </div>
        ) : null}
        <Panel
          title={view === "routes" ? "By route" : "By hub"}
          subtitle="Sent = left the hub in these dates · Received = arrived in these dates · On the way / Missing = of those sent"
          tools={
            <div className="row" style={{ gap: 6 }}>
              <Button size="sm" variant={view === "routes" ? "primary" : "default"} onClick={() => setView("routes")}>
                By route
              </Button>
              <Button size="sm" variant={view === "hubs" ? "primary" : "default"} onClick={() => setView("hubs")}>
                By hub
              </Button>
            </div>
          }
        >
          <div className="table-wrap">
            {view === "routes" ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Route</th>
                    <th className="num">Sent</th>
                    <th className="num">Received</th>
                    <th className="num">On the way</th>
                    <th className="num">Missing</th>
                    <th className="num">Avg. time</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {d?.routes.length ? (
                    d.routes.map(r => {
                      const k = routeKey(r);
                      return (
                        <Fragment key={k}>
                          <tr className={open === k ? "selected" : undefined}>
                            <td>
                              <strong>{r.from.name}</strong> <span className="faint">→</span> <strong>{r.to.name}</strong>
                              {r.lastSentAt ? <span className="sub">last sent {time(r.lastSentAt)}</span> : null}
                            </td>
                            <td className="num strong">
                              <Zero v={r.sent} />
                            </td>
                            <td className="num">
                              <Zero v={r.received} />
                            </td>
                            <td className="num">{r.onTheWay ? <strong style={{ color: "var(--primary)" }}>{r.onTheWay}</strong> : <Zero v={0} />}</td>
                            <td className="num">{r.missing ? <strong style={{ color: "var(--bad)" }}>{r.missing}</strong> : <Zero v={0} />}</td>
                            <td className="num">{span(r.avgHours)}</td>
                            <td>
                              <div className="row-actions">
                                <Button size="sm" onClick={() => setOpen(open === k ? null : k)}>
                                  {open === k ? "Hide" : "Parcels"}
                                </Button>
                                <Button size="sm" onClick={async () => saveCsv(`transfers-${slug(r.from.code || r.from.name)}-to-${slug(r.to.code || r.to.name)}-${range}.csv`, [TRANSFER_HEAD, ...(await parcels(r)).map(transferRow)])}>
                                  CSV
                                </Button>
                              </div>
                            </td>
                          </tr>
                          {open === k ? (
                            <tr>
                              <td colSpan={7} style={{ background: "var(--surface-2)" }}>
                                <TransferParcels load={() => parcels(r)} />
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={7} className="empty">
                        {q.isLoading || !d ? "Loading…" : "No parcels moved between hubs in these dates."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Hub</th>
                    <th className="num">Sent out</th>
                    <th className="num">Received in</th>
                    <th className="num">On the way out</th>
                    <th className="num">On the way in</th>
                    <th className="num">Missing (sent)</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {d?.hubs.length ? (
                    d.hubs.map(h => (
                      <tr key={h.hub.id || h.hub.name}>
                        <td>
                          <span className="strong">{h.hub.name}</span>
                          {h.hub.code ? <span className="sub">{h.hub.code}</span> : null}
                        </td>
                        <td className="num strong">
                          <Zero v={h.sentOut} />
                        </td>
                        <td className="num strong">
                          <Zero v={h.receivedIn} />
                        </td>
                        <td className="num">
                          <Zero v={h.onTheWayOut} />
                        </td>
                        <td className="num">
                          <Zero v={h.onTheWayIn} />
                        </td>
                        <td className="num">{h.missingOut ? <strong style={{ color: "var(--bad)" }}>{h.missingOut}</strong> : <Zero v={0} />}</td>
                        <td>
                          {h.hub.id ? (
                            <div className="row-actions">
                              <Button size="sm" onClick={() => (set({ fromHubId: h.hub.id!, toHubId: "" }), setView("routes"))}>
                                Sent from here
                              </Button>
                              <Button size="sm" onClick={() => (set({ fromHubId: "", toHubId: h.hub.id! }), setView("routes"))}>
                                Sent to here
                              </Button>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={7} className="empty">
                        {q.isLoading || !d ? "Loading…" : "No parcels moved between hubs in these dates."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </Panel>
      </div>
    </>
  );
}

function TransferParcels({ load }: { load: () => Promise<TransferParcel[]> }) {
  const [list, setList] = useState<TransferParcel[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => void load().then(setList, e => setError(describe(e))), [load]);
  if (error) return <div className="form-error">{error}</div>;
  if (!list) return <div className="muted">Loading parcels…</div>;
  if (!list.length) return <div className="muted">No parcels in these dates.</div>;
  return (
    <div className="table-wrap" style={{ maxHeight: 420, background: "#fff", border: "1px solid var(--line)", borderRadius: 10 }}>
      <table className="table">
        <thead>
          <tr>
            <th>Parcel</th>
            <th>From</th>
            <th>Recipient</th>
            <th>Trip / bag</th>
            <th>Sent</th>
            <th>Received</th>
            <th className="num">On the road</th>
            <th>Transfer</th>
            <th>Status now</th>
          </tr>
        </thead>
        <tbody>
          {list.map((p, i) => (
            <tr key={i}>
              <td>
                <span className="strong">{p.trackingId}</span>
                {p.cod ? <span className="sub">COD {tk(p.cod)}</span> : null}
              </td>
              <td>{p.sender || ""}</td>
              <td>
                {p.recipient || ""}
                {p.zone ? <span className="sub">{p.zone}</span> : null}
              </td>
              <td>
                {p.trip || p.bag ? (
                  <>
                    {p.trip || ""}
                    <span className="sub">{p.bag || ""}</span>
                  </>
                ) : (
                  <span className="sub">By hand</span>
                )}
              </td>
              <td>
                {time(p.sentAt)}
                {p.sentBy ? <span className="sub">{p.sentBy}</span> : null}
              </td>
              <td>
                {p.receivedAt ? (
                  <>
                    {time(p.receivedAt)}
                    {p.receivedBy ? <span className="sub">{p.receivedBy}</span> : null}
                  </>
                ) : (
                  "—"
                )}
              </td>
              <td className="num">{span(p.hours)}</td>
              <td>
                <Pill tone={p.state === "Received" ? "good" : p.state === "Missing" ? "bad" : "info"}>{p.state}</Pill>
              </td>
              <td>{p.status || ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
