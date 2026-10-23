import { merchantPickupArea, merchantPickupZone } from "../merchants/merchant-address";
import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  bdPhoneProblem,
  isBanking,
  isMaskedBdMobile,
  normalizeBdPhone,
  normalizeMaskedBdPhone,
  packageOptions,
  parseSpeedOption,
  PRODUCT_TYPE_LABEL,
  PRODUCT_TYPES,
  productListOf,
  SEED_PRODUCTS,
  SEGMENT_LABEL,
  SERVICE_BY_CODE,
  SPEED_LABEL,
  SPEED_SERVICE,
  SPEED_SERVICE_LEVEL,
  type FirstMile,
  type LastMile,
  type PriceLine,
  type ProductType,
  type SpeedOption,
} from "@delivery-fast/shared";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AppError } from "../../common/errors";
import type { MerchantType, ParcelProduct } from "../../generated/prisma/client";
import { PricingService, type Catalog } from "../pricing/pricing.service";
import type { BookingInput } from "../parcels/parcels.service";
import type { MissingField } from "../parcels/incomplete";
import { resolvePlace } from "../parcels/places";
import { PackagesService, type HubRef, type PackageQuote, type PackageSubject } from "../packages/packages.service";
import type { PackageView } from "../packages/package-resolver";
import { columnsFor, KIND_LABEL, segmentOf, type ColumnDef, type ColumnKey, type ImportKindKey, type ListKey, type PackageColumnOptions } from "./columns";
import type { ImportSettings } from "./import-config.service";

/**
 * `__scan`: the Scan ID of a "Scan with phone" row (parcel-scans); the booked parcel keeps its photo.
 * `__auto`: place columns picked from the address (import-places.ts), comma-separated.
 */
export type Cells = Partial<Record<ColumnKey | "__cod" | "__scan" | "__auto", string>>;
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
  /** The file's merchant (null: customer parcels). */
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
  /** Priced and checked against the package. */
  quote?: PackageQuote;
  product?: { id: string | null; name: string; type: string; sendMessages: boolean } | null;
  /** E-commerce: a product name that isn't one of the listed products (booked as written, priced as Regular). */
  freeProduct?: string;
}

export interface EngineContext {
  kind: ImportKindKey;
  settings: ImportSettings;
  columns: ColumnDef[];
  lists: Record<ListKey, string[]>;
  catalog: Catalog;
  /** The merchant chosen for the file (operations) or the signed-in merchant; null for customer parcels (or a template without a merchant). */
  fileMerchant: MerchantInfo | null;
  services: ImportServiceOptions;
  /** The package the file books with: the merchant's, else the category's default (customer parcels: the Customer default). */
  pkg: PackageView;
  /** The category's active products, in list order (type, then the seeded order, then name). */
  products: ParcelProduct[];
  /** Per-file caches: hubs by place. */
  memo: { hubs: Map<string, HubRef | null> };
}

const YES = new Set(["yes", "y", "true", "1", "হ্যাঁ"]);
const NO = new Set(["no", "n", "false", "0", "prepaid", "না"]);
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

/** "Fashion & Apparel (Regular)": how products appear in the dropdown (the plain name is accepted too). */
export const productLabel = (p: Pick<ParcelProduct, "name" | "type">) => `${p.name} (${PRODUCT_TYPE_LABEL[p.type as ProductType] ?? p.type})`;
/** "Fashion & Apparel (Regular)" → "fashion & apparel" (cells may hold the label or the name). */
export const productNameOfCell = (cell: string) => lower(cell).replace(/\s*\((regular|document|books)\)$/, "");

/** Products in list order: Regular, Document, Books; inside a type the seeded order, then new ones by name. */
export function sortProducts<T extends Pick<ParcelProduct, "name" | "type" | "segment">>(products: T[]): T[] {
  const typeRank = (t: string) => {
    const i = (PRODUCT_TYPES as readonly string[]).indexOf(t);
    return i < 0 ? PRODUCT_TYPES.length : i;
  };
  const seedRank = (p: T) => {
    const list = SEED_PRODUCTS[p.segment === "BANKING_FINANCIAL" ? "BANKING_FINANCIAL" : "ECOMMERCE"][p.type as ProductType] ?? [];
    const i = list.indexOf(p.name);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...products].sort((a, b) => typeRank(a.type) - typeRank(b.type) || seedRank(a) - seedRank(b) || a.name.localeCompare(b.name));
}

