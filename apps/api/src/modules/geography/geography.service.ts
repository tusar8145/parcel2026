import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { RealtimeService } from "../../common/realtime.service";
import { AppError, notFound } from "../../common/errors";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { Prisma } from "../../generated/prisma/client";
import { catalogSchema, PricingService, type Catalog } from "../pricing/pricing.service";
import { GEO_META_KEY, inactiveAreasOf, listed, lockGeography, norm, readMeta, same, type GeoMeta, type LatLng } from "./geo-catalog";
import { childUsage, describeUsage, placeUsage, type Usage } from "./geo-usage";
import type { addAreasSchema, createDistrictSchema, createZoneSchema, updateAreaSchema, updateDistrictSchema, updateZoneSchema } from "./geography.schemas";
import { merchantsInZone, rederiveMerchantHubs } from "../merchants/merchant-hubs";

type State = { catalog: Catalog; meta: GeoMeta; tx: Db };
type Change<T> = { result: T; audit: { action: string; entityId: string; data: Prisma.InputJsonObject }[] };

const without = (list: string[], name: string) => list.filter(x => !same(x, name));
const withName = (list: string[], name: string) => (listed(list, name) ? list : [...list, name]);
const keyOf = <T>(record: Record<string, T>, name: string) => Object.keys(record).find(k => same(k, name));

/**
 * Districts, zones and areas of the service catalog (super admin): create, rename, deactivate and
 * delete, with usage checks.
 *
 * Identity: places are referenced BY NAME everywhere (parcels, addresses, hubs, riders, delivery
 * zones, SLA policies, merchant pickup addresses, import settings), so a rename updates every
 * reference in the same transaction as the catalog (and is audited with the counts). Zone names
 * are unique in the whole country (the catalog keys areas by zone name); area names are unique
 * within their zone; district names are unique.
 */
