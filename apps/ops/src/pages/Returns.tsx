/**
 * Returns (RTO) and Pickup › Scheduled pickups (bridge-returns.js):
 *   Returns            return requests grouped by merchant → plan a return run (rider, note), add a parcel by tracking ID,
 *                      runs (view, print sheet, dispatch with a rider, complete with the parcels not taken back, cancel),
 *                      returned parcels awaiting the merchant's confirmation, and the "Return scheduled" stage table
 *   Scheduled pickups  merchants' pickup requests (today & upcoming, or a day) → assign a rider, collected / missed,
 *                      generate from recurring schedules
 */
import { Select } from "@panel/ui/Select";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { useLive } from "@panel/lib/events";
import { addressText, money, num, when } from "@panel/lib/format";
import { useOps } from "@/lib/ops";
import { Button, Metric, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { confirm, openCustom, openForm, prompt } from "@panel/ui/dialogs";
import { toast } from "@panel/ui/toast";
import ViewTabs from "@/app/ViewTabs";
import { openDocument, refreshParcels } from "@/features/parcels/actions";
import type { Handoff } from "@/features/parcels/useParcelActions";
import { BulkUpdateButton } from "@/features/imports/ImportButtons";
import { StageTable } from "./ParcelPages";

const RUN_STATUS: Record<string, string> = { PLANNED: "Planned", OUT_FOR_RETURN: "Out for return", COMPLETED: "Completed", CANCELLED: "Cancelled" };
const PICKUP_STATUS: Record<string, string> = { REQUESTED: "Requested", ASSIGNED: "Rider assigned", COMPLETED: "Collected", CANCELLED: "Cancelled", MISSED: "Missed" };
const label = (status: string) => status.replaceAll("_", " ").toLowerCase().replace(/^./, c => c.toUpperCase());

interface ReturnItem {
  trackingId: string;
  merchantOrderRef?: string;
  merchant: { id: string; name: string; code: string };
  recipientName: string;
  deliveryZone: string;
  deliveryDistrict: string;
  attemptCount: number;
  reason?: string;
  requestedBy?: string;
  status: string;
  hub?: { name: string } | null;
  requestedAt?: string;
  run?: { number: string } | null;
  returnCharge?: number | null;
  updatedAt?: string;
}
interface Run {
  id: string;
  number: string;
  status: string;
  merchant: { id: string; name: string; pickupAddress?: string; pickupArea?: string };
  parcelCount: number;
  riderId?: string | null;
  createdAt: string;
}
interface RunDetail extends Run {
  returnCharges: number;
  parcels: { trackingId: string; recipientName: string; reason?: string; status: string; returnCharge?: number | null }[];
}

const problemsError = (error: unknown) => {
  const d = (error as { details?: { problems?: { trackingId: string; message: string }[] } })?.details;
  return d?.problems ? new Error(d.problems.map(p => `${p.trackingId}: ${p.message}`).join(" · ")) : error;
};

export default function Returns() {
  const ops = useOps();
  const qc = useQueryClient();
  const location = useLocation();
  const handoff = location.state as Handoff | null;
  const q = useQuery({
    queryKey: ["returns"],
    queryFn: async () => {
      const [requested, returned, runs] = await Promise.all([api<{ items: ReturnItem[] }>("/returns?stage=requested&limit=200"), api<{ items: ReturnItem[] }>("/returns?stage=returned&limit=100"), api<{ items: Run[] }>("/returns/runs?limit=50")]);
      return { requested: requested.items, returned: returned.items, runs: runs.items };
    },
  });
  useLive(["parcel.updated", "return_run.updated"], () => void qc.invalidateQueries({ queryKey: ["returns"] }));
  const reload = () => (void qc.invalidateQueries({ queryKey: ["returns"] }), refreshParcels());
  const riderName = (id?: string | null) => {
    const r = ops.riders.find(x => x.id === id);
    return r ? `${r.code} · ${r.name}` : id ? "Assigned rider" : "—";
  };
  const riderChoices = ops.riders.map(r => ({ value: r.id, label: `${r.code} · ${r.name}` }));
  const [picked, setPicked] = useState<Record<string, Set<string>>>({});

  function addParcel(code = "") {
    if (!ops.require("dispatch", "plan return runs")) return;
    void openForm({
      title: "Return a parcel",
      description: "For parcels operations decide to return (e.g. delivery attempts exhausted). The merchant is notified.",
      submit: "Plan return run",
      fields: [
        { id: "trackingId", label: "Tracking ID", required: true, placeholder: "PP-261016-XXXXX", maxLength: 40, value: code },
        { id: "reason", label: "Reason", required: true, maxLength: 300, value: "Delivery attempts exhausted" },
      ],
      validate: { reason: v => (v.length < 3 ? "At least 3 characters" : "") },
      onSubmit: async v => {
        const id = v.trackingId.toUpperCase();
        const parcel = await api<{ trackingId: string; merchant?: { id: string } | null }>(`/parcels/${encodeURIComponent(id)}`);
        if (!parcel.merchant?.id) throw new Error("Only merchant parcels are returned in runs. Use the parcel's status for customer parcels.");
        const run = await api<{ number: string }>("/returns/runs", { method: "POST", body: { merchantId: parcel.merchant.id, trackingIds: [parcel.trackingId], reason: v.reason } }).catch(e => {
          throw problemsError(e);
        });
        reload();
        return `${run.number} planned for ${parcel.trackingId}.`;
      },
    });
  }
  // From a parcel's "Add to return run".
  useEffect(() => {
    if (handoff?.action === "returnRun") addParcel(handoff.code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff]);

  function planRun(merchantId: string, items: ReturnItem[]) {
    const chosen = [...(picked[merchantId] ?? new Set(items.map(i => i.trackingId)))];
    if (!chosen.length) return toast("Choose at least one parcel.");
    if (!ops.require("dispatch", "plan return runs")) return;
    void openForm({
      title: `Return run · ${items[0]?.merchant.name || ""}`,
      description: `${chosen.length} parcel(s) go to RETURN_SCHEDULED and the merchant is notified.`,
      submit: "Plan return run",
      fields: [
        { id: "parcels", label: "Parcels", type: "static", value: chosen.join(", ") },
        { id: "riderId", label: "Rider (needed to dispatch)", type: "select", options: riderChoices, full: true },
        { id: "note", label: "Note", maxLength: 500, full: true },
      ],
      onSubmit: async v => {
        const run = await api<{ number: string; parcelCount: number }>("/returns/runs", { method: "POST", body: { merchantId, trackingIds: chosen, riderId: v.riderId || undefined, note: v.note || undefined } }).catch(e => {
          throw problemsError(e);
        });
        reload();
        return `${run.number} planned with ${run.parcelCount} parcel(s).`;
      },
    });
  }

  async function viewRun(id: string) {
    const run = await api<RunDetail>(`/returns/runs/${id}`);
    await openCustom(close => (
      <>
        <div className="dialog-head">
          <div>
            <h2>{`${run.number} · ${run.merchant.name}`}</h2>
            <p>{`${RUN_STATUS[run.status] || run.status} · ${run.parcelCount} parcel(s) · return charges ${money(run.returnCharges)} · ${addressText(run.merchant.pickupAddress, run.merchant.pickupArea)}`}</p>
          </div>
        </div>
        <div className="dialog-body">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Tracking</th>
                  <th>Recipient</th>
                  <th>Reason</th>
                  <th>Status</th>
                  <th className="num">Charge</th>
                </tr>
              </thead>
              <tbody>
                {run.parcels.map(p => (
                  <tr key={p.trackingId}>
                    <td className="tracking">{p.trackingId}</td>
                    <td>{p.recipientName}</td>
                    <td>{p.reason || ""}</td>
                    <td>
                      <Pill>{label(p.status)}</Pill>
                    </td>
                    <td className="num">{p.returnCharge != null ? money(p.returnCharge) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="dialog-foot">
          <button className="button primary" onClick={() => close()}>
            Close
          </button>
        </div>
      </>
    ), "wide");
  }

  function dispatchRun(run: Run) {
    if (!ops.require("dispatch", "update return runs")) return;
    void openForm({
      title: `Dispatch ${run.number}`,
      description: "The rider takes the parcels back to the merchant.",
      submit: "Dispatch",
      fields: [{ id: "riderId", label: "Rider", type: "select", required: true, value: run.riderId || "", options: riderChoices, full: true }],
      onSubmit: async v => {
        const done = await api<{ number: string }>(`/returns/runs/${run.id}/dispatch`, { method: "POST", body: { riderId: v.riderId } });
        reload();
        return `${done.number} is out for return.`;
      },
    });
  }

  async function completeRun(run: Run) {
    if (!ops.require("dispatch", "update return runs")) return;
    const full = await api<RunDetail>(`/returns/runs/${run.id}`);
    await openCustom(close => <CompleteRun run={full} close={close} onDone={reload} />, "wide");
  }

  const data = q.data;
  const groups = new Map<string, ReturnItem[]>();
  for (const r of data?.requested ?? []) groups.set(r.merchant.id, [...(groups.get(r.merchant.id) ?? []), r]);
  return (
    <>
      <PageHeading
        eyebrow="Network operations"
        title="Returns"
        subtitle="Bring undeliverable parcels back to merchants in planned return runs. The return charge follows each parcel's rate card."
        actions={
          <>
            <Button onClick={() => addParcel()}>Add parcel by tracking ID</Button>
            <BulkUpdateButton kind="returns" />
            <BulkUpdateButton kind="returns" history />
            <Button icon="refresh" onClick={async () => (await q.refetch(), toast("Returns refreshed."))}>
              Refresh
            </Button>
          </>
        }
      />
      {q.isError ? <div className="callout bad">{describe(q.error)}</div> : null}
      <div className="metrics">
        <Metric label="Return requests" value={data ? num(data.requested.length) : "—"} icon="box" foot="waiting for a run" />
        <Metric label="Runs in progress" value={data ? num(data.runs.filter(r => r.status === "PLANNED" || r.status === "OUT_FOR_RETURN").length) : "—"} icon="truck" foot="planned or out" />
        <Metric label="Returned, unconfirmed" value={data ? num(data.returned.length) : "—"} icon="check" foot="awaiting merchant receipt" />
      </div>
      {data && !groups.size ? <div className="panel panel-body muted" style={{ marginBottom: 16 }}>No return requests waiting. Merchants request returns from their panel; you can also add a parcel by tracking ID.</div> : null}
      {[...groups.entries()].map(([merchantId, items]) => {
        const sel = picked[merchantId] ?? new Set(items.map(i => i.trackingId));
        const toggle = (id: string) => {
          const next = new Set(sel);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          setPicked(p => ({ ...p, [merchantId]: next }));
        };
        return (
          <Panel
            key={merchantId}
            title={items[0].merchant.name}
            subtitle={`${items[0].merchant.code} · ${items.length} parcel(s) to return`}
            tools={
              <Button size="sm" variant="primary" onClick={() => planRun(merchantId, items)}>
                Plan return run
              </Button>
            }
          >
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th className="check-cell">
                      <input type="checkbox" aria-label="Select all" checked={sel.size === items.length} onChange={e => setPicked(p => ({ ...p, [merchantId]: e.target.checked ? new Set(items.map(i => i.trackingId)) : new Set() }))} />
                    </th>
                    <th>Tracking</th>
                    <th>Recipient</th>
                    <th>Reason</th>
                    <th>Status</th>
                    <th>Hub</th>
                    <th>Requested</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(r => (
                    <tr key={r.trackingId}>
                      <td className="check-cell">
                        <input type="checkbox" checked={sel.has(r.trackingId)} onChange={() => toggle(r.trackingId)} aria-label={`Select ${r.trackingId}`} />
                      </td>
                      <td>
                        <span className="strong">{r.trackingId}</span>
                        <span className="sub">{r.merchantOrderRef || ""}</span>
                      </td>
                      <td>
                        {r.recipientName}
                        <span className="sub">{`${r.deliveryZone}, ${r.deliveryDistrict} · ${r.attemptCount} attempt(s)`}</span>
                      </td>
                      <td>
                        {r.reason || "—"}
                        <span className="sub">{r.requestedBy || ""}</span>
                      </td>
                      <td>
                        <Pill>{label(r.status)}</Pill>
                      </td>
                      <td>{r.hub?.name || "—"}</td>
                      <td className="nowrap">{when(r.requestedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        );
      })}
      <Panel title="Return runs" subtitle="Latest 50">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Merchant</th>
                <th className="num">Parcels</th>
                <th>Rider</th>
                <th>Status</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.runs.length ? (
                data.runs.map(run => (
                  <tr key={run.id}>
                    <td className="strong">{run.number}</td>
                    <td>
                      {run.merchant.name}
                      <span className="sub">{run.merchant.pickupAddress || ""}</span>
                    </td>
                    <td className="num">{run.parcelCount}</td>
                    <td>{riderName(run.riderId)}</td>
                    <td>
                      <Pill>{RUN_STATUS[run.status] || run.status}</Pill>
                    </td>
                    <td className="nowrap">{when(run.createdAt)}</td>
                    <td>
                      <div className="row-actions">
                        <Button size="sm" onClick={() => viewRun(run.id)}>
                          View
                        </Button>
                        <Button size="sm" icon="print" title="Return run sheet (PDF): parcels, reasons, return charges and signatures" onClick={() => openDocument(`/documents/return-run/${run.id}`, { title: "Preparing the return run sheet…" })}>
                          Print
                        </Button>
                        {run.status === "PLANNED" ? (
                          <>
                            <Button size="sm" onClick={() => dispatchRun(run)}>
                              Dispatch
                            </Button>
                            <Button
                              size="sm"
                              onClick={async () => {
                                if (!(await confirm({ title: "Cancel this return run?", message: "Its parcels go back to the hub and keep their return request.", ok: "Cancel run", cancel: "Keep it", danger: true }))) return;
                                if (!ops.require("dispatch", "update return runs")) return;
                                const done = await api<{ number: string }>(`/returns/runs/${run.id}/cancel`, { method: "POST" });
                                reload();
                                toast(`${done.number} cancelled.`);
                              }}
                            >
                              Cancel
                            </Button>
                          </>
                        ) : run.status === "OUT_FOR_RETURN" ? (
                          <Button size="sm" variant="primary" onClick={() => completeRun(run)}>
                            Complete
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="empty">
                    {q.isLoading ? "Loading…" : "No return runs yet."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="Returned · awaiting merchant confirmation">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Tracking</th>
                <th>Merchant</th>
                <th>Run</th>
                <th className="num">Return charge</th>
                <th>Returned</th>
              </tr>
            </thead>
            <tbody>
              {data?.returned.length ? (
                data.returned.map(r => (
                  <tr key={r.trackingId}>
                    <td className="strong">{r.trackingId}</td>
                    <td>{r.merchant.name}</td>
                    <td>{r.run?.number || "—"}</td>
                    <td className="num">{r.returnCharge != null ? money(r.returnCharge) : "—"}</td>
                    <td className="nowrap">{when(r.updatedAt)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="empty">
                    Nothing awaiting confirmation.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
      <StageTable id="returns" stage="returns" title="Return scheduled" subtitle="Parcels going back to their merchants on a return run" empty="No parcels are on a return run." />
    </>
  );
}

function CompleteRun({ run, close, onDone }: { run: RunDetail; close: () => void; onDone: () => void }) {
  const [notReturned, setNot] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <div className="dialog-head">
        <div>
          <h2>Complete {run.number}</h2>
          <p>Parcels the merchant took back become RETURNED (the return charge is booked). Tick any that weren't taken back; they go back to the hub.</p>
        </div>
      </div>
      <div className="dialog-body stack">
        <div className="field">
          <span className="field-label">Parcels not taken back</span>
          {run.parcels.length ? (
            run.parcels.map(p => (
              <label key={p.trackingId} className="check">
                <input
                  type="checkbox"
                  checked={notReturned.has(p.trackingId)}
                  onChange={e => {
                    const next = new Set(notReturned);
                    if (e.target.checked) next.add(p.trackingId);
                    else next.delete(p.trackingId);
                    setNot(next);
                  }}
                />
                {`${p.trackingId} · ${p.recipientName}`} <small className="faint">(not taken back)</small>
              </label>
            ))
          ) : (
            <span className="muted">No parcels.</span>
          )}
        </div>
        <label className="field">
          <span>Note (optional)</span>
          <input className="input" maxLength={500} value={note} onChange={e => setNote(e.target.value)} />
        </label>
        {error ? <div className="form-error">{error}</div> : null}
      </div>
      <div className="dialog-foot">
        <button className="button" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button
          className="button primary"
          aria-busy={busy || undefined}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const done = await api<{ number: string }>(`/returns/runs/${run.id}/complete`, { method: "POST", body: { notReturned: [...notReturned], note: note || undefined } });
              onDone();
              toast(`${done.number} completed.`, "good");
              close();
            } catch (e) {
              setError(describe(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Complete run
        </button>
      </div>
    </>
  );
}

// ───────────── Pickup › Scheduled pickups ─────────────

interface PickupRequest {
  id: string;
  number: string;
  schedule?: { name: string } | null;
  merchant: { name?: string; code?: string };
  date: string;
  windowStart: string;
  windowEnd: string;
  street?: string;
  area?: string;
  zone?: string;
  district?: string;
  contactName: string;
  contactPhone: string;
  note?: string | null;
  expectedParcels: number;
  riderId?: string | null;
  status: string;
}
const dhakaToday = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.parse(`${dhakaToday()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dayLabel = (d: string) => (d === dhakaToday() ? "Today" : d === plusDays(1) ? "Tomorrow" : new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }));
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Dhaka" });

export function ScheduledPickups({ tab }: { tab: string }) {
  const ops = useOps();
  const qc = useQueryClient();
  const [date, setDate] = useState("upcoming");
  const q = useQuery({
    queryKey: ["pickup-requests", date],
    queryFn: async () => {
      const range = date === "upcoming" ? `from=${dhakaToday()}&to=${plusDays(30)}` : `date=${date}`;
      const page = await api<{ items: PickupRequest[] }>(`/pickup-requests?${range}&limit=200`);
      return page.items.sort((a, b) => Date.parse(a.windowStart) - Date.parse(b.windowStart));
    },
  });
  useLive(["pickup_request.updated", "parcel.updated"], () => void qc.invalidateQueries({ queryKey: ["pickup-requests"] }));
  const act = async (id: string, path: string, body: unknown, success: string) => {
    if (!ops.require("dispatch", "update pickups")) return;
    try {
      await api(`/pickup-requests/${id}/${path}`, { method: "POST", body });
      toast(success, "good");
    } finally {
      void q.refetch();
    }
  };
  const riderName = (id?: string | null) => {
    const r = ops.riders.find(x => x.id === id);
    return r ? `${r.code} · ${r.name}` : id ? "Assigned rider" : "—";
  };
  const days = [-1, 0, 1, 2, 3].map(plusDays);
  const items = q.data;
  const count = (s: string) => (items || []).filter(r => r.status === s).length;
  return (
    <>
      <PageHeading
        eyebrow="Network operations"
        title="Pickup"
        subtitle="Merchant pickup visits from recurring schedules and one-off requests. Assign a rider before the window starts."
        actions={
          <>
            <Select className="select" aria-label="Day" value={date} onChange={e => setDate(e.target.value)}>
              <option value="upcoming">Today & upcoming</option>
              {days.map(d => (
                <option key={d} value={d}>
                  {dayLabel(d)}
                </option>
              ))}
            </Select>
            <Button
              onClick={async () => {
                const result = await api<{ created: number }>("/pickup-requests/generate", { method: "POST", body: date === "upcoming" ? {} : { date } });
                await q.refetch();
                toast(`${result.created} pickup(s) created from recurring schedules.`, "good");
              }}
            >
              Generate from schedules
            </Button>
          </>
        }
      />
      <ViewTabs view="Pickup" tab={tab} />
      <div className="metrics">
        {(
          [
            ["Requested", count("REQUESTED")],
            ["Rider assigned", count("ASSIGNED")],
            ["Collected", count("COMPLETED")],
          ] as [string, number][]
        ).map(([l, v]) => (
          <Metric key={l} label={l} value={num(v)} foot={date === "upcoming" ? "Today & upcoming" : dayLabel(date)} />
        ))}
      </div>
      <Panel>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Pickup</th>
                <th>Merchant</th>
                <th>Window</th>
                <th>Address</th>
                <th className="num">Parcels</th>
                <th>Rider</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items?.length ? (
                items.map(r => {
                  const open = r.status === "REQUESTED" || r.status === "ASSIGNED";
                  return (
                    <tr key={r.id}>
                      <td>
                        <span className="strong">{r.number}</span>
                        <span className="sub">{r.schedule?.name || "One-off request"}</span>
                      </td>
                      <td>
                        {r.merchant.name || ""}
                        <span className="sub">{r.merchant.code || ""}</span>
                      </td>
                      <td className="nowrap">
                        {date === "upcoming" ? <strong>{dayLabel(r.date)}</strong> : null}
                        <span className={date === "upcoming" ? "sub" : undefined}>{`${time(r.windowStart)} – ${time(r.windowEnd)}`}</span>
                      </td>
                      <td>
                        {addressText(r.street, r.area, r.zone, r.district)}
                        <span className="sub">{`${r.contactName} · ${r.contactPhone}${r.note ? ` · ${r.note}` : ""}`}</span>
                      </td>
                      <td className="num">{r.expectedParcels}</td>
                      <td>
                        {open ? (
                          <Select className="select sm" aria-label="Rider" value={r.riderId || ""} onChange={e => e.target.value && void act(r.id, "assign", { riderId: e.target.value }, "Rider assigned to the pickup.").catch(err => toast(describe(err), "bad"))}>
                            <option value="">Choose a rider…</option>
                            {ops.riders.map(x => (
                              <option key={x.id} value={x.id}>{`${x.code} · ${x.name}`}</option>
                            ))}
                          </Select>
                        ) : (
                          riderName(r.riderId)
                        )}
                      </td>
                      <td>
                        <Pill>{PICKUP_STATUS[r.status] || r.status}</Pill>
                      </td>
                      <td>
                        {open ? (
                          <div className="row-actions">
                            <Button size="sm" variant="primary" onClick={() => act(r.id, "complete", undefined, "Pickup marked as collected.")}>
                              Collected
                            </Button>
                            <Button
                              size="sm"
                              onClick={async () => {
                                const note = await prompt({ title: "Mark the pickup as missed", message: "The merchant is notified.", label: "Why was the pickup missed?", multiline: true, required: false, ok: "Mark missed", placeholder: "e.g. Shop closed when the rider arrived" });
                                if (note === null) return;
                                await act(r.id, "missed", { note: note || undefined }, "Pickup marked as missed. The merchant was notified.");
                              }}
                            >
                              Missed
                            </Button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={8} className="empty">
                    {q.isError ? describe(q.error) : items ? (date === "upcoming" ? "No pickups scheduled from today on." : "No pickups scheduled for this day.") : "Loading…"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
