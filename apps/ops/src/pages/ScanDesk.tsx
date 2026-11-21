/**
 * Scan desk: the Operations app's Scan on the web, in the same groups and names. At the hub: Assign pickup rider,
 * Receive at hub, Hub transfer, Hub return, Delivery rider assign, Return rider assign. Hub collection. CN labels:
 * CN Assign Merchant, CN Scan Details. Rider operation: a rider's app steps done for them (RiderOperation). Each scan
 * does the step at once and the fields above apply to the scans that follow. Logs, counters and choices stay while you
 * switch tabs.
 */
import { Select } from "@panel/ui/Select";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { useLive } from "@panel/lib/events";
import { localPhone, num } from "@panel/lib/format";
import { useOps } from "@/lib/ops";
import { Button, Empty, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { toast } from "@panel/ui/toast";
import ViewTabs from "@/app/ViewTabs";
import { viewById } from "@/app/nav";
import { printLabels } from "@/features/parcels/actions";
import { findParcels } from "@/features/parcels/search";
import { useParcelActions } from "@/features/parcels/useParcelActions";
import { OperationTimeBar } from "@/features/scan/OperationTime";
import { CnMerchantDesk, CnScanDetailsDesk } from "@/features/scan/CnDesk";
import RiderOperation from "@/features/scan/RiderOperation";
import { LogList, type LogEntry } from "@/features/scan/deskShared";
import "@/features/scan/cn-desk.css";
import { normalizeScan, ScanInput, type ScanInputHandle, type ScanSource } from "@/features/scan/scanner";
import type { Handoff } from "@/features/parcels/useParcelActions";
import { useLocation } from "react-router";
import { StageTable } from "./ParcelPages";

/** Fallback while the super admin's list loads (GET /returns/reasons). */
const RETURN_REASONS = ["Recipient refused", "Recipient unreachable", "Wrong or incomplete address", "Recipient asked to cancel", "Damaged in transit", "Merchant cancelled the order", "Delivery attempts exhausted"];

type Part = "assign" | "transfer" | "returntransfer" | "returnassign";
interface TabCfg {
  path: string;
  /** Another endpoint than /hub-desk/<path>. */
  endpoint?: string;
  title: string;
  subtitle: string;
  done: string[];
  counter: string;
  hint: string;
  hub?: boolean;
  toHub?: boolean;
  rider?: boolean;
  riderRequired?: boolean;
  returnReason?: boolean;
  runs?: boolean;
  /** Shows the returns held at this hub (GET /hub-desk/returns-summary). */
  waiting?: boolean;
}
const TABS: Record<Part, TabCfg> = {
  assign: {
    path: "assign",
    endpoint: "/ops/hub-assign",
    title: "Delivery rider assign",
    subtitle: "Choose the rider, then scan the parcels they take. A parcel not received here yet (in transit to this hub, a drop-off, back from a rider) is received and given to the rider in one scan. Scanning it for another rider moves it to that rider.",
    done: ["ASSIGNED", "REASSIGNED"],
    counter: "assigned",
    rider: true,
    riderRequired: true,
    hub: true,
    hint: "The rider can go out at once (the rider scans Start deliveries in the app, or Rider operation › Start deliveries here). The rider doesn't need to scan to receive them.",
  },
  transfer: {
    path: "transfer",
    title: "Hub transfer",
    subtitle: "Parcels received here that another hub delivers: scan each one and it's on its way there (in transit). The destination is the hub serving the delivery area unless you choose one.",
    done: ["IN_TRANSIT"],
    counter: "sent",
    toHub: true,
    hint: "Parcels already packed in a transfer bag travel with the bag (Transfers). The destination hub receives them on its Receive at hub.",
  },
  returntransfer: {
    path: "return-transfer",
    title: "Hub return",
    subtitle: "Returns held at this hub leave for the central hub: scan each one and it's on its way (in transit). The central hub receives them on Receive at hub, then puts them on return runs.",
    done: ["SENT_TO_CENTRAL"],
    counter: "sent",
    returnReason: true,
    hub: true,
    waiting: true,
    hint: "Only parcels going back to their merchant. A parcel nobody asked to return yet is marked for return with the reason above first; leave it empty to send only the returns already marked (Could not deliver → Return to sender, or the merchant's request).",
  },
  returnassign: {
    path: "return-assign",
    title: "Return rider assign",
    subtitle: "Parcels going back to their merchants: choose the rider, then scan. Each parcel joins that rider's return run for its merchant (one run per merchant). Send the runs out below when the rider leaves.",
    done: ["ASSIGNED"],
    counter: "assigned",
    rider: true,
    riderRequired: true,
    returnReason: true,
    hub: true,
    runs: true,
    hint: "The reason is used only for parcels nobody asked to return yet. The rider sees the returns in the rider app and scans each parcel the merchant takes back (Returned to merchant); or do it for the rider on Rider operation › Returned to merchant.",
  },
};
const TAB_PART: Record<string, Part | "pickupassign" | "receive" | "collect" | "cnmerchant" | "cnscan" | "rider"> = {
  "Assign pickup rider": "pickupassign",
  "Receive at hub": "receive",
  "Hub transfer": "transfer",
  "Hub return": "returntransfer",
  "Delivery rider assign": "assign",
  "Return rider assign": "returnassign",
  "Hub collection": "collect",
  "CN Assign Merchant": "cnmerchant",
  "CN Scan Details": "cnscan",
  "Rider operation": "rider",
};

/** Kept while the panel is open (switching tabs keeps the work). */
const desk = {
  hubId: "",
  riderId: "",
  toHubId: "",
  returnReason: "",
  log: Object.fromEntries(Object.keys(TABS).map(k => [k, [] as LogEntry[]])) as Record<Part, LogEntry[]>,
  count: Object.fromEntries(Object.keys(TABS).map(k => [k, 0])) as Record<Part, number>,
  queue: Promise.resolve() as Promise<unknown>,
};

export default function ScanDesk({ tab }: { tab: string }) {
  const view = viewById("Scan desk")!;
  const part = TAB_PART[tab] ?? "receive";
  return (
    <>
      <PageHeading title="Scan desk" subtitle={view.subtitle} actions={<OperationTimeBar />} />
      <ViewTabs view="Scan desk" tab={tab} />
      <p className="faint" style={{ margin: "-6px 0 12px", fontSize: 12 }}>
        Keyboard: <kbd>/</kbd> find a parcel · <kbd>F2</kbd> scan box · <kbd>Esc</kbd> close the dialog or drawer
      </p>
      {part === "receive" ? (
        <ReceiveDesk />
      ) : part === "pickupassign" ? (
        <PickupAssign />
      ) : part === "collect" ? (
        <CollectCounter />
      ) : part === "cnmerchant" ? (
        <CnMerchantDesk />
      ) : part === "cnscan" ? (
        <CnScanDetailsDesk />
      ) : part === "rider" ? (
        <RiderOperation />
      ) : (
        <HubDeskTab key={part} part={part} />
      )}
    </>
  );
}

/** Assign pickup rider: the Pickup page's lists (accepted orders without a pickup rider, and those being picked up). */
function PickupAssign() {
  return (
    <>
      <StageTable id="pickup-waiting" stage="pickup_waiting" title="Waiting for a pickup rider" subtitle="Accepted orders without a pickup rider: tick them and assign a pickup rider (new orders are accepted with a rider in New orders)" empty="Every accepted order has a pickup rider." />
      <StageTable id="pickup-active" stage="pickup" title="Being picked up" subtitle="Pickup assigned, confirmed or picked up · on the way to the hub" empty="No pickups in progress." />
    </>
  );
}

function useOwnHub() {
  const ops = useOps();
  return ops.myHubs?.length === 1 ? ops.myHubs[0] : null;
}

function HubDeskTab({ part }: { part: Part }) {
  const t = TABS[part];
  const ops = useOps();
  const own = useOwnHub();
  const box = useRef<ScanInputHandle>(null);
  const [, force] = useState(0);
  const redraw = () => force(n => n + 1);
  const set = (patch: Partial<typeof desk>) => (Object.assign(desk, patch), redraw());
  const returnReasons = useQuery({ queryKey: ["return-reasons"], queryFn: async () => (await api<{ reasons: string[] }>("/returns/reasons")).reasons, enabled: !!t.returnReason, staleTime: 10 * 60_000 });
  const hubId = own?.id || desk.hubId;
  const runs = useQuery({
    queryKey: ["hub-desk", "return-runs", hubId],
    queryFn: () => api<{ items: { id: string; number: string; merchant?: { name: string }; rider?: string; parcels: number }[] }>(`/hub-desk/return-runs${hubId ? `?hubId=${encodeURIComponent(hubId)}` : ""}`),
    enabled: !!t.runs,
  });
  const summary = useQuery({
    queryKey: ["hub-desk", "returns-summary", hubId],
    queryFn: () => api<ReturnsSummary>(`/hub-desk/returns-summary?hubId=${encodeURIComponent(hubId)}`),
    enabled: !!t.waiting && !!hubId,
  });
  useLive(["parcel.updated", "return_run.updated"], () => void (t.waiting && hubId && summary.refetch()));

  function add(entry: LogEntry) {
    desk.log[part] = [entry, ...desk.log[part]].slice(0, 100);
    redraw();
  }

  function scan(code: string, source: ScanSource) {
    const body: Record<string, unknown> = { code, source };
    const hub = t.hub ? own?.id || desk.hubId || undefined : undefined;
    if (hub) body.hubId = hub;
    if (t.riderRequired && !desk.riderId) {
      box.current?.feedback(false, "Choose the rider first, then scan.");
      return add({ tone: "bad", message: "Choose the rider first, then scan.", at: new Date() });
    }
    if (t.rider && desk.riderId) body.riderId = desk.riderId;
    if (t.returnReason && desk.returnReason.trim()) body.reason = desk.returnReason.trim();
    if (t.toHub && desk.toHubId) body.toHubId = desk.toHubId;
    desk.queue = desk.queue.then(async () => {
      let r: { ok: boolean; outcome?: string; message: string };
      try {
        r = await api(t.endpoint ?? `/hub-desk/${t.path}`, { method: "POST", body });
      } catch (error) {
        r = { ok: false, message: describe(error) };
      }
      box.current?.feedback(r.ok, r.message);
      const tone = !r.ok ? "bad" : t.done.includes(r.outcome || "") || r.outcome === "UPDATED" ? "" : "info";
      if (r.ok && t.done.includes(r.outcome || "")) desk.count[part]++;
      add({ tone, message: r.message, at: new Date() });
      if (t.runs && r.ok) void runs.refetch();
      if (t.waiting && r.ok) void summary.refetch();
    });
  }

  const hubs = ops.myHubs || ops.hubs.filter(h => h.active !== false);
  const riders = ops.riders.filter(r => r.active !== false);
  return (
    <Panel
      title={`${t.title}${t.hub && own ? ` · ${own.name}` : ""}`}
      subtitle={t.subtitle}
      tools={<span className="pill neutral">{`${desk.count[part]} ${t.counter}`}</span>}
    >
      <div className="panel-body">
        <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
          {t.hub && !own ? (
            <label className="field">
              <span>Hub you're working at</span>
              <Select className="select" value={desk.hubId} onChange={e => set({ hubId: e.target.value })}>
                <option value="">The parcel's hub</option>
                {hubs.map(h => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          {t.toHub ? (
            <label className="field">
              <span>Send to</span>
              <Select className="select" value={desk.toHubId} onChange={e => set({ toHubId: e.target.value })}>
                <option value="">The hub serving the delivery area (automatic)</option>
                {ops.hubs
                  .filter(h => h.active !== false && h.id !== own?.id)
                  .map(h => (
                    <option key={h.id} value={h.id}>
                      {h.type === "FRANCHISE" ? `${h.name} · Franchise` : h.name}
                    </option>
                  ))}
              </Select>
            </label>
          ) : null}
          {t.rider ? (
            <label className="field">
              <span>{part === "returnassign" ? "Rider taking the returns" : "Rider"}</span>
              <Select className="select" value={desk.riderId} onChange={e => set({ riderId: e.target.value })}>
                <option value="">— Choose the rider —</option>
                {riders.map(r => (
                  <option key={r.id} value={r.id}>
                    {`${r.label || `${r.code} · ${r.name}`}${r.hub?.name ? ` · ${r.hub.name}` : ""}`}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          {t.returnReason ? (
            <label className="field">
              <span>Return reason (if none yet)</span>
              <input className="input" maxLength={300} list="hdReasons" placeholder="e.g. Recipient refused" value={desk.returnReason} onChange={e => set({ returnReason: e.target.value })} />
              <datalist id="hdReasons">
                {(returnReasons.data ?? RETURN_REASONS).map(r => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </label>
          ) : null}
        </div>
        <div style={{ marginTop: 14 }}>
          <ScanInput ref={box} onScan={scan} id="hdScan" />
        </div>
        <p className="muted" style={{ margin: "10px 0 0", fontSize: 12.5 }}>
          {t.hint}
        </p>
        <LogList entries={desk.log[part]} />
        {t.waiting ? <ReturnsWaiting data={summary.data} error={summary.error} loading={summary.isLoading} hubChosen={!!hubId} /> : null}
        {t.runs ? <ReturnRuns runs={runs.data?.items} error={runs.error} loading={runs.isLoading} onSent={(n: string) => (add({ tone: "", message: `Return run ${n} is out with its rider.`, at: new Date() }), void runs.refetch())} /> : null}
      </div>
    </Panel>
  );
}

interface ReturnsSummary {
  centralHub: { id: string; name: string; code: string } | null;
  isCentral: boolean;
  waiting: { count: number; next: "TRANSFER" | "ASSIGN_RIDER"; items: { trackingId: string; merchant: string | null; reason: string | null; recipient: string | null }[] };
  coming: { count: number; items: { trackingId: string; merchant: string | null; reason: string | null }[] };
  plannedRuns: number;
  outForReturn: number;
}

/** The returns held at this hub, with their next step (the central hub also sees what's on its way). */
function ReturnsWaiting({ data, error, loading, hubChosen }: { data?: ReturnsSummary; error: unknown; loading: boolean; hubChosen: boolean }) {
  if (!hubChosen) return <p className="muted" style={{ marginTop: 16 }}>Choose the hub to see the returns held there.</p>;
  if (loading) return <p className="muted">Loading the returns at this hub…</p>;
  if (error) return <p className="muted">{describe(error)}</p>;
  if (!data) return null;
  const next = data.waiting.next === "TRANSFER" ? `send to ${data.centralHub?.name ?? "the central hub"} (Hub return)` : "put on a return run (Return rider assign)";
  return (
    <div style={{ marginTop: 16 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <Pill tone={data.waiting.count ? "warn" : "neutral"}>{`${data.waiting.count} held here`}</Pill>
        {data.isCentral ? <Pill tone={data.coming.count ? "info" : "neutral"}>{`${data.coming.count} on the way here`}</Pill> : null}
        <Pill tone="neutral">{`${data.plannedRuns} planned run${data.plannedRuns === 1 ? "" : "s"}`}</Pill>
        <Pill tone="neutral">{`${data.outForReturn} out for return`}</Pill>
        <small className="faint">{data.centralHub ? (data.isCentral ? "This is the central hub." : `Central hub: ${data.centralHub.name}`) : "No central hub is set (super admin › Platform settings)."}</small>
      </div>
      {data.waiting.count ? (
        <>
          <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>{`Returns held here · next: ${next}`}</h3>
          <div className="table-wrap" style={{ maxHeight: 320, overflow: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Parcel</th>
                  <th>Merchant</th>
                  <th>Reason</th>
                  <th>Recipient</th>
                </tr>
              </thead>
              <tbody>
                {data.waiting.items.map(p => (
                  <tr key={p.trackingId}>
                    <td className="strong">{p.trackingId}</td>
                    <td>{p.merchant || "—"}</td>
                    <td>{p.reason || "—"}</td>
                    <td>{p.recipient || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="muted">No return held at this hub.</p>
      )}
    </div>
  );
}

function ReturnRuns({ runs, error, loading, onSent }: { runs?: { id: string; number: string; merchant?: { name: string }; rider?: string; parcels: number }[]; error: unknown; loading: boolean; onSent: (number: string) => void }) {
  if (loading) return <p className="muted">Loading the planned return runs…</p>;
  if (error) return <p className="muted">{describe(error)}</p>;
  if (!runs?.length) return <p className="muted">No planned return run. Scanned parcels make one per merchant and rider.</p>;
  return (
    <div style={{ marginTop: 16 }}>
      <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Planned return runs</h3>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Merchant</th>
              <th>Rider</th>
              <th className="num">Parcels</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {runs.map(r => (
              <tr key={r.id}>
                <td className="strong">{r.number}</td>
                <td>{r.merchant?.name || "—"}</td>
                <td>{r.rider || "—"}</td>
                <td className="num">{r.parcels}</td>
                <td className="num">
                  <Button size="sm" variant="primary" onClick={async () => (await api(`/returns/runs/${encodeURIComponent(r.id)}/dispatch`, { method: "POST", body: {} }), onSent(r.number))}>
                    Send out
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ───────────── Receive at hub ─────────────

const OUTCOME: Record<string, { label: string; tone: "good" | "info" | "bad" | "warn" }> = {
  RECEIVED: { label: "Received", tone: "good" },
  BAG_RECEIVED: { label: "Bag received", tone: "good" },
  TRIP: { label: "Manifest", tone: "info" },
  EXTRA: { label: "Extra parcel", tone: "bad" },
  NOT_IN_TRANSIT: { label: "Not departed", tone: "warn" },
  ALREADY_RECEIVED: { label: "Already received", tone: "info" },
  WRONG_HUB: { label: "Wrong hub", tone: "bad" },
  NOT_FOUND: { label: "Not found", tone: "bad" },
  NOT_DROP_OFF: { label: "Not a drop-off", tone: "warn" },
  REFUSED: { label: "Refused", tone: "bad" },
  ERROR: { label: "Not sent", tone: "bad" },
  PENDING: { label: "Checking…", tone: "info" },
};
interface Batch {
  id: string;
  number: string;
  expected: number;
  received: number;
  missing: number;
  cancelled?: number;
  fileName?: string | null;
}
interface ReceiveEntry {
  code: string;
  outcome: string;
  message: string;
  at: string;
  parcel?: { trackingId: string; merchant?: string; recipient?: string; destination?: string; inBatch?: boolean };
}
const DESK_HUB_KEY = "deliveryfast-receive-desk-hub";
const receive = { hubId: "", batchId: "", decision: "RIDER", log: [] as ReceiveEntry[], received: 0, queue: Promise.resolve() as Promise<unknown>, feedback: { tone: "", text: "Scan with a USB scanner (keyboard mode), use the camera, or type a tracking ID / CN and press Enter. The box stays ready for the next parcel." } };

function ReceiveDesk() {
  const ops = useOps();
  const location = useLocation();
  const actions = useParcelActions();
  const box = useRef<ScanInputHandle>(null);
  const [, force] = useState(0);
  const redraw = () => force(n => n + 1);
  const hubs = ops.myHubs || ops.hubs;
  const handoff = location.state as Handoff | null;
  if (!receive.hubId || !hubs.some(h => h.id === receive.hubId)) {
    let remembered: string | null = null;
    try {
      remembered = localStorage.getItem(DESK_HUB_KEY);
    } catch {
      /* blocked */
    }
    receive.hubId = (hubs.some(h => h.id === remembered) && remembered) || hubs[0]?.id || "";
  }
  // From a parcel's "Receive": its drop-off hub and its code ready in the box.
  useEffect(() => {
    if (handoff?.action !== "receive") return;
    if (handoff.hubId && hubs.some(h => h.id === handoff.hubId)) receive.hubId = handoff.hubId;
    const input = document.getElementById("rdCode") as HTMLInputElement | null;
    if (input && handoff.code) {
      input.value = handoff.code;
      input.focus();
    }
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff]);
  const qc = useQueryClient();
  const batches = useQuery({
    queryKey: ["booking-batches", receive.hubId],
    queryFn: async () => (await api<{ items: Batch[] }>(`/ops/booking-batches?intake=DROP_OFF&hubId=${receive.hubId}&limit=30`)).items,
    enabled: !!receive.hubId,
    retry: false,
  });
  useLive(["parcel.updated"], () => receive.batchId && void qc.invalidateQueries({ queryKey: ["booking-batches"] }), { debounceMs: 1500 });
  const [missing, setMissing] = useState<{ trackingId: string; recipient: string; destination: string; merchantOrderRef?: string }[] | null>(null);
  const [batchDetail, setBatchDetail] = useState<Batch | null>(null);
  const batch = batchDetail && batchDetail.id === receive.batchId ? batchDetail : batches.data?.find(b => b.id === receive.batchId) || null;

  async function loadMissing() {
    const detail = await api<Batch & { parcels: { trackingId: string; recipient: string; destination: string; merchantOrderRef?: string; received: boolean; cancelled: boolean }[] }>(`/ops/booking-batches/${receive.batchId}`);
    setBatchDetail(detail);
    const list = detail.parcels.filter(p => !p.received && !p.cancelled);
    setMissing(list);
    return list;
  }

  function scan(code: string, source: ScanSource) {
    if (!ops.require("dispatch", "receive parcels")) return;
    const hub = ops.hubById(receive.hubId);
    if (!hub) {
      receive.feedback = { tone: "bad", text: "Choose the hub you are receiving at." };
      return redraw();
    }
    const entry: ReceiveEntry = { code, outcome: "PENDING", message: `Receiving at ${hub.name}…`, at: new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) };
    receive.log.unshift(entry);
    redraw();
    const batchId = receive.batchId || undefined;
    receive.queue = receive.queue.then(async () => {
      try {
        const r = await api<{ ok: boolean; outcome: string; message: string; code: string; parcel?: ReceiveEntry["parcel"]; batch?: Batch }>("/ops/hub-receive", { method: "POST", body: { code, hubId: hub.id, source, batchId, decision: receive.decision } });
        Object.assign(entry, { outcome: r.outcome, message: r.message, parcel: r.parcel, code: r.parcel?.trackingId || r.code });
        if (r.outcome === "RECEIVED") receive.received++;
        if (r.batch && r.batch.id === receive.batchId) {
          setBatchDetail(r.batch);
          if (r.parcel && r.outcome === "RECEIVED") setMissing(m => m && m.filter(p => p.trackingId !== r.parcel!.trackingId));
        }
        receive.feedback = { tone: (OUTCOME[r.outcome] || OUTCOME.REFUSED).tone, text: r.message };
        box.current?.feedback(r.ok, r.message);
      } catch (error) {
        Object.assign(entry, { outcome: "ERROR", message: describe(error) });
        receive.feedback = { tone: "bad", text: describe(error) };
        box.current?.feedback(false, describe(error));
      }
      redraw();
    });
  }

  async function find() {
    const input = document.getElementById("rdCode") as HTMLInputElement | null;
    const raw = input?.value.trim() || "";
    if (!raw) {
      receive.feedback = { tone: "warn", text: "Scan or type a tracking ID, CN or phone number, then choose Find." };
      return redraw();
    }
    void api("/scans", { method: "POST", body: { code: raw, kind: "HUB_LOOKUP", hubId: receive.hubId || undefined, source: "KEYBOARD", ok: true } }).catch(() => undefined);
    try {
      const found = await findParcels(raw);
      if (!found.length) {
        receive.feedback = { tone: "bad", text: `No parcel found for ${raw}.` };
        return redraw();
      }
      const p = found[0];
      receive.feedback = { tone: "info", text: `${p.trackingId} · ${p.statusLabel} · ${p.currentHub?.name || "not at a hub"} · ${p.recipient?.name || "recipient not set"}, ${p.delivery?.zone || "—"}` };
      redraw();
      actions.openParcel(p.trackingId, found.length > 1 ? found.map(f => f.trackingId) : undefined);
    } catch (e) {
      receive.feedback = { tone: "bad", text: describe(e) };
      redraw();
    }
  }

  const toneColor = { good: "var(--good)", bad: "var(--bad)", warn: "var(--warn)", info: "var(--info)" }[receive.feedback.tone as "good"];
  return (
    <div className="grid-2" style={{ alignItems: "start" }}>
      <Panel
        title="Receive at hub"
        subtitle={`Every arrival, wherever it comes from: drop-offs (at the hub they were booked for), picked-up parcels, transfers and parcels back from riders (failed deliveries, unfinished returns). "Find" shows a parcel without receiving it.`}
        tools={<span className="pill good">{`${receive.received} received`}</span>}
      >
        <div className="panel-body stack">
          <label className="field">
            <span>Hub</span>
            <Select
              className="select"
              value={receive.hubId}
              onChange={e => {
                receive.hubId = e.target.value;
                receive.batchId = "";
                setMissing(null);
                try {
                  localStorage.setItem(DESK_HUB_KEY, receive.hubId);
                } catch {
                  /* blocked */
                }
                redraw();
              }}
            >
              {hubs.map(h => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="field">
            <span>Import batch</span>
            <Select className="select" value={receive.batchId} onChange={e => ((receive.batchId = e.target.value), setMissing(null), setBatchDetail(null), redraw())}>
              <option value="">Any parcel (no import)</option>
              {(batches.data || []).map(b => (
                <option key={b.id} value={b.id}>
                  {`${b.number} · ${b.received}/${b.expected} received${b.fileName ? ` · ${b.fileName}` : ""}`}
                </option>
              ))}
            </Select>
          </label>
          <label className="field">
            <span>Back from a rider (failed delivery)</span>
            <Select className="select" value={receive.decision} onChange={e => ((receive.decision = e.target.value), redraw())}>
              <option value="RIDER">As the rider chose (deliver again / return)</option>
              <option value="REATTEMPT">Deliver again</option>
              <option value="RETURN">Return to the sender</option>
            </Select>
          </label>
          <ScanInput ref={box} id="rdCode" label="Tracking ID / CN" placeholder="Scan or type, then Enter" cameraTitle="Scan parcels into the hub" onScan={scan}>
            <Button onClick={find} title="Show the parcel's details without receiving it">
              Find
            </Button>
          </ScanInput>
          <p role="status" aria-live="polite" style={{ margin: 0, fontWeight: receive.feedback.tone ? 600 : 400, color: toneColor || "var(--muted)" }}>
            {receive.feedback.text}
          </p>
          {receive.batchId && batch ? (
            <div className="stack" style={{ gap: 8 }}>
              <div className="row">
                <span className="pill neutral">{`Expected ${batch.expected}`}</span>
                <span className="pill good">{`Received ${batch.received}`}</span>
                <span className="pill warn">{`Missing ${batch.missing}`}</span>
                {batch.cancelled ? <span className="pill neutral">{`${batch.cancelled} cancelled`}</span> : null}
              </div>
              <div className="row">
                <Button size="sm" onClick={() => loadMissing()}>
                  {missing ? "Refresh missing" : "Show missing"}
                </Button>
                {batch.missing ? (
                  <Button size="sm" icon="print" onClick={async () => printLabels((missing || (await loadMissing())).map(p => p.trackingId))}>
                    Print missing labels
                  </Button>
                ) : null}
              </div>
              {missing ? (
                missing.length ? (
                  <div className="table-wrap" style={{ maxHeight: 220 }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Missing parcel</th>
                          <th>Recipient</th>
                          <th>Order</th>
                        </tr>
                      </thead>
                      <tbody>
                        {missing.map(p => (
                          <tr key={p.trackingId}>
                            <td className="tracking">{p.trackingId}</td>
                            <td>
                              {p.recipient}
                              <span className="sub">{p.destination}</span>
                            </td>
                            <td>{p.merchantOrderRef || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="muted">Every parcel of this import has been received.</p>
                )
              ) : null}
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              Choose an import batch to see which of its parcels are still missing.
            </p>
          )}
        </div>
      </Panel>
      <Panel title="Scanned this session" subtitle={`${receive.log.length} scan${receive.log.length === 1 ? "" : "s"} · ${receive.received} received`}>
        <div className="table-wrap" style={{ maxHeight: 560 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Code</th>
                <th>Result</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {receive.log.length ? (
                receive.log.slice(0, 100).map((e, i) => (
                  <tr key={i} data-rd-outcome={e.outcome}>
                    <td className="nowrap">{e.at}</td>
                    <td className="tracking">{e.code}</td>
                    <td>
                      <Pill tone={(OUTCOME[e.outcome] || OUTCOME.REFUSED).tone}>{(OUTCOME[e.outcome] || { label: e.outcome }).label}</Pill>
                    </td>
                    <td>
                      {e.message}
                      {e.parcel ? <span className="sub">{[e.parcel.merchant, e.parcel.recipient, e.parcel.destination].filter(Boolean).join(" · ") + (e.parcel.inBatch === false ? " · not in this import" : "")}</span> : null}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4}>
                    <Empty>Scanned parcels appear here, newest first.</Empty>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

// ───────────── Hub collection ─────────────

interface Waiting {
  trackingId: string;
  recipient?: { name?: string; phone?: string };
  codAmount?: number;
  collect?: { dueAt?: string };
}
const collect = { hubId: "" };

function CollectCounter() {
  const ops = useOps();
  const location = useLocation();
  const handoff = location.state as Handoff | null;
  const hubs = ops.myHubs || ops.hubs.filter(h => h.active !== false);
  const [hubId, setHubId] = useState(() => (handoff?.action === "handover" && handoff.hubId) || collect.hubId || hubs[0]?.id || "");
  useEffect(() => {
    if (!hubId && hubs[0]) setHubId(hubs[0].id);
    collect.hubId = hubId;
  }, [hubId, hubs]);
  const [handing, setHanding] = useState<string | null>(handoff?.action === "handover" ? handoff.code ?? null : null);
  const [message, setMessage] = useState("");
  const box = useRef<ScanInputHandle>(null);
  const items = useQuery({ queryKey: ["collections", hubId], queryFn: async () => (await api<{ items: Waiting[] }>(`/ops/collections?hubId=${encodeURIComponent(hubId)}`)).items, enabled: !!hubId });
  const relations = useQuery({ queryKey: ["receiver-relations"], queryFn: async () => (await api<{ relations: string[] }>("/delivery/receiver-relations")).relations, staleTime: 10 * 60_000 });
  useLive(["parcel.updated"], () => !handing && void items.refetch(), { debounceMs: 800 });
  const taka = (n?: number) => `৳${Number(n || 0).toLocaleString("en-BD")}`;
  const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short" }) : "—");

  function findWaiting(raw: string) {
    const code = normalizeScan(raw);
    void api("/scans", { method: "POST", body: { code, kind: "HUB_LOOKUP", hubId: hubId || undefined, source: "KEYBOARD", ok: true } }).catch(() => undefined);
    const hit = items.data?.find(p => p.trackingId.toUpperCase() === code);
    if (!hit) {
      setMessage(`${code} isn't waiting for collection at this hub.`);
      return box.current?.feedback(false);
    }
    setHanding(hit.trackingId);
    setMessage(`${hit.trackingId} · ${hit.recipient?.name || "receiver"}: check the collection code, then confirm the hand-over.`);
    box.current?.feedback(true);
  }

  return (
    <Panel
      title="Hub collection"
      subtitle="Parcels waiting for their receivers. Hand them over against the collection code; cash on delivery goes into this hub's cash."
      tools={
        <>
          <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
            Hub
            <Select className="select sm" value={hubId} onChange={e => (setHubId(e.target.value), setHanding(null))}>
              {hubs.map(h => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </Select>
          </label>
          <span className="pill">{`${num(items.data?.length ?? 0)} waiting`}</span>
        </>
      }
    >
      <div className="panel-body stack" style={{ paddingBottom: 0 }}>
        <ScanInput ref={box} id="collectScan" label="Find a waiting parcel" placeholder="Scan the label or type the tracking ID, then Enter" big={false} cameraTitle="Scan the parcel label" onScan={findWaiting} />
        {message ? (
          <p className="muted" role="status" style={{ margin: 0 }}>
            {message}
          </p>
        ) : null}
      </div>
      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Tracking ID</th>
              <th>Receiver</th>
              <th>COD</th>
              <th>Collect by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.isLoading ? (
              <tr>
                <td colSpan={5} className="empty">
                  Loading…
                </td>
              </tr>
            ) : items.isError ? (
              <tr>
                <td colSpan={5} className="empty">
                  {describe(items.error)}
                </td>
              </tr>
            ) : !items.data?.length ? (
              <tr>
                <td colSpan={5} className="empty">
                  No parcels are waiting for collection at this hub.
                </td>
              </tr>
            ) : (
              items.data.map(p => {
                const overdue = p.collect?.dueAt && new Date(p.collect.dueAt) < new Date(Date.now() + 86_400_000);
                return (
                  <CollectRow
                    key={p.trackingId}
                    p={p}
                    overdue={!!overdue}
                    due={day(p.collect?.dueAt)}
                    cod={p.codAmount ? taka(p.codAmount) : "Prepaid"}
                    open={handing === p.trackingId}
                    relations={relations.data || ["Self"]}
                    onOpen={() => (setHanding(p.trackingId), setMessage(""))}
                    onClose={() => setHanding(null)}
                    onDone={() => (setHanding(null), setMessage(`${p.trackingId} handed over.`), void items.refetch())}
                    onMessage={setMessage}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function CollectRow({ p, overdue, due, cod, open, relations, onOpen, onClose, onDone, onMessage }: { p: Waiting; overdue: boolean; due: string; cod: string; open: boolean; relations: string[]; onOpen: () => void; onClose: () => void; onDone: () => void; onMessage: (m: string) => void }) {
  const [code, setCode] = useState("");
  const [by, setBy] = useState(p.recipient?.name || "");
  const [relation, setRelation] = useState("Self");
  const [cash, setCash] = useState(String(p.codAmount || 0));
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim() && !file) return onMessage("Enter the collection code, or take a photo of the receiver's ID.");
    setBusy(true);
    try {
      const image = file ? await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = rej;
        r.readAsDataURL(file);
      }) : null;
      await api(`/parcels/${encodeURIComponent(p.trackingId)}/collect`, {
        method: "POST",
        body: { receivedBy: by.trim(), receiverRelation: relation || "Self", codCollected: Number(cash) || 0, ...(code.trim() ? { code: code.trim() } : { proof: { method: "PHOTO", image } }) },
      });
      toast(`${p.trackingId} handed over.`, "good");
      onDone();
    } catch (err) {
      onMessage(describe(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <tr>
        <td className="tracking">{p.trackingId}</td>
        <td>
          {p.recipient?.name || "—"}
          <span className="sub">{localPhone(p.recipient?.phone)}</span>
        </td>
        <td>{cod}</td>
        <td style={overdue ? { color: "var(--bad)", fontWeight: 600 } : undefined}>{due}</td>
        <td>
          <div className="row-actions">
            <Button size="sm" variant="primary" onClick={onOpen}>
              Hand over
            </Button>
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await api(`/parcels/${encodeURIComponent(p.trackingId)}/collection-code`, { method: "POST" });
                  onMessage(`A new collection code was sent to the receiver of ${p.trackingId}.`);
                } catch (err) {
                  onMessage(describe(err));
                }
              }}
            >
              Resend code
            </Button>
          </div>
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={5} style={{ background: "var(--surface-2)" }}>
            <form onSubmit={submit} className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
              <label className="field">
                <span>Collection code</span>
                <input className="input" inputMode="numeric" maxLength={8} placeholder="6-digit code from the receiver" value={code} onChange={e => setCode(e.target.value)} autoFocus />
              </label>
              <label className="field">
                <span>Collected by</span>
                <input className="input" maxLength={120} required value={by} onChange={e => setBy(e.target.value)} />
              </label>
              <label className="field">
                <span>Relation to the recipient</span>
                <Select className="select" value={relation} onChange={e => setRelation(e.target.value)}>
                  {relations.map(r => (
                    <option key={r} value={r}>
                      {r === "Self" ? "Self (the recipient)" : r}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="field">
                <span>Cash received (৳)</span>
                <input className="input" type="number" min={0} value={cash} onChange={e => setCash(e.target.value)} />
              </label>
              <label className="field">
                <span>No code? Photo of the receiver's ID</span>
                <input className="input" type="file" accept="image/*" capture="environment" onChange={e => setFile(e.target.files?.[0] ?? null)} />
              </label>
              <div className="row" style={{ alignSelf: "end" }}>
                <button className="button primary" type="submit" aria-busy={busy || undefined} disabled={busy}>
                  Confirm hand-over
                </button>
                <button className="button" type="button" onClick={onClose}>
                  Cancel
                </button>
              </div>
            </form>
          </td>
        </tr>
      ) : null}
    </>
  );
}