@Injectable()
export class GeographyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly pricing: PricingService,
    private readonly realtime: RealtimeService,
  ) {}

  // ───────────── reading ─────────────

  /** The whole hierarchy with active flags, map points and the hubs serving each zone. */
  async tree() {
    const [catalog, meta, served, hubs] = await Promise.all([
      this.pricing.catalog(this.prisma, { includeInactive: true }),
      readMeta(this.prisma),
      this.prisma.deliveryZone.findMany({ where: { hubId: { not: null } }, select: { district: true, name: true, active: true, hub: { select: { id: true, code: true, name: true } } } }),
      this.prisma.hub.findMany({ where: { zone: { not: null } }, select: { id: true, code: true, name: true, district: true, zone: true, active: true } }),
    ]);
    const point = (p: LatLng | undefined) => (p ? { lat: p.lat, lng: p.lng } : { lat: null, lng: null });
    const pointOf = (record: Record<string, LatLng>, name: string) => point(record[keyOf(record, name) ?? ""]);
    let zones = 0;
    let areas = 0;
    const districts = catalog.districts.map(d => {
      const districtActive = !listed(meta.inactive.districts, d);
      return {
        name: d,
        active: districtActive,
        ...pointOf(meta.coordinates.districts, d),
        zones: (catalog.zonesByDistrict[d] ?? []).map(z => {
          zones++;
          const off = inactiveAreasOf(meta, z);
          const areaPoints = meta.coordinates.areas[keyOf(meta.coordinates.areas, z) ?? ""] ?? {};
          const list = (catalog.areasByZone[z] ?? []).map(a => {
            areas++;
            const p = areaPoints[keyOf(areaPoints, a) ?? ""];
            return { name: a, active: !listed(off, a), ...(p ? { lat: p.lat, lng: p.lng } : {}) };
          });
          return {
            name: z,
            active: !listed(meta.inactive.zones, z),
            ...pointOf(meta.coordinates.zones, z),
            servedBy: served.filter(s => same(s.district, d) && same(s.name, z)).map(s => ({ ...s.hub!, active: s.active })),
            hubs: hubs.filter(h => same(h.district, d) && same(h.zone, z)).map(h => ({ id: h.id, code: h.code, name: h.name, active: h.active })),
            areas: list,
          };
        }),
      };
    });
    return {
      districts,
      totals: {
        districts: districts.length,
        zones,
        areas,
        inactive: { districts: meta.inactive.districts.length, zones: meta.inactive.zones.length, areas: Object.values(meta.inactive.areas).flat().length },
      },
    };
  }

  /** Usage totals per child: the districts, the zones of a district or the areas of a zone. */
  async counts(query: { district?: string; zone?: string }) {
    const catalog = await this.pricing.catalog(this.prisma, { includeInactive: true });
    const level = query.zone ? "area" : query.district ? "zone" : "district";
    const district = query.district ? this.findDistrict(catalog, query.district) : undefined;
    const zone = query.zone && district ? this.findZone(catalog, district, query.zone) : undefined;
    const usage = await childUsage(this.prisma, catalog, level, { district, zone });
    const names = level === "district" ? catalog.districts : level === "zone" ? (catalog.zonesByDistrict[district!] ?? []) : (catalog.areasByZone[zone!] ?? []);
    return { level, district: district ?? null, zone: zone ?? null, counts: Object.fromEntries(names.map(n => [n, usage.get(norm(n)) ?? { total: 0, items: [] }])) };
  }

  /** Everything that references one place, with counts. */
  async usage(query: { district: string; zone?: string; area?: string }) {
    const catalog = await this.pricing.catalog(this.prisma, { includeInactive: true });
    const target = this.resolve(catalog, query);
    return { ...target, ...(await placeUsage(this.prisma, catalog, target)) };
  }

  // ───────────── districts ─────────────

  createDistrict(actor: Actor, input: z.infer<typeof createDistrictSchema>, meta: RequestMeta) {
    return this.mutate(actor, meta, async ({ catalog, meta: geo }) => {
      const clash = catalog.districts.find(d => same(d, input.name));
      if (clash) throw new AppError("DISTRICT_EXISTS", `${clash} is already a district`, HttpStatus.CONFLICT, { field: "name" });
      catalog.districts.push(input.name);
      catalog.zonesByDistrict[input.name] = [];
      geo.deleted.districts = without(geo.deleted.districts, input.name);
      setPoint(geo.coordinates.districts, input.name, input);
      return { result: { district: input.name }, audit: [{ action: "geo.district.create", entityId: input.name, data: { name: input.name, lat: input.lat ?? null, lng: input.lng ?? null } }] };
    });
  }

  updateDistrict(actor: Actor, input: z.infer<typeof updateDistrictSchema>, meta: RequestMeta) {
    return this.mutate(actor, meta, async ({ catalog, meta: geo, tx }) => {
      const district = this.findDistrict(catalog, input.district);
      let name = district;
      let references: Record<string, number> = {};
      if (input.name && input.name !== district) {
        const clash = catalog.districts.find(d => same(d, input.name!) && d !== district);
        if (clash) throw new AppError("DISTRICT_EXISTS", `${clash} is already a district`, HttpStatus.CONFLICT, { field: "name" });
        name = input.name;
        references = await renameDistrictRecord(tx, catalog, geo, district, name);
      }
      if (input.active !== undefined) geo.inactive.districts = input.active ? without(geo.inactive.districts, name) : withName(geo.inactive.districts, name);
      if (input.lat !== undefined) setPoint(geo.coordinates.districts, name, input);
      return {
        result: { district: name, active: !listed(geo.inactive.districts, name), references },
        audit: [{ action: "geo.district.update", entityId: name, data: { district, ...changes(input, district), references } }],
      };
    });
  }

  deleteDistrict(actor: Actor, districtName: string, meta: RequestMeta) {
    return this.mutate(actor, meta, async ({ catalog, meta: geo, tx }) => {
      const district = this.findDistrict(catalog, districtName);
      await this.assertUnused(tx, catalog, { district }, district);
      const zones = catalog.zonesByDistrict[district] ?? [];
      catalog.districts = catalog.districts.filter(d => d !== district);
      delete catalog.zonesByDistrict[district];
      for (const z of zones) forgetZone(catalog, geo, z);
      geo.inactive.districts = without(geo.inactive.districts, district);
      deleteKey(geo.coordinates.districts, district);
      geo.deleted.districts = withName(geo.deleted.districts, district);
      return { result: { deleted: true, district }, audit: [{ action: "geo.district.delete", entityId: district, data: { district, zones: zones.length } }] };
    });
  }

  // ───────────── zones ─────────────

  createZone(actor: Actor, input: z.infer<typeof createZoneSchema>, meta: RequestMeta) {
    return this.mutate(actor, meta, async ({ catalog, meta: geo, tx }) => {
      const district = this.findDistrict(catalog, input.district);
      this.assertZoneNameFree(catalog, input.name, district);
      (catalog.zonesByDistrict[district] ??= []).push(input.name);
      geo.deleted.zones = geo.deleted.zones.filter(k => !same(k, `${district}|${input.name}`));
      setPoint(geo.coordinates.zones, input.name, input);
      let deliveryZone: { id: string; code: string; hubId: string | null } | null = null;
      if (input.hubId) {
        const hub = await tx.hub.findUnique({ where: { id: input.hubId }, select: { id: true, active: true, name: true } });
        if (!hub) throw notFound("Hub");
        if (!hub.active) throw new AppError("HUB_INACTIVE", `${hub.name} is deactivated; choose an active hub`, HttpStatus.UNPROCESSABLE_ENTITY, { field: "hubId" });
        const existing = await tx.deliveryZone.findFirst({ where: { district: { equals: district, mode: "insensitive" }, name: { equals: input.name, mode: "insensitive" } } });
        deliveryZone = existing
          ? await tx.deliveryZone.update({ where: { id: existing.id }, data: { hubId: hub.id, name: input.name, district }, select: { id: true, code: true, hubId: true } })
          : await tx.deliveryZone.create({
              data: { code: await freeZoneCode(tx, district, input.name), name: input.name, district, areas: [], hubId: hub.id, lat: input.lat ?? null, lng: input.lng ?? null },
              select: { id: true, code: true, hubId: true },
            });
        // Merchants picking up in this zone now belong to its hub.
        await rederiveMerchantHubs(tx, this.audit, actor, meta, merchantsInZone(district, input.name), "geo.zone.create");
      }
      return {
        result: { district, zone: input.name, deliveryZone },
        audit: [{ action: "geo.zone.create", entityId: `${district}|${input.name}`, data: { district, name: input.name, lat: input.lat ?? null, lng: input.lng ?? null, hubId: input.hubId ?? null, deliveryZone } }],
      };
    });
  }

  updateZone(actor: Actor, input: z.infer<typeof updateZoneSchema>, meta: RequestMeta) {
    return this.mutate(actor, meta, async ({ catalog, meta: geo, tx }) => {
      const district = this.findDistrict(catalog, input.district);
      const zone = this.findZone(catalog, district, input.zone);
      let name = zone;
      let references: Record<string, number> = {};
      if (input.name && input.name !== zone) {
        this.assertZoneNameFree(catalog, input.name, district, zone);
        name = input.name;
        catalog.zonesByDistrict[district] = catalog.zonesByDistrict[district].map(z => (z === zone ? name : z));
        catalog.areasByZone = renameKey(catalog.areasByZone, zone, name);
        geo.inactive.zones = geo.inactive.zones.map(z => (same(z, zone) ? name : z));
        geo.inactive.areas = renameKey(geo.inactive.areas, zone, name);
        geo.coordinates.zones = renameKey(geo.coordinates.zones, zone, name);
        geo.coordinates.areas = renameKey(geo.coordinates.areas, zone, name);
        geo.deleted.zones = withName(without(geo.deleted.zones, `${district}|${name}`), `${district}|${zone}`);
        geo.deleted.areas = geo.deleted.areas.map(k => (same(k.split("|")[0], zone) ? `${name}|${k.split("|")[1]}` : k));
        references = await renameReferences(tx, { district, zone }, name);
      }
      if (input.active !== undefined) geo.inactive.zones = input.active ? without(geo.inactive.zones, name) : withName(geo.inactive.zones, name);
      if (input.lat !== undefined) setPoint(geo.coordinates.zones, name, input);
      return {
        result: { district, zone: name, active: !listed(geo.inactive.zones, name), references },
        audit: [{ action: "geo.zone.update", entityId: `${district}|${name}`, data: { district, zone, ...changes(input, zone), references } }],
      };
    });
  }

  deleteZone(actor: Actor, query: { district: string; zone: string }, meta: RequestMeta) {
    return this.mutate(actor, meta, async ({ catalog, meta: geo, tx }) => {
      const district = this.findDistrict(catalog, query.district);
      const zone = this.findZone(catalog, district, query.zone);
      await this.assertUnused(tx, catalog, { district, zone }, `${zone} (${district})`);
      catalog.zonesByDistrict[district] = catalog.zonesByDistrict[district].filter(z => z !== zone);
      const areas = catalog.areasByZone[zone]?.length ?? 0;
      forgetZone(catalog, geo, zone);
      geo.deleted.zones = withName(geo.deleted.zones, `${district}|${zone}`);
      return { result: { deleted: true, district, zone }, audit: [{ action: "geo.zone.delete", entityId: `${district}|${zone}`, data: { district, zone, areas } }] };
    });
  }

  // ───────────── areas ─────────────

  /** Adds one or many areas (pasted lines). Existing names and invalid lines are skipped and reported. */
  addAreas(actor: Actor, input: z.infer<typeof addAreasSchema>, meta: RequestMeta) {
    return this.mutate(actor, meta, async ({ catalog, meta: geo }) => {
      const district = this.findDistrict(catalog, input.district);
      const zone = this.findZone(catalog, district, input.zone);
      const list = (catalog.areasByZone[zone] ??= []);
      const added: string[] = [];
      const skipped: { line: number; name: string; reason: string }[] = [];
      input.names.forEach((raw, i) => {
        const name = raw.trim().replace(/\s+/g, " ");
        if (!name) return;
        const skip = (reason: string) => skipped.push({ line: i + 1, name, reason });
        if (name.length > 80) return skip("longer than 80 characters");
        if (name.includes("|")) return skip('contains "|"');
        const existing = list.find(a => same(a, name));
        if (existing) return skip(added.includes(existing) ? "listed twice" : `already an area of ${zone}`);
        if (list.length >= 500) return skip(`${zone} already has 500 areas (the most a zone can have)`);
        list.push(name);
        added.push(name);
        geo.deleted.areas = without(geo.deleted.areas, `${zone}|${name}`);
      });
      if (!added.length && !skipped.length) throw new AppError("VALIDATION_FAILED", "Enter at least one area", HttpStatus.UNPROCESSABLE_ENTITY, { field: "names" });
      return {
        result: { district, zone, added, skipped },
        audit: added.length ? [{ action: added.length > 1 ? "geo.area.bulk_create" : "geo.area.create", entityId: `${district}|${zone}`, data: { district, zone, added, skipped: skipped.length } }] : [],
      };
    });
  }

  updateArea(actor: Actor, input: z.infer<typeof updateAreaSchema>, meta: RequestMeta) {
    return this.mutate(actor, meta, async ({ catalog, meta: geo, tx }) => {
      const district = this.findDistrict(catalog, input.district);
      const zone = this.findZone(catalog, district, input.zone);
      const area = this.findArea(catalog, zone, input.area);
      let name = area;
      let references: Record<string, number> = {};
      const zoneKey = keyOf(geo.inactive.areas, zone) ?? zone;
      if (input.name && input.name !== area) {
        const clash = catalog.areasByZone[zone].find(a => same(a, input.name!) && a !== area);
        if (clash) throw new AppError("AREA_EXISTS", `${clash} is already an area of ${zone}`, HttpStatus.CONFLICT, { field: "name" });
        name = input.name;
        catalog.areasByZone[zone] = catalog.areasByZone[zone].map(a => (a === area ? name : a));
        if (geo.inactive.areas[zoneKey]) geo.inactive.areas[zoneKey] = geo.inactive.areas[zoneKey].map(a => (same(a, area) ? name : a));
        const pointsKey = keyOf(geo.coordinates.areas, zone);
        if (pointsKey) geo.coordinates.areas[pointsKey] = renameKey(geo.coordinates.areas[pointsKey], area, name);
        geo.deleted.areas = withName(without(geo.deleted.areas, `${zone}|${name}`), `${zone}|${area}`);
        references = await renameReferences(tx, { district, zone, area }, name);
      }
      if (input.active !== undefined) {
        const next = input.active ? without(geo.inactive.areas[zoneKey] ?? [], name) : withName(geo.inactive.areas[zoneKey] ?? [], name);
        if (next.length) geo.inactive.areas[zoneKey] = next;
        else delete geo.inactive.areas[zoneKey];
      }
      if (input.lat !== undefined) setPoint((geo.coordinates.areas[keyOf(geo.coordinates.areas, zone) ?? zone] ??= {}), name, input);
      return {
        result: { district, zone, area: name, active: !listed(inactiveAreasOf(geo, zone), name), references },
        audit: [{ action: "geo.area.update", entityId: `${district}|${zone}|${name}`, data: { district, zone, area, ...changes(input, area), references } }],
      };
    });
  }

  deleteArea(actor: Actor, query: { district: string; zone: string; area: string }, meta: RequestMeta) {
    return this.mutate(actor, meta, async ({ catalog, meta: geo, tx }) => {
      const district = this.findDistrict(catalog, query.district);
      const zone = this.findZone(catalog, district, query.zone);
      const area = this.findArea(catalog, zone, query.area);
      await this.assertUnused(tx, catalog, { district, zone, area }, `${area} (${zone})`);
      catalog.areasByZone[zone] = catalog.areasByZone[zone].filter(a => a !== area);
      if (!catalog.areasByZone[zone].length) delete catalog.areasByZone[zone];
      const zoneKey = keyOf(geo.inactive.areas, zone);
      if (zoneKey) {
        geo.inactive.areas[zoneKey] = without(geo.inactive.areas[zoneKey], area);
        if (!geo.inactive.areas[zoneKey].length) delete geo.inactive.areas[zoneKey];
      }
      const pointsKey = keyOf(geo.coordinates.areas, zone);
      if (pointsKey) deleteKey(geo.coordinates.areas[pointsKey], area);
      geo.deleted.areas = withName(geo.deleted.areas, `${zone}|${area}`);
      return { result: { deleted: true, district, zone, area }, audit: [{ action: "geo.area.delete", entityId: `${district}|${zone}|${area}`, data: { district, zone, area } }] };
    });
  }

  // ───────────── helpers ─────────────

  /** Runs a change on the full catalog and its state under the catalog lock, validates, saves, audits and announces it. */
  private async mutate<T>(actor: Actor, meta: RequestMeta, change: (state: State) => Promise<Change<T>>): Promise<T> {
    const done = await this.prisma.$transaction(
      async tx => {
        await lockGeography(tx);
        const state: State = { catalog: structuredClone(await this.pricing.catalog(tx, { includeInactive: true })), meta: await readMeta(tx), tx };
        const out = await change(state);
        const parsed = catalogSchema.safeParse(state.catalog);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw new AppError("GEOGRAPHY_INVALID", issue?.message ?? "The change would leave the catalog invalid", HttpStatus.UNPROCESSABLE_ENTITY, { path: issue?.path });
        }
        const catalogValue = parsed.data as unknown as Prisma.InputJsonObject;
        const metaValue = state.meta as unknown as Prisma.InputJsonObject;
        await tx.setting.upsert({ where: { key: "catalog" }, create: { key: "catalog", value: catalogValue }, update: { value: catalogValue } });
        await tx.setting.upsert({ where: { key: GEO_META_KEY }, create: { key: GEO_META_KEY, value: metaValue }, update: { value: metaValue } });
        for (const entry of out.audit) await this.audit.record(actor, { ...entry, entityType: "geography" }, meta, tx);
        return out;
      },
      { timeout: 120_000, maxWait: 15_000 },
    );
    this.announce(done.audit[0]?.action ?? "geo.update");
    return done.result;
  }

  /** Every page refreshes its catalog (dropdowns, templates, address search) on this event. */
  announce(action: string) {
    this.realtime.publish({ type: "catalog.updated", id: "catalog", staffPermission: "support:create", data: { action } });
  }

  private async assertUnused(tx: Db, catalog: Catalog, target: { district: string; zone?: string; area?: string }, label: string) {
    const usage: Usage = await placeUsage(tx, catalog, target);
    if (usage.total)
      throw new AppError(
        "IN_USE",
        `${label} is in use and can't be deleted (${describeUsage(usage)}). Deactivate it instead: it disappears from new bookings and lists, and existing records keep it.`,
        HttpStatus.CONFLICT,
        { usage },
      );
  }

  private assertZoneNameFree(catalog: Catalog, name: string, district: string, except?: string) {
    for (const [d, zones] of Object.entries(catalog.zonesByDistrict)) {
      const clash = zones.find(z => same(z, name) && z !== except);
      if (clash)
        throw new AppError(
          "ZONE_EXISTS",
          `${clash} is already a zone of ${d}. Zone names are unique across the country; add the district to tell them apart, e.g. "${name} (${district})".`,
          HttpStatus.CONFLICT,
          { field: "name", district: d },
        );
    }
  }

  private findDistrict(catalog: Catalog, name: string) {
    const d = catalog.districts.find(x => same(x, name));
    if (!d) throw new AppError("NOT_FOUND", `${name} isn't a district in the service catalog`, HttpStatus.NOT_FOUND, { field: "district" });
    return d;
  }
  private findZone(catalog: Catalog, district: string, name: string) {
    const z = (catalog.zonesByDistrict[district] ?? []).find(x => same(x, name));
    if (!z) throw new AppError("NOT_FOUND", `${name} isn't a zone of ${district}`, HttpStatus.NOT_FOUND, { field: "zone" });
    return z;
  }
  private findArea(catalog: Catalog, zone: string, name: string) {
    const a = (catalog.areasByZone[zone] ?? []).find(x => same(x, name));
    if (!a) throw new AppError("NOT_FOUND", `${name} isn't an area of ${zone}`, HttpStatus.NOT_FOUND, { field: "area" });
    return a;
  }
  private resolve(catalog: Catalog, q: { district: string; zone?: string; area?: string }) {
    const district = this.findDistrict(catalog, q.district);
    const zone = q.zone ? this.findZone(catalog, district, q.zone) : undefined;
    const area = q.area && zone ? this.findArea(catalog, zone, q.area) : undefined;
    return { district, ...(zone ? { zone } : {}), ...(area ? { area } : {}) };
  }
}

