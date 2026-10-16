import { z } from "zod";

export const SERVICE_LEVELS = ["REGULAR", "SAME_DAY", "EXPRESS"] as const;
export type ServiceLevel = (typeof SERVICE_LEVELS)[number];
export const SERVICE_LEVEL_LABEL: Record<ServiceLevel, string> = { REGULAR: "Regular", SAME_DAY: "Same day", EXPRESS: "Express" };

const money = z.number().min(0).max(1_000_000);

/** Stored in RateCard.config. Defaults match the original super-admin demo config. */
export const rateCardConfigSchema = z.object({
  sameZone: money.default(70),
  crossZone: money.default(120),
  /** Weight included in the base charge. */
  includedWeightKg: z.number().min(0).default(1),
  /** Charge per started kg above includedWeightKg. */
  extraWeight: money.default(20),
  codFeePercent: z.number().min(0).max(100).default(1),
  /** Minimum COD fee when COD is used. */
  codFeeMin: money.default(0),
  serviceFees: z
    .object({ REGULAR: money.default(0), SAME_DAY: money.default(30), EXPRESS: money.default(50) })
    .default({ REGULAR: 0, SAME_DAY: 30, EXPRESS: 50 }),
  /** Percentage of the delivery charge billed when a parcel is returned. */
  returnPercent: z.number().min(0).max(100).default(50),
  /**
   * Document parcels (type DOCUMENT with a document type): the same-zone charge for each
   * document type, e.g. { "B2B Document": 60 }. Between zones the card's inter-zone surcharge
   * (crossZone − sameZone) is added. Types not listed use sameZone / crossZone.
   */
  documentTypeRates: z
    .record(z.string().trim().min(1).max(80), money)
    .refine(r => Object.keys(r).length <= 100, "Use at most 100 document types")
    .default({}),
});
export type RateCardConfig = z.infer<typeof rateCardConfigSchema>;
export const DEFAULT_RATE_CARD: RateCardConfig = rateCardConfigSchema.parse({});

/** A merchant's own tariff: any rate card field, applied on top of its segment's card. */
export const rateCardOverrideSchema = z
  .object({
    sameZone: money,
    crossZone: money,
    includedWeightKg: z.number().min(0),
    extraWeight: money,
    codFeePercent: z.number().min(0).max(100),
    codFeeMin: money,
    serviceFees: z.object({ REGULAR: money, SAME_DAY: money, EXPRESS: money }).partial(),
    returnPercent: z.number().min(0).max(100),
    documentTypeRates: z.record(z.string().trim().min(1).max(80), money).refine(r => Object.keys(r).length <= 100, "Use at most 100 document types"),
  })
  .partial()
  .strict();
export type RateCardOverride = z.infer<typeof rateCardOverrideSchema>;

/** The segment card with a merchant override applied (document rates and service fees merge per key). */
export function applyRateOverride(card: RateCardConfig, override?: RateCardOverride | null): RateCardConfig {
  if (!override) return card;
  return {
    ...card,
    ...override,
    serviceFees: { ...card.serviceFees, ...(override.serviceFees ?? {}) },
    documentTypeRates: { ...card.documentTypeRates, ...(override.documentTypeRates ?? {}) },
  };
}

/** The rate for a document type (case-insensitive), if the card prices it. */
export function documentTypeRate(card: RateCardConfig, documentType?: string | null): { name: string; rate: number } | undefined {
  const wanted = documentType?.trim().toLowerCase();
  if (!wanted) return undefined;
  const entry = Object.entries(card.documentTypeRates ?? {}).find(([name]) => name.trim().toLowerCase() === wanted);
  return entry ? { name: entry[0], rate: entry[1] } : undefined;
}

export interface QuoteInput {
  pickupDistrict: string;
  pickupZone: string;
  deliveryDistrict: string;
  deliveryZone: string;
  weightKg: number;
  serviceLevel: ServiceLevel;
  codAmount: number;
  /** Merchant plan discount on the delivery charge, 0–100. */
  discountPercent?: number;
  /** Parcel type (PARCEL, DOCUMENT…). Document type rates apply to DOCUMENT parcels only. */
  parcelType?: string;
  /** For DOCUMENT parcels: the document type, priced by the card's documentTypeRates. */
  documentType?: string;
}

export interface Quote {
  sameZone: boolean;
  baseCharge: number;
  weightCharge: number;
  serviceCharge: number;
  codFee: number;
  discount: number;
  /** What the sender pays. The recipient separately pays codAmount. */
  totalCharge: number;
  codAmount: number;
  codFeePercent: number;
  /** Set when a document type rate priced the base charge. */
  documentType?: string;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Delivery charge, same formula the website showed: base + weight + service + COD fee. */
export function quoteParcel(card: RateCardConfig, input: QuoteInput): Quote {
  const sameZone = same(input.pickupDistrict, input.deliveryDistrict) && same(input.pickupZone, input.deliveryZone);
  const docRate = input.parcelType === "DOCUMENT" ? documentTypeRate(card, input.documentType) : undefined;
  const baseCharge = docRate
    ? round2(docRate.rate + (sameZone ? 0 : Math.max(0, card.crossZone - card.sameZone)))
    : sameZone
      ? card.sameZone
      : card.crossZone;
  const extraKg = Math.max(0, Math.ceil(input.weightKg - card.includedWeightKg));
  const weightCharge = extraKg * card.extraWeight;
  const serviceCharge = card.serviceFees[input.serviceLevel];
  const codFee = input.codAmount > 0 ? Math.max(card.codFeeMin, Math.ceil((input.codAmount * card.codFeePercent) / 100)) : 0;
  const discount = round2(((baseCharge + weightCharge + serviceCharge) * (input.discountPercent ?? 0)) / 100);
  return {
    sameZone,
    baseCharge,
    weightCharge,
    serviceCharge,
    codFee,
    discount,
    totalCharge: round2(baseCharge + weightCharge + serviceCharge + codFee - discount),
    codAmount: input.codAmount,
    codFeePercent: card.codFeePercent,
    ...(docRate ? { documentType: docRate.name } : {}),
  };
}
