import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { cashFor, createPartialReturn, partialData } from "./partial-delivery";
import { operationNow } from "../../common/operation-time";
import { addressText } from "../../common/address";
import type { z } from "zod";
import type { deliveryOutcomeSchema, pickupOutcomeSchema, proofCaptureSchema } from "@delivery-fast/shared";
import { AuditService } from "../../common/audit.service";
import { actorLabel } from "../../common/auth/actor";
import { PrismaService, type Db } from "../../common/prisma.service";
import { StorageService } from "../../common/storage.service";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import { decrypt, safeEqual } from "../../common/crypto";
import { parcelInclude, parcelView, proofMethodsOf, type ParcelWithRelations } from "./parcel.views";
import { ParcelWorkflowService, parcelEvent, type AfterCommit } from "./parcel-workflow.service";
import { ParcelsService } from "./parcels.service";
import type { Parcel, Prisma } from "../../generated/prisma/client";
import { addDays, dhakaDayStart, dhakaMonthStart, dhakaWeekStart, opsHubScope } from "./ops-scope";
import { recordTaskEarning } from "../rider/earnings";
import { LedgerService } from "../finance/ledger.service";
import { recordFranchiseReturn } from "../franchise/franchise-commission";

/** Service lines riders are paid for (rider plans in the platform settings use these keys). */
type ServiceLine = "ecommerce" | "document" | "parcel";
const lineOf = (merchantType: string | null | undefined): ServiceLine =>
  merchantType === "ECOMMERCE" ? "ecommerce" : merchantType === "BANKING_FINANCIAL" ? "document" : "parcel";

const PICKUP_STATUSES = ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED"] as const;
const DELIVERY_STATUSES = ["ASSIGNED", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "EXCEPTION"] as const;

/**
 * One pickup stop: a merchant (all its parcels assigned to the rider) or, for customer parcels, one
 * sender. The rider app's "Pickup from merchant" scan sends it back as `expectedStop`.
 */
export const pickupStopKey = (p: Pick<Parcel, "merchantId" | "senderPhone">) => (p.merchantId ? `M:${p.merchantId}` : `S:${p.senderPhone}`);

