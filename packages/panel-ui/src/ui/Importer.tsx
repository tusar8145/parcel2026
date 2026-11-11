/**
 * Spreadsheet import and bulk updates (shared/importer.js), one dialog with steps:
 *   Import      choose (category, merchant, first / last mile, drop-off hub, messages, file) → match the columns of
 *               any merchant's file (POST /imports/analyze) → check (POST /imports/validate) → preview (filters,
 *               pages, address / district / zone / area corrected inline: PATCH /imports/:id/rows/:row) → create
 *               (POST /imports/:id/commit) → progress (import.* events + poll) → result (failed rows, labels)
 *   Bulk        choose an action (GET /bulk-updates/actions) → download its file with the filters → upload → check →
 *               preview → apply (options from the page, e.g. Transfers: seal / trip) → progress → result
 *   History     past imports / bulk updates with View and downloads
 */
import { Select } from "./Select";
import { Icon } from "./Icon";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, apiRaw, describe, download } from "../lib/api";
import { events } from "../lib/events";
import { num } from "../lib/format";
import { openCustom } from "./dialogs";
import { toast } from "./toast";
import { SearchSelect } from "./SearchSelect";
import { PRINT_FORMATS, printFormat } from "../lib/print";

const PAGE_SIZE = 50;
const ACCEPT = ".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
type Tone = "good" | "warn" | "bad" | "info";
const ROW_STATUS: Record<string, [string, Tone]> = { VALID: ["Valid", "good"], INCOMPLETE: ["Needs info", "warn"], ERROR: ["Error", "bad"], CREATED: ["Created", "good"], FAILED: ["Not created", "bad"] };
const BULK_ROW_STATUS: Record<string, [string, Tone]> = { READY: ["Will apply", "good"], WARNING: ["Will apply · warning", "warn"], ERROR: ["Error", "bad"], APPLIED: ["Applied", "good"], ALREADY_DONE: ["Already done", "info"], FAILED: ["Not applied", "bad"] };
const JOB_STATUS: Record<string, [string, Tone]> = { VALIDATED: ["Not submitted", "info"], QUEUED: ["Queued", "info"], PROCESSING: ["Booking", "info"], COMPLETED: ["Completed", "good"], FAILED: ["Stopped", "bad"], DISCARDED: ["Discarded", "info"] };
const BULK_JOB_STATUS: Record<string, [string, Tone]> = { ...JOB_STATUS, PROCESSING: ["Applying", "info"] };
const MISSING: Record<string, string> = { recipientName: "recipient name", recipientPhone: "recipient phone", address: "delivery address", district: "district", zone: "zone" };
const KIND_LABEL: Record<string, string> = { customer: "Customer parcel", ecommerce: "E-commerce", document: "Banking & Financial" };
const MERCHANT_TYPE: Record<string, string> = { ecommerce: "ECOMMERCE", document: "BANKING_FINANCIAL" };
const FIRST_MILE: Record<string, [string, string]> = { RIDER_PICKUP: ["PICKUP", "Rider pickup"], HUB_DROP: ["DROP_OFF", "Drop at hub"], ON_DEMAND_PICKUP: ["ON_DEMAND_PICKUP", "On-demand pickup"] };
const LAST_MILE: Record<string, string> = { DOORSTEP: "Home delivery", HUB_COLLECT: "Hub Pickup" };
const PRODUCT_TYPE: [string, string][] = [
  ["REGULAR", "Regular"],
  ["DOCUMENT", "Document"],
  ["BOOKS", "Books"],
];
const STATUS_OPTIONS: [string, string][] = [
  ["PENDING_CONFIRMATION", "Pending operations confirmation"],
  ["PICKUP_ASSIGNED", "Pickup assigned"],
  ["PICKUP_CONFIRMED", "Pickup confirmed"],
  ["PICKED_UP", "Picked up"],
  ["AT_HUB", "At hub"],
  ["ASSIGNED", "Assigned"],
  ["IN_TRANSIT", "In transit"],
  ["OUT_FOR_DELIVERY", "Out for delivery"],
  ["RETRY_SCHEDULED", "Retry scheduled"],
  ["RETURN_SCHEDULED", "Return scheduled"],
  ["EXCEPTION", "Exception"],
  ["DELIVERED", "Delivered"],
  ["PICKUP_CANCELLED", "Pickup cancelled"],
  ["RETURNED", "Returned"],
];
const PRESETS: [string, string][] = [
  ["pending_review", "Pending operations confirmation"],
  ["at_hub_unassigned", "At hub · no delivery rider"],
  ["needs_info", "Needs info"],
];
const LINE_LABEL: Record<string, string> = { ecommerce: "E-commerce", document: "Documents", customer: "Customer parcels" };
const taka = (n: unknown) => (n == null ? "—" : `৳${Number(n).toLocaleString("en-BD", { maximumFractionDigits: 2 })}`);
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const qs = (path: string, params: Record<string, unknown>) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false).map(([k, v]) => [k, String(v)]));
  return s.toString() ? `${path}?${s}` : path;
};
const bulkDay = (d?: string, end?: boolean) => (d ? new Date(`${d}T${end ? "23:59:59.999" : "00:00:00"}`).toISOString() : "");

export interface MerchantRef {
  id: string;
  code?: string;
  name: string;
  type?: string;
  /** The merchant's hub (chosen by a super admin, or the hub serving its pickup zone): preselected as the drop-off hub. */
  hubId?: string | null;
}
export interface BulkFilters {
  preset?: string;
  status?: string;
  merchantId?: string;
  hubId?: string;
  intake?: string;
  sla?: string;
  from?: string;
  to?: string;
  dateField?: string;
  incomplete?: boolean;
}
export interface ImportConfig {
  mode?: "import" | "bulk";
  kind?: string;
  kinds?: string[];
  forOps?: boolean;
  merchantId?: string;
  merchants?: MerchantRef[];
  hubs?: { id: string; name: string }[];
  hubId?: string;
  noun?: string;
  file?: File;
  printLabels?: (ids: string[]) => void;
  onDone?: () => void;
  // bulk
  bulkKind?: string;
  bulkAction?: string;
  filters?: BulkFilters;
  line?: string;
  /** Apply options shown under the preview (Transfers: seal / trip); `body()` returns the apply body, or false. */
  applyExtra?: { render: () => ReactNode; body: () => Record<string, unknown> | false };
  resultExtra?: (job: Job) => ReactNode;
}

interface Job {
  id: string;
  number: string;
  status: string;
  fileName?: string;
  columns: { key: string; header: string; required?: boolean; editable?: boolean }[];
  counts: { rows: number; valid: number; incomplete: number; errors: number; toApply: number; warnings: number; alreadyDone: number; ignored: number };
  result: { created: number; createdIncomplete: number; notCreated: number; applied: number; alreadyDone: number; notApplied: number };
  progress: { processed: number; total: number; percent: number };
  services?: { firstMileLabel?: string; lastMileLabel?: string; notifications?: unknown[]; speedLabel?: string | null; productTypeLabel?: string | null; categoryLabel?: string | null; priorityLabel?: string | null };
  intake?: string;
  dropOffHub?: { name: string } | null;
  batch?: { number: string } | null;
  totals?: { charge: number } | null;
  ignoredColumns?: string[];
  skippedLines?: { count: number; rows: number[] } | null;
  rowsAvailable?: boolean;
  error?: string;
  title?: string;
  kindTitle?: string;
  action?: string;
  kind?: string;
  pricing?: { rows: number; before: number; after: number; difference: number } | null;
  transfer?: { result?: TransferResult };
  createdAt?: string;
  createdBy?: string;
  merchant?: { name: string } | null;
  downloads?: { failedRows?: boolean };
}
export interface TransferResult {
  bags: { number: string; label?: string; originHub: string; destHub: string; parcels: number; status: string; trip?: string | null }[];
  trips: { number: string; destHub: string; bags: number }[];
  problems: string[];
}
interface Rows {
  items: Row[];
  page: number;
  pages: number;
  total: number;
}
interface Row {
  rowNumber: number;
  status: string;
  cells?: Record<string, string>;
  errors: { column: string; message: string; text: string }[];
  warnings: { column: string; message: string; text: string }[];
  missing?: string[];
  autoFilled?: string[];
  trackingId?: string;
  charge?: number;
  lines?: { label: string; amount: number }[];
  messagesOff?: boolean;
  messagesNote?: string;
  plan?: { price?: { before: number; after: number; difference: number }; usedSuggestion?: boolean };
  result?: string;
}
interface Layout {
  headerRow: number;
  template?: boolean;
  remembered?: boolean;
  orders: number;
  extraLines: number;
  top: { row: number; text: string }[];
  fields: { key: string; header: string; required?: boolean }[];
  columns: { index: number; letter: string; header?: string; samples: string[]; key: string | null; by?: string | null }[];
}
interface Pkg {
  options: { firstMiles: string[]; lastMiles: string[]; speeds?: string[]; deliveryTypes?: { code: string; name: string }[]; defaultFirstMile?: string; defaultLastMile?: string; [k: string]: unknown };
  notifications: { code: string; title: string }[];
  dropHubs?: { id: string; name: string }[];
  /** The list's categories and priorities (the modal may set them for every row). */
  categories?: { id: string; name: string }[];
  priorities?: { id: string; name: string; isDefault: boolean }[];
}
interface KindDef {
  kind: string;
  page: string;
  title: string;
  presets: string[];
  statuses: { value: string; label: string }[];
  actions: { action: string; label: string }[];
}
interface Action {
  action: string;
  label: string;
  summary: string;
  title: string;
  howTo: string;
  does: string;
  parcels: string;
  count: number;
  fill: string[];
  skipBlank?: boolean;
}
interface Catalog {
  districts: string[];
  zonesByDistrict: Record<string, string[]>;
  areasByZone: Record<string, string[]>;
}

export const openImport = (cfg: ImportConfig) => openCustom(close => <Importer cfg={{ mode: "import", ...cfg }} start="open" close={close} />, "xwide");
export const openImportHistory = (cfg: ImportConfig) => openCustom(close => <Importer cfg={{ mode: "import", ...cfg }} start="history" close={close} />, "xwide");
export const openBulk = (cfg: ImportConfig) => openCustom(close => <Importer cfg={{ ...cfg, mode: "bulk" }} start="open" close={close} />, "xwide");
export const openBulkHistory = (cfg: ImportConfig) => openCustom(close => <Importer cfg={{ ...cfg, mode: "bulk" }} start="history" close={close} />, "xwide");
export async function downloadTemplate(kind: string, merchantId?: string) {
  const name = await download(qs(`/imports/templates/${kind}`, { merchantId }), `delivery-fast-${kind}-template.xlsx`);
  toast(`${name} downloaded. Required columns have red headers with *; the Instructions sheet explains every column.`, "good");
}

