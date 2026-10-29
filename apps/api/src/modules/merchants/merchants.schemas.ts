import { z } from "zod";
import { emailSchema, isBdMobile, normalizeBdPhone, phoneSchema } from "@paira-express/shared";
import { pageQuerySchema } from "../../common/pagination";
import { WEBHOOK_EVENTS } from "../notifications/webhooks.service";
import { apiKeyScopesSchema } from "./api-key-scopes";
import { periodChecks, periodQueryShape } from "../../common/period";
import { handoverSchema, merchantPlaceSchema, pickupFieldsShape, pickupTimeSchema, websiteSchema } from "./merchant-address";

const text = (min: number, max: number) => z.string().trim().min(min, `Use at least ${min} characters`).max(max, `Use at most ${max} characters`);

export const merchantTypeSchema = z.enum(["ECOMMERCE", "BANKING_FINANCIAL"], "Choose ECOMMERCE or BANKING_FINANCIAL");
export const MERCHANT_STATUSES = ["PENDING_REVIEW", "INFO_REQUESTED", "ACTIVE", "SUSPENDED", "REJECTED"] as const;
export const merchantStatusSchema = z.enum(MERCHANT_STATUSES, `Choose ${MERCHANT_STATUSES.join(", ")}`);
/** Statuses set with PATCH; rejecting and asking for information have their own endpoints (they need a message). */
export const adminStatusSchema = z.enum(["PENDING_REVIEW", "ACTIVE", "SUSPENDED"], "Choose PENDING_REVIEW, ACTIVE or SUSPENDED (use /reject or /request-info for the others)");
export const segmentSchema = z.enum(["CUSTOMER", "ECOMMERCE", "BANKING_FINANCIAL"], "Choose CUSTOMER, ECOMMERCE or BANKING_FINANCIAL");

const contactFields = {
  contactName: text(2, 120),
  contactPhone: phoneSchema,
  contactEmail: emailSchema,
};

const pickupMissing = { code: "custom" as const, path: ["pickup"], message: "Enter the pickup address, or tick \"Pickup from the business address\"" };

/**
 * The merchant application (website /merchant): business details, the structured business address,
 * the pickup location (the business address or its own), pickup contact / time and the handover.
 * The serving hub and the pricing route district are derived on the server.
 */
export const merchantApplicationSchema = z
  .object({
    type: merchantTypeSchema,
    name: text(2, 120),
    contactName: contactFields.contactName,
    contactPhone: contactFields.contactPhone,
    contactEmail: contactFields.contactEmail.optional(),
    /** Optional: a product type (Regular / Document / Books…) or, for Banking & Financial, the institution type. */
    businessCategory: text(2, 80).optional(),
    /** Optional Facebook page or website. */
    websiteUrl: websiteSchema.optional(),
    business: merchantPlaceSchema,
    ...pickupFieldsShape,
    pickupSameAsBusiness: pickupFieldsShape.pickupSameAsBusiness.default(true),
    /** Defaults to the contact person / phone. */
    pickupContactName: pickupFieldsShape.pickupContactName.optional(),
    pickupContactPhone: pickupFieldsShape.pickupContactPhone.optional(),
    handover: handoverSchema.default("RIDER_PICKUP"),
    /** From an invitation link (?invite=…): marks the invitation accepted. */
    inviteToken: z.string().trim().min(10).max(200).optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.pickupSameAsBusiness && !v.pickup) ctx.addIssue(pickupMissing);
  });

/** bKash/Nagad wallets are BD mobile numbers, stored as 01XXXXXXXXX. */
const walletNumber = z
  .string()
  .trim()
  .refine(isBdMobile, "Enter the wallet's Bangladeshi mobile number, e.g. 01712-345678")
  .transform(v => normalizeBdPhone(v).replace(/^\+88/, ""));

