/**
 * Transfers (Linehaul, bridge-linehaul.js + bridge-section-tabs.js + bridge-vehicles.js):
 *   Send        bag parcels (new / open bag, scan in, remove, seal, reopen, bag tag), plan trips, load bags on the
 *               manifest, depart / arrive / close / cancel, print the manifest; trips and bags lists; bulk by Excel
 *   Receive     scan at the destination hub (bag label = whole bag, parcel = one by one, manifest = the trip to check),
 *               finish a bag (the rest recorded missing), inbound trips with expected / received / missing
 *   On the road vehicles sharing their location (map + list), "I'm travelling in this vehicle", parcels in transit
 *   Issues      missing / extra parcels, seal mismatches; resolve
 *   Vehicles    the linehaul fleet (hub managers add and edit)
 */
import { Select } from "@panel/ui/Select";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { useLive } from "@panel/lib/events";
import { ago, localPhone, money, num, when } from "@panel/lib/format";
import { useOps } from "@/lib/ops";
import { Button, Metric, PageHeading, Panel, Pill, useDebounced } from "@panel/ui/kit";
import { confirm, openForm } from "@panel/ui/dialogs";
import { toast } from "@panel/ui/toast";
import ViewTabs from "@/app/ViewTabs";
import { pathFor } from "@/app/nav";
import NetworkMap from "@/features/maps/NetworkMap";
import { openDocument } from "@/features/parcels/actions";
import type { Handoff } from "@/features/parcels/useParcelActions";
import { ScanInput, type ScanInputHandle, type ScanSource } from "@/features/scan/scanner";
import { share, useVehicleShare, vehicleShare } from "@/features/linehaul/vehicleShare";
import { StageTable } from "./ParcelPages";
import { BulkUpdateButton } from "@/features/imports/ImportButtons";

const BAG_STATUS: Record<string, string> = { OPEN: "Open", SEALED: "Sealed", IN_TRANSIT: "In transit", RECEIVED: "Received" };
const TRIP_STATUS: Record<string, string> = { PLANNED: "Planned", DEPARTED: "In transit", ARRIVED: "Arrived", CLOSED: "Closed", CANCELLED: "Cancelled" };
const ITEM_STATE: Record<string, string> = { LOADED: "Loaded", RECEIVED: "Received", MISSING: "Missing" };
const DISCREPANCY: Record<string, string> = { MISSING: "Missing parcel", EXTRA: "Extra parcel", SEAL_MISMATCH: "Seal mismatch", DAMAGED: "Damaged" };
const tone = (t?: string): "bad" | "info" | "good" | "warn" | "neutral" | undefined =>
  !t ? undefined : ["Missing", "Missing parcel", "Seal mismatch", "Extra parcel", "Damaged"].includes(t) ? "bad" : t === "Received" || t === "Closed" ? "good" : t === "Open" || t === "Planned" ? "neutral" : t === "Cancelled" ? "bad" : "info";

type HubRef = { id: string; name: string };
interface BagItem {
  state: string;
  parcel: { trackingId: string; recipient: string; zone: string; weightKg: number; codAmount: number };
}
interface Bag {
  id: string;
  number: string;
  status: string;
  sealNo?: string | null;
  originHub: HubRef;
  destHub: HubRef;
  parcels: number;
  trip?: { id: string; number: string; status?: string } | null;
  totals: { parcels: number; weightKg: number; codAmount: number; received: number; missing: number; loaded: number };
  items: BagItem[];
}
interface Trip {
  id: string;
  number: string;
  status: string;
  originHub: HubRef;
  destHub: HubRef;
  vehicleRegNo: string;
  driverName: string;
  driverPhone: string;
  createdAt: string;
  departedAt?: string | null;
  arrivedAt?: string | null;
  plannedDepartureAt?: string | null;
  bags: number;
  parcels: number;
  bagsReceived?: number;
  openDiscrepancies?: number;
}
interface TripDetail extends Omit<Trip, "bags"> {
  bags: (Bag & { totals: Bag["totals"] })[];
  totals: { bags: number; parcels: number; weightKg: number; codAmount: number; openDiscrepancies: number };
  discrepancies: unknown[];
}
interface InboundTrip {
  id: string;
  number: string;
  status: string;
  originHub: HubRef;
  destHub: HubRef;
  vehicleRegNo: string;
  driverName: string;
  departedAt?: string | null;
  plannedDepartureAt?: string | null;
  arrivedAt?: string | null;
  bags: { number: string; label?: string; received: number; expected: number; missing: number; status: string }[];
  totals: { bags: number; bagsReceived: number; expected: number; received: number; missing: number; pending: number; openDiscrepancies: number };
}
interface Issue {
  id: string;
  kind: string;
  trackingId?: string | null;
  bag?: { number: string } | null;
  trip?: { number: string } | null;
  hub?: HubRef | null;
  hubId: string;
  note?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
  resolution?: string | null;
}
interface Vehicle {
  id: string;
  regNo: string;
  kind: string;
  capacityKg?: number | null;
  ownerName?: string | null;
  active: boolean;
}

const route = (x: { originHub?: HubRef; destHub?: HubRef }) => `${x.originHub?.name || "—"} → ${x.destHub?.name || "—"}`;

export default function Transfers({ tab }: { tab: string }) {
  const ops = useOps();
  const qc = useQueryClient();
  useLive(["linehaul.updated"], () => void qc.invalidateQueries({ queryKey: ["linehaul"] }));
  const canDispatch = ops.can("dispatch");
  const navigate = useNavigate();
  useEffect(() => {
    const go = () => navigate(pathFor("Transfers", "Receive"));
    window.addEventListener("ops:go-receive", go);
    return () => window.removeEventListener("ops:go-receive", go);
  }, [navigate]);
  return (
    <>
      <PageHeading
        eyebrow="Hub operations · between hubs"
        title="Transfers"
        subtitle="Bag parcels, load trucks against a manifest, dispatch them and receive bags at the destination hub."
        actions={
          canDispatch && tab === "Send" ? (
            <>
              <BulkUpdateButton kind="transfers" label="Bulk transfer by Excel" />
              <BulkUpdateButton kind="transfers" label="Transfer history" history />
              <Button icon="route" onClick={() => tripDialog(ops, qc)}>
                Plan trip
              </Button>
              <Button variant="primary" icon="plus" onClick={() => newBagDialog(ops, qc)}>
                New bag
              </Button>
            </>
          ) : null
        }
      />
      <ViewTabs view="Transfers" tab={tab} />
      <Metrics />
      {tab === "Send" ? <SendTab /> : tab === "Receive" ? <ReceiveTab /> : tab === "On the road" ? <RoadTab /> : tab === "Issues" ? <IssuesList /> : <VehiclesList />}
    </>
  );
}

