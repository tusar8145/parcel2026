import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { hashPassword } from "../../common/crypto";
import { nextCounter } from "../../common/counters";
import { AppError, conflict, notFound } from "../../common/errors";
import { PricingService } from "../pricing/pricing.service";
import { RealtimeService } from "../../common/realtime.service";
import { GEO_META_KEY, listed, lockGeography, readMeta, same } from "../geography/geo-catalog";
import { describeUsage, hubUsage } from "../geography/geo-usage";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { ParcelStatus, Prisma } from "../../generated/prisma/client";
import type { createRiderSchema, hubSchema, listRidersQuerySchema, updateHubSchema, updateRiderSchema } from "./network.schemas";
import { opsHubScope } from "../parcels/ops-scope";

const OPEN_DELIVERY_STATUSES: ParcelStatus[] = ["ASSIGNED", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "EXCEPTION"];

export const riderView = (r: {
  id: string;
  code: string;
  vehicle: string;
  zone: string | null;
  status: string;
  active: boolean;
  dailyCapacity?: number | null;
  hub: { id: string; name: string; code: string; type?: string } | null;
  user: { name: string; phone: string };
  _count?: { pickups: number; deliveries: number };
}) => ({
  id: r.id,
  code: r.code,
  name: r.user.name,
  phone: r.user.phone,
  /** "R-2048 · Jordan Rivera", the label the web panels use. */
  label: `${r.code} · ${r.user.name}`,
  vehicle: r.vehicle,
  zone: r.zone,
  status: r.status,
  active: r.active,
  dailyCapacity: r.dailyCapacity ?? null,
  hub: r.hub,
  openTasks: r._count ? r._count.pickups + r._count.deliveries : undefined,
});

