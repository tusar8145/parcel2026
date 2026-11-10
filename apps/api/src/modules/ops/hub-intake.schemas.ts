import { z } from "zod";
import { PARCEL_INTAKES } from "@delivery-fast/shared";
import { pageQuerySchema } from "../../common/pagination";
import { optionalText, scanSourceSchema } from "./ops-common";

/** One scan or typed ID at the hub console's receive desk (POST /ops/hub-receive). */
export const hubReceiveSchema = z.object({
  /** Tracking ID or pre-printed CN, as scanned or typed. */
  code: z.string().trim().min(3).max(64),
  hubId: z.uuid(),
  source: scanSourceSchema,
  /** The import being checked in; the answer then includes its expected / received counts. */
  batchId: z.uuid().optional(),
  note: optionalText(300),
  /** Back from a rider after a failed delivery: follow the rider's choice (RIDER), or REATTEMPT / RETURN. */
  decision: z.enum(["RIDER", "REATTEMPT", "RETURN"]).optional(),
});

/**
 * Receive & assign rider in one scan (POST /ops/hub-assign): a parcel at the hub, or coming to it (in transit, a
 * drop-off, back from a rider), is received when needed and given to the rider. Scanning it again for another rider
 * gives it to that rider instead.
 */
export const hubAssignSchema = z.object({
  code: z.string().trim().min(3).max(64),
  hubId: z.uuid(),
  riderId: z.uuid(),
  source: scanSourceSchema,
});

export const listBatchesQuerySchema = pageQuerySchema.extend({
  hubId: z.uuid().optional(),
  intake: z.enum(PARCEL_INTAKES).optional(),
});

export const labelsSchema = z.object({
  trackingIds: z.array(z.string().trim().min(3).max(64)).min(1).max(500),
});
