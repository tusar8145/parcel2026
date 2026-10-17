import { HttpStatus, Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import {
  applyRateOverride,
  DEFAULT_RATE_CARD,
  quoteParcel,
  rateCardConfigSchema,
  rateCardOverrideSchema,
  type QuoteInput,
  type RateCardConfig,
  type RateCardOverride,
} from "@delivery-fast/shared";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError, notFound } from "../../common/errors";
import { ApprovalsService } from "../approvals/approvals.service";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { Prisma, RateCard, Segment } from "../../generated/prisma/client";
import { RealtimeService } from "../../common/realtime.service";
import { activeCatalog, GEO_META_KEY, lockGeography, normalizeMeta, readMeta } from "../geography/geo-catalog";
import { prepareCatalogSave } from "../geography/geo-catalog-save";

export const SEGMENTS = ["CUSTOMER", "ECOMMERCE", "BANKING_FINANCIAL"] as const satisfies readonly Segment[];
export const segmentSchema = z.enum(SEGMENTS, "Choose CUSTOMER, ECOMMERCE or BANKING_FINANCIAL");

const label = z.string().trim().min(1, "Names can't be empty").max(80, "Use at most 80 characters per name");
const labels = (what: string, max = 500) =>
  z
    .array(label)
    .max(max, `Use at most ${max} ${what}`)
    .refine(items => new Set(items.map(i => i.toLowerCase())).size === items.length, `The same ${what.replace(/s$/, "")} is listed twice`);

/** Lists offered on booking forms, editable by super admins (Setting "catalog"). */
const catalogShape = z.object({
  districts: labels("districts").min(1, "Keep at least one district"),
  zonesByDistrict: z.record(label, labels("zones")),
  areasByZone: z.record(label, labels("areas")),
  packaging: labels("packaging types", 100),
  products: labels("products", 200),
  weightsKg: z.array(z.number().positive().max(1000)).max(50),
});
/** Every zone belongs to a listed district and every area to a listed zone. */
export const catalogSchema = catalogShape.superRefine((c, ctx) => {
  const districts = new Set(c.districts);
  for (const district of Object.keys(c.zonesByDistrict))
    if (!districts.has(district)) ctx.addIssue({ code: "custom", path: ["zonesByDistrict", district], message: `${district} is not in the district list` });
  const zones = new Set(Object.values(c.zonesByDistrict).flat());
  for (const zone of Object.keys(c.areasByZone))
    if (!zones.has(zone)) ctx.addIssue({ code: "custom", path: ["areasByZone", zone], message: `${zone} is not a zone of any district` });
});
export type Catalog = z.infer<typeof catalogSchema>;

export const DEFAULT_CATALOG: Catalog = {
  districts: ["Dhaka North", "Dhaka Central", "Dhaka South", "Chattogram"],
  zonesByDistrict: {
    "Dhaka North": ["Gulshan", "Banani", "Uttara"],
    "Dhaka Central": ["Dhanmondi", "Mirpur"],
    "Dhaka South": ["Motijheel"],
    Chattogram: ["Agrabad"],
  },
  areasByZone: {
    Gulshan: ["Niketon Central Mosque", "Road 4 Gulshan"],
    Banani: ["Banani Block C"],
    Dhanmondi: ["Dhanmondi Road 7"],
  },
  packaging: ["Small carton", "Large carton", "Box", "Poly mailer"],
  products: ["General merchandise", "Fragile item", "Clothing", "Electronics"],
  weightsKg: [0.5, 1, 2, 5],
};

export const createRateCardSchema = z.object({
  segment: segmentSchema,
  name: z.string().trim().min(2).max(120),
  config: rateCardConfigSchema,
  /** Defaults to now. A future date schedules the card; the current one stays in force until then. */
  effectiveFrom: z.coerce.date().optional(),
});

export const listRateCardsQuerySchema = z.object({ segment: segmentSchema.optional() });

/** A merchant's own tariff on top of its segment card; `config: null` removes it. */
export const merchantRateSchema = z.object({
  config: rateCardOverrideSchema.nullable(),
  note: z.string().trim().max(300, "Use at most 300 characters").optional(),
});
const merchantRateChangeSchema = merchantRateSchema.extend({ merchantId: z.uuid() });
const deactivateChangeSchema = z.object({ id: z.uuid() });

