import { z } from "zod";
import { pageQuerySchema } from "../../common/pagination";
import { optionalText } from "../ops/ops-common";

export const createBatchSchema = z.object({
  count: z.number().int().min(1).max(1000),
  /** The hub the labels are kept at (hub operators: their own hub). */
  hubId: z.uuid().optional(),
  /** A merchant the labels are issued to: only that merchant's bookings can use them. */
  merchantId: z.uuid().optional(),
  note: optionalText(300),
});

export const updateBatchSchema = z
  .object({ hubId: z.uuid().nullable().optional(), merchantId: z.uuid().nullable().optional(), note: z.string().trim().max(300).nullable().optional() })
  .refine(v => v.hubId !== undefined || v.merchantId !== undefined || v.note !== undefined, { message: "Change the hub, merchant or note" });

export const listBatchesQuerySchema = pageQuerySchema.extend({ hubId: z.uuid().optional(), merchantId: z.uuid().optional(), q: optionalText(60) });

export const listStockQuerySchema = pageQuerySchema.extend({
  status: z.enum(["AVAILABLE", "USED", "VOID"]).optional(),
  batchId: z.uuid().optional(),
  hubId: z.uuid().optional(),
  merchantId: z.uuid().optional(),
  q: optionalText(60),
});

const cnList = z.array(z.string().trim().toUpperCase().min(6).max(40)).min(1).max(1000);

export const printSchema = z.object({ cns: cnList.optional() });
export const voidSchema = z.object({ cns: cnList, reason: z.string().trim().min(3).max(300) });
