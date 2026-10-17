import { HttpStatus } from "@nestjs/common";
import type { Db } from "../../common/prisma.service";
import { AppError } from "../../common/errors";
import type { Catalog } from "../pricing/pricing.service";
import { inactiveAreasOf, listed, same, type GeoMeta } from "./geo-catalog";
import { describeUsage, placeUsage } from "./geo-usage";

/**
 * PUT /catalog sends the catalog as the panels see it (deactivated places are hidden from them).
 * Before it is saved: the hidden places are put back, and a place that disappeared must be unused
 * (409 IN_USE otherwise; renames and deletions with reference handling are the geography admin's
 * job). Returns the catalog to store and the geography state cleaned of removed places.
 */
export async function prepareCatalogSave(tx: Db, incoming: Catalog, full: Catalog, meta: GeoMeta): Promise<{ catalog: Catalog; meta: GeoMeta }> {
  const next: Catalog = structuredClone(incoming);
  const inDistricts = (d: string) => next.districts.find(x => same(x, d));
  // 1. Put back what the client couldn't see.
  for (const d of full.districts) {
    if (listed(meta.inactive.districts, d) && !inDistricts(d)) {
      next.districts.push(d);
      next.zonesByDistrict[d] = [...(full.zonesByDistrict[d] ?? [])];
      for (const z of full.zonesByDistrict[d] ?? []) if (full.areasByZone[z]) next.areasByZone[z] = [...full.areasByZone[z]];
      continue;
    }
    const key = inDistricts(d);
    if (!key) continue;
    for (const z of full.zonesByDistrict[d] ?? []) {
      const zones = (next.zonesByDistrict[key] ??= []);
      if (listed(meta.inactive.zones, z) && !listed(zones, z)) {
        zones.push(z);
        if (full.areasByZone[z]) next.areasByZone[z] = [...full.areasByZone[z]];
        continue;
      }
      const off = inactiveAreasOf(meta, z);
      if (!off.length || !listed(zones, z)) continue;
      const areas = (next.areasByZone[z] ??= []);
      for (const a of full.areasByZone[z] ?? []) if (listed(off, a) && !listed(areas, a)) areas.push(a);
    }
  }
  // 2. Anything removed must be unused.
  const removed: { target: { district: string; zone?: string; area?: string }; label: string }[] = [];
  for (const d of full.districts) {
    const key = inDistricts(d);
    if (!key) {
      removed.push({ target: { district: d }, label: d });
      continue;
    }
    for (const z of full.zonesByDistrict[d] ?? []) {
      if (!listed(next.zonesByDistrict[key], z)) {
        removed.push({ target: { district: d, zone: z }, label: `${z} (${d})` });
        continue;
      }
      for (const a of full.areasByZone[z] ?? []) if (!listed(next.areasByZone[z], a)) removed.push({ target: { district: d, zone: z, area: a }, label: `${a} (${z})` });
    }
  }
  for (const r of removed.slice(0, 200)) {
    const usage = await placeUsage(tx, full, r.target);
    if (usage.total)
      throw new AppError("IN_USE", `${r.label} is in use and can't be removed (${describeUsage(usage)}). Deactivate it in the geography settings instead.`, HttpStatus.CONFLICT, {
        place: r.target,
        usage,
      });
  }
  if (removed.length > 200) throw new AppError("TOO_MANY_REMOVALS", "Remove at most 200 places at once; use the geography settings to delete places.", HttpStatus.UNPROCESSABLE_ENTITY);
  // 3. Removed places leave no state behind (and the BD seed doesn't bring them back).
  const state = structuredClone(meta);
  for (const r of removed) {
    const { district, zone, area } = r.target;
    if (area) {
      state.deleted.areas.push(`${zone}|${area}`);
      const k = Object.keys(state.inactive.areas).find(x => same(x, zone));
      if (k) state.inactive.areas[k] = state.inactive.areas[k].filter(x => !same(x, area));
    } else if (zone) {
      state.deleted.zones.push(`${district}|${zone}`);
      state.inactive.zones = state.inactive.zones.filter(x => !same(x, zone));
    } else {
      state.deleted.districts.push(district);
      state.inactive.districts = state.inactive.districts.filter(x => !same(x, district));
    }
  }
  return { catalog: next, meta: state };
}
