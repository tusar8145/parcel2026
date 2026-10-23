import { z } from "zod";
import { firstMileSchema, lastMileSchema, PARCEL_INTAKES } from "@delivery-fast/shared";
import { pageQuerySchema } from "../../common/pagination";
import { IMPORT_KINDS } from "./columns";

/** ecommerce | document (Banking & Financial; "banking" is accepted too) | customer (customer parcels, operations only). */
export const importKindSchema = z.preprocess(
  v => (typeof v === "string" && ["banking", "banking_financial", "banking-financial"].includes(v.trim().toLowerCase()) ? "document" : v),
  z.enum(IMPORT_KINDS, "Choose the ecommerce, document (Banking & Financial) or customer template"),
);

/** Options of an upload (multipart form fields, or the JSON body next to `rows`). */
export const importOptionsSchema = z.object({
  kind: importKindSchema,
  /** The merchant of every row. Merchants with one workspace may leave it out; operations choose it for E-commerce and Banking & Financial files (customer parcels have none). */
  merchantId: z.uuid("merchantId must be a valid id").optional(),
  /** Operations: PICKUP (default, a pickup rider collects them) or DROP_OFF at dropOffHubId (same as firstMile HUB_DROP). */
  intake: z.enum(PARCEL_INTAKES).optional(),
  dropOffHubId: z.uuid().optional(),
  /** Service package choices for the whole file (import modal): first mile, its drop hub, last mile. Defaults: the package's. */
  firstMile: firstMileSchema.optional(),
  dropHubId: z.uuid().optional(),
  lastMile: lastMileSchema.optional(),
  /** Parcel notifications to send for these orders (codes; a JSON array or comma-separated; "none" for no messages). Default: every one in the package. */
  notifications: z
    .preprocess(v => (v === "none" ? [] : typeof v === "string" ? (v.trim().startsWith("[") ? JSON.parse(v) : v.split(",").map(x => x.trim()).filter(Boolean)) : v), z.array(z.string().trim().min(1).max(60)).max(40))
    .optional(),
  fileName: z.string().trim().max(200).optional(),
  /**
   * Courier Operations, any merchant's file: the columns as matched in the dialog (POST /imports/analyze),
   * JSON `{ "headerRow": 3, "columns": ["recipient_name", null, "__address_part", …] }` (headerRow 0 = none).
   * Without it, operations files are matched automatically.
   */
  mapping: z
    .preprocess(
      v => (typeof v === "string" && v.trim() ? JSON.parse(v) : v),
      z.object({ headerRow: z.number().int().min(0).max(30), columns: z.array(z.string().max(40).nullable()).max(200) }),
    )
    .optional(),
});

/** POST /imports/analyze: the file's options, and the header row the user chose (1-based; 0 = no header row). */
export const analyzeOptionsSchema = z.object({
  kind: importKindSchema,
  merchantId: z.uuid("merchantId must be a valid id").optional(),
  headerRow: z.coerce.number().int().min(0).max(30).optional(),
});

/** JSON uploads (API integrations): rows as objects keyed by template header or column key. */
export const importRowsBodySchema = importOptionsSchema.extend({
  rows: z
    .array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])), "Send rows: an array of objects keyed by column")
    .min(1, "Send at least one row"),
});

export const ROW_FILTERS = ["all", "valid", "incomplete", "error", "created", "failed", "not_created"] as const;
export const rowsQuerySchema = z.object({
  filter: z.enum(ROW_FILTERS).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
});

export const listImportsQuerySchema = pageQuerySchema.extend({
  merchantId: z.uuid().optional(),
  kind: importKindSchema.optional(),
  /** Operations: only my imports. */
  mine: z
    .enum(["true", "false"])
    .transform(v => v === "true")
    .optional(),
});

export const templateQuerySchema = z.object({
  /** Deprecated (there is no Merchant column any more); accepted and ignored. */
  for: z.enum(["merchant", "ops"]).optional(),
  /** The file's merchant: the Service list and checks follow its package. Operations without one get the category's default package. */
  merchantId: z.uuid().optional(),
});

export const failedRowsQuerySchema = z.object({ format: z.enum(["xlsx", "csv"]).default("xlsx") });

/** A preview edit of one row (PATCH /imports/:id/rows/:rowNumber): cells by column key ("" or null clears one). */
export const editRowSchema = z.object({
  cells: z.record(z.string().regex(/^[a-z_]{2,40}$/, "Unknown column"), z.union([z.string().trim().max(500, "Use at most 500 characters"), z.null()])),
  /** The address changed: pick its district / zone / area again. */
  detect: z.boolean().optional(),
});
