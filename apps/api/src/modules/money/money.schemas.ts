import { z } from "zod";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A Dhaka calendar day (YYYY-MM-DD). */
const day = z.string().regex(ISO_DAY, "Use a date like 2026-10-25");
const money = z.coerce.number("Enter an amount").multipleOf(0.01, "Use at most 2 decimals");
/** A photo or PDF as a data URL (receipts, transfer proofs). */
const proof = z.string().startsWith("data:", "Attach the receipt as a photo or PDF").max(7_500_000, "The receipt must be 5 MB or smaller").optional();
const ref = z.string().trim().max(120).optional();
export const PAY_METHODS = ["BANK", "BKASH", "NAGAD", "ROCKET", "CASH", "OTHER"] as const;
const method = z.enum(PAY_METHODS, { error: `Choose how it was paid: ${PAY_METHODS.join(", ")}` });

export const accountKindSchema = z.enum(["ECOMMERCE", "FINANCIAL", "CUSTOMER"]);

export const listAccountsQuerySchema = z.object({
  kind: accountKindSchema,
  q: z.string().trim().max(80).optional(),
});

export const dateRangeQuerySchema = z.object({ from: day.optional(), to: day.optional() });

export const accountParcelsQuerySchema = dateRangeQuerySchema.extend({
  q: z.string().trim().max(40).optional(),
  /** E-commerce / Customer: open (not settled) | ready | settled; Financial: not_billed | billed | paid. */
  status: z.enum(["all", "open", "ready", "settled", "not_billed", "billed", "paid"]).default("all"),
});

export const adjustmentSchema = z.object({
  /** + = we owe the account more (credit), − = the account owes us more (charge). */
  amount: money.refine(v => v !== 0, "Enter an amount other than 0").refine(v => Math.abs(v) <= 10_000_000, "That amount looks too large"),
  reason: z.string().trim().min(3, "Write the reason (at least 3 characters)").max(300),
  trackingId: z.string().trim().toUpperCase().max(40).optional(),
});

// ───────────── payouts (E-commerce, Customer) ─────────────

export const createPayoutSchema = z.object({
  /** The parcels to settle (ready ones); default every ready parcel. Open adjustments and return charges always go with it. */
  parcelIds: z.array(z.uuid()).min(1, "Choose at least one parcel").max(5000).optional(),
});
export const payPayoutSchema = z.object({ method, reference: ref, proof });
export const listPayoutsQuerySchema = z.object({
  /** Paid between (Dhaka days, inclusive; paid settlements' history). */
  from: day.optional(),
  to: day.optional(),
  accountId: z.uuid().optional(),
  status: z.enum(["UNPAID", "PAID", "CANCELLED"]).optional(),
  kind: accountKindSchema.optional(),
});

// ───────────── bills and payments (Financial) ─────────────

export const createBillSchema = z.object({
  from: day,
  to: day,
  parcelIds: z.array(z.uuid()).min(1, "Choose at least one parcel").max(5000),
});
export const voidBillSchema = z.object({ reason: z.string().trim().min(3, "Write why (at least 3 characters)").max(300) });
export const listBillsQuerySchema = z.object({
  /** Issued between (Dhaka days, inclusive; the bills' history). */
  from: day.optional(),
  to: day.optional(),
  accountId: z.uuid().optional(),
  status: z.enum(["ISSUED", "PARTLY_PAID", "PAID", "VOID", "UNPAID"]).optional(),
});

export const paymentSchema = z.object({
  amount: money.refine(v => v > 0, "Enter the amount paid").refine(v => v <= 100_000_000, "That amount looks too large"),
  method,
  reference: ref,
  paidOn: day,
  note: z.string().trim().max(300).optional(),
  proof,
  /** Pay this bill first (the rest goes to the oldest bills, then advance credit). */
  billId: z.uuid().optional(),
});
export const rejectPaymentSchema = z.object({ reason: z.string().trim().min(3, "Write why (at least 3 characters)").max(300) });
export const listPaymentsQuerySchema = z.object({
  accountId: z.uuid().optional(),
  status: z.enum(["PENDING", "CONFIRMED", "REJECTED"]).optional(),
  /** Paid on, Dhaka days (inclusive). */
  from: day.optional(),
  to: day.optional(),
});

// ───────────── cash ─────────────

export const receiveCashSchema = z.object({
  /** The cash counted. Less than expected = the difference is recorded as due. */
  received: money.refine(v => v >= 0, "Enter the amount received"),
  hubId: z.uuid().optional(),
});
export const listSlipsQuerySchema = z.object({
  status: z.enum(["OPEN", "RECEIVED", "CANCELLED"]).optional(),
  hubId: z.uuid().optional(),
});
export const createTransferSchema = z.object({
  fromHubId: z.uuid("Choose the hub sending the cash"),
  /** The received slips to send; default all at the hub. Counter cash and the hub's dues always go with them. */
  slipIds: z.array(z.uuid()).max(2000).optional(),
  method,
  reference: ref,
  proof,
});
export const listTransfersQuerySchema = z.object({
  status: z.enum(["IN_TRANSIT", "RECEIVED", "CANCELLED"]).optional(),
  hubId: z.uuid().optional(),
});
export const onHandQuerySchema = z.object({ hubId: z.uuid().optional() });

// ───────────── self (merchant / customer) ─────────────

export const payToSchema = z.object({
  method: z.enum(["BKASH", "NAGAD", "ROCKET", "BANK"]),
  accountName: z.string().trim().min(2, "Enter the account holder's name").max(120),
  accountNumber: z.string().trim().min(5, "Enter the account or wallet number").max(40),
  bankName: z.string().trim().max(120).optional(),
  branch: z.string().trim().max(120).optional(),
});