function Metrics() {
  const ops = useOps();
  const count = async (path: string) => {
    const page = await api<{ items: unknown[]; nextCursor: string | null }>(`${path}&limit=200`).catch(() => null);
    return page ? `${page.items.length}${page.nextCursor ? "+" : ""}` : "—";
  };
  const m = useQuery({
    queryKey: ["linehaul", "metrics"],
    queryFn: async () => {
      const [openBags, outbound, inbound, issues] = await Promise.all([
        count("/linehaul/bags?status=OPEN&direction=outbound"),
        count("/linehaul/trips?status=DEPARTED&direction=outbound"),
        count("/linehaul/trips?status=DEPARTED&direction=inbound"),
        count("/linehaul/discrepancies?open=true"),
      ]);
      return { openBags, outbound, inbound, issues };
    },
  });
  const v = (k: keyof NonNullable<typeof m.data>) => m.data?.[k] ?? "…";
  return (
    <div className="metrics">
      <Metric label="Open bags" value={v("openBags")} icon="box" foot="being made up" note={ops.me?.hubIds ? "at your hub" : "network wide"} />
      <Metric label="Trucks out" value={v("outbound")} icon="truck" foot="departed" note="outbound" />
      <Metric label="Arriving" value={v("inbound")} icon="route" foot="in transit to you" note="inbound" />
      <Metric label="Open discrepancies" value={v("issues")} icon="alert" foot="missing, extra, seals" note="to resolve" />
    </div>
  );
}

const refreshLinehaul = (qc: ReturnType<typeof useQueryClient>) => void qc.invalidateQueries({ queryKey: ["linehaul"] });

// ───────────── Send ─────────────

const sendKept = { bagId: null as string | null, tripId: null as string | null };

