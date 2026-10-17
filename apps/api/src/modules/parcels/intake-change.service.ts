import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { INTAKE_CHANGEABLE_STATUSES, PARCEL_INTAKES, PARCEL_STATUS_LABEL, quoteParcel, rateCardConfigSchema, type ParcelStatus, type ServiceLevel } from "@delivery-fast/shared";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { actorLabel, type Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, forbidden, notFound } from "../../common/errors";
import type { Parcel, Prisma, Segment } from "../../generated/prisma/client";
import { NotifyService } from "../notifications/notify.service";
import { WebhooksService } from "../notifications/webhooks.service";
import { PricingService, type PricingOrigin } from "../pricing/pricing.service";
import { slaDueDates } from "../sla/sla-policy";
import { ParcelsService } from "./parcels.service";
import { ParcelWorkflowService, parcelEvent, type AfterCommit } from "./parcel-workflow.service";
import { opsHubScope } from "./ops-scope";
import { trackingUrl } from "./parcel-access";
import { pricedDestination } from "./incomplete";
import { PackagesService } from "../packages/packages.service";

export const changeIntakeSchema = z
  .object({
    /** PICKUP: a pickup rider collects it. DROP_OFF: the sender brings it to dropOffHubId. */
    intake: z.enum(PARCEL_INTAKES, "Choose PICKUP or DROP_OFF"),
    /** The drop-off hub (DROP_OFF only). Hub operators may leave it out to use their own hub. */
    dropOffHubId: z.uuid().optional(),
    /** Why (internal; staff only). */
    note: z.string().trim().max(500).optional().transform(v => v || undefined),
    expectedVersion: z.number().int().min(0).optional(),
  })
  .refine(v => v.intake === "DROP_OFF" || !v.dropOffHubId, { message: "A rider pickup has no drop-off hub", path: ["dropOffHubId"] });

type Snapshot = { config?: unknown; discountPercent?: number; segment?: Segment; origin?: PricingOrigin; destination?: { district: string; zone: string } } & Record<string, unknown>;
const money = (n: number) => n.toLocaleString("en-BD", { maximumFractionDigits: 2 });

/**
 * Switching a booked parcel between rider pickup and hub drop-off (or to another drop-off hub)
 * before it is picked up. A released pickup assignment goes back to PENDING_CONFIRMATION through
 * ParcelWorkflowService.transition; the parcel is re-priced from its new origin with the tariff
 * frozen at booking, the sender is told what to do, and the change is tracked, audited and published.
 */
