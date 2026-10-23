import { z } from "zod";
import { PARCEL_INTAKES, PARCEL_STATUSES, parseParcelStatus } from "../parcel-status";
import { SERVICE_LEVELS } from "../pricing";
import { serviceSelectionSchema } from "../packages";
import { phoneSchema, recipientPhoneSchema } from "./auth";

export const ADDRESS_CATEGORIES = ["HOME", "OFFICE", "OTHER"] as const;
export const PARCEL_TYPES = ["PARCEL", "DOCUMENT", "FRAGILE", "ECOMMERCE"] as const;

const text = (max: number) => z.string().trim().min(1, "This field is required").max(max, `Use at most ${max} characters`);
const optionalText = (max: number) => z.string().trim().max(max).optional().transform(v => v || undefined);
const amount = z.coerce.number().min(0).max(1_000_000).transform(n => Math.round(n * 100) / 100);

/** Accepts "Home" / "HOME". */
const category = z
  .string()
  .transform(v => v.trim().toUpperCase())
  .pipe(z.enum(ADDRESS_CATEGORIES))
  .default("HOME");

/** Accepts "Same day" / "SAME_DAY". */
export const serviceLevelSchema = z
  .string()
  .transform(v => v.trim().toUpperCase().replace(/\s+/g, "_"))
  .pipe(z.enum(SERVICE_LEVELS))
  .default("REGULAR");

const statusSchema = z
  .string()
  .transform((v, ctx) => parseParcelStatus(v) ?? (ctx.addIssue({ code: "custom", message: `Unknown status: ${v}` }), z.NEVER));

/** Optional map pin (WGS84). */
export const latitudeSchema = z.coerce.number().min(-90, "Invalid latitude").max(90, "Invalid latitude");
export const longitudeSchema = z.coerce.number().min(-180, "Invalid longitude").max(180, "Invalid longitude");

export const addressPartsSchema = z.object({
  category,
  street: text(200),
  area: optionalText(120),
  zone: text(80),
  district: text(80),
  lat: latitudeSchema.optional(),
  lng: longitudeSchema.optional(),
});

/** A pickup time window (e.g. one of GET /pickup-slots). */
export const pickupWindowSchema = z
  .object({ start: z.coerce.date("Choose a pickup time"), end: z.coerce.date("Choose a pickup time") })
  .refine(w => w.end > w.start, { message: "The pickup window must end after it starts", path: ["end"] })
  .refine(w => w.end.getTime() - w.start.getTime() <= 12 * 3600_000, { message: "A pickup window can be at most 12 hours", path: ["end"] });

export const quoteRequestSchema = z.object({
  /** Prices depend on the districts only (route tiers); zones find the Hub Pickup hub. */
  pickupDistrict: text(80),
  pickupZone: optionalText(80),
  deliveryDistrict: text(80),
  deliveryZone: optionalText(80),
  weightKg: z.coerce.number().positive("Enter the weight").max(50, "At most 50 kg").default(0.5),
  serviceLevel: serviceLevelSchema,
  codAmount: amount.default(0),
  /** DOCUMENT parcels: the document type, priced by the rate card's documentTypeRates. */
  parcelType: z.enum(PARCEL_TYPES).optional(),
  documentType: optionalText(80),
  /** Hub drop-off: priced from this hub's location (district / zone) instead of the pickup address. */
  dropOffHubId: z.uuid().optional(),
  /** Areas find the hubs' delivery zones more precisely (optional). */
  pickupArea: optionalText(120),
  deliveryArea: optionalText(120),
  /** Ops / API: quote for this merchant's package (staff only; merchants always get their own). */
  merchantId: z.uuid().optional(),
}).extend(serviceSelectionSchema.omit({ notifications: true }).shape);

export const createParcelSchema = z.object({
  sender: z.object({ name: text(120), phone: phoneSchema }),
  pickup: addressPartsSchema,
  recipient: z.object({ name: text(120), phone: recipientPhoneSchema }),
  delivery: addressPartsSchema,
  type: z.enum(PARCEL_TYPES).default("PARCEL"),
  /** DOCUMENT parcels: the document type (e.g. "B2B Document"), priced by the rate card's documentTypeRates. */
  documentType: optionalText(80),
  serviceLevel: serviceLevelSchema,
  weightKg: z.coerce.number().positive("Enter the weight").max(50, "At most 50 kg"),
  packaging: optionalText(80),
  contents: optionalText(120),
  declaredValue: amount.optional(),
  codAmount: amount.default(0),
  instructions: optionalText(500),
  merchantOrderRef: optionalText(80),
  /** Who may receive it for the recipient, e.g. "Self", "Reception", "Authorized representative". */
  receiverRelation: optionalText(60),
  /** Banking & Financial merchants: the branch the consignment originates from, e.g. "MBP-DHK-01". */
  originBranchCode: optionalText(40),
  /** Save sender/recipient to the customer's address book. */
  saveAddresses: z.boolean().default(true),
  /** When the rider should collect it. Website bookings must pick one of GET /pickup-slots. */
  pickupWindow: pickupWindowSchema.optional(),
  /** A pre-printed consignment number from CN stock; it becomes the tracking ID. */
  cn: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2,4}-\d{6}-[0-9A-Z]{4,8}$/, "Enter the consignment number printed on the label")
    .optional(),
}).extend(serviceSelectionSchema.shape);
export type CreateParcelInput = z.infer<typeof createParcelSchema>;

