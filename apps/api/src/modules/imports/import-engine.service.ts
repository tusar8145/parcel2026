import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  applyRateOverride,
  bdPhoneProblem,
  normalizeBdPhone,
  quoteParcel,
  SERVICE_LEVEL_LABEL,
  SERVICE_LEVELS,
  type RateCardConfig,
  type ServiceLevel,
} from "@delivery-fast/shared";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { MerchantType, Segment } from "../../generated/prisma/client";
import { PricingService, type Catalog, type PricingOrigin } from "../pricing/pricing.service";
import type { BookingInput } from "../parcels/parcels.service";
import type { MissingField } from "../parcels/incomplete";
import { resolvePlace, zoneForArea } from "../parcels/places";
import { PLATFORM_CONFIG_KEY } from "../admin/platform-config.service";
import { columnsFor, type ColumnDef, type ColumnKey, type ImportKindKey, type ListKey } from "./columns";
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
  discountPercent: number;
  card: RateCardConfig;
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
  /** The booking (rows without errors). */
  booking?: BookingInput;
  /** Where an incomplete row is priced to. */
  destination?: { district: string; zone: string };
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
  origin: PricingOrigin | null;
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

const lower = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const unique = (items: string[]) => {
  const seen = new Set<string>();
  return items.filter(i => i && !seen.has(lower(i)) && seen.add(lower(i)));
};
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map(x => x.trim()) : []);

/** "1,5 kg" → 1.5; "৳ 2,450" → 2450; null when not a number. */
export function parseNumber(raw: string): number | null {
  let s = raw.replace(/[৳\s]|tk|bdt|taka|kg|kgs/gi, "");
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^\d+,\d+$/.test(s)) s = s.replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/**
 * The import rules, shared by the preview (POST /imports/validate) and the booking job, so a row
 * shown as valid is booked exactly as previewed. Lenient creation: only the columns super admins
 * made required must be filled; strict validation: every non-empty cell must be valid.
 */
