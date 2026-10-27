import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { postParcelEntries } from "../money/entries";
import { chosenOperationTime, operationNow } from "../../common/operation-time";
import { canTransition, packagePricesSchema, PARCEL_STATUS_LABEL, reattemptFeeFor, type ParcelStatus, type TransitionActor, type TransitionContext } from "@delivery-fast/shared";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { OutboxService } from "../notifications/outbox.service";
import { WebhooksService, type WebhookEvent } from "../notifications/webhooks.service";
import { actorLabel, type Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError } from "../../common/errors";
import { decrypt, encrypt, randomDigits } from "../../common/crypto";
import { env } from "../../config/env";
import type { Parcel, Prisma, ScanSource } from "../../generated/prisma/client";
import { slaTargets } from "../sla/sla-policy";
import { RealtimeService, type RealtimeEvent } from "../../common/realtime.service";
import { NotifyService, type NotifyInput } from "../notifications/notify.service";
import { InboxService } from "../notifications/inbox.service";
import type { NotificationEvent } from "../notifications/events";
import { signLiveLocationAccess, signParcelAccess, trackingUrl } from "./parcel-access";
import { assertDetailsFor, pricedDestination } from "./incomplete";
import { PackagesService } from "../packages/packages.service";
import { LedgerService } from "../finance/ledger.service";
import { franchiseOfHub, recordFranchiseCommission } from "../franchise/franchise-commission";

/** "23 Oct" in Dhaka time (collection deadlines). */
const dhakaDate = (d: Date) => d.toLocaleDateString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short" });
const dhakaDateTime = (d: Date) => d.toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });

/** Default customer-facing text for each status. */
const EVENT_TEXT: Record<ParcelStatus, { title: string; description: string; location?: string }> = {
  PENDING_CONFIRMATION: { title: "Pickup request submitted", description: "We received the request. Operations will confirm it shortly.", location: "Paira Express" },
  PICKUP_ASSIGNED: { title: "Pickup accepted and rider assigned", description: "A rider will collect the parcel.", location: "Courier operations" },
  PICKUP_CONFIRMED: { title: "Pickup confirmed", description: "The pickup time has been confirmed.", location: "Courier operations" },
  PICKED_UP: { title: "Picked up", description: "The rider collected the parcel.", location: "Rider" },
  PICKUP_CANCELLED: { title: "Pickup cancelled", description: "The pickup request was cancelled." },
  AT_HUB: { title: "At hub", description: "The parcel arrived at a Paira Express hub." },
  ASSIGNED: { title: "Assigned to delivery rider", description: "A rider has been assigned to deliver the parcel.", location: "Courier operations" },
  IN_TRANSIT: { title: "In transit", description: "The parcel is on its way to the destination area." },
  OUT_FOR_DELIVERY: { title: "Out for delivery", description: "The rider is on the way to the recipient.", location: "Rider" },
  DELIVERED: { title: "Delivered", description: "The parcel was delivered.", location: "Rider" },
  RETRY_SCHEDULED: { title: "Delivery attempt failed", description: "We'll try to deliver again.", location: "Rider" },
  RETURN_SCHEDULED: { title: "Return scheduled", description: "The parcel will be returned to the sender.", location: "Courier operations" },
  RETURNED: { title: "Returned to sender", description: "The parcel was returned to the sender." },
  EXCEPTION: { title: "Needs attention", description: "Operations is reviewing an issue with this parcel.", location: "Courier operations" },
  READY_FOR_COLLECTION: { title: "Ready for collection", description: "The parcel is waiting at the hub for the recipient to collect it." },
};