// ───────────── plain helpers ─────────────

function renameKey<T>(record: Record<string, T>, from: string, to: string): Record<string, T> {
  const key = keyOf(record, from);
  if (key === undefined) return record;
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k === key ? to : k, v]));
}
function deleteKey(record: Record<string, unknown>, name: string) {
  const key = keyOf(record, name);
  if (key !== undefined) delete record[key];
}
function setPoint(record: Record<string, LatLng>, name: string, p: { lat?: number | null; lng?: number | null }) {
  deleteKey(record, name);
  if (p.lat != null && p.lng != null) record[name] = { lat: p.lat, lng: p.lng };
}
/** Removes a zone's areas and state (the zone itself was taken out of its district). */
function forgetZone(catalog: Catalog, geo: GeoMeta, zone: string) {
  delete catalog.areasByZone[zone];
  geo.inactive.zones = without(geo.inactive.zones, zone);
  deleteKey(geo.inactive.areas, zone);
  deleteKey(geo.coordinates.zones, zone);
  deleteKey(geo.coordinates.areas, zone);
}
const changes = (input: { name?: string; active?: boolean; lat?: number | null; lng?: number | null }, before: string) => ({
  ...(input.name && input.name !== before ? { renamedTo: input.name } : {}),
  ...(input.active !== undefined ? { active: input.active } : {}),
  ...(input.lat !== undefined ? { lat: input.lat, lng: input.lng ?? null } : {}),
});