@Injectable()
export class IntakeChangeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly parcels: ParcelsService,
    private readonly workflow: ParcelWorkflowService,
    private readonly pricing: PricingService,
    private readonly audit: AuditService,
  ) {}

  @Inject(NotifyService) private readonly notify!: NotifyService;
  @Inject(WebhooksService) private readonly webhooks!: WebhooksService;
  @Inject(PackagesService) private readonly packages!: PackagesService;

  async change(actor: Actor, trackingId: string, input: z.infer<typeof changeIntakeSchema>, meta: RequestMeta) {
    const after = this.workflow.newAfterCommit();
    await this.prisma.$transaction(tx => this.apply(tx, actor, trackingId, input, meta, after));
    await this.workflow.flush(after);
    return this.parcels.detail(actor, trackingId);
  }

  private async apply(tx: Db, actor: Actor, trackingId: string, input: z.infer<typeof changeIntakeSchema>, meta: RequestMeta, after: AfterCommit) {
    const parcel = await this.parcels.loadForUpdate(actor, trackingId, tx);
    if (input.expectedVersion !== undefined && input.expectedVersion !== parcel.version)
      throw new AppError("PARCEL_CHANGED", "This parcel was just updated by someone else. Refresh and try again.", HttpStatus.CONFLICT);
    const status = parcel.status as ParcelStatus;
    if (!INTAKE_CHANGEABLE_STATUSES.includes(status))
      throw new AppError(
        "INTAKE_LOCKED",
        `${parcel.trackingId} is "${PARCEL_STATUS_LABEL[status]}". Pickup and drop-off can only be switched before the parcel is picked up or received at a hub.`,
        HttpStatus.CONFLICT,
        { status },
      );

    const scope = opsHubScope(actor);
    const previousHub = parcel.dropOffHubId ? await tx.hub.findUnique({ where: { id: parcel.dropOffHubId }, select: { id: true, name: true, address: true } }) : null;
    // Hub operators act only on bookings of their own hubs.
    if (scope) {
      if (previousHub && !scope.includes(previousHub.id)) throw forbidden(`${parcel.trackingId} is booked for drop-off at ${previousHub.name}. Only that hub or an operations manager can change it`);
      if (parcel.pickupRiderId) {
        const rider = await tx.rider.findUnique({ where: { id: parcel.pickupRiderId }, select: { hubId: true } });
        if (rider?.hubId && !scope.includes(rider.hubId)) throw forbidden(`${parcel.trackingId}'s pickup is assigned to another hub's rider. Only that hub or an operations manager can change it`);
      }
    }

    let hub: { id: string; name: string; address: string } | null = null;
    if (input.intake === "DROP_OFF") {
      const hubId = input.dropOffHubId ?? (scope?.length === 1 ? scope[0] : undefined);
      if (!hubId) throw new AppError("HUB_REQUIRED", "Choose the hub the sender will bring the parcel to", 422);
      if (scope && !scope.includes(hubId)) throw forbidden("You can only book drop-offs at your own hub");
      const found = await tx.hub.findUnique({ where: { id: hubId }, select: { id: true, name: true, address: true, active: true } });
      if (!found) throw notFound("Hub");
      if (!found.active) throw new AppError("HUB_INACTIVE", `${found.name} isn't operating`, 422);
      if (parcel.intake === "DROP_OFF" && parcel.dropOffHubId === found.id)
        throw new AppError("INTAKE_UNCHANGED", `${parcel.trackingId} is already booked for drop-off at ${found.name}`, HttpStatus.CONFLICT);
      hub = { id: found.id, name: found.name, address: found.address };
    } else if (parcel.intake === "PICKUP") throw new AppError("INTAKE_UNCHANGED", `${parcel.trackingId} is already booked for rider pickup`, HttpStatus.CONFLICT);

    // Re-price from the new origin with the tariff frozen at booking.
    const { snap, origin, packaged, price } = await this.priceFrom(tx, parcel, hub?.id ?? null);
    const { origin: _old, ...rest } = snap;
    const pricingSnapshot = (
      packaged ? this.packages.snapshot(packaged, snap.destination ? { destination: snap.destination } : {}) : { ...rest, ...(origin ? { origin: { ...origin } } : {}) }
    ) as Prisma.InputJsonObject;
    const oldCharge = Number(parcel.totalCharge);
    const priceChanged = oldCharge !== price.totalCharge;

    // Drop-offs have no pickup leg (delivery SLA from the hand-over); pickups get a pickup SLA from now.
    const due = hub
      ? { pickupDueAt: null, deliveryDueAt: null }
      : await slaDueDates(tx, {
          serviceLevel: parcel.serviceLevel,
          pickupDistrict: parcel.pickupDistrict,
          pickupZone: parcel.pickupZone,
          deliveryDistrict: pricedDestination(parcel).district,
          deliveryZone: pricedDestination(parcel).zone,
          pickupWindowEnd: parcel.pickupWindowEnd && parcel.pickupWindowEnd > new Date() ? parcel.pickupWindowEnd : undefined,
        });
    const releasedRiderId = parcel.pickupRiderId;
    const data = {
      intake: input.intake,
      dropOffHubId: hub?.id ?? null,
      pickupRiderId: null,
      pickupDueAt: due.pickupDueAt,
      deliveryDueAt: due.deliveryDueAt,
      slaState: "ON_TRACK" as const,
      baseCharge: price.baseCharge,
      weightCharge: price.weightCharge,
      serviceCharge: price.serviceCharge,
      codFee: price.codFee,
      discount: price.discount,
      totalCharge: price.totalCharge,
      pricingSnapshot,
      ...(packaged ? { firstMile: packaged.selection.firstMile } : {}),
    } satisfies Prisma.ParcelUncheckedUpdateManyInput;

    const hubChange = parcel.intake === "DROP_OFF" && !!hub;
    const title = hub ? (hubChange ? `Drop-off hub changed to ${hub.name}` : `Changed to drop-off at ${hub.name}`) : "Changed to rider pickup";
    const description = [
      hub
        ? `Bring the parcel to ${hub.name} (${hub.address}). It is on its way once the hub receives it.`
        : "A Delivery Fast rider will collect the parcel from the pickup address. There is no need to bring it to a hub.",
      releasedRiderId ? "The pickup rider assignment was released." : "",
      priceChanged ? `Delivery charge updated from Tk ${money(oldCharge)} to Tk ${money(price.totalCharge)}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const location = hub?.name ?? "Courier operations";
    const metadata = {
      kind: "intake_changed",
      from: parcel.intake,
      to: input.intake,
      hubId: hub?.id ?? null,
      previousHubId: previousHub?.id ?? null,
      releasedRiderId,
      totalCharge: { from: oldCharge, to: price.totalCharge },
    };

    if (status !== "PENDING_CONFIRMATION") {
      // A pickup that was already assigned goes back to waiting (for the sender, or for another rider).
      await this.workflow.transition(
        tx,
        parcel,
        { to: "PENDING_CONFIRMATION", actorRole: "ops", data, title, description, location, metadata, internalNote: input.note, context: { intakeChange: true } },
        actor,
        meta,
        after,
      );
    } else {
      const { count } = await tx.parcel.updateMany({ where: { id: parcel.id, version: parcel.version }, data: { ...data, version: { increment: 1 } } });
      if (!count) throw new AppError("PARCEL_CHANGED", "This parcel was just updated by someone else. Refresh and try again.", HttpStatus.CONFLICT);
      const actorUserId = actor.kind === "user" ? actor.userId : null;
      await tx.trackingEvent.create({ data: { parcelId: parcel.id, status, title, description, location, metadata, actorUserId, actorLabel: actorLabel(actor) } });
      if (input.note)
        await tx.trackingEvent.create({ data: { parcelId: parcel.id, status, title: "Note", description: input.note, visibility: "INTERNAL", actorUserId, actorLabel: actorLabel(actor) } });
    }
    const updated = await tx.parcel.findUniqueOrThrow({ where: { id: parcel.id } });
    // The released rider and the previous drop-off hub must see it leave their lists too.
    const event = parcelEvent(updated);
    event.riderIds?.push(releasedRiderId);
    event.hubIds?.push(previousHub?.id ?? null);
    after.realtime.push(event);

    const track = trackingUrl(parcel.trackingId);
    after.outbox.push(
      ...(await this.notify.notify(tx, {
        event: hub ? "parcel.changed_to_drop_off" : "parcel.changed_to_pickup",
        to: { phone: parcel.senderPhone, userId: parcel.customerId, name: parcel.senderName },
        vars: { trackingId: parcel.trackingId, charge: money(price.totalCharge), trackingUrl: track, ...(hub ? { hub: hub.name, hubAddress: hub.address } : {}) },
        parcel,
      })),
    );
    after.webhooks.push(
      ...(await this.webhooks.emit(tx, parcel.merchantId, "shipment.intake_changed", {
        trackingId: parcel.trackingId,
        merchantOrderRef: parcel.merchantOrderRef,
        intake: input.intake,
        previousIntake: parcel.intake,
        dropOffHub: hub ? { id: hub.id, name: hub.name, address: hub.address } : null,
        status: updated.status,
        totalCharge: price.totalCharge,
        at: new Date().toISOString(),
      })),
    );
    await this.audit.record(
      actor,
      {
        action: "parcel.intake_change",
        entityType: "parcel",
        entityId: parcel.id,
        data: {
          trackingId: parcel.trackingId,
          from: parcel.intake,
          to: input.intake,
          dropOffHubId: hub?.id ?? null,
          previousDropOffHubId: previousHub?.id ?? null,
          releasedPickupRiderId: releasedRiderId,
          status: { from: status, to: updated.status },
          totalCharge: { from: oldCharge, to: price.totalCharge },
          ...(input.note ? { note: input.note } : {}),
        },
      },
      meta,
      tx,
    );
  }

  /**
   * The charge switching to drop-off at `dropOffHubId` (or to rider pickup: null) would give the
   * parcel, without changing it (the bulk update preview). Same engine as `change`; throws what it
   * would throw for the price (e.g. SERVICE_NOT_IN_PACKAGE when the package lacks that first mile).
   */
  async previewCharge(parcel: Parcel, dropOffHubId: string | null, db: Db = this.prisma) {
    const { price } = await this.priceFrom(db, parcel, dropOffHubId);
    return { before: Number(parcel.totalCharge), after: price.totalCharge };
  }

  /** Re-prices from the new origin (the drop-off hub, else the pickup address) with the package / rate card frozen at booking. */
  private async priceFrom(db: Db, parcel: Parcel, dropOffHubId: string | null) {
    const snap = (parcel.pricingSnapshot ?? {}) as Snapshot;
    const origin = dropOffHubId ? await this.pricing.hubOrigin(dropOffHubId, db) : null;
    // Service packages: the package frozen at booking must offer the new first mile (SERVICE_NOT_IN_PACKAGE).
    const packaged = await this.packages.reprice(parcel, { firstMile: dropOffHubId ? "HUB_DROP" : "RIDER_PICKUP", dropHubId: dropOffHubId }, db);
    const price = packaged ? { ...packaged.columns, totalCharge: packaged.totalCharge + Number(parcel.reattemptCharge) } : await this.reprice(db, parcel, snap, origin);
    return { snap, origin, packaged, price };
  }

  /** The parcel's price from `origin` (or its pickup address), with the rate card frozen on it at booking. */
  private async reprice(db: Db, parcel: Parcel, snap: Snapshot, origin: PricingOrigin | null) {
    const input = {
      pickupDistrict: origin?.district ?? parcel.pickupDistrict,
      pickupZone: origin?.zone ?? parcel.pickupZone,
      // Incomplete orders: the default destination they were priced to (parcels/incomplete.ts).
      deliveryDistrict: pricedDestination(parcel).district,
      deliveryZone: pricedDestination(parcel).zone,
      weightKg: Number(parcel.weightKg),
      serviceLevel: parcel.serviceLevel as ServiceLevel,
      codAmount: Number(parcel.codAmount),
      discountPercent: snap.discountPercent ?? 0,
      parcelType: parcel.type,
      documentType: parcel.documentType ?? undefined,
    };
    const frozen = rateCardConfigSchema.safeParse(snap.config);
    if (frozen.success) return quoteParcel(frozen.data, input);
    const segment: Segment = snap.segment ?? (parcel.merchantId ? "ECOMMERCE" : "CUSTOMER");
    return this.pricing.quote(segment, input, db, { merchantId: parcel.merchantId });
  }
}
