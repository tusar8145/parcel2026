import { HttpStatus, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { RealtimeService } from "../../common/realtime.service";
import { QueueService } from "../../common/queues";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import { runsJobs } from "../../config/env";
import type { Prisma } from "../../generated/prisma/client";
import { opsHubScope } from "../parcels/ops-scope";
import { inHubScope, isUuid } from "../ops/ops-common";
import { retentionDays } from "../rider/location.service";
import { readLocationSettings, staleAfterMinutes } from "./location-settings";
import { reasonForTripStatus, SHAREABLE_TRIP_STATUSES, type ShareEndReason } from "./trip-shares";
import type { shareableTripsQuerySchema, startVehicleShareSchema, tripHistoryQuerySchema, vehicleLocationsQuerySchema, vehiclePointSchema } from "./tracking.schemas";

/** Light history per trip for operations (older points are dropped). */
export const TRIP_HISTORY_MAX_POINTS = 500;
const MAX_CLOCK_SKEW_MS = 2 * 60_000;
/** A fix older than this (queued on a phone without signal) is not accepted as the vehicle's position. */
const MAX_FIX_AGE_MS = 12 * 3600_000;

const hubSelect = { id: true, code: true, name: true, district: true, lat: true, lng: true } satisfies Prisma.HubSelect;
const tripSelect = {
  id: true,
  number: true,
  status: true,
  originHubId: true,
  destHubId: true,
  vehicleRegNo: true,
  driverName: true,
  plannedDepartureAt: true,
  departedAt: true,
  arrivedAt: true,
  createdAt: true,
  originHub: { select: hubSelect },
  destHub: { select: hubSelect },
} satisfies Prisma.LinehaulTripSelect;
type TripRow = Prisma.LinehaulTripGetPayload<{ select: typeof tripSelect }>;

const tripSummary = (t: TripRow) => ({
  id: t.id,
  number: t.number,
  status: t.status,
  vehicleRegNo: t.vehicleRegNo,
  driverName: t.driverName,
  originHub: { id: t.originHub.id, code: t.originHub.code, name: t.originHub.name, district: t.originHub.district },
  destHub: { id: t.destHub.id, code: t.destHub.code, name: t.destHub.name, district: t.destHub.district },
  plannedDepartureAt: t.plannedDepartureAt,
  departedAt: t.departedAt,
  arrivedAt: t.arrivedAt,
  route: `${t.originHub.name} → ${t.destHub.name}`,
});

/**
 * "I'm travelling in this vehicle": a rider or hub staff member shares their phone's position as a
 * linehaul trip's vehicle position. One open share per user and per trip (starting again moves it);
 * it ends when the user stops, the trip arrives / closes / is cancelled (endTripShares, and lazily
 * on the next position), or another person takes over the trip.
 */
@Injectable()
export class VehicleShareService implements OnApplicationBootstrap {
  private readonly logger = new Logger("VehicleShare");

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly queues: QueueService,
  ) {}

  onApplicationBootstrap() {
    if (!runsJobs()) return;
    void this.queues
      .schedule("trip-location-retention", "25 3 * * *", async () => {
        const removed = await this.purgeHistory();
        this.logger.log(`Removed ${removed} vehicle location points older than ${retentionDays()} days`);
      })
      .catch(err => this.logger.error({ err }, "Could not schedule the vehicle location retention job"));
  }

  // ───────────── who may share ─────────────

  /** The hubs this user works at for vehicle sharing: a rider's hub, a hub operator's hubs; null = every hub (managers). */
  private async sharingHubs(actor: Actor): Promise<string[] | null> {
    if (actor.kind !== "user") throw forbidden("Sign in as a rider or hub staff member to share a vehicle's location");
    const hubs = new Set<string>();
    let any = false;
    if (actor.riderId) {
      const rider = await this.prisma.rider.findUnique({ where: { id: actor.riderId }, select: { hubId: true, active: true } });
      if (rider?.active && rider.hubId) hubs.add(rider.hubId);
      any = true;
    }
    if (actor.permissions.has("parcel:dispatch")) {
      const scope = opsHubScope(actor);
      if (!scope) return null;
      scope.forEach(h => hubs.add(h));
      any = true;
    }
    if (!any) throw forbidden("Only riders and hub staff can share a vehicle's location");
    return [...hubs];
  }

  private async assertCanShare(actor: Actor, trip: TripRow) {
    const hubs = await this.sharingHubs(actor);
    if (hubs && !hubs.includes(trip.originHubId) && !hubs.includes(trip.destHubId))
      throw forbidden(`Only riders and staff of ${trip.originHub.name} or ${trip.destHub.name} can share this vehicle's location`);
  }

  private async findTrip(ref: string) {
    const code = ref.trim().replace(/^\*+|\*+$/g, "");
    const trip = await this.prisma.linehaulTrip.findFirst({ where: isUuid(code) ? { id: code } : { number: code.toUpperCase() }, select: tripSelect });
    if (!trip) throw new AppError("TRIP_NOT_FOUND", `No trip found for ${code.toUpperCase()}. Scan the manifest's MF-… barcode or choose the trip from the list.`, HttpStatus.NOT_FOUND);
    return trip;
  }

  // ───────────── the traveller's side ─────────────

  /** Trips this user may share now: planned (around today) or departed, from or to their hubs. */
  async shareableTrips(actor: Actor, query: z.infer<typeof shareableTripsQuerySchema>) {
    const hubs = await this.sharingHubs(actor);
    const now = Date.now();
    const recent = new Date(now - 2 * 86_400_000);
    const soon = new Date(now + 2 * 86_400_000);
    const rows = await this.prisma.linehaulTrip.findMany({
      where: {
        AND: [
          hubs ? { OR: [{ originHubId: { in: hubs } }, { destHubId: { in: hubs } }] } : {},
          {
            OR: [
              { status: "DEPARTED" },
              { status: "PLANNED", OR: [{ plannedDepartureAt: { gte: recent, lte: soon } }, { plannedDepartureAt: null, createdAt: { gte: recent } }, { createdAt: { gte: recent } }] },
            ],
          },
          query.q ? { OR: [{ number: { contains: query.q.toUpperCase() } }, { vehicleRegNo: { contains: query.q, mode: "insensitive" } }] } : {},
        ],
      },
      select: { ...tripSelect, vehicleShares: { where: { endedAt: null }, select: { id: true, userId: true } } },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 50,
    });
    const names = await this.userNames(rows.flatMap(r => r.vehicleShares.map(s => s.userId)));
    const userId = actor.kind === "user" ? actor.userId : null;
    return {
      items: rows.map(({ vehicleShares, ...t }) => ({
        ...tripSummary(t),
        sharing: vehicleShares[0] ? { byMe: vehicleShares[0].userId === userId, name: names.get(vehicleShares[0].userId) ?? "Someone" } : null,
      })),
    };
  }

  /** The user's open share (the rider app / console status), or null. Ends it if its trip has meanwhile arrived. */
  async mine(actor: UserActor) {
    const share = await this.prisma.vehicleShare.findFirst({ where: { userId: actor.userId, endedAt: null }, orderBy: { startedAt: "desc" } });
    const settings = await readLocationSettings(this.prisma);
    if (!share) return { share: null, settings };
    const trip = await this.prisma.linehaulTrip.findUniqueOrThrow({ where: { id: share.tripId }, select: tripSelect });
    const ended = reasonForTripStatus(trip.status);
    if (ended) {
      await this.end(share.id, ended, "system");
      return { share: null, ended: { trip: tripSummary(trip), reason: ended }, settings };
    }
    return { share: this.shareView(share, trip), settings };
  }

  async start(actor: UserActor, input: z.infer<typeof startVehicleShareSchema>, meta: RequestMeta) {
    const trip = await this.findTrip(input.trip);
    await this.assertCanShare(actor, trip);
    if (!(SHAREABLE_TRIP_STATUSES as readonly string[]).includes(trip.status))
      throw conflict("TRIP_NOT_SHAREABLE", `${trip.number} is ${trip.status.toLowerCase()}: a vehicle's location is shared only for planned or departed trips`);
    const share = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM linehaul_trips WHERE id = ${trip.id}::uuid FOR UPDATE`;
      const open = await tx.vehicleShare.findMany({ where: { endedAt: null, OR: [{ userId: actor.userId }, { tripId: trip.id }] } });
      const same = open.find(s => s.userId === actor.userId && s.tripId === trip.id);
      if (same) return same;
      const now = new Date();
      for (const s of open) {
        const reason: ShareEndReason = s.userId === actor.userId ? "REPLACED" : "TAKEN_OVER";
        await tx.vehicleShare.update({ where: { id: s.id }, data: { endedAt: now, endReason: reason } });
        await this.audit.record(actor, { action: "vehicle_share.stop", entityType: "linehaul_trip", entityId: s.tripId, data: { shareId: s.id, userId: s.userId, reason } }, meta, tx);
      }
      const created = await tx.vehicleShare.create({ data: { tripId: trip.id, userId: actor.userId } });
      await this.audit.record(
        actor,
        { action: "vehicle_share.start", entityType: "linehaul_trip", entityId: trip.id, data: { shareId: created.id, trip: trip.number, vehicle: trip.vehicleRegNo, tookOver: open.filter(s => s.userId !== actor.userId).map(s => s.userId) } },
        meta,
        tx,
      );
      return created;
    });
    this.publishShare(trip, true);
    return { share: this.shareView(share, trip), settings: await readLocationSettings(this.prisma) };
  }

  /**
   * One position from the travelling phone. Moves the trip's latest position (forward in time only),
   * keeps a bounded history and tells operations (`vehicle.location`). A share whose trip has arrived
   * ends here: `{ stopped: true, reason }` tells the phone to stop sending.
   */
  async record(actor: UserActor, shareId: string, point: z.infer<typeof vehiclePointSchema>) {
    const share = await this.prisma.vehicleShare.findUnique({ where: { id: shareId } });
    if (!share || share.userId !== actor.userId) throw notFound("Vehicle location share");
    if (share.endedAt) return { live: false, stopped: true, reason: share.endReason ?? "STOPPED" };
    const trip = await this.prisma.linehaulTrip.findUniqueOrThrow({ where: { id: share.tripId }, select: tripSelect });
    const ended = reasonForTripStatus(trip.status);
    if (ended) {
      await this.end(share.id, ended, "system");
      this.publishShare(trip, false);
      return { live: false, stopped: true, reason: ended };
    }
    const at = new Date(point.at);
    const now = Date.now();
    if (at.getTime() > now + MAX_CLOCK_SKEW_MS || at.getTime() < now - MAX_FIX_AGE_MS)
      throw new AppError("INVALID_LOCATION_TIME", "The location's time isn't plausible. Check the phone's date and time.", 422);
    const fix = { lat: point.lat, lng: point.lng, accuracy: point.accuracy, heading: point.heading ?? null, speed: point.speed ?? null, at };
    const created = await this.prisma.tripLocationPoint.createMany({ data: [{ tripId: trip.id, ...fix }], skipDuplicates: true });
    const latest = { ...fix, shareId: share.id, receivedAt: new Date() };
    const moved = await this.prisma.tripLocation.updateMany({ where: { tripId: trip.id, at: { lt: at } }, data: latest });
    let live = moved.count > 0;
    if (!live) live = (await this.prisma.tripLocation.createMany({ data: [{ tripId: trip.id, ...latest }], skipDuplicates: true })).count > 0;
    const updated = await this.prisma.vehicleShare.update({ where: { id: share.id }, data: { lastAt: at, points: { increment: created.count } } });
    if (created.count && updated.points % 50 === 0) await this.trimHistory(trip.id);
    if (live)
      this.realtime.publish({
        type: "vehicle.location",
        id: trip.number,
        hubIds: [trip.originHubId, trip.destHubId],
        staffPermission: "hub:manage",
        data: { tripId: trip.id, number: trip.number, vehicleRegNo: trip.vehicleRegNo, status: trip.status, lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, at: fix.at, route: `${trip.originHub.name} → ${trip.destHub.name}` },
      });
    return { live, stopped: false, accepted: created.count };
  }

  /** "Stop sharing": the traveller, or operations staff of the trip's hubs. */
  async stop(actor: UserActor, shareId: string, meta: RequestMeta) {
    const share = await this.prisma.vehicleShare.findUnique({ where: { id: shareId } });
    if (!share) throw notFound("Vehicle location share");
    const trip = await this.prisma.linehaulTrip.findUniqueOrThrow({ where: { id: share.tripId }, select: tripSelect });
    const own = share.userId === actor.userId;
    if (!own && !(actor.permissions.has("parcel:dispatch") && inHubScope(actor, trip.originHubId, trip.destHubId))) throw notFound("Vehicle location share");
    if (share.endedAt) return { share: this.shareView(share, trip) };
    const ended = await this.prisma.$transaction(async tx => {
      const { count } = await tx.vehicleShare.updateMany({ where: { id: share.id, endedAt: null }, data: { endedAt: new Date(), endReason: "STOPPED" } });
      if (count)
        await this.audit.record(actor, { action: "vehicle_share.stop", entityType: "linehaul_trip", entityId: trip.id, data: { shareId: share.id, userId: share.userId, reason: "STOPPED", byOwner: own } }, meta, tx);
      return tx.vehicleShare.findUniqueOrThrow({ where: { id: share.id } });
    });
    this.publishShare(trip, false);
    return { share: this.shareView(ended, trip) };
  }

  private async end(shareId: string, reason: ShareEndReason, actor: Actor | "system") {
    await this.prisma.$transaction(async tx => {
      const share = await tx.vehicleShare.findUniqueOrThrow({ where: { id: shareId } });
      const { count } = await tx.vehicleShare.updateMany({ where: { id: shareId, endedAt: null }, data: { endedAt: new Date(), endReason: reason } });
      if (count) await this.audit.record(actor, { action: "vehicle_share.auto_stop", entityType: "linehaul_trip", entityId: share.tripId, data: { shareId, userId: share.userId, reason } }, undefined, tx);
    });
  }

  private shareView(share: { id: string; startedAt: Date; endedAt: Date | null; endReason: string | null; lastAt: Date | null; points: number }, trip: TripRow) {
    return { id: share.id, startedAt: share.startedAt, endedAt: share.endedAt, endReason: share.endReason, lastAt: share.lastAt, points: share.points, trip: tripSummary(trip) };
  }

  private publishShare(trip: TripRow, sharing: boolean) {
    this.realtime.publish({ type: "vehicle.share", id: trip.number, hubIds: [trip.originHubId, trip.destHubId], staffPermission: "hub:manage", data: { tripId: trip.id, number: trip.number, sharing } });
  }

  // ───────────── operations ─────────────

  /** Vehicles with a shared position on planned / departed trips (hub operators: trips through their hubs). */
  async live(actor: Actor, query: z.infer<typeof vehicleLocationsQuerySchema>) {
    const scope = opsHubScope(actor);
    if (query.hubId && scope && !scope.includes(query.hubId)) throw forbidden("You can only see your own hub's vehicles");
    const hubs = query.hubId ? [query.hubId] : scope;
    const rows = await this.prisma.tripLocation.findMany({
      where: { trip: { status: { in: [...SHAREABLE_TRIP_STATUSES] }, ...(hubs ? { OR: [{ originHubId: { in: hubs } }, { destHubId: { in: hubs } }] } : {}) } },
      include: { trip: { select: { ...tripSelect, vehicleShares: { where: { endedAt: null }, select: { userId: true } } } } },
      orderBy: { at: "desc" },
      take: 500,
    });
    const settings = await readLocationSettings(this.prisma);
    const staleMs = staleAfterMinutes(settings) * 60_000;
    const names = await this.userNames(rows.flatMap(r => r.trip.vehicleShares.map(s => s.userId)));
    const now = Date.now();
    return {
      generatedAt: new Date(now).toISOString(),
      staleAfterSeconds: staleMs / 1000,
      items: rows.map(r => {
        const { vehicleShares, ...trip } = r.trip;
        const sharer = vehicleShares[0];
        return {
          ...tripSummary(trip),
          tripId: trip.id,
          lat: r.lat,
          lng: r.lng,
          accuracy: r.accuracy,
          heading: r.heading,
          speed: r.speed,
          at: r.at,
          sharing: !!sharer,
          sharedBy: sharer ? (names.get(sharer.userId) ?? null) : null,
          stale: !sharer || now - r.at.getTime() > staleMs,
        };
      }),
    };
  }

  /** The trip's recent track (at most TRIP_HISTORY_MAX_POINTS points), oldest first. */
  async history(actor: Actor, tripRef: string, query: z.infer<typeof tripHistoryQuerySchema>) {
    const trip = await this.findTrip(tripRef);
    if (!inHubScope(actor, trip.originHubId, trip.destHubId)) throw forbidden("This trip doesn't move through your hub");
    const points = await this.prisma.tripLocationPoint.findMany({
      where: { tripId: trip.id },
      select: { lat: true, lng: true, accuracy: true, heading: true, speed: true, at: true },
      orderBy: { at: "desc" },
      take: query.limit,
    });
    return { trip: tripSummary(trip), points: points.reverse() };
  }

  private async trimHistory(tripId: string) {
    await this.prisma.$executeRaw`DELETE FROM trip_location_points WHERE id IN (SELECT id FROM trip_location_points WHERE "tripId" = ${tripId}::uuid ORDER BY at DESC OFFSET ${TRIP_HISTORY_MAX_POINTS})`;
  }

  async purgeHistory(now = new Date()) {
    const cutoff = new Date(now.getTime() - retentionDays() * 86_400_000);
    const { count } = await this.prisma.tripLocationPoint.deleteMany({ where: { at: { lt: cutoff } } });
    return count;
  }

  private async userNames(ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map<string, string>();
    const users = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
    return new Map(users.map(u => [u.id, u.name]));
  }
}