export const payoutAccountSchema = z.discriminatedUnion(
  "method",
  [
    z.object({ method: z.literal("BKASH"), accountNumber: walletNumber, accountName: text(2, 120) }),
    z.object({ method: z.literal("NAGAD"), accountNumber: walletNumber, accountName: text(2, 120) }),
    z.object({
      method: z.literal("BANK"),
      accountNumber: z
        .string()
        .trim()
        .transform(v => v.replace(/[\s-]/g, ""))
        .pipe(z.string().regex(/^\d{6,20}$/, "Bank account numbers have 6–20 digits")),
      accountName: text(2, 120),
      bankName: z.string("Enter the bank name").trim().min(2, "Enter the bank name").max(120),
      branch: text(2, 120).optional(),
      /** Bangladesh Bank routing number of the branch (9 digits), optional. */
      routingNumber: z
        .string()
        .trim()
        .transform(v => v.replace(/[\s-]/g, ""))
        .pipe(z.string().regex(/^\d{9}$/, "Routing numbers have 9 digits"))
        .optional(),
    }),
  ],
  "Choose a payout method: BKASH, NAGAD or BANK",
);

const nonEmpty = <T extends z.ZodObject>(schema: T) =>
  schema.refine(v => Object.values(v).some(x => x !== undefined), "Send at least one field to change");

/**
 * Address changes (Settings and super admin): `business`, and the pickup location as a whole
 * (`pickupSameAsBusiness` + `pickup` when it differs). Changing the pickup re-derives the serving hub.
 */
const addressUpdateShape = {
  businessCategory: text(2, 80).nullable().optional(),
  websiteUrl: websiteSchema.nullable().optional(),
  business: merchantPlaceSchema.optional(),
  pickupSameAsBusiness: z.boolean("Send true or false").optional(),
  pickup: merchantPlaceSchema.optional(),
  pickupContactName: text(2, 120).optional(),
  pickupContactPhone: phoneSchema.optional(),
  pickupTime: pickupTimeSchema.optional(),
  handover: handoverSchema.optional(),
};
const addressChecks = (v: { pickupSameAsBusiness?: boolean; pickup?: unknown }, ctx: z.RefinementCtx) => {
  if (v.pickupSameAsBusiness === false && !v.pickup) ctx.addIssue(pickupMissing);
  if (v.pickupSameAsBusiness === true && v.pickup) ctx.addIssue({ code: "custom", path: ["pickup"], message: "The pickup is the business address: don't send a separate pickup address" });
};

export const updateMyMerchantSchema = nonEmpty(
  z.object({
    contactName: contactFields.contactName.optional(),
    contactPhone: contactFields.contactPhone.optional(),
    contactEmail: contactFields.contactEmail.nullable().optional(),
    ...addressUpdateShape,
    payoutAccount: payoutAccountSchema.nullable().optional(),
    /** Only while the application is under review or information was requested. */
    name: text(2, 120).optional(),
  }),
).superRefine(addressChecks);

export const adminUpdateMerchantSchema = nonEmpty(
  z.object({
    status: adminStatusSchema.optional(),
    planId: z.uuid("Choose a valid plan").nullable().optional(),
    name: text(2, 120).optional(),
    contactName: contactFields.contactName.optional(),
    contactPhone: contactFields.contactPhone.optional(),
    contactEmail: contactFields.contactEmail.nullable().optional(),
    ...addressUpdateShape,
  }),
).superRefine(addressChecks);

export const pickupHubQuerySchema = z.object({ district: text(2, 80), zone: text(1, 80), area: z.string().trim().max(80).optional() });

export const listMerchantsQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().max(80).optional(),
  status: merchantStatusSchema.optional(),
  type: merchantTypeSchema.optional(),
  kycStatus: z.enum(["NOT_SUBMITTED", "PENDING", "APPROVED", "REJECTED"]).optional(),
  /** The merchant's hub (from its pickup address), or "none". */
  hubId: z.union([z.uuid(), z.literal("none")], "hubId must be a hub id or none").optional(),
});

/** Operations change a merchant's business / pickup address (its hub follows the pickup address). */
export const merchantAddressSchema = nonEmpty(
  z.object({
    business: merchantPlaceSchema.optional(),
    pickupSameAsBusiness: z.boolean("Send true or false").optional(),
    pickup: merchantPlaceSchema.optional(),
  }),
).superRefine(addressChecks);

export const addressRequestQuerySchema = z.object({ status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]).optional() });
export const rejectAddressRequestSchema = z.object({ note: z.string().trim().min(3, "Write at least 3 characters").max(500, "Use at most 500 characters") });

/** Members of several merchants pick one with ?merchantId=. */
export const merchantSelectorSchema = z.object({ merchantId: z.uuid("merchantId must be a valid id").optional() });

