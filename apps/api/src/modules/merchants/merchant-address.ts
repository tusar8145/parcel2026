import { HttpStatus } from "@nestjs/common";
import { z } from "zod";
import { phoneSchema } from "@paira-express/shared";
import { AppError } from "../../common/errors";
import type { Db } from "../../common/prisma.service";
import type { Catalog } from "../pricing/pricing.service";
import { resolvePlace, zoneForArea } from "../parcels/places";
import { resolveZone } from "../network/zone-resolver";
import type { Hub, Merchant, Prisma } from "../../generated/prisma/client";

/**
 * Structured merchant addresses (2026-10-18).
 *
 * The merchant row keeps the business address (business* columns) and ONE primary pickup location:
 * the original pickupAddress (street) / pickupArea / pickupDistrict columns that booking defaults,
 * pricing and imports read, plus pickupZone, the pin, the pickup contact, the preferred time, the
 * handover preference and the derived serving hub (pickupHubId). Multiple pickup locations can be
 * added later as a MerchantPickupLocation table with an isPrimary flag whose primary row is mirrored
 * into these columns, so nothing that reads the merchant has to change.
 */

const text = (min: number, max: number) => z.string().trim().min(min, `Use at least ${min} characters`).max(max, `Use at most ${max} characters`);

export const PICKUP_TIMES = ["MORNING", "MIDDAY", "AFTERNOON"] as const;
export const PICKUP_TIME_LABEL: Record<(typeof PICKUP_TIMES)[number], string> = { MORNING: "Morning (9am–12pm)", MIDDAY: "Midday (12pm–3pm)", AFTERNOON: "Afternoon (3pm–6pm)" };
export const HANDOVERS = ["RIDER_PICKUP", "HUB_DROP"] as const;
export const pickupTimeSchema = z.enum(PICKUP_TIMES, "Choose MORNING, MIDDAY or AFTERNOON");
export const handoverSchema = z.enum(HANDOVERS, "Choose RIDER_PICKUP or HUB_DROP");

/** One structured address: district → zone (thana / upazila) → area (or "Other" text) → street, optional map pin. */
export const merchantPlaceSchema = z
  .object({
    district: text(2, 80),
    zone: text(1, 80),
    /** A catalog area of the zone. */
    area: z.string().trim().max(80, "Use at most 80 characters").optional(),
    /** "Other": an area that isn't listed, as free text (instead of `area`). */
    otherArea: text(2, 80).optional(),
    street: text(5, 300),
    lat: z.number("Enter a latitude").min(20, "The map pin must be in Bangladesh").max(27, "The map pin must be in Bangladesh").optional(),
    lng: z.number("Enter a longitude").min(88, "The map pin must be in Bangladesh").max(93, "The map pin must be in Bangladesh").optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.lat === undefined) !== (v.lng === undefined)) ctx.addIssue({ code: "custom", path: ["lat"], message: "Send both lat and lng for the map pin" });
    if (v.area && v.otherArea) ctx.addIssue({ code: "custom", path: ["otherArea"], message: "Choose a listed area or type another one, not both" });
  });
export type MerchantPlaceInput = z.infer<typeof merchantPlaceSchema>;