/**
 * Renames a district in the catalog and its state (in place) and on every record that names it, in
 * the caller's transaction. The old name is tombstoned for the BD seed. Returns the reference counts.
 * Used by the geography admin and by data migrations such as the BD seed's "Dhaka (Sub-urban)".
 */
export async function renameDistrictRecord(tx: Db, catalog: Catalog, geo: GeoMeta, district: string, name: string) {
  catalog.districts = catalog.districts.map(d => (d === district ? name : d));
  catalog.zonesByDistrict = renameKey(catalog.zonesByDistrict, district, name);
  geo.inactive.districts = geo.inactive.districts.map(d => (same(d, district) ? name : d));
  geo.coordinates.districts = renameKey(geo.coordinates.districts, district, name);
  geo.deleted.districts = withName(without(geo.deleted.districts, name), district);
  geo.deleted.zones = geo.deleted.zones.map(k => (same(k.split("|")[0], district) ? `${name}|${k.split("|")[1]}` : k));
  return renameReferences(tx, { district }, name);
}

/** A free delivery-zone code: <district letters>-<zone letters>, ≤ 24 characters. */
async function freeZoneCode(tx: Db, district: string, zone: string) {
  const letters = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const base = `${letters(district).slice(0, 3) || "ZN"}-${letters(zone.replace(/\s*\(.*\)$/, "")).slice(0, 10) || "Z"}`;
  for (let i = 1; ; i++) {
    const code = i === 1 ? base : `${base.slice(0, 20)}-${i}`;
    if (!(await tx.deliveryZone.findUnique({ where: { code }, select: { id: true } }))) return code;
  }
}

