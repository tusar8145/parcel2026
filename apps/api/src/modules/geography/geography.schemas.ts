import { z } from "zod";

/** A place name as stored in the catalog (at most 80 characters; "|" is reserved). */
const placeName = (what: string) =>
  z
    .string(`Enter the ${what} name`)
    .trim()
    .min(1, `Enter the ${what} name`)
    .max(80, `Use at most 80 characters for a ${what} name`)
    .refine(v => !v.includes("|"), `A ${what} name can't contain "|"`)
    .transform(v => v.replace(/\s+/g, " "));
/** Identifies an existing place (matched case-insensitively). */
const ref = (what: string) => z.string(`Choose the ${what}`).trim().min(1, `Choose the ${what}`).max(120);

const lat = z.number().min(20, "Latitude must be in Bangladesh (20–27)").max(27, "Latitude must be in Bangladesh (20–27)");
const lng = z.number().min(88, "Longitude must be in Bangladesh (88–93)").max(93, "Longitude must be in Bangladesh (88–93)");
const both = (v: { lat?: number | null; lng?: number | null }) => (v.lat == null) === (v.lng == null) && (v.lat === undefined) === (v.lng === undefined);
const bothMessage = { message: "Give both latitude and longitude, or neither", path: ["lng"] };

const coords = { lat: lat.nullable().optional(), lng: lng.nullable().optional() };
/** Patch fields shared by districts, zones and areas: rename, (de)activate, map point. */
const patch = { name: placeName("new").optional(), active: z.boolean().optional(), ...coords };

export const createDistrictSchema = z.object({ name: placeName("district"), ...coords }).refine(both, bothMessage);
export const updateDistrictSchema = z.object({ district: ref("district"), ...patch }).refine(both, bothMessage);

export const createZoneSchema = z
  .object({
    district: ref("district"),
    name: placeName("zone"),
    ...coords,
    /** Optional: the hub that serves the zone (creates its delivery zone, areas → zone → hub). */
    hubId: z.uuid().optional(),
  })
  .refine(both, bothMessage);
export const updateZoneSchema = z.object({ district: ref("district"), zone: ref("zone"), ...patch }).refine(both, bothMessage);

/** One or more areas (e.g. pasted lines); blank lines are ignored, duplicates and bad lines are reported. */
export const addAreasSchema = z.object({
  district: ref("district"),
  zone: ref("zone"),
  names: z.array(z.string().max(500)).min(1, "Enter at least one area").max(2000, "Add at most 2,000 areas at once"),
});
export const updateAreaSchema = z.object({ district: ref("district"), zone: ref("zone"), area: ref("area"), ...patch }).refine(both, bothMessage);

/** A district, a zone of it, or an area of that zone. */
export const placeQuerySchema = z
  .object({ district: ref("district"), zone: ref("zone").optional(), area: ref("area").optional() })
  .refine(v => !v.area || v.zone, { message: "Give the area's zone", path: ["zone"] });
/** Usage counts of the districts (no parameters), a district's zones or a zone's areas. */
export const countsQuerySchema = z
  .object({ district: ref("district").optional(), zone: ref("zone").optional() })
  .refine(v => !v.zone || v.district, { message: "Give the zone's district", path: ["district"] });
