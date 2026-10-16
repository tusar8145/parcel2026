import { z } from "zod";
import { PARCEL_INTAKES } from "@delivery-fast/shared";
import { pageQuerySchema } from "../../common/pagination";
import { IMPORT_KINDS } from "./columns";

export const importKindSchema = z.enum(IMPORT_KINDS, "Choose the ecommerce or document template");

/** Options of an upload (multipart form fields, or the JSON body next to `rows`). */
export const importOptionsSchema = z.object({
  kind: importKindSchema,
  /** The merchant of every row. Merchants with one workspace may leave it out; operations may choose one or use the Merchant column. */
  merchantId: z.uuid("merchantId must be a valid id").optional(),
  /** Operations: PICKUP (default, a pickup rider collects them) or DROP_OFF at dropOffHubId. */
  intake: z.enum(PARCEL_INTAKES).optional(),
  dropOffHubId: z.uuid().optional(),
  fileName: z.string().trim().max(200).optional(),
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
  /** Operations templates carry a Merchant column; `for=merchant` gives the merchant version. */
  for: z.enum(["merchant", "ops"]).optional(),
  merchantId: z.uuid().optional(),
});

export const failedRowsQuerySchema = z.object({ format: z.enum(["xlsx", "csv"]).default("xlsx") });
