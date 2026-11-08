/**
 * CN stock (bridge-cn.js): consignment-number labels.
 *   Allocate a batch       POST /cn/batches (up to 1000 CNs)
 *   Batches / stock        GET /cn/batches (search, hub, cursor), /cn/batches/:id, /cn/summary
 *   Issue to hub/merchant  PATCH /cn/batches/:id
 *   Print labels           GET/POST /documents/cn-sheet/:id → PDF (A4, 3 × 8, Code 128)
 *   Void lost labels       POST /cn/stock/void
 *   Check a label          GET /cn/stock/:cn (camera or USB scanner)
 */
import { Select } from "@/ui/Select";
import { useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@/lib/api";
import { useLive } from "@/lib/events";
import { date, num, when } from "@/lib/format";
import { useOps } from "@/lib/ops";
import { Button, Metric, PageHeading, Panel, Pill, useDebounced } from "@/ui/kit";
import { openForm } from "@/ui/dialogs";
import { toast } from "@/ui/toast";
import { openDocument } from "@/features/parcels/actions";
import { ScanInput, type ScanInputHandle } from "@/features/scan/scanner";

const STATUS: Record<string, string> = { AVAILABLE: "Available", USED: "Used", VOID: "Void" };
interface Stock {
  available: number;
  used: number;
  void: number;
}
interface Batch {
  id: string;
  number: string;
  count: number;
  createdAt: string;
  note: string | null;
  hub: { id: string; name: string } | null;
  merchant: { id: string; name: string } | null;
  stock: Stock;
}
interface BatchDetail extends Batch {
  items: { cn: string; status: string; parcel: { trackingId: string; recipientName: string } | null; voidReason: string | null; printCount: number; lastPrintAt: string | null }[];
}
interface Check {
  cn: string;
  status: string;
  batch: { number: string; hub: { name: string } | null; merchant: { name: string } | null };
  parcel: { trackingId: string; status: string } | null;
  voidReason: string | null;
}
type Summary = Record<"available" | "printedUnused" | "used" | "void" | "batches" | "total", number>;

export default function CnStock() {
  const ops = useOps();
  const qc = useQueryClient();
  const can = ops.can("dispatch");
  const hubs = (ops.myHubs ?? ops.hubs).filter(h => h.active !== false);
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 350);
  const [hubId, setHubId] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [check, setCheck] = useState<Check | { error: string } | null>(null);
  const scan = useRef<ScanInputHandle>(null);

  const summary = useQuery({ queryKey: ["cn", "summary"], queryFn: () => api<Summary>("/cn/summary"), staleTime: 30_000 });
  const batches = useInfiniteQuery({
    queryKey: ["cn", "batches", q, hubId],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: "25" });
      if (q) p.set("q", q);
      if (hubId) p.set("hubId", hubId);
      if (pageParam) p.set("cursor", pageParam);
      return api<{ items: Batch[]; nextCursor: string | null }>(`/cn/batches?${p}`);
    },
    getNextPageParam: last => last.nextCursor || undefined,
    staleTime: 30_000,
  });
  const detail = useQuery({ queryKey: ["cn", "batch", open], queryFn: () => api<BatchDetail>(`/cn/batches/${open}`), enabled: !!open });
  const reload = () => void qc.invalidateQueries({ queryKey: ["cn"] });
  // Bookings use labels: refresh the counts when parcels are created.
  useLive(["parcel.created"], reload, { debounceMs: 2000 });
  const items = batches.data?.pages.flatMap(p => p.items) ?? [];
  const s = summary.data;
  const v = (k: keyof Summary) => (s ? num(s[k]) : "…");
  const d = open ? detail.data : null;

  const merchants = async () => (await api<{ id: string; name: string; code: string; status: string }[]>("/ops/merchants").catch(() => [])).filter(m => m.status === "ACTIVE");
  const hubOptions = hubs.map(h => ({ value: h.id, label: h.name }));

  async function printLabels(batchId: string, cns?: string[]) {
    const done = await openDocument(`/documents/cn-sheet/${batchId}`, cns ? { method: "POST", body: { cns }, title: "Preparing CN labels…" } : { title: "Preparing CN labels…" });
    if (done) reload();
  }
  async function allocate() {
    if (!ops.require("dispatch", "allocate labels")) return;
    const list = await merchants();
    await openForm({
      title: "Allocate CN batch",
      description: "Reserves consignment numbers for pre-printed labels. They are ordinary tracking IDs once used.",
      submit: "Allocate",
      fields: [
        { id: "count", label: "Number of labels", type: "number", required: true, value: "50", min: 1, max: 1000, step: 1 },
        { id: "hubId", label: "Kept at hub", type: "select", required: !!ops.myHubs, value: ops.myHubs?.[0]?.id ?? "", options: hubOptions, hint: ops.myHubs ? undefined : "Empty: no hub" },
        { id: "merchantId", label: "Issued to merchant", type: "select", full: true, value: "", options: list.map(m => ({ value: m.id, label: `${m.name} · ${m.code}` })), hint: "Empty: any account (hub counter)" },
        { id: "note", label: "Note", full: true, maxLength: 300, placeholder: "e.g. Counter labels for October" },
      ],
      validate: { count: v => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 1000 ? "" : "Allocate between 1 and 1000 labels") },
      onSubmit: async v => {
        const batch = await api<Batch>("/cn/batches", { method: "POST", body: { count: Number(v.count), hubId: v.hubId || undefined, merchantId: v.merchantId || undefined, note: v.note || undefined } });
        setOpen(batch.id);
        setPicked(new Set());
        reload();
        return `${batch.number}: ${batch.count} consignment numbers allocated. Print the labels from the batch.`;
      },
    });
  }
  async function issue(b: Batch) {
    const list = await merchants();
    await openForm({
      title: `Issue ${b.number}`,
      description: "Move the labels to another hub or issue them to a merchant (only possible before any is used).",
      submit: "Save",
      fields: [
        { id: "hubId", label: "Kept at hub", type: "select", required: !!ops.myHubs, value: b.hub?.id ?? "", options: hubOptions, hint: ops.myHubs ? undefined : "Empty: no hub" },
        { id: "merchantId", label: "Issued to merchant", type: "select", value: b.merchant?.id ?? "", options: list.map(m => ({ value: m.id, label: `${m.name} · ${m.code}` })), hint: "Empty: any account (hub counter)" },
        { id: "note", label: "Note", full: true, maxLength: 300, value: b.note ?? "" },
      ],
      onSubmit: async v => {
        await api(`/cn/batches/${b.id}`, { method: "PATCH", body: { hubId: v.hubId || null, merchantId: v.merchantId || null, note: v.note || null } });
        reload();
        return "Batch updated.";
      },
    });
  }
  async function voidLabels(cns: string[]) {
    await openForm({
      title: `Void ${cns.length} label(s)`,
      description: cns.slice(0, 6).join(", ") + (cns.length > 6 ? "…" : ""),
      submit: "Void labels",
      danger: true,
      fields: [{ id: "reason", label: "Reason", required: true, full: true, maxLength: 300, placeholder: "e.g. Labels damaged in the printer" }],
      validate: { reason: v => (v.length < 3 ? "Say why the labels are voided" : "") },
      onSubmit: async v => {
        const r = await api<{ voided: number; skipped: unknown[] }>("/cn/stock/void", { method: "POST", body: { cns, reason: v.reason } });
        setPicked(new Set());
        reload();
        return `${r.voided} label(s) voided${r.skipped.length ? `; ${r.skipped.length} skipped` : ""}.`;
      },
    });
  }
  async function checkLabel(code: string, source: string) {
    void api("/scans", { method: "POST", body: { code, kind: "CN_CHECK", hubId: ops.myHubs?.[0]?.id, source, ok: true } }).catch(() => undefined);
    try {
      const item = await api<Check>(`/cn/stock/${encodeURIComponent(code)}`);
      setCheck(item);
      // Usable = an unused label; anything else (used, void, unknown) is an error beep.
      scan.current?.feedback(item.status === "AVAILABLE");
    } catch (e) {
      setCheck({ error: describe(e) });
      scan.current?.feedback(false);
    }
  }
  const selected = [...picked];

  return (
    <>
      <PageHeading
        eyebrow="Hub operations · labels"
        title="CN stock"
        subtitle="Pre-allocate consignment numbers in batches, print barcode labels for hubs and merchants, and track used, unused and voided labels."
        actions={
          can ? (
            <Button variant="primary" icon="plus" onClick={allocate}>
              Allocate batch
            </Button>
          ) : null
        }
      />
      <div className="metrics">
        <Metric label="Unused labels" value={v("available")} icon="box" foot={s ? `${num(s.printedUnused)} printed` : ""} note="in stock" />
        <Metric label="Used" value={v("used")} icon="check" foot="booked parcels" note="all time" />
        <Metric label="Voided" value={v("void")} icon="alert" foot="lost or damaged" note="all time" />
        <Metric label="Batches" value={v("batches")} icon="chart" foot={s ? `${num(s.total)} labels` : ""} note={ops.myHubs ? "your hub" : "network wide"} />
      </div>
      <div className="grid-2">
        <Panel title="Check a label" subtitle="Scan a pre-printed label to see whether it can still be used.">
          <div style={{ padding: "12px 16px 16px" }}>
            <ScanInput ref={scan} onScan={checkLabel} label="Consignment number" placeholder="PP-261016-7K3QF" cameraTitle="Scan a CN label" autoFocus={false} big={false} />
            <p aria-live="polite" style={{ margin: "10px 0 0", fontSize: 13 }}>
              {!check ? null : "error" in check ? (
                <span style={{ color: "var(--bad)" }}>{check.error}</span>
              ) : (
                <>
                  <strong>{check.cn}</strong> · <Pill>{STATUS[check.status] ?? check.status}</Pill> · batch {check.batch.number}
                  {check.batch.hub ? ` · ${check.batch.hub.name}` : ""}
                  {check.batch.merchant ? ` · issued to ${check.batch.merchant.name}` : ""}
                  {check.parcel ? ` · parcel ${check.parcel.trackingId} (${check.parcel.status})` : ""}
                  {check.voidReason ? ` · ${check.voidReason}` : ""}
                </>
              )}
            </p>
          </div>
        </Panel>
        <Panel
          title="Using a label"
          subtitle="Stick a pre-printed label on the parcel and enter its CN when booking (New shipment → Pre-printed CN, or the merchant API field cn). The CN becomes the tracking ID; each label can be used once. A batch issued to a merchant can only be used for that merchant's bookings."
        />
      </div>
      {open ? (
        <Panel
          title={d ? `Batch ${d.number}` : "Batch"}
          subtitle={d ? `${d.stock.available} unused · ${d.stock.used} used · ${d.stock.void} void${d.hub ? ` · ${d.hub.name}` : ""}${d.merchant ? ` · issued to ${d.merchant.name}` : ""}` : detail.error ? describe(detail.error) : "Loading…"}
          tools={
            <div className="row">
              {can ? (
                <>
                  <Button size="sm" onClick={() => (selected.length && d ? printLabels(d.id, selected) : toast("Tick the labels to print."))}>
                    Print selected
                  </Button>
                  <Button size="sm" onClick={() => (selected.length ? void voidLabels(selected) : toast("Tick the unused labels to void."))}>
                    Void selected
                  </Button>
                </>
              ) : null}
              <Button size="sm" onClick={() => (setOpen(null), setPicked(new Set()))}>
                Close
              </Button>
            </div>
          }
        >
          <div className="table-wrap" style={{ maxHeight: 360 }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    {d ? (
                      <input
                        type="checkbox"
                        aria-label="Select all unused"
                        checked={!!picked.size && d.items.filter(i => i.status === "AVAILABLE").every(i => picked.has(i.cn))}
                        onChange={e => setPicked(e.target.checked ? new Set(d.items.filter(i => i.status === "AVAILABLE").map(i => i.cn)) : new Set())}
                      />
                    ) : null}
                  </th>
                  <th>CN</th>
                  <th>Status</th>
                  <th>Parcel / reason</th>
                  <th>Printed</th>
                </tr>
              </thead>
              <tbody>
                {(d?.items ?? []).map(i => (
                  <tr key={i.cn}>
                    <td>
                      {i.status === "AVAILABLE" ? (
                        <input type="checkbox" aria-label={`Select ${i.cn}`} checked={picked.has(i.cn)} onChange={() => setPicked(p => (p.has(i.cn) ? (p.delete(i.cn), new Set(p)) : new Set(p.add(i.cn))))} />
                      ) : null}
                    </td>
                    <td>
                      <strong>{i.cn}</strong>
                    </td>
                    <td>
                      <Pill>{STATUS[i.status] ?? i.status}</Pill>
                    </td>
                    <td>{i.parcel ? `${i.parcel.trackingId} · ${i.parcel.recipientName}` : i.voidReason || "—"}</td>
                    <td>{i.printCount ? `${i.printCount}× · ${when(i.lastPrintAt)}` : "Not printed"}</td>
                  </tr>
                ))}
                {d && !d.items.length ? (
                  <tr>
                    <td colSpan={5} className="empty">
                      Empty batch.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
      <Panel
        title="Batches"
        subtitle="Allocated label batches · newest first"
        tools={
          <div className="row">
            <input className="input sm" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Batch number, note or CN" aria-label="Search batches" style={{ width: 220 }} />
            {hubs.length > 1 ? (
              <Select className="select sm" style={{ width: "auto" }} value={hubId} onChange={e => setHubId(e.target.value)} aria-label="Hub">
                <option value="">All hubs</option>
                {hubs.map(h => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </Select>
            ) : null}
          </div>
        }
        footer={
          <div className="row" style={{ justifyContent: "space-between", width: "100%" }}>
            <span>Showing {items.length} batch(es)</span>
            {batches.hasNextPage ? (
              <Button size="sm" onClick={() => batches.fetchNextPage()} disabled={batches.isFetchingNextPage}>
                Load more
              </Button>
            ) : null}
          </div>
        }
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Batch</th>
                <th>Hub</th>
                <th>Issued to</th>
                <th className="num">Unused</th>
                <th className="num">Used</th>
                <th className="num">Void</th>
                <th>Note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map(x => (
                <tr key={x.id}>
                  <td>
                    <strong>{x.number}</strong>
                    <span className="sub">{date(x.createdAt)}</span>
                  </td>
                  <td>{x.hub?.name || "—"}</td>
                  <td>{x.merchant?.name || "Any account"}</td>
                  <td className="num">
                    {x.stock.available} / {x.count}
                  </td>
                  <td className="num">{x.stock.used}</td>
                  <td className="num">{x.stock.void}</td>
                  <td>{x.note || ""}</td>
                  <td>
                    <div className="row-actions">
                      <Button size="sm" onClick={() => (setOpen(x.id), setPicked(new Set()), window.scrollTo({ top: 0, behavior: "smooth" }))}>
                        View
                      </Button>
                      {can ? (
                        <>
                          <Button size="sm" disabled={!x.stock.available} onClick={() => printLabels(x.id)}>
                            Print unused
                          </Button>
                          <Button size="sm" onClick={() => issue(x)}>
                            Issue
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
              {!items.length ? (
                <tr>
                  <td colSpan={8} className="empty">
                    {batches.error ? describe(batches.error) : batches.isLoading ? "Loading…" : "No batches yet. Allocate one to print labels."}
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
