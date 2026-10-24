import { z } from "zod";
import { pageQuerySchema } from "../../common/pagination";
import { evidenceSchema, enumLoose } from "../support/support.schemas";
import { moneySchema } from "./finance.schemas";

export const DISPUTE_KINDS = ["DAMAGED", "LOST", "OVERCHARGE", "WEIGHT_DISCREPANCY", "OTHER"] as const;
export const DISPUTE_STATUSES = ["OPEN", "UNDER_REVIEW", "APPROVED", "REJECTED"] as const;
export const DISPUTE_PAYOUTS = ["MERCHANT_BALANCE", "BANK", "BKASH", "CASH"] as const;

const weightSchema = z.coerce.number("Enter the weight in kg").positive("Weight must be more than 0 kg").max(500, "Weight can be up to 500 kg");
const positiveMoney = moneySchema.refine(a => a.gt(0), "Amount must be more than zero");

export const createDisputeSchema = z
  .object({
    trackingId: z.string().trim().toUpperCase().min(3).max(40),
    kind: enumLoose(DISPUTE_KINDS, "Kind"),
    description: z.string().trim().min(10, "Describe the problem (at least 10 characters)").max(3000),
    /** Damaged / lost / overcharge / other: the amount claimed. */
    claimedAmount: positiveMoney.optional(),
    /** Weight discrepancy: the measured weight. */
    actualWeightKg: weightSchema.optional(),
    /** Photos, receipts, weighing slips (PNG/JPEG/WebP/PDF, up to 3 × 350 KB). */
    evidence: evidenceSchema,
  })
  .refine(v => v.kind !== "WEIGHT_DISCREPANCY" || v.actualWeightKg !== undefined, { message: "Enter the measured weight", path: ["actualWeightKg"] })
  .refine(v => v.kind === "WEIGHT_DISCREPANCY" || v.kind === "OTHER" || v.claimedAmount !== undefined, { message: "Enter the amount you are claiming", path: ["claimedAmount"] });

export const listDisputesQuerySchema = pageQuerySchema.extend({
  status: enumLoose(DISPUTE_STATUSES, "Status").optional(),
  kind: enumLoose(DISPUTE_KINDS, "Kind").optional(),
  merchantId: z.uuid().optional(),
  /** Number or tracking ID. */
  q: z.string().trim().min(2).max(40).optional(),
});

export const disputeNoteSchema = z.object({
  body: z.string().trim().min(1, "Write a message").max(3000),
  /** Staff only: not shown to the person who raised it. */
  internal: z.boolean().default(false),
  evidence: evidenceSchema,
});

export const approveDisputeSchema = z.object({
  /** Refund / claim amount (not used for weight discrepancies, which are re-priced). */
  approvedAmount: positiveMoney.optional(),
  /** Weight discrepancy: the weight to re-price with (defaults to the one reported). */
  actualWeightKg: weightSchema.optional(),
  /** How the money reaches them; merchants default to their balance (next settlement). */
  payout: enumLoose(DISPUTE_PAYOUTS, "Payout").optional(),
  payoutReference: z.string().trim().min(3).max(120).optional(),
  resolution: z.string().trim().min(3, "Explain the decision").max(1000),
});

export const rejectDisputeSchema = z.object({ resolution: z.string().trim().min(3, "Explain the decision").max(1000) });
