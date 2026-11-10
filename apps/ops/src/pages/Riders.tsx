/**
 * Riders (03.js Riders & fleet, bridge-pages.js rider report, bridge-network.js Add rider, bridge-shifts.js,
 * bridge-rider-kyc.js, bridge-login-as.js):
 *   Riders               rider pickup & status report for pickup dates (GET /ops/rider-report), run sheets (PDF),
 *                        assigned shipment list, CSV export, Add rider (POST /riders), Log in as
 *   Shifts & attendance  today's roster, recurring shift schedules, attendance report (CSV), recent check-ins with
 *                        corrections (GET/POST/PATCH /shifts/…)
 *   Verification         rider KYC documents: approve / reject each, then approve the rider or ask for changes
 */
import { Select } from "@panel/ui/Select";
import { Icon } from "@panel/ui/Icon";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { saveCsv } from "@panel/lib/csv";
import { useLive } from "@panel/lib/events";
import { date as fmtDate, dayKey, localPhone, num, when } from "@panel/lib/format";
import { useOps } from "@/lib/ops";
import { Button, Empty, Loading, Metric, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { confirm, openCustom, openForm, prompt } from "@panel/ui/dialogs";
import { toast, toastError } from "@panel/ui/toast";
import ViewTabs from "@/app/ViewTabs";
import { useCatalog } from "@/features/parcels/search";
import { loginAs } from "@/features/support/loginAs";
import { openDocument } from "@/features/parcels/actions";

const VEHICLE: Record<string, string> = { MOTORBIKE: "Motorcycle", BICYCLE: "Bicycle", VAN: "Van", ON_FOOT: "On foot" };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const time = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—");
const PICKED = ["Picked up", "At hub", "In transit", "Out for delivery", "Delivered", "Exception", "Return scheduled", "Returned"];

export default function Riders({ tab }: { tab: string }) {
  const ops = useOps();
  const tabs = <ViewTabs view="Riders" tab={tab} />;
  if (!ops.can("readRiders") && ops.me)
    return (
      <>
        <PageHeading eyebrow="Fleet operations" title="Riders & fleet" />
        {tabs}
        <Panel>
          <Empty title="Not available">Rider reports are available to operations and support staff.</Empty>
        </Panel>
      </>
    );
  if (tab === "Shifts & attendance") return <Shifts tabs={tabs} />;
  if (tab === "Verification") return <Verification tabs={tabs} />;
  return <RiderList tabs={tabs} />;
}

// ───────────── Riders ─────────────

interface ReportRider {
  id: string;
  code: string;
  name: string;
  zone: string | null;
  vehicle: string;
  status: string;
  active: boolean;
  hub: { id: string; name: string; code: string; type?: string } | null;
  openDeliveries: number;
  picked: number;
  counts: Record<string, number>;
  records: { trackingId: string; merchant: string | null; recipient: string | null; destination: string | null; service: string; status: string; pickedUpAt: string | null; codAmount: number }[];
}
const statusLabel = (r: ReportRider) => (!r.active ? "Inactive" : r.status === "ONLINE" ? (r.openDeliveries ? "On route" : "Available") : r.status === "ON_BREAK" ? "On break" : "Off shift");

function RiderList({ tabs }: { tabs: React.ReactNode }) {
  const ops = useOps();
  const qc = useQueryClient();
  const zones = useRiderZones();
  const [, setParams] = useSearchParams();
  // The parcel drawer (?parcel=, ParcelDrawer.tsx) opens over the page.
  const openParcel = (code: string) => setParams(p => (p.set("parcel", code), p));
  const today = dayKey(new Date());
  const [range, setRange] = useState({ from: today, to: today });
  const [rider, setRider] = useState("");
  const q = useQuery({
    queryKey: ["riders", "report", range.from, range.to],
    queryFn: () => api<{ riders: ReportRider[] }>(`/ops/rider-report?from=${range.from}&to=${range.to}`),
    staleTime: 30_000,
  });
  useLive(["parcel.updated", "rider.updated"], () => void q.refetch(), { debounceMs: 4000 });
  const all = q.data?.riders ?? [];
  const riders = rider ? all.filter(r => r.code === rider) : all;
  const records = riders.flatMap(r => r.records.map(p => ({ rider: r, p })));
  const picked = records.filter(x => !!x.p.pickedUpAt || PICKED.includes(x.p.status)).length;
  const statuses = [...new Set(records.map(x => x.p.status))].sort();
  const zoneOf = (r: ReportRider) => r.zone || r.hub?.name || "—";
  const setDate = (key: "from" | "to", value: string) => {
    const next = { ...range, [key]: value };
    if (!next.from || !next.to) return;
    if (next.from > next.to) return toast("Choose a start date on or before the end date.", "bad");
    setRange(next);
  };

  function exportReport() {
    const rows = riders.map(r => [r.code, r.name, zoneOf(r), r.picked, Object.entries(r.counts).filter(([, c]) => c).map(([s, c]) => `${s}: ${c}`).join(" · ")]);
    if (!rows.length) return toast("No rider data is available for export.", "bad");
    saveCsv("delivery-fast-rider-report.csv", [["Pickup date from", "Pickup date to", "Rider ID", "Rider name", "Zone", "Parcels picked up", "Status counts"], ...rows.map(r => [range.from, range.to, ...r])]);
    toast(`${rows.length} rider report row(s) downloaded.`, "good");
  }
  // Run sheet: today's assigned work (or the report's end date when it is in the past), in route order.
  const runSheet = (code: string) => {
    const day = range.to && range.to <= today ? range.to : today;
    void openDocument(`/documents/run-sheet/${encodeURIComponent(code)}?date=${day}`, { title: "Preparing the run sheet…" });
  };

  return (
    <>
      <PageHeading
        eyebrow="Fleet operations · date-wise delivery activity"
        title="Riders & fleet"
        subtitle="Review parcels picked up by each rider, current shipment statuses, and print route run sheets."
        actions={
          <>
            <Button icon="download" onClick={exportReport}>
              Export rider report
            </Button>
            {ops.can("manageRiders") ? (
              <Button variant="primary" icon="plus" onClick={() => void addRider(ops, zones, () => void qc.invalidateQueries({ queryKey: ["riders"] }))}>
                Add rider
              </Button>
            ) : null}
          </>
        }
      />
      {tabs}
      <div className="metrics">
        <Metric label="Riders in report" value={num(riders.length)} icon="users" foot="selected date range" note="fleet" />
        <Metric label="Parcels picked up" value={num(picked)} icon="box" foot="assigned rider shipments" note="date-wise" />
        {statuses.map(s => (
          <Metric key={s} label={s} value={num(records.filter(x => x.p.status === s).length)} icon="truck" foot="current shipment status" note="parcels" />
        ))}
      </div>
      <Panel
        title="Rider pickup & status report"
        subtitle="Pickup date range · status totals reflect each shipment's current state."
        tools={
          <div className="row">
            <label className="row" style={{ gap: 6 }}>
              <span className="faint">From</span>
              <input className="input sm" type="date" value={range.from} onChange={e => setDate("from", e.target.value)} aria-label="Report from date" />
            </label>
            <label className="row" style={{ gap: 6 }}>
              <span className="faint">To</span>
              <input className="input sm" type="date" value={range.to} onChange={e => setDate("to", e.target.value)} aria-label="Report to date" />
            </label>
            <Select className="select sm" value={rider} onChange={e => setRider(e.target.value)} aria-label="Filter by rider" style={{ width: "auto" }}>
              <option value="">All riders</option>
              {all.map(r => (
                <option key={r.id} value={r.code}>
                  {r.code} · {r.name}
                </option>
              ))}
            </Select>
          </div>
        }
        footer="Run sheets include the filtered date range's assigned parcels, orders, and shipments."
      >
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <Empty title="Couldn't load the report">{describe(q.error)}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Rider</th>
                  <th>Zone</th>
                  <th>Vehicle</th>
                  <th className="num">Open deliveries</th>
                  <th className="num">Parcels picked up</th>
                  <th>Current status counts</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {riders.map(r => {
                  const summary = Object.keys(r.counts).filter(s => r.counts[s]).map(s => `${s}: ${r.counts[s]}`).join(" · ") || "No pickups in range";
                  return (
                    <tr key={r.id}>
                      <td>
                        <strong>
                          {r.code} · {r.name}
                        </strong>
                        <span className="sub">
                          {statusLabel(r)}
                          {r.hub ? ` · ${r.hub.name}` : ""}
                          {r.hub?.type === "FRANCHISE" ? " · Franchise rider" : ""}
                        </span>
                      </td>
                      <td>{zoneOf(r)}</td>
                      <td>{VEHICLE[r.vehicle] || r.vehicle}</td>
                      <td className="num">{num(r.openDeliveries)}</td>
                      <td className="num">{num(r.picked)}</td>
                      <td>{summary}</td>
                      <td>
                        <div className="row-actions">
                          <Button size="sm" icon="print" onClick={() => runSheet(r.code)} title="Today's assigned deliveries and pickups for this rider, in route order, with COD and signature lines">
                            Run sheet (PDF)
                          </Button>
                          {ops.can("loginAs") ? (
                            <Button size="sm" onClick={() => void loginAs({ riderId: r.id, name: `${r.code} · ${r.name}` }, { loginAs: ops.can("loginAs"), loginAsFull: ops.can("loginAsFull") })} title="Open this account in a new tab (support access: reason, time limit, recorded)">
                              Log in as
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!riders.length ? (
                  <tr>
                    <td colSpan={7} className="empty">
                      No riders match this report.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title="Assigned shipment list" subtitle="Parcels currently assigned to riders in the selected date range.">
        <div className="table-wrap" style={{ maxHeight: 520 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Tracking ID</th>
                <th>Rider</th>
                <th>Merchant / sender</th>
                <th>Recipient</th>
                <th>Destination</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {records.slice(0, 1000).map(({ rider: r, p }) => (
                <tr key={`${r.id}-${p.trackingId}`}>
                  <td>
                    <a href={`?parcel=${encodeURIComponent(p.trackingId)}`} onClick={e => (e.preventDefault(), openParcel(p.trackingId))}>
                      {p.trackingId}
                    </a>
                  </td>
                  <td>
                    {r.code} · {r.name}
                  </td>
                  <td>{p.merchant || "—"}</td>
                  <td>{p.recipient || "—"}</td>
                  <td>{p.destination || "—"}</td>
                  <td>
                    <Pill>{p.status}</Pill>
                  </td>
                </tr>
              ))}
              {!records.length ? (
                <tr>
                  <td colSpan={6} className="empty">
                    No assigned shipments in this date range.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {records.length > 1000 ? <p className="faint" style={{ padding: "8px 16px" }}>Showing the first 1,000 of {num(records.length)}; export the report or narrow the dates for the rest.</p> : null}
      </Panel>
    </>
  );
}

async function addRider(ops: ReturnType<typeof useOps>, zones: string[], done: () => void) {
  if (!ops.require("manageRiders", "add riders")) return;
  const hubs = (ops.myHubs ?? ops.hubs).filter(h => h.active !== false);
  await openForm({
    title: "Add rider",
    description: "Creates the rider's account. They sign in to the rider app with this phone number (SMS code).",
    submit: "Add rider",
    fields: [
      { id: "name", label: "Rider name", required: true, maxLength: 120, placeholder: "Full name" },
      { id: "phone", label: "Phone number", type: "phone", required: true },
      { id: "email", label: "Email", type: "email", maxLength: 120 },
      { id: "hubId", label: "Hub", type: "select", value: ops.myHubs?.[0]?.id ?? "", options: hubs.map(h => ({ value: h.id, label: h.name })), hint: "No hub yet if left empty." },
      { id: "vehicle", label: "Vehicle", type: "select", required: true, value: "MOTORBIKE", options: Object.entries(VEHICLE).map(([value, label]) => ({ value, label })) },
      {
        id: "zone",
        label: "Service zone",
        maxLength: 80,
        placeholder: "e.g. Gulshan",
        suggestions: zones,
      },
      { id: "dailyCapacity", label: "Daily capacity (stops)", type: "number", min: 1, max: 500, step: 1, placeholder: "Network default: 40" },
    ],
    validate: {
      name: v => (v.length < 2 ? "Enter the rider's full name" : ""),
      email: v => (v && !/^\S+@\S+\.\S+$/.test(v) ? "Enter a valid email or leave it empty" : ""),
      dailyCapacity: v => (v && (Number(v) < 1 || Number(v) > 500 || !Number.isInteger(Number(v))) ? "Use a whole number from 1 to 500" : ""),
    },
    onSubmit: async v => {
      const rider = await api<{ label: string; phone: string; hub?: { name: string } | null }>("/riders", {
        method: "POST",
        body: {
          name: v.name,
          phone: v.phone,
          email: v.email || undefined,
          hubId: v.hubId || undefined,
          vehicle: v.vehicle,
          zone: v.zone || undefined,
          dailyCapacity: v.dailyCapacity ? Number(v.dailyCapacity) : undefined,
        },
      });
      done();
      return `${rider.label} added${rider.hub ? ` at ${rider.hub.name}` : ""}. They can sign in to the rider app with ${localPhone(rider.phone)}.`;
    },
  });
}

// ───────────── Shifts & attendance ─────────────

interface RiderRef {
  id: string;
  label: string;
  hub?: { name: string } | null;
}
interface Roster {
  rider: RiderRef;
  schedule: { startTime: string; endTime: string } | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  late: number | null;
  state: string;
}
interface Schedule {
  id: string;
  rider: RiderRef;
  weekdays: number[];
  startTime: string;
  endTime: string;
  validFrom: string;
  validTo: string | null;
  note: string | null;
}
interface Attendance {
  id: string;
  rider: RiderRef;
  workDate: string;
  checkInAt: string;
  checkOutAt: string | null;
  late: number | null;
  minutes: number | null;
  source: string;
  note: string | null;
}
interface AttendanceReport {
  lateAfterMinutes: number;
  riders: { rider: RiderRef; scheduled: number; present: number; late: number; avgLateMinutes: number | null; absent: number; attendanceRate: number | null; hoursWorked: number }[];
}

function Shifts({ tabs }: { tabs: React.ReactNode }) {
  const ops = useOps();
  const qc = useQueryClient();
  const manage = ops.can("manageRiders");
  const [range, setRange] = useState({ from: dayKey(new Date(Date.now() - 6 * 86400000)), to: dayKey(new Date()) });
  const today = useQuery({ queryKey: ["shifts", "today"], queryFn: () => api<Roster[]>("/shifts/today"), staleTime: 30_000 });
  const schedules = useQuery({ queryKey: ["shifts", "schedules"], queryFn: () => api<{ items: Schedule[] }>("/shifts/schedules?limit=200&active=true"), staleTime: 60_000 });
  const report = useQuery({ queryKey: ["shifts", "report", range.from, range.to], queryFn: () => api<AttendanceReport>(`/shifts/report?from=${range.from}&to=${range.to}`), staleTime: 60_000 });
  const attendance = useQuery({ queryKey: ["shifts", "attendance"], queryFn: () => api<{ items: Attendance[] }>("/shifts/attendance?limit=30"), staleTime: 30_000 });
  const reload = () => void qc.invalidateQueries({ queryKey: ["shifts"] });
  useLive(["rider.shift"], reload);
  const roster = (today.data ?? []).filter(r => r.schedule || r.checkInAt);
  const setDate = (key: "from" | "to", value: string) => {
    const next = { ...range, [key]: value };
    if (!next.from || !next.to || next.from > next.to) return toast("Choose a start date on or before the end date.", "bad");
    setRange(next);
  };

  async function scheduleDialog(x?: Schedule) {
    if (!ops.require("manageRiders", "plan shifts")) return;
    const days = x?.weekdays ?? [0, 1, 2, 3, 4, 6];
    await openForm({
      title: x ? `Edit shift · ${x.rider.label}` : "Add shift",
      description: "A recurring shift. Riders check in and out from the rider app; attendance is measured against it.",
      submit: x ? "Save shift" : "Add shift",
      fields: [
        ...(x ? [] : [{ id: "riderId", label: "Rider", type: "select" as const, required: true, full: true, options: ops.riders.map(r => ({ value: r.id, label: `${r.code} · ${r.name}` })) }]),
        { id: "days", label: "Days", type: "checks", required: true, value: days.join(","), options: DAYS.map((d, i) => ({ value: String(i), label: d })) },
        { id: "startTime", label: "Starts", type: "time", required: true, value: x?.startTime ?? "08:00" },
        { id: "endTime", label: "Ends", type: "time", required: true, value: x?.endTime ?? "17:00" },
        ...(x ? [] : [{ id: "validFrom", label: "From", type: "date" as const, required: true, value: dayKey(new Date()) }]),
        { id: "validTo", label: "Until", type: "date", value: x?.validTo ? String(x.validTo).slice(0, 10) : "" },
        { id: "note", label: "Note", maxLength: 300, full: true, value: x?.note ?? "" },
      ],
      validate: { startTime: (v, all) => (v === all.endTime ? "The shift must end at a different time" : "") },
      onSubmit: async v => {
        const weekdays = v.days ? v.days.split(",").map(Number) : [];
        if (!weekdays.length) throw new Error("Choose at least one day.");
        const body = x
          ? { weekdays, startTime: v.startTime, endTime: v.endTime, validTo: v.validTo || null, note: v.note || null }
          : { riderId: v.riderId, weekdays, startTime: v.startTime, endTime: v.endTime, validFrom: v.validFrom, validTo: v.validTo || undefined, note: v.note || undefined };
        await api(x ? `/shifts/schedules/${x.id}` : "/shifts/schedules", { method: x ? "PATCH" : "POST", body });
        reload();
        return `Shift ${x ? "saved" : "added"}.`;
      },
    });
  }
  async function endSchedule(x: Schedule) {
    if (!(await confirm({ title: "End this shift schedule?", message: "It ends from today. Past attendance is kept.", ok: "End schedule", danger: true }))) return;
    try {
      await api(`/shifts/schedules/${x.id}`, { method: "PATCH", body: { active: false } });
      reload();
      toast("Shift schedule ended.", "good");
    } catch (e) {
      toastError(e);
    }
  }
  async function correct(x: Attendance) {
    if (!ops.require("manageRiders", "correct attendance")) return;
    const local = (iso?: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");
    await openForm({
      title: `Correct attendance · ${x.rider.label}`,
      description: `${x.workDate}. The change is recorded with your name and reason.`,
      submit: "Save correction",
      fields: [
        { id: "in", label: "Checked in", type: "datetime-local", required: true, value: local(x.checkInAt) },
        { id: "out", label: "Checked out", type: "datetime-local", value: local(x.checkOutAt) },
        { id: "note", label: "Reason", required: true, maxLength: 300, full: true, placeholder: "e.g. Phone battery died; confirmed with the hub" },
      ],
      validate: { note: v => (v.length < 3 ? "Give the reason for the correction" : ""), out: (v, all) => (v && v <= all.in ? "Check-out must be after check-in" : "") },
      onSubmit: async v => {
        await api(`/shifts/attendance/${x.id}`, { method: "PATCH", body: { checkInAt: new Date(v.in).toISOString(), checkOutAt: v.out ? new Date(v.out).toISOString() : null, note: v.note } });
        reload();
        return "Attendance corrected.";
      },
    });
  }
  function exportReport() {
    const r = report.data;
    if (!r) return toast("The report is still loading.");
    saveCsv(`delivery-fast-attendance-${range.from}-to-${range.to}.csv`, [
      ["Rider", "Hub", "Scheduled", "Present", "Late", "Absent", "Attendance %", "Hours"],
      ...r.riders.map(x => [x.rider.label, x.rider.hub?.name || "", x.scheduled, x.present, x.late, x.absent, x.attendanceRate ?? "", x.hoursWorked]),
    ]);
  }
  const stateTone = (s: string) => (s === "On shift" ? "good" : s === "Late" ? "warn" : s === "Absent" ? "bad" : "neutral");
  const empty = (q: { isLoading: boolean; error: unknown }, text: string) => (q.isLoading ? "Loading…" : q.error ? describe(q.error) : text);

  return (
    <>
      <PageHeading eyebrow="Fleet operations" title="Riders & fleet" subtitle="Shift plans and attendance from the rider app's check-in and check-out." />
      {tabs}
      <div className="stack-lg">
        <Panel title="Today's shift roster" subtitle="Who is scheduled, on shift, late or absent today">
          <SimpleTable head={["Rider", "Shift", "Checked in", "Checked out", "Late", "State"]} empty={empty(today, "Nobody is scheduled or checked in today.")}>
            {roster.map(r => (
              <tr key={r.rider.id}>
                <td>
                  <strong>{r.rider.label}</strong>
                  <span className="sub">{r.rider.hub?.name || "No hub"}</span>
                </td>
                <td>{r.schedule ? `${r.schedule.startTime}–${r.schedule.endTime}` : "Unscheduled"}</td>
                <td>{time(r.checkInAt)}</td>
                <td>{time(r.checkOutAt)}</td>
                <td>{r.late ? `${r.late} min` : "—"}</td>
                <td>
                  <Pill tone={stateTone(r.state)}>{r.state}</Pill>
                </td>
              </tr>
            ))}
          </SimpleTable>
        </Panel>
        <Panel
          title="Shift schedules"
          subtitle="Recurring shifts per rider (Dhaka time)"
          tools={
            manage ? (
              <Button size="sm" icon="plus" onClick={() => void scheduleDialog()}>
                Add shift
              </Button>
            ) : null
          }
        >
          <SimpleTable head={["Rider", "Days", "Hours", "Valid", "Note", ""]} empty={empty(schedules, "No shift schedules yet.")}>
            {(schedules.data?.items ?? []).map(x => (
              <tr key={x.id}>
                <td>
                  <strong>{x.rider.label}</strong>
                  <span className="sub">{x.rider.hub?.name || "No hub"}</span>
                </td>
                <td>{x.weekdays.map(d => DAYS[d]).join(", ")}</td>
                <td>
                  {x.startTime}–{x.endTime}
                </td>
                <td>
                  {fmtDate(x.validFrom)}
                  {x.validTo ? ` to ${fmtDate(x.validTo)}` : " onwards"}
                </td>
                <td>{x.note || ""}</td>
                <td>
                  {manage ? (
                    <div className="row-actions">
                      <Button size="sm" onClick={() => void scheduleDialog(x)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => void endSchedule(x)}>
                        End
                      </Button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </SimpleTable>
        </Panel>
        <Panel
          title="Attendance report"
          subtitle={report.data ? `Late = checked in more than ${report.data.lateAfterMinutes} minutes after the shift start` : "Loading…"}
          tools={
            <div className="row">
              <label className="row" style={{ gap: 6 }}>
                <span className="faint">From</span>
                <input className="input sm" type="date" value={range.from} onChange={e => setDate("from", e.target.value)} />
              </label>
              <label className="row" style={{ gap: 6 }}>
                <span className="faint">To</span>
                <input className="input sm" type="date" value={range.to} onChange={e => setDate("to", e.target.value)} />
              </label>
              <Button size="sm" icon="download" onClick={exportReport}>
                CSV
              </Button>
            </div>
          }
        >
          <SimpleTable head={["Rider", "Scheduled", "Present", "Late", "Absent", "Attendance", "Hours"]} empty={empty(report, "No riders.")}>
            {(report.data?.riders ?? []).map(x => (
              <tr key={x.rider.id}>
                <td>{x.rider.label}</td>
                <td>{x.scheduled}</td>
                <td>{x.present}</td>
                <td>
                  {x.late}
                  {x.avgLateMinutes ? <span className="sub">avg {x.avgLateMinutes} min</span> : null}
                </td>
                <td>{x.absent}</td>
                <td>{x.attendanceRate == null ? "—" : `${x.attendanceRate}%`}</td>
                <td>{x.hoursWorked}</td>
              </tr>
            ))}
          </SimpleTable>
        </Panel>
        <Panel title="Recent check-ins" subtitle="Check-ins and check-outs from the rider app; corrections are recorded with a reason">
          <SimpleTable head={["Rider", "Day", "In", "Out", "Worked", "Source", ""]} empty={empty(attendance, "No check-ins yet.")}>
            {(attendance.data?.items ?? []).map(x => (
              <tr key={x.id}>
                <td>{x.rider.label}</td>
                <td>{x.workDate}</td>
                <td>
                  {time(x.checkInAt)}
                  {x.late ? <span className="sub">{x.late} min late</span> : null}
                </td>
                <td>{x.checkOutAt ? time(x.checkOutAt) : "On shift"}</td>
                <td>{x.minutes == null ? "—" : `${Math.floor(x.minutes / 60)}h ${x.minutes % 60}m`}</td>
                <td>
                  {x.source === "OPERATIONS" ? "Corrected" : "Rider app"}
                  {x.note ? <span className="sub">{x.note}</span> : null}
                </td>
                <td>
                  {manage ? (
                    <Button size="sm" onClick={() => void correct(x)}>
                      Correct
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </SimpleTable>
        </Panel>
      </div>
    </>
  );
}

function SimpleTable({ head, empty, children }: { head: string[]; empty: string; children: React.ReactNode[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {children.length ? (
            children
          ) : (
            <tr>
              <td colSpan={head.length} className="empty">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ───────────── Verification ─────────────

const KYC: Record<string, [string, "info" | "warn" | "bad" | "good" | "neutral"]> = {
  UNDER_REVIEW: ["Waiting for review", "info"],
  DOCUMENTS_PENDING: ["Documents needed", "warn"],
  REJECTED: ["Needs changes", "bad"],
  APPROVED: ["Verified", "good"],
  NOT_STARTED: ["Not started", "neutral"],
};
const DOC: Record<string, [string, "warn" | "good" | "bad"]> = { PENDING: ["Pending", "warn"], APPROVED: ["Approved", "good"], REJECTED: ["Rejected", "bad"] };
interface KycRow {
  id: string;
  code: string;
  name: string;
  phone: string;
  vehicle: string;
  hub: { name: string } | null;
  documents: { total: number; rejected: number; pending: number };
  submittedAt: string | null;
  startedAt: string | null;
  status: string;
}
interface KycDetail {
  status: string;
  note: string | null;
  missing: string[];
  rider: { id: string; code: string; name: string; phone: string; vehicle: string };
  documents: { id: string; type: string; label: string; documentNumber: string | null; status: string; reason?: string | null; file: { mimeType: string } }[];
}

function Verification({ tabs }: { tabs: React.ReactNode }) {
  const ops = useOps();
  const qc = useQueryClient();
  const [filter, setFilter] = useState("UNDER_REVIEW");
  const q = useQuery({ queryKey: ["rider-kyc", filter], queryFn: () => api<KycRow[]>(`/rider-kyc?status=${filter}`), enabled: ops.can("manageRiders"), staleTime: 30_000 });
  useLive(["rider.kyc"], () => void qc.invalidateQueries({ queryKey: ["rider-kyc"] }));
  if (!ops.can("manageRiders"))
    return (
      <>
        <PageHeading eyebrow="Fleet operations" title="Riders & fleet" />
        {tabs}
        <Panel>
          <Empty title="Not available">Rider verification is for operations managers and super admins.</Empty>
        </Panel>
      </>
    );
  const rows = q.data ?? [];
  return (
    <>
      <PageHeading eyebrow="Fleet operations" title="Riders & fleet" subtitle="KYC documents uploaded by riders · approve or ask for changes." />
      {tabs}
      <Panel
        title="Rider verification"
        subtitle="KYC documents uploaded by riders · approve or ask for changes"
        tools={
          <Select className="select sm" style={{ width: "auto" }} value={filter} onChange={e => setFilter(e.target.value)} aria-label="Verification status">
            {Object.entries(KYC)
              .filter(([k]) => k !== "NOT_STARTED")
              .map(([k, [label]]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
          </Select>
        }
      >
        <SimpleTable head={["Rider", "Hub", "Vehicle", "Documents", "Submitted", "Status", ""]} empty={q.isLoading ? "Loading…" : q.error ? describe(q.error) : "No riders in this list."}>
          {rows.map(r => (
            <tr key={r.id}>
              <td>
                <strong>
                  {r.code} · {r.name}
                </strong>
                <span className="sub">{localPhone(r.phone)}</span>
              </td>
              <td>{r.hub?.name || "—"}</td>
              <td>{VEHICLE[r.vehicle] || r.vehicle}</td>
              <td>
                {r.documents.total}
                {r.documents.rejected ? ` · ${r.documents.rejected} rejected` : r.documents.pending ? ` · ${r.documents.pending} to check` : ""}
              </td>
              <td>{when(r.submittedAt || r.startedAt)}</td>
              <td>
                <Pill tone={(KYC[r.status] ?? [r.status, "neutral"])[1]}>{(KYC[r.status] ?? [r.status])[0]}</Pill>
              </td>
              <td>
                <Button size="sm" variant={r.status === "UNDER_REVIEW" ? "primary" : "default"} onClick={() => void openKyc(r.id, () => void qc.invalidateQueries({ queryKey: ["rider-kyc"] }))}>
                  Review
                </Button>
              </td>
            </tr>
          ))}
        </SimpleTable>
      </Panel>
    </>
  );
}

async function openKyc(riderId: string, changed: () => void) {
  let detail: KycDetail;
  try {
    detail = await api<KycDetail>(`/rider-kyc/${riderId}`);
  } catch (e) {
    return toastError(e);
  }
  await openCustom(close => <KycDialog first={detail} changed={changed} close={() => close()} />, "wide");
}

function KycDialog({ first, changed, close }: { first: KycDetail; changed: () => void; close: () => void }) {
  const [d, setD] = useState(first);
  const [files, setFiles] = useState<Record<string, { dataUrl: string; mimeType: string; filename: string } | "loading" | { error: string }>>({});
  const [note, setNote] = useState(first.note || "");
  const [busy, setBusy] = useState(false);
  const load = (id: string) => {
    setFiles(f => ({ ...f, [id]: "loading" }));
    api<{ dataUrl: string; mimeType: string; filename: string }>(`/rider-kyc/documents/${id}/file`, { headers: { accept: "application/json" } })
      .then(file => setFiles(f => ({ ...f, [id]: file })))
      .catch(e => setFiles(f => ({ ...f, [id]: { error: describe(e) } })));
  };
  // Images load in the background (they're small: resized on the phone).
  useEffect(() => {
    for (const doc of first.documents) if (doc.file.mimeType !== "application/pdf") load(doc.id);
  }, [first]);
  const labelOf = (type: string) => d.documents.find(x => x.type === type)?.label || type.replace(/_/g, " ").toLowerCase();
  async function act(work: () => Promise<KycDetail>, message: string) {
    setBusy(true);
    try {
      setD(await work());
      changed();
      toast(message, "good");
      return true;
    } catch (e) {
      toastError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function review(docId: string, decision: "APPROVE" | "REJECT") {
    let reason: string | undefined;
    if (decision === "REJECT") {
      const r = await prompt({ title: "Reject this document", message: "The rider sees the reason in the app and can upload it again.", label: "Why is it rejected?", multiline: true, ok: "Reject document", placeholder: "e.g. The photo is blurred; the NID number can't be read" });
      if (!r) return;
      if (r.trim().length < 3) return toast("Give a reason of at least 3 characters.", "bad");
      reason = r.trim();
    }
    await act(() => api(`/rider-kyc/documents/${docId}/review`, { method: "POST", body: { decision, reason } }), decision === "APPROVE" ? "Document approved." : "Document rejected.");
  }
  async function decide(decision: "APPROVE" | "REJECT") {
    const text = note.trim();
    if (decision === "REJECT" && !text) return toast("Tell the rider what to fix before asking for changes.", "bad");
    const ok = await act(
      () => api(`/rider-kyc/${d.rider.id}/decision`, { method: "POST", body: { decision, note: text || undefined } }),
      decision === "APPROVE" ? `${d.rider.code} is verified.` : `${d.rider.code} asked to update their documents.`,
    );
    if (ok) close();
  }
  return (
    <>
      <div className="dialog-head">
        <div>
          <h2>
            Verification · {d.rider.code} · {d.rider.name}
          </h2>
          <p>
            {(KYC[d.status] ?? [d.status])[0]} · {VEHICLE[d.rider.vehicle] || d.rider.vehicle} · {localPhone(d.rider.phone)}
            {d.missing.length ? ` · missing: ${d.missing.map(labelOf).join(", ")}` : ""}
          </p>
        </div>
        <button type="button" className="button ghost icon dialog-close" aria-label="Close" onClick={close}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="dialog-body">
        {d.documents.length ? (
          d.documents.map(doc => {
            const file = files[doc.id];
            return (
              <div key={doc.id} style={{ padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>
                    {doc.label}
                    {doc.documentNumber ? ` · ${doc.documentNumber}` : ""}
                  </strong>
                  <span className="row">
                    <Pill tone={(DOC[doc.status] ?? [doc.status, "warn"])[1]}>{(DOC[doc.status] ?? [doc.status])[0]}</Pill>
                    <Button size="sm" disabled={busy || doc.status === "APPROVED"} onClick={() => void review(doc.id, "APPROVE")}>
                      Approve
                    </Button>
                    <Button size="sm" variant="danger" disabled={busy || doc.status === "REJECTED"} onClick={() => void review(doc.id, "REJECT")}>
                      Reject
                    </Button>
                  </span>
                </div>
                {doc.reason ? <span className="sub">Rejected: {doc.reason}</span> : null}
                {!file ? (
                  <Button size="sm" onClick={() => load(doc.id)} style={{ marginTop: 8 }}>
                    Show
                  </Button>
                ) : file === "loading" ? (
                  <span className="faint">Loading…</span>
                ) : "error" in file ? (
                  <span style={{ color: "var(--bad)" }}>{file.error}</span>
                ) : file.mimeType === "application/pdf" ? (
                  <a className="button sm" href={file.dataUrl} download={file.filename} style={{ marginTop: 8 }}>
                    Download PDF
                  </a>
                ) : (
                  <img src={file.dataUrl} alt={doc.label} style={{ display: "block", maxWidth: "100%", maxHeight: 320, marginTop: 8, borderRadius: 8, border: "1px solid var(--line)" }} />
                )}
              </div>
            );
          })
        ) : (
          <Empty>No documents uploaded yet.</Empty>
        )}
        <label className="field" style={{ marginTop: 12 }}>
          <span>Note for the rider (required to ask for changes)</span>
          <textarea className="textarea" maxLength={500} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Your NID photo is blurred; please retake it in daylight" />
        </label>
      </div>
      <div className="dialog-foot">
        <Button variant="danger" disabled={busy} onClick={() => void decide("REJECT")}>
          Ask for changes
        </Button>
        <Button variant="primary" disabled={busy || d.status === "APPROVED"} onClick={() => void decide("APPROVE")}>
          Approve rider
        </Button>
      </div>
    </>
  );
}

/** Zone names from the service catalog, for the Add rider suggestions. */
function useRiderZones() {
  const c = useCatalog();
  return useMemo(() => (c ? [...new Set(Object.values(c.zonesByDistrict).flat())].sort() : []), [c]);
}
