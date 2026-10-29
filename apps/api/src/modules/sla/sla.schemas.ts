import { z } from "zod";
import { serviceLevelSchema } from "@paira-express/shared";
import { pageQuerySchema } from "../../common/pagination";
import { boolQuery, optionalText } from "../ops/ops-common";

const place = z.string().trim().min(2).max(80).nullable().optional();
const minutes = z.number().int().min(15).max(60 * 24 * 30);

export const slaPolicySchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    serviceLevel: serviceLevelSchema,
    /** Empty = any. A zone needs its district. */
    originDistrict: place,
    originZone: place,
    destDistrict: place,
    destZone: place,
    pickupMinutes: minutes,
    deliveryMinutes: minutes,
    atRiskMinutes: z.number().int().min(5).max(60 * 24).default(120),
    active: z.boolean().default(true),
  })
  .refine(v => !v.originZone || v.originDistrict, { message: "Choose the origin district for this zone", path: ["originDistrict"] })
  .refine(v => !v.destZone || v.destDistrict, { message: "Choose the destination district for this zone", path: ["destDistrict"] });

export const updateSlaPolicySchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  pickupMinutes: minutes.optional(),
  deliveryMinutes: minutes.optional(),
  atRiskMinutes: z.number().int().min(5).max(60 * 24).optional(),
  active: z.boolean().optional(),
});

export const listPoliciesQuerySchema = pageQuerySchema.extend({ active: boolQuery.optional() });

export const listAlertsQuerySchema = pageQuerySchema.extend({
  open: boolQuery.optional(),
  leg: z.enum(["PICKUP", "DELIVERY"]).optional(),
  level: z.enum(["AT_RISK", "BREACHED"]).optional(),
  hubId: z.uuid().optional(),
  acknowledged: boolQuery.optional(),
});

export const acknowledgeSchema = z.object({ note: optionalText(500) });

const day = z.iso.date();
export const slaReportQueryDoc = z.object({ from: day.optional(), to: day.optional(), hubId: z.uuid().optional() });
export const slaReportQuerySchema = slaReportQueryDoc
  .transform(v => {
    const to = v.to ?? new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
    const from = v.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
    return { ...v, from, to };
  })
  .refine(v => v.from <= v.to, { message: "from must be on or before to", path: ["from"] })
  .refine(v => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 < 92, { message: "Choose a range of at most 92 days", path: ["from"] });