/** "1,5 kg" → 1.5; "৳ 2,450" → 2450; null when not a number. */
export function parseNumber(raw: string): number | null {
  let s = raw.replace(/[৳\s]|tk|bdt|taka|kg|kgs/gi, "");
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^\d+,\d+$/.test(s)) s = s.replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** Which optional columns a package's template has (COD amount, Open box). */
export function packageColumnOptions(pkg: PackageView): PackageColumnOptions {
  const o = packageOptions(pkg.segment, pkg.services);
  return { cod: o.cod, openBox: o.openBox };
}

/** "Shop 1's service package" / "the Customer service package". */
export const packageOwner = (ctx: Pick<EngineContext, "fileMerchant" | "pkg">) => (ctx.fileMerchant ? `${ctx.fileMerchant.name}'s service package` : `the ${SEGMENT_LABEL[ctx.pkg.segment]} service package`);

/**
 * The import rules, shared by the preview (POST /imports/validate) and the booking job, so a row
 * shown as valid is booked exactly as previewed. Lenient creation: only the columns super admins
 * made required must be filled; strict validation: every non-empty cell must be valid. Prices and
 * the services come from the file's service package (the merchant's, or the Customer default for
 * customer parcels; PackagesService.quote, per row).
 */
@Injectable()
export class ImportEngineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly packages: PackagesService,
  ) {}

  /** Live option lists (geography, the package, the category's products) for a file. */
  async context(
    input: { kind: ImportKindKey; settings: ImportSettings; merchantId?: string | null; dropOffHubId?: string | null; services?: ImportServiceOptions },
    db: Db = this.prisma,
  ): Promise<EngineContext> {
    const segment = segmentOf(input.kind);
    const [catalog, products] = await Promise.all([this.pricing.catalog(db), this.packages.products(segment, db)]);
    const zones = unique(catalog.districts.flatMap(d => catalog.zonesByDistrict[d] ?? []));
    const m = input.kind !== "customer" && input.merchantId ? await db.merchant.findUnique({ where: { id: input.merchantId } }) : null;
    const fileMerchant: MerchantInfo | null = m
      ? {
          id: m.id,
          code: m.code,
          name: m.name,
          type: m.type,
          status: m.status,
          contactPhone: m.contactPhone,
          pickupAddress: m.pickupAddress,
          pickupArea: merchantPickupArea(m) ?? "",
          pickupDistrict: m.pickupDistrict,
          pickupZone: merchantPickupZone(catalog, m),
        }
      : null;
    const pkg = await this.packages.effective(fileMerchant ? { merchantId: fileMerchant.id } : { segment }, db);
    const sorted = sortProducts(products);
    const lists: Record<ListKey, string[]> = {
      districts: catalog.districts,
      zones,
      areas: unique(zones.flatMap(z => catalog.areasByZone[z] ?? [])),
      // The category's active products with their type (Customer and E-commerce share one list).
      products: sorted.map(productLabel),
      // Only the services the package offers.
      speeds: packageOptions(pkg.segment, pkg.services).speeds.map(s => SPEED_LABEL[s]),
      weights: [...new Set(catalog.weightsKg)].sort((a, b) => a - b).map(String),
      yesNo: ["Yes", "No"],
    };
    const services: ImportServiceOptions = { ...input.services, ...(input.dropOffHubId ? { firstMile: "HUB_DROP" as const, dropHubId: input.dropOffHubId } : {}) };
    return {
      kind: input.kind,
      settings: input.settings,
      columns: columnsFor(input.kind, packageColumnOptions(pkg)),
      lists,
      catalog,
      fileMerchant,
      services,
      pkg,
      products: sorted,
      memo: { hubs: new Map() },
    };
  }

  /** Who the file books for: the merchant, or the Customer category. */
  private subjectOf(ctx: EngineContext): PackageSubject {
    return ctx.fileMerchant ? { merchantId: ctx.fileMerchant.id } : { segment: ctx.pkg.segment };
  }

  /** Validates rows: cell rules, required columns, duplicates in the file, orders already booked, then the package and the price. */
  async validate(ctx: EngineContext, rows: { rowNumber: number; cells: Cells }[], opts: { inFileDuplicates?: boolean; db?: Db } = {}): Promise<RowResult[]> {
    const results = rows.map(r => this.validateRow(ctx, r.rowNumber, r.cells));
    if (opts.inFileDuplicates !== false) {
      // The first row with a reference (or the same details) is kept; later ones are errors that name it.
      const first = new Map<string, RowResult>();
      for (const r of results) {
        if (!r.dedupeKey || r.status === "ERROR") continue;
        const key = `${r.merchantId ?? "customer"}|${r.dedupeKey}`;
        const earlier = first.get(key);
        if (!earlier) first.set(key, r);
        else
          this.fail(
            r,
            "order_ref",
            r.dedupeKey.startsWith("h:")
              ? `the same order as row ${earlier.rowNumber} (identical details); add an order ID to book both`
              : `${r.dedupeKey} duplicates row ${earlier.rowNumber} (each reference is booked once)`,
          );
      }
    }
    const db = opts.db ?? this.prisma;
    await this.markBooked(results, db);
    await this.priceRows(ctx, results, db);
    return results;
  }

  /**
   * Each row against the file's package: services it doesn't include are refused
   * (SERVICE_NOT_IN_PACKAGE), defaults applied, the product resolved and the price computed.
   */
  private async priceRows(ctx: EngineContext, results: RowResult[], db: Db) {
    const subject = this.subjectOf(ctx);
    for (const r of results) {
      if (r.status === "ERROR" || !r.booking) continue;
      const b = r.booking;
      try {
        const product = r.freeProduct ? { id: null, name: r.freeProduct, type: "REGULAR", sendMessages: true } : await this.packages.resolveProduct(ctx.pkg.segment, b.product, db, ctx.products);
        const quote = await this.packages.quote(
          subject,
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
          { pkg: ctx.pkg, hubs: ctx.memo.hubs },
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
        else for (const d of details) this.fail(r, COLUMN_OF_FIELD[d.path ?? ""] ?? "row", d.message.replace(/^SERVICE_NOT_IN_PACKAGE: /, `not in ${packageOwner(ctx)}: `));
      }
    }
  }

  /** Rows whose order was booked before (same order ref, or the same row imported before) for the same merchant (or as customer parcels). */
  private async markBooked(results: RowResult[], db: Db) {
    const bySubject = new Map<string, RowResult[]>();
    for (const r of results) if (r.dedupeKey && r.status !== "ERROR") bySubject.set(r.merchantId ?? "", [...(bySubject.get(r.merchantId ?? "") ?? []), r]);
    for (const [subject, rows] of bySubject) {
      for (let i = 0; i < rows.length; i += 1000) {
        const chunk = rows.slice(i, i + 1000);
        const refs = chunk.filter(r => !r.dedupeKey!.startsWith("h:")).map(r => r.dedupeKey!);
        const keys = chunk.filter(r => r.dedupeKey!.startsWith("h:")).map(r => r.dedupeKey!);
        const found = await db.parcel.findMany({
          where: { merchantId: subject || null, OR: [...(refs.length ? [{ merchantOrderRef: { in: refs } }] : []), ...(keys.length ? [{ importKey: { in: keys } }] : [])] },
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
    const customer = ctx.kind === "customer";
    const banking = isBanking(ctx.pkg.segment);
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
    const phone = (key: ColumnKey) => {
      const v = value(key);
      if (!v) return undefined;
      // A recipient's number printed masked ("019***545"): kept as written, never messaged.
      if (key === "recipient_phone" && isMaskedBdMobile(v)) return normalizeMaskedBdPhone(v);
      const problem = bdPhoneProblem(v);
      if (problem) err(key, `${problem.charAt(0).toLowerCase()}${problem.slice(1)}`);
      return problem ? undefined : normalizeBdPhone(v);
    };

    // Merchant: the one chosen for the whole file (there is no Merchant column). Customer parcels have none.
    const merchant = customer ? null : ctx.fileMerchant;
    if (!customer && !merchant) err("row", `choose the ${KIND_LABEL[ctx.kind]} merchant for this file`);
    if (merchant && merchant.status !== "ACTIVE") err("row", `${merchant.name} is not active`);

    // Sender and pickup: the merchant's, or (customer parcels) the row's.
    let sender: { name: string; phone: string } | null = null;
    let pickup: { street: string; area?: string; district: string; zone: string } | null = null;
    if (customer) {
      const sName = text("sender_name", 120);
      const sPhone = phone("sender_phone");
      const sStreet = text("pickup_address", 200);
      const place = resolvePlace(ctx.catalog, value("pickup_district"), value("pickup_zone"));
      if (!place.ok) err(place.column === "district" ? "pickup_district" : "pickup_zone", place.message);
      const sArea = text("pickup_area", 120);
      if (sName && sPhone) sender = { name: sName, phone: sPhone };
      if (sStreet && place.ok && place.district && place.zone) pickup = { street: sStreet, area: sArea, district: place.district, zone: place.zone };
    } else if (merchant) {
      sender = { name: merchant.name, phone: merchant.contactPhone };
      pickup = { street: merchant.pickupAddress, area: merchant.pickupArea || undefined, district: merchant.pickupDistrict, zone: merchant.pickupZone };
    }

    const name = text("recipient_name", 120);
    const recipientPhone = phone("recipient_phone");
    const street = text("address", 200);
    const place = resolvePlace(ctx.catalog, value("district"), value("zone"));
    if (!place.ok) err(place.column, place.message);
    const area = text("area", 120);

    // Service (one dropdown, only the package's options). Empty = Regular.
    let speed: SpeedOption = "REGULAR";
    const serviceText = value("service_level");
    if (serviceText) {
      const options = ctx.lists.speeds.join(", ");
      const parsed = parseSpeedOption(serviceText);
      if (/^same[\s_-]*day$/i.test(serviceText.trim()))
        err(
          "service_level",
          `"Same day" is not a service option: choose one from the list (${options})${!banking && ctx.lists.speeds.includes(SPEED_LABEL.EXPRESS) ? "; Express is the same-day service, inside the same district" : ""}`,
        );
      else if (parsed && ctx.lists.speeds.includes(SPEED_LABEL[parsed])) speed = parsed;
      else if (parsed && SERVICE_BY_CODE.get(SPEED_SERVICE[parsed])!.segments.includes(ctx.pkg.segment)) err("service_level", `${SPEED_LABEL[parsed]} is not in ${packageOwner(ctx)} (choose ${options})`);
      else err("service_level", `"${serviceText}" is not an option (${options})`);
    }
    // Weight: Customer & E-commerce only (Banking & Financial has no weight).
    const weightKg = banking ? undefined : number("weight_kg", 0.01, 50, " kg");
    const declaredValue = banking ? undefined : number("declared_value", 0, 1_000_000, "");
    const instructions = text("instructions", 500);
    const openBox = banking ? false : (yesNo("open_box") ?? false);
    const ref = text("order_ref", 80);
    // Product (optional): the category's list, by its dropdown label or its name; its type prices the row.
    // E-commerce takes any name: one that isn't listed is booked as written and priced as Regular.
    let product: string | undefined;
    let freeProduct: string | undefined;
    if (value("product_type")) {
      const wanted = productNameOfCell(value("product_type"));
      const hit = ctx.products.find(p => lower(p.name) === wanted || lower(productLabel(p)) === lower(value("product_type")));
      if (hit) product = hit.name;
      else if (ctx.kind === "ecommerce") freeProduct = value("product_type").replace(/\s+/g, " ").slice(0, 120);
      else err("product_type", `"${value("product_type")}" is not an option (choose a product of the ${SEGMENT_LABEL[ctx.pkg.segment]} list)`);
    }
    let codAmount = 0;
    if (!banking) codAmount = number("cod_amount", 0, 1_000_000, "") ?? 0;
    else {
      const cod = (cells.__cod ?? "").trim();
      if (cod && !NO.has(lower(cod)) && parseNumber(cod) !== 0) err("cod_amount", "Banking & Financial parcels can't be cash on delivery");
    }

    const result: RowResult = { rowNumber, cells, status: "VALID", errors, missing: [], merchantId: merchant?.id ?? null, dedupeKey: null, charge: null };
    const district = place.ok ? place.district : null;
    const zone = place.ok ? place.zone : null;
    if (!name) result.missing.push("recipientName");
    if (!recipientPhone) result.missing.push("recipientPhone");
    if (!street) result.missing.push("address");
    if (!district) result.missing.push("district");
    if (!zone) result.missing.push("zone");
    if (errors.length || !sender || !pickup) {
      if (!errors.length) err("row", "the sender and pickup details are incomplete");
      result.status = "ERROR";
      result.missing = [];
      return result;
    }

    const type = ctx.kind === "document" ? "DOCUMENT" : customer ? "PARCEL" : "ECOMMERCE";
    const category: "HOME" | "OFFICE" = ctx.kind === "document" ? "OFFICE" : "HOME";
    const serviceLevel = SPEED_SERVICE_LEVEL[speed];
    const documentType = ctx.kind === "document" && ["B2B", "TRADE", "URGENT"].includes(speed) ? SPEED_LABEL[speed] : undefined;
    const booking: BookingInput = {
      sender,
      pickup: { category: customer ? "HOME" : "OFFICE", street: pickup.street, area: pickup.area, zone: pickup.zone, district: pickup.district },
      recipient: { name: name ?? null, phone: recipientPhone ?? null },
      delivery: { category, street: street ?? null, area, zone, district },
      type,
      documentType,
      serviceLevel,
      weightKg: weightKg ?? 0.5,
      contents: product,
      declaredValue,
      codAmount,
      instructions,
      merchantOrderRef: ref,
      // Removed from the templates (2026-10-18); never written by imports any more.
      packaging: undefined,
      receiverRelation: undefined,
      originBranchCode: undefined,
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
    // Priced to the destination, or (incomplete) to the configured default: inside the sender's own district or a fixed zone.
    const fallback =
      ctx.settings.defaultDestination.mode === "FIXED" ? { district: ctx.settings.defaultDestination.district, zone: ctx.settings.defaultDestination.zone } : { district: pickup.district, zone: pickup.zone };
    const destination = {
      district: district ?? fallback.district,
      zone: zone ?? (district ? (district === pickup.district ? pickup.zone : (ctx.catalog.zonesByDistrict[district]?.[0] ?? fallback.zone)) : fallback.zone),
    };
    result.booking = booking;
    result.freeProduct = freeProduct;
    result.destination = destination;
    result.status = result.missing.length ? "INCOMPLETE" : "VALID";
    // The content hash keeps the fields of the older templates in place (re-uploads of older files stay
    // idempotent; removed columns are null); new choices are added only when set.
    const extras = [speed !== "REGULAR" && speed !== "EXPRESS" && speed !== "ON_DEMAND" ? speed : null, openBox || null].filter(Boolean);
    const senderExtras = customer ? [[sender.name, sender.phone, pickup.street, pickup.district, pickup.zone, pickup.area ?? null]] : [];
    result.dedupeKey =
      ref ??
      `h:${createHash("sha256")
        .update(
          JSON.stringify([
            merchant?.id ?? "customer",
            ctx.kind,
            name,
            recipientPhone,
            street,
            district,
            zone,
            area,
            category,
            type,
            serviceLevel,
            booking.weightKg,
            codAmount,
            product,
            documentType,
            undefined,
            undefined,
            declaredValue,
            instructions,
            ...(extras.length ? [extras] : []),
            ...senderExtras,
          ]),
        )
        .digest("hex")
        .slice(0, 40)}`;
    return result;
  }
}

/** The product list a category reads (Customer and E-commerce share one). */
export const productSegmentOf = (kind: ImportKindKey) => productListOf(segmentOf(kind));
