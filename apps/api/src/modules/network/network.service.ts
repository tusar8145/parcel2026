import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { merchantsInZone, rederiveMerchantHubs } from "../merchants/merchant-hubs";
import { hashPassword } from "../../common/crypto";
import { nextCounter } from "../../common/counters";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import { PricingService } from "../pricing/pricing.service";
import { RealtimeService } from "../../common/realtime.service";
import { GEO_META_KEY, listed, lockGeography, readMeta, same } from "../geography/geo-catalog";
import { describeUsage, hubUsage } from "../geography/geo-usage";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { ParcelStatus, Prisma } from "../../generated/prisma/client";
import type { appRiderSchema, createRiderSchema, hubSchema, listRidersQuerySchema, updateHubSchema, updateRiderSchema } from "./network.schemas";
import { hubManagerHubIds, opsHubScope } from "../parcels/ops-scope";
import { SessionService } from "../auth/session.service";
import { env } from "../../config/env";
import { NotifyService } from "../notifications/notify.service";
import { inviteMessage } from "../notifications/account-invite";
import { nearestOf } from "./nearest-hub";

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
  hubs?: { hub: { id: string; name: string; code: string; type?: string } }[];
  user: { name: string; phone: string; email?: string | null };
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
  email: r.user.email ?? null,
  /** The hub the rider works at now (cash goes there; with several hubs, the nearest). */
  hub: r.hub,
  /** Every hub the rider works for. */
  hubs: r.hubs?.length ? r.hubs.map(h => h.hub) : r.hub ? [r.hub] : [],
  openTasks: r._count ? r._count.pickups + r._count.deliveries : undefined,
});

