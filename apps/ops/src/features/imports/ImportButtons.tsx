/**
 * The page buttons that open the importer (bridge-imports.js, bridge-bulk.js, bridge-linehaul.js bulk transfer):
 * Import Excel / Import history on New orders and All parcels, "Bulk update <page> by Excel" and its history on every
 * journey page (only when this person can use that page's actions: GET /bulk-updates/kinds), and the Transfers
 * apply options (seal the bags, load them on a planned or new trip).
 */
import { Select } from "@panel/ui/Select";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { bdPhoneProblem, normalizeBdPhone } from "@delivery-fast/shared/dist/phone.js";
import { api } from "@panel/lib/api";
import { useOps } from "@/lib/ops";
import { Button } from "@panel/ui/kit";
import { toast } from "@panel/ui/toast";
import { printLabels, PDF_LIMITS, refreshParcels } from "@/features/parcels/actions";
import { openDocument } from "@/features/parcels/actions";
import { num } from "@panel/lib/format";
import { openBulk, openBulkHistory, openImport, openImportHistory, type BulkFilters, type ImportConfig, type MerchantRef, type TransferResult } from "@panel/ui/Importer";
import { useNavigate } from "react-router";
import { pathFor } from "@/app/nav";
import { pinImport, pinName, unpinImport, useImportPin, PIN_HOURS } from "./importPin";

const PAGE_OF: Record<string, string> = { new_orders: "New orders", pickup: "Pickup", hub_desk: "Hub desk", delivery: "Delivery", problems: "Problems", returns: "Returns", transfers: "Transfers", all: "All parcels" };
export const bulkLabel = (kind: string) => `Bulk update ${PAGE_OF[kind] || "All parcels"} by Excel`;

function useMerchants() {
  return useQuery({ queryKey: ["ops", "merchants"], queryFn: () => api<(MerchantRef & { status?: string; pickupHub?: { id: string } | null })[]>("/ops/merchants"), staleTime: 5 * 60_000 });
}
/** The bulk templates this person can use. */
export function useBulkKinds() {
  const ops = useOps();
  return useQuery({ queryKey: ["bulk-updates", "kinds"], queryFn: async () => (await api<{ kind: string }[]>("/bulk-updates/kinds")).map(k => k.kind), enabled: ops.can("dispatch"), staleTime: 10 * 60_000, retry: false });
}

/** Courier Operations import config (kind of the page; All parcels offers all three). */
export function useImportConfig(kind: "customer" | "ecommerce" | "document", kinds?: string[]) {
  const ops = useOps();
  const merchants = useMerchants();
  const navigate = useNavigate();
  return async (): Promise<ImportConfig> => {
    const list = merchants.data ?? (await api<(MerchantRef & { status?: string; pickupHub?: { id: string } | null })[]>("/ops/merchants").catch(() => []));
    return {
      kind,
      kinds,
      forOps: true,
      merchants: list.filter(m => !m.status || m.status === "ACTIVE").map(m => ({ id: m.id, code: m.code, name: m.name, type: m.type, hubId: m.pickupHub?.id ?? null })),
      hubs: ops.myHubs || ops.hubs,
      hubId: ops.myHubs?.[0]?.id,
      printLabels: ids => {
        if (ids.length > PDF_LIMITS.labels) toast(`Labels for the first ${num(PDF_LIMITS.labels)} of ${num(ids.length)} parcels; print the rest from the shipment list.`);
        void printLabels(ids.slice(0, PDF_LIMITS.labels));
      },
      onDone: () => refreshParcels(),
      // Pin: New orders shows only this import's parcels (this browser, 6 hours).
      onPin: job => {
        pinImport({ batchId: job.batch.id, batch: job.batch.number, number: job.number });
        toast(`New orders shows only ${pinName({ number: job.number, batch: job.batch.number })} on this device for ${PIN_HOURS} hours, or until you unpin it.`, "good");
        navigate(pathFor("New orders"));
      },
    };
  };
}

/** New orders: the pinned import's Unpin button (with its number). */
export function UnpinButton() {
  const pin = useImportPin();
  if (!pin) return null;
  const left = Math.max(1, Math.round((pin.pinnedAt + PIN_HOURS * 3600_000 - Date.now()) / 60_000));
  return (
    <Button icon="pin" variant="primary" title={`Pinned on this device; ends by itself in ${left >= 60 ? `${Math.floor(left / 60)} h ${left % 60} min` : `${left} min`}`} onClick={() => (unpinImport(), toast("Unpinned: New orders shows every new order again."))}>
      {`Unpin ${pinName(pin)}`}
    </Button>
  );
}

