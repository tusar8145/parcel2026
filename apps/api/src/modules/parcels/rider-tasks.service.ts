import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import type { deliveryOutcomeSchema, pickupOutcomeSchema, proofCaptureSchema } from "@delivery-fast/shared";
import { PrismaService, type Db } from "../../common/prisma.service";
import { StorageService } from "../../common/storage.service";
import type { UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, forbidden, notFound } from "../../common/errors";
import { decrypt, safeEqual } from "../../common/crypto";
import { parcelInclude, parcelView, proofMethodsOf } from "./parcel.views";
import { ParcelWorkflowService, type AfterCommit } from "./parcel-workflow.service";
import { ParcelsService } from "./parcels.service";
import type { Parcel, Prisma } from "../../generated/prisma/client";
import { addDays, dhakaDayStart, dhakaMonthStart, dhakaWeekStart } from "./ops-scope";
import { recordTaskEarning } from "../rider/earnings";
import { LedgerService } from "../finance/ledger.service";

/** Service lines riders are paid for (rider plans in the platform settings use these keys). */
type ServiceLine = "ecommerce" | "document" | "parcel";
const lineOf = (merchantType: string | null | undefined): ServiceLine =>
  merchantType === "ECOMMERCE" ? "ecommerce" : merchantType === "BANKING_FINANCIAL" ? "document" : "parcel";

const PICKUP_STATUSES = ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED"] as const;
const DELIVERY_STATUSES = ["ASSIGNED", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "EXCEPTION"] as const;

/** Where and when the proof was captured (device clock + GPS). Offline captures may be synced days later. */
function proofCapture(input: z.infer<typeof proofCaptureSchema> | undefined, now: Date) {
  if (!input) return {};
  const capturedAt = input.capturedAt ? new Date(input.capturedAt) : undefined;
  if (capturedAt && (capturedAt.getTime() > now.getTime() + 5 * 60_000 || capturedAt.getTime() < now.getTime() - 7 * 86_400_000))
    throw new AppError("INVALID_CAPTURE_TIME", "The proof's capture time isn't plausible. Check the phone's date and time.", 422);
  const fix = input.lat !== undefined && input.lng !== undefined;
  return { capturedAt, lat: fix ? input.lat : undefined, lng: fix ? input.lng : undefined, accuracy: fix ? input.accuracy : undefined };
}

