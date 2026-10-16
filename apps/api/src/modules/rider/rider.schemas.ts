import { z } from "zod";
import { pageQuerySchema } from "../../common/pagination";

const money = z.coerce
  .number()
  .min(0)
  .max(10_000_000)
  .transform(n => Math.round(n * 100) / 100);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform(v => v || undefined);
const isoDate = z.iso.datetime({ offset: true });

// ── location ──

export const locationPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** Metres (the browser's GeolocationCoordinates.accuracy). */
  accuracy: z.number().min(0).max(10_000),
  heading: z.number().min(0).max(360).nullish(),
  /** Metres per second. */
  speed: z.number().min(0).max(100).nullish(),
  /** When the device took the fix (ISO 8601). */
  at: isoDate,
});

export const locationBatchSchema = z.object({
  points: z.array(locationPointSchema).min(1).max(500),
});

export const riderLocationsQuerySchema = z.object({
  hubId: z.uuid().optional(),
  /** Include riders who are off shift (their last known position). */
  includeOffShift: z
    .enum(["true", "false"])
    .optional()
    .transform(v => v === "true"),
});

export const locationHistoryQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});

// ── pay ──

export const payPlanSchema = z.object({
  riderId: z.uuid(),
  name: z.string().trim().min(1).max(60),
  mode: z.enum(["PER_PARCEL", "MONTHLY_SALARY", "BOTH"]),
  ecommerceRate: money.default(0),
  documentRate: money.default(0),
  parcelRate: money.default(0),
  pickupRate: money.default(0),
  monthlySalary: money.default(0),
  effectiveFrom: isoDate.optional(),
});

export const syncPlansSchema = z.object({
  /** Replace stored plans that were themselves seeded from the settings (manual plans are kept). */
  overwriteSeeded: z.boolean().default(true),
});

export const adjustmentSchema = z.object({
  riderId: z.uuid(),
  type: z.enum(["INCENTIVE", "DEDUCTION"]),
  amount: money.refine(n => n > 0, "Enter an amount above zero"),
  description: z.string().trim().min(3).max(200),
  earnedAt: isoDate.optional(),
});

export const earningsQuerySchema = pageQuerySchema.extend({
  riderId: z.uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  unpaid: z
    .enum(["true", "false"])
    .optional()
    .transform(v => (v === undefined ? undefined : v === "true")),
});

export const payoutsQuerySchema = pageQuerySchema.extend({
  riderId: z.uuid().optional(),
  status: z.enum(["DRAFT", "APPROVED", "PAID", "CANCELLED"]).optional(),
});

export const payoutRunSchema = z
  .object({
    periodStart: isoDate,
    periodEnd: isoDate,
    riderIds: z.array(z.uuid()).max(1000).optional(),
    note: optionalText(300),
  })
  .refine(v => new Date(v.periodEnd) > new Date(v.periodStart), { message: "The period must end after it starts", path: ["periodEnd"] });

export const payPayoutSchema = z.object({
  paymentMethod: z.enum(["BANK_TRANSFER", "BKASH", "NAGAD", "ROCKET", "CASH"]),
  paymentReference: z.string().trim().min(2).max(100),
  note: optionalText(300),
});

export const cancelSchema = z.object({ note: optionalText(300) });

// ── cash handover requests ──

export const handoverRequestSchema = z.object({
  hubId: z.uuid(),
  note: optionalText(300),
});

export const handoverRequestsQuerySchema = z.object({
  hubId: z.uuid().optional(),
  status: z.enum(["PENDING", "COMPLETED", "CANCELLED"]).optional(),
});

export const completeHandoverRequestSchema = z.object({ handoverId: z.uuid() });

// ── KYC / onboarding ──

export const KYC_DOCUMENT_TYPES = ["NID_FRONT", "NID_BACK", "DRIVING_LICENSE", "PHOTO", "VEHICLE_PAPERS"] as const;
/** Needed before a rider can submit for review (vehicle papers only for motorised vehicles). */
export const REQUIRED_KYC = (vehicle: string) =>
  (["NID_FRONT", "NID_BACK", "PHOTO", ...(vehicle === "MOTORBIKE" || vehicle === "VAN" ? (["DRIVING_LICENSE", "VEHICLE_PAPERS"] as const) : [])] as const).slice();

export const kycUploadSchema = z.object({
  type: z.enum(KYC_DOCUMENT_TYPES),
  /** data:image/png|jpeg|webp;base64,… or data:application/pdf;base64,… (about 3.5 MB at most; the request body limit is 5 MB) */
  file: z
    .string()
    .regex(/^data:(image\/(png|jpeg|webp)|application\/pdf);base64,[A-Za-z0-9+/=]+$/, "Upload a PNG, JPEG, WebP or PDF file")
    .max(4_900_000, "Files must be about 3.5 MB or smaller"),
  documentNumber: optionalText(60),
  expiresAt: isoDate.optional(),
});

export const kycQueueQuerySchema = z.object({
  status: z.enum(["NOT_STARTED", "DOCUMENTS_PENDING", "UNDER_REVIEW", "APPROVED", "REJECTED"]).optional(),
});

export const kycDocumentReviewSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"]),
    reason: optionalText(300),
  })
  .refine(v => v.decision === "APPROVE" || !!v.reason, { message: "Say why the document is rejected", path: ["reason"] });

export const kycDecisionSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"]),
    note: optionalText(500),
  })
  .refine(v => v.decision === "APPROVE" || !!v.note, { message: "Tell the rider what to fix", path: ["note"] });

export const startOnboardingSchema = z.object({
  applicationId: z.uuid().optional(),
  note: optionalText(300),
});
