import { Inject, Injectable } from "@nestjs/common";
import { SERVICE_LEVEL_LABEL, SERVICE_LEVELS, type RateCardConfig } from "@paira-express/shared";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { notFound } from "../../common/errors";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { Prisma } from "../../generated/prisma/client";
import { PricingService, type Catalog, type CurrentCard } from "../pricing/pricing.service";
import type { PlatformConfig } from "./admin.schemas";
import { PackagesService } from "../packages/packages.service";
import { DERIVED_KEYS, NOT_STORED_KEYS, RETIRED_KEYS } from "./derived-keys";

export const PLATFORM_CONFIG_KEY = "platform-config";

export { DERIVED_KEYS, RETIRED_KEYS };

const unique = (items: string[]) => [...new Set(items)];
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const objectAt = (v: unknown) => (isObject(v) ? v : {});
/** Service fees keyed by the labels the pages use ("Same day"). */
const feesByLabel = (card: RateCardConfig) => Object.fromEntries(SERVICE_LEVELS.map(level => [SERVICE_LEVEL_LABEL[level], card.serviceFees[level]]));

@Injectable()
export class PlatformConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly pricing: PricingService,
  ) {}

  /** Prices shown on the pages come from the service packages (global module). */
  @Inject(PackagesService) private readonly packages!: PackagesService;

  /** The stored configuration with the server-owned settings filled in; 404 until first saved. */
  async get(): Promise<PlatformConfig> {
    const [setting, catalog, cards] = await Promise.all([
      this.prisma.setting.findUnique({ where: { key: PLATFORM_CONFIG_KEY } }),
      this.pricing.catalog(),
      this.packages.legacyCards(),
    ]);
    if (!setting || !isObject(setting.value)) throw notFound("Platform configuration");
    // No product lists here: forms read the parcel products (GET /catalog, /packages/me, /parcel-products).
    return withServerData(setting.value, catalog, cards);
  }

  /** Replaces the stored configuration (server-owned settings and retired lists are dropped, see derived-keys.ts). */
  async save(actor: Actor, input: PlatformConfig, meta: RequestMeta): Promise<PlatformConfig> {
    const stored = Object.fromEntries(Object.entries(input).filter(([key]) => !NOT_STORED_KEYS.includes(key))) as Prisma.InputJsonObject;
    await this.prisma.$transaction(async tx => {
      const previous = await tx.setting.findUnique({ where: { key: PLATFORM_CONFIG_KEY } });
      const before = objectAt(previous?.value);
      const changedKeys = unique([...Object.keys(before), ...Object.keys(stored)])
        .filter(key => JSON.stringify(before[key]) !== JSON.stringify(stored[key]))
        .sort();
      await tx.setting.upsert({ where: { key: PLATFORM_CONFIG_KEY }, create: { key: PLATFORM_CONFIG_KEY, value: stored }, update: { value: stored } });
      await this.audit.record(
        actor,
        {
          action: "platform_config.update",
          entityType: "setting",
          entityId: PLATFORM_CONFIG_KEY,
          data: { changedKeys, bytes: Buffer.byteLength(JSON.stringify(stored)) },
        },
        meta,
        tx,
      );
    });
    return this.get();
  }
}

function withServerData(
  stored: Record<string, unknown>,
  catalog: Catalog,
  cards: Record<"CUSTOMER" | "ECOMMERCE" | "BANKING_FINANCIAL", CurrentCard>,
): PlatformConfig {
  const customer = cards.CUSTOMER.config;
  const ecommerce = cards.ECOMMERCE.config;
  const document = cards.BANKING_FINANCIAL.config;
  const merchantPricing = objectAt(stored.merchantPricing);
  const hasDocumentRates = Object.keys(document.documentTypeRates ?? {}).length > 0;
  // Follow the district order (JSONB doesn't keep object key order).
  const zones = unique(catalog.districts.flatMap(d => catalog.zonesByDistrict[d] ?? []));
  return {
    ...Object.fromEntries(Object.entries(stored).filter(([key]) => !RETIRED_KEYS.includes(key))),
    deliveryServices: SERVICE_LEVELS.map(level => SERVICE_LEVEL_LABEL[level]),
    geoCatalog: { district: catalog.districts, zone: zones, area: unique(zones.flatMap(z => catalog.areasByZone[z] ?? [])) },
    geoHierarchy: { zonesByDistrict: catalog.zonesByDistrict, areasByZone: catalog.areasByZone },
    ecommercePackaging: catalog.packaging,
    customerParcelPricing: {
      sameZone: customer.sameZone,
      crossZone: customer.crossZone,
      extraWeight: customer.extraWeight,
      codFeePercent: customer.codFeePercent,
      serviceFees: feesByLabel(customer),
    },
    serviceLevelFees: feesByLabel(ecommerce),
    // Merchant tariffs follow the e-commerce and banking & financial rate cards.
    merchantPricing: {
      ...merchantPricing,
      ecommerce: {
        ...objectAt(merchantPricing.ecommerce),
        sameZone: ecommerce.sameZone,
        crossZone: ecommerce.crossZone,
        extraWeight: ecommerce.extraWeight,
        returnPercent: ecommerce.returnPercent,
        serviceFees: feesByLabel(ecommerce),
      },
      document: {
        ...objectAt(merchantPricing.document),
        sameZone: document.sameZone,
        crossZone: document.crossZone,
        returnPercent: document.returnPercent,
        // Per-type document rates are priced from the banking & financial rate card once it has them.
        ...(hasDocumentRates ? { documentRates: document.documentTypeRates } : {}),
      },
    },
    ...(hasDocumentRates ? { documentTypeRates: { ...objectAt(stored.documentTypeRates), ...document.documentTypeRates } } : {}),
    deliveryRates: {
      ...objectAt(stored.deliveryRates),
      sameZone: ecommerce.sameZone,
      crossZone: ecommerce.crossZone,
      extraWeight: ecommerce.extraWeight,
      returnPercent: ecommerce.returnPercent,
    },
  };
}