const riderInclude = {
  user: { select: { name: true, phone: true, email: true } },
  hub: { select: { id: true, name: true, code: true, type: true } },
  hubs: { select: { hub: { select: { id: true, name: true, code: true, type: true } } }, orderBy: { createdAt: "asc" } },
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
  @Inject(NotifyService) private readonly notify!: NotifyService;
  @Inject(SessionService) private readonly sessions!: SessionService;

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

  /**
   * Every signed-in user lists hubs. Those who manage them also get the in-charge's name and phone, the hub's
   * sign-in people (Hub Managers: `managers`) and, for a franchise hub, its franchise and the franchise's account.
   */
  async listHubs(includeInactive: boolean, canManage = false) {
    if (!canManage) {
      const hubs = await this.prisma.hub.findMany({ where: includeInactive ? {} : { active: true }, orderBy: { name: "asc" } });
      return hubs.map(({ inChargeName: _name, inChargePhone: _phone, ...hub }) => hub);
    }
    const person = { select: { id: true, name: true, phone: true, email: true, status: true } } as const;
    const hubs = await this.prisma.hub.findMany({
      where: includeInactive ? {} : { active: true },
      orderBy: { name: "asc" },
      include: {
        staff: { where: { role: "HUB_OPERATOR", user: { status: { not: "DEACTIVATED" } } }, select: { user: person }, orderBy: { createdAt: "asc" } },
        franchise: { select: { id: true, code: true, name: true, status: true, owner: person } },
      },
    });
    return hubs.map(({ staff, franchise, ...hub }) => ({
      ...hub,
      managers: [...new Map(staff.map(s => [s.user.id, s.user])).values()],
      franchise: franchise ? { id: franchise.id, code: franchise.code, name: franchise.name, status: franchise.status, account: franchise.owner } : null,
    }));
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
      // Switched off / on: merchants of the zones it serves (and those it served) are derived again.
      if (input.active !== undefined && input.active !== current.active) {
        const zones = await tx.deliveryZone.findMany({ where: { hubId: id }, select: { district: true, name: true } });
        await rederiveMerchantHubs(tx, this.audit, actor, meta, { OR: [{ pickupHubId: id }, ...zones.map(z => merchantsInZone(z.district, z.name))] }, input.active ? "hub.activate" : "hub.deactivate");
      }
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
    // A Hub Manager sees only their own hubs' riders.
    const managerHubs = actor ? hubManagerHubIds(actor) : null;
    const riders = await this.prisma.rider.findMany({
      where: {
        // A hub's riders: those at it now and those who also work for it.
        ...(query.hubId ? { OR: [{ hubId: query.hubId }, { hubs: { some: { hubId: query.hubId } } }] } : {}),
        ...(query.company ? { NOT: { hub: { type: "FRANCHISE" } } } : {}),
        ...(managerHubs
          ? { AND: [{ OR: [{ hubId: { in: managerHubs } }, { hubs: { some: { hubId: { in: managerHubs } } } }] }] }
          : scope
            ? { AND: [{ OR: [{ hubId: null }, { hub: { type: "COMPANY" } }, { hubId: { in: scope } }, { hubs: { some: { hubId: { in: scope } } } }] }] }
            : {}),
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
    const hubIds = [...new Set([...(input.hubId ? [input.hubId] : []), ...(input.hubIds ?? [])])];
    await this.checkHubs(hubIds);
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
        data: { userId: user.id, code, hubId: hubIds[0], vehicle: input.vehicle, zone: input.zone, dailyCapacity: input.dailyCapacity, hubs: { create: hubIds.map(hubId => ({ hubId })) } },
        include: riderInclude,
      });
      await this.audit.record(actor, { action: "rider.create", entityType: "rider", entityId: created.id, data: { code, phone: input.phone, hubIds, sms: input.sendSms, password: !!input.password } }, meta, tx);
      return created;
    });
    // The sign-in message only when asked for (the form shows it first).
    let messageSent = false;
    if (input.sendSms) {
      const { event, vars } = inviteMessage("rider", { inviter: actor.kind === "user" ? actor.name : "Delivery Fast", name: rider.user.name, code: rider.code, hubName: rider.hub?.name });
      messageSent = (await this.notify.notifyNow({ event, to: { userId: rider.userId, phone: rider.user.phone, email: rider.user.email, name: rider.user.name }, vars }).catch(() => [])).length > 0;
    }
    return { ...riderView(rider), messageSent };
  }

  /**
   * Which hubs the actor may add riders to and reset riders' passwords at, from the operations app: null = any
   * (operations managers, super admins: rider:manage); a Hub Manager: their own hubs. Anyone else is refused.
   */
  private riderHubsFor(actor: Actor): string[] | null {
    if (actor.permissions.has("rider:manage")) return null;
    const mine = hubManagerHubIds(actor);
    if (mine) return mine;
    throw forbidden("Only operations managers and Hub Managers can add riders here");
  }

  /** The rider app download link, to share with a new rider. */
  riderAppLink() {
    return `${env().APP_URL.replace(/\/+$/, "")}/downloads/rider.apk`;
  }

  /** Operations app: a new rider with a password; nothing is sent (the sign-in details are shared by hand). */
  async createAppRider(actor: Actor, input: z.infer<typeof appRiderSchema>, meta: RequestMeta) {
    const allowed = this.riderHubsFor(actor);
    const hubId = input.hubId ?? allowed?.[0];
    if (!hubId) throw new AppError("HUB_REQUIRED", "Choose the rider's hub", HttpStatus.UNPROCESSABLE_ENTITY, { field: "hubId" });
    if (allowed && !allowed.includes(hubId)) throw forbidden("You can add riders only to your own hub");
    const existing = await this.prisma.user.findUnique({ where: { phone: input.phone }, select: { id: true } });
    const rider = await this.createRider(actor, { name: input.name, phone: input.phone, email: input.email, password: input.password, hubIds: [hubId], vehicle: input.vehicle, zone: input.zone, sendSms: false }, meta);
    // A number that already had an account keeps its own password (the one typed here isn't applied).
    return { ...rider, passwordSet: !existing, appLink: this.riderAppLink() };
  }

  /** Operations app: a new password for a rider; they are signed out everywhere. Accounts with other access are refused. */
  async setRiderPassword(actor: Actor, id: string, password: string, meta: RequestMeta) {
    return this.resetRiderPassword(actor, id, password, meta, this.riderHubsFor(actor));
  }

  /** A rider's new password, when the rider works at one of `allowed` (null = any hub). Also the franchise panel's. */
  async resetRiderPassword(actor: Actor, id: string, password: string, meta: RequestMeta, allowed: string[] | null) {
    const rider = await this.prisma.rider.findUnique({ where: { id }, select: { id: true, code: true, userId: true, hubId: true, hubs: { select: { hubId: true } }, user: { select: { phone: true, email: true, roles: { select: { role: true } } } } } });
    if (!rider) throw notFound("Rider");
    if (allowed && ![rider.hubId, ...rider.hubs.map(h => h.hubId)].some(h => h && allowed.includes(h))) throw notFound("Rider");
    if (rider.user.roles.some(r => !["RIDER", "CUSTOMER", "APPLICANT"].includes(r.role)))
      throw new AppError("OTHER_ACCESS", "This account has other access too: its password is changed in the super admin panel", HttpStatus.UNPROCESSABLE_ENTITY);
    await this.prisma.$transaction(async tx => {
      await tx.user.update({ where: { id: rider.userId }, data: { passwordHash: await hashPassword(password), failedLoginCount: 0, lockedUntil: null } });
      await this.audit.record(actor, { action: "rider.password_reset", entityType: "rider", entityId: id, data: { code: rider.code } }, meta, tx);
    });
    await this.sessions.revokeAllForUser(rider.userId, "password_reset").catch(() => undefined);
    return { id: rider.id, code: rider.code, phone: rider.user.phone, email: rider.user.email, appLink: this.riderAppLink() };
  }

  /** Hubs a rider is given: existing and operating. */
  private async checkHubs(ids: string[]) {
    if (!ids.length) return;
    const found = await this.prisma.hub.findMany({ where: { id: { in: ids }, active: true }, select: { id: true } });
    if (found.length !== ids.length) throw new AppError("HUB_UNKNOWN", "Choose operating hubs", HttpStatus.UNPROCESSABLE_ENTITY, { field: "hubIds" });
  }

  async updateRider(actor: Actor, id: string, input: z.infer<typeof updateRiderSchema>, meta: RequestMeta) {
    const before = await this.prisma.rider.findUnique({ where: { id }, include: { hubs: true } });
    if (!before) throw notFound("Rider");
    const { name, phone, email, password, hubIds: wanted, ...riderData } = input;
    const hubIds = wanted ? [...new Set(wanted)] : null;
    if (hubIds) await this.checkHubs(hubIds);
    if (phone && (await this.prisma.user.findFirst({ where: { phone, id: { not: before.userId } }, select: { id: true } }))) throw conflict("PHONE_IN_USE", "Another account uses this mobile number");
    if (email && (await this.prisma.user.findFirst({ where: { email, id: { not: before.userId } }, select: { id: true } }))) throw conflict("EMAIL_IN_USE", "Another account uses this email address");
    const rider = await this.prisma.$transaction(async tx => {
      if (name !== undefined || phone !== undefined || email !== undefined || password)
        await tx.user.update({ where: { id: before.userId }, data: { name, phone, email, ...(password ? { passwordHash: await hashPassword(password) } : {}) } });
      if (hubIds) {
        await tx.riderHub.deleteMany({ where: { riderId: id, hubId: { notIn: hubIds } } });
        await tx.riderHub.createMany({ data: hubIds.map(hubId => ({ riderId: id, hubId })), skipDuplicates: true });
        // The current hub stays when it's still one of them; else the first.
        const current = riderData.hubId !== undefined ? riderData.hubId : before.hubId;
        riderData.hubId = current && hubIds.includes(current) ? current : hubIds[0];
      } else if (riderData.hubId) await tx.riderHub.createMany({ data: [{ riderId: id, hubId: riderData.hubId }], skipDuplicates: true });
      const updated = await tx.rider.update({ where: { id }, data: riderData, include: riderInclude });
      await this.audit.record(
        actor,
        { action: "rider.update", entityType: "rider", entityId: id, data: { ...riderData, hubIds: hubIds ?? undefined, name, phone, email, password: password ? "changed" : undefined } },
        meta,
        tx,
      );
      return updated;
    });
    return riderView(rider);
  }

  /**
   * A rider on several hubs works at the nearest one (from the app's location): their current hub (cash, hand-overs)
   * moves there. Hubs without a location are skipped. Returns the hub when it changed.
   */
  async moveToNearestHub(riderId: string, lat: number, lng: number) {
    const rider = await this.prisma.rider.findUnique({ where: { id: riderId }, select: { hubId: true, hubs: { select: { hub: { select: { id: true, lat: true, lng: true, active: true } } } } } });
    const hubs = (rider?.hubs ?? []).map(h => h.hub).filter(h => h.active && h.lat != null && h.lng != null);
    if (!rider || hubs.length < 2) return null;
    const nearest = nearestOf(hubs as { id: string; lat: number; lng: number }[], lat, lng);
    if (!nearest || nearest.id === rider.hubId) return null;
    await this.prisma.rider.update({ where: { id: riderId }, data: { hubId: nearest.id } });
    return nearest.id;
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