const riderInclude = {
  user: { select: { name: true, phone: true } },
  hub: { select: { id: true, name: true, code: true, type: true } },
  _count: {
    select: {
      pickups: { where: { status: { in: ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED"] as ParcelStatus[] } } },
      deliveries: { where: { status: { in: OPEN_DELIVERY_STATUSES } } },
    },
  },
} satisfies Prisma.RiderInclude;

@Injectable()
export class NetworkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly pricing: PricingService,
  ) {}

  /** Hub changes are announced to operations (property injection keeps the constructor stable for parallel edits). */
  @Inject(RealtimeService) private readonly realtime!: RealtimeService;

  // ── hubs ──
  /**
   * The catalog spelling of the hub's district and zone. The zone must be a zone of the district;
   * deactivated places are refused unless the hub already had them (`current`).
   */
  private async hubPlace(district: string, zone: string | null | undefined, current?: { district: string; zone: string | null }) {
    const [catalog, geo] = await Promise.all([this.pricing.catalog(undefined, { includeInactive: true }), readMeta(this.prisma)]);
    const d = catalog.districts.find(x => same(x, district));
    if (!d) throw new AppError("HUB_DISTRICT_INVALID", `${district} isn't a district in the service catalog.`, HttpStatus.UNPROCESSABLE_ENTITY, { field: "district" });
    if (listed(geo.inactive.districts, d) && !same(d, current?.district)) throw new AppError("HUB_DISTRICT_INVALID", `${d} is deactivated. Choose an active district.`, HttpStatus.UNPROCESSABLE_ENTITY, { field: "district" });
    if (zone == null) return { district: d, zone };
    const match = (catalog.zonesByDistrict[d] ?? []).find(z => same(z, zone));
    if (!match) throw new AppError("HUB_ZONE_INVALID", `${zone} is not a zone of ${d}. Choose one of the district's zones.`, HttpStatus.UNPROCESSABLE_ENTITY, { field: "zone" });
    if (listed(geo.inactive.zones, match) && !(same(match, current?.zone) && same(d, current?.district)))
      throw new AppError("HUB_ZONE_INVALID", `${match} is deactivated. Choose an active zone of ${d}.`, HttpStatus.UNPROCESSABLE_ENTITY, { field: "zone" });
    return { district: d, zone: match };
  }

  private async assertHubNameFree(name: string, exceptId?: string) {
    const clash = await this.prisma.hub.findFirst({ where: { name: { equals: name.trim(), mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { code: true } });
    if (clash) throw new AppError("HUB_NAME_TAKEN", `Hub ${clash.code} already has the name ${name.trim()}`, HttpStatus.CONFLICT, { field: "name" });
  }

  listHubs(includeInactive: boolean) {
    return this.prisma.hub.findMany({ where: includeInactive ? {} : { active: true }, orderBy: { name: "asc" } });
  }

  async createHub(actor: Actor, input: z.infer<typeof hubSchema>, meta: RequestMeta) {
    if (await this.prisma.hub.findUnique({ where: { code: input.code } })) throw conflict("HUB_CODE_TAKEN", `Hub code ${input.code} is already used`);
    await this.assertHubNameFree(input.name);
    input = { ...input, ...(await this.hubPlace(input.district, input.zone)) };
    const hub = await this.prisma.$transaction(async tx => {
      const created = await tx.hub.create({ data: input });
      await this.audit.record(actor, { action: "hub.create", entityType: "hub", entityId: created.id, data: input }, meta, tx);
      return created;
    });
    this.hubsChanged(hub.code);
    return hub;
  }

  async updateHub(actor: Actor, id: string, input: z.infer<typeof updateHubSchema>, meta: RequestMeta) {
    const current = await this.prisma.hub.findUnique({ where: { id } });
    if (!current) throw notFound("Hub");
    if (input.code && input.code !== current.code && (await this.prisma.hub.findUnique({ where: { code: input.code } }))) throw conflict("HUB_CODE_TAKEN", `Hub code ${input.code} is already used`);
    if (input.name && !same(input.name, current.name)) await this.assertHubNameFree(input.name, id);
    // A new district needs a zone of that district: the old zone is checked against it too.
    if (input.zone !== undefined || (input.district !== undefined && !same(input.district, current.district)))
      input = { ...input, ...(await this.hubPlace(input.district ?? current.district, input.zone !== undefined ? input.zone : current.zone, current)) };
    const hub = await this.prisma.$transaction(async tx => {
      const updated = await tx.hub.update({ where: { id }, data: input });
      await this.audit.record(
        actor,
        { action: input.active === false && current.active ? "hub.deactivate" : input.active === true && !current.active ? "hub.activate" : "hub.update", entityType: "hub", entityId: id, data: input },
        meta,
        tx,
      );
      return updated;
    });
    this.hubsChanged(hub.code);
    return hub;
  }

  /** Everything that references the hub (parcels, riders, staff, zones it serves, routes, cash, linehaul, scans…). */
  async hubUsage(id: string) {
    const hub = await this.prisma.hub.findUnique({ where: { id }, select: { id: true, code: true, name: true, active: true } });
    if (!hub) throw notFound("Hub");
    return { hub, ...(await hubUsage(this.prisma, id)) };
  }

  /** Deletes a hub nothing references (409 IN_USE with the usage otherwise: deactivate it instead). */
  async deleteHub(actor: Actor, id: string, meta: RequestMeta) {
    const hub = await this.prisma.$transaction(
      async tx => {
        const row = await tx.hub.findUnique({ where: { id } });
        if (!row) throw notFound("Hub");
        const usage = await hubUsage(tx, id);
        if (usage.total)
          throw new AppError("IN_USE", `${row.name} is in use and can't be deleted (${describeUsage(usage)}). Deactivate it instead: it disappears from new bookings and lists, and existing records keep it.`, HttpStatus.CONFLICT, { usage });
        await tx.hub.delete({ where: { id } });
        // The BD geography seed must not bring a deleted network hub back.
        await lockGeography(tx);
        const geo = await readMeta(tx);
        if (!geo.deleted.hubs.includes(row.code)) {
          geo.deleted.hubs.push(row.code);
          const value = geo as unknown as Prisma.InputJsonObject;
          await tx.setting.upsert({ where: { key: GEO_META_KEY }, create: { key: GEO_META_KEY, value }, update: { value } });
        }
        await this.audit.record(actor, { action: "hub.delete", entityType: "hub", entityId: id, data: { code: row.code, name: row.name, district: row.district, zone: row.zone } }, meta, tx);
        return row;
      },
      { timeout: 30_000 },
    );
    this.hubsChanged(hub.code);
    return { deleted: true, id, code: hub.code };
  }

  private hubsChanged(code: string) {
    this.realtime.publish({ type: "network.updated", id: code, data: { kind: "hub" }, staffPermission: "hub:read" });
  }

  // ── riders ──
  async listRiders(query: z.infer<typeof listRidersQuerySchema>, actor?: Actor) {
    // Hub staff don't see other hubs' franchise riders (they work only for their franchise); operations managers do.
    const scope = actor ? opsHubScope(actor) : null;
    const riders = await this.prisma.rider.findMany({
      where: {
        hubId: query.hubId,
        ...(scope ? { OR: [{ hubId: null }, { hub: { type: "COMPANY" } }, { hubId: { in: scope } }] } : {}),
        status: query.status,
        active: query.active,
        ...(query.q
          ? { OR: [{ code: { contains: query.q, mode: "insensitive" } }, { user: { name: { contains: query.q, mode: "insensitive" } } }, { user: { phone: { contains: query.q } } }] }
          : {}),
      },
      include: riderInclude,
      orderBy: { code: "asc" },
    });
    return riders.map(riderView);
  }

  async getRider(id: string) {
    const rider = await this.prisma.rider.findUnique({ where: { id }, include: riderInclude });
    if (!rider) throw notFound("Rider");
    return riderView(rider);
  }

  async createRider(actor: Actor, input: z.infer<typeof createRiderSchema>, meta: RequestMeta) {
    const rider = await this.prisma.$transaction(async tx => {
      const code = input.code ?? `R-${await nextCounter(tx, "rider-code", 2100)}`;
      if (await tx.rider.findUnique({ where: { code } })) throw conflict("RIDER_CODE_TAKEN", `Rider code ${code} is already used`);
      const existing = await tx.user.findUnique({ where: { phone: input.phone }, include: { rider: true } });
      if (existing?.rider) throw conflict("ALREADY_A_RIDER", "This person is already a rider");
      const user =
        existing ??
        (await tx.user.create({
          data: {
            name: input.name,
            phone: input.phone,
            email: input.email,
            passwordHash: input.password ? await hashPassword(input.password) : null,
          },
        }));
      await tx.userRole.create({ data: { userId: user.id, role: "RIDER" } });
      const created = await tx.rider.create({
        data: { userId: user.id, code, hubId: input.hubId, vehicle: input.vehicle, zone: input.zone, dailyCapacity: input.dailyCapacity },
        include: riderInclude,
      });
      await this.audit.record(actor, { action: "rider.create", entityType: "rider", entityId: created.id, data: { code, phone: input.phone } }, meta, tx);
      return created;
    });
    return riderView(rider);
  }

  async updateRider(actor: Actor, id: string, input: z.infer<typeof updateRiderSchema>, meta: RequestMeta) {
    await this.getRider(id);
    const rider = await this.prisma.rider.update({ where: { id }, data: input, include: riderInclude });
    await this.audit.record(actor, { action: "rider.update", entityType: "rider", entityId: id, data: input }, meta);
    return riderView(rider);
  }

  async myRiderProfile(actor: UserActor) {
    if (!actor.riderId) throw notFound("Rider profile");
    return this.getRider(actor.riderId);
  }

  async setMyStatus(actor: UserActor, status: "OFFLINE" | "ONLINE" | "ON_BREAK") {
    if (!actor.riderId) throw notFound("Rider profile");
    const rider = await this.prisma.rider.update({ where: { id: actor.riderId }, data: { status }, include: riderInclude });
    return riderView(rider);
  }
}
