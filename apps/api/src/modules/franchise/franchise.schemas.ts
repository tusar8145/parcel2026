import { z } from "zod";
import { addressPartsSchema, createParcelSchema, emailSchema, phoneSchema, quoteRequestSchema } from "@delivery-fast/shared";
import { franchiseConfigSchema } from "./franchise-config";

const money = z.coerce.number().min(0, "Can't be negative").max(1_000_000, "Too large");
const percent = z.coerce.number().min(0, "Can't be negative").max(100, "At most 100%");
const text = (max: number) => z.string().trim().min(1, "Required").max(max, `At most ${max} characters`);
const optionalText = (max: number) => z.string().trim().max(max, `At most ${max} characters`).optional();

export const commissionRatesSchema = z.object({
  pickupPercent: percent.default(0),
  pickupMin: money.default(0),
  deliveryPercent: percent.default(0),
  deliveryMin: money.default(0),
  returnPercent: percent.default(0),
  returnMin: money.default(0),
});

// ───────────── super admin ─────────────

export const createFranchiseSchema = z.object({
  /** An approved franchise application: its applicant becomes the franchise account (signs in as before). */
  applicationId: z.uuid().optional(),
  name: text(120),
  contactName: text(120),
  /** Without an application: the account's phone (an existing user keeps their sign-in). */
  phone: phoneSchema.optional(),
  email: emailSchema.optional(),
  hub: z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,20}$/, "Use 3–20 letters, digits or dashes").optional(),
    name: text(120),
    district: text(80),
    zone: optionalText(80),
    address: text(300),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
  }),
  rates: commissionRatesSchema.default({ pickupPercent: 0, pickupMin: 0, deliveryPercent: 0, deliveryMin: 0, returnPercent: 0, returnMin: 0 }),
});

export const updateFranchiseSchema = z
  .object({ name: text(120).optional(), contactName: text(120).optional(), contactEmail: emailSchema.nullable().optional(), rates: commissionRatesSchema.partial().optional() })
  .refine(v => Object.values(v).some(x => x !== undefined), "Send at least one field to change");

export const franchiseStatusSchema = z.object({ status: z.enum(["ACTIVE", "SUSPENDED"], "Choose ACTIVE or SUSPENDED"), reason: optionalText(300) });

export const updateFranchiseConfigSchema = franchiseConfigSchema.partial();

export const listFranchiseInvoicesQuerySchema = z.object({
  status: z.enum(["ISSUED", "APPROVED", "PAID", "VOID"]).optional(),
  franchiseId: z.uuid().optional(),
});

export const payFranchiseInvoiceSchema = z.object({
  method: z.enum(["BANK", "BKASH", "CASH"], "Choose BANK, BKASH or CASH").default("BANK"),
  reference: text(120),
});

export const listRemittancesQuerySchema = z.object({ status: z.enum(["PENDING", "RECEIVED", "CANCELLED"]).optional(), hubId: z.uuid().optional() });
export const receiveRemittanceSchema = z.object({ amountReceived: money, note: optionalText(300) });

// ───────────── franchise panel ─────────────

export const FRANCHISE_PARCEL_VIEWS = ["incoming", "at-hub", "pickups", "drop-offs", "out", "returns", "delivered", "all"] as const;
export const franchiseParcelsQuerySchema = z.object({
  view: z.enum(FRANCHISE_PARCEL_VIEWS).default("at-hub"),
  q: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const franchiseReceiveSchema = z.object({ code: z.string().trim().min(3).max(64), source: z.enum(["CAMERA", "KEYBOARD", "MANUAL"]).default("MANUAL") });
export const franchiseAssignSchema = z.object({ riderId: z.uuid(), task: z.enum(["PICKUP", "DELIVERY"]), note: optionalText(300) });
export const franchiseSendSchema = z.object({ hubId: z.uuid(), note: optionalText(300) });
export const franchiseReturnRunSchema = z.object({ trackingIds: z.array(z.string().trim().min(3).max(40)).min(1).max(200), riderId: z.uuid(), reason: optionalText(300) });
export const franchiseCompleteReturnSchema = z.object({ notReturned: z.array(z.string().trim().min(3).max(40)).max(200).default([]), note: optionalText(300) });

/** Walk-in booking at the counter: the sender's pickup address defaults to the franchise hub's. */
export const franchiseWalkInSchema = createParcelSchema.extend({ pickup: addressPartsSchema.optional() });
export const franchiseQuoteSchema = quoteRequestSchema.omit({ pickupDistrict: true, pickupZone: true, merchantId: true, dropOffHubId: true, firstMile: true, dropHubId: true });

export const franchiseRiderSchema = z.object({
  name: text(120),
  phone: phoneSchema,
  email: emailSchema.optional(),
  vehicle: z.enum(["MOTORBIKE", "BICYCLE", "VAN", "ON_FOOT"]).default("MOTORBIKE"),
  zone: optionalText(80),
});
export const updateFranchiseRiderSchema = z
  .object({ active: z.boolean().optional(), vehicle: z.enum(["MOTORBIKE", "BICYCLE", "VAN", "ON_FOOT"]).optional(), zone: z.string().trim().max(80).nullable().optional() })
  .refine(v => Object.values(v).some(x => x !== undefined), "Send at least one field to change");
export const riderRatesSchema = z.object({ pickup: money, delivery: money, return: money });
export const riderPaymentSchema = z.object({ method: z.enum(["CASH", "BKASH", "NAGAD", "ROCKET", "BANK_TRANSFER"]).default("CASH"), reference: optionalText(120), note: optionalText(300) });

export const franchiseHandoverSchema = z.object({ riderId: z.uuid(), collectionIds: z.array(z.uuid()).min(1).max(500), amountReceived: money });
export const franchiseRemittanceSchema = z.object({ hubId: z.uuid(), note: optionalText(300) });