const WEBHOOK_FOR: Partial<Record<ParcelStatus, WebhookEvent>> = {
  PICKUP_ASSIGNED: "pickup.scheduled",
  PICKED_UP: "pickup.completed",
  DELIVERED: "shipment.delivered",
  PICKUP_CANCELLED: "shipment.cancelled",
  OUT_FOR_DELIVERY: "shipment.out_for_delivery",
  RETRY_SCHEDULED: "shipment.delivery_failed",
  RETURN_SCHEDULED: "shipment.return_scheduled",
  RETURNED: "shipment.returned",
};
/** Further events for the same change (sent after the specific one). */
const EXTRA_WEBHOOKS: Partial<Record<ParcelStatus, WebhookEvent[]>> = {
  PICKUP_CANCELLED: ["pickup.cancelled"],
};

export interface TransitionInput {
  to: ParcelStatus;
  actorRole: TransitionActor;
  /** Fields to set alongside the status (rider ids, hub, timestamps…). */
  data?: Prisma.ParcelUncheckedUpdateInput;
  title?: string;
  description?: string;
  location?: string;
  /** Staff-only detail, recorded as a separate INTERNAL event. */
  internalNote?: string;
  expectedVersion?: number;
  metadata?: Prisma.InputJsonValue;
  /** Extra lifecycle facts, e.g. { intakeChange: true } when operations switch a pickup to drop-off. */
  context?: Pick<TransitionContext, "intakeChange">;
}

/** Side effects to run after the transaction commits. */
export interface AfterCommit {
  outbox: string[];
  webhooks: string[];
  realtime: RealtimeEvent[];
}

/** Who should see a parcel change live (see RealtimeService.canSee). */
export function parcelEvent(
  p: Pick<Parcel, "trackingId" | "status" | "merchantId" | "customerId" | "pickupRiderId" | "deliveryRiderId" | "currentHubId"> & Partial<Pick<Parcel, "dropOffHubId" | "pickupHubId" | "collectHubId">>,
  type = "parcel.updated",
): RealtimeEvent {
  return {
    type,
    id: p.trackingId,
    merchantId: p.merchantId,
    customerId: p.customerId,
    riderIds: [p.pickupRiderId, p.deliveryRiderId],
    // The drop-off hub follows parcels it is waiting for.
    hubIds: [p.currentHubId, ...(p.dropOffHubId ? [p.dropOffHubId] : []), ...(p.pickupHubId ? [p.pickupHubId] : []), ...(p.collectHubId ? [p.collectHubId] : [])],
    data: { status: p.status },
  };
}

