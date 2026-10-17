import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  bdPhoneProblem,
  normalizeBdPhone,
  packageOptions,
  parseSpeedOption,
  SPEED_LABEL,
  SPEED_OPTIONS,
  SPEED_SERVICE,
  SPEED_SERVICE_LEVEL,
  SERVICE_BY_CODE,
  type FirstMile,
  type LastMile,
  type PackageSegment,
  type PriceLine,
  type ProductType,
  type SpeedOption,
} from "@delivery-fast/shared";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AppError } from "../../common/errors";
import type { MerchantType, ParcelProduct, Segment } from "../../generated/prisma/client";
import { PricingService, type Catalog } from "../pricing/pricing.service";
import type { BookingInput } from "../parcels/parcels.service";
import type { MissingField } from "../parcels/incomplete";
import { resolvePlace, zoneForArea } from "../parcels/places";
import { PLATFORM_CONFIG_KEY } from "../admin/platform-config.service";
import { PackagesService, type HubRef, type PackageQuote } from "../packages/packages.service";
import type { PackageView } from "../packages/package-resolver";
import { columnsFor, type ColumnDef, type ColumnKey, type ImportKindKey, type ListKey, type PackageColumnOptions } from "./columns";
import type { ImportSettings } from "./import-config.service";

export type Cells = Partial<Record<ColumnKey | "__cod", string>>;
export interface CellError {
  column: string;
  message: string;
}
export type RowStatus = "VALID" | "INCOMPLETE" | "ERROR";

export interface MerchantInfo {
  id: string;
  code: string;
  name: string;
  type: MerchantType;
  status: string;
  contactPhone: string;
  pickupAddress: string;
  pickupArea: string;
  pickupDistrict: string;
  pickupZone: string;
  segment: Segment;
}

/** The import modal's choices for the whole file (service packages): first / last mile, drop hub, notifications. */
export interface ImportServiceOptions {
  firstMile?: FirstMile | null;
  lastMile?: LastMile | null;
  dropHubId?: string | null;
  /** Parcel notifications to send; omitted = every one in the package. */
  notifications?: string[] | null;
}

export interface RowResult {
  rowNumber: number;
  cells: Cells;
  status: RowStatus;
  errors: CellError[];
  missing: MissingField[];
  merchantId: string | null;
  /** Order ref, or "h:<hash>" of the normalised row when it has none. */
  dedupeKey: string | null;
  charge: number | null;
  /** The price breakdown (service packages). */
  lines?: PriceLine[];
  /** The booking (rows without errors). */
  booking?: BookingInput;
  /** Where an incomplete row is priced to. */
  destination?: { district: string; zone: string };
  /** Priced and checked against the merchant's package. */
  quote?: PackageQuote;
  product?: { id: string; name: string; type: string; mutedNotifications: string[] } | null;
}

export interface EngineContext {
  kind: ImportKindKey;
  forOps: boolean;
  settings: ImportSettings;
  columns: ColumnDef[];
  lists: Record<ListKey, string[]>;
  catalog: Catalog;
  fileMerchant: MerchantInfo | null;
  /** Operations: every merchant of the template's type, by code, name and "code · name" (lower case). */
  merchants: Map<string, MerchantInfo>;
  services: ImportServiceOptions;
  /** The file merchant's package (null: operations file with a Merchant column). */
  pkg: PackageView | null;
  products: ParcelProduct[];
  /** Per-file caches: packages by merchant, hubs by place, hub groups. */
  memo: { packages: Map<string, PackageView>; hubs: Map<string, HubRef | null>; groups: Map<string, string | null> };
}

