import { merchantNotActive } from "../merchants/merchant-status";
import { HttpStatus, Injectable, OnModuleInit } from "@nestjs/common";
import {
  CORE_SERVICES,
  defaultServicesFor,
  FIRST_MILE_LABEL,
  isBanking,
  LAST_MILE_LABEL,
  normalizeServices,
  packageOptions,
  packagePricesSchema,
  packageProblems,
  PARCEL_NOTIFICATIONS,
  parseSpeedOption,
  priceParcel,
  PRICE_FIELDS,
  PRODUCT_TYPE_LABEL,
  PRODUCT_TYPES,
  productListOf,
  rateCardConfigSchema,
  resolveSelection,
  routeProblems,
  routeTier,
  ROUTE_TIER_LABEL,
  SEED_PRODUCTS,
  SEGMENT_LABEL,
  SERVICE_GROUP_LABEL,
  SERVICE_GROUPS,
  SERVICES,
  SPEED_LABEL,
  SPEED_SERVICE_LEVEL,
  speedFromDocumentType,
  type BookingSelection,
  type FirstMile,
  type LastMile,
  type PackagePrices,
  type PackageSegment,
  type PriceBreakdown,
  type ProductType,
  type RateCardConfig,
  type SelectionProblem,
  type SpeedOption,
} from "@delivery-fast/shared";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError, conflict, notFound } from "../../common/errors";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { Prisma, Segment } from "../../generated/prisma/client";
import { ApprovalsService, type SubmitResult } from "../approvals/approvals.service";
import { PricingService, type PricingOrigin } from "../pricing/pricing.service";
import { resolveZone } from "../network/zone-resolver";
import { zoneForArea } from "../parcels/places";
import { assignedPackage, defaultPackage, invalidatePackageCache, cached, remember, segmentOfMerchant, versionInForce, type PackageView } from "./package-resolver";
import { assignPackageSchema, createPackageSchema, packageSettingsSchema, packageVersionSchema, type AssignPackageInput, type CreatePackageInput, type PackageSettings, type PackageVersionInput } from "./packages.schemas";

export const SETTINGS_KEY = "service-packages-settings";
/** Marker of the v2 set-up (default packages, seeded products, old pricing retired). */
const MIGRATED_KEY = "service-packages-v2";
/** The snapshot engine of spec v2 (v1 snapshots, "package", are kept as booked and never re-priced). */
export const SNAPSHOT_ENGINE = "package-v2";
const DEFAULT_NAME: Record<PackageSegment, string> = { CUSTOMER: "Customer default", ECOMMERCE: "E-commerce default", BANKING_FINANCIAL: "Banking & Financial default" };

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

/** Who a quote / booking is for. */
export interface PackageSubject {
  merchantId?: string | null;
  segment?: PackageSegment;
}

/** A quote / booking request (POST /parcels, quotes, imports): places, parcel facts and the service choices. */
export interface QuoteRequest {
  pickup: { district: string; zone?: string | null; area?: string | null };
  delivery: { district: string; zone?: string | null; area?: string | null };
  weightKg?: number | null;
  codAmount?: number | null;
  firstMile?: FirstMile | null;
  lastMile?: LastMile | null;
  speed?: SpeedOption | null;
  openBox?: boolean | null;
  productType?: ProductType | null;
  /** A product name (quotes): its type is used when productType isn't given. */
  product?: string | null;
  dropHubId?: string | null;
  collectHubId?: string | null;
  notifications?: readonly string[] | null;
  /** Old fields: serviceLevel (SAME_DAY → Express), documentType ("B2B Document" → B2B). */
  serviceLevel?: string | null;
  documentType?: string | null;
}

export interface HubRef {
  id: string;
  code: string;
  name: string;
  address: string;
  district: string;
}

export interface PackageQuote extends PriceBreakdown {
  package: { id: string; name: string; versionId: string; version: number; isDefault: boolean };
  segment: PackageSegment;
  services: string[];
  prices: PackagePrices;
  selection: BookingSelection;
  /** The districts the route tier was priced from (the drop hub's / the collection hub's when chosen). */
  pickupDistrict: string;
  deliveryDistrict: string;
  dropHub: HubRef | null;
  collectHub: HubRef | null;
  /** Hub drop-offs: the hub's location (SLA and older snapshot readers). */
  origin: PricingOrigin | null;
  serviceLevel: "REGULAR" | "SAME_DAY" | "EXPRESS";
  returnPercent: number;
}

const hubSelect = { id: true, code: true, name: true, address: true, district: true, active: true } as const;

/**
 * Service packages (spec v2): resolution (which package applies), the server wrapper of the pricing
 * engine (district route tiers), booking enforcement, products, administration (maker-checker) and
 * the one-time set-up that retires the old pricing. See docs/architecture-contracts.md.
 */
