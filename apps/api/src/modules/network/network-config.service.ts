import { Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { RealtimeService } from "../../common/realtime.service";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, conflict, notFound } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import type { Prisma } from "../../generated/prisma/client";
import { PricingService } from "../pricing/pricing.service";
import { opsHubScope } from "../parcels/ops-scope";
import type { listRoutesQuerySchema, listZonesQuerySchema, routeSchema, updateRouteSchema, updateZoneSchema, zoneSchema } from "./network-config.schemas";

const zoneInclude = {
  hub: { select: { id: true, code: true, name: true } },
  route: { select: { id: true, code: true, name: true } },
} satisfies Prisma.DeliveryZoneInclude;
const routeInclude = {
  hub: { select: { id: true, code: true, name: true } },
  defaultRider: { select: { id: true, code: true, user: { select: { name: true } } } },
  _count: { select: { zones: true } },
} satisfies Prisma.DeliveryRouteInclude;

const routeView = (r: Prisma.DeliveryRouteGetPayload<{ include: typeof routeInclude }>) => {
  const { _count, defaultRider, ...rest } = r;
  return { ...rest, defaultRider: defaultRider ? { id: defaultRider.id, code: defaultRider.code, label: `${defaultRider.code} · ${defaultRider.user.name}` } : null, zones: _count.zones };
};

/** Parcels that occupy space at a hub. */
const HELD = ["AT_HUB", "ASSIGNED", "RETURN_SCHEDULED", "EXCEPTION"] as const;

/**
 * Network configuration used by assignment and SLA: delivery zones (catalog areas → zone →
 * hub), operating routes (zones a hub serves together, with a default rider) and hub
 * capacity.
 */