const PARCEL_TYPES: Record<string, "ECOMMERCE" | "FRAGILE" | "PARCEL" | "DOCUMENT"> = {
  "e-commerce parcel": "ECOMMERCE",
  "ecommerce parcel": "ECOMMERCE",
  "e-commerce": "ECOMMERCE",
  ecommerce: "ECOMMERCE",
  "fragile parcel": "FRAGILE",
  fragile: "FRAGILE",
  "domestic parcel": "PARCEL",
  parcel: "PARCEL",
  document: "DOCUMENT",
  "document delivery": "DOCUMENT",
  documents: "DOCUMENT",
};
const PARCEL_TYPE_LABELS = ["E-commerce parcel", "Fragile parcel", "Domestic parcel", "Document"];
const ADDRESS_TYPES: Record<string, "HOME" | "OFFICE" | "OTHER"> = { home: "HOME", house: "HOME", office: "OFFICE", work: "OFFICE", other: "OTHER" };
const YES = new Set(["yes", "y", "true", "1", "cod", "হ্যাঁ"]);
const NO = new Set(["no", "n", "false", "0", "prepaid", "না"]);
const DEFAULT_DOCUMENT_TYPES = ["B2B Document", "Trade Service Document", "Corporate Urgent Document", "ATM card", "Cheque book"];
const DEFAULT_DOCUMENT_ITEMS = ["ATM card", "Cheque book", "Contract", "Trade document"];
const DEFAULT_RELATIONS = ["Self", "Family member", "Colleague", "Reception", "Authorized representative"];
const DEFAULT_DOCUMENT_PACKAGING = ["Document envelope", "Security pouch", "Rigid document mailer"];
/** Quote / package problems → the template column they belong to. */
const COLUMN_OF_FIELD: Record<string, ColumnKey | "row"> = {
  speed: "service_level",
  codAmount: "cod_amount",
  openBox: "open_box",
  declaredValue: "declared_value",
  weightKg: "weight_kg",
  product: "product_type",
};

const lower = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const unique = (items: string[]) => {
  const seen = new Set<string>();
  return items.filter(i => i && !seen.has(lower(i)) && seen.add(lower(i)));
};
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map(x => x.trim()) : []);
const segmentOf = (kind: ImportKindKey): PackageSegment => (kind === "document" ? "BANKING_FINANCIAL" : "ECOMMERCE");

/** "1,5 kg" → 1.5; "৳ 2,450" → 2450; null when not a number. */
export function parseNumber(raw: string): number | null {
  let s = raw.replace(/[৳\s]|tk|bdt|taka|kg|kgs/gi, "");
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^\d+,\d+$/.test(s)) s = s.replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** Which optional columns a package's template has (Speed + handling only with more than Regular). */
export function packageColumnOptions(pkg: PackageView): PackageColumnOptions {
  const o = packageOptions(pkg.segment, pkg.services);
  return { cod: o.cod, speeds: o.speeds.length > 1, openBox: o.openBox, weight: o.weight };
}

/**
 * The import rules, shared by the preview (POST /imports/validate) and the booking job, so a row
 * shown as valid is booked exactly as previewed. Lenient creation: only the columns super admins
 * made required must be filled; strict validation: every non-empty cell must be valid. Prices and
 * the services come from the merchant's service package (PackagesService.quote, per row).
 */