@Injectable()
export class PackagesService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
    private readonly pricing: PricingService,
  ) {}

  // ───────────── resolution ─────────────

  /** The package in force for a merchant (its assignment, else its category default) or a category. */
  async effective(who: PackageSubject, db: Db = this.prisma): Promise<PackageView> {
    const key = who.merchantId ? `m:${who.merchantId}` : `s:${who.segment ?? "CUSTOMER"}`;
    const hit = cached(key);
    if (hit) return hit;
    await this.ensureMigrated();
    if (!who.merchantId) return remember(key, await this.defaultFor(who.segment ?? "CUSTOMER", db))!;
    const merchant = await db.merchant.findUnique({ where: { id: who.merchantId }, select: { type: true } });
    if (!merchant) throw notFound("Merchant");
    const segment = segmentOfMerchant(merchant.type);
    const { packageId } = await assignedPackage(db, who.merchantId);
    let view: PackageView | null = packageId ? await versionInForce(db, packageId) : null;
    if (view && view.segment !== segment) view = null;
    return remember(key, view ?? (await this.defaultFor(segment, db)))!;
  }

  private async defaultFor(segment: PackageSegment, db: Db): Promise<PackageView> {
    await this.ensureMigrated();
    const view = await defaultPackage(db, segment);
    if (!view) throw new AppError("NO_DEFAULT_PACKAGE", `The ${SEGMENT_LABEL[segment]} default package has no version in force yet`, HttpStatus.SERVICE_UNAVAILABLE);
    return view;
  }

  // ───────────── one-time set-up (v2) ─────────────

  /**
   * Once (marker Setting "service-packages-v2"): the three default packages with the owner's initial
   * prices (an existing default gets a new version), every other older package archived and its
   * merchants moved back to their default, the old products retired (deleted if unused, else
   * deactivated) and the owner's product lists seeded, and the old rate cards and service plans
   * deactivated. Ledger, audit and parcel history are never touched. Idempotent.
   */
  async ensureMigrated() {
    if (await this.prisma.setting.findUnique({ where: { key: MIGRATED_KEY } })) return;
    await this.prisma.$transaction(
      async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('service-packages-migrate'))`;
        if (await tx.setting.findUnique({ where: { key: MIGRATED_KEY } })) return;
        const now = new Date();
        const done = { defaults: 0, archived: 0, reassigned: 0, productsRetired: 0, productsSeeded: 0, rateCards: 0, plans: 0 };
        const defaults = new Set<string>();
        for (const segment of ["CUSTOMER", "ECOMMERCE", "BANKING_FINANCIAL"] as const) {
          const services = defaultServicesFor(segment);
          const prices = json(packagePricesSchema.parse({}));
          const existing = await tx.servicePackage.findUnique({ where: { defaultFor: segment }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } });
          if (existing) {
            await tx.servicePackage.update({ where: { id: existing.id }, data: { name: await this.freeName(tx, segment, DEFAULT_NAME[segment], existing.id), status: "ACTIVE" } });
            await tx.servicePackageVersion.create({ data: { packageId: existing.id, version: (existing.versions[0]?.version ?? 0) + 1, services, prices, effectiveFrom: now, note: "Service packages v2: route tiers, product types" } });
            defaults.add(existing.id);
          } else {
            const pkg = await tx.servicePackage.create({
              data: {
                segment,
                name: await this.freeName(tx, segment, DEFAULT_NAME[segment]),
                defaultFor: segment,
                source: `default:${segment}`,
                versions: { create: { version: 1, services, prices, effectiveFrom: new Date(0), note: "Default package (initial values)" } },
              },
            });
            defaults.add(pkg.id);
          }
          done.defaults++;
        }
        // Older (v1) packages: archived; their merchants book with their default again.
        const old = await tx.servicePackage.findMany({ where: { id: { notIn: [...defaults] }, status: "ACTIVE" }, select: { id: true } });
        if (old.length) {
          done.archived = (await tx.servicePackage.updateMany({ where: { id: { in: old.map(o => o.id) } }, data: { status: "ARCHIVED" } })).count;
          const merchants = await tx.packageAssignment.findMany({ where: { packageId: { in: old.map(o => o.id) } }, select: { merchantId: true }, distinct: ["merchantId"] });
          for (const m of merchants) await tx.packageAssignment.create({ data: { merchantId: m.merchantId, packageId: null, effectiveFrom: now, note: "Service packages v2: back to the default package" } });
          done.reassigned = merchants.length;
        }
        // Products: retire the old ones (delete if unused, else deactivate), seed the owner's lists.
        const seeded = new Set(Object.entries(SEED_PRODUCTS).flatMap(([segment, types]) => Object.values(types).flat().map(name => `${segment}|${name.toLowerCase()}`)));
        for (const p of await tx.parcelProduct.findMany({ include: { _count: { select: { parcels: true } } } })) {
          if (seeded.has(`${p.segment}|${p.name.toLowerCase()}`)) continue;
          if (p._count.parcels) await tx.parcelProduct.update({ where: { id: p.id }, data: { active: false } });
          else await tx.parcelProduct.delete({ where: { id: p.id } });
          done.productsRetired++;
        }
        done.productsSeeded = await this.seedProducts(tx);
        // Old pricing: no longer used for new prices (rows kept; nothing deleted).
        done.rateCards = (await tx.rateCard.updateMany({ where: { active: true }, data: { active: false } })).count;
        done.plans = (await tx.servicePlan.updateMany({ where: { active: true }, data: { active: false } })).count;
        await tx.setting.create({ data: { key: MIGRATED_KEY, value: { migratedAt: now.toISOString(), ...done } } });
        await this.audit.record("system", { action: "packages.migrate_v2", entityType: "setting", entityId: MIGRATED_KEY, data: done }, undefined, tx);
      },
      { timeout: 60_000 },
    );
    invalidatePackageCache();
  }

  /** The owner's product lists (spec v2): created or re-activated with their type; idempotent. Returns how many were created. */
  async seedProducts(db: Db) {
    let created = 0;
    for (const [segment, types] of Object.entries(SEED_PRODUCTS) as [Segment, Record<ProductType, readonly string[]>][])
      for (const type of PRODUCT_TYPES)
        for (const name of types[type]) {
          const existing = await db.parcelProduct.findFirst({ where: { segment, name: { equals: name, mode: "insensitive" } } });
          if (existing) {
            if (existing.type !== type || !existing.active) await db.parcelProduct.update({ where: { id: existing.id }, data: { type, active: true } });
          } else {
            await db.parcelProduct.create({ data: { segment, name, type } });
            created++;
          }
        }
    return created;
  }

  private async freeName(db: Db, segment: Segment, wanted: string, exceptId?: string) {
    let name = wanted.slice(0, 80);
    for (let i = 2; await db.servicePackage.findFirst({ where: { segment, name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } }); i++)
      name = `${wanted.slice(0, 74)} (${i})`;
    return name;
  }

  // ───────────── products ─────────────

  /** Active products of a category's list (Customer and E-commerce share one list). */
  async products(segment: PackageSegment, db: Db = this.prisma, includeInactive = false) {
    await this.ensureMigrated();
    return db.parcelProduct.findMany({ where: { segment: productListOf(segment), ...(includeInactive ? {} : { active: true }) }, orderBy: [{ type: "asc" }, { name: "asc" }] });
  }

  /**
   * The product of a booking (optional: none = Regular). An unknown name is refused (422
   * UNKNOWN_PRODUCT); `fallback` (the old `contents` field) is used only when it names a product.
   */
  async resolveProduct(
    segment: PackageSegment,
    raw: string | null | undefined,
    db: Db = this.prisma,
    list?: { id: string; name: string; type: string; sendMessages: boolean }[],
    fallback?: string | null,
  ): Promise<{ id: string; name: string; type: string; sendMessages: boolean } | null> {
    const products = list ?? (await this.products(segment, db));
    const wanted = (raw ?? fallback)?.trim().toLowerCase();
    if (!wanted) return null;
    const hit = products.find(p => p.id === raw || p.name.toLowerCase() === wanted);
    if (hit) return hit;
    if (!raw) return null; // `contents` free text that isn't a product
    throw new AppError("UNKNOWN_PRODUCT", `"${raw}" is not one of the products`, 422, [{ path: "product", code: "UNKNOWN_PRODUCT", message: `Choose a product from the ${SEGMENT_LABEL[segment]} list` }]);
  }

  // ───────────── quotes and bookings ─────────────

  /** Throws the selection problems as one 422 (SERVICE_NOT_IN_PACKAGE first). */
  selectionError(problems: SelectionProblem[]) {
    const first = problems.find(p => p.code === "SERVICE_NOT_IN_PACKAGE") ?? problems[0];
    return new AppError(first.code, problems.map(p => p.message).join("; "), 422, problems.map(p => ({ path: p.field, code: p.code, message: p.message })));
  }

  private async hub(db: Db, id: string, what: "drop" | "collection"): Promise<HubRef> {
    const hub = await db.hub.findUnique({ where: { id }, select: hubSelect });
    if (!hub) throw notFound(what === "drop" ? "Drop-off hub" : "Collection hub");
    if (!hub.active) throw new AppError("HUB_INACTIVE", `${hub.name} isn't operating`, 422, [{ path: what === "drop" ? "dropHubId" : "collectHubId", code: "HUB_INACTIVE", message: `${hub.name} isn't operating` }]);
    return hub;
  }

  /** The hub serving a place (its delivery zone's hub), memoised per file / request when a map is given. */
  private async servingHub(db: Db, place: { district: string; zone?: string | null; area?: string | null }, memo?: Map<string, HubRef | null>): Promise<HubRef | null> {
    if (!place.district || !place.zone) return null;
    const key = `${place.district}|${place.zone}|${place.area ?? ""}`.toLowerCase();
    if (memo?.has(key)) return memo.get(key) ?? null;
    const zone = await resolveZone(db, { district: place.district, zone: place.zone, area: place.area });
    const hub = zone?.hubId ? await db.hub.findUnique({ where: { id: zone.hubId }, select: hubSelect }) : null;
    memo?.set(key, hub);
    return hub;
  }

  /** The service of a request: `speed`, else the old document type / service level. */
  speedOf(segment: PackageSegment, input: Pick<QuoteRequest, "speed" | "serviceLevel" | "documentType">): SpeedOption | undefined {
    if (input.speed) return input.speed;
    const fromDoc = isBanking(segment) ? speedFromDocumentType(input.documentType) : undefined;
    if (fromDoc) return fromDoc;
    // Old `serviceLevel` field (API integrations): SAME_DAY still means Express.
    const level = input.serviceLevel ? (/^same[\s_-]*day$/i.test(String(input.serviceLevel).trim()) ? "EXPRESS" : parseSpeedOption(input.serviceLevel)) : undefined;
    return level && level !== "REGULAR" ? level : undefined;
  }

  /** A pickup "zone" that is really an area (merchant profiles keep an area): the catalog zone it belongs to. */
  async normalizePickup<T extends { pickup: { district: string; zone?: string | null } }>(input: T): Promise<T> {
    if (!input.pickup.zone) return input;
    const catalog = await this.pricing.catalog();
    return { ...input, pickup: { ...input.pickup, zone: zoneForArea(catalog, input.pickup.district, input.pickup.zone) } };
  }

  /**
   * The server wrapper of the pricing engine: the package in force, the booking defaults and
   * enforcement, the districts (drop hub / collection hub when chosen) and the route tier, then
   * `priceParcel`. Throws 422 for anything the package doesn't include (SERVICE_NOT_IN_PACKAGE) and for
   * Express outside the same district (Customer / E-commerce).
   */
  async quote(who: PackageSubject, input: QuoteRequest, db: Db = this.prisma, opts: { pkg?: PackageView; hubs?: Map<string, HubRef | null> } = {}): Promise<PackageQuote> {
    const pkg = opts.pkg ?? (await this.effective(who, db));
    const segment = pkg.segment;
    const { selection, problems } = resolveSelection(segment, pkg.services, {
      firstMile: input.firstMile ?? (input.dropHubId ? "HUB_DROP" : undefined),
      lastMile: input.lastMile ?? (input.collectHubId ? "HUB_COLLECT" : undefined),
      speed: this.speedOf(segment, input),
      productType: input.productType ?? (input.product ? ((await this.resolveProduct(segment, input.product, db))?.type as ProductType | undefined) : undefined),
      openBox: input.openBox,
      codAmount: input.codAmount,
      weightKg: input.weightKg,
      notifications: input.notifications,
    });
    if (problems.length) throw this.selectionError(problems);

    let dropHub: HubRef | null = null;
    let origin: PricingOrigin | null = null;
    if (selection.firstMile === "HUB_DROP") {
      if (!input.dropHubId) throw new AppError("DROP_HUB_REQUIRED", "Choose the hub the parcel is dropped at", 422, [{ path: "dropHubId", code: "DROP_HUB_REQUIRED", message: "Choose the drop-off hub" }]);
      dropHub = await this.hub(db, input.dropHubId, "drop");
      origin = await this.pricing.hubOrigin(dropHub.id, db);
    }
    let collectHub: HubRef | null = null;
    if (selection.lastMile === "HUB_COLLECT") {
      collectHub = input.collectHubId ? await this.hub(db, input.collectHubId, "collection") : await this.servingHub(db, input.delivery, opts.hubs);
      if (!collectHub)
        throw new AppError("COLLECT_HUB_UNKNOWN", `No hub serves ${input.delivery.zone || "the recipient's zone"} yet; choose the collection hub`, 422, [{ path: "collectHubId", code: "COLLECT_HUB_UNKNOWN", message: "Choose the collection hub" }]);
    }
    const pickupDistrict = dropHub?.district ?? input.pickup.district;
    const deliveryDistrict = collectHub?.district ?? input.delivery.district;
    const tier = routeTier(pickupDistrict, deliveryDistrict);
    const routeIssues = routeProblems(segment, tier, selection.speed);
    if (routeIssues.length) throw this.selectionError(routeIssues);
    const breakdown = priceParcel(pkg.prices, { segment, services: pkg.services, tier, selection });
    return {
      ...breakdown,
      package: { id: pkg.packageId, name: pkg.name, versionId: pkg.versionId, version: pkg.version, isDefault: pkg.isDefault },
      segment,
      services: pkg.services,
      prices: pkg.prices,
      selection,
      pickupDistrict,
      deliveryDistrict,
      dropHub,
      collectHub,
      origin,
      serviceLevel: SPEED_SERVICE_LEVEL[selection.speed],
      returnPercent: pkg.prices.returnPercent,
    };
  }

  /** The frozen price snapshot stored on the parcel (Parcel.pricingSnapshot). */
  snapshot(q: PackageQuote, extra: Record<string, unknown> = {}): Prisma.InputJsonObject {
    const hubRef = (h: HubRef | null) => (h ? { id: h.id, code: h.code, name: h.name, district: h.district } : null);
    return json({
      engine: SNAPSHOT_ENGINE,
      packageId: q.package.id,
      packageName: q.package.name,
      versionId: q.package.versionId,
      version: q.package.version,
      segment: q.segment,
      prices: q.prices,
      services: q.services,
      tier: q.tier,
      pickupDistrict: q.pickupDistrict,
      deliveryDistrict: q.deliveryDistrict,
      dropHub: hubRef(q.dropHub),
      collectHub: hubRef(q.collectHub),
      selection: q.selection,
      lines: q.lines,
      deliveryCharge: q.deliveryCharge,
      codFee: q.codFee,
      total: q.totalCharge,
      ...(q.origin ? { origin: { ...q.origin } } : {}),
      ...extra,
    }) as Prisma.InputJsonObject;
  }

  /** Parcel columns for a package-priced booking (charges, choices, frozen services and notifications). */
  parcelFields(q: PackageQuote, product: { id: string | null; name: string; sendMessages: boolean } | null) {
    return {
      baseCharge: q.columns.baseCharge,
      weightCharge: q.columns.weightCharge,
      serviceCharge: q.columns.serviceCharge,
      codFee: q.columns.codFee,
      discount: q.columns.discount,
      totalCharge: q.totalCharge,
      packageVersionId: q.package.versionId,
      firstMile: q.selection.firstMile,
      lastMile: q.selection.lastMile,
      speedOption: q.selection.speed,
      openBox: q.selection.openBox,
      onDemand: q.selection.firstMile === "ON_DEMAND_PICKUP" || q.selection.speed === "ON_DEMAND",
      productId: product?.id ?? null,
      productName: product?.name ?? null,
      productType: q.selection.productType,
      services: q.services,
      // The booking's ticked messages (default: every message in the package); none when the product sends no messages.
      notifications: product && !product.sendMessages ? [] : q.selection.notifications,
      collectHubId: q.collectHub?.id ?? null,
      serviceLevel: q.serviceLevel,
    };
  }

  /** Everything a booking form needs for this merchant / category (GET /packages/me, /packages/effective). */
  /** Merchant-facing package reads: only for active merchants (see MerchantsService.resolveOwn). */
  async assertActiveMerchant(merchantId: string) {
    const m = await this.prisma.merchant.findUnique({ where: { id: merchantId }, select: { status: true } });
    if (!m) throw notFound("Merchant");
    if (m.status !== "ACTIVE") throw merchantNotActive(m.status);
  }

  async bookingView(who: PackageSubject, db: Db = this.prisma) {
    const pkg = await this.effective(who, db);
    const [products, hubs] = await Promise.all([
      this.products(pkg.segment, db),
      db.hub.findMany({ where: { active: true }, select: { id: true, code: true, name: true, address: true, district: true, type: true }, orderBy: { name: "asc" } }),
    ]);
    const options = packageOptions(pkg.segment, pkg.services);
    const has = new Set(pkg.services);
    return {
      segment: pkg.segment,
      segmentLabel: SEGMENT_LABEL[pkg.segment],
      package: { id: pkg.packageId, name: pkg.name, version: pkg.version, versionId: pkg.versionId, isDefault: pkg.isDefault, effectiveFrom: pkg.effectiveFrom },
      services: pkg.services,
      options,
      labels: { firstMile: FIRST_MILE_LABEL, lastMile: LAST_MILE_LABEL, speed: SPEED_LABEL, tier: ROUTE_TIER_LABEL, productType: PRODUCT_TYPE_LABEL },
      notifications: PARCEL_NOTIFICATIONS.filter(n => options.notifications.includes(n.code)).map(n => ({ code: n.code, label: n.label, audience: n.audience, title: `${n.label} (${n.audience})` })),
      products: products.map(p => ({ id: p.id, name: p.name, type: p.type, sendMessages: p.sendMessages })),
      prices: pkg.prices,
      dropHubs: options.firstMiles.includes("HUB_DROP") ? hubs : [],
      collectHubs: options.lastMiles.includes("HUB_COLLECT") ? hubs : [],
      entitlements: {
        supportTickets: has.has("support.tickets"),
        api: has.has("integration.api"),
        webhooks: has.has("integration.webhooks"),
        push: has.has("integration.push"),
        liveLocation: has.has("tracking.live_location"),
        riderPhone: has.has("tracking.rider_phone"),
      },
    };
  }

  /** Re-prices a v2 package-priced parcel with its frozen package (weight / destination / first mile changes); null for other parcels. */
  async reprice(
    parcel: { pricingSnapshot: unknown; pickupDistrict: string; pickupZone: string; pickupArea?: string | null; deliveryDistrict: string | null; deliveryZone: string | null; deliveryArea?: string | null; codAmount: Prisma.Decimal | number; weightKg: Prisma.Decimal | number; collectHubId?: string | null; dropOffHubId?: string | null },
    changes: Partial<QuoteRequest> & { delivery?: { district: string; zone?: string | null; area?: string | null } },
    db: Db = this.prisma,
  ): Promise<PackageQuote | null> {
    const snap = (parcel.pricingSnapshot ?? {}) as { engine?: string; segment?: PackageSegment; packageId?: string; packageName?: string; versionId?: string; version?: number; prices?: unknown; services?: string[]; selection?: BookingSelection; destination?: { district: string; zone: string } };
    if (snap.engine !== SNAPSHOT_ENGINE || !snap.selection || !snap.services) return null;
    const pkg: PackageView = {
      packageId: snap.packageId ?? "",
      name: snap.packageName ?? "",
      segment: snap.segment ?? "ECOMMERCE",
      isDefault: false,
      status: "ACTIVE",
      versionId: snap.versionId ?? "",
      version: snap.version ?? 1,
      effectiveFrom: new Date(0),
      services: snap.services,
      prices: packagePricesSchema.parse(snap.prices ?? {}),
    };
    const s = snap.selection;
    const delivery = changes.delivery ?? { district: parcel.deliveryDistrict ?? snap.destination?.district ?? parcel.pickupDistrict, zone: parcel.deliveryZone ?? snap.destination?.zone ?? parcel.pickupZone, area: parcel.deliveryArea };
    return this.quote(
      {},
      {
        pickup: { district: parcel.pickupDistrict, zone: parcel.pickupZone, area: parcel.pickupArea },
        delivery,
        weightKg: changes.weightKg ?? Number(parcel.weightKg),
        codAmount: changes.codAmount ?? Number(parcel.codAmount),
        firstMile: changes.firstMile ?? s.firstMile,
        lastMile: changes.lastMile ?? s.lastMile,
        speed: changes.speed ?? s.speed,
        productType: changes.productType ?? s.productType,
        openBox: changes.openBox ?? s.openBox,
        dropHubId: changes.firstMile && changes.firstMile !== "HUB_DROP" ? null : (changes.dropHubId ?? parcel.dropOffHubId),
        collectHubId: changes.collectHubId ?? parcel.collectHubId,
        notifications: s.notifications,
      },
      db,
      { pkg },
    );
  }

  // ───────────── administration ─────────────

  catalogView() {
    return {
      segments: (["ECOMMERCE", "BANKING_FINANCIAL", "CUSTOMER"] as const).map(s => ({ code: s, label: SEGMENT_LABEL[s] })),
      groups: SERVICE_GROUPS.map(g => ({ code: g, label: SERVICE_GROUP_LABEL[g] })),
      services: SERVICES,
      core: CORE_SERVICES,
      priceFields: PRICE_FIELDS,
      defaults: packagePricesSchema.parse({}),
      labels: { firstMile: FIRST_MILE_LABEL, lastMile: LAST_MILE_LABEL, speed: SPEED_LABEL, tier: ROUTE_TIER_LABEL, productType: PRODUCT_TYPE_LABEL },
      productTypes: PRODUCT_TYPES.map(t => ({ code: t, label: PRODUCT_TYPE_LABEL[t] })),
      notifications: PARCEL_NOTIFICATIONS,
    };
  }

  async list(query: { segment?: Segment; status?: "ACTIVE" | "ARCHIVED" }) {
    await this.ensureMigrated();
    const rows = await this.prisma.servicePackage.findMany({
      where: { segment: query.segment, status: query.status },
      include: { versions: { orderBy: { version: "desc" } }, _count: { select: { assignments: true } } },
      orderBy: [{ segment: "asc" }, { name: "asc" }],
    });
    const now = new Date();
    const assigned = await this.currentAssignmentCounts();
    return rows.map(p => this.packageView(p, now, assigned.get(p.id) ?? 0));
  }

  /** Merchants whose assignment in force points at each package. */
  private async currentAssignmentCounts() {
    const rows = await this.prisma.$queryRaw<{ packageId: string; n: bigint }[]>`
      SELECT "packageId", count(*) AS n FROM (
        SELECT DISTINCT ON ("merchantId") "merchantId", "packageId" FROM package_assignments
        WHERE "effectiveFrom" <= now() ORDER BY "merchantId", "effectiveFrom" DESC, "createdAt" DESC
      ) a WHERE "packageId" IS NOT NULL GROUP BY "packageId"`;
    return new Map(rows.map(r => [r.packageId, Number(r.n)]));
  }

  private packageView(
    p: Prisma.ServicePackageGetPayload<{ include: { versions: true } }>,
    now: Date,
    merchants: number,
  ) {
    const versions = [...p.versions].sort((a, b) => b.version - a.version);
    const current = versions.filter(v => v.effectiveFrom <= now).sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime() || b.version - a.version)[0] ?? null;
    const scheduled = versions.filter(v => v.effectiveFrom > now).sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
    const v = (x: (typeof versions)[number]) => ({ id: x.id, version: x.version, services: x.services, prices: packagePricesSchema.parse(x.prices ?? {}), effectiveFrom: x.effectiveFrom, note: x.note, createdAt: x.createdAt, changeRequestId: x.changeRequestId });
    return {
      id: p.id,
      segment: p.segment,
      segmentLabel: SEGMENT_LABEL[p.segment as PackageSegment],
      name: p.name,
      description: p.description,
      isDefault: p.defaultFor === p.segment,
      status: p.status,
      source: p.source,
      merchants,
      current: current ? v(current) : null,
      scheduled: scheduled.map(v),
      versions: versions.map(v),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  async get(id: string) {
    const p = await this.prisma.servicePackage.findUnique({ where: { id }, include: { versions: true } });
    if (!p) throw notFound("Package");
    const assigned = await this.currentAssignmentCounts();
    const assignments = await this.prisma.packageAssignment.findMany({
      where: { packageId: id },
      include: { merchant: { select: { id: true, code: true, name: true } } },
      orderBy: { effectiveFrom: "desc" },
      take: 200,
    });
    const parcels = await this.prisma.parcel.count({ where: { packageVersion: { packageId: id } } });
    return {
      ...this.packageView(p, new Date(), assigned.get(id) ?? 0),
      parcels,
      assignments: assignments.map(a => ({ id: a.id, merchant: a.merchant, effectiveFrom: a.effectiveFrom, note: a.note, createdAt: a.createdAt })),
    };
  }

  private checkContent(segment: PackageSegment, services: string[], prices: PackagePrices) {
    const normalized = normalizeServices(segment, services);
    const problems = packageProblems(segment, services);
    if (problems.length) throw new AppError("INVALID_PACKAGE", problems.join("; "), 422, problems.map(message => ({ path: "services", message })));
    return { services: normalized, prices };
  }

  // The one-time set-up runs before any change, so it never archives a package created after it.
  async create(actor: Actor, input: CreatePackageInput, meta: RequestMeta) {
    await this.ensureMigrated();
    return this.approvals.submit(actor, "package.create", input, meta);
  }
  async addVersion(actor: Actor, id: string, input: PackageVersionInput, meta: RequestMeta) {
    await this.ensureMigrated();
    return this.approvals.submit(actor, "package.version", { ...input, packageId: id }, meta);
  }
  setDefault(actor: Actor, id: string, meta: RequestMeta) {
    return this.approvals.submit(actor, "package.set_default", { packageId: id }, meta);
  }
  archive(actor: Actor, id: string, meta: RequestMeta) {
    return this.approvals.submit(actor, "package.archive", { packageId: id }, meta);
  }
  async assign(actor: Actor, merchantId: string, input: AssignPackageInput, meta: RequestMeta) {
    await this.ensureMigrated();
    return this.approvals.submit(actor, "package.assign", { ...input, merchantId }, meta);
  }

  /** Deletes a package nothing ever used (else archive it). */
  async remove(actor: Actor, id: string, meta: RequestMeta) {
    const p = await this.prisma.servicePackage.findUnique({ where: { id }, include: { _count: { select: { assignments: true } } } });
    if (!p) throw notFound("Package");
    const parcels = await this.prisma.parcel.count({ where: { packageVersion: { packageId: id } } });
    if (p.defaultFor || p._count.assignments || parcels)
      throw new AppError("PACKAGE_IN_USE", `${p.name} is ${p.defaultFor ? "the default package" : parcels ? `used by ${parcels} parcel(s)` : "assigned to merchants"}: archive it instead`, HttpStatus.CONFLICT, {
        isDefault: !!p.defaultFor,
        assignments: p._count.assignments,
        parcels,
      });
    await this.prisma.$transaction(async tx => {
      await tx.servicePackage.delete({ where: { id } });
      await this.audit.record(actor, { action: "package.delete", entityType: "service_package", entityId: id, data: { name: p.name, segment: p.segment } }, meta, tx);
    });
    invalidatePackageCache();
    return { deleted: true };
  }

  /** A merchant's package now, its scheduled change and its history. */
  async merchantPackage(merchantId: string) {
    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId }, select: { id: true, code: true, name: true, type: true } });
    if (!merchant) throw notFound("Merchant");
    const current = await this.effective({ merchantId });
    const history = await this.prisma.packageAssignment.findMany({ where: { merchantId }, include: { package: { select: { id: true, name: true } } }, orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }] });
    const now = new Date();
    return {
      merchant,
      segment: segmentOfMerchant(merchant.type),
      current: { packageId: current.packageId, name: current.name, isDefault: current.isDefault, version: current.version, services: current.services, prices: current.prices },
      scheduled: history.filter(h => h.effectiveFrom > now).map(h => ({ package: h.package, effectiveFrom: h.effectiveFrom, note: h.note })),
      history: history.map(h => ({ package: h.package, effectiveFrom: h.effectiveFrom, note: h.note, createdAt: h.createdAt })),
    };
  }

  /** Every merchant of a segment with the package it books with now and any scheduled change (super admin assignment table). */
  async assignments(segment: "ECOMMERCE" | "BANKING_FINANCIAL") {
    await this.ensureMigrated();
    const merchants = await this.prisma.merchant.findMany({ where: { type: segment }, select: { id: true, code: true, name: true, status: true }, orderBy: { name: "asc" }, take: 2000 });
    const now = new Date();
    const rows = await this.prisma.packageAssignment.findMany({ where: { merchantId: { in: merchants.map(m => m.id) } }, include: { package: { select: { id: true, name: true } } }, orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }] });
    const def = await this.prisma.servicePackage.findUnique({ where: { defaultFor: segment }, select: { id: true, name: true } });
    return merchants.map(m => {
      const mine = rows.filter(r => r.merchantId === m.id);
      const current = mine.find(r => r.effectiveFrom <= now);
      const pkg = current ? (current.package ?? def) : def;
      return {
        merchant: { id: m.id, code: m.code, name: m.name, status: m.status },
        package: pkg ? { id: pkg.id, name: pkg.name, isDefault: pkg.id === def?.id } : null,
        since: current?.effectiveFrom ?? null,
        scheduled: mine.filter(r => r.effectiveFrom > now).map(r => ({ package: r.package ?? def, effectiveFrom: r.effectiveFrom })),
      };
    });
  }

  /** Price simulator: a stored package (version in force) or the editor's draft. */
  async simulate(input: QuoteRequest & { packageId?: string; segment: PackageSegment; services?: string[]; prices?: PackagePrices; merchantId?: string }) {
    let pkg: PackageView | null = null;
    if (input.packageId) pkg = await versionInForce(this.prisma, input.packageId);
    else if (input.services && input.prices) {
      const { services, prices } = this.checkContent(input.segment, input.services, input.prices);
      pkg = { packageId: "draft", name: "Draft", segment: input.segment, isDefault: false, status: "ACTIVE", versionId: "draft", version: 0, effectiveFrom: new Date(), services, prices };
    } else pkg = await this.effective(input.merchantId ? { merchantId: input.merchantId } : { segment: input.segment });
    if (!pkg) throw notFound("Package version in force");
    return this.quote({}, input, this.prisma, { pkg });
  }

  async settings(db: Db = this.prisma): Promise<PackageSettings> {
    const row = await db.setting.findUnique({ where: { key: SETTINGS_KEY } });
    const parsed = packageSettingsSchema.safeParse(row?.value ?? {});
    return parsed.success ? parsed.data : packageSettingsSchema.parse({});
  }

  async saveSettings(actor: Actor, input: PackageSettings, meta: RequestMeta) {
    await this.prisma.$transaction(async tx => {
      await tx.setting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value: input }, update: { value: input } });
      await this.audit.record(actor, { action: "package_settings.update", entityType: "setting", entityId: SETTINGS_KEY, data: input }, meta, tx);
    });
    return this.settings();
  }

  // ───────────── old pricing readers ─────────────

  /** The default packages' route prices in the old rate card shape (platform-config pages that still read rate cards). */
  async legacyCards(db: Db = this.prisma): Promise<Record<Segment, { id: string | null; name: string | null; effectiveFrom: Date | null; config: RateCardConfig }>> {
    const segments = ["CUSTOMER", "ECOMMERCE", "BANKING_FINANCIAL"] as const;
    const views = await Promise.all(segments.map(s => this.effective({ segment: s }, db)));
    return Object.fromEntries(segments.map((segment, i) => [segment, { id: views[i].versionId, name: views[i].name, effectiveFrom: views[i].effectiveFrom, config: legacyCardOf(views[i].prices) }])) as Record<
      Segment,
      { id: string | null; name: string | null; effectiveFrom: Date | null; config: RateCardConfig }
    >;
  }

  // ───────────── maker-checker handlers ─────────────

  onModuleInit() {
    this.approvals.register<CreatePackageInput>({
      kind: "package.create",
      prepare: async (payload, db) => {
        const p = createPackageSchema.parse(payload);
        const content = this.checkContent(p.segment, p.services, p.prices);
        if (await db.servicePackage.findFirst({ where: { segment: p.segment, name: { equals: p.name, mode: "insensitive" } } })) throw conflict("PACKAGE_NAME_TAKEN", `There is already a ${SEGMENT_LABEL[p.segment]} package called ${p.name}`);
        return { ...p, ...content };
      },
      summary: p => `New ${SEGMENT_LABEL[p.segment]} package "${p.name}"${p.makeDefault ? " (default)" : ""}`,
      apply: async (tx, p, { actor, requestedById, meta }) => {
        if (p.makeDefault) await tx.servicePackage.updateMany({ where: { defaultFor: p.segment }, data: { defaultFor: null } });
        const pkg = await tx.servicePackage.create({
          data: {
            segment: p.segment,
            name: p.name,
            description: p.description,
            defaultFor: p.makeDefault ? p.segment : null,
            createdById: requestedById,
            versions: { create: { version: 1, services: p.services, prices: json(p.prices), effectiveFrom: p.effectiveFrom ? new Date(p.effectiveFrom) : new Date(), note: p.note, createdById: requestedById } },
          },
        });
        await this.audit.record(actor, { action: "package.create", entityType: "service_package", entityId: pkg.id, data: json({ segment: p.segment, name: p.name, services: p.services, prices: p.prices, makeDefault: p.makeDefault, requestedById }) }, meta, tx);
        invalidatePackageCache();
        return json(pkg);
      },
      afterCommit: async () => invalidatePackageCache(),
    });
    this.approvals.register<PackageVersionInput & { packageId: string; segment: PackageSegment; packageName: string }>({
      kind: "package.version",
      prepare: async (payload, db) => {
        const { packageId } = payload as { packageId: string };
        const p = packageVersionSchema.parse(payload);
        const pkg = await db.servicePackage.findUnique({ where: { id: packageId } });
        if (!pkg) throw notFound("Package");
        if (pkg.status === "ARCHIVED") throw conflict("PACKAGE_ARCHIVED", `${pkg.name} is archived`);
        if (p.name && p.name.toLowerCase() !== pkg.name.toLowerCase() && (await db.servicePackage.findFirst({ where: { segment: pkg.segment, name: { equals: p.name, mode: "insensitive" } } })))
          throw conflict("PACKAGE_NAME_TAKEN", `There is already a package called ${p.name}`);
        return { ...p, ...this.checkContent(pkg.segment as PackageSegment, p.services, p.prices), packageId, segment: pkg.segment as PackageSegment, packageName: pkg.name };
      },
      summary: p => `New version of the package "${p.packageName}"${p.effectiveFrom ? ` from ${new Date(p.effectiveFrom).toISOString().slice(0, 10)}` : ""}`,
      apply: async (tx, p, { actor, requestedById, meta }) => {
        const last = await tx.servicePackageVersion.findFirst({ where: { packageId: p.packageId }, orderBy: { version: "desc" }, select: { version: true } });
        const version = await tx.servicePackageVersion.create({
          data: { packageId: p.packageId, version: (last?.version ?? 0) + 1, services: p.services, prices: json(p.prices), effectiveFrom: p.effectiveFrom ? new Date(p.effectiveFrom) : new Date(), note: p.note, createdById: requestedById },
        });
        if (p.name || p.description !== undefined) await tx.servicePackage.update({ where: { id: p.packageId }, data: { ...(p.name ? { name: p.name } : {}), ...(p.description !== undefined ? { description: p.description } : {}) } });
        await this.audit.record(actor, { action: "package.version", entityType: "service_package", entityId: p.packageId, data: json({ version: version.version, services: p.services, prices: p.prices, effectiveFrom: version.effectiveFrom, requestedById }) }, meta, tx);
        invalidatePackageCache();
        return json(version);
      },
      afterCommit: async () => invalidatePackageCache(),
    });
    this.approvals.register<{ packageId: string; segment: Segment; name: string }>({
      kind: "package.set_default",
      prepare: async (payload, db) => {
        const { packageId } = payload as { packageId: string };
        const pkg = await db.servicePackage.findUnique({ where: { id: packageId } });
        if (!pkg) throw notFound("Package");
        if (pkg.status === "ARCHIVED") throw conflict("PACKAGE_ARCHIVED", `${pkg.name} is archived`);
        if (pkg.defaultFor) throw conflict("ALREADY_DEFAULT", `${pkg.name} is already the default package`);
        if (!(await versionInForce(db, pkg.id))) throw conflict("NO_VERSION_IN_FORCE", `${pkg.name} has no version in force yet`);
        return { packageId, segment: pkg.segment, name: pkg.name };
      },
      summary: p => `Make "${p.name}" the default ${SEGMENT_LABEL[p.segment as PackageSegment]} package`,
      apply: async (tx, p, { actor, requestedById, meta }) => {
        await tx.servicePackage.updateMany({ where: { defaultFor: p.segment }, data: { defaultFor: null } });
        await tx.servicePackage.update({ where: { id: p.packageId }, data: { defaultFor: p.segment } });
        await this.audit.record(actor, { action: "package.set_default", entityType: "service_package", entityId: p.packageId, data: { segment: p.segment, requestedById } }, meta, tx);
        invalidatePackageCache();
        return { packageId: p.packageId, segment: p.segment };
      },
      afterCommit: async () => invalidatePackageCache(),
    });
    this.approvals.register<{ packageId: string; name: string }>({
      kind: "package.archive",
      prepare: async (payload, db) => {
        const { packageId } = payload as { packageId: string };
        const pkg = await db.servicePackage.findUnique({ where: { id: packageId } });
        if (!pkg) throw notFound("Package");
        if (pkg.defaultFor) throw conflict("PACKAGE_IS_DEFAULT", `${pkg.name} is the default package: make another package the default first`);
        if (pkg.status === "ARCHIVED") throw conflict("PACKAGE_ARCHIVED", `${pkg.name} is already archived`);
        return { packageId, name: pkg.name };
      },
      summary: p => `Archive the package "${p.name}"`,
      apply: async (tx, p, { actor, requestedById, meta }) => {
        await tx.servicePackage.update({ where: { id: p.packageId }, data: { status: "ARCHIVED" } });
        await this.audit.record(actor, { action: "package.archive", entityType: "service_package", entityId: p.packageId, data: { requestedById } }, meta, tx);
        invalidatePackageCache();
        return { packageId: p.packageId, status: "ARCHIVED" };
      },
      afterCommit: async () => invalidatePackageCache(),
    });
    this.approvals.register<AssignPackageInput & { merchantId: string; merchantName: string; packageName: string }>({
      kind: "package.assign",
      prepare: async (payload, db) => {
        const p = assignPackageSchema.parse(payload);
        const { merchantId } = payload as { merchantId: string };
        const merchant = await db.merchant.findUnique({ where: { id: merchantId }, select: { name: true, type: true } });
        if (!merchant) throw notFound("Merchant");
        let packageName = "the default package";
        if (p.packageId) {
          const pkg = await db.servicePackage.findUnique({ where: { id: p.packageId } });
          if (!pkg) throw notFound("Package");
          if (pkg.status === "ARCHIVED") throw conflict("PACKAGE_ARCHIVED", `${pkg.name} is archived`);
          if (pkg.segment !== segmentOfMerchant(merchant.type))
            throw new AppError("PACKAGE_SEGMENT_MISMATCH", `${pkg.name} is a ${SEGMENT_LABEL[pkg.segment as PackageSegment]} package; ${merchant.name} is a ${SEGMENT_LABEL[segmentOfMerchant(merchant.type)]} merchant`, 422);
          packageName = pkg.name;
        }
        return { ...p, merchantId, merchantName: merchant.name, packageName };
      },
      summary: p => `Assign ${p.packageName} to ${p.merchantName}${p.effectiveFrom ? ` from ${new Date(p.effectiveFrom).toISOString().slice(0, 10)}` : ""}`,
      apply: async (tx, p, { actor, requestedById, meta }) => {
        const row = await tx.packageAssignment.create({ data: { merchantId: p.merchantId, packageId: p.packageId, effectiveFrom: p.effectiveFrom ? new Date(p.effectiveFrom) : new Date(), note: p.note, createdById: requestedById } });
        await this.audit.record(actor, { action: "package.assign", entityType: "merchant", entityId: p.merchantId, data: json({ packageId: p.packageId, packageName: p.packageName, effectiveFrom: row.effectiveFrom, requestedById }) }, meta, tx);
        invalidatePackageCache();
        return json(row);
      },
      afterCommit: async () => invalidatePackageCache(),
    });
  }
}

/** 202 while a second super admin must approve; else the result. */
export function changeResponse(reply: { status(code: number): unknown }, result: SubmitResult) {
  if (result.status === "APPLIED") return result.result;
  reply.status(202);
  return result;
}

/** Package prices in the old rate card shape (same-zone = inside same district, cross-zone = different district). */
export function legacyCardOf(prices: PackagePrices): RateCardConfig {
  return rateCardConfigSchema.parse({
    sameZone: prices.sameDistrict,
    crossZone: prices.differentDistrict,
    includedWeightKg: 0.5,
    extraWeight: prices.extraKg,
    codFeePercent: prices.codPercent,
    codFeeMin: prices.codMin,
    serviceFees: { REGULAR: prices.regularFee, SAME_DAY: prices.expressFee, EXPRESS: prices.expressFee },
    returnPercent: prices.returnPercent,
    documentTypeRates: {},
  });
}

/** A quote for API answers: the breakdown plus the old flat fields (baseCharge, weightCharge, serviceCharge, codFee, discount, totalCharge). */
export function quoteResponse(q: PackageQuote) {
  const hub = (h: HubRef | null) => (h ? { id: h.id, code: h.code, name: h.name, district: h.district, address: h.address } : null);
  return {
    tier: q.tier,
    tierLabel: ROUTE_TIER_LABEL[q.tier],
    sameZone: q.tier === "SAME_DISTRICT",
    pickupDistrict: q.pickupDistrict,
    deliveryDistrict: q.deliveryDistrict,
    ...q.columns,
    deliveryCharge: q.deliveryCharge,
    totalCharge: q.totalCharge,
    codAmount: q.selection.codAmount,
    codFeePercent: q.prices.codPercent,
    lines: q.lines,
    selection: q.selection,
    package: q.package,
    segment: q.segment,
    dropHub: hub(q.dropHub),
    collectHub: hub(q.collectHub),
    ...(q.origin ? { origin: q.origin } : {}),
    returnPercent: q.returnPercent,
    returnCharge: Math.ceil((q.totalCharge * q.returnPercent) / 100),
  };
}
