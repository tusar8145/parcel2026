import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { GeoService } from "../geo/geo.service";

/** Inside Bangladesh (the hub form's limits): a geocoder answer elsewhere is a wrong match. */
const inBangladesh = (lat: number, lng: number) => lat >= 20 && lat <= 27 && lng >= 88 && lng <= 93;

/**
 * Super admin › Hubs & zones › "Find hub locations": hubs without a map location get one (riders and staff on several
 * hubs work at the nearest). The hub's address with its zone and district, else the zone and district, from the
 * geocoder; else the zone's planning centre. Hubs with a location keep it unless `overwrite`.
 */
@Injectable()
export class HubLocateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly geo: GeoService,
  ) {}

  async locate(actor: Actor, input: { overwrite?: boolean; hubIds?: string[] }, meta: RequestMeta) {
    const hubs = await this.prisma.hub.findMany({
      where: { ...(input.hubIds?.length ? { id: { in: input.hubIds } } : {}), ...(input.overwrite ? {} : { OR: [{ lat: null }, { lng: null }] }) },
      select: { id: true, code: true, name: true, address: true, zone: true, district: true },
      orderBy: { name: "asc" },
    });
    const results: { id: string; code: string; name: string; lat: number | null; lng: number | null; source: "address" | "zone" | "zone centre" | null; match: string | null }[] = [];
    for (const h of hubs) {
      let found: { lat: number; lng: number; source: "address" | "zone" | "zone centre"; match: string | null } | null = null;
      for (const [text, source] of [
        [[h.address, h.zone, h.district, "Bangladesh"].filter(Boolean).join(", "), "address"],
        [[h.zone, h.district, "Bangladesh"].filter(Boolean).join(", "), "zone"],
      ] as const) {
        if (found || !text) continue;
        const place = await this.geo.geocode(text).catch(() => null);
        if (place && inBangladesh(place.lat, place.lng)) found = { lat: place.lat, lng: place.lng, source, match: place.label };
      }
      if (!found && h.zone) {
        const zone = await this.prisma.deliveryZone.findFirst({ where: { district: h.district, name: { equals: h.zone, mode: "insensitive" }, lat: { not: null }, lng: { not: null } }, select: { lat: true, lng: true } });
        if (zone?.lat != null && zone.lng != null) found = { lat: zone.lat, lng: zone.lng, source: "zone centre", match: `${h.zone}, ${h.district}` };
      }
      if (found) await this.prisma.hub.update({ where: { id: h.id }, data: { lat: Math.round(found.lat * 1e6) / 1e6, lng: Math.round(found.lng * 1e6) / 1e6 } });
      results.push({ id: h.id, code: h.code, name: h.name, lat: found?.lat ?? null, lng: found?.lng ?? null, source: found?.source ?? null, match: found?.match ?? null });
    }
    await this.audit.record(actor, { action: "hub.locate", entityType: "hub", entityId: undefined, data: { hubs: results.map(r => ({ code: r.code, source: r.source })) } }, meta);
    return { checked: results.length, located: results.filter(r => r.source).length, hubs: results };
  }
}