/**
 * Renames a place on every record that names it (case-insensitively), in the caller's
 * transaction. Returns the number of rows changed per table/column.
 */
async function renameReferences(tx: Db, from: { district: string; zone?: string; area?: string }, to: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const run = async (key: string, sql: string, ...params: unknown[]) => {
    const n = await tx.$executeRawUnsafe(sql, ...params);
    if (n) counts[key] = (counts[key] ?? 0) + n;
  };
  const eq = (c: string, i: number) => `lower("${c}") = lower($${i})`;
  /** In the district (rows without a district, e.g. SLA policies by zone only, match too). */
  const inDistrict = (c: string, i: number) => `("${c}" IS NULL OR ${eq(c, i)})`;
  const snapshot = async (part: "district" | "zone") => {
    for (const leg of ["origin", "destination"]) {
      const where =
        part === "district"
          ? `lower("pricingSnapshot" #>> '{${leg},district}') = lower($1)`
          : `lower("pricingSnapshot" #>> '{${leg},zone}') = lower($1) AND lower("pricingSnapshot" #>> '{${leg},district}') = lower($3)`;
      await run(`parcels.pricingSnapshot.${leg}`, `UPDATE "parcels" SET "pricingSnapshot" = jsonb_set("pricingSnapshot", '{${leg},${part}}', to_jsonb($2::text)) WHERE ${where}`, from[part === "district" ? "district" : "zone"], to, ...(part === "zone" ? [from.district] : []));
    }
  };

  if (from.area !== undefined) {
    const [old, d, z] = [from.area, from.district, from.zone!];
    for (const [t, dc, zc, ac] of [
      ["parcels", "pickupDistrict", "pickupZone", "pickupArea"],
      ["parcels", "deliveryDistrict", "deliveryZone", "deliveryArea"],
      ["addresses", "district", "zone", "area"],
      ["pickup_schedules", "district", "zone", "area"],
      ["pickup_requests", "district", "zone", "area"],
      ["merchants", "businessDistrict", "businessZone", "businessArea"],
    ])
      await run(`${t}.${ac}`, `UPDATE "${t}" SET "${ac}" = $2 WHERE ${eq(ac, 1)} AND ${eq(dc, 3)} AND ${eq(zc, 4)}`, old, to, d, z);
    await run("merchants.pickupArea", `UPDATE "merchants" SET "pickupArea" = $2 WHERE ${eq("pickupArea", 1)} AND ${eq("pickupDistrict", 3)}`, old, to, d);
    await run(
      "delivery_zones.areas",
      `UPDATE "delivery_zones" SET "areas" = ARRAY(SELECT CASE WHEN lower(a) = lower($1) THEN $2 ELSE a END FROM unnest("areas") AS a)
        WHERE ${eq("district", 3)} AND ${eq("name", 4)} AND EXISTS (SELECT 1 FROM unnest("areas") AS a WHERE lower(a) = lower($1))`,
      old,
      to,
      d,
      z,
    );
    return counts;
  }

  if (from.zone !== undefined) {
    const [old, d] = [from.zone, from.district];
    for (const [t, dc, zc] of [
      ["parcels", "pickupDistrict", "pickupZone"],
      ["parcels", "deliveryDistrict", "deliveryZone"],
      ["addresses", "district", "zone"],
      ["pickup_schedules", "district", "zone"],
      ["pickup_requests", "district", "zone"],
      ["merchants", "pickupDistrict", "pickupZone"],
      ["merchants", "businessDistrict", "businessZone"],
      ["hubs", "district", "zone"],
      ["delivery_zones", "district", "name"],
      ["sla_policies", "originDistrict", "originZone"],
      ["sla_policies", "destDistrict", "destZone"],
    ])
      await run(`${t}.${zc}`, `UPDATE "${t}" SET "${zc}" = $2 WHERE ${eq(zc, 1)} AND ${inDistrict(dc, 3)}`, old, to, d);
    await run("riders.zone", `UPDATE "riders" SET "zone" = $2 WHERE ${eq("zone", 1)}`, old, to);
    await run("merchants.pickupArea", `UPDATE "merchants" SET "pickupArea" = $2 WHERE ${eq("pickupArea", 1)} AND ${eq("pickupDistrict", 3)}`, old, to, d);
    await snapshot("zone");
    await renameImportDestination(tx, counts, "zone", old, to, d);
    return counts;
  }

  const old = from.district;
  for (const [t, dc] of [
    ["parcels", "pickupDistrict"],
    ["parcels", "deliveryDistrict"],
    ["addresses", "district"],
    ["merchants", "pickupDistrict"],
    ["merchants", "businessDistrict"],
    ["pickup_schedules", "district"],
    ["pickup_requests", "district"],
    ["hubs", "district"],
    ["delivery_zones", "district"],
    ["sla_policies", "originDistrict"],
    ["sla_policies", "destDistrict"],
  ])
    await run(`${t}.${dc}`, `UPDATE "${t}" SET "${dc}" = $2 WHERE ${eq(dc, 1)}`, old, to);
  await snapshot("district");
  await renameImportDestination(tx, counts, "district", old, to);
  return counts;
}

/** The import settings' fixed default destination follows a renamed district / zone. */
async function renameImportDestination(tx: Db, counts: Record<string, number>, part: "district" | "zone", old: string, to: string, district?: string) {
  const row = await tx.setting.findUnique({ where: { key: "import-config" } });
  const value = row?.value as { defaultDestination?: { mode?: string; district?: string; zone?: string } } | null;
  const dest = value?.defaultDestination;
  if (!row || dest?.mode !== "FIXED") return;
  if (part === "district" ? !same(dest.district, old) : !(same(dest.zone, old) && same(dest.district, district))) return;
  const next = { ...value, defaultDestination: { ...dest, [part]: to } } as Prisma.InputJsonObject;
  await tx.setting.update({ where: { key: "import-config" }, data: { value: next } });
  counts["settings.import-config"] = 1;
}
