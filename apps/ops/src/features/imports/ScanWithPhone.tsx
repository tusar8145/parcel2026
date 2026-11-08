/**
 * New orders › "Scan with phone" (bridge-scan.js; API /parcel-scans):
 *   1. Choose the parcel type and merchant (one per session) → POST /parcel-scans/sessions.
 *   2. A QR code and link opened on a phone: photos of parcel labels are sent, kept and read on the server into order
 *      fields. Rows appear live (parcel_scan.updated) with their photo; cells are edited in place
 *      (PATCH …/scans/:id). A row's photo opens beside the rows (hover zoom, turn, the text read from it).
 *   3. Download Excel (the import template with a Scan ID column) / Import Excel (the edited file back), or Submit:
 *      the rows go to the import dialog (first / last mile, hub, messages), and each booked parcel keeps its photo.
 * The link works only while this window is open: extended every minute, ended when it closes (also on leaving).
 */
import { Select } from "@panel/ui/Select";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiRaw, describe, download } from "@panel/lib/api";
import { events } from "@panel/lib/events";
import { confirm, openCustom } from "@panel/ui/dialogs";
import { Button, Pill } from "@panel/ui/kit";
import { Icon } from "@panel/ui/Icon";
import { SearchSelect } from "@panel/ui/SearchSelect";
import { toast } from "@panel/ui/toast";
import type { Catalog } from "@/features/parcels/search";
import { openImport, type ImportConfig } from "@panel/ui/Importer";

const KINDS: [string, string][] = [
  ["ecommerce", "E-commerce"],
  ["document", "Banking & Financial"],
  ["customer", "Customer parcel"],
];
const MERCHANT_TYPE: Record<string, string> = { ecommerce: "ECOMMERCE", document: "BANKING_FINANCIAL" };
/** Columns edited in the table (the rest are in the Excel file), in this order when the template has them. */
const TABLE_COLUMNS = ["sender_name", "sender_phone", "pickup_address", "pickup_district", "pickup_zone", "recipient_name", "recipient_phone", "address", "district", "zone", "area", "cod_amount", "weight_kg", "order_ref", "instructions"];
const WIDE: Record<string, number> = { address: 220, pickup_address: 200, instructions: 180 };
const STATUS: Record<string, [string, "info" | "good" | "warn"]> = { READING: ["Reading…", "info"], READ: ["Read", "good"], FAILED: ["Couldn't read", "warn"] };
const PREF_KEY = "deliveryfast-scan-choice";
const PLACE = new Set(["district", "zone", "area", "pickup_district", "pickup_zone", "pickup_area"]);
const familyOf = (key: string) => (key.startsWith("pickup_") ? { district: "pickup_district", zone: "pickup_zone", area: "pickup_area" } : { district: "district", zone: "zone", area: "area" });
const ZOOM = { start: 2.5, min: 1.5, max: 6 };

interface Scan {
  id: string;
  number: number;
  hasPhoto: boolean;
  status: string;
  trackingId: string | null;
  text: string | null;
  cells: Record<string, string | null>;
}
interface Session {
  id: string;
  url: string;
  qrSvg: string;
  kind: string;
  kindLabel: string;
  merchant: { id: string; name: string } | null;
  columns: { key: string; header: string }[];
  scans: Scan[];
}
interface MerchantRef {
  id: string;
  code: string;
  name: string;
  type: string;
  status?: string;
}

export function openScanWithPhone(importConfig: () => Promise<ImportConfig>) {
  return openCustom(close => <ScanDialog importConfig={importConfig} close={() => close()} />, "xwide");
}

