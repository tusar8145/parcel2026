import { z } from "zod";
import { pageQuerySchema } from "../../common/pagination";
import { boolQuery, optionalText } from "../ops/ops-common";

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{2,24}$/, "Use 2–24 letters, digits or dashes");
const lat = z.number().min(20).max(27);
const lng = z.number().min(88).max(93);

/** A delivery zone: catalog areas → zone → hub (and optionally a route). */
export const zoneSchema = z
  .object({
    code,
    /** The catalog zone name, e.g. "Gulshan". */
    name: z.string().trim().min(2).max(80),
    district: z.string().trim().min(2).max(80),
    /** Catalog areas in this zone; empty = every area. */
    areas: z.array(z.string().trim().min(1).max(120)).max(200).default([]),
    hubId: z.uuid().nullable().optional(),
    routeId: z.uuid().nullable().optional(),
    lat: lat.nullable().optional(),
    lng: lng.nullable().optional(),
    active: z.boolean().default(true),
  })
  .refine(v => (v.lat == null) === (v.lng == null), { message: "Give both latitude and longitude, or neither", path: ["lng"] });
export const updateZoneSchema = z
  .object({
    code: code.optional(),
    areas: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
    hubId: z.uuid().nullable().optional(),
    routeId: z.uuid().nullable().optional(),
    lat: lat.nullable().optional(),
    lng: lng.nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine(v => (v.lat === undefined) === (v.lng === undefined) && (v.lat === null) === (v.lng === null), { message: "Change latitude and longitude together", path: ["lng"] });
export const listZonesQuerySchema = pageQuerySchema.extend({
  hubId: z.uuid().optional(),
  routeId: z.uuid().optional(),
  district: optionalText(80),
  active: boolQuery.optional(),
  q: optionalText(80),
});

export const routeSchema = z.object({
  code,
  name: z.string().trim().min(2).max(120),
  hubId: z.uuid(),
  defaultRiderId: z.uuid().nullable().optional(),
  note: optionalText(500),
  active: z.boolean().default(true),
});
export const updateRouteSchema = z.object({
  code: code.optional(),
  name: z.string().trim().min(2).max(120).optional(),
  hubId: z.uuid().optional(),
  defaultRiderId: z.uuid().nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  active: z.boolean().optional(),
});
export const listRoutesQuerySchema = pageQuerySchema.extend({ hubId: z.uuid().optional(), active: boolQuery.optional(), q: optionalText(80) });
