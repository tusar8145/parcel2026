import { z } from "zod";
import { pageQuerySchema } from "../../common/pagination";
import { instantSchema } from "./finance.schemas";

export const uploadStatementSchema = z.object({
  source: z.enum(["BANK", "BKASH"], "Source must be BANK or BKASH"),
  /** e.g. "City Bank 1234" or "bKash merchant 01XXXXXXXXX". */
  accountLabel: z.string().trim().min(2).max(80),
  filename: z.string().trim().min(1).max(160),
  /** The CSV file's text (UTF-8). Columns are detected from the header row. */
  content: z.string().min(10, "The file is empty").max(2_000_000, "Statements can be up to 2 MB"),
  /** Run automatic matching right after import (default true). */
  autoMatch: z.boolean().default(true),
});

export const listLinesQuerySchema = pageQuerySchema.extend({
  statementId: z.uuid().optional(),
  status: z.enum(["UNMATCHED", "MATCHED", "IGNORED"]).optional(),
});

export const matchLineSchema = z
  .object({
    settlementId: z.uuid().optional(),
    invoiceId: z.uuid().optional(),
    riderPayoutId: z.uuid().optional(),
    note: z.string().trim().min(3).max(300).optional(),
  })
  .refine(v => [v.settlementId, v.invoiceId, v.riderPayoutId].filter(Boolean).length === 1, "Choose exactly one of settlementId, invoiceId or riderPayoutId");

export const ignoreLineSchema = z.object({ note: z.string().trim().min(3, "Say why this line needs no match").max(300) });

export const exceptionsQuerySchema = z.object({ from: instantSchema.optional(), to: instantSchema.optional() });

export const autoMatchSchema = z.object({ statementId: z.uuid().optional() });