type Step = "loading" | "actions" | "choose" | "analyzing" | "map" | "checking" | "preview" | "booking" | "result" | "history";

function Importer({ cfg: initial, start, close }: { cfg: ImportConfig; start: "open" | "history"; close: () => void }) {
  const bulk = initial.mode === "bulk";
  const base = bulk ? "/bulk-updates" : "/imports";
  const [cfg, setCfg] = useState<ImportConfig>(initial);
  const [step, setStep] = useState<Step>("loading");
  const [message, setMessage] = useState("");
  const [limits, setLimits] = useState<{ maxRows: number; maxFileMb: number } | null>(null);
  const [config, setConfig] = useState<{ ai?: boolean; templates: Record<string, { key: string; header: string; required?: boolean; inTemplate?: boolean; packageOnly?: string }[]> } | null>(null);
  const [kinds, setKinds] = useState<KindDef[]>([]);
  const [pkg, setPkg] = useState<Pkg | null>(null);
  const [merchantId, setMerchantId] = useState(initial.forOps && initial.merchantId && !bulk ? initial.merchantId : "");
  const [firstMile, setFirstMile] = useState("RIDER_PICKUP");
  const [lastMile, setLastMile] = useState("DOORSTEP");
  const [hubId, setHubId] = useState(() => (initial.forOps && initial.merchantId ? initial.merchants?.find(m => m.id === initial.merchantId)?.hubId : null) || initial.hubId || "");
  const [notifications, setNotifications] = useState<Set<string>>(new Set());
  // The modal's Service and product type for every row ("" = each row's own, from the file).
  const [speed, setSpeed] = useState("");
  const [productType, setProductType] = useState("");
  // The modal's category (none = each row's own / its product's) and priority (the default preselected).
  const [category, setCategory] = useState("");
  const [priority, setPriority] = useState("");
  const unticked = useRef<Set<string>>(new Set());
  // Operations: choosing the merchant preselects its hub as the drop-off hub (when this person can use that hub).
  useEffect(() => {
    if (!cfg.forOps || !merchantId) return;
    const hub = cfg.merchants?.find(m => m.id === merchantId)?.hubId;
    if (hub && (!cfg.hubs?.length || cfg.hubs.some(h => h.id === hub))) setHubId(hub);
  }, [merchantId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [file, setFile] = useState<File | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [rows, setRows] = useState<Rows | null>(null);
  const [filter, setFilter] = useState("all");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [actions, setActions] = useState<Action[] | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [filters, setFilters] = useState<BulkFilters>({ ...(initial.filters || {}) });
  const [exportInfo, setExportInfo] = useState("");
  const [history, setHistory] = useState<Job[] | null>(null);
  const [historyKind, setHistoryKind] = useState<string | null>(null);
  const [historyAction, setHistoryAction] = useState("");
  const [busy, setBusy] = useState(false);
  const autoPicked = useRef(false);
  const stepRef = useRef(step);
  stepRef.current = step;
  const jobRef = useRef(job);
  jobRef.current = job;

  const bulkKind = cfg.bulkKind || "all";
  const kindDef = kinds.find(k => k.kind === bulkKind);
  const pageOf = (k: string) => kinds.find(x => x.kind === k)?.page || (k === "all" ? "All parcels" : k);
  const bulkTitle = `Bulk update ${pageOf(bulkKind)} by Excel`;
  /** A delivery type code's name (from the package's options). */
  const typeName = (code: string) => pkg?.options.deliveryTypes?.find(t => t.code === code)?.name ?? code;
  const noun = cfg.noun || (cfg.kind === "document" ? "consignments" : cfg.kind === "customer" ? "parcels" : "orders");
  const nounFor = (n: number) => (n === 1 ? noun.replace(/s$/, "") : noun);
  const count = (n: number) => `${num(n)} ${nounFor(n)}`;
  const needsMerchant = !!cfg.forOps && cfg.kind !== "customer";
  const mapsColumns = !bulk && !!cfg.forOps;
  const merchantsOf = (cfg.merchants || []).filter(m => !m.type || m.type === MERCHANT_TYPE[cfg.kind || ""]);
  const rowStatus = bulk ? BULK_ROW_STATUS : ROW_STATUS;

  // Closing: a checked file not submitted is dropped; a running job goes on in the background.
  const finishClose = () => {
    const j = jobRef.current;
    if (stepRef.current === "preview" && j?.status === "VALIDATED") void api(`${base}/${j.id}`, { method: "DELETE" }).catch(() => undefined);
    if (stepRef.current === "booking") toast(bulk ? `Bulk update ${j?.number || ""} continues in the background. Open the bulk update history to follow it.` : `Import ${j?.number || ""} continues in the background. Open the import history to follow it.`);
    if (j && ["COMPLETED", "QUEUED", "PROCESSING"].includes(j.status)) cfg.onDone?.();
    close();
  };

  async function loadPackage(kind = cfg.kind, merchant = merchantId) {
    let p: Pkg | null = null;
    try {
      if (!cfg.forOps) p = await api<Pkg>("/packages/me");
      else if (kind === "customer") p = await api<Pkg>(qs("/packages/effective", { segment: "CUSTOMER" }));
      else if (merchant) p = await api<Pkg>(qs("/packages/effective", { merchantId: merchant }));
    } catch (e) {
      toast(describe(e), "bad");
    }
    setPkg(p);
    if (!p) return;
    const o = p.options;
    setFirstMile(f => (o.firstMiles.includes(f) ? f : o.defaultFirstMile || "RIDER_PICKUP"));
    setLastMile(l => (o.lastMiles.includes(l) ? l : o.defaultLastMile || "DOORSTEP"));
    // Delivery type and priority: for the whole file, the first (default) preselected.
    setSpeed(v => (v && (o.speeds ?? []).includes(v) ? v : (o.speeds ?? [])[0] || ""));
    setCategory(v => (v && (p.categories ?? []).some(c => c.id === v) ? v : ""));
    setPriority(v => (v && (p.priorities ?? []).some(x => x.id === v) ? v : ((p.priorities ?? []).find(x => x.isDefault)?.id ?? (p.priorities ?? [])[0]?.id ?? "")));
    setNotifications(new Set(p.notifications.map(n => n.code).filter(c => !unticked.current.has(c))));
  }

  useEffect(() => {
    void (async () => {
      if (start === "history") return void openHistory();
      try {
        if (bulk) {
          const [l, k] = await Promise.all([api<{ maxRows: number; maxFileMb: number }>("/bulk-updates/limits"), api<KindDef[]>("/bulk-updates/kinds")]);
          setLimits(l);
          setKinds(k);
          if (!k.some(x => x.kind === bulkKind)) throw new Error(`You can't use the ${pageOf(bulkKind)} bulk update.`);
          await actionStep(k);
        } else {
          const [l, c] = await Promise.all([api<{ maxRows: number; maxFileMb: number }>(qs("/imports/limits", { merchantId: cfg.merchantId })), api<typeof config>("/imports/config")]);
          setLimits(l);
          setConfig(c);
          await loadPackage();
          if (cfg.file) pick(cfg.file, l);
          setStep("choose");
        }
      } catch (e) {
        toast(e instanceof Error && !("status" in e) ? e.message : describe(e), "bad");
        close();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pick(f: File, l = limits) {
    setFile(null);
    setLayout(null);
    setMessage("");
    if (!/\.(xlsx|csv)$/i.test(f.name)) return setMessage(/\.xls$/i.test(f.name) ? "Old .xls files can't be read: save it as Excel Workbook (.xlsx)." : "Choose an Excel (.xlsx) or CSV file.");
    if (l && f.size > l.maxFileMb * 1024 * 1024) return setMessage(`This file is ${(f.size / 1048576).toFixed(1)} MB; the limit is ${l.maxFileMb} MB. Split it into smaller files.`);
    setFile(f);
  }

  // ── bulk: choose an action ──
  async function actionStep(k = kinds) {
    setStep("actions");
    setAction(null);
    setFile(null);
    setExportInfo("");
    const f = filters;
    const list = await api<Action[]>(
      qs("/bulk-updates/actions", { kind: bulkKind, preset: f.preset, status: f.status, merchantId: f.merchantId, hubId: f.hubId, intake: f.intake, sla: f.sla, from: bulkDay(f.from), to: bulkDay(f.to, true), dateField: f.dateField, incomplete: f.incomplete ? "true" : "", line: cfg.line }),
    );
    setActions(list);
    void k;
    if (cfg.bulkAction && !autoPicked.current) {
      autoPicked.current = true;
      const a = list.find(x => x.action === cfg.bulkAction);
      if (a) {
        setAction(a);
        setStep("choose");
      }
    }
  }

  async function bulkDownload() {
    if (!action) return;
    setExportInfo("Preparing the file…");
    const f = filters;
    try {
      const response = await apiRaw(
        qs("/bulk-updates/export", { kind: bulkKind, action: action.action, preset: f.preset, status: f.status, merchantId: f.merchantId, hubId: f.hubId, intake: f.intake, sla: f.sla, from: bulkDay(f.from), to: bulkDay(f.to, true), dateField: f.dateField, incomplete: f.incomplete ? "true" : "", line: cfg.line }),
      );
      const n = Number(response.headers.get("x-row-count") || 0);
      const matched = Number(response.headers.get("x-matched") || n);
      const limit = Number(response.headers.get("x-row-limit") || 0);
      let info: string;
      if (!n) info = `No parcels can take "${action.label}" with these filters.`;
      else {
        const name = /filename="?([^";]+)"?/.exec(response.headers.get("content-disposition") || "")?.[1] || "delivery-fast-bulk-update.xlsx";
        const url = URL.createObjectURL(await response.blob());
        const link = Object.assign(document.createElement("a"), { href: url, download: name });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        info =
          matched > n
            ? `Downloaded the first ${num(n)} of ${num(matched)} parcels (limit ${num(limit)} per file). Narrow the filters for the rest.`
            : `Downloaded ${num(n)} parcel${n === 1 ? "" : "s"}. ${action.skipBlank ? "Fill in the rows to change (empty rows are skipped)" : "Delete the rows you don't want to change"}, save, and upload it below.`;
      }
      setExportInfo(info);
      toast(info);
    } catch (e) {
      setExportInfo(describe(e));
      toast(describe(e), "bad");
    }
  }

  // ── check (dry run) ──
  async function check() {
    if (!file) return;
    setMessage("");
    if (!bulk && needsMerchant && !merchantId) return setMessage("Choose the merchant for this file.");
    if (!bulk && firstMile === "HUB_DROP" && !hubId) return setMessage("Choose the hub the parcels are dropped at.");
    if (mapsColumns && !layout) return analyze();
    if (mapsColumns && step === "choose") return setStep("map");
    if (mapsColumns && layout) {
      const problem = mappingProblem(layout);
      if (problem) {
        setMessage(problem);
        return setStep("map");
      }
    }
    await validate(layout);
  }

  async function validate(l: Layout | null) {
    setStep("checking");
    const form = new FormData();
    if (!bulk) {
      form.append("kind", cfg.kind || "");
      if (cfg.merchantId) form.append("merchantId", cfg.merchantId);
      if (needsMerchant && merchantId) form.append("merchantId", merchantId);
      if (firstMile === "HUB_DROP") {
        form.append("intake", "DROP_OFF");
        form.append("dropOffHubId", hubId);
      } else if (pkg && firstMile) form.append("firstMile", firstMile);
      if (pkg && lastMile) form.append("lastMile", lastMile);
      if (speed) form.append("speed", speed);
      if (productType && cfg.kind !== "document") form.append("productType", productType);
      if (category && !config?.ai) form.append("category", category);
      if (priority) form.append("priority", priority);
      if (pkg?.notifications?.length && notifications.size !== pkg.notifications.length) form.append("notifications", notifications.size ? [...notifications].join(",") : "none");
      if (mapsColumns && l) form.append("mapping", JSON.stringify({ headerRow: l.headerRow, columns: l.columns.map(c => c.key || null) }));
    }
    form.append("file", file!, file!.name);
    try {
      const response = await apiRaw(bulk ? qs(`${base}/validate`, { kind: bulkKind, action: action?.action }) : `${base}/validate`, { method: "POST", body: form });
      const j = (await response.json()) as Job & { rows: Rows };
      setJob(j);
      setRows(j.rows);
      setFilter("all");
      if (!bulk && !catalog) setCatalog(await api<Catalog>("/catalog").catch(() => null));
      setStep("preview");
    } catch (e) {
      setMessage(describe(e));
      setStep(mapsColumns && l ? "map" : "choose");
    }
  }

  async function analyze(headerRow?: number) {
    setStep("analyzing");
    const form = new FormData();
    form.append("kind", cfg.kind || "");
    const m = cfg.merchantId || (needsMerchant ? merchantId : "");
    if (m) form.append("merchantId", m);
    if (headerRow !== undefined) form.append("headerRow", String(headerRow));
    form.append("file", file!, file!.name);
    try {
      const l = (await (await apiRaw(`${base}/analyze`, { method: "POST", body: form })).json()) as Layout;
      setLayout(l);
      // Our own template (or a Scan with phone workbook): nothing to match, check it straight away.
      if (l.template && headerRow === undefined) return void validate(l);
      setStep("map");
    } catch (e) {
      setMessage(describe(e));
      setStep("choose");
    }
  }

  function mappingProblem(l: Layout) {
    const chosen = l.columns.map(c => c.key).filter(Boolean);
    const missing = l.fields.filter(f => f.required && !chosen.includes(f.key)).map(f => f.header);
    if (missing.length) return `Choose the ${missing.join(" and ")} column.`;
    const twice = l.fields.find(f => f.key !== "__address_part" && chosen.filter(k => k === f.key).length > 1);
    if (twice) return `${twice.header} is chosen for more than one column: keep one.`;
    return "";
  }

  async function loadRows(f = filter, page = rows?.page ?? 1) {
    const r = await api<Rows>(qs(`${base}/${job!.id}/rows`, { filter: f, page, pageSize: PAGE_SIZE }));
    setRows(r);
    setFilter(f);
  }

  // ── create / apply, progress, result ──
  async function commit() {
    if (!job) return;
    const body = bulk && cfg.applyExtra ? cfg.applyExtra.body() : undefined;
    if (body === false) return;
    const j = await api<Job>(bulk ? qs(`/bulk-updates/${job.id}/apply`, { kind: bulkKind, action: job.action || undefined }) : `/imports/${job.id}/commit`, { method: "POST", ...(body ? { body } : {}) });
    setJob(j);
    if (["COMPLETED", "FAILED"].includes(j.status)) return finish(j);
    setStep("booking");
  }
  useEffect(() => {
    if (step !== "booking" || !job) return;
    const refresh = async () => {
      try {
        const j = await api<Job>(`${base}/${job.id}`);
        setJob(j);
        if (["COMPLETED", "FAILED"].includes(j.status)) void finish(j);
      } catch {
        /* next poll */
      }
    };
    const types = bulk ? ["bulk_update.progress", "bulk_update.completed"] : ["import.progress", "import.completed"];
    const offs = types.map(t => events.on(t, d => d?.id === job.id && void refresh()));
    const poll = setInterval(refresh, 3000);
    return () => (offs.forEach(o => o()), clearInterval(poll));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, job?.id]);

  async function finish(j: Job) {
    const f = bulk ? (j.result.notApplied ? "not_applied" : "all") : j.result.notCreated ? "not_created" : "all";
    setFilter(f);
    try {
      setRows(await api<Rows>(qs(`${base}/${j.id}/rows`, { filter: f, page: 1, pageSize: PAGE_SIZE })));
    } catch {
      setRows({ items: [], page: 1, pages: 1, total: 0 });
    }
    setStep("result");
  }

  async function downloadFailed(id = job?.id, number = job?.number) {
    await download(`${base}/${id}/failed-rows`, `${number}-not-${bulk ? "applied" : "created"}.xlsx`);
    toast(`Rows not ${bulk ? "applied" : "created"} downloaded with an Error column. Fix them and upload the file again.`);
  }

  async function labels(j = job) {
    if (!j) return;
    const { trackingIds } = await api<{ trackingIds: string[] }>(`/imports/${j.id}/tracking-ids`);
    if (!trackingIds.length) return toast("This import didn't create any parcels.");
    finishClose();
    cfg.printLabels?.(trackingIds);
  }

  async function openHistory(kindFilter = historyKind, actionFilter = historyAction) {
    setStep("history");
    setJob(null);
    setHistory(null);
    try {
      if (bulk) {
        const k = kinds.length ? kinds : await api<KindDef[]>("/bulk-updates/kinds").catch(() => []);
        setKinds(k);
        const hk = kindFilter ?? (bulkKind === "all" ? "" : bulkKind);
        setHistoryKind(hk);
        setHistory((await api<{ items: Job[] }>(qs("/bulk-updates", { limit: 50, kind: hk, action: actionFilter }))).items);
      } else {
        // Pages that import several kinds (Operations › New orders, All parcels) show every import, of any kind;
        // filtering by the kind on screen hid an import of another kind after it was booked.
        const many = (initial.kinds?.length ?? 0) > 1;
        setHistory((await api<{ items: Job[] }>(qs("/imports", { merchantId: cfg.merchantId, kind: many ? undefined : cfg.kind, limit: 50 }))).items);
      }
    } catch (e) {
      toast(describe(e), "bad");
      close();
    }
  }

  async function view(id: string) {
    const j = await api<Job>(`${base}/${id}`);
    setJob(j);
    if (["QUEUED", "PROCESSING"].includes(j.status)) return setStep("booking");
    await finish(j);
  }

  // ───────────── drawing ─────────────
  const pill = (text: string, t: Tone) => <span className={`pill ${t === "info" ? "" : t}`}>{text}</span>;
  let title = "";
  let subtitle: ReactNode = "";
  let body: ReactNode = null;
  let foot: ReactNode = null;
  const run = (work: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      toast(describe(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  const cancel = (
    <button type="button" className="button" onClick={finishClose}>
      Cancel
    </button>
  );
  const fileDrop = (
    <FileDrop file={file} accept={ACCEPT} maxMb={limits?.maxFileMb} onFile={f => (f ? pick(f) : (setFile(null), setLayout(null)))} />
  );
  const errorLine = message ? (
    <p role="alert" className="form-error" style={{ margin: 0 }}>
      {message}
    </p>
  ) : null;

  if (step === "loading") {
    title = bulk ? bulkTitle : `Import ${noun} from Excel`;
    subtitle = "Loading the limits…";
    foot = cancel;
  } else if (step === "actions") {
    title = bulkTitle;
    subtitle = "Choose an action → download its Excel file → fill it in → upload → check the preview → apply. Each action has its own file with only the parcels and columns it needs.";
    body = (
      <div className="stack">
        <h3 style={{ margin: 0, fontSize: 15 }}>1 · Choose an action</h3>
        {!actions ? <p className="muted">Loading the actions…</p> : null}
        <div role="list" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
          {actions?.map(a => (
            <button key={a.action} type="button" className="panel" style={{ display: "grid", gap: 3, textAlign: "left", padding: "12px 14px", cursor: "pointer", font: "inherit", color: "inherit" }} onClick={() => (setAction(a), setFile(null), setExportInfo(""), setStep("choose"))}>
              <span className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                <strong style={{ color: "var(--ink)" }}>{a.label}</strong>
                {pill(`${num(a.count)} parcel${a.count === 1 ? "" : "s"}`, a.count ? "info" : "warn")}
              </span>
              <span className="muted" style={{ fontSize: 13 }}>
                {a.summary}
              </span>
            </button>
          ))}
        </div>
        {errorLine}
      </div>
    );
    foot = (
      <>
        <div className="row" style={{ marginRight: "auto" }}>
          <button type="button" className="button" onClick={() => void openHistory()}>
            Bulk update history
          </button>
        </div>
        {cancel}
      </>
    );
  } else if (step === "choose" && bulk && action) {
    title = bulkTitle;
    subtitle = `${action.title} · download → fill in → upload → check the preview → apply. Each row is applied on its own, exactly like the single action.`;
    const f = filters;
    const set = (patch: Partial<BulkFilters>) => setFilters(x => ({ ...x, ...patch }));
    const sel = (label: string, value: string | undefined, options: [string, string][], all: string, onChange: (v: string) => void) => (
      <label className="field">
        <span>{label}</span>
        <Select className="select" value={value || ""} onChange={e => onChange(e.target.value)}>
          <option value="">{all}</option>
          {options.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </label>
    );
    const presets = PRESETS.filter(([v]) => !kindDef || kindDef.presets.includes(v));
    body = (
      <div className="stack-lg">
        <section className="stack">
          <h3 style={{ margin: 0, fontSize: 15 }}>2 · Download the "{action.label}" file</h3>
          <div className="callout" style={{ display: "block", marginBottom: 0 }}>
            <strong style={{ display: "block", marginBottom: 4 }}>{action.title}</strong>
            <span style={{ display: "block", marginBottom: 4 }}>{action.howTo}</span>
            <span style={{ display: "block", marginBottom: 4 }}>{`${action.does} The file lists ${action.parcels}: ${num(action.count)} now.`}</span>
            <span>
              Columns to fill in: <strong>{action.fill.join(", ")}</strong> (* = required). The other columns are the parcel's data (grey, locked). There is no Action column: the file is "{action.label}".
            </span>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            {presets.length ? "Choose a quick filter or set your own" : "Narrow it with the filters below if you like"}
            {cfg.line ? (
              <>
                {" "}
                (service line: <strong>{LINE_LABEL[cfg.line]}</strong>)
              </>
            ) : null}
            . Only the parcels that can take this action are in the file. <strong>Max {num(limits?.maxRows)} parcels per file.</strong>
          </p>
          <div className="row" role="group" aria-label="Quick filters">
            {presets.map(([v, l]) => (
              <button key={v} type="button" className={`button sm ${f.preset === v ? "primary" : ""}`} aria-pressed={f.preset === v} onClick={() => setFilters(f.preset !== v ? { preset: v } : {})}>
                {l}
              </button>
            ))}
            <button type="button" className="button sm" onClick={() => setFilters({})}>
              Clear filters
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            {sel("Status", f.status, kindDef && kindDef.kind !== "all" ? kindDef.statuses.map(s => [s.value, s.label]) : STATUS_OPTIONS, kindDef && kindDef.kind !== "all" ? `Every ${kindDef.page} status` : "All statuses", v => set({ status: v }))}
            <label className="field">
              <span>Merchant</span>
              <SearchSelect label="Merchant" emptyLabel="All merchants" options={(cfg.merchants || []).map(m => ({ value: m.id, label: `${m.code ? `${m.code} · ` : ""}${m.name}` }))} value={f.merchantId || ""} onChange={v => set({ merchantId: v })} />
            </label>
            {sel("Hub", f.hubId, (cfg.hubs || []).map(h => [h.id, h.name]), cfg.hubs?.length === 1 ? "My hub's work" : "All hubs", v => set({ hubId: v }))}
            {sel("Intake", f.intake, [["PICKUP", "Rider pickup"], ["DROP_OFF", "Drop-off at hub"]], "Pickup and drop-off", v => set({ intake: v }))}
            {sel("SLA state", f.sla, [["AWAITING_REVIEW", "Awaiting review"], ["ON_TRACK", "On track"], ["AT_RISK", "At risk"], ["BREACHED", "Breached"]], "Any", v => set({ sla: v }))}
            <label className="field">
              <span>{f.dateField === "status" ? "Status updated from" : "Created from"}</span>
              <input className="input" type="date" value={f.from || ""} onChange={e => set({ from: e.target.value })} />
            </label>
            <label className="field">
              <span>{f.dateField === "status" ? "Status updated to" : "Created to"}</span>
              <input className="input" type="date" value={f.to || ""} onChange={e => set({ to: e.target.value })} />
            </label>
            <label className="check" style={{ alignSelf: "end", minHeight: 36 }}>
              <input type="checkbox" checked={!!f.incomplete} onChange={e => set({ incomplete: e.target.checked })} /> Needs info only
            </label>
          </div>
          <div className="row">
            <button type="button" className="button primary" onClick={run(bulkDownload)} aria-busy={busy || undefined} disabled={busy}>
              {`Download "${action.label}" file (.xlsx)`}
            </button>
            <span className="muted" role="status">
              {exportInfo}
            </span>
          </div>
        </section>
        <section className="stack">
          <h3 style={{ margin: 0, fontSize: 15 }}>3 · Upload the filled-in file</h3>
          <p className="muted" style={{ margin: 0 }}>
            Every row is checked first (lifecycle, hub, rider, details and whether the parcel changed since you downloaded it). Only a "{action.label}" file is accepted here. Nothing changes until you press Apply. Max {num(limits?.maxRows)} rows and {limits?.maxFileMb} MB.
          </p>
          {fileDrop}
        </section>
        {errorLine}
      </div>
    );
    foot = (
      <>
        <div className="row" style={{ marginRight: "auto" }}>
          <button type="button" className="button" onClick={run(() => actionStep())}>
            ‹ Change action
          </button>
          <button type="button" className="button" onClick={() => void openHistory()}>
            Bulk update history
          </button>
        </div>
        {cancel}
        <button type="button" className="button primary" disabled={!file || busy} aria-busy={busy || undefined} onClick={run(check)}>
          Check file
        </button>
      </>
    );
  } else if (step === "choose" && config && limits) {
    const columns = config.templates[cfg.kind || "ecommerce"].filter(c => c.inTemplate !== false && (!c.packageOnly || !pkg || pkg.options?.[c.packageOnly]));
    const required = columns.filter(c => c.required).map(c => c.header);
    // Optional unless a super admin made it required (Import Template settings).
    const phoneRequired = !!columns.find(c => c.key === "recipient_phone")?.required;
    const choose = needsMerchant && !merchantId;
    title = `Import ${noun} from Excel`;
    subtitle = `${KIND_LABEL[cfg.kind || ""] || cfg.kind} template${merchantId && needsMerchant ? ` · ${merchantsOf.find(m => m.id === merchantId)?.name || ""}` : ""} · the preview shows every row before anything is created.`;
    const hubs = cfg.forOps ? cfg.hubs || [] : pkg?.dropHubs || [];
    body = (
      <div className="stack">
        <div className="callout" style={{ display: "block", marginBottom: 0 }}>
          <strong>
            Max {num(limits.maxRows)} rows and {limits.maxFileMb} MB per file
          </strong>{" "}
          · {cfg.forOps ? "Excel (.xlsx) or CSV: our template or any merchant's own file (you match its columns next)." : "Excel (.xlsx) or CSV with the template's headers."}
          <br />
          Required columns: <strong>{required.join(", ") || "none"}</strong> (red headers with * in the template). Other columns may stay empty; a value you enter must be valid or the row is not created.
          <br />
          {phoneRequired ? "The recipient phone is required. Rows missing the recipient name, address or destination" : "Rows missing the recipient phone, name, address or destination"} are created as <strong>Needs info</strong>, priced with defaults and held before delivery until completed.
          <br />
          First mile, the drop-off hub, last mile and the messages are chosen here for the whole file{cfg.forOps ? (cfg.kind === "customer" ? " (Customer package); the sender and pickup are in each row" : " (the merchant's package)") : ""}.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          {cfg.forOps && (cfg.kinds?.length ?? 0) > 1 ? (
            <label className="field">
              <span>Category</span>
              <Select
                className="select"
                value={cfg.kind}
                onChange={e => {
                  const kind = e.target.value;
                  setCfg(c => ({ ...c, kind }));
                  setMerchantId("");
                  setLayout(null);
                  void loadPackage(kind, "");
                }}
              >
                {cfg.kinds!.map(k => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k] || k}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          {needsMerchant ? (
            <label className="field">
              <span>Merchant</span>
              <SearchSelect
                label="Merchant"
                placeholder={merchantsOf.length ? `Choose the merchant (${merchantsOf.length})` : "No active merchant in this category"}
                options={merchantsOf.map(m => ({ value: m.id, label: `${m.code ? `${m.code} · ` : ""}${m.name}` }))}
                value={merchantId}
                onChange={v => {
                  setMerchantId(v);
                  setLayout(null);
                  void loadPackage(cfg.kind, v);
                }}
              />
            </label>
          ) : null}
          {pkg && (pkg.options.firstMiles.length > 1 || cfg.forOps) ? (
            <label className="field">
              <span>First mile</span>
              <Select className="select" value={firstMile} onChange={e => setFirstMile(e.target.value)}>
                {pkg.options.firstMiles.map(f => (
                  <option key={f} value={f}>
                    {FIRST_MILE[f]?.[1] || f}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          {pkg?.options.firstMiles.includes("HUB_DROP") ? (
            <label className="field">
              <span>Drop-off hub</span>
              <Select className="select" value={hubId} disabled={firstMile !== "HUB_DROP"} onChange={e => setHubId(e.target.value)}>
                {!cfg.forOps || !hubId ? <option value="">Choose the hub</option> : null}
                {hubs.map(h => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          {pkg && pkg.options.lastMiles.length > 1 ? (
            <label className="field">
              <span>Last mile</span>
              <Select className="select" value={lastMile} onChange={e => setLastMile(e.target.value)}>
                {pkg.options.lastMiles.map(l => (
                  <option key={l} value={l}>
                    {LAST_MILE[l] || l}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          {pkg && (pkg.options.speeds?.length ?? 0) > 0 ? (
            <label className="field">
              <span>Delivery type</span>
              <Select className="select" value={speed} onChange={e => setSpeed(e.target.value)}>
                {pkg.options.speeds!.map(v => (
                  <option key={v} value={v}>
                    {typeName(v)}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          {pkg?.categories?.length && !config?.ai ? (
            <label className="field">
              <span>Category</span>
              <Select className="select" value={category} onChange={e => setCategory(e.target.value)}>
                <option value="">From the file / product</option>
                {pkg.categories.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          {pkg?.priorities?.length ? (
            <label className="field">
              <span>Priority</span>
              <Select className="select" value={priority} onChange={e => setPriority(e.target.value)}>
                {pkg.priorities.map(x => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          {pkg && cfg.kind !== "document" ? (
            <label className="field">
              <span>Product type</span>
              <Select className="select" value={productType} onChange={e => setProductType(e.target.value)}>
                <option value="">From the file</option>
                {PRODUCT_TYPE.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
        </div>
        {choose ? <p className="muted" style={{ margin: 0 }}>Choose the merchant: the template's services, the choices above and the checks follow its package.</p> : null}
        {(() => {
          const chosen = [
            speed ? `delivery type ${typeName(speed)}` : "",
            productType && cfg.kind !== "document" ? `product type ${PRODUCT_TYPE.find(([v]) => v === productType)?.[1]}` : "",
            category && !config?.ai ? `category ${pkg?.categories?.find(c => c.id === category)?.name}` : "",
            priority ? `priority ${pkg?.priorities?.find(x => x.id === priority)?.name}` : "",
          ].filter(Boolean);
          return chosen.length ? (
            <p className="muted" style={{ margin: 0 }}>
              {`${chosen.join(", ").replace(/^./, c => c.toUpperCase())}: for every row (the price follows the delivery and product type).`}
            </p>
          ) : null;
        })()}
        {pkg && lastMile === "HUB_COLLECT" ? <p className="muted" style={{ margin: 0 }}>Hub Pickup: each order waits at the hub serving its recipient's zone; the recipient gets an SMS with the hub address and a collection code.</p> : null}
        {pkg?.notifications?.length ? (
          <fieldset style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px", margin: 0 }}>
            <legend style={{ fontWeight: 600, fontSize: 13, padding: "0 4px" }}>{`Messages to send for these ${noun} (${notifications.size} of ${pkg.notifications.length})`}</legend>
            <div className="row" style={{ gap: 6, marginBottom: 8 }}>
              <button
                type="button"
                className="button sm"
                disabled={notifications.size === pkg.notifications.length}
                onClick={() => {
                  unticked.current.clear();
                  setNotifications(new Set(pkg.notifications.map(n => n.code)));
                }}
              >
                Select all
              </button>
              <button
                type="button"
                className="button sm"
                disabled={notifications.size === 0}
                onClick={() => {
                  pkg.notifications.forEach(n => unticked.current.add(n.code));
                  setNotifications(new Set());
                }}
              >
                Unselect all
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: "6px 12px" }}>
              {pkg.notifications.map(n => (
                <label key={n.code} className="check">
                  <input
                    type="checkbox"
                    checked={notifications.has(n.code)}
                    onChange={e => {
                      const next = new Set(notifications);
                      if (e.target.checked) (next.add(n.code), unticked.current.delete(n.code));
                      else (next.delete(n.code), unticked.current.add(n.code));
                      setNotifications(next);
                    }}
                  />
                  {n.title}
                </label>
              ))}
            </div>
            <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
              Rows whose product doesn't send messages are booked without any.
            </p>
          </fieldset>
        ) : null}
        {fileDrop}
        {errorLine}
      </div>
    );
    foot = (
      <>
        <div className="row" style={{ marginRight: "auto" }}>
          <button
            type="button"
            className="button"
            onClick={run(async () => {
              if (needsMerchant && !merchantId && !cfg.merchantId) return setMessage("Choose the merchant first: the template's services follow its package.");
              await downloadTemplate(cfg.kind || "ecommerce", cfg.merchantId || (needsMerchant ? merchantId : "") || undefined);
            })}
          >
            Download template (.xlsx)
          </button>
          <button type="button" className="button" onClick={() => void openHistory()}>
            Import history
          </button>
        </div>
        {cancel}
        <button type="button" className="button primary" disabled={!file || choose || busy} aria-busy={busy || undefined} onClick={run(check)}>
          Check file
        </button>
      </>
    );
  } else if (step === "analyzing" || step === "checking") {
    title = step === "analyzing" ? `Reading ${file?.name}` : `Checking ${file?.name}`;
    subtitle = step === "analyzing" ? "Finding the header row and which column is which…" : `Reading the file and checking every row. Nothing ${bulk ? "changes" : "is created"} yet.`;
    body = (
      <div style={{ display: "grid", placeItems: "center", padding: 28, gap: 10 }}>
        <div className="spinner" />
        <p className="muted">{step === "analyzing" ? "Reading the file…" : "Checking rows…"}</p>
      </div>
    );
    foot = cancel;
  } else if (step === "map" && layout) {
    title = `Match the columns of ${file?.name}`;
    subtitle = `${KIND_LABEL[cfg.kind || ""] || cfg.kind}${merchantId && needsMerchant ? ` · ${merchantsOf.find(m => m.id === merchantId)?.name || ""}` : ""} · any merchant's Excel or CSV. Nothing is created yet.`;
    const BY: Record<string, string> = { saved: "as last time", header: "by its name", data: "by its data" };
    body = (
      <div className="stack">
        <div className="callout" style={{ display: "block", marginBottom: 0 }}>
          <strong>{`${num(layout.orders)} order${layout.orders === 1 ? "" : "s"}`}</strong> found{layout.extraLines ? ` · ${num(layout.extraLines)} other line${layout.extraLines === 1 ? "" : "s"} (titles, totals, notes) will be skipped` : ""}.{" "}
          {layout.remembered ? "Matched as this merchant's last file with the same columns." : "Check each column's field; change any that is wrong, or ignore columns you don't need."} Columns set to <strong>Add to delivery address</strong> (e.g. a separate City or Thana) are added to the address; district, zone and area are found from it.
        </div>
        <label className="field">
          <span>Header row</span>
          <Select className="select" value={layout.headerRow} onChange={e => void analyze(Number(e.target.value))}>
            <option value={0}>No header row (data from row 1)</option>
            {layout.top
              .filter(t => t.text)
              .map(t => (
                <option key={t.row} value={t.row}>{`Row ${t.row}: ${t.text.slice(0, 90)}`}</option>
              ))}
          </Select>
        </label>
        <div className="table-wrap" style={{ maxHeight: "50vh" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Column in the file</th>
                <th>Values</th>
                <th>Field</th>
              </tr>
            </thead>
            <tbody>
              {layout.columns.map(c => (
                <tr key={c.index}>
                  <td className="strong nowrap">{`${c.letter}${c.header ? ` · ${c.header}` : ""}`}</td>
                  <td style={{ maxWidth: 340 }}>
                    {c.samples.length ? (
                      c.samples.map((v, i) => (
                        <span key={i} className="muted" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {v}
                        </span>
                      ))
                    ) : (
                      <span className="faint">empty</span>
                    )}
                  </td>
                  <td>
                    <Select
                      className="select sm"
                      aria-label={`Field for column ${c.letter}`}
                      value={c.key || ""}
                      style={{ minWidth: 210, color: c.key ? undefined : "var(--faint)" }}
                      onChange={e => {
                        const key = e.target.value || null;
                        setLayout(l => l && { ...l, columns: l.columns.map(x => (x.index === c.index ? { ...x, key, by: key !== x.key ? null : x.by } : x)) });
                      }}
                    >
                      <option value="">Ignore this column</option>
                      {layout.fields.map(f => (
                        <option key={f.key} value={f.key}>
                          {`${f.header}${f.required ? " *" : ""}`}
                        </option>
                      ))}
                    </Select>
                    {c.key && c.by ? <small style={{ display: "block", marginTop: 3, color: "var(--good)" }}>Matched {BY[c.by] || ""}</small> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {errorLine}
      </div>
    );
    foot = (
      <>
        <button type="button" className="button" onClick={() => setStep("choose")}>
          Back
        </button>
        <button type="button" className="button primary" disabled={busy} aria-busy={busy || undefined} onClick={run(check)}>
          Check file
        </button>
      </>
    );
  } else if ((step === "preview" || step === "result") && job && rows) {
    const c = job.counts;
    const r = job.result;
    const failed = job.status === "FAILED";
    const filterBar = (list: [string, string, number | undefined][]) => (
      <div className="row" role="group" aria-label="Filter rows" style={{ margin: "12px 0" }}>
        {list.map(([value, label, n]) => (
          <button key={value} type="button" className={`button sm ${filter === value ? "primary" : ""}`} aria-pressed={filter === value} onClick={run(() => loadRows(value, 1))}>
            {label}
            {n === undefined ? "" : ` (${num(n)})`}
          </button>
        ))}
      </div>
    );
    const pager = (
      <div className="row" style={{ marginTop: 10, fontSize: 13 }}>
        <button type="button" className="button sm" disabled={rows.page <= 1} onClick={run(() => loadRows(filter, rows.page - 1))}>
          ‹ Previous
        </button>
        <span>{`Page ${num(rows.page)} of ${num(rows.pages)} · ${num(rows.total)} row${rows.total === 1 ? "" : "s"}`}</span>
        <button type="button" className="button sm" disabled={rows.page >= rows.pages} onClick={run(() => loadRows(filter, rows.page + 1))}>
          Next ›
        </button>
        <label className="row" style={{ marginLeft: "auto", gap: 6 }}>
          Go to page
          <input
            className="input sm"
            type="number"
            min={1}
            max={rows.pages}
            defaultValue={rows.page}
            style={{ width: 80 }}
            onKeyDown={e => {
              if (e.key !== "Enter") return;
              const n = Math.round(Number(e.currentTarget.value));
              if (!n || n < 1 || n > rows.pages) return toast(`Choose a page from 1 to ${rows.pages}.`);
              void run(() => loadRows(filter, n))();
            }}
          />
        </label>
      </div>
    );
    const summary = (items: [string, Tone][]) => (
      <div className="row" style={{ gap: 8 }}>
        {items.map(([t, k]) => (
          <span key={t}>{pill(t, k)}</span>
        ))}
      </div>
    );
    const table = bulk ? <BulkRowsTable job={job} rows={rows} statuses={rowStatus} /> : <ImportRowsTable job={job} rows={rows} statuses={rowStatus} catalog={step === "preview" && job.status === "VALIDATED" ? catalog : null} onSaved={(row, j) => (setJob(x => x && { ...x, ...j }), setRows(x => x && { ...x, items: x.items.map(i => (i.rowNumber === row.rowNumber ? row : i)) }))} />;
    if (step === "preview") {
      if (bulk) {
        title = `Preview · ${job.fileName || "upload"}`;
        subtitle = `${job.number} · ${job.title || job.kindTitle || ""} · nothing changes until you apply.`;
        const notes = [
          c.ignored ? `${num(c.ignored)} row${c.ignored === 1 ? "" : "s"} with nothing filled in ${c.ignored === 1 ? "was" : "were"} skipped.` : "",
          job.ignoredColumns?.length ? `Ignored columns (not in the download): ${job.ignoredColumns.join(", ")}.` : "",
          c.errors ? "Rows with errors are skipped: fix them in your file and upload it again, or download them with the reason for each." : "",
          c.warnings ? "Rows with warnings are applied; check them first." : "",
        ].filter(Boolean);
        const p = job.pricing;
        body = (
          <>
            {summary([
              [`${num(c.rows)} row${c.rows === 1 ? "" : "s"} checked`, "info"],
              [`${num(c.toApply)} will apply`, "good"],
              [`${num(c.warnings)} with warnings`, "warn"],
              [`${num(c.errors)} with errors`, "bad"],
              [`${num(c.alreadyDone)} already done`, "info"],
              ...(p?.rows ? ([[`Re-priced: ${taka(p.before)} → ${taka(p.after)} (${p.difference > 0 ? "+" : p.difference < 0 ? "−" : "±"}${taka(Math.abs(p.difference))}) on ${num(p.rows)} row${p.rows === 1 ? "" : "s"}`, p.difference > 0 ? "warn" : "info"]] as [string, Tone][]) : []),
            ])}
            {notes.length ? <p className="muted" style={{ margin: "10px 0 0" }}>{notes.join(" ")}</p> : null}
            {filterBar([
              ["all", "All", c.rows],
              ["apply", "Will apply", c.toApply],
              ["warning", "Warnings", c.warnings],
              ["error", "Errors", c.errors],
              ...(c.alreadyDone ? ([["already_done", "Already done", c.alreadyDone]] as [string, string, number][]) : []),
            ])}
            {table}
            {pager}
            {c.toApply && cfg.applyExtra ? cfg.applyExtra.render() : null}
          </>
        );
      } else {
        title = `Preview · ${job.fileName || "upload"}`;
        const s = job.services || {};
        const where = [
          job.intake === "DROP_OFF" ? ` · drop-off at ${job.dropOffHub?.name || "hub"}` : s.firstMileLabel ? ` · ${s.firstMileLabel.toLowerCase()}` : cfg.forOps ? " · rider pickup" : "",
          s.lastMileLabel ? ` · ${s.lastMileLabel.toLowerCase()}` : "",
          s.speedLabel ? ` · delivery type ${s.speedLabel} (every row)` : "",
          s.productTypeLabel ? ` · product type ${s.productTypeLabel} (every row)` : "",
          s.categoryLabel ? ` · category ${s.categoryLabel} (every row)` : "",
          s.priorityLabel ? ` · priority ${s.priorityLabel}` : "",
          s.notifications ? ` · ${s.notifications.length} message${s.notifications.length === 1 ? "" : "s"}` : "",
        ].join("");
        subtitle = `${job.number}${where} · nothing is created until you confirm.`;
        const toBook = c.valid + c.incomplete;
        const notes = [
          job.ignoredColumns?.length ? `Ignored columns (${cfg.forOps ? "not matched to a field" : "not in the template"}): ${job.ignoredColumns.join(", ")}.` : "",
          job.skippedLines?.count
            ? `${num(job.skippedLines.count)} line${job.skippedLines.count === 1 ? "" : "s"} that ${job.skippedLines.count === 1 ? "isn't an order was" : "aren't orders were"} skipped (row${job.skippedLines.count === 1 ? "" : "s"} ${job.skippedLines.rows.slice(0, 12).join(", ")}${job.skippedLines.count > 12 ? ", …" : ""}).`
            : "",
          c.errors ? "Rows with errors are skipped: correct the address and places below, or fix them in your file and upload it again (download them with the reason for each)." : "",
          catalog && job.status === "VALIDATED" ? "District, zone and area left out of the file are picked from the address (green). Change any address or place below: the row is checked and priced again." : "",
        ].filter(Boolean);
        body = (
          <>
            {summary([
              [`${num(c.rows)} rows`, "info"],
              [`${num(c.valid)} valid`, "good"],
              [`${num(c.incomplete)} needs info`, "warn"],
              [`${num(c.errors)} with errors`, "bad"],
              ...(job.totals && toBook ? ([[`Total ৳${Number(job.totals.charge).toLocaleString("en-BD")} for ${count(toBook)}`, "info"]] as [string, Tone][]) : []),
            ])}
            {notes.length ? <p className="muted" style={{ margin: "10px 0 0" }}>{notes.join(" ")}</p> : null}
            {filterBar([
              ["all", "All", c.rows],
              ["valid", "Valid", c.valid],
              ["incomplete", "Needs info", c.incomplete],
              ["error", "Errors", c.errors],
            ])}
            {table}
            {pager}
          </>
        );
      }
      const toDo = bulk ? c.toApply : c.valid + c.incomplete;
      foot = (
        <>
          <div className="row" style={{ marginRight: "auto" }}>
            <button
              type="button"
              className="button"
              onClick={() => {
                if (job.status === "VALIDATED") void api(`${base}/${job.id}`, { method: "DELETE" }).catch(() => undefined);
                setJob(null);
                setFile(null);
                setStep("choose");
              }}
            >
              Back · choose another file
            </button>
            {c.errors ? (
              <button type="button" className="button" onClick={run(() => downloadFailed())}>
                Download rows with errors (.xlsx)
              </button>
            ) : null}
          </div>
          <button type="button" className="button primary" disabled={!toDo || busy} aria-busy={busy || undefined} onClick={run(commit)}>
            {bulk ? (toDo ? `Apply ${num(toDo)} row${toDo === 1 ? "" : "s"}` : "Nothing to apply") : toDo ? `Create ${count(toDo)}` : "Nothing to create"}
          </button>
        </>
      );
    } else {
      const rowsAvailable = job.rowsAvailable !== false;
      title = bulk ? (failed ? `Bulk update ${job.number} stopped` : `Bulk update ${job.number} finished`) : failed ? `Import ${job.number} stopped` : `Import ${job.number} finished`;
      subtitle = bulk ? [job.title || job.kindTitle, job.fileName].filter(Boolean).join(" · ") : `${job.fileName || ""}${job.batch ? ` · batch ${job.batch.number}` : ""}${job.intake === "DROP_OFF" ? ` · drop-off at ${job.dropOffHub?.name || "hub"}` : ""}`;
      body = (
        <>
          {failed ? (
            <p role="alert" className="form-error" style={{ marginTop: 0 }}>
              {job.error || (bulk ? "The bulk update stopped." : "The import stopped.")}
            </p>
          ) : bulk ? (
            <p style={{ margin: "0 0 10px", fontSize: 14 }}>
              <strong>{num(r.applied)}</strong> row{r.applied === 1 ? "" : "s"} applied, <strong>{num(r.alreadyDone)}</strong> already done (skipped), <strong>{num(r.notApplied)}</strong> not applied.
            </p>
          ) : (
            <p style={{ margin: "0 0 10px", fontSize: 14 }}>
              <strong>{num(r.created)}</strong> {nounFor(r.created)} created
              {r.createdIncomplete ? (
                <>
                  , <strong>{num(r.createdIncomplete)}</strong> marked “Needs info”
                </>
              ) : null}
              . <strong>{num(r.notCreated)}</strong> row{r.notCreated === 1 ? "" : "s"} not created.
            </p>
          )}
          {bulk && cfg.resultExtra ? cfg.resultExtra(job) : null}
          {bulk
            ? summary([
                [`${num(r.applied)} applied`, "good"],
                [`${num(r.alreadyDone)} already done`, "info"],
                [`${num(r.notApplied)} not applied`, r.notApplied ? "bad" : "info"],
              ])
            : summary([
                [`${num(r.created)} created`, "good"],
                [`${num(r.createdIncomplete)} of them need info`, "warn"],
                [`${num(r.notCreated)} not created`, r.notCreated ? "bad" : "info"],
              ])}
          {rowsAvailable ? (
            <>
              {filterBar(
                bulk
                  ? [
                      ["all", "All", c.rows],
                      ["applied", "Applied", r.applied],
                      ["already_done", "Already done", r.alreadyDone],
                      ["not_applied", "Not applied", r.notApplied],
                    ]
                  : [
                      ["all", "All", c.rows],
                      ["created", "Created", r.created],
                      ["not_created", "Not created", r.notCreated],
                    ],
              )}
              {table}
              {pager}
            </>
          ) : (
            <p className="muted">The rows of this {bulk ? "bulk update" : "import"} are no longer kept.</p>
          )}
        </>
      );
      const notDone = bulk ? r.notApplied : r.notCreated;
      foot = (
        <>
          <div className="row" style={{ marginRight: "auto" }}>
            {notDone && rowsAvailable ? (
              <button type="button" className="button" onClick={run(() => downloadFailed())}>
                {bulk ? "Download rows not applied (.xlsx)" : "Download rows not created (.xlsx)"}
              </button>
            ) : null}
            {!bulk && r.created && cfg.forOps && job ? (
              <PrintImport jobId={job.id} number={job.number} kind={job.kind} />
            ) : !bulk && r.created && cfg.printLabels ? (
              <button type="button" className="button" onClick={run(() => labels())}>
                {`Print labels (${num(r.created)})`}
              </button>
            ) : null}
            <button type="button" className="button" onClick={() => void openHistory()}>
              {bulk ? "Bulk update history" : "Import history"}
            </button>
          </div>
          <button type="button" className="button primary" onClick={finishClose}>
            Done
          </button>
        </>
      );
    }
  } else if (step === "booking" && job) {
    const p = job.progress;
    title = bulk ? `Applying changes · ${job.number}` : `Creating ${noun} · ${job.number}`;
    subtitle = `This runs on the server: you can close this window and follow it in the ${bulk ? "bulk update" : "import"} history.`;
    body = (
      <div className="stack" style={{ padding: "10px 0" }}>
        <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.percent} style={{ height: 12, background: "var(--surface-3)", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${p.percent}%`, background: "var(--primary)", transition: "width .4s" }} />
        </div>
        <p className="muted" style={{ margin: 0 }}>{`${num(p.processed)} of ${num(p.total)} rows processed (${p.percent}%)`}</p>
      </div>
    );
    foot = (
      <button type="button" className="button" onClick={finishClose}>
        Close · keep running
      </button>
    );
  } else if (step === "history") {
    title = bulk ? "Bulk update history" : "Import history";
    const items = history || [];
    subtitle = !history
      ? "Loading…"
      : bulk
        ? `${items.length ? `The last ${num(items.length)} bulk update${items.length === 1 ? "" : "s"}` : "No bulk updates yet"} · each has its own number, recorded on every change in the audit log.`
        : `${items.length ? `Your last ${num(items.length)} import${items.length === 1 ? "" : "s"}` : "No imports yet"} · each import is a booking batch with its own number.`;
    const statuses = bulk ? BULK_JOB_STATUS : JOB_STATUS;
    const actionOptions = [...new Map((historyKind ? kinds.filter(k => k.kind === historyKind) : kinds).flatMap(k => k.actions).map(a => [a.action, a.label])).entries()];
    body = (
      <>
        {bulk ? (
          <div className="row" style={{ gap: 16, marginBottom: 10 }}>
            <label className="row" style={{ gap: 8, fontWeight: 600, fontSize: 13 }}>
              Page
              <Select className="select sm" value={historyKind || ""} onChange={e => void openHistory(e.target.value, historyAction)}>
                <option value="">Every page</option>
                {kinds.map(k => (
                  <option key={k.kind} value={k.kind}>
                    {k.title}
                  </option>
                ))}
              </Select>
            </label>
            <label className="row" style={{ gap: 8, fontWeight: 600, fontSize: 13 }}>
              Action
              <Select className="select sm" value={historyAction} onChange={e => (setHistoryAction(e.target.value), void openHistory(historyKind, e.target.value))}>
                <option value="">Every action</option>
                {actionOptions.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        ) : null}
        <div className="table-wrap" style={{ maxHeight: "60vh" }}>
          <table className="table">
            <thead>
              <tr>
                <th>{bulk ? "Bulk update" : "Import"}</th>
                {bulk ? <th>Action · page</th> : null}
                <th>Uploaded</th>
                {!bulk ? <th>Merchant</th> : null}
                <th className="num">Rows</th>
                <th className="num">{bulk ? "Applied" : "Created"}</th>
                <th className="num">{bulk ? "Already done" : "Needs info"}</th>
                <th className="num">{bulk ? "Not applied" : "Not created"}</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.length ? (
                items.map(j => {
                  const [label, t] = statuses[j.status] || [j.status, "info" as Tone];
                  const done = j.status === "COMPLETED";
                  return (
                    <tr key={j.id}>
                      <td>
                        <span className="strong">{j.number}</span>
                        <span className="sub">{[!bulk && (initial.kinds?.length ?? 0) > 1 ? KIND_LABEL[j.kind || ""] || j.kind : "", j.fileName].filter(Boolean).join(" · ")}</span>
                      </td>
                      {bulk ? <td>{j.title || j.kindTitle || ""}</td> : null}
                      <td>
                        {when(j.createdAt)}
                        <span className="sub">{j.createdBy || ""}</span>
                      </td>
                      {!bulk ? (
                        <td>
                          {j.merchant ? j.merchant.name : j.kind === "customer" ? "Customer parcels" : "—"}
                          {j.intake === "DROP_OFF" ? <span className="sub">{`Drop-off · ${j.dropOffHub?.name || ""}`}</span> : null}
                        </td>
                      ) : null}
                      <td className="num">{num(j.counts.rows)}</td>
                      <td className="num">{num(bulk ? j.result.applied : j.result.created)}</td>
                      <td className="num">{num(bulk ? j.result.alreadyDone : j.result.createdIncomplete)}</td>
                      <td className="num">{num(bulk ? (done ? j.result.notApplied : j.counts.errors) : j.status === "COMPLETED" ? j.result.notCreated : j.counts.errors)}</td>
                      <td>{pill(j.status === "PROCESSING" ? `${label} ${j.progress.percent}%` : label, t)}</td>
                      <td>
                        <div className="row-actions">
                          {j.status !== "VALIDATED" ? (
                            <button type="button" className="button sm" onClick={run(() => view(j.id))}>
                              View
                            </button>
                          ) : null}
                          {j.downloads?.failedRows ? (
                            <button type="button" className="button sm" onClick={run(() => download(`${base}/${j.id}/failed-rows`))}>
                              {bulk ? "Not applied (.xlsx)" : "Not created (.xlsx)"}
                            </button>
                          ) : null}
                          {!bulk && j.result.created && cfg.forOps ? (
                            <PrintImport jobId={j.id} number={j.number} kind={j.kind} size="sm" />
                          ) : !bulk && j.result.created && cfg.printLabels ? (
                            <button type="button" className="button sm" onClick={run(() => labels(j))}>
                              Labels
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={10} className="empty">
                    {history ? (bulk ? "No bulk updates yet." : "No imports yet.") : "Loading…"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </>
    );
    foot = (
      <>
        <button
          type="button"
          className="button"
          onClick={async () => {
            if (bulk) {
              autoPicked.current = true;
              const k = kinds.length ? kinds : await api<KindDef[]>("/bulk-updates/kinds");
              if (!limits) setLimits(await api("/bulk-updates/limits"));
              setKinds(k);
              await actionStep(k);
            } else {
              if (!limits || !config) {
                const [l, c] = await Promise.all([api<{ maxRows: number; maxFileMb: number }>(qs("/imports/limits", { merchantId: cfg.merchantId })), api<typeof config>("/imports/config")]);
                setLimits(l);
                setConfig(c);
                await loadPackage();
              }
              setFile(null);
              setStep("choose");
            }
          }}
        >
          {bulk ? "New bulk update" : "New import"}
        </button>
        <button type="button" className="button primary" onClick={finishClose}>
          Close
        </button>
      </>
    );
  }

  return (
    <>
      <div className="dialog-head">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <button type="button" className="button ghost icon dialog-close" aria-label="Close" onClick={finishClose}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="dialog-body" style={{ maxHeight: "calc(100vh - 200px)" }}>
        {body}
      </div>
      <div className="dialog-foot">{foot}</div>
    </>
  );
}

/** "Choose file" drop zone: click or drop, name and size, clear. */
function FileDrop({ file, accept, maxMb, onFile }: { file: File | null; accept: string; maxMb?: number; onFile: (f: File | null) => void }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={e => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      style={{ border: `2px dashed ${over ? "var(--primary)" : "var(--line-strong)"}`, borderRadius: 12, padding: 18, textAlign: "center", background: over ? "var(--primary-soft)" : "var(--surface-2)" }}
    >
      <input ref={input} type="file" accept={accept} hidden aria-label="The filled-in file" onChange={e => (onFile(e.target.files?.[0] ?? null), (e.target.value = ""))} />
      {file ? (
        <div className="row" style={{ justifyContent: "center" }}>
          <strong>{file.name}</strong>
          <span className="muted">{`${(file.size / 1024).toFixed(file.size > 1048576 ? 0 : 1)} KB`}</span>
          <button type="button" className="button sm" onClick={() => onFile(null)} aria-label="Remove the file">
            <Icon name="x" size={14} />
          </button>
        </div>
      ) : (
        <>
          <button type="button" className="button" onClick={() => input.current?.click()}>
            Choose file
          </button>
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 12.5 }}>
            or drop it here · Excel (.xlsx) or CSV{maxMb ? ` · up to ${maxMb} MB` : ""}
          </p>
        </>
      )}
    </div>
  );
}

const PLACE_FAMILIES = [
  { address: "address", district: "district", zone: "zone", area: "area" },
  { address: "pickup_address", district: "pickup_district", zone: "pickup_zone", area: "pickup_area" },
];
const familyOf = (key: string) => PLACE_FAMILIES.find(f => Object.values(f).includes(key));

function ImportRowsTable({ job, rows, statuses, catalog, onSaved }: { job: Job; rows: Rows; statuses: Record<string, [string, Tone]>; catalog: Catalog | null; onSaved: (row: Row, job: Partial<Job>) => void }) {
  const present = new Set(rows.items.flatMap(r => Object.keys(r.cells || {})));
  const canEdit = !!catalog;
  const always = ["recipient_name", "recipient_phone", "address", "district", "zone", ...(canEdit ? ["area", "pickup_address", "pickup_district", "pickup_zone"] : [])];
  const shown = job.columns.filter(c => present.has(c.key) || c.required || always.includes(c.key));
  const missingCol: Record<string, string> = { recipientName: "recipient_name", recipientPhone: "recipient_phone", address: "address", district: "district", zone: "zone" };

  async function save(r: Row, key: string, value: string) {
    const f = familyOf(key)!;
    const cells: Record<string, string | null> = { [key]: value || null };
    let detect = false;
    if (key === f.address) detect = true;
    else if (key === f.district) Object.assign(cells, { [f.zone]: null, [f.area]: null });
    else if (key === f.zone) {
      const owner = Object.keys(catalog!.zonesByDistrict).find(d => catalog!.zonesByDistrict[d].includes(value));
      if (value && owner && owner !== r.cells?.[f.district]) cells[f.district] = owner;
      cells[f.area] = null;
    }
    const known = new Set(job.columns.map(c => c.key));
    for (const k of Object.keys(cells)) if (!known.has(k)) delete cells[k];
    try {
      const res = await api<{ row: Row; job: Partial<Job> }>(`/imports/${job.id}/rows/${r.rowNumber}`, { method: "PATCH", body: { cells, ...(detect ? { detect: true } : {}) } });
      onSaved(res.row, res.job);
    } catch (e) {
      toast(describe(e), "bad");
    }
  }

  return (
    <div className="table-wrap" style={{ maxHeight: "52vh", border: "1px solid var(--line)", borderRadius: 10 }}>
      <table className="table">
        <thead>
          <tr>
            <th>Row</th>
            <th>Status</th>
            {shown.map(c => (
              <th key={c.key} title={c.header}>
                {c.header}
                {c.required ? " *" : ""}
              </th>
            ))}
            <th>Charge</th>
            <th>Problems</th>
          </tr>
        </thead>
        <tbody>
          {rows.items.length ? (
            rows.items.map(r => {
              const [label, t] = statuses[r.status] || [r.status, "info" as Tone];
              const bad = new Map((r.errors || []).map(e => [e.column, e.message]));
              const missing = new Set((r.missing || []).map(m => missingCol[m]));
              const auto = new Set(r.autoFilled || []);
              return (
                <tr key={r.rowNumber} data-status={r.status}>
                  <td>{r.rowNumber}</td>
                  <td>
                    <span className={`pill ${t === "info" ? "" : t}`}>{label}</span>
                  </td>
                  {shown.map(c => {
                    const value = r.cells?.[c.key] ?? "";
                    const problem = bad.get(c.key) || (r.status === "INCOMPLETE" && missing.has(c.key) ? "needed before delivery" : "");
                    if (canEdit && familyOf(c.key)) return <EditCell key={c.key} r={r} c={c} value={value} problem={problem} auto={auto.has(c.key)} catalog={catalog!} onSave={v => save(r, c.key, v)} />;
                    if (bad.has(c.key))
                      return (
                        <td key={c.key} title={`${c.header}: ${bad.get(c.key)}`} style={{ background: "var(--bad-soft)", color: "var(--bad)", fontWeight: 600 }}>
                          {value || "—"}
                        </td>
                      );
                    if (r.status === "INCOMPLETE" && missing.has(c.key))
                      return (
                        <td key={c.key} title={`${c.header}: needed before delivery`} style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>
                          —
                        </td>
                      );
                    return <td key={c.key}>{value}</td>;
                  })}
                  <td className="nowrap">
                    {r.lines?.length ? (
                      <details>
                        <summary style={{ cursor: "pointer" }}>{taka(r.charge)}</summary>
                        <div style={{ fontSize: 11, lineHeight: 1.5, color: "var(--muted)", whiteSpace: "nowrap" }}>
                          {r.lines.map(l => (
                            <div key={l.label}>{`${l.label} · ${l.amount < 0 ? "−" : ""}৳${Math.abs(l.amount)}`}</div>
                          ))}
                        </div>
                      </details>
                    ) : (
                      taka(r.charge)
                    )}
                  </td>
                  <td style={{ minWidth: 260, fontSize: 12 }}>
                    {r.errors?.length ? r.errors.map((e, i) => <div key={i}>{e.text}</div>) : r.status === "INCOMPLETE" ? <span style={{ color: "var(--warn)" }}>{`Needs ${(r.missing || []).map(m => MISSING[m] || m).join(", ")} before delivery`}</span> : r.trackingId ? <span className="tracking">{r.trackingId}</span> : null}
                    {r.messagesOff && r.status !== "ERROR" ? <div className="muted">{r.messagesNote || "This product doesn't send messages"}</div> : null}
                  </td>
                </tr>
              );
            })
          ) : (
            <tr>
              <td colSpan={shown.length + 4} className="empty">
                No rows match this filter.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function EditCell({ r, c, value, problem, auto, catalog, onSave }: { r: Row; c: { key: string; header: string }; value: string; problem: string; auto: boolean; catalog: Catalog; onSave: (v: string) => Promise<void> }) {
  const f = familyOf(c.key)!;
  const [busy, setBusy] = useState(false);
  const style = { ...(problem ? { borderColor: "#f3b4ad", background: "var(--bad-soft)" } : auto ? { background: "var(--good-soft)" } : {}) };
  const title = problem ? `${c.header}: ${problem}` : auto ? `${c.header}: picked from the address (you can change it)` : c.header;
  const save = async (v: string) => {
    if (v === value) return;
    setBusy(true);
    await onSave(v.trim());
    setBusy(false);
  };
  if (c.key === f.address)
    return (
      <td>
        <input className="input sm" defaultValue={value} title={title} aria-label={`${c.header}, row ${r.rowNumber}`} disabled={busy} style={{ width: 230, ...style }} onBlur={e => void save(e.target.value)} onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()} />
      </td>
    );
  const cells = r.cells || {};
  let list: string[] = [];
  let empty = "Choose…";
  if (c.key === f.district) list = catalog.districts;
  else if (c.key === f.zone) {
    list = cells[f.district] ? catalog.zonesByDistrict[cells[f.district]] || [] : [...new Set(Object.values(catalog.zonesByDistrict).flat())].sort((a, b) => a.localeCompare(b));
    empty = cells[f.district] ? "Choose a zone" : "Choose a zone (any district)";
  } else {
    list = cells[f.zone] ? catalog.areasByZone[cells[f.zone]] || [] : [];
    empty = cells[f.zone] ? (list.length ? "Choose an area" : "No areas listed") : "Choose the zone first";
  }
  const unknown = value && !list.includes(value);
  return (
    <td>
      <Select className="select sm" value={value} title={title} aria-label={`${c.header}, row ${r.rowNumber}`} disabled={busy} style={{ width: 150, ...style }} onChange={e => void save(e.target.value)}>
        <option value="">{empty}</option>
        {unknown ? <option value={value}>{`${value} (not in the list)`}</option> : null}
        {list.map(o => (
          <option key={o}>{o}</option>
        ))}
      </Select>
    </td>
  );
}

function BulkRowsTable({ job, rows, statuses }: { job: Job; rows: Rows; statuses: Record<string, [string, Tone]> }) {
  const header = new Map(job.columns.map(c => [c.key, c.header]));
  const keys = new Set(["tracking_id", "status", ...job.columns.filter(c => c.editable && !c.key.startsWith("set_") && c.key !== "priority").map(c => c.key)]);
  for (const r of rows.items) {
    for (const k of Object.keys(r.cells || {})) if (k.startsWith("set_") || k === "priority") keys.add(k);
    for (const e of [...r.errors, ...r.warnings]) if (header.has(e.column)) keys.add(e.column);
  }
  const shown = job.columns.filter(c => keys.has(c.key));
  const priced = rows.items.some(r => r.plan?.price);
  return (
    <div className="table-wrap" style={{ maxHeight: "52vh", border: "1px solid var(--line)", borderRadius: 10 }}>
      <table className="table">
        <thead>
          <tr>
            <th>Row</th>
            <th>Status</th>
            {shown.map(c => (
              <th key={c.key} title={c.header}>
                {c.header}
              </th>
            ))}
            {priced ? <th title="Delivery charge now → after this change">Price</th> : null}
            <th>Problems / result</th>
          </tr>
        </thead>
        <tbody>
          {rows.items.length ? (
            rows.items.map(r => {
              const [label, t] = statuses[r.status] || [r.status, "info" as Tone];
              const bad = new Map(r.errors.map(e => [e.column, e.message]));
              const warned = new Map(r.warnings.map(e => [e.column, e.message]));
              const p = r.plan?.price;
              return (
                <tr key={r.rowNumber} data-status={r.status}>
                  <td>{r.rowNumber}</td>
                  <td>
                    <span className={`pill ${t === "info" ? "" : t}`}>{label}</span>
                  </td>
                  {shown.map(c => {
                    let value = r.cells?.[c.key] ?? "";
                    if (c.key === "rider" && !value && r.plan?.usedSuggestion) value = `${r.cells?.suggested_rider || ""} (suggested)`;
                    if (bad.has(c.key))
                      return (
                        <td key={c.key} title={`${c.header}: ${bad.get(c.key)}`} style={{ background: "var(--bad-soft)", color: "var(--bad)", fontWeight: 600 }}>
                          {value || "—"}
                        </td>
                      );
                    if (warned.has(c.key))
                      return (
                        <td key={c.key} title={`${c.header}: ${warned.get(c.key)}`} style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>
                          {value || "—"}
                        </td>
                      );
                    return (
                      <td key={c.key} className={c.key === "tracking_id" ? "tracking" : undefined}>
                        {value}
                      </td>
                    );
                  })}
                  {priced ? (
                    <td className="nowrap">
                      {p ? (
                        <>
                          {taka(p.before)} → <strong>{taka(p.after)}</strong>{" "}
                          {p.difference ? <span style={{ color: p.difference > 0 ? "var(--bad)" : "var(--good)", fontWeight: 600 }}>{`(${p.difference > 0 ? "+" : "−"}${taka(Math.abs(p.difference))})`}</span> : <span className="muted">(no change)</span>}
                        </>
                      ) : null}
                    </td>
                  ) : null}
                  <td style={{ minWidth: 280, fontSize: 12 }}>
                    {r.errors.map((e, i) => (
                      <div key={`e${i}`}>{e.text}</div>
                    ))}
                    {r.warnings.map((e, i) => (
                      <div key={`w${i}`} style={{ color: "var(--warn)" }}>
                        {e.text}
                      </div>
                    ))}
                    {r.result ? <div style={{ color: r.status === "APPLIED" ? "var(--good)" : "var(--ink-2)" }}>{r.result}</div> : null}
                  </td>
                </tr>
              );
            })
          ) : (
            <tr>
              <td colSpan={shown.length + 3 + (priced ? 1 : 0)} className="empty">
                No rows match this filter.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Operations: "Print…" for an import's parcels, with every format of the parcel lists' Print menu (invoices A4 / 4 / 8
 * per page / POS, shipment labels, the shipment list), the import's own parcels in each (GET /imports/:id/tracking-ids).
 */
function PrintImport({ jobId, number, kind, size = "md" }: { jobId: string; number?: string; kind?: string; size?: "sm" | "md" }) {
  const [busy, setBusy] = useState(false);
  const line = kind === "ecommerce" ? "ECOMMERCE" : kind === "document" ? "BANKING_FINANCIAL" : kind === "customer" ? "CUSTOMER" : undefined;
  return (
    <Select
      className={`select${size === "sm" ? " sm" : ""}`}
      searchable={false}
      icon="print"
      aria-label="Print this import's parcels"
      title="Invoices, labels or the shipment list of the parcels this import created"
      value=""
      disabled={busy}
      style={{ width: size === "sm" ? 110 : 130, fontWeight: 600 }}
      onChange={async e => {
        const format = e.target.value;
        if (!format) return;
        setBusy(true);
        try {
          const { trackingIds } = await api<{ trackingIds: string[] }>(`/imports/${jobId}/tracking-ids`);
          if (!trackingIds.length) return void toast("This import didn't create any parcels.");
          await printFormat(format, trackingIds, `Import ${number || ""}`.trim());
        } catch (err) {
          toast(describe(err), "bad");
        } finally {
          setBusy(false);
        }
      }}
    >
      <option value="" hidden>
        {busy ? "Preparing…" : "Print…"}
      </option>
      {PRINT_FORMATS.map(f => (
        <option key={f.value} value={f.value} disabled={!!f.line && !!line && f.line !== line}>
          {f.label}
        </option>
      ))}
    </Select>
  );
}