@Injectable()
export class ParcelWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly webhooks: WebhooksService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Return-to-merchant notices (property injection keeps the constructor stable for parallel edits). */
  @Inject(NotifyService) private readonly returnNotices!: NotifyService;
  @Inject(InboxService) private readonly inbox!: InboxService;
  /** Collect-from-hub hold period (service packages settings; global module). */
  @Inject(PackagesService) private readonly packageSettings!: PackagesService;
  /** Finance ledger (global module): franchise commission on drop-offs received at a franchise hub. */
  @Inject(LedgerService) private readonly ledger!: LedgerService;

  /**
   * The only way a parcel's status changes. Checks the lifecycle rules, applies
   * optimistic locking, writes tracking events, SMS and webhooks in one transaction.
   */
  async transition(db: Db, parcel: Parcel, input: TransitionInput, actor: Actor | "system", meta: Partial<RequestMeta> | undefined, after: AfterCommit): Promise<Parcel> {
    const from = parcel.status as ParcelStatus;
    if (input.expectedVersion !== undefined && input.expectedVersion !== parcel.version) throw this.changedError();
    if (!canTransition(from, input.to, input.actorRole, { intake: parcel.intake, lastMile: parcel.lastMile, ...input.context })) {
      if (parcel.lastMile === "HUB_COLLECT" && (input.to === "ASSIGNED" || input.to === "OUT_FOR_DELIVERY"))
        throw new AppError(
          "COLLECT_FROM_HUB",
          `${parcel.trackingId} is collected by the recipient at the hub: no delivery rider is assigned. Hand it over at the collection hub.`,
          HttpStatus.CONFLICT,
          { from, to: input.to },
        );
      if (parcel.intake === "DROP_OFF" && from === "PENDING_CONFIRMATION" && input.to === "PICKUP_ASSIGNED")
        throw new AppError(
          "DROP_OFF_PARCEL",
          `${parcel.trackingId} is booked for drop-off at a hub, not rider pickup. Receive it at the hub when the sender brings it.`,
          HttpStatus.CONFLICT,
          { from, to: input.to },
        );
      if (from === "PENDING_CONFIRMATION" && input.to === "AT_HUB")
        throw new AppError(
          "NOT_DROP_OFF",
          `${parcel.trackingId} is booked for rider pickup. Assign a pickup rider; only drop-off parcels can be received at a hub before pickup.`,
          HttpStatus.CONFLICT,
          { from, to: input.to },
        );
      throw new AppError(
        "INVALID_STATUS_CHANGE",
        `A parcel that is "${PARCEL_STATUS_LABEL[from]}" can't be changed to "${PARCEL_STATUS_LABEL[input.to]}"`,
        HttpStatus.CONFLICT,
        { from, to: input.to },
      );
    }
    // Incomplete orders (imports) can't go out for delivery or between hubs until the details are known.
    assertDetailsFor(parcel, input.to);
    // A drop-off is received only at the hub the sender was asked to bring it to.
    if (from === "PENDING_CONFIRMATION" && input.to === "AT_HUB") {
      const hubId = input.data?.currentHubId;
      if (!parcel.dropOffHubId || hubId !== parcel.dropOffHubId) throw await this.wrongDropOffHub(db, parcel);
    }

    // A Scan desk entry dated earlier can't go before the parcel's last update (its timeline stays in order).
    const chosen = chosenOperationTime();
    if (chosen) {
      const last = await db.trackingEvent.findFirst({ where: { parcelId: parcel.id }, orderBy: { createdAt: "desc" }, select: { createdAt: true, title: true } });
      if (last && chosen < last.createdAt)
        throw new AppError(
          "OPERATION_TIME_BEFORE_LAST_UPDATE",
          `${parcel.trackingId}: the operation time is before its last update ("${last.title}", ${dhakaDateTime(last.createdAt)}). Choose a later date & time.`,
          HttpStatus.CONFLICT,
          { lastUpdateAt: last.createdAt.toISOString() },
        );
    }
    const { count } = await db.parcel.updateMany({
      where: { id: parcel.id, version: parcel.version },
      data: { ...(input.data as Prisma.ParcelUncheckedUpdateManyInput), status: input.to, version: { increment: 1 } },
    });
    if (!count) throw this.changedError();

    const text = EVENT_TEXT[input.to];
    const label = actor === "system" ? "System" : actorLabel(actor);
    const actorUserId = actor !== "system" && actor.kind === "user" ? actor.userId : null;
    await db.trackingEvent.create({
      data: {
        parcelId: parcel.id,
        createdAt: operationNow(),
        status: input.to,
        title: input.title ?? text.title,
        description: input.description ?? text.description,
        location: input.location ?? text.location,
        actorUserId,
        actorLabel: label,
        metadata: input.metadata,
      },
    });
    if (input.internalNote) {
      await db.trackingEvent.create({
        data: { parcelId: parcel.id, createdAt: operationNow(), status: input.to, title: "Note", description: input.internalNote, visibility: "INTERNAL", actorUserId, actorLabel: label },
      });
    }

    const updated = await db.parcel.findUniqueOrThrow({ where: { id: parcel.id } });
    // Delivered / returned: the parcel's COD and charges go onto its merchant's or sender's account (Accounts).
    if (input.to === "DELIVERED" || input.to === "RETURNED") await postParcelEntries(db, updated);
    // The previous holders (e.g. the rider handing over) must also see it leave their list.
    const event = parcelEvent(updated);
    event.riderIds?.push(parcel.pickupRiderId, parcel.deliveryRiderId);
    event.hubIds?.push(parcel.currentHubId);
    after.realtime.push(event);
    await this.notify(db, updated, from, after);
    await this.audit.record(
      actor,
      { action: "parcel.status_change", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId, from, to: input.to } },
      meta,
      db,
    );
    // Collect from hub: arriving at the collection hub makes it ready for the recipient.
    if (input.to === "AT_HUB" && updated.lastMile === "HUB_COLLECT" && updated.collectHubId && updated.currentHubId === updated.collectHubId)
      return this.readyForCollection(db, updated, after);
    return updated;
  }

  /**
   * Collect from hub: READY_FOR_COLLECTION with a collection code, the hold period (super admin →
   * Service plans & pricing → Collect from hub) and the recipient's SMS (hub address, code).
   */
  async readyForCollection(db: Db, parcel: Parcel, after: AfterCommit): Promise<Parcel> {
    const hub = await db.hub.findUniqueOrThrow({ where: { id: parcel.collectHubId! }, select: { id: true, name: true, address: true } });
    const settings = await this.packageSettings.settings(db);
    const now = operationNow();
    const code = randomDigits(6);
    const dueAt = new Date(now.getTime() + settings.collectHoldDays * 86_400_000);
    const ready = await this.transition(
      db,
      parcel,
      {
        to: "READY_FOR_COLLECTION",
        actorRole: "ops",
        data: { readyForCollectionAt: now, collectionDueAt: dueAt, collectionReminderAt: null, collectionCodeEncrypted: encrypt(code), deliveryRiderId: null },
        title: `Ready for collection at ${hub.name}`,
        description: `The parcel is waiting at ${hub.name} (${hub.address}). The recipient collects it with the collection code by ${dhakaDate(dueAt)}.`,
        location: hub.name,
        metadata: { hubId: hub.id, kind: "ready_for_collection", dueAt: dueAt.toISOString() },
      },
      "system",
      undefined,
      after,
    );
    after.outbox.push(
      ...(await this.returnNotices.notify(db, {
        event: "parcel.ready_for_collection",
        to: { phone: parcel.recipientPhone, name: parcel.recipientName },
        vars: { trackingId: parcel.trackingId, hub: hub.name, hubAddress: hub.address, code, codAmount: Number(parcel.codAmount) > 0 ? Number(parcel.codAmount).toLocaleString("en-BD") : "", until: dhakaDate(dueAt), trackingUrl: trackingUrl(parcel.trackingId) },
        parcel,
      })),
    );
    return ready;
  }

  /**
   * Re-attempt fee (service packages): after the n-th failed delivery attempt, a parcel whose package
   * charges re-attempts beyond its free ones gets the fee added to `reattemptCharge` and `totalCharge`.
   */
  async chargeReattempt(db: Db, parcel: Parcel, actor: Actor | "system", meta: Partial<RequestMeta> | undefined) {
    const snap = parcel.pricingSnapshot as { engine?: string; prices?: unknown } | null;
    if (snap?.engine !== "package-v2" && snap?.engine !== "package") return 0;
    const prices = packagePricesSchema.parse(snap.prices ?? {});
    const failed = await db.deliveryAttempt.count({ where: { parcelId: parcel.id, outcome: "FAILED" } });
    const fee = reattemptFeeFor(prices, failed);
    if (!fee) return 0;
    await db.parcel.update({ where: { id: parcel.id }, data: { reattemptCharge: { increment: fee }, totalCharge: { increment: fee } } });
    const label = actor === "system" ? "System" : actorLabel(actor);
    await db.trackingEvent.create({
      data: {
        parcelId: parcel.id,
        createdAt: operationNow(),
        status: parcel.status,
        title: "Re-attempt fee",
        description: `Delivery attempt ${failed} failed; the package includes ${prices.freeReattempts} free re-attempt${prices.freeReattempts === 1 ? "" : "s"}, so ৳${fee} is added to the delivery charge.`,
        visibility: "INTERNAL",
        actorUserId: actor !== "system" && actor.kind === "user" ? actor.userId : null,
        actorLabel: label,
        metadata: { kind: "reattempt_fee", fee, failedAttempts: failed },
      },
    });
    await this.audit.record(actor, { action: "parcel.reattempt_fee", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId, fee, failedAttempts: failed } }, meta, db);
    return fee;
  }

  /** Queue SMS and webhooks written in a committed transaction. */
  async flush(after: AfterCommit) {
    await Promise.all([this.outbox.flush(after.outbox), this.webhooks.flush(after.webhooks)]);
    this.realtime.publish(...after.realtime);
  }

  newAfterCommit = (): AfterCommit => ({ outbox: [], webhooks: [], realtime: [] });

  /**
   * A fresh delivery code for the recipient, sent by SMS. Returns the encrypted value to store. A
   * parcel whose package (or booking) left out the "Delivery code" message gets no SMS, and OTP
   * isn't one of its proof methods (proofMethodsFor).
   */
  async issueDeliveryCode(db: Db, parcel: Pick<Parcel, "trackingId" | "recipientPhone" | "codAmount"> & Partial<Pick<Parcel, "packageVersionId" | "notifications">>, after: AfterCommit) {
    const code = randomDigits(4);
    const cod = Number(parcel.codAmount) > 0 ? Number(parcel.codAmount).toLocaleString("en-BD") : "";
    // A security message: can't be switched off by recipients, skips per-recipient SMS spacing.
    after.outbox.push(
      ...(await this.returnNotices.notify(db, {
        event: "parcel.delivery_code",
        to: { phone: parcel.recipientPhone },
        vars: { trackingId: parcel.trackingId, code, codAmount: cod },
        channels: ["sms"],
        parcel: { packageVersionId: parcel.packageVersionId ?? null, notifications: parcel.notifications ?? [] },
      })),
    );
    return encrypt(code);
  }

  /** Development only: lets testers see the code without a phone. */
  devDeliveryCode(parcel: Pick<Parcel, "deliveryOtpEncrypted">) {
    return env().EXPOSE_DEV_OTP && parcel.deliveryOtpEncrypted ? decrypt(parcel.deliveryOtpEncrypted) : undefined;
  }

  private async notify(db: Db, parcel: Parcel, from: ParcelStatus, after: AfterCommit) {
    const to = parcel.status as ParcelStatus;
    // "Live rider location" (package): the recipient's out-for-delivery link carries a token that shows
    // the rider's position (a lookup by tracking ID alone doesn't).
    const track =
      to === "OUT_FOR_DELIVERY" && parcel.services.includes("tracking.live_location")
        ? trackingUrl(parcel.trackingId, signLiveLocationAccess(parcel.trackingId))
        : trackingUrl(parcel.trackingId);
    // Status notices through NotifyService (templates, admin toggles, preferences, rate limits).
    const sender = { phone: parcel.senderPhone, userId: parcel.customerId, name: parcel.senderName };
    const STATUS_EVENTS: Partial<Record<ParcelStatus, { event: NotificationEvent; to: NotifyInput["to"] }>> = {
      DELIVERED: { event: "parcel.delivered", to: sender },
      PICKUP_CANCELLED: { event: "parcel.cancelled", to: sender },
      PICKUP_ASSIGNED: { event: "parcel.pickup_assigned", to: sender },
      PICKED_UP: { event: "parcel.picked_up", to: sender },
      OUT_FOR_DELIVERY: { event: "parcel.out_for_delivery", to: { phone: parcel.recipientPhone, name: parcel.recipientName } },
      RETRY_SCHEDULED: { event: "parcel.delivery_failed", to: sender },
      // RETURN_SCHEDULED / RETURNED: sent below with the return details.
    };
    // Merchants ship in bulk and follow progress in their panel / webhooks: only the final outcome reaches them.
    const merchantQuiet: ParcelStatus[] = ["PICKUP_ASSIGNED", "PICKED_UP", "RETRY_SCHEDULED"];
    const notice = from !== to && !(parcel.merchantId && merchantQuiet.includes(to)) ? STATUS_EVENTS[to] : undefined;
    // Share rider phone number (package): in the out-for-delivery message, on the delivery day only.
    const riderPhone =
      to === "OUT_FOR_DELIVERY" && parcel.deliveryRiderId && parcel.services.includes("tracking.rider_phone")
        ? ((await db.rider.findUnique({ where: { id: parcel.deliveryRiderId }, select: { user: { select: { phone: true } } } }))?.user.phone ?? "")
        : "";
    if (notice) after.outbox.push(...(await this.returnNotices.notify(db, { ...notice, vars: { trackingId: parcel.trackingId, trackingUrl: track, ...(riderPhone ? { riderPhone } : {}) }, parcel })));
    if (to === "DELIVERED") {
      // Ask customers (not merchants, who ship in bulk) to rate the delivery; the signed link works without signing in.
      if (!parcel.merchantId) after.outbox.push(
        ...(await this.returnNotices.notify(db, {
          event: "parcel.feedback_request",
          to: { phone: parcel.senderPhone, userId: parcel.customerId, name: parcel.senderName },
          vars: { trackingId: parcel.trackingId, link: trackingUrl(parcel.trackingId, signParcelAccess(parcel.trackingId, "feedback"), "feedback") },
          parcel,
        })),
      );
    }
    if (parcel.merchantId) {
      const data = {
        trackingId: parcel.trackingId,
        merchantOrderRef: parcel.merchantOrderRef,
        from,
        status: to,
        statusLabel: PARCEL_STATUS_LABEL[to],
        at: operationNow().toISOString(),
        // Partial delivery: the cash actually collected; the rest returns on a new return order.
        ...(to === "DELIVERED" && parcel.partialDelivery ? { partial: true, codCollected: Number(parcel.codCollectedAmount ?? 0) } : {}),
      };
      after.webhooks.push(...(await this.webhooks.emit(db, parcel.merchantId, "shipment.status_updated", data)));
      const specific = WEBHOOK_FOR[to];
      if (specific) after.webhooks.push(...(await this.webhooks.emit(db, parcel.merchantId, specific, data)));
      for (const extra of EXTRA_WEBHOOKS[to] ?? []) after.webhooks.push(...(await this.webhooks.emit(db, parcel.merchantId, extra, data)));
    }
    if (to === "RETURN_SCHEDULED" || to === "RETURNED") {
      const charge = parcel.returnCharge == null ? null : Number(parcel.returnCharge);
      after.outbox.push(
        ...(await this.returnNotices.notify(db, {
          event: to === "RETURNED" ? "parcel.returned" : "parcel.return_scheduled",
          to: { phone: parcel.senderPhone, userId: parcel.customerId, name: parcel.senderName },
          vars: { trackingId: parcel.trackingId, reason: parcel.returnReason, returnCharge: charge, trackingUrl: track },
          parcel,
        })),
      );
    }
    // The merchant's team: final outcomes in the merchant panel's bell (docs "In-app notifications").
    const MERCHANT_INBOX: Partial<Record<ParcelStatus, NotificationEvent>> = {
      DELIVERED: "parcel.delivered",
      PICKUP_CANCELLED: "parcel.cancelled",
      RETURN_SCHEDULED: "parcel.return_scheduled",
      RETURNED: "parcel.returned",
    };
    const inboxEvent = parcel.merchantId && from !== to ? MERCHANT_INBOX[to] : undefined;
    if (inboxEvent) {
      const copy = this.inbox.merchantCopy(inboxEvent, { trackingId: parcel.trackingId, reason: parcel.returnReason, returnCharge: parcel.returnCharge == null ? null : Number(parcel.returnCharge) });
      if (copy) await this.inbox.toMerchant(db, parcel.merchantId!, copy);
    }
  }

  /**
   * A drop-off parcel arrives at its declared hub (hub console scan or typed ID): AT_HUB with the
   * "Received at <hub> (drop-off)" event, a HUB_RECEIVE scan and the delivery SLA counted from now.
   * The caller checks that the actor works at `hub`; transition() checks it is the declared hub.
   */
  async receiveDropOff(
    db: Db,
    parcel: Parcel,
    input: { hub: { id: string; name: string }; code?: string; source?: ScanSource; note?: string; expectedVersion?: number },
    actor: Actor,
    meta: Partial<RequestMeta> | undefined,
    after: AfterCommit,
  ) {
    const now = operationNow();
    // The journey starts at the drop-off hub (the origin it was priced from).
    const origin = (parcel.pricingSnapshot as { origin?: { district?: string; zone?: string } } | null)?.origin;
    const targets = await slaTargets(db, {
      serviceLevel: parcel.serviceLevel,
      pickupDistrict: origin?.district ?? parcel.pickupDistrict,
      pickupZone: origin?.zone ?? parcel.pickupZone,
      // Incomplete orders: the destination they were priced to until it is completed.
      deliveryDistrict: pricedDestination(parcel).district,
      deliveryZone: pricedDestination(parcel).zone,
    });
    const deliveryDueAt = new Date(now.getTime() + targets.deliveryMinutes * 60_000);
    const updated = await this.transition(
      db,
      parcel,
      {
        to: "AT_HUB",
        actorRole: "ops",
        data: {
          currentHubId: input.hub.id,
          deliveryRiderId: null,
          droppedOffAt: now,
          deliveryDueAt,
          slaState: "ON_TRACK",
          // The customer promise counts from the hand-over too, never earlier than booked.
          estimatedDeliveryAt: parcel.estimatedDeliveryAt && parcel.estimatedDeliveryAt > deliveryDueAt ? parcel.estimatedDeliveryAt : deliveryDueAt,
        },
        title: `Received at ${input.hub.name} (drop-off)`,
        description: `The sender handed the parcel over at ${input.hub.name}. It is now in the Paira Express network.`,
        location: input.hub.name,
        metadata: { hubId: input.hub.id, kind: "drop_off_received" },
        internalNote: input.note,
        expectedVersion: input.expectedVersion,
      },
      actor,
      meta,
      after,
    );
    await db.scanEvent.create({
      data: {
        code: (input.code?.trim().toUpperCase() || parcel.trackingId).slice(0, 64),
        trackingId: parcel.trackingId,
        parcelId: parcel.id,
        kind: "HUB_RECEIVE",
        hubId: input.hub.id,
        userId: actor.kind === "user" ? actor.userId : null,
        source: input.source ?? "MANUAL",
        ok: true,
        message: "Drop-off received",
      },
    });
    // Received at a franchise hub (merchant drop-off or walk-in at its counter): the franchise's pickup commission.
    const franchise = await franchiseOfHub(db, input.hub.id);
    if (franchise) await recordFranchiseCommission(db, this.ledger, { franchise, parcelId: parcel.id, type: "PICKUP", at: now });
    return updated;
  }

  private async wrongDropOffHub(db: Db, parcel: Parcel) {
    const declared = parcel.dropOffHubId ? await db.hub.findUnique({ where: { id: parcel.dropOffHubId }, select: { id: true, name: true } }) : null;
    return new AppError(
      "DROP_OFF_WRONG_HUB",
      declared ? `${parcel.trackingId} is booked for drop-off at ${declared.name}. Receive it there.` : `${parcel.trackingId} has no drop-off hub. Contact operations.`,
      HttpStatus.CONFLICT,
      { dropOffHub: declared },
    );
  }

  private changedError() {
    return new AppError("PARCEL_CHANGED", "This parcel was just updated by someone else. Refresh and try again.", HttpStatus.CONFLICT);
  }
}