@Injectable()
export class NetworkConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly pricing: PricingService,
    private readonly realtime: RealtimeService,
  ) {}

  // ── zones ──

  async listZones(query: z.infer<typeof listZonesQuerySchema>) {
    const rows = await this.prisma.deliveryZone.findMany({
      where: {
        hubId: query.hubId,
        routeId: query.routeId,
        active: query.active,
        ...(query.district ? { district: { equals: query.district, mode: "insensitive" } } : {}),
        ...(query.q
          ? { OR: [{ code: { contains: query.q, mode: "insensitive" } }, { name: { contains: query.q, mode: "insensitive" } }, { areas: { has: query.q } }] }
          : {}),
      },
      include: zoneInclude,
      ...pageArgs(query),
    });
    return toPage(rows, query.limit);
  }

  async createZone(actor: Actor, input: z.infer<typeof zoneSchema>, meta: RequestMeta) {
    await this.checkCatalog(input.district, input.name, input.areas);
    await this.checkLinks(input.hubId, input.routeId);
    if (await this.prisma.deliveryZone.findUnique({ where: { code: input.code } })) throw conflict("ZONE_CODE_TAKEN", `Zone code ${input.code} is already used`);
    if (await this.prisma.deliveryZone.findUnique({ where: { district_name: { district: input.district, name: input.name } } }))
      throw conflict("ZONE_EXISTS", `${input.name}, ${input.district} is already configured; edit it instead`);
    const zone = await this.prisma.$transaction(async tx => {
      const created = await tx.deliveryZone.create({ data: input, include: zoneInclude });
      await this.audit.record(actor, { action: "zone.create", entityType: "delivery_zone", entityId: created.id, data: input }, meta, tx);
      return created;
    });
    this.changed("zone", zone.code);
    return zone;
  }

  async updateZone(actor: Actor, id: string, input: z.infer<typeof updateZoneSchema>, meta: RequestMeta) {
    const zone = await this.prisma.deliveryZone.findUnique({ where: { id } });
    if (!zone) throw notFound("Zone");
    if (input.areas) await this.checkCatalog(zone.district, zone.name, input.areas);
    await this.checkLinks(input.hubId, input.routeId);
    if (input.code && input.code !== zone.code && (await this.prisma.deliveryZone.findUnique({ where: { code: input.code } })))
      throw conflict("ZONE_CODE_TAKEN", `Zone code ${input.code} is already used`);
    const updated = await this.prisma.$transaction(async tx => {
      const row = await tx.deliveryZone.update({ where: { id }, data: input, include: zoneInclude });
      await this.audit.record(actor, { action: "zone.update", entityType: "delivery_zone", entityId: id, data: input }, meta, tx);
      return row;
    });
    this.changed("zone", updated.code);
    return updated;
  }

  async deleteZone(actor: Actor, id: string, meta: RequestMeta) {
    const zone = await this.prisma.deliveryZone.findUnique({ where: { id } });
    if (!zone) throw notFound("Zone");
    await this.prisma.$transaction(async tx => {
      await tx.deliveryZone.delete({ where: { id } });
      await this.audit.record(actor, { action: "zone.delete", entityType: "delivery_zone", entityId: id, data: { code: zone.code, name: zone.name, district: zone.district } }, meta, tx);
    });
    this.changed("zone", zone.code);
    return { deleted: true };
  }

  // ── routes ──

  async listRoutes(query: z.infer<typeof listRoutesQuerySchema>) {
    const rows = await this.prisma.deliveryRoute.findMany({
      where: {
        hubId: query.hubId,
        active: query.active,
        ...(query.q ? { OR: [{ code: { contains: query.q, mode: "insensitive" } }, { name: { contains: query.q, mode: "insensitive" } }] } : {}),
      },
      include: routeInclude,
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { items: page.items.map(routeView), nextCursor: page.nextCursor };
  }

  async createRoute(actor: Actor, input: z.infer<typeof routeSchema>, meta: RequestMeta) {
    await this.checkLinks(input.hubId, undefined, input.defaultRiderId);
    if (await this.prisma.deliveryRoute.findUnique({ where: { code: input.code } })) throw conflict("ROUTE_CODE_TAKEN", `Route code ${input.code} is already used`);
    const route = await this.prisma.$transaction(async tx => {
      const created = await tx.deliveryRoute.create({ data: input, include: routeInclude });
      await this.audit.record(actor, { action: "route.create", entityType: "delivery_route", entityId: created.id, data: input }, meta, tx);
      return created;
    });
    this.changed("route", route.code);
    return routeView(route);
  }

  async updateRoute(actor: Actor, id: string, input: z.infer<typeof updateRouteSchema>, meta: RequestMeta) {
    const route = await this.prisma.deliveryRoute.findUnique({ where: { id } });
    if (!route) throw notFound("Route");
    await this.checkLinks(input.hubId, undefined, input.defaultRiderId);
    if (input.code && input.code !== route.code && (await this.prisma.deliveryRoute.findUnique({ where: { code: input.code } })))
      throw conflict("ROUTE_CODE_TAKEN", `Route code ${input.code} is already used`);
    const updated = await this.prisma.$transaction(async tx => {
      const row = await tx.deliveryRoute.update({ where: { id }, data: input, include: routeInclude });
      await this.audit.record(actor, { action: "route.update", entityType: "delivery_route", entityId: id, data: input }, meta, tx);
      return row;
    });
    this.changed("route", updated.code);
    return routeView(updated);
  }

  /** Zones on the route stay configured; they just no longer belong to a route. */
  async deleteRoute(actor: Actor, id: string, meta: RequestMeta) {
    const route = await this.prisma.deliveryRoute.findUnique({ where: { id } });
    if (!route) throw notFound("Route");
    await this.prisma.$transaction(async tx => {
      await tx.deliveryRoute.delete({ where: { id } });
      await this.audit.record(actor, { action: "route.delete", entityType: "delivery_route", entityId: id, data: { code: route.code, name: route.name } }, meta, tx);
    });
    this.changed("route", route.code);
    return { deleted: true };
  }

  // ── hub capacity ──

  /** Each hub's load against its capacity, with the zones and routes it serves (hub operators: their hubs). */
  async hubCapacity(actor: Actor) {
    const scope = opsHubScope(actor);
    const [hubs, held, inbound, zones, routes] = await Promise.all([
      this.prisma.hub.findMany({ where: { active: true, ...(scope ? { id: { in: scope } } : {}) }, orderBy: { name: "asc" } }),
      this.prisma.parcel.groupBy({ by: ["currentHubId"], where: { currentHubId: { not: null }, status: { in: [...HELD] } }, _count: { _all: true } }),
      this.prisma.parcel.groupBy({ by: ["currentHubId"], where: { currentHubId: { not: null }, status: "IN_TRANSIT" }, _count: { _all: true } }),
      this.prisma.deliveryZone.groupBy({ by: ["hubId"], where: { active: true, hubId: { not: null } }, _count: { _all: true } }),
      this.prisma.deliveryRoute.groupBy({ by: ["hubId"], where: { active: true }, _count: { _all: true } }),
    ]);
    return hubs.map(h => {
      const load = held.find(r => r.currentHubId === h.id)?._count._all ?? 0;
      const arriving = inbound.find(r => r.currentHubId === h.id)?._count._all ?? 0;
      const utilisation = h.capacity ? Math.round((load / h.capacity) * 1000) / 10 : null;
      return {
        hub: { id: h.id, code: h.code, name: h.name, district: h.district, lat: h.lat, lng: h.lng },
        capacity: h.capacity,
        load,
        inbound: arriving,
        utilisation,
        projected: h.capacity ? Math.round(((load + arriving) / h.capacity) * 1000) / 10 : null,
        state: utilisation == null ? "Not set" : utilisation >= 100 ? "Over capacity" : utilisation >= 85 ? "Near capacity" : "OK",
        zones: zones.find(z => z.hubId === h.id)?._count._all ?? 0,
        routes: routes.find(r => r.hubId === h.id)?._count._all ?? 0,
      };
    });
  }

  // ── checks ──

  private async checkCatalog(district: string, zone: string, areas: string[]) {
    const catalog = await this.pricing.catalog();
    const zones = catalog.zonesByDistrict[district];
    if (!zones) throw new AppError("UNKNOWN_DISTRICT", `${district} isn't a district in the service catalog`, 422);
    if (!zones.includes(zone)) throw new AppError("UNKNOWN_ZONE", `${zone} isn't a ${district} zone in the service catalog`, 422);
    const known = catalog.areasByZone[zone] ?? [];
    const unknown = known.length ? areas.filter(a => !known.some(k => k.toLowerCase() === a.toLowerCase())) : [];
    if (unknown.length) throw new AppError("UNKNOWN_AREA", `Not ${zone} areas in the catalog: ${unknown.join(", ")}`, 422, { unknown });
  }

  private async checkLinks(hubId?: string | null, routeId?: string | null, riderId?: string | null) {
    if (hubId && !(await this.prisma.hub.findUnique({ where: { id: hubId }, select: { id: true } }))) throw notFound("Hub");
    if (routeId && !(await this.prisma.deliveryRoute.findUnique({ where: { id: routeId }, select: { id: true } }))) throw notFound("Route");
    if (riderId && !(await this.prisma.rider.findUnique({ where: { id: riderId }, select: { id: true } }))) throw notFound("Rider");
  }

  private changed(kind: "zone" | "route", id: string) {
    this.realtime.publish({ type: "network.updated", id, data: { kind }, staffPermission: "hub:read" });
  }
}
