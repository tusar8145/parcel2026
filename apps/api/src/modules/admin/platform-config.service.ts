import { Injectable } from "@nestjs/common";
import { SERVICE_LEVEL_LABEL, SERVICE_LEVELS, type RateCardConfig } from "@delivery-fast/shared";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { notFound } from "../../common/errors";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { Prisma } from "../../generated/prisma/client";
import { PricingService, type Catalog, type CurrentCard } from "../pricing/pricing.service";
import type { PlatformConfig } from "./admin.schemas";

export const PLATFORM_CONFIG_KEY = "platform-config";

/**
 * Settings that only mirror server data (PUT /catalog and the rate cards in force). They are
 * filled in from that data on every read and never stored, so no page can show places or
 * prices other than the ones bookings are validated and priced with.
 */
export const DERIVED_KEYS: readonly string[] = [
  "deliveryServices",
  "geoCatalog",
  "geoHierarchy",
  "ecommercePackaging",
  "ecommerceProducts",
  "customerParcelPricing",
  "serviceLevelFees",
];

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

  /** The stored configuration with the server-owned settings filled in; 404 until first saved. */
  async get(): Promise<PlatformConfig> {
    const [setting, catalog, cards] = await Promise.all([
      this.prisma.setting.findUnique({ where: { key: PLATFORM_CONFIG_KEY } }),
      this.pricing.catalog(),
      this.pricing.currentCards(),
    ]);
    if (!setting || !isObject(setting.value)) throw notFound("Platform configuration");
    return withServerData(setting.value, catalog, cards);
  }

  /** Replaces the stored configuration (server-owned settings are dropped, see DERIVED_KEYS). */
  async save(actor: Actor, input: PlatformConfig, meta: RequestMeta): Promise<PlatformConfig> {
    const stored = Object.fromEntries(Object.entries(input).filter(([key]) => !DERIVED_KEYS.includes(key))) as Prisma.InputJsonObject;
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
  cards: Record<"CUSTOMER" | "ECOMMERCE" | "CORPORATE_DOCUMENT", CurrentCard>,
): PlatformConfig {
  const customer = cards.CUSTOMER.config;
  const ecommerce = cards.ECOMMERCE.config;
  const document = cards.CORPORATE_DOCUMENT.config;
  const merchantPricing = objectAt(stored.merchantPricing);
  const hasDocumentRates = Object.keys(document.documentTypeRates ?? {}).length > 0;
  // Follow the district order (JSONB doesn't keep object key order).
  const zones = unique(catalog.districts.flatMap(d => catalog.zonesByDistrict[d] ?? []));
  return {
    ...stored,
    deliveryServices: SERVICE_LEVELS.map(level => SERVICE_LEVEL_LABEL[level]),
    geoCatalog: { district: catalog.districts, zone: zones, area: unique(zones.flatMap(z => catalog.areasByZone[z] ?? [])) },
    geoHierarchy: { zonesByDistrict: catalog.zonesByDistrict, areasByZone: catalog.areasByZone },
    ecommercePackaging: catalog.packaging,
    ecommerceProducts: catalog.products,
    customerParcelPricing: {
      sameZone: customer.sameZone,
      crossZone: customer.crossZone,
      extraWeight: customer.extraWeight,
      codFeePercent: customer.codFeePercent,
      serviceFees: feesByLabel(customer),
    },
    serviceLevelFees: feesByLabel(ecommerce),
    // Merchant tariffs follow the e-commerce and corporate-document rate cards.
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
        // Per-type document rates are priced from the corporate-document rate card once it has them.
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