@Injectable()
export class ImportEngineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly packages: PackagesService,
  ) {}

  /** Live option lists (catalog, the package, products, platform settings) and merchants for a file. */
  async context(
    input: { kind: ImportKindKey; forOps: boolean; settings: ImportSettings; merchantId?: string | null; dropOffHubId?: string | null; services?: ImportServiceOptions },
    db: Db = this.prisma,
  ): Promise<EngineContext> {
    const segment = segmentOf(input.kind);
    const [catalog, platform, products] = await Promise.all([this.pricing.catalog(db), db.setting.findUnique({ where: { key: PLATFORM_CONFIG_KEY } }), this.packages.products(segment, db)]);
    const pc = (platform?.value ?? {}) as Record<string, unknown>;
    const zones = unique(catalog.districts.flatMap(d => catalog.zonesByDistrict[d] ?? []));
    const type: MerchantType = input.kind === "document" ? "BANKING_FINANCIAL" : "ECOMMERCE";
    const rows = await db.merchant.findMany({ where: input.forOps ? { type, status: "ACTIVE" } : { id: input.merchantId ?? "00000000-0000-0000-0000-000000000000" }, orderBy: { code: "asc" } });
    if (input.merchantId && !rows.some(r => r.id === input.merchantId)) {
      const chosen = await db.merchant.findUnique({ where: { id: input.merchantId } });
      if (chosen) rows.push(chosen);
    }
    const merchants = new Map<string, MerchantInfo>();
    let fileMerchant: MerchantInfo | null = null;
    for (const m of rows) {
      const info: MerchantInfo = {
        id: m.id,
        code: m.code,
        name: m.name,
        type: m.type,
        status: m.status,
        contactPhone: m.contactPhone,
        pickupAddress: m.pickupAddress,
        pickupArea: m.pickupArea,
        pickupDistrict: m.pickupDistrict,
        pickupZone: zoneForArea(catalog, m.pickupDistrict, m.pickupArea),
        segment: m.type === "BANKING_FINANCIAL" ? "BANKING_FINANCIAL" : "ECOMMERCE",
      };
      if (m.id === input.merchantId) fileMerchant = info;
      if (m.type === type && m.status === "ACTIVE") for (const key of [m.code, m.name, `${m.code} · ${m.name}`]) merchants.set(lower(key), info);
    }
    const memo: EngineContext["memo"] = { packages: new Map(), hubs: new Map(), groups: new Map() };
    const pkg = fileMerchant ? await this.packageOf(fileMerchant.id, memo, db) : null;
    const speeds = pkg ? packageOptions(pkg.segment, pkg.services).speeds : SPEED_OPTIONS.filter(o => SERVICE_BY_CODE.get(SPEED_SERVICE[o])!.segments.includes(segment));
    const lists: Record<ListKey, string[]> = {
      merchants: input.forOps ? rows.filter(m => m.type === type && m.status === "ACTIVE").map(m => `${m.code} · ${m.name}`) : [],
      districts: catalog.districts,
      zones,
      areas: unique(zones.flatMap(z => catalog.areasByZone[z] ?? [])),
      addressTypes: ["Home", "Office", "Other"],
      parcelTypes: PARCEL_TYPE_LABELS,
      // The segment's products (service packages); before any are set up, the booking catalog's suggestions.
      products: products.length ? products.map(p => p.name) : input.kind === "document" ? [] : catalog.products,
      speeds: speeds.map(s => SPEED_LABEL[s]),
      weights: [...new Set(catalog.weightsKg)].sort((a, b) => a - b).map(String),
      yesNo: ["Yes", "No"],
      packaging: input.kind === "document" ? unique([...(strings(pc.documentPackaging).length ? strings(pc.documentPackaging) : DEFAULT_DOCUMENT_PACKAGING), ...catalog.packaging]) : catalog.packaging,
      documentTypes: unique(strings(pc.documentTypes)).length ? unique(strings(pc.documentTypes)) : DEFAULT_DOCUMENT_TYPES,
      documentItems: strings(pc.documentProducts).length ? strings(pc.documentProducts) : DEFAULT_DOCUMENT_ITEMS,
      relations: strings(pc.receiverRelations).length ? strings(pc.receiverRelations) : DEFAULT_RELATIONS,
    };
    const services: ImportServiceOptions = { ...input.services, ...(input.dropOffHubId ? { firstMile: "HUB_DROP" as const, dropHubId: input.dropOffHubId } : {}) };
    return {
      kind: input.kind,
      forOps: input.forOps,
      settings: input.settings,
      columns: columnsFor(input.kind, input.forOps, pkg ? packageColumnOptions(pkg) : null),
      lists,
      catalog,
      fileMerchant,
      merchants,
      services,
      pkg,
      products,
      memo,
    };
  }

  private async packageOf(merchantId: string, memo: EngineContext["memo"], db: Db) {
    let pkg = memo.packages.get(merchantId);
    if (!pkg) {
      pkg = await this.packages.effective({ merchantId }, db);
      memo.packages.set(merchantId, pkg);
    }
    return pkg;
  }

  /** Validates rows: cell rules, required columns, duplicates in the file, orders already booked, then the package and the price. */
  async validate(ctx: EngineContext, rows: { rowNumber: number; cells: Cells }[], opts: { inFileDuplicates?: boolean; db?: Db } = {}): Promise<RowResult[]> {
    const results = rows.map(r => this.validateRow(ctx, r.rowNumber, r.cells));
    if (opts.inFileDuplicates !== false) {
      const groups = new Map<string, RowResult[]>();
      for (const r of results) if (r.merchantId && r.dedupeKey) groups.set(`${r.merchantId}|${r.dedupeKey}`, [...(groups.get(`${r.merchantId}|${r.dedupeKey}`) ?? []), r]);
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const where = `rows ${group.map(g => g.rowNumber).join(", ")}`;
        for (const r of group)
          this.fail(
            r,
            "order_ref",
            r.dedupeKey!.startsWith("h:") ? `the same order appears more than once in this file (${where}); add an order ID to book each one` : `${r.dedupeKey} appears more than once in this file (${where})`,
          );
      }
    }
    const db = opts.db ?? this.prisma;
    await this.markBooked(results, db);
    await this.priceRows(ctx, results, db);
    return results;
  }

  /**
   * Each row against its merchant's package: services it doesn't include are refused
   * (SERVICE_NOT_IN_PACKAGE), defaults applied, the product resolved and the price computed.
   */
  private async priceRows(ctx: EngineContext, results: RowResult[], db: Db) {
    for (const r of results) {
      if (r.status === "ERROR" || !r.booking || !r.merchantId) continue;
      const b = r.booking;
      try {
        const pkg = await this.packageOf(r.merchantId, ctx.memo, db);
        const product = await this.packages.resolveProduct(pkg.segment, b.product, db, ctx.products);
        const quote = await this.packages.quote(
          { merchantId: r.merchantId },
          {
            pickup: { district: b.pickup.district, zone: b.pickup.zone, area: b.pickup.area },
            delivery: { district: r.destination!.district, zone: r.destination!.zone, area: b.delivery.area },
            weightKg: b.weightKg,
            codAmount: b.codAmount,
            productType: (product?.type as ProductType | undefined) ?? "REGULAR",
            firstMile: b.firstMile,
            dropHubId: b.dropHubId,
            lastMile: b.lastMile,
            collectHubId: b.collectHubId,
            speed: b.speed,
            openBox: b.openBox,
            notifications: b.notifications,
          },
          db,
          { pkg, hubs: ctx.memo.hubs },
        );
        r.quote = quote;
        r.product = product;
        r.charge = quote.totalCharge;
        r.lines = quote.lines;
        b.serviceLevel = quote.serviceLevel;
        if (ctx.kind === "document" && ["B2B", "TRADE", "URGENT"].includes(quote.selection.speed)) b.documentType = SPEED_LABEL[quote.selection.speed];
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        const details = Array.isArray(error.details) ? (error.details as { path?: string; message: string }[]) : [];
        const message = (error.getResponse() as { message: string }).message;
        if (!details.length) this.fail(r, "row", message);
        else for (const d of details) this.fail(r, COLUMN_OF_FIELD[d.path ?? ""] ?? "row", d.message.replace(/^SERVICE_NOT_IN_PACKAGE: /, "not in your service package: "));
      }
    }
  }

  /** Rows whose order was booked before (same order ref, or the same row imported before). */
  private async markBooked(results: RowResult[], db: Db) {
    const byMerchant = new Map<string, RowResult[]>();
    for (const r of results) if (r.merchantId && r.dedupeKey && r.status !== "ERROR") byMerchant.set(r.merchantId, [...(byMerchant.get(r.merchantId) ?? []), r]);
    for (const [merchantId, rows] of byMerchant) {
      for (let i = 0; i < rows.length; i += 1000) {
        const chunk = rows.slice(i, i + 1000);
        const refs = chunk.filter(r => !r.dedupeKey!.startsWith("h:")).map(r => r.dedupeKey!);
        const keys = chunk.filter(r => r.dedupeKey!.startsWith("h:")).map(r => r.dedupeKey!);
        const found = await db.parcel.findMany({
          where: { merchantId, OR: [...(refs.length ? [{ merchantOrderRef: { in: refs } }] : []), ...(keys.length ? [{ importKey: { in: keys } }] : [])] },
          select: { trackingId: true, merchantOrderRef: true, importKey: true },
        });
        if (!found.length) continue;
        const byRef = new Map(found.filter(f => f.merchantOrderRef).map(f => [f.merchantOrderRef!, f.trackingId]));
        const byKey = new Map(found.filter(f => f.importKey).map(f => [f.importKey!, f.trackingId]));
        for (const r of chunk) {
          const ref = byRef.get(r.dedupeKey!);
          const key = byKey.get(r.dedupeKey!);
          if (ref) this.fail(r, "order_ref", `${r.dedupeKey} was already booked as ${ref}`);
          else if (key) this.fail(r, "order_ref", `this order was already imported as ${key} (same details); add an order ID to book it again`);
        }
      }
    }
  }

  private fail(r: RowResult, column: string, message: string) {
    if (!r.errors.some(e => e.column === column && e.message === message)) r.errors.push({ column, message });
    r.status = "ERROR";
    r.booking = undefined;
    r.charge = null;
    r.lines = undefined;
    r.quote = undefined;
    r.missing = [];
  }

  validateRow(ctx: EngineContext, rowNumber: number, cells: Cells): RowResult {
    const errors: CellError[] = [];
    const err = (column: string, message: string) => errors.push({ column, message });
    const settings = ctx.settings.templates[ctx.kind];
    const raw = (key: ColumnKey) => (cells[key] ?? "").trim();
    // Required columns (super admin), then defaults for empty cells.
    for (const col of ctx.columns) if (settings[col.key]?.required && !raw(col.key)) err(col.key, "required");
    const value = (key: ColumnKey) => raw(key) || (settings[key]?.default ?? "");
    const text = (key: ColumnKey, max: number) => {
      const v = value(key);
      if (v.length > max) {
        err(key, `use at most ${max} characters`);
        return undefined;
      }
      return v || undefined;
    };
    const fromList = (key: ColumnKey, list: ListKey) => {
      const v = value(key);
      if (!v) return undefined;
      const hit = ctx.lists[list].find(x => lower(x) === lower(v));
      if (!hit) err(key, `"${v}" is not an option (choose from the list)`);
      return hit;
    };
    const number = (key: ColumnKey, min: number, max: number, unit: string) => {
      const v = value(key);
      if (!v) return undefined;
      const n = parseNumber(v);
      if (n === null) {
        err(key, `"${v}" is not a number`);
        return undefined;
      }
      if (n < min) err(key, n < 0 ? "can't be negative" : `must be at least ${min}${unit}`);
      else if (n > max) err(key, `must be at most ${max.toLocaleString("en-US")}${unit}`);
      else return Math.round(n * 100) / 100;
      return undefined;
    };
    const yesNo = (key: ColumnKey) => {
      const v = value(key);
      if (!v) return undefined;
      if (YES.has(lower(v))) return true;
      if (NO.has(lower(v))) return false;
      err(key, `"${v}" is not an option (Yes or No)`);
      return undefined;
    };

    // Merchant: the row's, else the one chosen for the file.
    let merchant = ctx.fileMerchant;
    if (ctx.forOps && raw("merchant")) {
      const hit = ctx.merchants.get(lower(raw("merchant"))) ?? ctx.merchants.get(lower(raw("merchant").split("·")[0]));
      if (!hit) err("merchant", `unknown or inactive ${ctx.kind === "document" ? "document" : "e-commerce"} merchant "${raw("merchant")}"`);
      merchant = hit ?? null;
    } else if (!merchant) err("merchant", "choose the merchant (in this column or for the whole file)");
    if (merchant && merchant.status !== "ACTIVE") err("merchant", `${merchant.name} is not active`);

    const ref = text("order_ref", 80);
    const name = text("recipient_name", 120);
    let phone: string | undefined;
    if (value("recipient_phone")) {
      const problem = bdPhoneProblem(value("recipient_phone"));
      if (problem) err("recipient_phone", `${problem.charAt(0).toLowerCase()}${problem.slice(1)}`);
      else phone = normalizeBdPhone(value("recipient_phone"));
    }
    const street = text("address", 200);
    const place = resolvePlace(ctx.catalog, value("district"), value("zone"));
    if (!place.ok) err(place.column, place.message);
    const area = text("area", 120);
    let category: "HOME" | "OFFICE" | "OTHER" = ctx.kind === "document" ? "OFFICE" : "HOME";
    if (value("address_type")) {
      const c = ADDRESS_TYPES[lower(value("address_type"))];
      if (!c) err("address_type", `"${value("address_type")}" is not an option (Home, Office or Other)`);
      else category = c;
    }
    let type: "ECOMMERCE" | "FRAGILE" | "PARCEL" | "DOCUMENT" = ctx.kind === "document" ? "DOCUMENT" : "ECOMMERCE";
    if (ctx.kind === "ecommerce" && value("parcel_type")) {
      const t = PARCEL_TYPES[lower(value("parcel_type"))];
      if (!t) err("parcel_type", `"${value("parcel_type")}" is not an option (choose from the list)`);
      else type = t;
    }
    // Speed + handling (one dropdown). Empty = Regular; old service levels and document types still read.
    let speed: SpeedOption = "REGULAR";
    // Documents: an old document type (e.g. "Cheque book") that isn't a handling option books Regular and is kept.
    let otherDocumentType: string | undefined;
    if (value("service_level")) {
      const parsed = parseSpeedOption(value("service_level"));
      const oldType = ctx.kind === "document" && !parsed ? ctx.lists.documentTypes.find(t => lower(t) === lower(value("service_level"))) : undefined;
      if (parsed) speed = parsed;
      else if (oldType) otherDocumentType = oldType;
      else err("service_level", `"${value("service_level")}" is not an option (${ctx.lists.speeds.join(", ")})`);
    }
    const weightKg = number("weight_kg", 0.01, 50, " kg") ?? (value("weight_kg") ? undefined : 0.5);
    const packaging = fromList("packaging", "packaging");
    const declaredValue = number("declared_value", 0, 1_000_000, "");
    const instructions = text("instructions", 500);
    const openBox = ctx.kind === "ecommerce" ? (yesNo("open_box") ?? false) : false;
    // Product (optional): its type prices the row; none = Regular.
    let product: string | undefined;
    if (value("product_type")) product = fromList("product_type", "products");
    let contents: string | undefined;
    let receiverRelation: string | undefined;
    let originBranchCode: string | undefined;
    let codAmount = 0;
    if (ctx.kind === "ecommerce") {
      const item = text("item_description", 120);
      contents = [product, item].filter(Boolean).join(" — ").slice(0, 120) || undefined;
      const amount = number("cod_amount", 0, 1_000_000, "");
      const codText = value("cod");
      const cod = codText ? (YES.has(lower(codText)) ? true : NO.has(lower(codText)) ? false : null) : undefined;
      if (cod === null) err("cod", `"${codText}" is not an option (Yes or No)`);
      if (type === "DOCUMENT" && ((amount ?? 0) > 0 || cod === true)) err("cod_amount", "documents can't be cash on delivery");
      else if (cod === false && (amount ?? 0) > 0) err("cod_amount", 'Cash on delivery is "No" but an amount is given');
      else if (cod === true && !value("cod_amount")) err("cod_amount", 'enter the amount to collect (Cash on delivery is "Yes")');
      else if (cod === true && amount === 0) err("cod_amount", 'must be more than 0 when Cash on delivery is "Yes"');
      codAmount = amount ?? 0;
    } else {
      const item = text("document_item", 120);
      contents = [product, item && item !== product ? item : ""].filter(Boolean).join(" — ").slice(0, 120) || undefined;
      receiverRelation = fromList("receiver_relationship", "relations");
      originBranchCode = text("branch_code", 40);
      const cod = (cells.__cod ?? "").trim();
      if (cod && !NO.has(lower(cod)) && parseNumber(cod) !== 0) err("cod_amount", "documents can't be cash on delivery");
    }

    const result: RowResult = { rowNumber, cells, status: "VALID", errors, missing: [], merchantId: merchant?.id ?? null, dedupeKey: null, charge: null };
    const district = place.ok ? place.district : null;
    const zone = place.ok ? place.zone : null;
    if (!name) result.missing.push("recipientName");
    if (!phone) result.missing.push("recipientPhone");
    if (!street) result.missing.push("address");
    if (!district) result.missing.push("district");
    if (!zone) result.missing.push("zone");
    if (errors.length || !merchant) {
      result.status = "ERROR";
      result.missing = [];
      return result;
    }

    const serviceLevel = SPEED_SERVICE_LEVEL[speed];
    const documentType = ctx.kind === "document" ? (["B2B", "TRADE", "URGENT"].includes(speed) ? SPEED_LABEL[speed] : otherDocumentType) : undefined;
    const booking: BookingInput = {
      sender: { name: merchant.name, phone: merchant.contactPhone },
      pickup: { category: "OFFICE", street: merchant.pickupAddress, area: merchant.pickupArea || undefined, zone: merchant.pickupZone, district: merchant.pickupDistrict },
      recipient: { name: name ?? null, phone: phone ?? null },
      delivery: { category, street: street ?? null, area, zone, district },
      type,
      documentType,
      serviceLevel,
      weightKg: weightKg ?? 0.5,
      packaging,
      contents,
      declaredValue,
      codAmount,
      instructions,
      merchantOrderRef: ref,
      receiverRelation,
      originBranchCode,
      saveAddresses: false,
      // The file's choices (import modal) and the row's.
      firstMile: ctx.services.firstMile ?? undefined,
      dropHubId: ctx.services.dropHubId ?? undefined,
      lastMile: ctx.services.lastMile ?? undefined,
      notifications: ctx.services.notifications ?? undefined,
      speed,
      openBox,
      product,
    };
    // Priced to the destination, or (incomplete) to the configured default: the merchant's own city or a fixed zone.
    const fallback =
      ctx.settings.defaultDestination.mode === "FIXED"
        ? { district: ctx.settings.defaultDestination.district, zone: ctx.settings.defaultDestination.zone }
        : { district: merchant.pickupDistrict, zone: merchant.pickupZone };
    const destination = {
      district: district ?? fallback.district,
      zone: zone ?? (district ? (district === merchant.pickupDistrict ? merchant.pickupZone : (ctx.catalog.zonesByDistrict[district]?.[0] ?? fallback.zone)) : fallback.zone),
    };
    result.booking = booking;
    result.destination = destination;
    result.status = result.missing.length ? "INCOMPLETE" : "VALID";
    // The content hash keeps its old fields (re-uploads of older files stay idempotent); new choices are added only when set.
    const extras = [speed !== "REGULAR" && speed !== "EXPRESS" && speed !== "ON_DEMAND" ? speed : null, openBox || null].filter(Boolean);
    result.dedupeKey =
      ref ??
      `h:${createHash("sha256")
        .update(JSON.stringify([merchant.id, ctx.kind, name, phone, street, district, zone, area, category, type, serviceLevel, booking.weightKg, codAmount, contents, documentType, receiverRelation, originBranchCode, declaredValue, instructions, ...(extras.length ? [extras] : [])]))
        .digest("hex")
        .slice(0, 40)}`;
    return result;
  }
}
