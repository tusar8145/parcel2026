import { z } from "zod";
import { Prisma } from "../../generated/prisma/client";
import { pageQuerySchema } from "../../common/pagination";
import { instantSchema, moneySchema } from "./finance.schemas";

export const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a period like 2026-10");

export const trialBalanceQuerySchema = z.object({
  /** Movements posted in this period ("YYYY-MM"). */
  period: periodSchema.optional(),
  /** Cumulative balances before this instant (ignored with period). */
  asOf: instantSchema.optional(),
  nonZeroOnly: z.preprocess(v => v === "true" || v === true || v === "1", z.boolean()).default(false),
});

export const statementQuerySchema = z.object({
  /** Account code ("2010") or system key ("MERCHANT_PAYABLES"). */
  account: z.string().trim().min(2).max(40),
  merchantId: z.uuid().optional(),
  riderId: z.uuid().optional(),
  hubId: z.uuid().optional(),
  from: instantSchema.optional(),
  to: instantSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export const listEntriesQuerySchema = pageQuerySchema.extend({
  period: periodSchema.optional(),
  eventType: z.string().trim().toUpperCase().max(40).optional(),
  merchantId: z.uuid().optional(),
  riderId: z.uuid().optional(),
  reference: z.string().trim().min(1).max(80).optional(),
});

export const createAccountSchema = z.object({
  code: z.string().trim().regex(/^\d{4}$/, "Account codes are 4 digits"),
  name: z.string().trim().min(2).max(120),
  type: z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]),
});

const journalLineSchema = z
  .object({
    account: z.string().trim().regex(/^\d{4}$/, "Use the 4-digit account code"),
    debit: moneySchema.default(new Prisma.Decimal(0)),
    credit: moneySchema.default(new Prisma.Decimal(0)),
    merchantId: z.uuid().optional(),
    riderId: z.uuid().optional(),
    hubId: z.uuid().optional(),
    memo: z.string().trim().max(200).optional(),
  })
  .refine(l => l.debit.isZero() !== l.credit.isZero(), "Each line has either a debit or a credit");

export const manualJournalSchema = z.object({
  reference: z.string().trim().min(3).max(80),
  memo: z.string().trim().min(3).max(300),
  occurredAt: instantSchema.optional(),
  lines: z.array(journalLineSchema).min(2).max(50),
});

export const depositSchema = z.object({
  hubId: z.uuid(),
  amount: moneySchema.refine(a => a.gt(0), "Amount must be more than zero"),
  to: z.enum(["BANK", "BKASH"]).default("BANK"),
  reference: z.string().trim().min(3).max(80),
  note: z.string().trim().max(300).optional(),
});

export const closePeriodSchema = z.object({ note: z.string().trim().max(300).optional() });

export const merchantStatementQuerySchema = z.object({ from: instantSchema.optional(), to: instantSchema.optional() });
