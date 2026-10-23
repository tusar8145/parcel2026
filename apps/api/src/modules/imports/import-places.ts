import type { Catalog } from "../pricing/pricing.service";
import { placeIn } from "../geography/place-in-text";
import type { ColumnKey } from "./columns";
import type { Cells } from "./import-engine.service";

type Places = Pick<Catalog, "districts" | "zonesByDistrict" | "areasByZone">;

/** The address columns of a template and the place columns picked from them. */
const FAMILIES = [
  { address: "address", district: "district", zone: "zone", area: "area" },
  { address: "pickup_address", district: "pickup_district", zone: "pickup_zone", area: "pickup_area" },
] as const satisfies readonly Record<string, ColumnKey>[];

const lower = (s: string) => s.trim().toLowerCase();
/** The catalog's spelling of a name (any case), or undefined. */
const pick = (list: readonly string[] | undefined, name: string) => (name ? (list ?? []).find(x => lower(x) === lower(name)) : undefined);

/** The place columns that were picked from the address (`cells.__auto`, comma-separated keys). */
export const autoKeys = (cells: Cells) => new Set((cells.__auto ?? "").split(",").filter(Boolean));

/**
 * District, zone and area picked from a row's address (geography/place-in-text.ts) where the file left
 * them empty or wrote a name the catalog doesn't have. A valid district / zone in the file is kept (an
 * address naming another place doesn't overrule it); the area is added only inside the row's zone.
 * Picked columns are listed in `__auto` (the preview marks them; editing one removes it).
 */
export function fillPlaces(cells: Cells, catalog: Places, columns: Set<ColumnKey>): Cells {
  const out: Cells = { ...cells };
  const auto = autoKeys(cells);
  for (const f of FAMILIES) {
    if (!columns.has(f.district) || !columns.has(f.zone)) continue;
    const address = (out[f.address] ?? "").trim();
    const district = pick(catalog.districts, out[f.district] ?? "");
    const zone = district ? pick(catalog.zonesByDistrict[district], out[f.zone] ?? "") : undefined;
    const hasArea = columns.has(f.area);
    const set = (key: ColumnKey, value: string) => {
      out[key] = value;
      auto.add(key);
    };
    if (district && zone) {
      // Both given: only a missing area, when the address names one in this zone.
      if (hasArea && !(out[f.area] ?? "").trim() && address) {
        const found = placeIn(address, catalog);
        if (found.zone === zone && found.area) set(f.area, found.area);
      }
      if (district !== out[f.district]) out[f.district] = district;
      if (zone !== out[f.zone]) out[f.zone] = zone;
      continue;
    }
    // The address, then whatever the district / zone cells say (a zone alone, a misspelt district).
    const text = [address, out[f.zone], out[f.district]].filter(v => v && v.trim()).join(", ");
    if (!text) continue;
    const found = placeIn(text, catalog);
    if (!found.district) continue;
    if (district && found.district !== district) continue; // the file's own district wins; the check reports a wrong zone
    if (!district) set(f.district, found.district);
    if (found.zone) {
      set(f.zone, found.zone);
      if (hasArea && !(out[f.area] ?? "").trim() && found.area) set(f.area, found.area);
    }
  }
  if (auto.size) out.__auto = [...auto].join(",");
  return out;
}

/** The place columns of the address column `key` (an edited address picks its places again). */
export const placesOfAddress = (key: string) => FAMILIES.find(f => f.address === key);
