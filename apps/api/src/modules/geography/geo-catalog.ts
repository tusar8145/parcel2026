import { HttpStatus } from "@nestjs/common";
import type { Db } from "../../common/prisma.service";
import { AppError } from "../../common/errors";
import type { Catalog } from "../pricing/pricing.service";

/**
 * Geography state kept next to the service catalog (Setting "catalog", which holds the names and
 * the district → zone → area hierarchy every booking path reads):
 * - `inactive`: deactivated districts, zones (by name; zone names are unique in the country) and
 *   areas (per zone). Hidden from new bookings, dropdowns and templates; existing records keep them.
 * - `coordinates`: optional map points.
 * - `deleted`: tombstones of deleted (or renamed-away) places and hub codes, so the BD geography
 *   seed (`seed/geo-bd.ts`) doesn't bring them back.
 * Names are stored in the catalog's spelling; comparisons are case-insensitive.
 */
export const GEO_META_KEY = "catalog-meta";

export interface LatLng {
  lat: number;
  lng: number;
}
export interface GeoMeta {
  inactive: { districts: string[]; zones: string[]; areas: Record<string, string[]> };
  coordinates: { districts: Record<string, LatLng>; zones: Record<string, LatLng>; areas: Record<string, Record<string, LatLng>> };
  /** zones: "district|zone", areas: "zone|area", hubs: hub codes. */
  deleted: { districts: string[]; zones: string[]; areas: string[]; hubs: string[] };
}

export const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
export const same = (a: string | null | undefined, b: string | null | undefined) => a != null && b != null && norm(a) === norm(b);
export const listed = (list: readonly string[] | undefined, name: string | null | undefined) => !!name && !!list?.some(x => same(x, name));

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const point = (v: unknown): LatLng | null => (isObject(v) && typeof v.lat === "number" && typeof v.lng === "number" ? { lat: v.lat, lng: v.lng } : null);
const points = (v: unknown) => Object.fromEntries(Object.entries(isObject(v) ? v : {}).flatMap(([k, p]) => (point(p) ? [[k, point(p)!]] : [])));

/** Reads a stored value leniently (anything malformed is dropped). */
export function normalizeMeta(value: unknown): GeoMeta {
  const v = isObject(value) ? value : {};
  const inactive = isObject(v.inactive) ? v.inactive : {};
  const coordinates = isObject(v.coordinates) ? v.coordinates : {};
  const deleted = isObject(v.deleted) ? v.deleted : {};
  const areaLists = isObject(inactive.areas) ? inactive.areas : {};
  const areaPoints = isObject(coordinates.areas) ? coordinates.areas : {};
  return {
    inactive: {
      districts: strings(inactive.districts),
      zones: strings(inactive.zones),
      areas: Object.fromEntries(Object.entries(areaLists).map(([z, list]) => [z, strings(list)]).filter(([, list]) => list.length)),
    },
    coordinates: {
      districts: points(coordinates.districts),
      zones: points(coordinates.zones),
      areas: Object.fromEntries(Object.entries(areaPoints).map(([z, p]) => [z, points(p)])),
    },
    deleted: { districts: strings(deleted.districts), zones: strings(deleted.zones), areas: strings(deleted.areas), hubs: strings(deleted.hubs) },
  };
}

/** Serialises catalog edits (geography admin and PUT /catalog) within a transaction. */
export async function lockGeography(tx: Db) {
  await tx.$queryRawUnsafe(`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('df:geo-catalog'))) AS l`);
}

export async function readMeta(db: Db): Promise<GeoMeta> {
  const row = await db.setting.findUnique({ where: { key: GEO_META_KEY } });
  return normalizeMeta(row?.value);
}

export const hasInactive = (meta: GeoMeta) => meta.inactive.districts.length > 0 || meta.inactive.zones.length > 0 || Object.keys(meta.inactive.areas).length > 0;

/** The areas of `zone` that are switched off (the key is matched case-insensitively). */
export const inactiveAreasOf = (meta: GeoMeta, zone: string) => Object.entries(meta.inactive.areas).find(([z]) => same(z, zone))?.[1] ?? [];

/**
 * The catalog without deactivated places: a district switched off hides its zones and areas, a
 * zone its areas. This is what bookings, dropdowns, templates and imports offer.
 */
export function activeCatalog(catalog: Catalog, meta: GeoMeta): Catalog {
  if (!hasInactive(meta)) return catalog;
  const districts = catalog.districts.filter(d => !listed(meta.inactive.districts, d));
  const zonesByDistrict: Record<string, string[]> = {};
  const areasByZone: Record<string, string[]> = {};
  for (const d of districts) {
    if (!catalog.zonesByDistrict[d]) continue;
    const zones = catalog.zonesByDistrict[d].filter(z => !listed(meta.inactive.zones, z));
    zonesByDistrict[d] = zones;
    for (const z of zones) {
      const areas = catalog.areasByZone[z];
      if (!areas) continue;
      const off = inactiveAreasOf(meta, z);
      areasByZone[z] = off.length ? areas.filter(a => !listed(off, a)) : areas;
    }
  }
  return { ...catalog, districts, zonesByDistrict, areasByZone };
}

export type Place = { district?: string | null; zone?: string | null; area?: string | null } | null | undefined;

/** The first deactivated part of a place ("district" / "zone" / "area"), if any. */
export function inactivePart(meta: GeoMeta, place: Place): { field: "district" | "zone" | "area"; name: string } | null {
  if (!place) return null;
  if (place.district && listed(meta.inactive.districts, place.district)) return { field: "district", name: place.district };
  if (place.zone && listed(meta.inactive.zones, place.zone)) return { field: "zone", name: place.zone };
  if (place.zone && place.area && listed(inactiveAreasOf(meta, place.zone), place.area)) return { field: "area", name: place.area };
  return null;
}

/**
 * New bookings may not use a deactivated district, zone or area (existing parcels keep theirs).
 * One settings read; nothing to check while nothing is switched off.
 */
export async function assertActivePlaces(db: Db, places: { label: string; place: Place }[]) {
  const meta = await readMeta(db);
  if (!hasInactive(meta)) return;
  for (const { label, place } of places) {
    const off = inactivePart(meta, place);
    if (off)
      throw new AppError("PLACE_INACTIVE", `${off.name} (${label}) is no longer offered for new bookings. Choose another ${off.field}.`, HttpStatus.UNPROCESSABLE_ENTITY, {
        field: off.field,
        name: off.name,
        address: label,
      });
  }
}