function ScanDialog({ importConfig, close }: { importConfig: () => Promise<ImportConfig>; close: () => void }) {
  const [merchants, setMerchants] = useState<MerchantRef[] | null>(null);
  const pref = (() => {
    try {
      return JSON.parse(localStorage.getItem(PREF_KEY) || "{}") as { kind?: string; merchantId?: string };
    } catch {
      return {};
    }
  })();
  const [kind, setKind] = useState(KINDS.some(([k]) => k === pref.kind) ? pref.kind! : "ecommerce");
  const [merchantId, setMerchantId] = useState(pref.merchantId ?? "");
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const live = useRef(true);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  useEffect(() => {
    live.current = true;
    api<MerchantRef[]>("/ops/merchants").then(
      list => setMerchants(list.filter(m => m.status === "ACTIVE")),
      () => setMerchants([]),
    );
    const leave = () => sessionRef.current && void apiRaw(`/parcel-scans/sessions/${sessionRef.current.id}`, { method: "DELETE", keepalive: true }).catch(() => undefined);
    addEventListener("pagehide", leave);
    return () => {
      live.current = false;
      removeEventListener("pagehide", leave);
      if (sessionRef.current) void api(`/parcel-scans/sessions/${sessionRef.current.id}`, { method: "DELETE" }).catch(() => undefined);
    };
  }, []);

  const type = MERCHANT_TYPE[kind];
  const list = type ? (merchants ?? []).filter(m => m.type === type) : [];
  async function start() {
    const mid = type ? merchantId : "";
    if (type && !mid) return setError("Choose the merchant.");
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({ kind, merchantId: mid }));
    } catch {
      /* private mode */
    }
    setStarting(true);
    try {
      const created = await api<Session>("/parcel-scans/sessions", { method: "POST", body: { kind, ...(mid ? { merchantId: mid } : {}) } });
      // The window was closed meanwhile: end the new session (its link) at once.
      if (!live.current) return void api(`/parcel-scans/sessions/${created.id}`, { method: "DELETE" }).catch(() => undefined);
      setCatalog(await api<Catalog>("/catalog", { auth: false }).catch(() => null));
      setSession(created);
    } catch (e) {
      setError(describe(e));
      setStarting(false);
    }
  }

  if (!session)
    return (
      <>
        <Head title="Scan with phone" subtitle={merchants ? "Photograph parcel labels with a phone: each photo becomes an order row here, read from the label." : "Loading merchants…"} close={close} />
        <div className="dialog-body">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))", gap: 12 }}>
            <label className="field">
              <span>Parcel type</span>
              <Select className="select" value={kind} onChange={e => (setKind(e.target.value), setMerchantId(""), setError(""))}>
                {KINDS.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </label>
            {type ? (
              <div className="field">
                <span className="field-label">Merchant</span>
                <SearchSelect
                  label="Merchants"
                  value={merchantId}
                  onChange={v => (setMerchantId(v), setError(""))}
                  placeholder={list.length ? `Choose the merchant (${list.length})` : "No active merchant of this type"}
                  options={list.map(m => ({ value: m.id, label: `${m.code} · ${m.name}` }))}
                />
              </div>
            ) : null}
          </div>
          <p className="faint" style={{ margin: "12px 0 0" }}>
            Every row of this session uses this type and merchant. The phone link works only while this window is open.
          </p>
          {error ? (
            <p role="alert" style={{ margin: "10px 0 0", color: "var(--bad)", fontWeight: 600 }}>
              {error}
            </p>
          ) : null}
        </div>
        <div className="dialog-foot">
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" icon="camera" onClick={start} disabled={starting || !merchants}>
            Show QR code
          </Button>
        </div>
      </>
    );
  return <Rows first={session} catalog={catalog} setSession={setSession} importConfig={importConfig} close={close} />;
}

function Head({ title, subtitle, close }: { title: string; subtitle: string; close: () => void }) {
  return (
    <div className="dialog-head">
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      <button type="button" className="button ghost icon dialog-close" aria-label="Close" onClick={close}>
          <Icon name="x" size={18} />
        </button>
    </div>
  );
}