export const addMemberSchema = z.object({
  name: text(2, 120),
  phone: phoneSchema,
  role: z.enum(["MERCHANT_OWNER", "MERCHANT_STAFF"], "Choose MERCHANT_OWNER or MERCHANT_STAFF"),
});

export const createApiKeySchema = z.object({
  name: text(2, 80),
  /** Permission scopes. Omit for full access (book, read and cancel parcels). */
  scopes: apiKeyScopesSchema.optional(),
  expiresAt: z.coerce
    .date("Enter a valid date")
    .refine(d => d.getTime() > Date.now() + 60_000, "The expiry must be in the future")
    .optional(),
});

const webhookEvents = z
  .array(z.enum(WEBHOOK_EVENTS, `Unknown event. Choose from: ${WEBHOOK_EVENTS.join(", ")}`))
  .min(1, "Subscribe to at least one event")
  .transform(events => [...new Set(events)]);

export const createWebhookSchema = z.object({
  url: z.string().trim().min(1, "Enter the webhook URL").max(2000, "Use at most 2000 characters"),
  events: webhookEvents,
  active: z.boolean().default(true),
});

export const updateWebhookSchema = nonEmpty(
  z.object({
    url: createWebhookSchema.shape.url.optional(),
    events: webhookEvents.optional(),
    active: z.boolean().optional(),
  }),
);

export const listDeliveriesQuerySchema = merchantSelectorSchema.extend(pageQuerySchema.shape).extend({
  state: z.enum(["PENDING", "SUCCEEDED", "FAILED"]).optional(),
});

export const pageWithSelectorSchema = merchantSelectorSchema.extend(pageQuerySchema.shape);

export const planSchema = z.object({
  segment: segmentSchema,
  name: text(2, 80),
  monthlyFee: z.number("Enter the monthly fee in BDT").min(0, "The fee can't be negative").max(10_000_000).multipleOf(0.01, "Use at most 2 decimals"),
  discountPct: z.number("Enter a discount percentage").min(0, "Use 0–100").max(100, "Use 0–100").multipleOf(0.01, "Use at most 2 decimals").default(0),
  features: z.array(text(1, 200)).max(30, "Use at most 30 features").default([]),
  active: z.boolean().default(true),
});

export const updatePlanSchema = nonEmpty(
  z.object({
    segment: planSchema.shape.segment.optional(),
    name: planSchema.shape.name.optional(),
    monthlyFee: planSchema.shape.monthlyFee.optional(),
    discountPct: z.number().min(0, "Use 0–100").max(100, "Use 0–100").multipleOf(0.01, "Use at most 2 decimals").optional(),
    features: z.array(text(1, 200)).max(30, "Use at most 30 features").optional(),
    active: z.boolean().optional(),
  }),
);

export const listPlansQuerySchema = z.object({
  segment: segmentSchema.optional(),
  includeInactive: z.enum(["true", "false"]).transform(v => v === "true").optional(),
});

/** Dashboard window: the last 7 or 30 days (by day) or this calendar year (by month), Dhaka time. */
/** `period`: the older chart (7d / 30d / year). from / to (Dhaka days, default this month): the dashboard's `range` figures and chart. */
export const merchantStatsQuerySchema = merchantSelectorSchema
  .extend({
    period: z.enum(["7d", "30d", "year"], "Choose 7d, 30d or year").default("7d"),
    ...periodQueryShape,
  })
  .superRefine(periodChecks);

// ───────────── administration: review, notes, invitations ─────────────

export const rejectMerchantSchema = z.object({ reason: text(5, 1000) });
export const requestInfoSchema = z.object({ message: text(5, 2000) });
export const applicantResponseSchema = z.object({ message: text(2, 2000) });
export const merchantNoteSchema = z.object({ body: text(1, 4000) });

export const inviteMerchantSchema = z
  .object({
    /** The contact person's name (greets them in the SMS / email and prefills the application). */
    name: text(2, 120).refine(v => !/^[+\d\s()-]{7,}$/.test(v), "Enter the contact person's name. The mobile number goes in its own field."),
    businessName: text(2, 120).optional(),
    phone: phoneSchema.optional(),
    email: emailSchema.optional(),
    /** The panel the merchant is invited to; website customers are never invited. */
    type: z.enum(["ECOMMERCE", "BANKING_FINANCIAL"], "Choose the merchant type: ECOMMERCE (E-commerce) or BANKING_FINANCIAL (Banking & Financial)"),
    message: text(2, 500).optional(),
    /** How long the link works, 1–30 days (default 14). */
    expiresInDays: z.number().int().min(1).max(30).default(14),
  })
  .refine(v => v.phone || v.email, { message: "Enter a mobile number or an email address", path: ["phone"] });

