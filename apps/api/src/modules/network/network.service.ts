import { Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { hashPassword } from "../../common/crypto";
import { nextCounter } from "../../common/counters";
import { conflict, notFound } from "../../common/errors";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { ParcelStatus, Prisma } from "../../generated/prisma/client";
import type { createRiderSchema, hubSchema, listRidersQuerySchema, updateHubSchema, updateRiderSchema } from "./network.schemas";

const OPEN_DELIVERY_STATUSES: ParcelStatus[] = ["ASSIGNED", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "EXCEPTION"];

export const riderView = (r: {
  id: string;
  code: string;
  vehicle: string;
  zone: string | null;
  status: string;
  active: boolean;
  dailyCapacity?: number | null;
  hub: { id: string; name: string; code: string } | null;
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
  hub: { select: { id: true, name: true, code: true } },
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
  ) {}

  // ── hubs ──
  listHubs(includeInactive: boolean) {
    return this.prisma.hub.findMany({ where: includeInactive ? {} : { active: true }, orderBy: { name: "asc" } });
  }

  async createHub(actor: Actor, input: z.infer<typeof hubSchema>, meta: RequestMeta) {
    if (await this.prisma.hub.findUnique({ where: { code: input.code } })) throw conflict("HUB_CODE_TAKEN", `Hub code ${input.code} is already used`);
    const hub = await this.prisma.hub.create({ data: input });
    await this.audit.record(actor, { action: "hub.create", entityType: "hub", entityId: hub.id, data: input }, meta);
    return hub;
  }

  async updateHub(actor: Actor, id: string, input: z.infer<typeof updateHubSchema>, meta: RequestMeta) {
    await this.prisma.hub.findUnique({ where: { id } }).then(h => h ?? Promise.reject(notFound("Hub")));
    const hub = await this.prisma.hub.update({ where: { id }, data: input });
    await this.audit.record(actor, { action: "hub.update", entityType: "hub", entityId: id, data: input }, meta);
    return hub;
  }

  // ── riders ──
  async listRiders(query: z.infer<typeof listRidersQuerySchema>) {
    const riders = await this.prisma.rider.findMany({
      where: {
        hubId: query.hubId,
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
