import { HttpStatus, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { QueueService } from "../../common/queues";
import { AppError, forbidden } from "../../common/errors";
import type { UserActor } from "../../common/auth/actor";
import { runsJobs } from "../../config/env";
import { retentionDays } from "../rider/location.service";
import type { locationPointSchema } from "../rider/rider.schemas";

type Point = z.infer<typeof locationPointSchema>;
/** Who sends their position from the Operations app (the live map's people besides riders). */
export const STAFF_LOCATION_ROLES = new Set(["SUPER_ADMIN", "OPS_MANAGER", "HUB_OPERATOR", "FINANCE", "SUPPORT_AGENT", "FRANCHISE"]);
const MAX_CLOCK_SKEW_MS = 2 * 60_000;

/**
 * Operations app users' positions (super admin › Live map): the app sends one while it is open (every 2 minutes);
 * nothing while it is closed. Kept as the last position plus history, deleted after the riders' retention days.
 */
@Injectable()
export class StaffLocationService implements OnApplicationBootstrap {
  private readonly logger = new Logger("StaffLocation");

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
  ) {}

  onApplicationBootstrap() {
    if (!runsJobs()) return;
    void this.queues
      .schedule("staff-location-retention", "25 3 * * *", async () => {
        const cutoff = new Date(Date.now() - retentionDays() * 86_400_000);
        const { count } = await this.prisma.staffLocationPoint.deleteMany({ where: { at: { lt: cutoff } } });
        this.logger.log(`Removed ${count} staff location points older than ${retentionDays()} days`);
      })
      .catch(err => this.logger.error({ err }, "Could not schedule the staff location retention job"));
  }

  async record(actor: UserActor, p: Point) {
    if (!actor.roles.some(r => STAFF_LOCATION_ROLES.has(r.role))) throw forbidden("Only operations staff share their location here");
    const at = new Date(p.at);
    const now = Date.now();
    if (!(at.getTime() <= now + MAX_CLOCK_SKEW_MS && at.getTime() > now - 24 * 3600_000))
      throw new AppError("INVALID_LOCATION_TIME", "The location's time isn't plausible. Check the phone's date and time.", HttpStatus.UNPROCESSABLE_ENTITY);
    await this.prisma.staffLocationPoint.createMany({ data: [{ userId: actor.userId, lat: p.lat, lng: p.lng, accuracy: p.accuracy, at }], skipDuplicates: true });
    const data = { lat: p.lat, lng: p.lng, accuracy: p.accuracy, at, receivedAt: new Date() };
    // Only forward in time.
    const moved = await this.prisma.staffLocation.updateMany({ where: { userId: actor.userId, at: { lt: at } }, data });
    if (!moved.count) await this.prisma.staffLocation.createMany({ data: [{ userId: actor.userId, ...data }], skipDuplicates: true });
    return { ok: true };
  }
}
