import { z } from "zod";
import { Prisma } from "../../generated/prisma/client";
import { pageQuerySchema } from "../../common/pagination";

/** Taka amount sent as a number or decimal string; parsed to an exact Decimal (max 2 places). */
export const moneySchema = z
  .union([z.number().finite(), z.string().trim().regex(/^\d+(\.\d+)?$/, "Use a plain amount like 1500.50")])
  .transform(v => new Prisma.Decimal(String(v)))
  .refine(d => d.gte(0) && d.decimalPlaces() <= 2, "Use a non-negative amount with at most 2 decimal places");

/** ISO datetime, or a date (YYYY-MM-DD) read as midnight in Bangladesh time. */
export const instantSchema = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .transform(s => new Date(s.length === 10 ? `${s}T00:00:00+06:00` : s));

const rangeQuery = { from: instantSchema.optional(), to: instantSchema.optional() };

export const listCashRidersQuerySchema = z.object({ hubId: z.uuid().optional() });

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

export const listHandoversQuerySchema = pageQuerySchema.extend({
  riderId: z.uuid().optional(),
  hubId: z.uuid().optional(),
  ...rangeQuery,
});

export const createSettlementSchema = z.object({
  merchantId: z.uuid(),
  /** The COD collections to settle (GET /settlements/eligible); default every one waiting. */
  collectionIds: z.array(z.uuid()).min(1, "Choose at least one parcel").max(5000).optional(),
});
export const eligibleQuerySchema = z.object({ merchantId: z.uuid() });

/** reference: the bank / bKash transaction id (required unless the settlement pays ৳0). via: payout channel (default: the merchant payout account). */
export const paySettlementSchema = z.object({
  reference: z.string().trim().min(3).max(120).optional(),
  via: z.enum(["BANK", "BKASH"]).optional(),
  /** Photo of the payment receipt: a file sent from a phone (POST /photo-links, the payer's own upload), or a photo from the computer. */
  proofFileId: z.uuid().optional(),
  proofImage: z
    .string()
    .regex(/^data:image\/(jpeg|png|webp);base64,/, "Attach a JPEG, PNG or WebP photo")
    .max(7_500_000, "The photo is too large (max ~5 MB)")
    .optional(),
});

export const listSettlementsQuerySchema = pageQuerySchema.extend({
  merchantId: z.uuid().optional(),
  status: z.enum(["DRAFT", "APPROVED", "PAID"]).optional(),
  ...rangeQuery,
});

export const createInvoiceSchema = z
  .object({
    merchantId: z.uuid(),
    periodStart: instantSchema,
    periodEnd: instantSchema,
    /** The deliveries to bill (GET /invoices/billable); default every unbilled one in the period, which must have ended. */
    trackingIds: z.array(z.string().trim().min(3).max(40)).min(1, "Choose at least one delivery").max(5000).optional(),
  })
  .refine(v => v.periodEnd > v.periodStart, { message: "periodEnd must be after periodStart", path: ["periodEnd"] });
export const billableQuerySchema = z
  .object({ merchantId: z.uuid(), periodStart: instantSchema, periodEnd: instantSchema })
  .refine(v => v.periodEnd > v.periodStart, { message: "periodEnd must be after periodStart", path: ["periodEnd"] });

export const markInvoicePaidSchema = z.object({
  reference: z.string().trim().min(3).max(120).optional(),
  via: z.enum(["BANK", "BKASH", "CASH"]).default("BANK"),
});
export const voidInvoiceSchema = z.object({ reason: z.string().trim().min(3).max(300) });

export const listInvoicesQuerySchema = pageQuerySchema.extend({
  merchantId: z.uuid().optional(),
  status: z.enum(["ISSUED", "PAID", "VOID"]).optional(),
});

// ── automatic settlement schedule ──

export const SETTLEMENT_CYCLES = ["MANUAL", "DAILY", "WEEKLY", "BIWEEKLY"] as const;
export const listSchedulesQuerySchema = z.object({ cycle: z.enum(SETTLEMENT_CYCLES).optional() });
export const updateScheduleSchema = z
  .object({
    cycle: z.enum(SETTLEMENT_CYCLES, "Cycle must be MANUAL, DAILY, WEEKLY or BIWEEKLY"),
    /** 0 = Sunday … 6 = Saturday (weekly / biweekly). */
    weekday: z.number().int().min(0).max(6).optional(),
    /** Don't draft automatically below this net payable. */
    minimumAmount: moneySchema.default(new Prisma.Decimal(0)),
  })
  .refine(v => !(v.cycle === "WEEKLY" || v.cycle === "BIWEEKLY") || v.weekday !== undefined, { message: "Choose the weekday for weekly cycles", path: ["weekday"] });
