import { z } from "zod";

/** Most parcels in one label PDF (A4 4-up: 500 pages). Bigger batches: print in parts. */
export const MAX_LABELS = 2000;
export const MAX_INVOICES = 1000;
export const MAX_LIST_ROWS = 5000;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** Tracking IDs / CNs as an array (POST) or comma-separated (GET). */
const ids = z
  .union([z.array(z.string()), z.string()])
  .transform(v => (Array.isArray(v) ? v : v.split(/[\s,;]+/)).map(s => s.trim()).filter(Boolean))
  .pipe(z.array(z.string().min(3).max(64)).max(10_000));

const parcelSelection = {
  /** Tracking IDs or CNs, in print order. */
  ids: ids.optional(),
  /** Every parcel of a booking batch / import (IMP-…), instead of ids. */
  batchId: z.uuid().optional(),
};
const hasSelection = (v: { ids?: string[]; batchId?: string }) => !!v.ids?.length || !!v.batchId;
const selectionMessage = { message: "Choose the parcels: ids (tracking IDs) or batchId", path: ["ids"] };

export const labelsQuerySchema = z
  .object({
    ...parcelSelection,
    /** a4: four 105 × 148 mm labels per A4 sheet · thermal: one 100 × 150 mm (4 × 6 in) label per page. */
    format: z.enum(["a4", "thermal"]).default("a4"),
  })
  .refine(hasSelection, selectionMessage);

export const invoicesQuerySchema = z
  .object({
    ...parcelSelection,
    /** a4: one invoice per page · a4-4 / a4-8: four / eight per page · pos: 80 mm receipts. */
    layout: z.enum(["a4", "a4-4", "a4-8", "pos"]).default("a4"),
    /** Only one service line (the "E-commerce invoices · A4" style options). */
    line: z.enum(["all", "ecommerce", "document", "customer"]).default("all"),
  })
  .refine(hasSelection, selectionMessage);

export const parcelListQuerySchema = z
  .object({
    ...parcelSelection,
    title: z.string().trim().min(1).max(80).optional(),
  })
  .refine(hasSelection, selectionMessage);

export const runSheetQuerySchema = z.object({
  /** Dhaka day (default today): the parcels assigned to the rider that day. */
  date: day.optional(),
});

export const cnSheetQuerySchema = z.object({
  /** Only these CNs of the batch (default: every unused one). */
  cns: ids.optional(),
});

export const slaReportQuerySchema = z.object({
  from: day,
  to: day,
  hubId: z.uuid().optional(),
});

export const statementQuerySchema = z.object({
  /** Delivered on or after this Dhaka day. */
  from: day.optional(),
  /** Delivered before the end of this Dhaka day. */
  to: day.optional(),
  /** Only document consignments / only parcels. */
  line: z.enum(["all", "ecommerce", "document"]).default("all"),
});
