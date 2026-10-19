import { z } from "zod";
import { scanSourceSchema } from "../ops/ops-common";

/** Optional hub filter (operations managers: one hub; hub staff are always limited to their hubs). */
export const queueQuerySchema = z.object({
  hubId: z.uuid().optional(),
});

export const queueListQuerySchema = queueQuerySchema.extend({
  /** A group key from GET /work-queue/:task (route, area, rider…); none = the whole task. */
  group: z.string().trim().max(300).optional(),
});

export const queueScanSchema = z.object({
  /** Tracking ID or pre-printed CN, as scanned or typed. */
  code: z.string().trim().min(3).max(64),
  /** Only parcels of this group (the list on screen) are accepted. */
  group: z.string().trim().max(300).optional(),
  /** RECEIVE: the hub receiving (default: the parcel's expected hub). */
  hubId: z.uuid().optional(),
  /** ASSIGN_PICKUP / ASSIGN_DELIVERY: the rider. */
  riderId: z.uuid().optional(),
  source: scanSourceSchema,
});
