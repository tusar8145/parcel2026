import { z } from "zod";
import { pageQuerySchema } from "../../common/pagination";
import { optionalText } from "../ops/ops-common";

/** What a scan was for. Hub console, linehaul, CN stock and the rider app use these. */
export const SCAN_KINDS = [
  "HUB_RECEIVE",
  "HUB_SORT",
  "HUB_DISPATCH",
  "HUB_LOOKUP",
  "HUB_RETURN",
  "BAG_LOAD",
  "BAG_RECEIVE",
  "CN_CHECK",
  "RIDER_PICKUP",
  "RIDER_OUT_FOR_DELIVERY",
  "RIDER_DELIVERY",
  /** Rider app "Hand over at hub": the parcel is on the rider's handover list for that hub. */
  "RIDER_HANDOVER",
] as const;
export type ScanKind = (typeof SCAN_KINDS)[number];

export const recordScanSchema = z.object({
  code: z.string().trim().min(3).max(64),
  kind: z.enum(SCAN_KINDS),
  hubId: z.uuid().optional(),
  source: z.enum(["CAMERA", "KEYBOARD", "MANUAL"]).default("KEYBOARD"),
  /** false when the scan was refused by the workflow (wrong hub, unknown code…). */
  ok: z.boolean().default(true),
  message: optionalText(300),
});

const day = z.iso.date();

export const listScansQuerySchema = pageQuerySchema.extend({
  hubId: z.uuid().optional(),
  riderId: z.uuid().optional(),
  kind: z.enum(SCAN_KINDS).optional(),
  source: z.enum(["CAMERA", "KEYBOARD", "MANUAL", "SYSTEM"]).optional(),
  q: optionalText(64),
  from: day.optional(),
  to: day.optional(),
});

export const complianceQuerySchema = z
  .object({ from: day.optional(), to: day.optional(), hubId: z.uuid().optional() })
  .transform(v => {
    const to = v.to ?? new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
    const from = v.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
    return { ...v, from, to };
  })
  .refine(v => v.from <= v.to, { message: "from must be on or before to", path: ["from"] })
  .refine(v => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 < 92, { message: "Choose a range of at most 92 days", path: ["from"] });
export const complianceQueryDoc = z.object({ from: day.optional(), to: day.optional(), hubId: z.uuid().optional() });