export const listParcelsQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform(v => (v ? v.split(",").map(s => parseParcelStatus(s)).filter(s => s !== undefined) : undefined)),
  q: optionalText(80), // tracking ID, phone or name
  channel: z.enum(["WEBSITE", "MERCHANT_PORTAL", "MERCHANT_API", "OPERATIONS"]).optional(),
  merchantId: z.uuid().optional(),
  riderId: z.uuid().optional(),
  hubId: z.uuid().optional(),
  /** PICKUP or DROP_OFF; with dropOffHubId, the parcels to be brought to that hub. */
  intake: z.enum(PARCEL_INTAKES).optional(),
  dropOffHubId: z.uuid().optional(),
  /** Parcels booked in one spreadsheet import (GET /ops/booking-batches). */
  batchId: z.uuid().optional(),
  /** true: only incomplete orders ("Needs info", imports booked with delivery details missing). */
  incomplete: z
    .enum(["true", "false"])
    .transform(v => v === "true")
    .optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const cancelParcelSchema = z.object({ reason: optionalText(300) });

// ── operations ──
export const assignRiderSchema = z.object({
  riderId: z.uuid(),
  note: optionalText(300),
});

/** A pickup handed to a hub (e.g. a franchise hub, which then assigns one of its riders); null takes it back. */
export const assignPickupHubSchema = z.object({
  hubId: z.uuid().nullable(),
  note: optionalText(300),
});

export const updateStatusSchema = z.object({
  status: statusSchema,
  hubId: z.uuid().optional(),
  note: optionalText(500),
  /** Optimistic locking: the version the client last saw. */
  expectedVersion: z.number().int().min(0).optional(),
});

// ── rider ──
export const pickupOutcomeSchema = z.discriminatedUnion("outcome", [
  /**
   * Collected from the sender, still with the rider (PICKED_UP): the rider app's "Pickup from merchant"
   * scan. `expectedStop` (the pickup stop the rider chose, `pickupStop.key` in GET /rider/tasks) makes the
   * API refuse a parcel from another merchant / sender. The hub receives it later by scanning.
   */
  z.object({ outcome: z.literal("COLLECTED"), expectedStop: z.string().trim().max(200).optional(), note: optionalText(500) }),
  z.object({ outcome: z.literal("COLLECTED_DELIVER_DIRECT"), note: optionalText(500) }),
  z.object({ outcome: z.literal("COLLECTED_TO_HUB"), hubId: z.uuid(), note: optionalText(500) }),
  z.object({ outcome: z.literal("EXCEPTION"), note: text(500) }),
]);

const dataUrl = z
  .string()
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, "Must be a PNG, JPEG or WebP image")
  .max(3_000_000, "Image is too large (max ~2 MB)");

export const FAILURE_REASONS = [
  "Recipient unavailable",
  "Incorrect address",
  "Recipient refused",
  "Unable to contact recipient",
  "Access / safety issue",
  "Other",
] as const;

/** Where and when the rider captured delivery proof (device clock and GPS fix). */
export const proofCaptureSchema = z.object({
  capturedAt: z.iso.datetime({ offset: true }).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  accuracy: z.number().min(0).max(100_000).optional(),
});

export const deliveryOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("DELIVERED"),
    receivedBy: text(120),
    proof: z.discriminatedUnion("method", [
      z.object({ method: z.literal("OTP"), otp: z.string().trim().regex(/^\d{4,6}$/, "Enter the recipient's code") }),
      z.object({ method: z.literal("SIGNATURE"), image: dataUrl }),
      z.object({ method: z.literal("PHOTO"), image: dataUrl }),
    ]),
    /** Cash collected from the recipient; must equal the parcel's COD amount, or with `partial` the cash actually collected (0 … COD). */
    codCollected: amount.default(0),
    /** Partial delivery: the recipient kept part of the order; the rest goes back on a new return order. */
    partial: z.boolean().optional(),
    /** Who received it, as related to the recipient (super admin's Receiver relations; default Self). */
    receiverRelation: optionalText(60),
    note: optionalText(500),
    capture: proofCaptureSchema.optional(),
  }),
  z.object({
    outcome: z.literal("FAILED"),
    reason: z.enum(FAILURE_REASONS),
    nextAction: z.enum(["RETRY", "RETURN_TO_HUB"]),
    hubId: z.uuid().optional(),
    note: optionalText(500),
  }),
]);

export const parcelStatusValues = PARCEL_STATUSES;

/** Why a parcel goes back to the merchant (return to origin). */
export const RETURN_REASONS = [
  "Recipient refused",
  "Recipient unreachable",
  "Incorrect address",
  "Repeated failed attempts",
  "Merchant requested",
  "Damaged in transit",
  "Other",
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];
