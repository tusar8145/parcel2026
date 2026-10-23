import { z } from "zod";

/** A code read on the phone (barcode or QR; the panel normalises it). */
export const phoneScanSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "Scan a code")
    .max(120, "The code is too long")
    .regex(/^[\x20-\x7E]+$/, "The code has characters a label doesn't use"),
});

/** The panel's result for a scan, shown on the phone (✓ / ✗ with the panel's message). */
export const phoneScanResultSchema = z.object({
  n: z.number().int().min(1),
  ok: z.boolean(),
  message: z.string().trim().max(200).optional(),
});