@Injectable()
export class RiderTasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workflow: ParcelWorkflowService,
    private readonly parcels: ParcelsService,
    private readonly storage: StorageService,
  ) {}

  /** Finance ledger (global module; property injection keeps the constructor stable). */
  @Inject(LedgerService) private readonly ledger!: LedgerService;

  /** Pickup queue and delivery run for the signed-in rider. */
  async tasks(actor: UserActor) {
    const riderId = this.riderId(actor);
    const [pickups, deliveries] = await Promise.all([
      // On-demand pickups / deliveries first (service packages), then oldest first.
      this.prisma.parcel.findMany({ where: { pickupRiderId: riderId, status: { in: [...PICKUP_STATUSES] } }, include: parcelInclude, orderBy: [{ onDemand: "desc" }, { createdAt: "asc" }] }),
      this.prisma.parcel.findMany({ where: { deliveryRiderId: riderId, status: { in: [...DELIVERY_STATUSES] } }, include: parcelInclude, orderBy: [{ onDemand: "desc" }, { createdAt: "asc" }] }),
    ]);
    return {
      pickups: pickups.map(p => parcelView(p, { internal: false })),
      deliveries: deliveries.map(p => ({ ...parcelView(p, { internal: false }), devDeliveryCode: this.workflow.devDeliveryCode(p) })),
    };
  }

  async pickup(actor: UserActor, trackingId: string, input: z.infer<typeof pickupOutcomeSchema>, meta: RequestMeta) {
    const riderId = this.riderId(actor);
    return this.change(actor, trackingId, async (tx, parcel, after) => {
      if (parcel.pickupRiderId !== riderId) throw forbidden("This pickup isn't assigned to you");
      const rider = await tx.rider.findUniqueOrThrow({ where: { id: riderId }, include: { user: { select: { name: true } } } });
      const label = `${rider.code} · ${rider.user.name}`;
      if (input.outcome === "COLLECTED_DELIVER_DIRECT") {
        await this.workflow.transition(
          tx,
          parcel,
          {
            to: "OUT_FOR_DELIVERY",
            actorRole: "rider",
            data: { pickedUpAt: new Date(), deliveryRiderId: riderId, deliveryOtpEncrypted: await this.workflow.issueDeliveryCode(tx, parcel, after) },
            title: "Picked up and out for delivery",
            description: `${label} collected the parcel and is taking it straight to the recipient.`,
            internalNote: input.note,
          },
          actor,
          meta,
          after,
        );
        await recordTaskEarning(tx, { riderId, type: "PICKUP", parcel });
      } else if (input.outcome === "COLLECTED_TO_HUB") {
        const hub = await tx.hub.findUnique({ where: { id: input.hubId } });
        if (!hub || !hub.active) throw notFound("Hub");
        await this.workflow.transition(
          tx,
          parcel,
          {
            to: "AT_HUB",
            actorRole: "rider",
            data: { pickedUpAt: new Date(), currentHubId: hub.id, deliveryRiderId: null },
            description: `${label} collected the parcel and handed it to ${hub.name}.`,
            location: hub.name,
            metadata: { hubId: hub.id },
            internalNote: input.note,
          },
          actor,
          meta,
          after,
        );
        await recordTaskEarning(tx, { riderId, type: "PICKUP", parcel });
      } else {
        await this.workflow.transition(
          tx,
          parcel,
          { to: "EXCEPTION", actorRole: "rider", title: "Pickup issue reported", description: "The rider reported a problem with the pickup. Operations will follow up.", internalNote: input.note },
          actor,
          meta,
          after,
        );
      }
    });
  }

  /** Leaving for the recipient: sends the delivery code by SMS if they don't have one. */
  async startDelivery(actor: UserActor, trackingId: string, meta: RequestMeta) {
    const riderId = this.riderId(actor);
    return this.change(actor, trackingId, async (tx, parcel, after) => {
      if (parcel.deliveryRiderId !== riderId) throw forbidden("This delivery isn't assigned to you");
      await this.workflow.transition(
        tx,
        parcel,
        {
          to: "OUT_FOR_DELIVERY",
          actorRole: "rider",
          data: parcel.deliveryOtpEncrypted ? {} : { deliveryOtpEncrypted: await this.workflow.issueDeliveryCode(tx, parcel, after) },
        },
        actor,
        meta,
        after,
      );
    });
  }

  async resendDeliveryCode(actor: UserActor, trackingId: string) {
    const riderId = this.riderId(actor);
    return this.change(actor, trackingId, async (tx, parcel, after) => {
      if (parcel.deliveryRiderId !== riderId) throw forbidden("This delivery isn't assigned to you");
      if (!["ASSIGNED", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED"].includes(parcel.status)) throw new AppError("NOT_OUT_FOR_DELIVERY", "This parcel isn't out for delivery", HttpStatus.CONFLICT);
      await tx.parcel.update({ where: { id: parcel.id }, data: { deliveryOtpEncrypted: await this.workflow.issueDeliveryCode(tx, parcel, after) } });
    });
  }

  async deliver(actor: UserActor, trackingId: string, input: z.infer<typeof deliveryOutcomeSchema>, meta: RequestMeta) {
    const riderId = this.riderId(actor);
    return this.change(actor, trackingId, async (tx, parcel, after) => {
      if (parcel.deliveryRiderId !== riderId) throw forbidden("This delivery isn't assigned to you");
      if (input.outcome === "DELIVERED") {
        const cod = Number(parcel.codAmount);
        if (cod > 0 && input.codCollected !== cod)
          throw new AppError("COD_MISMATCH", `Collect exactly ৳${cod.toLocaleString("en-BD")} before completing the delivery`, 422, { expected: cod });
        // Service packages: only the proof methods active for this parcel (OTP needs the delivery code message).
        const allowed = proofMethodsOf(parcel);
        if (!allowed.includes(input.proof.method))
          throw new AppError("PROOF_METHOD_NOT_ALLOWED", `This parcel takes ${allowed.map(m => (m === "OTP" ? "the recipient's code" : m === "PHOTO" ? "a photo of the signed invoice" : "the recipient's signature")).join(" or ")} as proof`, 422, { allowed });
        let fileId: string | undefined;
        let otpVerified = false;
        if (input.proof.method === "OTP") {
          const expected = parcel.deliveryOtpEncrypted ? decrypt(parcel.deliveryOtpEncrypted) : undefined;
          if (!expected || !safeEqual(expected, input.proof.otp)) throw new AppError("INVALID_DELIVERY_CODE", "The recipient's code is incorrect", 422);
          otpVerified = true;
        } else {
          const file = await this.storage.saveDataUrl(input.proof.image, `${parcel.trackingId}-${input.proof.method.toLowerCase()}`, actor.userId, tx);
          fileId = file.id;
        }
        const now = new Date();
        const capture = proofCapture(input.capture, now);
        await this.workflow.transition(
          tx,
          parcel,
          {
            to: "DELIVERED",
            actorRole: "rider",
            data: { deliveredAt: now, attemptCount: { increment: 1 }, deliveryOtpEncrypted: null },
            description: `Delivered to ${input.receivedBy} with ${input.proof.method === "OTP" ? "OTP" : input.proof.method.toLowerCase()} proof.`,
            internalNote: input.note,
          },
          actor,
          meta,
          after,
        );
        await tx.deliveryProof.create({ data: { parcelId: parcel.id, method: input.proof.method, receivedBy: input.receivedBy, fileId, otpVerified, note: input.note, ...capture } });
        await tx.deliveryAttempt.create({ data: { parcelId: parcel.id, riderId, outcome: "DELIVERED", note: input.note } });
        if (cod > 0) await tx.codCollection.create({ data: { parcelId: parcel.id, riderId, amount: cod, collectedAt: now } });
        if (cod > 0) await this.ledger.record(tx, { type: "COD_COLLECTED", amount: parcel.codAmount, reference: parcel.trackingId, riderId, merchantId: parcel.merchantId, occurredAt: now });
        await recordTaskEarning(tx, { riderId, type: "DELIVERY", parcel, at: now });
        return;
      }

      // Failed attempt (re-attempts beyond the package's free ones carry its re-attempt fee).
      await tx.deliveryAttempt.create({ data: { parcelId: parcel.id, riderId, outcome: "FAILED", reason: input.reason, nextAction: input.nextAction, note: input.note } });
      await this.workflow.chargeReattempt(tx, parcel, actor, meta);
      if (input.nextAction === "RETRY") {
        await this.workflow.transition(
          tx,
          parcel,
          {
            to: "RETRY_SCHEDULED",
            actorRole: "rider",
            data: { attemptCount: { increment: 1 } },
            title: "Delivery attempt failed",
            description: `${input.reason}. We'll try to deliver again.`,
            internalNote: input.note,
            metadata: { reason: input.reason },
          },
          actor,
          meta,
          after,
        );
      } else {
        const rider = await tx.rider.findUniqueOrThrow({ where: { id: riderId } });
        const hubId = input.hubId ?? parcel.currentHubId ?? rider.hubId;
        if (!hubId) throw new AppError("HUB_REQUIRED", "Choose the hub you're returning the parcel to", 422);
        const hub = await tx.hub.findUnique({ where: { id: hubId } });
        if (!hub) throw notFound("Hub");
        await this.workflow.transition(
          tx,
          parcel,
          {
            to: "AT_HUB",
            actorRole: "rider",
            data: { attemptCount: { increment: 1 }, currentHubId: hub.id, deliveryRiderId: null, deliveryOtpEncrypted: null },
            title: "Returned to hub after failed delivery",
            description: `${input.reason}. The parcel is back at ${hub.name} for another delivery.`,
            location: hub.name,
            internalNote: input.note,
            metadata: { reason: input.reason, hubId: hub.id },
          },
          actor,
          meta,
          after,
        );
      }
    });
  }

  /** The rider's view of their COD cash. */
  async cash(actor: UserActor) {
    const riderId = this.riderId(actor);
    const collections = await this.prisma.codCollection.findMany({
      where: { riderId, state: "WITH_RIDER" },
      include: { parcel: { select: { trackingId: true, recipientName: true } } },
      orderBy: { collectedAt: "asc" },
    });
    return {
      inHand: collections.reduce((sum, c) => sum + Number(c.amount), 0),
      collections: collections.map(c => ({ id: c.id, trackingId: c.parcel.trackingId, recipient: c.parcel.recipientName, amount: Number(c.amount), collectedAt: c.collectedAt })),
    };
  }

  /** Counts behind the rider app's overview, earnings and performance pages. */
  async summary(actor: UserActor) {
    const riderId = this.riderId(actor);
    const now = new Date();
    const today = dhakaDayStart(now);
    const week = dhakaWeekStart(now);
    const previousWeek = addDays(week, -7);
    const month = dhakaMonthStart(now);
    const delivered = (from: Date, to?: Date): Prisma.ParcelWhereInput => ({ deliveryRiderId: riderId, status: "DELIVERED", deliveredAt: { gte: from, ...(to ? { lt: to } : {}) } });
    const db = this.prisma;

    const [rider, todayRows, weekRows, previousWeekCount, monthCount, monthOnTime, monthWithEstimate, attempts, failedToday, pickupsToday, pickupsMonth, open, cash, latest, recent] =
      await Promise.all([
        db.rider.findUniqueOrThrow({ where: { id: riderId }, include: { user: { select: { name: true, phone: true } }, hub: { select: { id: true, code: true, name: true } } } }),
        db.parcel.findMany({ where: delivered(today), select: { merchant: { select: { type: true } } } }),
        db.parcel.findMany({ where: delivered(week), select: { merchant: { select: { type: true } } } }),
        db.parcel.count({ where: delivered(previousWeek, week) }),
        db.parcel.count({ where: delivered(month) }),
        db.parcel.count({ where: { ...delivered(month), deliveredAt: { gte: month, lte: db.parcel.fields.estimatedDeliveryAt } } }),
        db.parcel.count({ where: { ...delivered(month), estimatedDeliveryAt: { not: null } } }),
        db.deliveryAttempt.groupBy({ by: ["outcome"], where: { riderId, createdAt: { gte: month } }, _count: { _all: true } }),
        db.deliveryAttempt.count({ where: { riderId, outcome: "FAILED", createdAt: { gte: today } } }),
        db.parcel.count({ where: { pickupRiderId: riderId, pickedUpAt: { gte: today } } }),
        db.parcel.count({ where: { pickupRiderId: riderId, pickedUpAt: { gte: month } } }),
        Promise.all([
          db.parcel.count({ where: { pickupRiderId: riderId, status: { in: [...PICKUP_STATUSES] } } }),
          db.parcel.aggregate({ where: { deliveryRiderId: riderId, status: { in: [...DELIVERY_STATUSES] } }, _count: { _all: true }, _sum: { codAmount: true } }),
        ]),
        db.codCollection.aggregate({ where: { riderId, state: "WITH_RIDER" }, _sum: { amount: true }, _count: { _all: true } }),
        db.parcel.findMany({ where: { deliveryRiderId: riderId, status: "DELIVERED" }, select: { deliveredAt: true, estimatedDeliveryAt: true }, orderBy: { deliveredAt: "desc" }, take: 100 }),
        db.trackingEvent.findMany({
          where: { actorUserId: actor.userId, visibility: "PUBLIC" },
          select: { title: true, location: true, status: true, createdAt: true, parcel: { select: { trackingId: true } } },
          orderBy: { createdAt: "desc" },
          take: 8,
        }),
      ]);

    const byLine = (rows: { merchant: { type: string } | null }[]) => {
      const counts: Record<ServiceLine, number> = { ecommerce: 0, document: 0, parcel: 0 };
      for (const r of rows) counts[lineOf(r.merchant?.type)]++;
      return counts;
    };
    const attemptCount = (outcome: string) => attempts.find(a => a.outcome === outcome)?._count._all ?? 0;
    const attemptsMonth = attemptCount("DELIVERED") + attemptCount("FAILED");
    let streak = 0;
    for (const p of latest) {
      if (!p.estimatedDeliveryAt || !p.deliveredAt || p.deliveredAt > p.estimatedDeliveryAt) break;
      streak++;
    }
    const [openPickups, openDeliveries] = open;
    const rate = (num: number, den: number) => (den ? Math.round((num / den) * 1000) / 10 : null);
    return {
      rider: {
        id: rider.id,
        code: rider.code,
        name: rider.user.name,
        zone: rider.zone,
        vehicle: rider.vehicle,
        status: rider.status,
        active: rider.active,
        hub: rider.hub,
      },
      today: {
        delivered: todayRows.length,
        deliveredByLine: byLine(todayRows),
        failed: failedToday,
        pickupsCompleted: pickupsToday,
        openPickups,
        openDeliveries: openDeliveries._count._all,
        codToCollect: Number(openDeliveries._sum.codAmount ?? 0),
      },
      week: { delivered: weekRows.length, deliveredByLine: byLine(weekRows), previousWeekDelivered: previousWeekCount },
      month: {
        delivered: monthCount,
        pickups: pickupsMonth,
        completedStops: monthCount + pickupsMonth,
        onTimeRate: rate(monthOnTime, monthWithEstimate),
        successRate: rate(attemptCount("DELIVERED"), attemptsMonth),
        attempts: attemptsMonth,
      },
      onTimeStreak: streak,
      cash: { inHand: Number(cash._sum.amount ?? 0), collections: cash._count._all },
      recent: recent.map(e => ({ trackingId: e.parcel.trackingId, title: e.title, status: e.status, location: e.location, at: e.createdAt })),
    };
  }

  private riderId(actor: UserActor) {
    if (!actor.riderId) throw forbidden("Only riders can do this");
    return actor.riderId;
  }

  private async change(actor: UserActor, trackingId: string, work: (tx: Db, parcel: Parcel, after: AfterCommit) => Promise<void>) {
    const after = this.workflow.newAfterCommit();
    await this.prisma.$transaction(async tx => work(tx, await this.parcels.loadForUpdate(actor, trackingId, tx), after), { timeout: 15_000 });
    await this.workflow.flush(after);
    return this.parcels.detail(actor, trackingId);
  }
}