/** Tracking-event metadata kinds of the rider → hub handover list (no status change: the hub scans to receive). */
const HANDOVER = "RIDER_HANDOVER";
const HANDOVER_WITHDRAWN = "RIDER_HANDOVER_WITHDRAWN";
type EventLike = { createdAt: Date; metadata: unknown };
/** The rider's latest handover of a picked-up parcel to a hub, unless withdrawn since. */
export function currentHandover(events: EventLike[]): { hubId: string; hubName: string; at: Date } | null {
  for (const e of [...events].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    const m = (e.metadata ?? {}) as { kind?: string; hubId?: string; hubName?: string };
    if (m.kind === HANDOVER_WITHDRAWN) return null;
    if (m.kind === HANDOVER && m.hubId) return { hubId: m.hubId, hubName: m.hubName ?? "", at: e.createdAt };
  }
  return null;
}

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
  @Inject(AuditService) private readonly audit!: AuditService;

  /** Pickup queue and delivery run for the signed-in rider. */
  async tasks(actor: UserActor) {
    const riderId = this.riderId(actor);
    const [pickups, deliveries, carrying] = await Promise.all([
      // On-demand pickups / deliveries first (service packages), then oldest first.
      this.prisma.parcel.findMany({ where: { pickupRiderId: riderId, status: { in: [...PICKUP_STATUSES] } }, include: parcelInclude, orderBy: [{ onDemand: "desc" }, { createdAt: "asc" }] }),
      this.prisma.parcel.findMany({ where: { deliveryRiderId: riderId, status: { in: [...DELIVERY_STATUSES] } }, include: parcelInclude, orderBy: [{ onDemand: "desc" }, { createdAt: "asc" }] }),
      // Collected and still with the rider ("Pickup from merchant" scans) until a hub scans them in.
      this.prisma.parcel.findMany({ where: { pickupRiderId: riderId, status: "PICKED_UP" }, include: parcelInclude, orderBy: [{ pickedUpAt: "asc" }] }),
    ]);
    const stop = (p: ParcelWithRelations) => ({
      key: pickupStopKey(p),
      name: p.merchant?.name ?? p.senderName,
      address: addressText(p.pickupStreet, p.pickupArea, p.pickupZone),
    });
    return {
      pickups: pickups.map(p => ({ ...parcelView(p, { internal: false }), pickupStop: stop(p) })),
      // deliveryCodeSent: the recipient holds a valid code (sent when the delivery started), so OTP proof works.
      deliveries: deliveries.map(p => ({ ...parcelView(p, { internal: false }), deliveryCodeSent: Boolean(p.deliveryOtpEncrypted), devDeliveryCode: this.workflow.devDeliveryCode(p) })),
      carrying: carrying.map(p => ({ ...parcelView(p, { internal: false }), pickupStop: stop(p), handover: currentHandover(p.events) })),
    };
  }

  async pickup(actor: UserActor, trackingId: string, input: z.infer<typeof pickupOutcomeSchema>, meta: RequestMeta) {
    const riderId = this.riderId(actor);
    return this.change(actor, trackingId, async (tx, parcel, after) => {
      if (parcel.pickupRiderId !== riderId) throw forbidden("This pickup isn't assigned to you");
      const rider = await tx.rider.findUniqueOrThrow({ where: { id: riderId }, include: { user: { select: { name: true } } } });
      const label = `${rider.code} · ${rider.user.name}`;
      if (input.outcome === "COLLECTED") {
        if (input.expectedStop && input.expectedStop !== pickupStopKey(parcel)) {
          const owner = parcel.merchantId ? (await tx.merchant.findUnique({ where: { id: parcel.merchantId }, select: { name: true } }))?.name : parcel.senderName;
          throw new AppError("OTHER_PICKUP_STOP", `${parcel.trackingId} belongs to ${owner ?? "another sender"}, not this pickup. Scan it at its own stop.`, HttpStatus.CONFLICT);
        }
        // A repeated scan (or an offline replay) of a parcel already collected changes nothing.
        if (parcel.status === "PICKED_UP") return;
        if (!(PICKUP_STATUSES as readonly string[]).includes(parcel.status))
          throw new AppError("NOT_AWAITING_PICKUP", `${parcel.trackingId} isn't waiting for pickup (${parcel.status.toLowerCase().replace(/_/g, " ")}).`, HttpStatus.CONFLICT);
        await this.workflow.transition(
          tx,
          parcel,
          { to: "PICKED_UP", actorRole: "rider", data: { pickedUpAt: new Date() }, description: `${label} collected the parcel.`, internalNote: input.note },
          actor,
          meta,
          after,
        );
        await recordTaskEarning(tx, { riderId, type: "PICKUP", parcel }, this.ledger);
      } else if (input.outcome === "COLLECTED_DELIVER_DIRECT") {
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
        await recordTaskEarning(tx, { riderId, type: "PICKUP", parcel }, this.ledger);
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
        await recordTaskEarning(tx, { riderId, type: "PICKUP", parcel }, this.ledger);
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

  /**
   * "Start delivery": leaving for the recipient. Every start (first attempt or a retry from
   * RETRY_SCHEDULED / EXCEPTION) issues a FRESH delivery code and sends it by SMS, so the recipient's
   * latest message always holds the valid code; any earlier code stops working. Assignment sends none.
   */
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
          data: { deliveryOtpEncrypted: await this.workflow.issueDeliveryCode(tx, parcel, after) },
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
      // Only once the delivery has started (the code is sent then); a retry keeps its code until the next start.
      if (parcel.status === "ASSIGNED" || (parcel.status === "RETRY_SCHEDULED" && !parcel.deliveryOtpEncrypted))
        throw new AppError("DELIVERY_NOT_STARTED", "Start the delivery first; the code is sent to the recipient then", HttpStatus.CONFLICT);
      if (!["OUT_FOR_DELIVERY", "RETRY_SCHEDULED"].includes(parcel.status)) throw new AppError("NOT_OUT_FOR_DELIVERY", "This parcel isn't out for delivery", HttpStatus.CONFLICT);
      await tx.parcel.update({ where: { id: parcel.id }, data: { deliveryOtpEncrypted: await this.workflow.issueDeliveryCode(tx, parcel, after) } });
    });
  }

  async deliver(actor: UserActor, trackingId: string, input: z.infer<typeof deliveryOutcomeSchema>, meta: RequestMeta) {
    const riderId = this.riderId(actor);
    return this.change(actor, trackingId, async (tx, parcel, after) => {
      if (parcel.deliveryRiderId !== riderId) throw forbidden("This delivery isn't assigned to you");
      if (input.outcome === "DELIVERED") {
        // Partial delivery: the cash actually collected (0 … COD); else exactly the COD amount.
        const partial = !!input.partial;
        const { cod, collected } = cashFor(parcel, { partial, codCollected: input.codCollected });
        if (!partial && cod > 0 && input.codCollected !== cod)
          throw new AppError("COD_MISMATCH", `Collect exactly ৳${cod.toLocaleString("en-BD")} before completing the delivery (or tick Partial delivery)`, 422, { expected: cod });
        // Service packages: only the proof methods active for this parcel (OTP needs the delivery code message).
        const allowed = proofMethodsOf(parcel);
        if (!allowed.includes(input.proof.method))
          throw new AppError("PROOF_METHOD_NOT_ALLOWED", `This parcel takes ${allowed.map(m => (m === "OTP" ? "the recipient's code" : m === "PHOTO" ? "a photo of the signed invoice" : "the recipient's signature")).join(" or ")} as proof`, 422, { allowed });
        let fileId: string | undefined;
        let otpVerified = false;
        if (input.proof.method === "OTP") {
          // No code yet (e.g. still ASSIGNED): the recipient only gets one when the delivery starts.
          if (!parcel.deliveryOtpEncrypted)
            throw new AppError("DELIVERY_NOT_STARTED", "Start the delivery first; the code is sent to the recipient then", HttpStatus.CONFLICT);
          const expected = decrypt(parcel.deliveryOtpEncrypted);
          if (!safeEqual(expected, input.proof.otp)) throw new AppError("INVALID_DELIVERY_CODE", "The recipient's code is incorrect", 422);
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
            data: { deliveredAt: now, attemptCount: { increment: 1 }, deliveryOtpEncrypted: null, receiverRelation: input.receiverRelation || "Self", ...(partial ? partialData(collected, input.note) : {}) },
            ...(partial ? { title: "Partially delivered", metadata: { partial: true, codCollected: collected } } : {}),
            description: partial
              ? `Partly delivered to ${input.receivedBy} (${input.proof.method === "OTP" ? "OTP" : input.proof.method.toLowerCase()} proof): ৳${collected.toLocaleString("en-BD")} collected${cod > 0 ? ` of ৳${cod.toLocaleString("en-BD")}` : ""}. What the recipient didn't keep goes back to the sender.`
              : `Delivered to ${input.receivedBy} with ${input.proof.method === "OTP" ? "OTP" : input.proof.method.toLowerCase()} proof.`,
            internalNote: input.note,
          },
          actor,
          meta,
          after,
        );
        await tx.deliveryProof.create({ data: { parcelId: parcel.id, method: input.proof.method, receivedBy: input.receivedBy, fileId, otpVerified, note: input.note, ...capture } });
        await tx.deliveryAttempt.create({ data: { parcelId: parcel.id, riderId, outcome: "DELIVERED", note: input.note } });
        if (collected > 0) await tx.codCollection.create({ data: { parcelId: parcel.id, riderId, amount: collected, collectedAt: now } });
        if (partial) {
          const rider = await tx.rider.findUniqueOrThrow({ where: { id: riderId }, select: { hubId: true } });
          await createPartialReturn(tx, parcel, { hubId: parcel.currentHubId ?? rider.hubId, note: input.note, by: actorLabel(actor) }, after);
        }
        await recordTaskEarning(tx, { riderId, type: "DELIVERY", parcel, at: now }, this.ledger);
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

  /**
   * "Hand over at hub": the rider puts a parcel they collected (PICKED_UP) on their handover list for a
   * hub. No status change: the hub receives it by scanning (POST /ops/hub-receive → AT_HUB), so hub
   * receipt stays the hub's confirmation. Writes an internal tracking event, an audit entry and a
   * RIDER_HANDOVER scan, and tells the hub live (`rider.handover`). Repeating it for the same hub is a no-op.
   */
  async handover(actor: UserActor, trackingId: string, input: { hubId: string; source?: "CAMERA" | "KEYBOARD" | "MANUAL" }, meta: RequestMeta) {
    const riderId = this.riderId(actor);
    return this.change(actor, trackingId, async (tx, parcel, after) => {
      if (parcel.pickupRiderId !== riderId) throw forbidden("This parcel wasn't collected by you");
      if (parcel.status !== "PICKED_UP") {
        const where = parcel.status === "AT_HUB" ? "It was already received at a hub." : `It's ${parcel.status.toLowerCase().replace(/_/g, " ")}.`;
        throw new AppError("NOT_WITH_RIDER", `${parcel.trackingId} isn't a picked-up parcel you're carrying. ${where}`, HttpStatus.CONFLICT);
      }
      const hub = await tx.hub.findUnique({ where: { id: input.hubId }, select: { id: true, name: true, active: true } });
      if (!hub || !hub.active) throw notFound("Hub");
      const events = await tx.trackingEvent.findMany({ where: { parcelId: parcel.id, visibility: "INTERNAL" }, select: { createdAt: true, metadata: true } });
      if (currentHandover(events)?.hubId === hub.id) return;
      await this.writeHandoverEvent(tx, actor, parcel, { kind: HANDOVER, hub, title: `Handed over at ${hub.name}`, description: `The rider handed the parcel over at ${hub.name}. Waiting for the hub to scan it in.` }, after);
      await this.audit.record(actor, { action: "parcel.rider_handover", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId, hubId: hub.id } }, meta, tx);
      await tx.scanEvent.create({ data: { code: parcel.trackingId, trackingId: parcel.trackingId, parcelId: parcel.id, kind: "RIDER_HANDOVER", hubId: hub.id, riderId, userId: actor.userId, source: input.source ?? "KEYBOARD", ok: true, message: `Handed over at ${hub.name}` } });
    });
  }

  /** Takes a parcel off the handover list again (the hub hasn't scanned it in yet). */
  async withdrawHandover(actor: UserActor, trackingId: string, meta: RequestMeta) {
    const riderId = this.riderId(actor);
    return this.change(actor, trackingId, async (tx, parcel, after) => {
      if (parcel.pickupRiderId !== riderId) throw forbidden("This parcel wasn't collected by you");
      if (parcel.status !== "PICKED_UP") throw new AppError("HANDOVER_CLOSED", `${parcel.trackingId} was already received by the hub. It can't be taken back.`, HttpStatus.CONFLICT);
      const events = await tx.trackingEvent.findMany({ where: { parcelId: parcel.id, visibility: "INTERNAL" }, select: { createdAt: true, metadata: true } });
      const current = currentHandover(events);
      if (!current) return;
      const hub = { id: current.hubId, name: current.hubName };
      await this.writeHandoverEvent(tx, actor, parcel, { kind: HANDOVER_WITHDRAWN, hub, title: "Handover withdrawn", description: `The rider took the parcel back off the handover list for ${hub.name}.` }, after);
      await this.audit.record(actor, { action: "parcel.rider_handover_withdraw", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId, hubId: hub.id } }, meta, tx);
    });
  }

  private async writeHandoverEvent(
    tx: Db,
    actor: UserActor,
    parcel: Parcel,
    e: { kind: string; hub: { id: string; name: string }; title: string; description: string },
    after: AfterCommit,
  ) {
    // Bump the version so a hub scan-in racing with this sees the change (optimistic locking).
    const { count } = await tx.parcel.updateMany({ where: { id: parcel.id, version: parcel.version, status: "PICKED_UP" }, data: { version: { increment: 1 } } });
    if (!count) throw conflict("PARCEL_CHANGED", `${parcel.trackingId} was just updated by someone else. Refresh and try again.`);
    await tx.trackingEvent.create({
      data: {
        parcelId: parcel.id,
        createdAt: operationNow(),
        status: "PICKED_UP",
        title: e.title,
        description: e.description,
        location: e.hub.name,
        visibility: "INTERNAL",
        actorUserId: actor.userId,
        actorLabel: actorLabel(actor),
        metadata: { kind: e.kind, hubId: e.hub.id, hubName: e.hub.name },
      },
    });
    const base = parcelEvent(parcel);
    after.realtime.push({ ...base, hubIds: [...(base.hubIds ?? []), e.hub.id], staffPermission: "parcel:read:any" });
    after.realtime.push({ type: "rider.handover", id: parcel.trackingId, hubIds: [e.hub.id], riderIds: [parcel.pickupRiderId], staffPermission: "parcel:read:any", data: { kind: e.kind, hubId: e.hub.id } });
  }

  /**
   * Hub side of the handover list: parcels riders handed over at this hub that the hub hasn't scanned
   * in yet (still PICKED_UP), grouped by rider. The receive desk (POST /ops/hub-receive) scans them in.
   */
  async hubHandovers(actor: Actor, hubId: string) {
    const scope = opsHubScope(actor);
    if (scope && !scope.includes(hubId)) throw forbidden("You can only see your own hub's handovers");
    const hub = await this.prisma.hub.findUnique({ where: { id: hubId }, select: { id: true, name: true } });
    if (!hub) throw notFound("Hub");
    const parcels = await this.prisma.parcel.findMany({
      where: { status: "PICKED_UP", events: { some: { visibility: "INTERNAL", metadata: { path: ["hubId"], equals: hubId } } } },
      select: {
        trackingId: true,
        recipientName: true,
        senderName: true,
        merchant: { select: { name: true } },
        pickupRider: { select: { id: true, code: true, user: { select: { name: true } } } },
        events: { where: { visibility: "INTERNAL" }, select: { createdAt: true, metadata: true } },
      },
    });
    const riders = new Map<string, { rider: { id: string; code: string; name: string }; parcels: { trackingId: string; merchant: string; recipient: string; handedOverAt: Date }[] }>();
    for (const p of parcels) {
      const current = currentHandover(p.events);
      if (current?.hubId !== hubId || !p.pickupRider) continue;
      const entry = riders.get(p.pickupRider.id) ?? { rider: { id: p.pickupRider.id, code: p.pickupRider.code, name: p.pickupRider.user.name }, parcels: [] };
      entry.parcels.push({ trackingId: p.trackingId, merchant: p.merchant?.name ?? p.senderName, recipient: p.recipientName ?? "", handedOverAt: current.at });
      riders.set(p.pickupRider.id, entry);
    }
    const items = [...riders.values()].map(r => ({ ...r, parcels: r.parcels.sort((a, b) => a.handedOverAt.getTime() - b.handedOverAt.getTime()) }));
    return { hub, total: items.reduce((n, r) => n + r.parcels.length, 0), items };
  }

  /**
   * Return runs assigned to the rider (planned at the hub, or out for return), with the parcels still to
   * return: the rider app's "Assigned returns" and "Return to merchant". The rider scans each parcel the
   * merchant takes back (returnToMerchant); the run completes with its last parcel.
   */
  async returnRuns(actor: UserActor) {
    const riderId = this.riderId(actor);
    const runs = await this.prisma.returnRun.findMany({
      where: { riderId, status: { in: ["PLANNED", "OUT_FOR_RETURN"] } },
      orderBy: [{ dispatchedAt: "asc" }, { createdAt: "asc" }],
      include: {
        merchant: { select: { id: true, name: true, pickupAddress: true, pickupArea: true, contactPhone: true } },
        parcels: { where: { status: "RETURN_SCHEDULED" }, select: { trackingId: true, recipientName: true, returnReason: true, merchantOrderRef: true }, orderBy: { trackingId: "asc" } },
      },
    });
    return {
      items: runs.map(r => ({
        id: r.id,
        number: r.number,
        status: r.status,
        dispatchedAt: r.dispatchedAt,
        merchant: { id: r.merchant.id, name: r.merchant.name, address: addressText(r.merchant.pickupAddress, r.merchant.pickupArea), phone: r.merchant.contactPhone },
        parcels: r.parcels,
      })),
    };
  }

  /**
   * "Return to merchant" scan: the merchant took this parcel back from the rider of its return run:
   * Returned (as on Scan desk > Return entry: the return charge earned, a franchise rider's return pay).
   * A planned run is sent out with the rider's first return; the run completes with its last parcel.
   */
  async returnToMerchant(actor: UserActor, trackingId: string, input: { runId?: string; receivedBy?: string; note?: string }, meta: RequestMeta) {
    const riderId = this.riderId(actor);
    const after = this.workflow.newAfterCommit();
    const result = await this.prisma.$transaction(
      async tx => {
        const parcel = await tx.parcel.findUnique({ where: { trackingId: trackingId.trim().toUpperCase() } });
        if (!parcel) throw notFound("Parcel");
        const run = parcel.returnRunId ? await tx.returnRun.findUnique({ where: { id: parcel.returnRunId }, include: { merchant: { select: { name: true } } } }) : null;
        if (parcel.status === "RETURNED") return { trackingId: parcel.trackingId, outcome: "ALREADY_RETURNED" as const, run: run?.number ?? null, merchant: run?.merchant.name ?? null, runCompleted: false };
        if (!run || run.riderId !== riderId || !["PLANNED", "OUT_FOR_RETURN"].includes(run.status)) throw forbidden(`${parcel.trackingId} isn't on a return run assigned to you`);
        if (input.runId && input.runId !== run.id) throw new AppError("OTHER_RETURN_RUN", `${parcel.trackingId} is on ${run.number} (${run.merchant.name}), not this run`, HttpStatus.CONFLICT, { run: run.number });
        if (parcel.status !== "RETURN_SCHEDULED") throw new AppError("NOT_ON_RETURN", `${parcel.trackingId} isn't waiting to be returned`, HttpStatus.CONFLICT);
        const now = operationNow();
        // The rider is on the way: a planned run is out for return with the first parcel taken back.
        if (run.status === "PLANNED") await tx.returnRun.update({ where: { id: run.id }, data: { status: "OUT_FOR_RETURN", dispatchedAt: now } });
        const returned = await this.workflow.transition(
          tx,
          parcel,
          {
            to: "RETURNED",
            actorRole: "rider",
            data: { deliveredAt: null },
            description: `Returned to ${run.merchant.name}${input.receivedBy ? ` (received by ${input.receivedBy})` : ""} by the rider.`,
            internalNote: input.note,
            metadata: { returnRunId: run.id, riderId, receivedBy: input.receivedBy ?? null },
          },
          actor,
          meta,
          after,
        );
        await recordFranchiseReturn(tx, this.ledger, { riderId, parcel: returned });
        let runCompleted = false;
        if (!(await tx.parcel.count({ where: { returnRunId: run.id, status: "RETURN_SCHEDULED" } }))) {
          await tx.returnRun.update({ where: { id: run.id }, data: { status: "COMPLETED", completedAt: now } });
          runCompleted = true;
        }
        await this.audit.record(actor, { action: "parcel.rider_return", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId, returnRun: run.number, receivedBy: input.receivedBy ?? null, runCompleted } }, meta, tx);
        return { trackingId: parcel.trackingId, outcome: "RETURNED" as const, run: run.number, merchant: run.merchant.name, runCompleted };
      },
      { timeout: 15_000 },
    );
    await this.workflow.flush(after);
    return result;
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
