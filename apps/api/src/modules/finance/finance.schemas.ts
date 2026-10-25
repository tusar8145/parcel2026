import { z } from "zod";
import { Prisma } from "../../generated/prisma/client";

/** Taka amount sent as a number or decimal string; parsed to an exact Decimal (max 2 places). */
export const moneySchema = z
  .union([z.number().finite(), z.string().trim().regex(/^\d+(\.\d+)?$/, "Use a plain amount like 1500.50")])
  .transform(v => new Prisma.Decimal(String(v)))
  .refine(d => d.gte(0) && d.decimalPlaces() <= 2, "Use a non-negative amount with at most 2 decimal places");

/** ISO datetime, or a date (YYYY-MM-DD) read as midnight in Bangladesh time. */
export const instantSchema = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .transform(s => new Date(s.length === 10 ? `${s}T00:00:00+06:00` : s));

export const createHandoverSchema = z.object({
  riderId: z.uuid(),
  hubId: z.uuid(),
  collectionIds: z
    .array(z.uuid())
    .min(1)
    .max(500)
    .refine(ids => new Set(ids).size === ids.length, "Each collection can be listed only once"),
  amountReceived: moneySchema,
  note: z.string().trim().max(500).optional(),
});
