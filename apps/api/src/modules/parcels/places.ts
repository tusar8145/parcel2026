import type { Catalog } from "../pricing/pricing.service";

const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");

export type PlaceResult = { ok: true; district: string | null; zone: string | null } | { ok: false; column: "district" | "zone"; message: string };

/**
 * Checks a district / zone pair against the service catalog (PUT /catalog), case-insensitively,
 * and returns the catalog's spelling. A zone alone finds its district when only one district has
 * it. Either may be empty (incomplete orders); a value that isn't in the catalog is an error.
 */
export function resolvePlace(catalog: Catalog, district?: string | null, zone?: string | null): PlaceResult {
  const d = district?.trim() ? catalog.districts.find(x => norm(x) === norm(district)) : null;
  if (district?.trim() && !d) return { ok: false, column: "district", message: `unknown district "${district.trim()}" (use one from the list)` };
  if (!zone?.trim()) return { ok: true, district: d ?? null, zone: null };
  if (d) {
    const z = (catalog.zonesByDistrict[d] ?? []).find(x => norm(x) === norm(zone));
    return z ? { ok: true, district: d, zone: z } : { ok: false, column: "zone", message: `"${zone.trim()}" is not a zone of ${d}` };
  }
  const matches = catalog.districts.flatMap(x => (catalog.zonesByDistrict[x] ?? []).filter(z => norm(z) === norm(zone)).map(z => ({ district: x, zone: z })));
  if (!matches.length) return { ok: false, column: "zone", message: `unknown zone "${zone.trim()}" (use one from the list)` };
  if (matches.length > 1) return { ok: false, column: "district", message: `"${zone.trim()}" exists in ${matches.map(m => m.district).join(" and ")}: choose the district` };
  return { ok: true, district: matches[0].district, zone: matches[0].zone };
}

/** The catalog zone a free-text area (e.g. a merchant's pickup area) belongs to. */
export function zoneForArea(catalog: Catalog, district: string, area: string) {
  const zones = catalog.zonesByDistrict[district] ?? [];
  const lower = area.toLowerCase();
  return (
    zones.find(z => lower.startsWith(z.toLowerCase()) || lower.includes(z.toLowerCase())) ??
    zones.find(z => (catalog.areasByZone[z] ?? []).some(a => a.toLowerCase() === lower)) ??
    zones[0] ??
    area
  );
}