/** The location a parcel's price was computed from when it isn't the pickup address (hub drop-offs). */
export interface PricingOrigin {
  kind: "DROP_OFF_HUB";
  hubId: string;
  hub: string;
  district: string;
  zone: string;
}

export type CurrentCard ={ id: string | null; name: string | null; effectiveFrom: Date | null; config: RateCardConfig };

@Injectable()
export class PricingService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
  ) {}

  /** Catalog changes are announced to every panel (property injection keeps the constructor stable for parallel edits). */
  @Inject(RealtimeService) private readonly realtime!: RealtimeService;

  /** Rate cards and merchant tariffs are maker-checker changes (see ApprovalsService). */
  onModuleInit() {
    this.approvals.register<z.infer<typeof createRateCardSchema>>({
      kind: "rate_card.create",
      prepare: async payload => createRateCardSchema.parse(payload),
      summary: p => `New ${p.segment} rate card "${p.name}"${p.effectiveFrom ? ` from ${new Date(p.effectiveFrom).toISOString().slice(0, 10)}` : ""}`,
      apply: async (tx, p, { actor, requestedById, meta }) => {
        const card = await tx.rateCard.create({
          data: { segment: p.segment, name: p.name, config: p.config, effectiveFrom: p.effectiveFrom ?? new Date(), createdById: requestedById },
        });
        await this.audit.record(
          actor,
          { action: "rate_card.create", entityType: "rate_card", entityId: card.id, data: { segment: p.segment, name: p.name, config: p.config, requestedById } },
          meta,
          tx,
        );
        return JSON.parse(JSON.stringify(card));
      },
    });
    this.approvals.register<z.infer<typeof deactivateChangeSchema> & { segment: Segment; name: string }>({
      kind: "rate_card.deactivate",
      prepare: async (payload, db) => {
        const { id } = deactivateChangeSchema.parse(payload);
        const card = await db.rateCard.findUnique({ where: { id }, select: { segment: true, name: true, active: true } });
        if (!card) throw notFound("Rate card");
        if (!card.active) throw new AppError("RATE_CARD_INACTIVE", "This rate card is already inactive", HttpStatus.CONFLICT);
        return { id, segment: card.segment, name: card.name };
      },
      summary: p => `Deactivate ${p.segment} rate card "${p.name}"`,
      apply: async (tx, p, { actor, requestedById, meta }) => {
        const card = await tx.rateCard.update({ where: { id: p.id }, data: { active: false } });
        await this.audit.record(actor, { action: "rate_card.deactivate", entityType: "rate_card", entityId: p.id, data: { segment: card.segment, requestedById } }, meta, tx);
        return JSON.parse(JSON.stringify(card));
      },
    });
    this.approvals.register<z.infer<typeof merchantRateChangeSchema> & { merchantName: string }>({
      kind: "merchant_rate.set",
      prepare: async (payload, db) => {
        const p = merchantRateChangeSchema.parse(payload);
        const merchant = await db.merchant.findUnique({ where: { id: p.merchantId }, select: { name: true } });
        if (!merchant) throw notFound("Merchant");
        return { ...p, merchantName: merchant.name };
      },
      summary: p => (p.config ? `Custom tariff for ${p.merchantName}` : `Remove the custom tariff of ${p.merchantName}`),
      apply: async (tx, p, { actor, requestedById, meta }) => {
        if (p.config) {
          await tx.merchantRateOverride.upsert({
            where: { merchantId: p.merchantId },
            create: { merchantId: p.merchantId, config: p.config, note: p.note, updatedById: requestedById },
            update: { config: p.config, note: p.note ?? null, updatedById: requestedById },
          });
        } else await tx.merchantRateOverride.deleteMany({ where: { merchantId: p.merchantId } });
        await this.audit.record(
          actor,
          {
            action: p.config ? "merchant_rate.set" : "merchant_rate.remove",
            entityType: "merchant",
            entityId: p.merchantId,
            data: { config: p.config, note: p.note ?? null, requestedById },
          },
          meta,
          tx,
        );
        return { merchantId: p.merchantId, config: p.config };
      },
    });
  }

  private async currentRow(segment: Segment, db: Db): Promise<RateCard | null> {
    return db.rateCard.findFirst({
      where: { segment, active: true, effectiveFrom: { lte: new Date() } },
      orderBy: [{ effectiveFrom: "desc" }, { id: "desc" }],
    });
  }

  /** The card in force now: active, latest effectiveFrom not in the future. */
  async activeCard(segment: Segment, db: Db = this.prisma): Promise<{ id: string | null; config: RateCardConfig }> {
    const card = await this.currentRow(segment, db);
    return card ? { id: card.id, config: rateCardConfigSchema.parse(card.config) } : { id: null, config: DEFAULT_RATE_CARD };
  }

  /** The card in force for every segment (defaults where none exists yet). */
  async currentCards(db: Db = this.prisma): Promise<Record<Segment, CurrentCard>> {
    const rows = await Promise.all(SEGMENTS.map(s => this.currentRow(s, db)));
    return Object.fromEntries(
      SEGMENTS.map((segment, i) => {
        const row = rows[i];
        return [
          segment,
          row
            ? { id: row.id, name: row.name, effectiveFrom: row.effectiveFrom, config: rateCardConfigSchema.parse(row.config) }
            : { id: null, name: null, effectiveFrom: null, config: DEFAULT_RATE_CARD },
        ];
      }),
    ) as Record<Segment, CurrentCard>;
  }

  /** Price for a parcel. With a merchant, its own tariff (if any) applies on top of the segment card. */
  async quote(segment: Segment, input: QuoteInput & { dropOffHubId?: string | null }, db: Db = this.prisma, opts: { merchantId?: string | null } = {}) {
    const { dropOffHubId, ...rest } = input;
    // Hub drop-offs start their journey at the hub, so the hub's location is the origin.
    const origin = dropOffHubId ? await this.hubOrigin(dropOffHubId, db) : null;
    const priced: QuoteInput = origin ? { ...rest, pickupDistrict: origin.district, pickupZone: origin.zone } : rest;
    const [card, override] = await Promise.all([this.activeCard(segment, db), opts.merchantId ? this.merchantOverride(opts.merchantId, db) : null]);
    const config = applyRateOverride(card.config, override?.config);
    return { ...quoteParcel(config, priced), rateCardId: card.id, rateCard: config, merchantTariff: !!override, ...(origin ? { origin } : {}) };
  }

  /**
   * Where a hub drop-off is priced from: the hub's district and the catalog zone it is in (its
   * `zone` when set; else a zone it serves that its name or address mentions, else a catalog zone
   * of its district mentioned there, else the first zone it serves; empty when unknown, which
   * prices as cross-zone).
   */
  async hubOrigin(hubId: string, db: Db = this.prisma): Promise<PricingOrigin> {
    const hub = await db.hub.findUnique({
      where: { id: hubId },
      select: { id: true, name: true, district: true, zone: true, address: true, zones: { where: { active: true }, select: { name: true, district: true }, orderBy: { code: "asc" } } },
    });
    if (!hub) throw notFound("Hub");
    if (hub.zone?.trim()) return { kind: "DROP_OFF_HUB", hubId: hub.id, hub: hub.name, district: hub.district, zone: hub.zone.trim() };
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    const text = ` ${hub.name} ${hub.address} `.toLowerCase();
    const named = (zone: string) => new RegExp(`(^|[^a-z0-9])${zone.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(text);
    const served = hub.zones.filter(z => same(z.district, hub.district)).map(z => z.name);
    const catalog = await this.catalog(db, { includeInactive: true });
    const catalogZones = Object.entries(catalog.zonesByDistrict).find(([district]) => same(district, hub.district))?.[1] ?? [];
    const zone = served.find(named) ?? catalogZones.find(named) ?? served[0] ?? "";
    return { kind: "DROP_OFF_HUB", hubId: hub.id, hub: hub.name, district: hub.district, zone };
  }

  /** A merchant's own tariff (partial rate card), if set. Stored values that no longer validate are ignored. */
  async merchantOverride(merchantId: string, db: Db = this.prisma): Promise<{ config: RateCardOverride; note: string | null; updatedAt: Date } | null> {
    const row = await db.merchantRateOverride.findUnique({ where: { merchantId } });
    const parsed = row ? rateCardOverrideSchema.safeParse(row.config) : undefined;
    return row && parsed?.success ? { config: parsed.data, note: row.note, updatedAt: row.updatedAt } : null;
  }

  /** The merchant's segment card, its own tariff and the result bookings are priced with. */
  async merchantTariff(merchantId: string) {
    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId }, select: { id: true, name: true, type: true } });
    if (!merchant) throw notFound("Merchant");
    const segment: Segment = merchant.type === "BANKING_FINANCIAL" ? "BANKING_FINANCIAL" : "ECOMMERCE";
    const [card, override] = await Promise.all([this.activeCard(segment), this.merchantOverride(merchantId)]);
    return { merchantId, segment, override, segmentCard: card.config, effective: applyRateOverride(card.config, override?.config) };
  }

  setMerchantTariff(actor: Actor, merchantId: string, input: z.infer<typeof merchantRateSchema>, meta: RequestMeta) {
    return this.approvals.submit(actor, "merchant_rate.set", { ...input, merchantId }, meta);
  }

  listCards(segment?: Segment) {
    return this.prisma.rateCard.findMany({ where: { segment }, orderBy: [{ segment: "asc" }, { effectiveFrom: "desc" }, { id: "desc" }] });
  }

  /**
   * Rate cards are versioned: a new card replaces the current one from its effectiveFrom; old
   * cards stay for history. Needs a second super admin's approval (maker-checker).
   */
  createCard(actor: Actor, input: z.infer<typeof createRateCardSchema>, meta: RequestMeta) {
    return this.approvals.submit(actor, "rate_card.create", input, meta);
  }

  deactivateCard(actor: Actor, id: string, meta: RequestMeta) {
    return this.approvals.submit(actor, "rate_card.deactivate", { id }, meta);
  }

  /**
   * The service catalog. Without `includeInactive` (bookings, dropdowns, templates, imports) the
   * places deactivated in the geography admin are left out; existing records keep them, so code
   * that checks or prices an existing record passes `includeInactive: true`.
   */
  async catalog(db: Db = this.prisma, opts: { includeInactive?: boolean } = {}): Promise<Catalog> {
    const rows = await db.setting.findMany({ where: { key: { in: ["catalog", GEO_META_KEY] } } });
    const setting = rows.find(r => r.key === "catalog");
    // Read leniently: a stored catalog stays usable even if it predates a validation rule.
    const parsed = setting ? catalogShape.safeParse(setting.value) : undefined;
    const full = parsed?.success ? parsed.data : DEFAULT_CATALOG;
    return opts.includeInactive ? full : activeCatalog(full, normalizeMeta(rows.find(r => r.key === GEO_META_KEY)?.value));
  }

  /** Replaces the catalog lists (deactivated places the client can't see are kept; removed places must be unused). */
  async saveCatalog(actor: Actor, input: Catalog, meta: RequestMeta) {
    const catalog = await this.prisma.$transaction(async tx => {
      await lockGeography(tx);
      const prepared = await prepareCatalogSave(tx, input, await this.catalog(tx, { includeInactive: true }), await readMeta(tx));
      const catalog = catalogSchema.parse(prepared.catalog);
      const geo = prepared.meta as unknown as Prisma.InputJsonObject;
      await tx.setting.upsert({ where: { key: "catalog" }, create: { key: "catalog", value: catalog }, update: { value: catalog } });
      await tx.setting.upsert({ where: { key: GEO_META_KEY }, create: { key: GEO_META_KEY, value: geo }, update: { value: geo } });
      await this.audit.record(
        actor,
        {
          action: "catalog.update",
          entityType: "setting",
          entityId: "catalog",
          data: {
            districts: catalog.districts.length,
            zones: Object.values(catalog.zonesByDistrict).flat().length,
            areas: Object.values(catalog.areasByZone).flat().length,
          },
        },
        meta,
        tx,
      );
      return activeCatalog(catalog, prepared.meta);
    }, { timeout: 60_000 });
    this.realtime.publish({ type: "catalog.updated", id: "catalog", staffPermission: "support:create", data: { action: "catalog.update" } });
    return catalog;
  }
}