function Rows({ first, catalog, setSession, importConfig, close }: { first: Session; catalog: Catalog | null; setSession: (s: Session) => void; importConfig: () => Promise<ImportConfig>; close: () => void }) {
  const [session, setLocal] = useState(first);
  const [viewing, setViewing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const photos = useRef(new Map<string, string>());
  const [, setPhotoTick] = useState(0);
  const saving = useRef(new Map<string, { timer?: ReturnType<typeof setTimeout>; run: () => Promise<void> }>());
  const file = useRef<HTMLInputElement>(null);
  const update = useCallback(
    (s: Session) => {
      setLocal(s);
      setSession(s);
    },
    [setSession],
  );
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const reload = useCallback(async () => {
    try {
      const fresh = await api<Partial<Session>>(`/parcel-scans/sessions/${first.id}`);
      update({ ...sessionRef.current, ...fresh } as Session);
    } catch (e) {
      if ((e as { status?: number }).status === 404) close();
    }
  }, [first.id, update, close]);
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        await api(`/parcel-scans/sessions/${first.id}/keepalive`, { method: "POST" });
        void reload(); // also the safety net when live events are not coming through
      } catch (e) {
        if ((e as { status?: number }).status === 410) {
          clearInterval(timer);
          setExpired(true);
          toast("The phone link has expired. Close this window and open Scan with phone again for a new QR code.", "bad");
        }
      }
    }, 60_000);
    const off = events.on("parcel_scan.updated", d => d.id === first.id && void reload());
    const urls = photos.current;
    const pending = saving.current;
    return () => {
      clearInterval(timer);
      off();
      for (const p of pending.values()) clearTimeout(p.timer);
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
  }, [first.id, reload]);

  /** A row's photo, loaded once (kept as an object URL for the session). */
  const photo = useCallback(async (scanId: string) => {
    if (photos.current.has(scanId)) return photos.current.get(scanId)!;
    try {
      const url = URL.createObjectURL(await (await apiRaw(`/parcel-scans/scans/${scanId}/photo`)).blob());
      photos.current.set(scanId, url);
      setPhotoTick(t => t + 1);
      return url;
    } catch {
      return null;
    }
  }, []);

  const patch = async (scanId: string, cells: Record<string, string | null>) => {
    try {
      const fresh = await api<Scan>(`/parcel-scans/sessions/${first.id}/scans/${scanId}`, { method: "PATCH", body: { cells } });
      const s = sessionRef.current;
      update({ ...s, scans: s.scans.map(x => (x.id === scanId ? { ...x, ...fresh } : x)) });
    } catch (e) {
      toast(describe(e), "bad");
    }
  };
  /** A typed cell is saved after a pause (600 ms); Excel / Submit wait for it. */
  const typed = (scanId: string, key: string, value: string) => {
    const id = `${scanId}:${key}`;
    clearTimeout(saving.current.get(id)?.timer);
    const run = async () => {
      saving.current.delete(id);
      await patch(scanId, { [key]: value.trim() || null });
    };
    saving.current.set(id, { run, timer: setTimeout(() => void run(), 600) });
  };
  const flush = async () => {
    for (const p of [...saving.current.values()]) {
      clearTimeout(p.timer);
      await p.run();
    }
  };
  /** A place was chosen: a zone brings its district; a new district or zone clears what no longer fits. */
  const placeChanged = (scan: Scan, key: string, value: string) => {
    if (!catalog) return;
    const f = familyOf(key);
    const cells: Record<string, string> = { ...(scan.cells as Record<string, string>), [key]: value };
    if (key === f.zone && value) {
      const district = Object.keys(catalog.zonesByDistrict).find(d => catalog.zonesByDistrict[d].includes(value));
      if (district) cells[f.district] = district;
    }
    if (!value && key === f.district) cells[f.zone] = cells[f.area] = "";
    if (!value && key === f.zone) cells[f.area] = "";
    if (cells[f.zone] && cells[f.district] && !(catalog.zonesByDistrict[cells[f.district]] || []).includes(cells[f.zone])) cells[f.zone] = "";
    if (cells[f.area] && !(catalog.areasByZone[cells[f.zone]] || []).includes(cells[f.area])) cells[f.area] = "";
    const columns = new Set(session.columns.map(c => c.key));
    const changed = Object.fromEntries([f.district, f.zone, f.area].filter(k => columns.has(k) && (cells[k] ?? "") !== (scan.cells[k] ?? "")).map(k => [k, cells[k] || null]));
    if (Object.keys(changed).length) void patch(scan.id, changed);
  };
  const placeOptions = (scan: Scan, key: string) => {
    const f = familyOf(key);
    const value = scan.cells[key] ?? "";
    let list: string[] = [];
    let empty = "Choose…";
    if (catalog && key === f.district) list = catalog.districts;
    else if (catalog && key === f.zone) {
      const district = scan.cells[f.district];
      list = district ? catalog.zonesByDistrict[district] || [] : [...new Set(Object.values(catalog.zonesByDistrict).flat())].sort((a, b) => a.localeCompare(b));
      empty = district ? `Choose a zone (${list.length})` : "Choose a zone";
    } else if (catalog && key === f.area) {
      const zone = scan.cells[f.zone];
      list = zone ? catalog.areasByZone[zone] || [] : [];
      empty = zone ? (list.length ? `Choose an area (${list.length})` : "No areas listed") : "Choose the zone first";
    }
    // A value read from the photo that isn't in the catalog stays, marked, until it is changed.
    const options = [...(value && !list.includes(value) ? [{ value, label: `${value} (not in the list)` }] : []), ...list.map(v => ({ value: v, label: v }))];
    return { value, options, empty };
  };

  async function remove(scan: Scan) {
    if (!(await confirm({ title: "Remove this row?", message: "The row and its photo are deleted.", ok: "Remove", danger: true }))) return;
    try {
      await api(`/parcel-scans/sessions/${first.id}/scans/${scan.id}`, { method: "DELETE" });
      const s = sessionRef.current;
      update({ ...s, scans: s.scans.filter(x => x.id !== scan.id) });
      if (viewing === scan.id) setViewing(null);
    } catch (e) {
      toast(describe(e), "bad");
    }
  }
  async function excel() {
    await flush();
    try {
      await download(`/parcel-scans/sessions/${first.id}/workbook`, "delivery-fast-scanned.xlsx");
      toast("Excel downloaded. Keep the Scan ID column, then use Import Excel here to bring your changes back.");
    } catch (e) {
      toast(describe(e), "bad");
    }
  }
  async function importFile(f: File) {
    if (!/\.(xlsx|csv)$/i.test(f.name)) return toast("Choose the Excel (.xlsx) or CSV file.", "bad");
    await flush();
    const form = new FormData();
    form.append("file", f);
    try {
      const result = await (await apiRaw(`/parcel-scans/sessions/${first.id}/workbook`, { method: "POST", body: form })).json();
      update({ ...sessionRef.current, ...result.session });
      toast(`Excel imported: ${result.updated} row${result.updated === 1 ? "" : "s"} updated${result.added ? `, ${result.added} added` : ""}${result.skipped ? `, ${result.skipped} already booked (unchanged)` : ""}.`, "good");
    } catch (e) {
      toast(describe(e), "bad");
    }
  }
  /** The rows go to the import dialog (first / last mile, hub, messages, check, preview, create). */
  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      await flush();
      if (sessionRef.current.scans.some(x => x.status === "READING") && !(await confirm({ title: "Some photos are still being read", message: "Submit now? Those rows go with what is filled in so far.", ok: "Submit" }))) return;
      const blob = await (await apiRaw(`/parcel-scans/sessions/${first.id}/workbook`)).blob();
      const { kind, merchant } = sessionRef.current;
      const workbook = new File([blob], `scanned-${kind}.xlsx`, { type: blob.type });
      const cfg = await importConfig();
      close();
      void openImport({ ...cfg, kind, kinds: undefined, merchantId: merchant?.id, file: workbook });
    } catch (e) {
      toast(describe(e), "bad");
    } finally {
      setBusy(false);
    }
  }

  const cols = TABLE_COLUMNS.map(k => session.columns.find(c => c.key === k)).filter(Boolean) as Session["columns"];
  const scans = session.scans;
  const open = scans.filter(x => !x.trackingId);
  const reading = scans.filter(x => x.status === "READING").length;
  const who = `${session.kindLabel}${session.merchant ? ` · ${session.merchant.name}` : ""}`;
  const viewed = viewing ? scans.find(x => x.id === viewing) ?? null : null;

  return (
    <>
      <Head title="Scan with phone" subtitle={`${who} · photos taken through the link appear below, read from the label. Check each row, then submit.`} close={close} />
      <div className="dialog-body" style={{ maxHeight: "calc(100vh - 190px)" }}>
        <div className="scan-layout" style={{ display: "grid", gridTemplateColumns: viewed ? "minmax(280px, 380px) 1fr" : "minmax(200px, 240px) 1fr", gap: 18, alignItems: "start" }}>
          <div style={{ padding: 14, border: "1px solid var(--line)", borderRadius: 10, background: "#fbfcfe", minWidth: 0 }}>
            {viewed ? (
              <PhotoView scan={viewed} url={photos.current.get(viewed.id)} load={() => photo(viewed.id)} onQr={() => setViewing(null)} />
            ) : (
              <div style={{ display: "grid", gap: 10, justifyItems: "center" }}>
                <div role="img" aria-label="QR code of the phone link" style={{ width: 190, height: 190 }} dangerouslySetInnerHTML={{ __html: session.qrSvg.replace("<svg", '<svg style="width:100%;height:100%"') }} />
                <p style={{ margin: 0, fontSize: 12, color: "var(--muted)", textAlign: "center" }}>Scan with the phone's camera, or open the link on the phone.</p>
                <div className="row" style={{ width: "100%", flexWrap: "nowrap" }}>
                  <input className="input sm" readOnly value={session.url} aria-label="Phone link" style={{ fontSize: 12 }} onFocus={e => e.target.select()} />
                  <Button size="sm" onClick={() => navigator.clipboard?.writeText(session.url).then(() => toast("Link copied. Send it to the phone, or type it in the phone's browser."), () => undefined)}>
                    Copy
                  </Button>
                </div>
                <p style={{ margin: 0, fontSize: 12, color: expired ? "var(--bad)" : "#946200", textAlign: "center" }}>{expired ? "The phone link has expired." : "The link stops working when you close this window."}</p>
                <p style={{ margin: 0, fontSize: 12, color: "var(--muted)", textAlign: "center" }}>Click a row's photo to see it here and compare it with what was read.</p>
              </div>
            )}
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
              <strong>
                {scans.length} parcel{scans.length === 1 ? "" : "s"}
                {reading ? ` · ${reading} being read (a minute or two each, one at a time)` : ""}
              </strong>
              <span className="faint" style={{ fontSize: 12.5 }}>
                Changes are saved as you type · they go into the Excel file and the order
              </span>
            </div>
            <div className="table-wrap" style={{ maxHeight: "52vh", border: "1px solid var(--line)", borderRadius: 10 }}>
              <table className="table" style={{ minWidth: 300 + cols.reduce((a, c) => a + (WIDE[c.key] || 130), 0) }}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Photo</th>
                    <th>Status</th>
                    {cols.map(c => (
                      <th key={c.key}>{c.header}</th>
                    ))}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {scans.map(scan => {
                    const [label, tone] = scan.trackingId ? [`Booked · ${scan.trackingId}`, "good" as const] : STATUS[scan.status] || [scan.status, "info" as const];
                    return (
                      <tr key={scan.id} style={viewing === scan.id ? { background: "#eef3ff" } : undefined}>
                        <td>{scan.number}</td>
                        <td>
                          {scan.hasPhoto ? (
                            <Thumb scanId={scan.id} url={photos.current.get(scan.id)} load={photo} onOpen={() => setViewing(scan.id)} number={scan.number} />
                          ) : (
                            <span className="sub">Excel</span>
                          )}
                        </td>
                        <td>
                          <span title={scan.text ? `Read from the photo:\n${scan.text}` : undefined}>
                            <Pill tone={tone}>{label}</Pill>
                          </span>
                        </td>
                        {cols.map(c => {
                          if (PLACE.has(c.key)) {
                            const p = placeOptions(scan, c.key);
                            return (
                              <td key={c.key}>
                                <SearchSelect size="sm" width={150} label={`${c.header} (parcel ${scan.number})`} value={p.value} onChange={v => placeChanged(scan, c.key, v)} placeholder={p.empty} disabled={!!scan.trackingId} options={p.options} />
                              </td>
                            );
                          }
                          return (
                            <td key={c.key}>
                              <Cell value={scan.cells[c.key] ?? ""} width={WIDE[c.key] || 130} disabled={!!scan.trackingId} label={`${c.header} (parcel ${scan.number})`} onType={v => typed(scan.id, c.key, v)} />
                            </td>
                          );
                        })}
                        <td>
                          <Button size="sm" icon="trash" title="Remove this row and its photo" aria-label={`Remove parcel ${scan.number}`} disabled={!!scan.trackingId} onClick={() => void remove(scan)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!scans.length ? (
              <p className="faint" style={{ margin: "14px 0 0", textAlign: "center" }}>
                Waiting for the first photo…
              </p>
            ) : null}
          </div>
        </div>
        <input
          ref={file}
          type="file"
          accept=".xlsx,.csv"
          hidden
          onChange={e => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void importFile(f);
          }}
        />
      </div>
      <div className="dialog-foot">
        <div className="row" style={{ marginRight: "auto" }}>
          <Button icon="download" onClick={excel}>
            Download Excel
          </Button>
          <Button icon="upload" onClick={() => file.current?.click()}>
            Import Excel
          </Button>
        </div>
        <Button onClick={close}>Close</Button>
        <Button variant="primary" disabled={!open.length || busy} onClick={submit}>
          {open.length ? `Submit ${open.length} order${open.length === 1 ? "" : "s"}` : "Submit"}
        </Button>
      </div>
    </>
  );
}

/** A typed cell: keeps what is being typed; takes the server's value when not being edited. */
function Cell({ value, width, disabled, label, onType }: { value: string; width: number; disabled: boolean; label: string; onType: (v: string) => void }) {
  const [text, setText] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(value);
  }, [value]);
  return (
    <input
      className="input sm"
      aria-label={label}
      style={{ width, minWidth: 0 }}
      disabled={disabled}
      value={text}
      onFocus={() => (editing.current = true)}
      onBlur={() => (editing.current = false)}
      onChange={e => (setText(e.target.value), onType(e.target.value))}
    />
  );
}