export const listInvitesQuerySchema = pageQuerySchema.extend({ status: z.enum(["PENDING", "ACCEPTED", "EXPIRED", "REVOKED"]).optional() });

// ───────────── KYC ─────────────

export const KYC_DOCUMENT_TYPES = ["TRADE_LICENSE", "NID_FRONT", "NID_BACK", "TIN_BIN", "PAYOUT_PROOF"] as const;
export type KycDocumentType = (typeof KYC_DOCUMENT_TYPES)[number];
export const kycDocumentTypeSchema = z.enum(KYC_DOCUMENT_TYPES, `Choose one of ${KYC_DOCUMENT_TYPES.join(", ")}`);

export const uploadKycDocumentSchema = z.object({
  type: kycDocumentTypeSchema,
  filename: text(1, 120),
  /** data:<image/png|image/jpeg|image/webp|application/pdf>;base64,… (up to about 3.5 MB). */
  file: z
    .string()
    .max(5_000_000, "The file is too large (max about 3.5 MB)")
    .regex(/^data:(image\/(png|jpeg|webp)|application\/pdf);base64,[A-Za-z0-9+/=]+$/, "Upload a PNG, JPEG, WebP or PDF file"),
});

export const kycReviewSchema = z.discriminatedUnion(
  "decision",
  [z.object({ decision: z.literal("APPROVE"), note: text(2, 1000).optional() }), z.object({ decision: z.literal("REJECT"), reason: text(5, 1000) })],
  "Choose APPROVE or REJECT",
);

export const kycPolicySchema = z.object({
  /** Creating API keys needs approved KYC. */
  requireForApiKeys: z.boolean(),
  /** Paying out COD settlements needs approved KYC. */
  requireForCodPayouts: z.boolean(),
  /** Approving (activating) an application needs approved KYC. */
  requireForActivation: z.boolean(),
  requiredDocuments: z
    .array(kycDocumentTypeSchema)
    .min(1, "Require at least one document")
    .transform(v => [...new Set(v)]),
});
export type KycPolicy = z.infer<typeof kycPolicySchema>;

// ───────────── products ─────────────

const money = z.number("Enter an amount in BDT").min(0, "The amount can't be negative").max(10_000_000).multipleOf(0.01, "Use at most 2 decimals");
export const productSchema = z.object({
  sku: z
    .string()
    .trim()
    .min(1, "Enter a SKU")
    .max(60, "Use at most 60 characters")
    .regex(/^[\w.\-/ ]+$/, "Use letters, digits, spaces and - _ . /"),
  name: text(1, 160),
  category: text(1, 80).optional(),
  weightKg: z.number().positive("Use a weight above 0").max(50, "At most 50 kg").optional(),
  packaging: text(1, 80).optional(),
  price: money.default(0),
  active: z.boolean().default(true),
});
export const updateProductSchema = nonEmpty(
  z.object({
    sku: productSchema.shape.sku.optional(),
    name: productSchema.shape.name.optional(),
    category: text(1, 80).nullable().optional(),
    weightKg: z.number().positive("Use a weight above 0").max(50, "At most 50 kg").nullable().optional(),
    packaging: text(1, 80).nullable().optional(),
    price: money.optional(),
    active: z.boolean().optional(),
  }),
);
export const listProductsQuerySchema = merchantSelectorSchema.extend(pageQuerySchema.shape).extend({
  q: z.string().trim().max(80).optional(),
  active: z
    .enum(["true", "false"])
    .transform(v => v === "true")
    .optional(),
});

// ───────────── reports ─────────────

export const REPORT_KINDS = ["orders", "delivery-performance", "cod-reconciliation", "returns", "invoices"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const reportQuerySchema = merchantSelectorSchema.extend({
  from: z.coerce.date("Enter a valid start date").optional(),
  to: z.coerce.date("Enter a valid end date").optional(),
  format: z.enum(["csv", "json"]).default("csv"),
});
