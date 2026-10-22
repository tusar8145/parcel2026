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