export function ImportButtons({ kind, kinds }: { kind: "customer" | "ecommerce" | "document"; kinds?: string[] }) {
  const ops = useOps();
  const config = useImportConfig(kind, kinds);
  if (!ops.can("dispatch")) return null;
  return (
    <>
      <Button icon="upload" onClick={async () => void openImport(await config())}>
        Import Excel
      </Button>
      <Button icon="history" onClick={async () => void openImportHistory(await config())}>Import history</Button>
      <UnpinButton />
    </>
  );
}

/** "Bulk update <page> by Excel" (and its history), with the page's filters as the starting point. */
export function BulkUpdateButton({ kind, label, history, filters, line, presetFilters }: { kind: string; label?: string; history?: boolean; filters?: BulkFilters; line?: string; presetFilters?: BulkFilters }) {
  const ops = useOps();
  const kinds = useBulkKinds();
  const merchants = useMerchants();
  const qc = useQueryClient();
  if (!ops.can("dispatch")) return null;
  if (kind !== "all" && kind !== "transfers" && kinds.data && !kinds.data.includes(kind)) return null;
  const open = async () => {
    if (!ops.require("dispatch", "update parcels in bulk")) return;
    const list = merchants.data ?? (await api<MerchantRef[]>("/ops/merchants").catch(() => []));
    const cfg: ImportConfig = {
      bulkKind: kind,
      filters: { ...(presetFilters || {}), ...(filters || {}) },
      line,
      merchants: (line === "customer" ? [] : list.filter(m => !line || (m.type === "BANKING_FINANCIAL") === (line === "document"))).map(m => ({ id: m.id, code: m.code, name: m.name, type: m.type })),
      hubs: ops.myHubs || ops.hubs,
      onDone: () => (refreshParcels(), void qc.invalidateQueries({ queryKey: ["linehaul"] })),
    };
    if (kind === "transfers") Object.assign(cfg, await transferConfig(ops));
    if (history) await openBulkHistory(cfg);
    else await openBulk(cfg);
  };
  return (
    <Button icon={history ? "history" : kind === "transfers" ? "box" : "sheet"} onClick={open} title={history ? undefined : "Choose one of this page's actions, download its Excel file, fill it in, upload and apply"}>
      {label ?? (history ? "Bulk update history" : bulkLabel(kind))}
    </Button>
  );
}

// ───────────── Transfers: seal the bags, load them on a trip ─────────────

const topt = { seal: true, trip: "", vehicle: "", regNo: "", driver: "", phone: "", trips: [] as { id: string; number: string; vehicleRegNo: string; destHub: { name: string } }[], vehicles: [] as { id: string; regNo: string; kind: string }[], error: "" };

async function transferConfig(ops: ReturnType<typeof useOps>): Promise<Partial<ImportConfig>> {
  const canAct = (hubId: string) => ops.can("dispatch") && (!ops.me?.hubIds || ops.me.hubIds.includes(hubId));
  const [trips, vehicles] = await Promise.all([
    api<{ items: (typeof topt.trips[number] & { originHub: { id: string } })[] }>("/linehaul/trips?status=PLANNED&direction=outbound&limit=100")
      .then(p => p.items.filter(t => canAct(t.originHub.id)))
      .catch(() => []),
    api<{ items: { id: string; regNo: string; kind: string; active: boolean }[] }>("/linehaul/vehicles?limit=200")
      .then(p => p.items.filter(v => v.active))
      .catch(() => []),
  ]);
  Object.assign(topt, { trips, vehicles, trip: trips.some(t => t.id === topt.trip) || topt.trip === "new" ? topt.trip : "", error: "" });
  if (!topt.vehicle && vehicles[0]) topt.vehicle = vehicles[0].id;
  return {
    bulkKind: "transfers",
    bulkAction: "transfer",
    applyExtra: {
      render: () => <TransferOptions />,
      body: () => {
        if (topt.trip === "new") {
          if (!topt.vehicle && topt.regNo.trim().length < 3) return fail("Choose the vehicle or type its registration number.");
          if (topt.driver.trim().length < 2) return fail("Enter the driver's name.");
          const problem = bdPhoneProblem(topt.phone);
          if (problem) return fail(`Driver phone: ${problem}`);
        }
        topt.error = "";
        const transfer: Record<string, unknown> = { seal: topt.seal || !!topt.trip };
        if (topt.trip === "new") transfer.newTrip = { vehicleId: topt.vehicle || undefined, vehicleRegNo: topt.vehicle ? undefined : topt.regNo.trim(), driverName: topt.driver.trim(), driverPhone: normalizeBdPhone(topt.phone) };
        else if (topt.trip) transfer.tripId = topt.trip;
        return { transfer };
      },
    },
    resultExtra: job => <TransferResultView result={job.transfer?.result} />,
  };
}
function fail(message: string): false {
  topt.error = message;
  toast(message, "bad");
  window.dispatchEvent(new Event("ops:transfer-options"));
  return false;
}

