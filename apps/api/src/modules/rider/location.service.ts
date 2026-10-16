import { HttpStatus, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { RealtimeService } from "../../common/realtime.service";
import { QueueService } from "../../common/queues";
import { AppError, forbidden, notFound } from "../../common/errors";
import type { Actor, UserActor } from "../../common/auth/actor";
import { env, runsJobs } from "../../config/env";
import { opsHubScope } from "../parcels/ops-scope";
import type { locationHistoryQuerySchema, locationPointSchema, riderLocationsQuerySchema } from "./rider.schemas";

type Point = z.infer<typeof locationPointSchema>;

/** History older than this is deleted by a daily job (RIDER_LOCATION_RETENTION_DAYS, default 30). */
export const retentionDays = () => {
  const n = Number(process.env.RIDER_LOCATION_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 30;
};
/** Fixes taken more than this long ago (queued offline) are kept as history but don't move the rider on the map. */
const MAX_REPLAY_AGE_MS = 12 * 3600_000;
const MAX_CLOCK_SKEW_MS = 2 * 60_000;
/** A position older than this is shown as stale on operations maps. */
const STALE_AFTER_MS = 5 * 60_000;

@Injectable()
export class RiderLocationService implements OnApplicationBootstrap {
  private readonly logger = new Logger("RiderLocation");

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly queues: QueueService,
  ) {}

  onApplicationBootstrap() {
    if (!runsJobs()) return;
    void this.queues
      .schedule("rider-location-retention", "20 3 * * *", async () => {
        const removed = await this.purgeHistory();
        this.logger.log(`Removed ${removed} rider location points older than ${retentionDays()} days`);
      })
      .catch(err => this.logger.error({ err }, "Could not schedule the rider location retention job"));
  }

  /**
   * Live fix from a rider on shift. Stores history, moves the rider's latest position and
   * publishes `rider.location` to operations (rider:read) and the rider's hub.
   */
  async record(actor: UserActor, point: Point) {
    const rider = await this.onShiftRider(actor);
    if (rider.status === "OFFLINE") throw new AppError("RIDER_OFF_SHIFT", "Start your shift to share your location", HttpStatus.CONFLICT);
    const result = await this.store(rider, [point]);
    if (!result.accepted) throw new AppError("INVALID_LOCATION_TIME", "The location's time isn't plausible. Check the phone's date and time.", 422);
    return result;
  }

  /**
   * Fixes queued while offline, replayed in one call. Duplicates (same rider and time) are
   * ignored; only a recent fix taken while on shift moves the rider on the map.
   */
  async recordBatch(actor: UserActor, points: Point[]) {
    const rider = await this.onShiftRider(actor);
    return this.store(rider, points);
  }

  private async onShiftRider(actor: UserActor) {
    if (!actor.riderId) throw forbidden("Only riders can share their location");
    const rider = await this.prisma.rider.findUnique({ where: { id: actor.riderId }, select: { id: true, code: true, hubId: true, status: true, active: true } });
    if (!rider || !rider.active) throw notFound("Rider profile");
    return rider;
  }

  private async store(rider: { id: string; code: string; hubId: string | null; status: string }, points: Point[]) {
    const now = Date.now();
    const valid = points
      .map(p => ({ ...p, atDate: new Date(p.at) }))
      .filter(p => p.atDate.getTime() <= now + MAX_CLOCK_SKEW_MS && p.atDate.getTime() > now - retentionDays() * 86_400_000)
      .sort((a, b) => a.atDate.getTime() - b.atDate.getTime());
    if (!valid.length) return { accepted: 0, ignored: points.length, live: false };

    const { count } = await this.prisma.riderLocationPoint.createMany({
      data: valid.map(p => ({ riderId: rider.id, lat: p.lat, lng: p.lng, accuracy: p.accuracy, heading: p.heading ?? null, speed: p.speed ?? null, at: p.atDate })),
      skipDuplicates: true,
    });

    const latest = valid[valid.length - 1];
    let live = false;
    if (rider.status !== "OFFLINE" && latest.atDate.getTime() > now - MAX_REPLAY_AGE_MS) {
      const data = { lat: latest.lat, lng: latest.lng, accuracy: latest.accuracy, heading: latest.heading ?? null, speed: latest.speed ?? null, at: latest.atDate, receivedAt: new Date() };
      // Only move forward in time: a late replay must not overwrite a newer live fix.
      const moved = await this.prisma.riderLocation.updateMany({ where: { riderId: rider.id, at: { lt: latest.atDate } }, data });
      if (!moved.count) {
        const created = await this.prisma.riderLocation.createMany({ data: [{ riderId: rider.id, ...data }], skipDuplicates: true });
        live = created.count > 0;
      } else live = true;
      if (live) {
        this.realtime.publish({
          type: "rider.location",
          id: rider.id,
          riderIds: [rider.id],
          hubIds: [rider.hubId],
          staffPermission: "rider:read",
          data: { riderId: rider.id, code: rider.code, lat: latest.lat, lng: latest.lng, accuracy: latest.accuracy, heading: latest.heading ?? null, speed: latest.speed ?? null, at: latest.at, status: rider.status },
        });
      }
    }
    return { accepted: count, ignored: points.length - count, live };
  }

  /** Latest positions for operations maps (hub operators see their own hubs' riders). */
  async latest(actor: Actor, query: z.infer<typeof riderLocationsQuerySchema>) {
    const scope = opsHubScope(actor);
    if (query.hubId && scope && !scope.includes(query.hubId)) throw forbidden("You can only see riders of your own hub");
    const hubFilter = query.hubId ? { hubId: query.hubId } : scope ? { hubId: { in: scope } } : {};
    const rows = await this.prisma.riderLocation.findMany({
      where: { rider: { active: true, ...hubFilter, ...(query.includeOffShift ? {} : { status: { not: "OFFLINE" } }) } },
      include: { rider: { select: { id: true, code: true, status: true, vehicle: true, zone: true, user: { select: { name: true, phone: true } }, hub: { select: { id: true, code: true, name: true } } } } },
      orderBy: { at: "desc" },
    });
    const now = Date.now();
    return {
      generatedAt: new Date(now).toISOString(),
      staleAfterSeconds: STALE_AFTER_MS / 1000,
      items: rows.map(r => ({
        riderId: r.riderId,
        code: r.rider.code,
        name: r.rider.user.name,
        phone: r.rider.user.phone,
        label: `${r.rider.code} · ${r.rider.user.name}`,
        status: r.rider.status,
        vehicle: r.rider.vehicle,
        zone: r.rider.zone,
        hub: r.rider.hub,
        lat: r.lat,
        lng: r.lng,
        accuracy: r.accuracy,
        heading: r.heading,
        speed: r.speed,
        at: r.at,
        receivedAt: r.receivedAt,
        stale: now - r.at.getTime() > STALE_AFTER_MS,
      })),
    };
  }

  /** A rider's track for a time window (default: the last 12 hours). */
  async history(actor: Actor, riderId: string, query: z.infer<typeof locationHistoryQuerySchema>) {
    const rider = await this.prisma.rider.findUnique({ where: { id: riderId }, select: { id: true, code: true, hubId: true } });
    if (!rider) throw notFound("Rider");
    const scope = opsHubScope(actor);
    if (scope && (!rider.hubId || !scope.includes(rider.hubId))) throw notFound("Rider");
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - MAX_REPLAY_AGE_MS);
    const points = await this.prisma.riderLocationPoint.findMany({
      where: { riderId, at: { gte: from, lte: to } },
      select: { lat: true, lng: true, accuracy: true, heading: true, speed: true, at: true },
      orderBy: { at: "asc" },
      take: query.limit,
    });
    return { riderId, code: rider.code, from, to, points };
  }

  /** Deletes history past the retention window. Returns how many points were removed. */
  async purgeHistory(now = new Date()) {
    const cutoff = new Date(now.getTime() - retentionDays() * 86_400_000);
    const { count } = await this.prisma.riderLocationPoint.deleteMany({ where: { at: { lt: cutoff } } });
    return count;
  }
}