function SendTab() {
  const location = useLocation();
  const handoff = location.state as Handoff | null;
  const [bagId, setBagId] = useState<string | null>(sendKept.bagId);
  const [tripId, setTripId] = useState<string | null>(sendKept.tripId);
  useEffect(() => void Object.assign(sendKept, { bagId, tripId }), [bagId, tripId]);
  useEffect(() => {
    const open = (e: Event) => setBagId((e as CustomEvent<string>).detail);
    const trip = (e: Event) => setTripId((e as CustomEvent<string>).detail);
    window.addEventListener("ops:open-bag", open);
    window.addEventListener("ops:open-trip", trip);
    return () => (window.removeEventListener("ops:open-bag", open), window.removeEventListener("ops:open-trip", trip));
  }, []);
  return (
    <>
      <div className="panel panel-body" style={{ marginBottom: 16 }}>
        <h2 className="panel-title">How to send parcels to another hub</h2>
        <p className="panel-subtitle">One bag per destination hub. Single parcels can also go from Scan desk → Transfer out.</p>
        <ol className="grid-3" style={{ listStyle: "none", padding: 0, margin: "12px 0 0", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
          {[
            ["Bag the parcels", "New bag (or open one), choose the destination hub, scan the parcels into it."],
            ["Seal the bag", "Seal bag, type the seal number and print the bag label."],
            ["Plan a trip, load bags", "Plan trip (to the same hub) → Manifest → scan each sealed bag's label."],
            ["Depart", "When the truck leaves: Depart. Every parcel goes in transit; the other hub receives the bags."],
          ].map(([title, text], i) => (
            <li key={title} className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
              <b className="avatar" style={{ width: 26, height: 26, fontSize: 12 }}>
                {i + 1}
              </b>
              <div>
                <strong style={{ color: "var(--ink)" }}>{title}</strong>
                <small className="muted" style={{ display: "block" }}>
                  {text}
                </small>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <BagPanel bagId={bagId} setBagId={setBagId} handoffCode={handoff?.action === "transfer" ? handoff.code : undefined} />
      {tripId ? <TripPanel tripId={tripId} close={() => setTripId(null)} /> : null}
      <TripsList openTrip={setTripId} />
      <BagsList openBag={setBagId} />
    </>
  );
}

function BagPanel({ bagId, setBagId, handoffCode }: { bagId: string | null; setBagId: (id: string | null) => void; handoffCode?: string }) {
  const ops = useOps();
  const qc = useQueryClient();
  const box = useRef<ScanInputHandle>(null);
  const [last, setLast] = useState("");
  const q = useQuery({ queryKey: ["linehaul", "bag", bagId], queryFn: () => api<Bag>(`/linehaul/bags/${encodeURIComponent(bagId!)}`), enabled: !!bagId });
  const b = q.data;
  useEffect(() => {
    if (handoffCode && b) {
      const input = document.getElementById("lhScanParcel") as HTMLInputElement | null;
      if (input) input.value = handoffCode;
    }
  }, [handoffCode, b]);
  const canAct = (hubId: string) => ops.can("dispatch") && (!ops.me?.hubIds || ops.me.hubIds.includes(hubId));
  if (!b)
    return (
      <Panel title="Bag up parcels" subtitle="Open a bag by its number (or create one), then scan the parcels going into it.">
        <div className="panel-body">
          <ScanInput
            id="lhOpenBag"
            big={false}
            autoFocus={false}
            label="Bag number"
            placeholder="BG-261016-0001"
            cameraTitle="Scan the bag label"
            onScan={code => setBagId(code)}
          >
            <Button variant="primary" onClick={() => {
              const value = (document.getElementById("lhOpenBag") as HTMLInputElement | null)?.value.trim().toUpperCase();
              if (value) setBagId(value);
            }}>
              Open bag
            </Button>
            {ops.can("dispatch") ? <Button onClick={() => newBagDialog(ops, qc, setBagId)}>New bag</Button> : null}
          </ScanInput>
          {handoffCode ? <p className="callout" style={{ marginTop: 12 }}>{`Open a bag to the delivery hub (or create one), then scan ${handoffCode} into it.`}</p> : null}
          {q.isError ? <p className="form-error">{describe(q.error)}</p> : null}
        </div>
      </Panel>
    );
  const editable = b.status === "OPEN" && canAct(b.originHub.id);
  async function scanIn(code: string, source: ScanSource) {
    try {
      const r = await api<{ bag: Bag; added: boolean }>(`/linehaul/bags/${b!.id}/items`, { method: "POST", body: { code, source } });
      qc.setQueryData(["linehaul", "bag", bagId], r.bag);
      setLast(r.added ? `${code} added · ${r.bag.totals.parcels} parcel(s) in the bag` : `${code} is already in this bag`);
      box.current?.feedback(r.added);
    } catch (e) {
      setLast(describe(e));
      box.current?.feedback(false, describe(e));
    }
  }
  return (
    <Panel
      title={`Bag ${b.number}`}
      subtitle={`${route(b)} · ${b.totals.parcels} parcel(s) · ${b.totals.weightKg} kg · COD ${money(b.totals.codAmount)}${b.sealNo ? ` · seal ${b.sealNo}` : ""}${b.trip ? ` · on ${b.trip.number}` : ""}`}
      tools={<Pill tone={tone(BAG_STATUS[b.status])}>{BAG_STATUS[b.status]}</Pill>}
    >
      <div className="panel-body stack">
        {editable ? (
          <>
            <ScanInput ref={box} id="lhScanParcel" label="Scan parcel into the bag" placeholder="Scan or type the tracking ID" cameraTitle={`Scan parcels into ${b.number}`} onScan={scanIn} />
            <p className="muted" aria-live="polite" style={{ margin: 0 }}>
              {last || "Each scan is checked: the parcel must be at this hub and not in another bag."}
            </p>
          </>
        ) : null}
        <div className="row">
          {editable ? (
            <Button variant="primary" onClick={() => sealDialog(b, qc)}>
              Seal bag
            </Button>
          ) : null}
          {b.status === "SEALED" && canAct(b.originHub.id) && (!b.trip || b.trip.status === "PLANNED") ? (
            <Button
              onClick={async () => {
                if (!(await confirm({ title: `Reopen ${b.number}?`, message: "The seal is broken and recorded; the bag must be sealed again before it travels.", ok: "Break seal and reopen", danger: true }))) return;
                qc.setQueryData(["linehaul", "bag", bagId], await api<Bag>(`/linehaul/bags/${b.id}/reopen`, { method: "POST" }));
                refreshLinehaul(qc);
                toast(`${b.number} reopened.`);
              }}
            >
              Reopen
            </Button>
          ) : null}
          <Button icon="print" onClick={() => openDocument(`/documents/bag-label/${b.id}`, { title: "Preparing the bag tag…" })}>
            Print bag label
          </Button>
          <Button onClick={() => setBagId(null)}>Close</Button>
        </div>
      </div>
      <div className="table-wrap" style={{ maxHeight: 320 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Parcel</th>
              <th className="num">Weight</th>
              <th className="num">COD</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {b.items.length ? (
              b.items.map(i => (
                <tr key={i.parcel.trackingId}>
                  <td>
                    <span className="strong">{i.parcel.trackingId}</span>
                    <span className="sub">{`${i.parcel.recipient} · ${i.parcel.zone}`}</span>
                  </td>
                  <td className="num">{i.parcel.weightKg} kg</td>
                  <td className="num">{money(i.parcel.codAmount)}</td>
                  <td>
                    <Pill tone={tone(ITEM_STATE[i.state])}>{ITEM_STATE[i.state]}</Pill>
                  </td>
                  <td className="num">
                    {editable ? (
                      <Button
                        size="sm"
                        onClick={async () => {
                          qc.setQueryData(["linehaul", "bag", bagId], await api<Bag>(`/linehaul/bags/${b.id}/items/${encodeURIComponent(i.parcel.trackingId)}`, { method: "DELETE" }));
                          setLast(`${i.parcel.trackingId} removed`);
                        }}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="empty">
                  No parcels in this bag yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function TripPanel({ tripId, close }: { tripId: string; close: () => void }) {
  const ops = useOps();
  const qc = useQueryClient();
  const box = useRef<ScanInputHandle>(null);
  const q = useQuery({ queryKey: ["linehaul", "trip", tripId], queryFn: () => api<TripDetail>(`/linehaul/trips/${encodeURIComponent(tripId)}`) });
  const t = q.data;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }), [tripId]);
  if (!t) return <Panel title="Manifest">{q.isError ? <p className="panel-body form-error">{describe(q.error)}</p> : <p className="panel-body muted">Loading…</p>}</Panel>;
  const canAct = (hubId: string) => ops.can("dispatch") && (!ops.me?.hubIds || ops.me.hubIds.includes(hubId));
  const loading = t.status === "PLANNED" && canAct(t.originHub.id);
  async function load(code: string, source: ScanSource) {
    try {
      qc.setQueryData(["linehaul", "trip", tripId], await api<TripDetail>(`/linehaul/trips/${t!.id}/bags`, { method: "POST", body: { bag: code, source } }));
      toast(`${code} loaded on ${t!.number}.`, "good");
      refreshLinehaul(qc);
      box.current?.feedback(true);
    } catch (e) {
      toast(describe(e), "bad");
      box.current?.feedback(false);
    }
  }
  return (
    <section ref={ref} className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        <div>
          <h2 className="panel-title">Manifest {t.number}</h2>
          <p className="panel-subtitle">{`${route(t)} · ${t.vehicleRegNo} · ${t.driverName} (${localPhone(t.driverPhone)}) · ${t.totals.bags} bags · ${t.totals.parcels} parcels · ${t.totals.weightKg} kg · COD ${money(t.totals.codAmount)}`}</p>
        </div>
        <Pill tone={tone(TRIP_STATUS[t.status])}>{TRIP_STATUS[t.status]}</Pill>
      </div>
      <div className="panel-body stack">
        {loading ? <ScanInput ref={box} id="lhLoadBag" big={false} label="Load a sealed bag (scan its label)" placeholder="BG-261016-0001" cameraTitle={`Load bags on ${t.number}`} onScan={load} /> : null}
        <div className="row">
          <TripActions t={t} canAct={canAct} />
          <Button icon="print" onClick={() => openDocument(`/documents/manifest/${t.id}`, { title: "Preparing the manifest…" })}>
            Print manifest
          </Button>
          <Button onClick={close}>Close</Button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Bag</th>
              <th className="num">Parcels</th>
              <th className="num">Weight</th>
              <th className="num">COD</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {t.bags.length ? (
              t.bags.map(b => (
                <tr key={b.id}>
                  <td>
                    <span className="strong">{b.number}</span>
                    <span className="sub">Seal {b.sealNo || "—"}</span>
                  </td>
                  <td className="num">{b.totals.parcels}</td>
                  <td className="num">{b.totals.weightKg} kg</td>
                  <td className="num">{money(b.totals.codAmount)}</td>
                  <td>
                    <Pill tone={tone(BAG_STATUS[b.status])}>{BAG_STATUS[b.status]}</Pill>
                    {b.totals.missing ? <span className="sub">{b.totals.missing} missing</span> : null}
                  </td>
                  <td className="num">
                    {loading ? (
                      <Button size="sm" onClick={async () => (qc.setQueryData(["linehaul", "trip", tripId], await api<TripDetail>(`/linehaul/trips/${t.id}/bags/${b.id}`, { method: "DELETE" })), refreshLinehaul(qc))}>
                        Unload
                      </Button>
                    ) : b.status === "IN_TRANSIT" && canAct(t.destHub.id) ? (
                      <Button size="sm" onClick={() => startReceive(b.number)}>
                        Receive
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="empty">
                  No bags loaded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {t.discrepancies.length ? <div className="panel-foot">{t.totals.openDiscrepancies} open discrepancy(ies) on this trip.</div> : null}
    </section>
  );
}

function TripActions({ t, canAct }: { t: { id: string; status: string; originHub: HubRef; destHub: HubRef }; canAct: (hubId: string) => boolean }) {
  const qc = useQueryClient();
  const ops = useOps();
  const act = async (action: "depart" | "arrive" | "close" | "cancel", question?: { title: string; message: string; ok: string; cancel?: string; danger?: boolean }) => {
    if (question && !(await confirm(question))) return;
    const trip = await api<{ number: string }>(`/linehaul/trips/${t.id}/${action}`, { method: "POST" });
    toast(`${trip.number} ${{ depart: "departed: parcels are in transit", arrive: "marked arrived", close: "closed", cancel: "cancelled" }[action]}.`, "good");
    refreshLinehaul(qc);
    if (action === "depart") ops.refreshAll();
  };
  return (
    <>
      {t.status === "PLANNED" && canAct(t.originHub.id) ? (
        <Button size="sm" variant="primary" onClick={() => act("depart", { title: "Dispatch this truck?", message: "Every parcel on the manifest goes in transit to the destination hub.", ok: "Dispatch truck" })}>
          Depart
        </Button>
      ) : null}
      {t.status === "DEPARTED" && canAct(t.destHub.id) ? (
        <Button size="sm" onClick={() => act("arrive")}>
          Arrived
        </Button>
      ) : null}
      {t.status === "ARRIVED" && canAct(t.destHub.id) ? (
        <Button size="sm" onClick={() => act("close", { title: "Close this trip?", message: "Parcels in bags that weren't received are recorded as missing.", ok: "Close trip", danger: true })}>
          Close
        </Button>
      ) : null}
      {t.status === "PLANNED" && canAct(t.originHub.id) ? (
        <Button size="sm" onClick={() => act("cancel", { title: "Cancel this planned trip?", message: "Its bags stay sealed and can go on another trip.", ok: "Cancel trip", cancel: "Keep it", danger: true })}>
          Cancel trip
        </Button>
      ) : null}
    </>
  );
}

/** Cursor-paged lists of trips, bags and issues (Load more). */
function useCursorList<T>(kind: string, path: string, params: Record<string, string>) {
  const [pages, setPages] = useState(1);
  const key = JSON.stringify(params);
  useEffect(() => setPages(1), [key]);
  const q = useQuery({
    queryKey: ["linehaul", kind, key, pages],
    queryFn: async () => {
      let cursor: string | null = null;
      const items: T[] = [];
      for (let i = 0; i < pages; i++) {
        const p = new URLSearchParams({ limit: "25", ...Object.fromEntries(Object.entries(params).filter(([, v]) => v)) });
        if (cursor) p.set("cursor", cursor);
        const page: { items: T[]; nextCursor: string | null } = await api(`${path}?${p}`);
        items.push(...page.items);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      return { items, next: cursor };
    },
    placeholderData: prev => prev,
  });
  return { ...q, more: () => setPages(n => n + 1) };
}

function ListFilters({ kind, statuses, value, onChange }: { kind: string; statuses: Record<string, string>; value: { q: string; direction: string; status: string }; onChange: (v: { q: string; direction: string; status: string }) => void }) {
  const [q, setQ] = useState(value.q);
  const d = useDebounced(q, 350);
  useEffect(() => {
    if (d !== value.q) onChange({ ...value, q: d });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);
  return (
    <>
      <input className="input sm" type="search" placeholder={kind === "bags" ? "Bag, seal or tracking ID" : "Manifest, vehicle, driver or bag"} aria-label={`Search ${kind}`} value={q} onChange={e => setQ(e.target.value)} style={{ width: 210 }} />
      <Select className="select sm" aria-label="Direction" value={value.direction} onChange={e => onChange({ ...value, direction: e.target.value })}>
        <option value="">Both directions</option>
        <option value="outbound">Outbound</option>
        <option value="inbound">Inbound</option>
      </Select>
      <Select className="select sm" aria-label="Status" value={value.status} onChange={e => onChange({ ...value, status: e.target.value })}>
        <option value="">All statuses</option>
        {Object.entries(statuses).map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </Select>
    </>
  );
}

function TripsList({ openTrip }: { openTrip: (id: string) => void }) {
  const ops = useOps();
  const [f, setF] = useState({ q: "", direction: "", status: "" });
  const list = useCursorList<Trip>("trips", "/linehaul/trips", f);
  const canAct = (hubId: string) => ops.can("dispatch") && (!ops.me?.hubIds || ops.me.hubIds.includes(hubId));
  const items = list.data?.items ?? [];
  return (
    <Panel
      title="Trips & manifests"
      subtitle="Truck runs between hubs · open a manifest to load bags, dispatch, receive or print"
      tools={<ListFilters kind="trips" statuses={TRIP_STATUS} value={f} onChange={setF} />}
      footer={
        <>
          <span>{`Showing ${items.length} trip(s)`}</span>
          {list.data?.next ? (
            <Button size="sm" onClick={list.more}>
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
              <th>Manifest</th>
              <th>Route</th>
              <th>Vehicle / driver</th>
              <th>Load</th>
              <th>Departure</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.length ? (
              items.map(t => (
                <tr key={t.id}>
                  <td>
                    <span className="strong">{t.number}</span>
                    <span className="sub">{new Date(t.createdAt).toLocaleDateString("en-GB")}</span>
                  </td>
                  <td>{route(t)}</td>
                  <td>
                    {t.vehicleRegNo}
                    <span className="sub">{`${t.driverName} · ${localPhone(t.driverPhone)}`}</span>
                  </td>
                  <td>
                    {`${t.bags} bags · ${t.parcels} parcels`}
                    {t.bagsReceived ? <span className="sub">{t.bagsReceived} received</span> : null}
                  </td>
                  <td>{t.departedAt ? `Left ${when(t.departedAt)}` : t.plannedDepartureAt ? `Planned ${when(t.plannedDepartureAt)}` : "—"}</td>
                  <td>
                    <Pill tone={tone(TRIP_STATUS[t.status])}>{TRIP_STATUS[t.status]}</Pill>
                    {t.openDiscrepancies ? <span className="sub">{t.openDiscrepancies} open issue(s)</span> : null}
                  </td>
                  <td>
                    <div className="row-actions">
                      <Button size="sm" onClick={() => openTrip(t.id)}>
                        Manifest
                      </Button>
                      <TripActions t={t} canAct={canAct} />
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7} className="empty">
                  {list.isError ? describe(list.error) : list.isLoading ? "Loading trips…" : "No trips match."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function BagsList({ openBag }: { openBag: (id: string) => void }) {
  const ops = useOps();
  const [f, setF] = useState({ q: "", direction: "", status: "" });
  const list = useCursorList<Bag>("bags", "/linehaul/bags", f);
  const canAct = (hubId: string) => ops.can("dispatch") && (!ops.me?.hubIds || ops.me.hubIds.includes(hubId));
  const items = list.data?.items ?? [];
  return (
    <Panel
      title="Bags"
      subtitle="Sealed bags of parcels moving between hubs"
      tools={<ListFilters kind="bags" statuses={BAG_STATUS} value={f} onChange={setF} />}
      footer={
        <>
          <span>{`Showing ${items.length} bag(s)`}</span>
          {list.data?.next ? (
            <Button size="sm" onClick={list.more}>
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
              <th>Bag</th>
              <th>Route</th>
              <th className="num">Parcels</th>
              <th>Trip</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.length ? (
              items.map(b => (
                <tr key={b.id}>
                  <td>
                    <span className="strong">{b.number}</span>
                    <span className="sub">{b.sealNo ? `Seal ${b.sealNo}` : "Not sealed"}</span>
                  </td>
                  <td>{route(b)}</td>
                  <td className="num">{b.parcels}</td>
                  <td>{b.trip?.number || "—"}</td>
                  <td>
                    <Pill tone={tone(BAG_STATUS[b.status])}>{BAG_STATUS[b.status]}</Pill>
                  </td>
                  <td>
                    <div className="row-actions">
                      <Button size="sm" onClick={() => (openBag(b.id), window.scrollTo({ top: 0, behavior: "smooth" }))}>
                        Open
                      </Button>
                      {b.status === "IN_TRANSIT" && canAct(b.destHub.id) ? (
                        <Button size="sm" onClick={() => startReceive(b.number)}>
                          Receive
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="empty">
                  {list.isError ? describe(list.error) : list.isLoading ? "Loading bags…" : "No bags match."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ───────────── dialogs ─────────────

function hubPairFields(origins: { id: string; name: string }[], all: { id: string; name: string }[], idFrom: string, idTo: string) {
  return [
    { id: idFrom, label: "From hub", type: "select" as const, required: true, value: origins[0]?.id || "", options: origins.map(h => ({ value: h.id, label: h.name })) },
    { id: idTo, label: "To hub", type: "select" as const, required: true, options: all.map(h => ({ value: h.id, label: h.name })) },
  ];
}

function newBagDialog(ops: ReturnType<typeof useOps>, qc: ReturnType<typeof useQueryClient>, open?: (id: string) => void) {
  if (!ops.require("dispatch", "make up bags")) return;
  const origins = ops.myHubs || ops.hubs;
  void openForm({
    title: "New linehaul bag",
    description: "A bag carries parcels from one hub to another. Scan parcels into it, then seal it.",
    submit: "Create bag",
    fields: hubPairFields(origins, ops.hubs, "origin", "dest"),
    validate: { dest: (v, all) => (v && v === all.origin ? "Choose another hub than the one it leaves from" : "") },
    onSubmit: async v => {
      const bag = await api<Bag>("/linehaul/bags", { method: "POST", body: { originHubId: v.origin, destHubId: v.dest } });
      if (open) open(bag.id);
      else window.dispatchEvent(new CustomEvent("ops:open-bag", { detail: bag.id }));
      refreshLinehaul(qc);
      return `${bag.number} created. Scan parcels into it.`;
    },
  });
}

function sealDialog(b: Bag, qc: ReturnType<typeof useQueryClient>) {
  if (!b.items.length) return toast("Scan at least one parcel into the bag before sealing it.");
  void openForm({
    title: `Seal ${b.number}`,
    description: `${b.totals.parcels} parcel(s) · ${b.totals.weightKg} kg. Enter the number printed on the seal; the receiving hub checks it on arrival.`,
    submit: "Seal bag",
    fields: [{ id: "sealNo", label: "Seal number", required: true, maxLength: 40, placeholder: "e.g. S-104233", full: true }],
    validate: { sealNo: v => (v.length < 2 ? "Enter the seal number" : "") },
    onSubmit: async v => {
      const bag = await api<Bag>(`/linehaul/bags/${b.id}/seal`, { method: "POST", body: { sealNo: v.sealNo } });
      qc.setQueryData(["linehaul", "bag", b.id], bag);
      refreshLinehaul(qc);
      return `${bag.number} sealed. Load it on a trip from the manifest.`;
    },
  });
}

async function tripDialog(ops: ReturnType<typeof useOps>, qc: ReturnType<typeof useQueryClient>) {
  if (!ops.require("dispatch", "plan trips")) return;
  const vehicles = (await api<{ items: Vehicle[] }>("/linehaul/vehicles?limit=200").catch(() => ({ items: [] as Vehicle[] }))).items.filter(v => v.active);
  const origins = ops.myHubs || ops.hubs;
  const inHour = new Date(Date.now() + 3600_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await openForm({
    title: "Plan a linehaul trip",
    description: "The trip's manifest lists the sealed bags loaded on the truck. Departure moves every parcel in transit.",
    submit: "Create trip",
    wide: true,
    fields: [
      ...hubPairFields(origins, ops.hubs, "origin", "dest"),
      { id: "vehicleId", label: "Vehicle", type: "select", value: vehicles[0]?.id || "", options: vehicles.map(v => ({ value: v.id, label: `${v.regNo} · ${v.kind}` })), hint: "Choose “— Choose —” to type another registration." },
      { id: "regNo", label: "Registration number", maxLength: 40, placeholder: "DHAKA METRO-TA 11-2345", show: v => !v.vehicleId },
      { id: "driver", label: "Driver name", required: true, maxLength: 120 },
      { id: "phone", label: "Driver phone", type: "phone", required: true },
      { id: "planned", label: "Planned departure", type: "datetime-local", value: inHour },
      { id: "note", label: "Note", maxLength: 500 },
    ],
    validate: {
      dest: (v, all) => (v && v === all.origin ? "Choose another hub than the one it leaves from" : ""),
      driver: v => (v.length < 2 ? "Enter the driver's name" : ""),
      regNo: (v, all) => (!all.vehicleId && v.length < 3 ? "Enter the vehicle's registration number" : ""),
    },
    onSubmit: async v => {
      const trip = await api<{ id: string; number: string }>("/linehaul/trips", {
        method: "POST",
        body: {
          originHubId: v.origin,
          destHubId: v.dest,
          vehicleId: v.vehicleId || undefined,
          vehicleRegNo: v.vehicleId ? undefined : v.regNo,
          driverName: v.driver,
          driverPhone: v.phone,
          plannedDepartureAt: v.planned ? new Date(v.planned).toISOString() : undefined,
          note: v.note || undefined,
        },
      });
      window.dispatchEvent(new CustomEvent("ops:open-trip", { detail: trip.id }));
      refreshLinehaul(qc);
      return `${trip.number} planned. Scan sealed bags to load them.`;
    },
  });
}

// ───────────── Receive ─────────────

const RECV_OUTCOME: Record<string, string> = {
  RECEIVED: "Received",
  BAG_RECEIVED: "Bag received",
  ALREADY_RECEIVED: "Already received",
  TRIP: "Checking trip",
  EXTRA: "Extra parcel",
  WRONG_HUB: "Wrong hub",
  NOT_FOUND: "Not found",
  NOT_IN_TRANSIT: "Not departed",
  REFUSED: "Refused",
};
const recv = { hubId: "", trip: null as InboundTrip | null, bag: null as Bag | null, log: [] as { code: string; outcome: string; message: string }[], seal: "", last: null as { outcome: string; message: string } | null, listeners: new Set<() => void>() };
const recvChanged = () => recv.listeners.forEach(l => l());

/** "Receive" from a bag row or a manifest: the bag opens on the Receive tab. */
async function startReceive(number: string) {
  try {
    const bag = await api<Bag>(`/linehaul/bags/${encodeURIComponent(number)}`);
    Object.assign(recv, { bag, hubId: bag.destHub.id, trip: null, last: { outcome: "TRIP", message: `Opening ${bag.number}: scan its parcels one by one, or scan the bag label to receive it whole.` } });
    recvChanged();
    window.dispatchEvent(new CustomEvent("ops:go-receive"));
  } catch (e) {
    toast(describe(e), "bad");
  }
}

function ReceiveTab() {
  const ops = useOps();
  const qc = useQueryClient();
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force(n => n + 1);
    recv.listeners.add(l);
    return () => void recv.listeners.delete(l);
  }, []);
  const box = useRef<ScanInputHandle>(null);
  const hubs = ops.myHubs || ops.hubs;
  if (!recv.hubId || !hubs.some(h => h.id === recv.hubId)) recv.hubId = hubs[0]?.id || "";
  const [inboundHub, setInboundHub] = useState("");
  const inbound = useQuery({
    queryKey: ["linehaul", "inbound", inboundHub],
    queryFn: () => api<{ items: InboundTrip[]; totals: { trips: number; onTheRoad: number; expected: number; received: number; missing: number } }>(`/linehaul/inbound${!ops.myHubs && inboundHub ? `?hubId=${inboundHub}` : ""}`),
  });
  useEffect(() => {
    if (recv.trip && inbound.data) {
      const fresh = inbound.data.items.find(t => t.id === recv.trip!.id);
      if (fresh && fresh !== recv.trip) {
        recv.trip = fresh;
        recvChanged();
      }
    }
  }, [inbound.data]);
  const canScan = ops.can("dispatch") && !!recv.hubId;
  const canAct = (hubId: string) => ops.can("dispatch") && (!ops.me?.hubIds || ops.me.hubIds.includes(hubId));

  async function scan(code: string, source: ScanSource) {
    const sealInput = document.getElementById("lhRecvSeal") as HTMLInputElement | null;
    recv.seal = sealInput?.value.trim() || "";
    try {
      const res = await api<{ ok: boolean; outcome: string; message: string; code: string; trip?: InboundTrip; bag?: Bag }>("/linehaul/receive-scan", {
        method: "POST",
        body: { hubId: recv.hubId, code, source, tripId: recv.trip?.id, bagId: recv.bag?.id, sealNo: /^BG-/i.test(code) && recv.seal ? recv.seal : undefined },
      });
      if (res.trip) recv.trip = res.trip;
      if (res.bag) recv.bag = res.bag;
      if (/^BG-/i.test(code) && res.ok) {
        recv.seal = "";
        if (sealInput) sealInput.value = "";
      }
      recv.last = res;
      recv.log.unshift({ code: res.code, outcome: res.outcome, message: res.message });
      box.current?.feedback(res.ok, res.message);
      if (["RECEIVED", "BAG_RECEIVED", "EXTRA"].includes(res.outcome)) refreshLinehaul(qc);
    } catch (e) {
      recv.last = { outcome: "REFUSED", message: describe(e) };
      recv.log.unshift({ code: code.toUpperCase(), outcome: "REFUSED", message: describe(e) });
      box.current?.feedback(false, describe(e));
    }
    recvChanged();
  }

  async function finishBag() {
    const b = recv.bag;
    if (!b) return;
    const left = b.items.filter(i => i.state === "LOADED").length;
    if (!(await confirm({ title: `Finish ${b.number}?`, message: `${left} parcel(s) not scanned out of the bag are recorded as missing (a discrepancy to resolve).`, ok: "Finish and record missing", danger: true }))) return;
    const res = await api<{ bag: Bag; missing: number }>(`/linehaul/bags/${b.id}/receive`, { method: "POST", body: { hubId: b.destHub.id, trackingIds: [], source: "KEYBOARD" } });
    recv.bag = res.bag;
    recv.last = { outcome: "BAG_RECEIVED", message: `${res.bag.number} finished: ${res.missing} missing.` };
    toast(recv.last.message, "good");
    refreshLinehaul(qc);
    recvChanged();
  }

  const t = recv.trip;
  const b = recv.bag;
  const missingLeft = b && b.status === "IN_TRANSIT" ? b.items.filter(i => i.state === "LOADED") : [];
  const lastTone = (o?: string) => (o === "RECEIVED" || o === "BAG_RECEIVED" ? "good" : o === "ALREADY_RECEIVED" || o === "TRIP" ? "info" : "bad");
  const m = inbound.data?.totals;
  return (
    <>
      <div className="callout">
        Receiving a truck: scan each bag's label to receive the whole bag (or open it and scan the parcels one by one). Type the seal number to check it. Missing and extra parcels are recorded on Issues. Single parcels can also be received on Scan desk → Receive entry.
      </div>
      <Panel title="Receive transfers" subtitle={`Scan at ${hubs.find(h => h.id === recv.hubId)?.name || "your hub"}: bags whole, or parcels one by one against the manifest. Missing and extra parcels are recorded.`}>
        <div className="panel-body stack">
          {canScan ? (
            <div className="form-grid" style={{ gridTemplateColumns: hubs.length > 1 ? "minmax(180px, 240px) 1fr minmax(180px, 240px)" : "1fr minmax(180px, 260px)" }}>
              {hubs.length > 1 ? (
                <label className="field">
                  <span>Receiving hub</span>
                  <Select className="select" value={recv.hubId} onChange={e => (Object.assign(recv, { hubId: e.target.value, trip: null, bag: null, last: null }), recvChanged())}>
                    {hubs.map(h => (
                      <option key={h.id} value={h.id}>
                        {h.name}
                      </option>
                    ))}
                  </Select>
                </label>
              ) : null}
              <ScanInput ref={box} id="lhRecvScan" big={false} label="Scan bag, manifest or parcel" placeholder="BG-… · MF-… · tracking ID" cameraTitle="Scan bags or parcels to receive" onScan={scan} />
              <label className="field">
                <span>Seal number on arrival (bags, optional)</span>
                <input id="lhRecvSeal" className="input" autoComplete="off" defaultValue={recv.seal} placeholder="As printed on the seal" />
              </label>
            </div>
          ) : (
            <p className="muted">Only operations staff of the receiving hub can receive transfers.</p>
          )}
          {recv.last ? (
            <p role="status" aria-live="polite" style={{ margin: 0, fontWeight: 600, color: `var(--${lastTone(recv.last.outcome)})` }}>
              {recv.last.message}
            </p>
          ) : null}
          {t ? (
            <div style={{ padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10 }}>
              <div className="row">
                <strong>{t.number}</strong> · {route(t)} <Pill tone={tone(TRIP_STATUS[t.status])}>{TRIP_STATUS[t.status]}</Pill>
              </div>
              <small className="muted">{`Expected ${t.totals.expected} · received ${t.totals.received} · missing ${t.totals.missing} · still expected ${t.totals.pending}`}</small>
              {t.bags.length ? (
                <table className="table" style={{ marginTop: 6 }}>
                  <tbody>
                    {t.bags.map(x => (
                      <tr key={x.number} className={b?.number === x.number ? "selected" : undefined}>
                        <td>
                          <span className="strong">{x.number}</span>
                          {x.label ? <span className="sub">{x.label}</span> : null}
                        </td>
                        <td>{`${x.received} / ${x.expected} received${x.missing ? ` · ${x.missing} missing` : ""}`}</td>
                        <td>
                          <Pill tone={tone(BAG_STATUS[x.status])}>{BAG_STATUS[x.status]}</Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          ) : b ? (
            <div style={{ padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10 }}>
              <div className="row">
                <strong>{b.number}</strong> · {route(b)} <Pill tone={tone(BAG_STATUS[b.status])}>{BAG_STATUS[b.status]}</Pill>
              </div>
              <small className="muted">{`Expected ${b.totals.parcels} · received ${b.totals.received} · missing ${b.totals.missing} · still expected ${b.totals.loaded}`}</small>
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              Scan a manifest (MF-…) to check a trip, a bag label (BG-…) to receive the whole bag, or parcels one by one. Or press Check on an inbound trip below.
            </p>
          )}
          <div className="row">
            {b && missingLeft.length && b.items.some(i => i.state === "RECEIVED") && canAct(b.destHub.id) ? <Button onClick={finishBag}>{`Finish ${b.number}: ${missingLeft.length} not scanned → missing`}</Button> : null}
            {t || b ? <Button onClick={() => (Object.assign(recv, { trip: null, bag: null, last: null }), recvChanged())}>Clear</Button> : null}
          </div>
          {recv.log.length ? (
            <div className="table-wrap" style={{ maxHeight: 300 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Scanned</th>
                    <th>Result</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {recv.log.slice(0, 12).map((x, i) => (
                    <tr key={i} data-outcome={x.outcome}>
                      <td className="strong">{x.code}</td>
                      <td>
                        <Pill tone={lastTone(x.outcome)}>{RECV_OUTCOME[x.outcome] || x.outcome}</Pill>
                      </td>
                      <td>{x.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </Panel>
      <Panel
        title="Inbound transfers"
        subtitle={m ? `${m.trips} trip(s) coming in · ${m.onTheRoad} on the road · ${m.expected} parcels expected, ${m.received} received${m.missing ? `, ${m.missing} missing` : ""}` : "Trips and bags coming to your hub"}
        tools={
          !ops.myHubs ? (
            <Select className="select sm" aria-label="Receiving hub" value={inboundHub} onChange={e => setInboundHub(e.target.value)}>
              <option value="">All hubs</option>
              {ops.hubs.map(h => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </Select>
          ) : null
        }
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Manifest</th>
                <th>Route</th>
                <th>Departure</th>
                <th>Bags received</th>
                <th>Parcels</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {inbound.data?.items.length ? (
                inbound.data.items.map(x => (
                  <tr key={x.id}>
                    <td>
                      <span className="strong">{x.number}</span>
                      <span className="sub">{`${x.vehicleRegNo} · ${x.driverName}`}</span>
                    </td>
                    <td>{route(x)}</td>
                    <td>
                      {x.departedAt ? `Left ${when(x.departedAt)}` : x.plannedDepartureAt ? `Planned ${when(x.plannedDepartureAt)}` : "Planned"}
                      {x.arrivedAt ? <span className="sub">Arrived {when(x.arrivedAt)}</span> : null}
                    </td>
                    <td>
                      {`${x.totals.bagsReceived} / ${x.totals.bags}`}
                      {x.bags.map(bb => (
                        <span key={bb.number} className="sub">{`${bb.number}${bb.label ? ` (${bb.label})` : ""}: ${bb.received}/${bb.expected}${bb.missing ? ` · ${bb.missing} missing` : ""} · ${BAG_STATUS[bb.status]}`}</span>
                      ))}
                    </td>
                    <td>
                      {`${x.totals.expected} expected · ${x.totals.received} received${x.totals.missing ? ` · ${x.totals.missing} missing` : ""}`}
                      {x.totals.pending && x.status !== "PLANNED" ? <span className="sub">{x.totals.pending} still expected</span> : null}
                    </td>
                    <td>
                      <Pill tone={tone(TRIP_STATUS[x.status])}>{TRIP_STATUS[x.status]}</Pill>
                      {x.totals.openDiscrepancies ? <span className="sub">{x.totals.openDiscrepancies} open issue(s)</span> : null}
                    </td>
                    <td>
                      <div className="row-actions">
                        <Button
                          size="sm"
                          onClick={() => {
                            Object.assign(recv, { trip: x, bag: null, hubId: x.destHub.id, last: { outcome: "TRIP", message: `Checking ${x.number}: scan its bags to receive them whole, or the parcels one by one.` } });
                            recvChanged();
                            window.scrollTo({ top: 0, behavior: "smooth" });
                          }}
                        >
                          Check
                        </Button>
                        <Button size="sm" onClick={() => window.dispatchEvent(new CustomEvent("ops:manifest", { detail: x.id }))}>
                          Manifest
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="empty">
                    {inbound.isError ? describe(inbound.error) : inbound.isLoading ? "Loading inbound transfers…" : "No transfers coming in."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
      <ManifestOverlay />
    </>
  );
}

/** A manifest opened from another tab (Receive › Manifest). */
function ManifestOverlay() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    const open = (e: Event) => setId((e as CustomEvent<string>).detail);
    window.addEventListener("ops:manifest", open);
    return () => window.removeEventListener("ops:manifest", open);
  }, []);
  return id ? <TripPanel tripId={id} close={() => setId(null)} /> : null;
}

// ───────────── On the road ─────────────

function RoadTab() {
  const ops = useOps();
  const canSee = ops.can("dispatch") || ops.can("manageHubs");
  const vehicles = useQuery({ queryKey: ["map", "vehicles"], queryFn: async () => (await api<{ items: { tripId: string; number: string; vehicleRegNo: string; route: string; at: string; stale?: boolean; sharing?: boolean; sharedBy?: string }[] }>("/vehicle-locations")).items, enabled: canSee, staleTime: 60_000 });
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      {canSee ? (
        <Panel title="Vehicles on the road" subtitle="Linehaul trucks whose location someone on board shares · parcels on these trips show the vehicle on their map">
          <div style={{ padding: "0 16px 12px" }}>
            <div style={{ borderRadius: 10, overflow: "hidden", border: "1px solid var(--line)" }}>
              <NetworkMap height={260} vehiclesOnly footer={false} />
            </div>
          </div>
          {vehicles.data?.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Vehicle</th>
                    <th>Route</th>
                    <th>Last update</th>
                    <th>Shared by</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {vehicles.data.map(v => (
                    <tr key={v.tripId}>
                      <td>
                        <span className="strong">{v.vehicleRegNo}</span>
                        <span className="sub">{v.number}</span>
                      </td>
                      <td>{v.route}</td>
                      <td>
                        {ago(v.at)}
                        {v.stale ? <span className="sub">{v.sharing ? "no recent update" : "sharing stopped"}</span> : null}
                      </td>
                      <td>{v.sharedBy || "—"}</td>
                      <td>
                        <Pill tone={v.stale ? "warn" : "info"}>{v.stale ? "Pending" : "In transit"}</Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted" style={{ padding: "0 16px 14px", margin: 0 }}>
              No vehicle is sharing its location right now. Someone on board starts it from the rider app ("Travelling with a vehicle") or here.
            </p>
          )}
          {ops.can("dispatch") ? <ShareBar /> : null}
        </Panel>
      ) : null}
      <StageTable id="transfers" stage="transfers" title="Parcels in transit between hubs" subtitle="Transferred out of a hub and not yet received at the next one" empty="No parcels are between hubs right now." />
    </>
  );
}

function ShareBar() {
  const s = useVehicleShare();
  const qc = useQueryClient();
  const [trip, setTrip] = useState("");
  const [code, setCode] = useState("");
  const [, tick] = useState(0);
  useEffect(() => {
    if (!share.loaded) void vehicleShare.load();
    const t = setInterval(() => tick(n => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const trips = useQuery({ queryKey: ["vehicle-shares", "trips"], queryFn: () => vehicleShare.trips(), enabled: !s.share });
  useEffect(() => {
    if (!trip && trips.data?.[0]) setTrip(trips.data[0].id);
  }, [trips.data, trip]);
  if (s.share)
    return (
      <div className="callout good" style={{ margin: "0 16px 14px", justifyContent: "space-between", flexWrap: "wrap" }}>
        <span>{vehicleShare.describe()}</span>
        <span className="row">
          <Button size="sm" onClick={() => vehicleShare.sendNow()}>
            Send now
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={async () => {
              if (!(await confirm({ title: "Stop sharing the vehicle's location?", message: "Operations and merchants will see its last known position until someone shares it again.", ok: "Stop sharing" }))) return;
              await vehicleShare.stop();
              void trips.refetch();
              void qc.invalidateQueries({ queryKey: ["map", "vehicles"] });
            }}
          >
            Stop sharing
          </Button>
        </span>
      </div>
    );
  const start = async () => {
    const chosen = code.trim() ? code.trim().toUpperCase() : trip;
    if (!chosen) return toast("Choose a trip or scan the manifest's MF-… barcode.");
    const started = await vehicleShare.start(chosen);
    toast(`Sharing the location of ${started.trip.vehicleRegNo} (${started.trip.number}) from this device.`, "good");
    void qc.invalidateQueries({ queryKey: ["map", "vehicles"] });
  };
  return (
    <div style={{ margin: "0 16px 14px", display: "grid", gap: 6 }}>
      <div className="row">
        <span className="muted" style={{ fontWeight: 600 }}>
          Travelling with a truck?
        </span>
        {trips.isLoading ? (
          <span className="muted">Loading trips…</span>
        ) : trips.data?.length ? (
          <Select className="select sm" aria-label="Trip to share" value={trip} onChange={e => setTrip(e.target.value)} style={{ maxWidth: 360 }}>
            {trips.data.map(t => (
              <option key={t.id} value={t.id}>
                {`${t.number} · ${t.vehicleRegNo} · ${t.route} · ${t.status === "DEPARTED" ? "on the road" : "planned"}${t.sharing ? ` · shared by ${t.sharing.name}` : ""}`}
              </option>
            ))}
          </Select>
        ) : (
          <span className="muted">No planned or departed trips through your hub.</span>
        )}
        <input className="input sm" placeholder="or scan MF-…" aria-label="Manifest number" value={code} onChange={e => setCode(e.target.value)} style={{ width: 170 }} />
        <Button size="sm" variant="primary" onClick={start}>
          Start sharing vehicle location
        </Button>
      </div>
      <small className="faint">This browser sends its position while this page stays open (phones: screen on, this tab in front).</small>
    </div>
  );
}

// ───────────── Issues, Vehicles ─────────────

function IssuesList() {
  const ops = useOps();
  const qc = useQueryClient();
  const [open, setOpen] = useState("true");
  const list = useCursorList<Issue>("issues", "/linehaul/discrepancies", { open });
  const items = list.data?.items ?? [];
  const canAct = (hubId: string) => ops.can("dispatch") && (!ops.me?.hubIds || ops.me.hubIds.includes(hubId));
  return (
    <Panel
      title="Discrepancies"
      subtitle="Missing and extra parcels, seal mismatches · recorded when bags are received or trips closed"
      tools={
        <Select className="select sm" aria-label="Discrepancy filter" value={open} onChange={e => setOpen(e.target.value)}>
          <option value="true">Open</option>
          <option value="false">Resolved</option>
          <option value="">All</option>
        </Select>
      }
      footer={
        <>
          <span>{`Showing ${items.length} discrepancy(ies)`}</span>
          {list.data?.next ? (
            <Button size="sm" onClick={list.more}>
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
              <th>Issue</th>
              <th>Tracking ID</th>
              <th>Bag / trip</th>
              <th>Hub</th>
              <th>Note</th>
              <th>Found</th>
              <th>Resolution</th>
            </tr>
          </thead>
          <tbody>
            {items.length ? (
              items.map(d => (
                <tr key={d.id}>
                  <td>
                    <Pill tone="bad">{DISCREPANCY[d.kind] || d.kind}</Pill>
                  </td>
                  <td>{d.trackingId || "—"}</td>
                  <td>
                    {d.bag?.number || "—"}
                    <span className="sub">{d.trip?.number || ""}</span>
                  </td>
                  <td>{d.hub?.name || "—"}</td>
                  <td>{d.note || ""}</td>
                  <td className="nowrap">{when(d.createdAt)}</td>
                  <td>
                    {d.resolvedAt ? (
                      <>
                        {d.resolution}
                        <span className="sub">{when(d.resolvedAt)}</span>
                      </>
                    ) : canAct(d.hubId) ? (
                      <Button
                        size="sm"
                        onClick={() =>
                          openForm({
                            title: `Resolve · ${DISCREPANCY[d.kind] || d.kind}`,
                            description: `${d.trackingId || d.bag?.number || ""} · ${d.note || ""}`,
                            submit: "Resolve",
                            fields: [{ id: "resolution", label: "What was done", type: "textarea", required: true, maxLength: 500, placeholder: "e.g. Found on the next truck and received" }],
                            validate: { resolution: v => (v.length < 2 ? "Describe the resolution" : "") },
                            onSubmit: async v => {
                              await api(`/linehaul/discrepancies/${d.id}/resolve`, { method: "POST", body: { resolution: v.resolution } });
                              refreshLinehaul(qc);
                              return "Discrepancy resolved.";
                            },
                          })
                        }
                      >
                        Resolve
                      </Button>
                    ) : (
                      "Open"
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7} className="empty">
                  {list.isError ? describe(list.error) : list.isLoading ? "Loading…" : "No discrepancies."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function VehiclesList() {
  const ops = useOps();
  const qc = useQueryClient();
  const manage = ops.can("manageHubs");
  const q = useQuery({ queryKey: ["linehaul", "vehicles"], queryFn: async () => (await api<{ items: Vehicle[] }>("/linehaul/vehicles?limit=200")).items, enabled: manage || ops.can("dispatch") });
  const edit = (v?: Vehicle) => {
    if (!ops.require("manageHubs", "manage vehicles")) return;
    void openForm({
      title: v ? `Edit vehicle · ${v.regNo}` : "Add vehicle",
      submit: v ? "Save vehicle" : "Add vehicle",
      fields: [
        { id: "regNo", label: "Registration number", required: true, maxLength: 40, value: v?.regNo },
        { id: "kind", label: "Type", required: true, maxLength: 40, value: v?.kind, placeholder: "Covered van, Truck, Pickup" },
        { id: "capacityKg", label: "Capacity (kg)", type: "number", min: 1, step: 1, value: v?.capacityKg ?? "" },
        { id: "ownerName", label: "Owner / vendor", maxLength: 120, value: v?.ownerName || "" },
        { id: "active", label: "Status", type: "select", required: true, value: String(v?.active ?? true), options: [{ value: "true", label: "Active" }, { value: "false", label: "Inactive" }] },
      ],
      validate: { regNo: x => (x.length < 3 ? "Enter the registration number" : ""), kind: x => (x.length < 2 ? "Enter the vehicle type" : "") },
      onSubmit: async x => {
        const body = { regNo: x.regNo, kind: x.kind, capacityKg: x.capacityKg ? Number(x.capacityKg) : v ? null : undefined, ownerName: x.ownerName || (v ? null : undefined), active: x.active === "true" };
        await api(v ? `/linehaul/vehicles/${v.id}` : "/linehaul/vehicles", { method: v ? "PATCH" : "POST", body });
        refreshLinehaul(qc);
        return `${body.regNo} ${v ? "saved" : "added"}.`;
      },
    });
  };
  return (
    <Panel
      title="Vehicles"
      subtitle="Trucks and vans used for linehaul"
      tools={
        manage ? (
          <Button size="sm" icon="plus" onClick={() => edit()}>
            Add vehicle
          </Button>
        ) : null
      }
    >
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Registration</th>
              <th>Type</th>
              <th className="num">Capacity</th>
              <th>Owner / vendor</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data?.length ? (
              q.data.map(v => (
                <tr key={v.id}>
                  <td className="strong">{v.regNo}</td>
                  <td>{v.kind}</td>
                  <td className="num">{v.capacityKg ? `${num(v.capacityKg)} kg` : "—"}</td>
                  <td>{v.ownerName || "—"}</td>
                  <td>
                    <Pill tone={v.active ? "good" : "neutral"}>{v.active ? "Active" : "Inactive"}</Pill>
                  </td>
                  <td className="num">
                    {manage ? (
                      <Button size="sm" onClick={() => edit(v)}>
                        Edit
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="empty">
                  {q.isLoading ? "Loading…" : "No vehicles registered yet. Trips can still use a typed registration number."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