function TransferOptions() {
  const [, force] = useState(0);
  const redraw = () => force(n => n + 1);
  useEffect(() => {
    window.addEventListener("ops:transfer-options", redraw);
    return () => window.removeEventListener("ops:transfer-options", redraw);
  }, []);
  const set = (patch: Partial<typeof topt>) => (Object.assign(topt, patch), redraw());
  const isNew = topt.trip === "new";
  return (
    <form onSubmit={e => e.preventDefault()} className="stack" style={{ marginTop: 14, padding: "12px 14px", border: "1px solid var(--line)", borderRadius: 10 }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>After the parcels are in their bags</h3>
      <label className="check">
        <input type="checkbox" checked={topt.seal || !!topt.trip} disabled={!!topt.trip} onChange={e => set({ seal: e.target.checked })} /> Seal the bags (seal number = the bag number on its printed tag)
      </label>
      <label className="field">
        <span>Load on a trip</span>
        <Select className="select" value={topt.trip} onChange={e => set({ trip: e.target.value })}>
          <option value="">Don't load yet (load later from the manifest)</option>
          {topt.trips.map(t => (
            <option key={t.id} value={t.id}>{`${t.number} → ${t.destHub?.name || "—"} · ${t.vehicleRegNo}`}</option>
          ))}
          <option value="new">New trip per destination…</option>
        </Select>
      </label>
      {isNew ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
          <label className="field">
            <span>Vehicle</span>
            <Select className="select" value={topt.vehicle} onChange={e => set({ vehicle: e.target.value })}>
              {topt.vehicles.map(v => (
                <option key={v.id} value={v.id}>{`${v.regNo} · ${v.kind}`}</option>
              ))}
              <option value="">Other (type the registration)</option>
            </Select>
          </label>
          <label className="field">
            <span>Registration number</span>
            <input className="input" maxLength={40} disabled={!!topt.vehicle} placeholder="DHAKA METRO-TA 11-2345" defaultValue={topt.regNo} onChange={e => (topt.regNo = e.target.value)} />
          </label>
          <label className="field">
            <span>Driver name</span>
            <input className="input" maxLength={120} defaultValue={topt.driver} onChange={e => (topt.driver = e.target.value)} />
          </label>
          <label className="field">
            <span>Driver phone</span>
            <div className="phone-input">
              <span>+880</span>
              <input className="input" inputMode="tel" defaultValue={topt.phone} onChange={e => (topt.phone = e.target.value)} />
            </div>
          </label>
        </div>
      ) : null}
      <p className="muted" style={{ margin: 0 }}>
        Parcels stay "At hub" in their bags; they become "In transit" when the trip departs (Transfers → manifest → Depart). Bags on a trip are sealed first.
      </p>
      {topt.error ? (
        <p role="alert" className="form-error" style={{ margin: 0 }}>
          {topt.error}
        </p>
      ) : null}
    </form>
  );
}

const BAG_STATUS: Record<string, string> = { OPEN: "Open", SEALED: "Sealed", IN_TRANSIT: "In transit", RECEIVED: "Received" };
function TransferResultView({ result }: { result?: TransferResult }) {
  if (!result) return null;
  return (
    <section className="stack" style={{ margin: "0 0 12px" }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>Bags{result.trips.length ? " and trips" : ""}</h3>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Bag</th>
              <th>Route</th>
              <th className="num">Parcels</th>
              <th>Status</th>
              <th>Trip</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {result.bags.length ? (
              result.bags.map(b => (
                <tr key={b.number}>
                  <td>
                    <span className="strong">{b.number}</span>
                    {b.label ? <span className="sub">{b.label}</span> : null}
                  </td>
                  <td>{`${b.originHub} → ${b.destHub}`}</td>
                  <td className="num">{b.parcels}</td>
                  <td>{BAG_STATUS[b.status] || b.status}</td>
                  <td>{b.trip || "—"}</td>
                  <td>
                    <Button size="sm" icon="print" onClick={() => openDocument(`/documents/bag-label/${encodeURIComponent(b.number)}`, { title: "Preparing the bag tag…" })}>
                      Print tag
                    </Button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="empty">
                  No bags.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {result.trips.length ? (
        <div className="row">
          {result.trips.map(t => (
            <Button key={t.number} size="sm" icon="print" onClick={() => openDocument(`/documents/manifest/${encodeURIComponent(t.number)}`, { title: "Preparing the manifest…" })}>
              {`Manifest ${t.number} → ${t.destHub} (${t.bags} bag${t.bags === 1 ? "" : "s"})`}
            </Button>
          ))}
        </div>
      ) : null}
      {result.problems.length ? (
        <div role="alert" style={{ color: "var(--warn)", fontSize: 13 }}>
          {result.problems.map((p, i) => (
            <div key={i}>{p}</div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