@Injectable()
export class ImportEngineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
  ) {}

  /** Live option lists (catalog, rate cards, platform settings) and merchants for a file. */
  async context(input: { kind: ImportKindKey; forOps: boolean; settings: ImportSettings; merchantId?: string | null; dropOffHubId?: string | null }, db: Db = this.prisma): Promise<EngineContext> {
    const [catalog, platform, cards] = await Promise.all([
      this.pricing.catalog(db),
      db.setting.findUnique({ where: { key: PLATFORM_CONFIG_KEY } }),
      this.pricing.currentCards(db),
    ]);
    const pc = (platform?.value ?? {}) as Record<string, unknown>;
    const zones = unique(catalog.districts.flatMap(d => catalog.zonesByDistrict[d] ?? []));
    const docRates = Object.keys(cards.CORPORATE_DOCUMENT.config.documentTypeRates ?? {});
    const lists: Record<ListKey, string[]> = {
      merchants: [],
      districts: catalog.districts,
      zones,
      areas: unique(zones.flatMap(z => catalog.areasByZone[z] ?? [])),
      addressTypes: ["Home", "Office", "Other"],
      parcelTypes: PARCEL_TYPE_LABELS,
      products: catalog.products,
      serviceLevels: SERVICE_LEVELS.map(l => SERVICE_LEVEL_LABEL[l]),
      weights: [...new Set(catalog.weightsKg)].sort((a, b) => a - b).map(String),
      yesNo: ["Yes", "No"],
      packaging: input.kind === "document" ? unique([...(strings(pc.documentPackaging).length ? strings(pc.documentPackaging) : DEFAULT_DOCUMENT_PACKAGING), ...catalog.packaging]) : catalog.packaging,
      documentTypes: unique([...strings(pc.documentTypes), ...docRates]).length ? unique([...strings(pc.documentTypes), ...docRates]) : DEFAULT_DOCUMENT_TYPES,
      documentItems: strings(pc.documentProducts).length ? strings(pc.documentProducts) : DEFAULT_DOCUMENT_ITEMS,
      relations: strings(pc.receiverRelations).length ? strings(pc.receiverRelations) : DEFAULT_RELATIONS,
    };
    const type: MerchantType = input.kind === "document" ? "CORPORATE_DOCUMENT" : "ECOMMERCE";
    const rows = await db.merchant.findMany({
      where: input.forOps ? { type, status: "ACTIVE" } : { id: input.merchantId ?? "00000000-0000-0000-0000-000000000000" },
      include: { plan: { select: { discountPct: true } } },
      orderBy: { code: "asc" },
    });
    if (input.merchantId && !rows.some(r => r.id === input.merchantId)) {
      const chosen = await db.merchant.findUnique({ where: { id: input.merchantId }, include: { plan: { select: { discountPct: true } } } });
      if (chosen) rows.push(chosen);
    }
    const overrides = await db.merchantRateOverride.findMany({ where: { merchantId: { in: rows.map(r => r.id) } } });
    const merchants = new Map<string, MerchantInfo>();
    let fileMerchant: MerchantInfo | null = null;
    for (const m of rows) {
      const segment: Segment = m.type === "CORPORATE_DOCUMENT" ? "CORPORATE_DOCUMENT" : "ECOMMERCE";
      const override = overrides.find(o => o.merchantId === m.id);
      const card = applyRateOverride(cards[segment].config, override ? (override.config as Parameters<typeof applyRateOverride>[1]) : null);
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
        segment,
        discountPercent: m.plan ? Number(m.plan.discountPct) : 0,
        card,
      };
      if (m.id === input.merchantId) fileMerchant = info;
      if (m.type === type && m.status === "ACTIVE") for (const key of [m.code, m.name, `${m.code} · ${m.name}`]) merchants.set(lower(key), info);
    }
    if (input.forOps) lists.merchants = rows.filter(m => m.type === type && m.status === "ACTIVE").map(m => `${m.code} · ${m.name}`);
    const origin = input.dropOffHubId ? await this.pricing.hubOrigin(input.dropOffHubId, db) : null;
    return { kind: input.kind, forOps: input.forOps, settings: input.settings, columns: columnsFor(input.kind, input.forOps), lists, catalog, fileMerchant, merchants, origin };
  }

  /** Validates rows: cell rules, required columns, duplicates in the file and orders already booked. */
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
    await this.markBooked(results, opts.db ?? this.prisma);
    return results;
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
    r.errors.push({ column, message });
    r.status = "ERROR";
    r.booking = undefined;
    r.charge = null;
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
    let serviceLevel: ServiceLevel = "REGULAR";
    if (value("service_level")) {
      const v = lower(value("service_level")).replace(/[_-]/g, " ");
      const level = SERVICE_LEVELS.find(l => lower(SERVICE_LEVEL_LABEL[l]) === v || l.toLowerCase().replace(/_/g, " ") === v);
      if (!level) err("service_level", `"${value("service_level")}" is not an option (${SERVICE_LEVELS.map(l => SERVICE_LEVEL_LABEL[l]).join(", ")})`);
      else serviceLevel = level;
    }
    const weightKg = number("weight_kg", 0.01, 50, " kg") ?? (value("weight_kg") ? undefined : 1);
    const packaging = fromList("packaging", "packaging");
    const declaredValue = number("declared_value", 0, 1_000_000, "");
    const instructions = text("instructions", 500);
    let contents: string | undefined;
    let documentType: string | undefined;
    let receiverRelation: string | undefined;
    let originBranchCode: string | undefined;
    let codAmount = 0;
    if (ctx.kind === "ecommerce") {
      const product = fromList("product_type", "products");
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
      documentType = fromList("document_type", "documentTypes");
      const item = text("document_item", 120);
      contents = [documentType, item && item !== documentType ? item : ""].filter(Boolean).join(" — ").slice(0, 120) || undefined;
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

    const booking: BookingInput = {
      sender: { name: merchant.name, phone: merchant.contactPhone },
      pickup: { category: "OFFICE", street: merchant.pickupAddress, area: merchant.pickupArea || undefined, zone: merchant.pickupZone, district: merchant.pickupDistrict },
      recipient: { name: name ?? null, phone: phone ?? null },
      delivery: { category, street: street ?? null, area, zone, district },
      type,
      documentType,
      serviceLevel,
      weightKg: weightKg ?? 1,
      packaging,
      contents,
      declaredValue,
      codAmount,
      instructions,
      merchantOrderRef: ref,
      receiverRelation,
      originBranchCode,
      saveAddresses: false,
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
    const quote = quoteParcel(merchant.card, {
      pickupDistrict: ctx.origin?.district ?? merchant.pickupDistrict,
      pickupZone: ctx.origin?.zone ?? merchant.pickupZone,
      deliveryDistrict: destination.district,
      deliveryZone: destination.zone,
      weightKg: booking.weightKg,
      serviceLevel,
      codAmount,
      discountPercent: merchant.discountPercent,
      parcelType: type,
      documentType,
    });
    result.booking = booking;
    result.destination = destination;
    result.charge = quote.totalCharge;
    result.status = result.missing.length ? "INCOMPLETE" : "VALID";
    result.dedupeKey =
      ref ??
      `h:${createHash("sha256")
        .update(JSON.stringify([merchant.id, ctx.kind, name, phone, street, district, zone, area, category, type, serviceLevel, booking.weightKg, codAmount, contents, documentType, receiverRelation, originBranchCode, declaredValue, instructions]))
        .digest("hex")
        .slice(0, 40)}`;
    return result;
  }
}