/** "facebook.com/myshop", "https://myshop.com.bd" … (stored as typed, scheme added when missing). */
export const websiteSchema = z
  .string()
  .trim()
  .max(300, "Use at most 300 characters")
  .regex(/^(https?:\/\/)?[^\s/$.?#]+\.[^\s]+$/i, "Enter a website or Facebook page address, e.g. facebook.com/yourshop")
  .transform(v => (/^https?:\/\//i.test(v) ? v : `https://${v}`));

/** The pickup part shared by the application and the Settings update. */
export const pickupFieldsShape = {
  pickupSameAsBusiness: z.boolean("Send true or false"),
  pickup: merchantPlaceSchema.optional(),
  pickupContactName: text(2, 120),
  pickupContactPhone: phoneSchema,
  pickupTime: pickupTimeSchema,
  handover: handoverSchema,
};

export interface ResolvedPlace {
  district: string;
  zone: string;
  /** Catalog area, the "Other" text, or null (the zone lists no areas / none chosen). */
  area: string | null;
  areaOther: boolean;
  street: string;
  lat: number | null;
  lng: number | null;
}

const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Checks an address against the ACTIVE catalog and returns the catalog's spelling. Errors are
 * 422 VALIDATION_FAILED with `details: [{ path, message }]` under `prefix` (e.g. "business.zone").
 */
export function resolveMerchantPlace(catalog: Catalog, input: MerchantPlaceInput, prefix: string): ResolvedPlace {
  const fail = (field: string, message: string) => {
    throw new AppError("VALIDATION_FAILED", "Some fields need attention", HttpStatus.UNPROCESSABLE_ENTITY, [{ path: `${prefix}.${field}`, message }]);
  };
  if (!catalog.districts.some(d => norm(d) === norm(input.district))) fail("district", `"${input.district}" isn't one of our districts. Choose one from the list.`);
  const place = resolvePlace(catalog, input.district, input.zone);
  if (!place.ok || !place.district || !place.zone) return fail(place.ok ? "zone" : place.column, place.ok ? "Choose the thana / upazila" : `"${input.zone}" isn't a thana / upazila of ${input.district}. Choose one from the list.`);
  const areas = catalog.areasByZone[place.zone] ?? [];
  let area: string | null = null;
  let areaOther = false;
  if (input.otherArea) {
    // A typed area that is in fact listed is stored as the listed one.
    const listed = areas.find(a => norm(a) === norm(input.otherArea!));
    area = listed ?? input.otherArea.trim();
    areaOther = !listed;
  } else if (input.area) {
    area = areas.find(a => norm(a) === norm(input.area!)) ?? null;
    if (!area) fail("area", `"${input.area}" isn't an area of ${place.zone}. Choose one from the list or "Other".`);
  } else if (areas.length) fail("area", `Choose the area in ${place.zone}, or "Other" and type it`);
  return { district: place.district, zone: place.zone, area, areaOther, street: input.street.trim(), lat: input.lat ?? null, lng: input.lng ?? null };
}

/** Merchant columns for the business address. */
export const businessColumns = (p: ResolvedPlace) => ({
  businessDistrict: p.district,
  businessZone: p.zone,
  businessArea: p.area,
  businessAreaOther: p.areaOther,
  businessStreet: p.street,
  businessLat: p.lat,
  businessLng: p.lng,
});

/** Merchant columns for the primary pickup location (pickupArea falls back to the zone, which older readers resolve). */
export const pickupColumns = (p: ResolvedPlace) => ({
  pickupDistrict: p.district,
  pickupZone: p.zone,
  pickupArea: p.area ?? p.zone,
  pickupAreaOther: p.areaOther,
  pickupAddress: p.street,
  pickupLat: p.lat,
  pickupLng: p.lng,
});

export type HubRef = Pick<Hub, "id" | "code" | "name" | "district" | "address">;
const hubSelect = { id: true, code: true, name: true, district: true, address: true } satisfies Prisma.HubSelect;

/** The hub serving pickups in a zone (its delivery zone's hub), or null when none is configured. */
export async function servingHub(db: Db, place: { district: string; zone: string; area?: string | null }): Promise<HubRef | null> {
  const zone = await resolveZone(db, { district: place.district, zone: place.zone, area: place.area });
  if (!zone?.hubId) return null;
  const hub = await db.hub.findUnique({ where: { id: zone.hubId }, select: { ...hubSelect, active: true } });
  return hub?.active ? { id: hub.id, code: hub.code, name: hub.name, district: hub.district, address: hub.address } : null;
}

/** The district prices are routed from: the hub's when the merchant drops parcels at the hub, else the pickup district. */
export const routeDistrictOf = (m: { handover: string; pickupDistrict: string }, hub: { district: string } | null) => (m.handover === "HUB_DROP" && hub ? hub.district : m.pickupDistrict);

/**
 * Best-effort match of an older free-text pickup address to the catalog: only an unambiguous
 * district and zone (the area text naming a zone, or listed as an area of exactly one zone of the
 * district) — never the district's first zone. Null when it can't be matched safely.
 */
export function matchLegacyPickup(catalog: Catalog, m: Pick<Merchant, "pickupDistrict" | "pickupArea">): { district: string; zone: string; area: string | null } | null {
  const district = catalog.districts.find(d => norm(d) === norm(m.pickupDistrict));
  if (!district) return null;
  const zones = catalog.zonesByDistrict[district] ?? [];
  const text = norm(m.pickupArea ?? "");
  if (!text) return null;
  const byName = zones.filter(z => norm(z) === text || norm(z).replace(/\s*\([^)]*\)$/, "") === text);
  if (byName.length === 1) return { district, zone: byName[0], area: null };
  const byArea = zones.filter(z => (catalog.areasByZone[z] ?? []).some(a => norm(a) === text));
  if (byArea.length === 1) return { district, zone: byArea[0], area: (catalog.areasByZone[byArea[0]] ?? []).find(a => norm(a) === text) ?? null };
  return null;
}

/** The pickup area to copy onto bookings: null when only the zone was chosen (pickupArea then holds the zone). */
export const merchantPickupArea = (m: Pick<Merchant, "pickupZone" | "pickupArea" | "pickupAreaOther">) => (m.pickupZone && m.pickupArea === m.pickupZone && !m.pickupAreaOther ? null : m.pickupArea || null);

/** The zone pricing and booking defaults use for a merchant: the structured zone, else the old free-text guess. */
export const merchantPickupZone = (catalog: Catalog, m: Pick<Merchant, "pickupZone" | "pickupDistrict" | "pickupArea">) => m.pickupZone || zoneForArea(catalog, m.pickupDistrict, m.pickupArea);

type MerchantWithHub = Merchant & { pickupHub?: HubRef | null };

/** The structured address block of the merchant view. */
export function addressView(m: MerchantWithHub) {
  const hub = m.pickupHub ?? null;
  const pickupArea = m.pickupZone && m.pickupArea === m.pickupZone && !m.pickupAreaOther ? null : m.pickupArea;
  return {
    business: m.businessDistrict
      ? { district: m.businessDistrict, zone: m.businessZone, area: m.businessArea, areaOther: m.businessAreaOther, street: m.businessStreet, lat: m.businessLat, lng: m.businessLng }
      : null,
    pickup: { district: m.pickupDistrict, zone: m.pickupZone, area: pickupArea, areaOther: m.pickupAreaOther, street: m.pickupAddress, lat: m.pickupLat, lng: m.pickupLng },
    pickupSameAsBusiness: m.pickupSameAsBusiness,
    pickupContactName: m.pickupContactName,
    pickupContactPhone: m.pickupContactPhone,
    pickupTime: m.pickupTime,
    handover: m.handover,
    businessCategory: m.businessCategory,
    websiteUrl: m.websiteUrl,
    /** Older merchants: the free-text pickup address isn't matched to the catalog yet (Settings asks to complete it). */
    addressComplete: !!m.pickupZone,
    pickupHub: hub ? { id: hub.id, code: hub.code, name: hub.name, district: hub.district, address: hub.address } : null,
    routeDistrict: routeDistrictOf(m, hub),
  };
}

export const pickupHubInclude = { pickupHub: { select: hubSelect } } satisfies Prisma.MerchantInclude;
