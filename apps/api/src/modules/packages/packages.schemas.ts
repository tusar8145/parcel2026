import { z } from "zod";
import { PRODUCT_TYPES, packagePricesSchema, PACKAGE_SEGMENTS, quoteRequestSchema } from "@paira-express/shared";

export const segmentSchema = z.enum(PACKAGE_SEGMENTS, "Choose ECOMMERCE, BANKING_FINANCIAL or CUSTOMER");
const name = z.string().trim().min(2, "Use at least 2 characters").max(80, "Use at most 80 characters");
const note = z.string().trim().max(300, "Use at most 300 characters").optional();
const services = z.array(z.string().trim().min(1)).max(200, "Too many services");
/** Defaults to now; a future date schedules the change (the current version stays in force until then). */
const effectiveFrom = z.coerce.date("Enter a valid date").optional();

export const createPackageSchema = z.object({
  segment: segmentSchema,
  name,
  description: z.string().trim().max(300).optional(),
  services,
  prices: packagePricesSchema,
  effectiveFrom,
  /** Make it the segment's Default package (for everyone without an assigned package). */
  makeDefault: z.boolean().default(false),
  note,
});
export type CreatePackageInput = z.infer<typeof createPackageSchema>;

export const packageVersionSchema = z.object({
  services,
  prices: packagePricesSchema,
  effectiveFrom,
  note,
  /** Rename / describe the package with this change (optional). */
  name: name.optional(),
  description: z.string().trim().max(300).optional(),
});
export type PackageVersionInput = z.infer<typeof packageVersionSchema>;

export const listPackagesQuerySchema = z.object({
  segment: segmentSchema.optional(),
  status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
});

export const assignPackageSchema = z.object({
  /** null: back to the segment's Default package. */
  packageId: z.uuid().nullable(),
  effectiveFrom,
  note,
});
export type AssignPackageInput = z.infer<typeof assignPackageSchema>;

export const assignmentsQuerySchema = z.object({ segment: z.enum(["ECOMMERCE", "BANKING_FINANCIAL"]).default("ECOMMERCE") });
export const effectiveQuerySchema = z.object({ merchantId: z.uuid().optional(), segment: segmentSchema.optional() });

export const simulateSchema = quoteRequestSchema.extend({
  /** A stored package (its version in force), or draft services + prices from the editor. */
  packageId: z.uuid().optional(),
  segment: segmentSchema.default("ECOMMERCE"),
  services: services.optional(),
  prices: packagePricesSchema.optional(),
});

export const packageSettingsSchema = z.object({
  /** Collect from hub: days a parcel waits for the recipient before it is returned. */
  collectHoldDays: z.coerce.number().int().min(1, "At least 1 day").max(60, "At most 60 days").default(7),
  /** Hours before the hold period ends that the reminder goes out (0 = no reminder). */
  collectReminderHours: z.coerce.number().int().min(0).max(24 * 30).default(24),
});
export type PackageSettings = z.infer<typeof packageSettingsSchema>;

// ── hub groups ──
export const hubGroupSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{1,23}$/, "Use 2–24 letters, digits or dashes, e.g. DHAKA-CITY"),
  name,
  description: z.string().trim().max(300).optional(),
});
export const updateHubGroupSchema = hubGroupSchema.partial().extend({ active: z.boolean().optional() });
export const hubGroupHubsSchema = z.object({ hubIds: z.array(z.uuid()).max(500) });
export const hubHubGroupSchema = z.object({ hubGroupId: z.uuid().nullable() });

// ── products ──
export const productSchema = z.object({
  /** The list: ECOMMERCE (Customer + E-commerce) or BANKING_FINANCIAL. */
  segment: z.enum(["ECOMMERCE", "BANKING_FINANCIAL"], "Choose ECOMMERCE or BANKING_FINANCIAL"),
  name: z.string().trim().min(1, "Enter the product name").max(120, "Use at most 120 characters"),
  /** One of the three fixed product types; it prices the parcel. */
  type: z.enum(PRODUCT_TYPES, "Choose REGULAR, DOCUMENT or BOOKS").default("REGULAR"),
  /** "Send SMS & email for this product": false = its parcels get no parcel messages at all. */
  sendMessages: z.boolean().default(true),
});
// Explicit (not `.partial()`): zod applies defaults inside optional fields, which would reset type / sendMessages on every edit.
export const updateProductSchema = z.object({
  name: productSchema.shape.name.optional(),
  type: z.enum(PRODUCT_TYPES, "Choose REGULAR, DOCUMENT or BOOKS").optional(),
  sendMessages: z.boolean().optional(),
  active: z.boolean().optional(),
});
export const listProductsQuerySchema = z.object({
  segment: z.enum(["ECOMMERCE", "BANKING_FINANCIAL", "CUSTOMER"]).optional(),
  includeInactive: z
    .enum(["true", "false"])
    .transform(v => v === "true")
    .optional(),
});
