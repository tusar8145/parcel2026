import { z } from "zod";
import { importKindSchema } from "../imports/imports.schemas";

/** A scanning session: the parcel type of every row and its merchant (none for customer parcels). */
export const createScanSessionSchema = z.object({
  kind: importKindSchema,
  merchantId: z.uuid("merchantId must be a valid id").optional(),
});

/** A row's order fields by import column key; null or "" clears a field. */
export const updateScanSchema = z.object({
  cells: z.record(
    z.string().regex(/^[a-z_]{2,40}$/, "Unknown column"),
    z.union([z.string().trim().max(500, "Use at most 500 characters"), z.null()]),
  ),
});

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
/** GET /parcel-scans/usage: Dhaka days, inclusive (default: this month so far), and the log's page. */
export const scanUsageQuerySchema = z
  .object({
    from: day.optional(),
    to: day.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(10).max(200).default(50),
  })
  .refine(q => !q.from || !q.to || q.from <= q.to, { message: "From must be on or before To", path: ["from"] });

/** PUT /parcel-scans/balance: the limit on / off, and scans to add or the balance to set (not both). */
export const scanBalanceSchema = z
  .object({
    limited: z.boolean().optional(),
    add: z.number().int().min(1, "Add at least 1 scan").max(1_000_000).optional(),
    set: z.number().int().min(0, "The balance can't be below 0").max(1_000_000).optional(),
  })
  .refine(b => !(b.add !== undefined && b.set !== undefined), { message: "Either add scans or set the balance", path: ["add"] })
  .refine(b => b.limited !== undefined || b.add !== undefined || b.set !== undefined, { message: "Nothing to change", path: ["limited"] });