function Thumb({ scanId, url, load, onOpen, number }: { scanId: string; url?: string; load: (id: string) => Promise<string | null>; onOpen: () => void; number: number }) {
  useEffect(() => {
    if (!url) void load(scanId);
  }, [scanId, url, load]);
  return (
    <button type="button" className="button sm" onClick={onOpen} style={{ padding: 0, width: 52, height: 52, overflow: "hidden" }} aria-label={`Photo of parcel ${number}`}>
      {url ? <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /> : <Icon name="camera" />}
    </button>
  );
}

/** The photo beside the rows: hover to zoom (mouse wheel: more / less), turn, keep the text read from it shown. */
function PhotoView({ scan, url, load, onQr }: { scan: Scan; url?: string; load: () => Promise<string | null>; onQr: () => void }) {
  const [turn, setTurn] = useState(0);
  const [turnedUrl, setTurnedUrl] = useState<string | null>(null);
  const [pin, setPin] = useState(false);
  const zoom = useRef(ZOOM.start);
  const img = useRef<HTMLImageElement>(null);
  const base = useRef<DOMRect | null>(null);
  useEffect(() => {
    if (!url) void load();
  }, [url, load]);
  useEffect(() => setTurn(0), [scan.id]);
  // The photo drawn turned (so zooming follows the mouse on sideways photos too).
  useEffect(() => {
    if (!turn || !url) return setTurnedUrl(null);
    let made: string | null = null;
    let live = true;
    void (async () => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const canvas = document.createElement("canvas");
      const sideways = turn % 180 !== 0;
      canvas.width = sideways ? bitmap.height : bitmap.width;
      canvas.height = sideways ? bitmap.width : bitmap.height;
      const ctx = canvas.getContext("2d")!;
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((turn * Math.PI) / 180);
      ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
      bitmap.close?.();
      const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, "image/jpeg", 0.92));
      if (blob && live) setTurnedUrl((made = URL.createObjectURL(blob)));
    })();
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [turn, url]);
  const follow = (e: React.MouseEvent) => {
    const el = img.current;
    if (!el || !base.current || pin) return;
    const x = Math.min(1, Math.max(0, (e.clientX - base.current.left) / base.current.width));
    const y = Math.min(1, Math.max(0, (e.clientY - base.current.top) / base.current.height));
    el.style.transformOrigin = `${(x * 100).toFixed(1)}% ${(y * 100).toFixed(1)}%`;
    el.style.transform = `scale(${zoom.current})`;
  };
  const pic = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = pic.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!base.current || pin) return;
      e.preventDefault();
      zoom.current = Math.min(ZOOM.max, Math.max(ZOOM.min, zoom.current * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      if (img.current) img.current.style.transform = `scale(${zoom.current})`;
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [pin]);
  const text = scan.status === "READING" ? "Still reading this photo…" : scan.text || "No text could be read from this photo.";
  const state = scan.trackingId ? `Booked · ${scan.trackingId}` : (STATUS[scan.status] || [scan.status])[0];
  const shown = turnedUrl || url;
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>
          Parcel #{scan.number} · {state}
        </strong>
        <span className="row">
          <Button size="sm" onClick={() => setTurn(t => (t + 90) % 360)}>
            Turn ↻
          </Button>
          <Button size="sm" onClick={onQr}>
            QR code
          </Button>
        </span>
      </div>
      <div
        ref={pic}
        style={{ position: "relative", height: "min(52vh, 480px)", display: "grid", placeItems: "center", overflow: "hidden", borderRadius: 8, background: "#eef2f7", cursor: pin ? "auto" : "zoom-in" }}
        onMouseEnter={e => {
          if (pin || !img.current) return;
          img.current.style.transform = "";
          base.current = img.current.getBoundingClientRect();
          follow(e);
        }}
        onMouseMove={follow}
        onMouseLeave={() => {
          base.current = null;
          if (img.current) img.current.style.transform = "";
        }}
      >
        {shown ? (
          <img ref={img} src={shown} alt={`Photo of parcel ${scan.number}`} draggable={false} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", transition: "transform .08s ease-out", willChange: "transform" }} />
        ) : (
          <span className="faint">Loading the photo…</span>
        )}
        {pin ? (
          <pre aria-label="Text read from the photo" style={{ position: "absolute", inset: 0, overflow: "auto", margin: 0, padding: 12, background: "rgba(255,255,255,.95)", color: "#172033", font: "12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {`Read from the photo:\n\n${text}`}
          </pre>
        ) : null}
      </div>
      <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
        <span className="faint" style={{ fontSize: 12 }}>
          Point at the photo to zoom (mouse wheel: more / less).
        </span>
        <Button size="sm" onClick={() => setPin(p => !p)}>
          {pin ? "Hide text" : "Keep text shown"}
        </Button>
      </div>
    </div>
  );
}
