import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { FAILURE_REASONS, parcelStatusLabel, type ParcelStatus } from "@delivery-fast/shared";
import { AuditService } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import { StorageService } from "../../common/storage.service";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError } from "../../common/errors";
import { codeVariants, scanSourceSchema } from "../ops/ops-common";
import { LedgerService } from "../finance/ledger.service";
import { recordTaskEarning } from "../rider/earnings";
import { ParcelWorkflowService } from "./parcel-workflow.service";
import { ParcelsService } from "./parcels.service";
import { opsHubScope } from "./ops-scope";
import { resolveZone } from "../network/zone-resolver";
import { recordFranchiseReturn } from "../franchise/franchise-commission";

/** A photo of the signed delivery slip, shrunk in the browser (JPEG / WebP / PNG, up to ~1 MB). */
const slipPhoto = z
  .string()
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, "Must be a PNG, JPEG or WebP image")
  .max(1_500_000, "The photo is too large; take it again");

/** Hub desk → Delivered entry: one scan per signed delivery slip the rider hands in. */
export const deskDeliverySchema = z.object({
  code: z.string().trim().min(3).max(64),
  /** Who signed the slip (default: the recipient on the parcel). */
  receivedBy: z.string().trim().max(120).optional(),
  /** Cash the rider collected; must equal the parcel's COD amount (default: that amount). */
  codCollected: z.coerce.number().min(0).max(10_000_000).optional(),
  note: z.string().trim().max(500).optional(),
  /** Photo of the signed slip (the delivery proof). */
  photo: slipPhoto.optional(),
  source: scanSourceSchema,
});

/** Hub desk → Out for delivery: scan parcels as the rider leaves; a parcel still at the hub needs the rider. */
export const deskDispatchSchema = z.object({
  code: z.string().trim().min(3).max(64),
  riderId: z.uuid().optional(),
  source: scanSourceSchema,
});

/** The hub the desk works at: chosen (operations managers, several hubs), else the operator's only hub. */
const deskHub = { hubId: z.uuid().optional() };

/** Hub desk → Pickup entry: a pickup rider brings what they collected; picked up for that rider and received here. */
export const deskPickupSchema = z.object({ code: z.string().trim().min(3).max(64), ...deskHub, source: scanSourceSchema });

/** Hub desk → Failed delivery: the rider reports the attempt at the desk (reason and next step set once for a batch). */
export const deskFailedSchema = z.object({
  code: z.string().trim().min(3).max(64),
  reason: z.enum(FAILURE_REASONS, "Choose the reason"),
  nextAction: z.enum(["RETRY", "RETURN_TO_HUB"], "Choose RETRY or RETURN_TO_HUB"),
  note: z.string().trim().max(500).optional(),
  ...deskHub,
  source: scanSourceSchema,
});

/** Hub desk → Transfer out: a parcel received here goes to another hub (default: the hub serving its delivery zone). */
export const deskTransferSchema = z.object({ code: z.string().trim().min(3).max(64), toHubId: z.uuid().optional(), source: scanSourceSchema });

/** Hub desk → Return entry: the sender took the returned parcel back (a rider without the app hands in the run sheet). */
export const deskReturnSchema = z.object({
  code: z.string().trim().min(3).max(64),
  /** Who took it back at the sender (optional). */
  receivedBy: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
  source: scanSourceSchema,
});

/** Hub desk → Receive from rider: parcels coming back after a failed delivery or an unfinished return. */
export const deskReceiveBackSchema = z.object({ code: z.string().trim().min(3).max(64), ...deskHub, source: scanSourceSchema });

const DELIVERABLE: ParcelStatus[] = ["ASSIGNED", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED"];
const AWAITING_PICKUP: ParcelStatus[] = ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];
const taka = (n: number) => `৳${n.toLocaleString("en-BD")}`;

/**
 * Hub desk scans for one operator working through a stack of parcels.
 * - Delivered entry: a rider without a working phone delivers and hands the signed slip in at the hub; the desk
 *   records the delivery for that rider (proof: the slip, optionally photographed; COD as cash with that rider, handed
 *   over at the hub as usual). Scanning a parcel that is already delivered updates its proof instead.
 * - Out for delivery: assigned parcels leave with their rider; a parcel still at the hub is given to the chosen rider first.
 * Each scan answers { ok, outcome, message, parcel? } and never fails for a parcel problem.
 */
@Injectable()
export class HubDeskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workflow: ParcelWorkflowService,
    private readonly parcels: ParcelsService,
    private readonly storage: StorageService,
  ) {}

  @Inject(LedgerService) private readonly ledger!: LedgerService;
  @Inject(AuditService) private readonly audit!: AuditService;

  private async find(actor: Actor, code: string, opts: { anyHub?: boolean } = {}) {
    const variants = codeVariants(code);
    const parcel = await this.prisma.parcel.findFirst({
      where: { trackingId: { in: variants } },
      include: {
        deliveryRider: { select: { id: true, code: true, hubId: true, user: { select: { name: true } } } },
        pickupRider: { select: { id: true, code: true, hubId: true, user: { select: { name: true } } } },
        proof: true,
      },
    });
    if (!parcel) return { variants, parcel: null, problem: { ok: false, outcome: "NOT_FOUND", message: `No parcel found for ${variants[0]}.`, code: variants[0] } };
    // Hub staff: parcels of their hub (held there, or with one of their riders).
    const scope = opsHubScope(actor);
    if (!opts.anyHub && scope && !(parcel.currentHubId && scope.includes(parcel.currentHubId)) && !(parcel.deliveryRider?.hubId && scope.includes(parcel.deliveryRider.hubId)))
      return { variants, parcel: null, problem: { ok: false, outcome: "OTHER_HUB", message: `${parcel.trackingId} belongs to another hub.`, code: parcel.trackingId } };
    return { variants, parcel, problem: null };
  }

  private summary(p: { trackingId: string; recipientName: string | null; codAmount: unknown; status: string; deliveryRider: { code: string; user: { name: string } } | null }) {
    return { trackingId: p.trackingId, recipient: p.recipientName, codAmount: Number(p.codAmount), status: p.status, rider: p.deliveryRider ? `${p.deliveryRider.user.name} (${p.deliveryRider.code})` : null };
  }

  async deliver(actor: Actor, input: z.infer<typeof deskDeliverySchema>, meta: RequestMeta) {
    const { parcel, problem } = await this.find(actor, input.code);
    if (!parcel) return problem;
    const userId = actor.kind === "user" ? actor.userId : undefined;
    try {
      // Already delivered: the scan updates the proof (receiver, note, photo of the slip). COD can't change here.
      if (parcel.status === "DELIVERED") {
        const file = input.photo ? await this.storage.saveDataUrl(input.photo, `${parcel.trackingId}-slip`, userId) : null;
        const data = { ...(input.receivedBy ? { receivedBy: input.receivedBy } : {}), ...(input.note ? { note: input.note } : {}), ...(file ? { fileId: file.id } : {}) };
        if (!Object.keys(data).length) return { ok: true, outcome: "ALREADY_DELIVERED", message: `${parcel.trackingId} is already delivered. Add a photo, the receiver or a note and scan again to update it.`, code: parcel.trackingId, parcel: this.summary(parcel) };
        await this.prisma.$transaction(async tx => {
          if (parcel.proof) await tx.deliveryProof.update({ where: { parcelId: parcel.id }, data });
          else await tx.deliveryProof.create({ data: { parcelId: parcel.id, method: "SIGNATURE", receivedBy: input.receivedBy || parcel.recipientName || "Recipient", fileId: file?.id, note: input.note } });
          await this.audit.record(actor, { action: "parcel.delivery_proof_update", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId, ...data, photo: !!file } }, meta, tx);
        });
        return { ok: true, outcome: "UPDATED", message: `${parcel.trackingId}: delivery details updated${file ? " (slip photo saved)" : ""}.`, code: parcel.trackingId, parcel: this.summary(parcel) };
      }
      if (!DELIVERABLE.includes(parcel.status as ParcelStatus) || !parcel.deliveryRiderId || !parcel.deliveryRider)
        return { ok: false, outcome: "NOT_WITH_RIDER", message: `${parcel.trackingId} is ${parcelStatusLabel(parcel.status as ParcelStatus).toLowerCase()}; only parcels given to a delivery rider can be entered as delivered.`, code: parcel.trackingId };
      const cod = Number(parcel.codAmount);
      const collected = input.codCollected ?? cod;
      if (cod > 0 && collected !== cod) return { ok: false, outcome: "COD_MISMATCH", message: `${parcel.trackingId}: the rider must have collected exactly ${taka(cod)} cash.`, code: parcel.trackingId };
      const rider = parcel.deliveryRider;
      const receivedBy = input.receivedBy || parcel.recipientName || "Recipient";
      const after = this.workflow.newAfterCommit();
      await this.prisma.$transaction(
        async tx => {
          const current = await this.parcels.loadForUpdate(actor, parcel.trackingId, tx);
          const file = input.photo ? await this.storage.saveDataUrl(input.photo, `${parcel.trackingId}-slip`, userId, tx) : null;
          const now = new Date();
          // Recorded for the rider who delivered it (the lifecycle's rider step), entered by the hub desk.
          await this.workflow.transition(
            tx,
            current,
            {
              to: "DELIVERED",
              actorRole: "rider",
              data: { deliveredAt: now, attemptCount: { increment: 1 }, deliveryOtpEncrypted: null },
              description: `Delivered to ${receivedBy} by ${rider.user.name}. The signed delivery slip was handed in at the hub.`,
              internalNote: input.note,
              metadata: { deskEntry: true, riderId: rider.id },
            },
            actor,
            meta,
            after,
          );
          await tx.deliveryProof.create({ data: { parcelId: parcel.id, method: "SIGNATURE", receivedBy, fileId: file?.id, note: input.note ?? "Signed delivery slip handed in at the hub", capturedAt: now } });
          await tx.deliveryAttempt.create({ data: { parcelId: parcel.id, riderId: rider.id, outcome: "DELIVERED", note: input.note ?? "Entered at the hub desk from the signed slip" } });
          if (cod > 0) {
            await tx.codCollection.create({ data: { parcelId: parcel.id, riderId: rider.id, amount: cod, collectedAt: now } });
            await this.ledger.record(tx, { type: "COD_COLLECTED", amount: parcel.codAmount, reference: parcel.trackingId, riderId: rider.id, merchantId: parcel.merchantId, occurredAt: now });
          }
          await recordTaskEarning(tx, { riderId: rider.id, type: "DELIVERY", parcel: current, at: now }, this.ledger);
          await this.audit.record(actor, { action: "parcel.desk_delivery", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId, riderId: rider.id, receivedBy, codCollected: cod, photo: !!file } }, meta, tx);
        },
        { timeout: 15_000 },
      );
      await this.workflow.flush(after);
      return {
        ok: true,
        outcome: "DELIVERED",
        message: `${parcel.trackingId} delivered by ${rider.user.name}${cod > 0 ? ` · ${taka(cod)} cash with the rider` : ""}${input.photo ? " · slip photo saved" : ""}.`,
        code: parcel.trackingId,
        parcel: { ...this.summary(parcel), status: "DELIVERED" },
      };
    } catch (error) {
      if (error instanceof AppError) return { ok: false, outcome: "REFUSED", message: `${parcel.trackingId}: ${error.message}`, code: parcel.trackingId };
      throw error;
    }
  }

  /** The hub receiving at the desk: chosen, else the operator's only hub, else the fallback (parcel / rider hub). */
  private async hubFor(actor: Actor, chosen: string | undefined, fallback: (string | null | undefined)[]) {
    const scope = opsHubScope(actor);
    const id = chosen ?? (scope?.length === 1 ? scope[0] : (fallback.find(Boolean) ?? null));
    if (!id) return { hub: null, problem: "Choose the hub you're working at." };
    if (scope && !scope.includes(id)) return { hub: null, problem: "You can only receive parcels at your own hub." };
    const hub = await this.prisma.hub.findUnique({ where: { id }, select: { id: true, name: true, active: true } });
    if (!hub || !hub.active) return { hub: null, problem: "That hub isn't operating." };
    return { hub, problem: null };
  }

  /** A pickup rider without a working phone brings the collected parcels: picked up for that rider and received here. */
  async pickupEntry(actor: Actor, input: z.infer<typeof deskPickupSchema>, meta: RequestMeta) {
    const { parcel, problem } = await this.find(actor, input.code, { anyHub: true });
    if (!parcel) return problem;
    try {
      const rider = parcel.pickupRider;
      if (parcel.status === "AT_HUB") return { ok: true, outcome: "ALREADY_RECEIVED", message: `${parcel.trackingId} is already at a hub.`, code: parcel.trackingId };
      if (parcel.intake === "DROP_OFF") return { ok: false, outcome: "NOT_A_PICKUP", message: `${parcel.trackingId} is a drop-off: receive it on Scan desk → Receive entry.`, code: parcel.trackingId };
      const picked = parcel.status === "PICKED_UP";
      if (!picked && (!AWAITING_PICKUP.includes(parcel.status as ParcelStatus) || !rider))
        return {
          ok: false,
          outcome: "NOT_WITH_PICKUP_RIDER",
          message: `${parcel.trackingId} is ${parcelStatusLabel(parcel.status as ParcelStatus, { intake: parcel.intake }).toLowerCase()}; only parcels given to a pickup rider can be entered here.`,
          code: parcel.trackingId,
        };
      const { hub, problem: hubProblem } = await this.hubFor(actor, input.hubId, [rider?.hubId, parcel.pickupHubId]);
      if (!hub) return { ok: false, outcome: "HUB_REQUIRED", message: `${parcel.trackingId}: ${hubProblem}`, code: parcel.trackingId };
      if (picked) {
        // Already marked picked up in the rider app: only the hub receipt is missing.
        await this.parcels.setStatus(actor, parcel.trackingId, { status: "AT_HUB", hubId: hub.id, note: undefined }, meta, { code: input.code, source: input.source });
      } else {
        const after = this.workflow.newAfterCommit();
        await this.prisma.$transaction(
          async tx => {
            const current = await this.parcels.loadForUpdate(actor, parcel.trackingId, tx);
            const label = `${rider!.code} · ${rider!.user.name}`;
            // The rider's pickup step, entered by the hub desk: collected and handed to this hub.
            await this.workflow.transition(
              tx,
              current,
              {
                to: "AT_HUB",
                actorRole: "rider",
                data: { pickedUpAt: new Date(), currentHubId: hub.id, deliveryRiderId: null },
                description: `${label} collected the parcel and handed it to ${hub.name}.`,
                location: hub.name,
                metadata: { hubId: hub.id, deskEntry: true },
              },
              actor,
              meta,
              after,
            );
            await recordTaskEarning(tx, { riderId: rider!.id, type: "PICKUP", parcel: current }, this.ledger);
            await this.audit.record(actor, { action: "parcel.desk_pickup", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId, riderId: rider!.id, hubId: hub.id } }, meta, tx);
          },
          { timeout: 15_000 },
        );
        await this.workflow.flush(after);
      }
      return { ok: true, outcome: "RECEIVED", message: `${parcel.trackingId} picked up${rider ? ` by ${rider.user.name}` : ""} and received at ${hub.name}.`, code: parcel.trackingId };
    } catch (error) {
      if (error instanceof AppError) return { ok: false, outcome: "REFUSED", message: `${parcel.trackingId}: ${error.message}`, code: parcel.trackingId };
      throw error;
    }
  }

  /** The delivery rider reports a failed attempt at the desk: try again later, or back at the hub. */
  async failedDelivery(actor: Actor, input: z.infer<typeof deskFailedSchema>, meta: RequestMeta) {
    const { parcel, problem } = await this.find(actor, input.code);
    if (!parcel) return problem;
    try {
      const rider = parcel.deliveryRider;
      if (!DELIVERABLE.includes(parcel.status as ParcelStatus) || !rider)
        return { ok: false, outcome: "NOT_WITH_RIDER", message: `${parcel.trackingId} is ${parcelStatusLabel(parcel.status as ParcelStatus).toLowerCase()}; only parcels with a delivery rider can have a failed attempt.`, code: parcel.trackingId };
      let hub: { id: string; name: string } | null = null;
      if (input.nextAction === "RETURN_TO_HUB") {
        const found = await this.hubFor(actor, input.hubId, [parcel.currentHubId, rider.hubId]);
        if (!found.hub) return { ok: false, outcome: "HUB_REQUIRED", message: `${parcel.trackingId}: ${found.problem}`, code: parcel.trackingId };
        hub = found.hub;
      }
      const after = this.workflow.newAfterCommit();
      await this.prisma.$transaction(
        async tx => {
          const current = await this.parcels.loadForUpdate(actor, parcel.trackingId, tx);
          // The rider's failed attempt, entered by the hub desk (re-attempt fees as usual).
          await tx.deliveryAttempt.create({ data: { parcelId: parcel.id, riderId: rider.id, outcome: "FAILED", reason: input.reason, nextAction: input.nextAction, note: input.note } });
          await this.workflow.chargeReattempt(tx, current, actor, meta);
          if (hub)
            await this.workflow.transition(
              tx,
              current,
              {
                to: "AT_HUB",
                actorRole: "rider",
                data: { attemptCount: { increment: 1 }, currentHubId: hub.id, deliveryRiderId: null, deliveryOtpEncrypted: null },
                title: "Returned to hub after failed delivery",
                description: `${input.reason}. The parcel is back at ${hub.name} for another delivery.`,
                location: hub.name,
                internalNote: input.note,
                metadata: { reason: input.reason, hubId: hub.id, deskEntry: true },
              },
              actor,
              meta,
              after,
            );
          else
            await this.workflow.transition(
              tx,
              current,
              {
                to: "RETRY_SCHEDULED",
                actorRole: "rider",
                data: { attemptCount: { increment: 1 } },
                title: "Delivery attempt failed",
                description: `${input.reason}. We'll try to deliver again.`,
                internalNote: input.note,
                metadata: { reason: input.reason, deskEntry: true },
              },
              actor,
              meta,
              after,
            );
          await this.audit.record(actor, { action: "parcel.desk_failed_delivery", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId, riderId: rider.id, reason: input.reason, nextAction: input.nextAction, hubId: hub?.id ?? null } }, meta, tx);
        },
        { timeout: 15_000 },
      );
      await this.workflow.flush(after);
      return {
        ok: true,
        outcome: hub ? "BACK_AT_HUB" : "RETRY_SCHEDULED",
        message: `${parcel.trackingId}: ${input.reason.toLowerCase()} · ${hub ? `back at ${hub.name}` : `stays with ${rider.user.name} for another attempt`}.`,
        code: parcel.trackingId,
      };
    } catch (error) {
      if (error instanceof AppError) return { ok: false, outcome: "REFUSED", message: `${parcel.trackingId}: ${error.message}`, code: parcel.trackingId };
      throw error;
    }
  }

  /** Parcels a rider brings back: after a failed delivery (re-attempt scheduled, or never taken out) or an unfinished return. */
  async receiveBack(actor: Actor, input: z.infer<typeof deskReceiveBackSchema>, meta: RequestMeta) {
    const { parcel, problem } = await this.find(actor, input.code, { anyHub: true });
    if (!parcel) return problem;
    try {
      if (parcel.status === "AT_HUB") return { ok: true, outcome: "ALREADY_RECEIVED", message: `${parcel.trackingId} is already at a hub.`, code: parcel.trackingId };
      if (parcel.status === "OUT_FOR_DELIVERY")
        return { ok: false, outcome: "RECORD_FAILED_FIRST", message: `${parcel.trackingId} is still out for delivery: record the failed attempt on Scan desk → Failed delivery entry ("Back at the hub").`, code: parcel.trackingId };
      const run = parcel.status === "RETURN_SCHEDULED" && parcel.returnRunId ? await this.prisma.returnRun.findUnique({ where: { id: parcel.returnRunId }, select: { number: true, status: true } }) : null;
      const failed = (parcel.status === "RETRY_SCHEDULED" || parcel.status === "ASSIGNED") && !!parcel.deliveryRiderId;
      const unreturned = parcel.status === "RETURN_SCHEDULED" && run?.status === "OUT_FOR_RETURN";
      if (!failed && !unreturned)
        return { ok: false, outcome: "NOT_WITH_RIDER", message: `${parcel.trackingId} is ${parcelStatusLabel(parcel.status as ParcelStatus).toLowerCase()}; it isn't coming back from a rider.`, code: parcel.trackingId };
      const { hub, problem: hubProblem } = await this.hubFor(actor, input.hubId, [parcel.currentHubId, parcel.deliveryRider?.hubId]);
      if (!hub) return { ok: false, outcome: "HUB_REQUIRED", message: `${parcel.trackingId}: ${hubProblem}`, code: parcel.trackingId };
      const after = this.workflow.newAfterCommit();
      await this.prisma.$transaction(
        async tx => {
          const current = await this.parcels.loadForUpdate(actor, parcel.trackingId, tx);
          await this.workflow.transition(
            tx,
            current,
            unreturned
              ? {
                  to: "AT_HUB",
                  actorRole: "ops",
                  data: { returnRunId: null, currentHubId: hub.id },
                  title: "Return not completed",
                  description: `The return couldn't be completed; the parcel is back at ${hub.name}.`,
                  location: hub.name,
                  metadata: { hubId: hub.id, returnRun: run?.number, deskEntry: true },
                }
              : {
                  to: "AT_HUB",
                  actorRole: "ops",
                  data: { currentHubId: hub.id, deliveryRiderId: null, deliveryOtpEncrypted: null },
                  title: "Back at the hub",
                  description: `The rider brought the parcel back to ${hub.name}.`,
                  location: hub.name,
                  metadata: { hubId: hub.id, deskEntry: true },
                },
            actor,
            meta,
            after,
          );
          await this.audit.record(actor, { action: "parcel.desk_receive_back", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId, hubId: hub.id, from: parcel.status, returnRun: run?.number ?? null } }, meta, tx);
        },
        { timeout: 15_000 },
      );
      await this.workflow.flush(after);
      return { ok: true, outcome: "RECEIVED", message: `${parcel.trackingId} received back at ${hub.name}${unreturned ? ` (return run ${run?.number} not completed)` : ""}.`, code: parcel.trackingId };
    } catch (error) {
      if (error instanceof AppError) return { ok: false, outcome: "REFUSED", message: `${parcel.trackingId}: ${error.message}`, code: parcel.trackingId };
      throw error;
    }
  }

  /**
   * A parcel received at this hub goes to another hub: In transit to the hub serving its delivery zone (the collection
   * hub for Hub Pickup), or the hub chosen. Parcels already in a transfer bag travel with the bag.
   */
  async transfer(actor: Actor, input: z.infer<typeof deskTransferSchema>, meta: RequestMeta) {
    const { parcel, problem } = await this.find(actor, input.code, { anyHub: true });
    if (!parcel) return problem;
    try {
      if (parcel.status === "IN_TRANSIT") return { ok: true, outcome: "ALREADY_IN_TRANSIT", message: `${parcel.trackingId} is already on its way to another hub.`, code: parcel.trackingId };
      // Only from a hub of the operator's (hub staff).
      const scope = opsHubScope(actor);
      if (scope && !(parcel.currentHubId && scope.includes(parcel.currentHubId))) return { ok: false, outcome: "OTHER_HUB", message: `${parcel.trackingId} isn't at your hub.`, code: parcel.trackingId };
      if (parcel.status !== "AT_HUB" || !parcel.currentHubId)
        return { ok: false, outcome: "NOT_AT_HUB", message: `${parcel.trackingId} is ${parcelStatusLabel(parcel.status as ParcelStatus, { intake: parcel.intake }).toLowerCase()}; receive it at the hub first.`, code: parcel.trackingId };
      const bag = await this.prisma.linehaulBagItem.findFirst({ where: { parcelId: parcel.id, state: "LOADED", bag: { status: { in: ["OPEN", "SEALED", "IN_TRANSIT"] } } }, select: { bag: { select: { number: true } } } });
      if (bag) return { ok: false, outcome: "IN_BAG", message: `${parcel.trackingId} is in bag ${bag.bag.number}: it goes with the bag (Transfers).`, code: parcel.trackingId };
      let toHubId = input.toHubId ?? null;
      if (!toHubId) {
        if (parcel.lastMile === "HUB_COLLECT" && parcel.collectHubId) toHubId = parcel.collectHubId;
        else if (parcel.deliveryDistrict && parcel.deliveryZone) toHubId = (await resolveZone(this.prisma, { district: parcel.deliveryDistrict, zone: parcel.deliveryZone, area: parcel.deliveryArea }))?.hubId ?? null;
      }
      if (!toHubId)
        return { ok: false, outcome: "NO_DESTINATION", message: `${parcel.trackingId}: no hub serves ${[parcel.deliveryZone, parcel.deliveryDistrict].filter(Boolean).join(", ") || "its delivery area"} yet. Choose the hub to send it to.`, code: parcel.trackingId };
      if (toHubId === parcel.currentHubId)
        return { ok: false, outcome: "DELIVERED_FROM_HERE", message: `${parcel.trackingId} is delivered from this hub: give it to a delivery rider instead.`, code: parcel.trackingId };
      const to = await this.prisma.hub.findUnique({ where: { id: toHubId }, select: { name: true } });
      await this.parcels.setStatus(actor, parcel.trackingId, { status: "IN_TRANSIT", hubId: toHubId, note: undefined }, meta, { code: input.code, source: input.source });
      return { ok: true, outcome: "IN_TRANSIT", message: `${parcel.trackingId} sent to ${to?.name ?? "the hub"} (in transit).`, code: parcel.trackingId };
    } catch (error) {
      if (error instanceof AppError) return { ok: false, outcome: "REFUSED", message: `${parcel.trackingId}: ${error.message}`, code: parcel.trackingId };
      throw error;
    }
  }

  /**
   * The sender took the returned parcel back: Returned (as when a return run is completed: the return charge earned,
   * a franchise rider's return pay). When the run has no parcel left to return, it's completed.
   */
  async returnEntry(actor: Actor, input: z.infer<typeof deskReturnSchema>, meta: RequestMeta) {
    const { parcel, problem } = await this.find(actor, input.code, { anyHub: true });
    if (!parcel) return problem;
    try {
      if (parcel.status === "RETURNED") return { ok: true, outcome: "ALREADY_RETURNED", message: `${parcel.trackingId} is already returned to the sender.`, code: parcel.trackingId };
      if (parcel.status !== "RETURN_SCHEDULED")
        return { ok: false, outcome: "NOT_ON_RETURN", message: `${parcel.trackingId} is ${parcelStatusLabel(parcel.status as ParcelStatus).toLowerCase()}; only parcels scheduled for return can be entered here.`, code: parcel.trackingId };
      const run = parcel.returnRunId ? await this.prisma.returnRun.findUnique({ where: { id: parcel.returnRunId }, select: { id: true, number: true, hubId: true, riderId: true, status: true } }) : null;
      // Hub staff: returns of their hub (the run's hub, or where the parcel is held).
      const scope = opsHubScope(actor);
      if (scope && !(run?.hubId && scope.includes(run.hubId)) && !(parcel.currentHubId && scope.includes(parcel.currentHubId)))
        return { ok: false, outcome: "OTHER_HUB", message: `${parcel.trackingId} is another hub's return.`, code: parcel.trackingId };
      const sender = parcel.merchantId ? ((await this.prisma.merchant.findUnique({ where: { id: parcel.merchantId }, select: { name: true } }))?.name ?? "the sender") : parcel.senderName;
      const after = this.workflow.newAfterCommit();
      let runDone = false;
      await this.prisma.$transaction(
        async tx => {
          const current = await this.parcels.loadForUpdate(actor, parcel.trackingId, tx);
          const returned = await this.workflow.transition(
            tx,
            current,
            {
              to: "RETURNED",
              actorRole: "ops",
              data: { deliveredAt: null },
              description: `Returned to ${sender}${input.receivedBy ? ` (received by ${input.receivedBy})` : ""}.`,
              internalNote: input.note,
              metadata: { returnRunId: run?.id ?? null, deskEntry: true, receivedBy: input.receivedBy ?? null },
            },
            actor,
            meta,
            after,
          );
          const charge = returned.returnCharge == null ? 0 : Number(returned.returnCharge);
          if (charge > 0)
            await this.ledger.record(tx, { type: "DELIVERY_CHARGE_EARNED", amount: charge, reference: `${returned.trackingId}:return`, merchantId: returned.merchantId, hubId: run?.hubId ?? returned.currentHubId, memo: "Return charge" });
          if (run?.riderId) await recordFranchiseReturn(tx, this.ledger, { riderId: run.riderId, parcel: returned });
          // The run's last parcel: the run is completed.
          if (run && run.status !== "COMPLETED" && run.status !== "CANCELLED" && !(await tx.parcel.count({ where: { returnRunId: run.id, status: "RETURN_SCHEDULED" } }))) {
            await tx.returnRun.update({ where: { id: run.id }, data: { status: "COMPLETED", completedAt: new Date() } });
            runDone = true;
          }
          await this.audit.record(actor, { action: "parcel.desk_return", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId, returnRun: run?.number ?? null, receivedBy: input.receivedBy ?? null, runCompleted: runDone } }, meta, tx);
        },
        { timeout: 15_000 },
      );
      await this.workflow.flush(after);
      return { ok: true, outcome: "RETURNED", message: `${parcel.trackingId} returned to ${sender}${runDone ? ` · return run ${run!.number} completed` : ""}.`, code: parcel.trackingId };
    } catch (error) {
      if (error instanceof AppError) return { ok: false, outcome: "REFUSED", message: `${parcel.trackingId}: ${error.message}`, code: parcel.trackingId };
      throw error;
    }
  }

  async dispatch(actor: Actor, input: z.infer<typeof deskDispatchSchema>, meta: RequestMeta) {
    const { parcel, problem } = await this.find(actor, input.code);
    if (!parcel) return problem;
    try {
      if (parcel.status === "OUT_FOR_DELIVERY") return { ok: true, outcome: "ALREADY_OUT", message: `${parcel.trackingId} is already out for delivery${parcel.deliveryRider ? ` with ${parcel.deliveryRider.user.name}` : ""}.`, code: parcel.trackingId, parcel: this.summary(parcel) };
      let riderName = parcel.deliveryRider?.user.name ?? null;
      if (parcel.status === "AT_HUB" || (parcel.status === "RETRY_SCHEDULED" && !parcel.deliveryRiderId)) {
        if (!input.riderId) return { ok: false, outcome: "RIDER_REQUIRED", message: `${parcel.trackingId} has no delivery rider yet: choose the rider above, then scan again.`, code: parcel.trackingId };
        await this.parcels.assignDelivery(actor, parcel.trackingId, { riderId: input.riderId, note: undefined }, meta);
        riderName = (await this.prisma.rider.findUnique({ where: { id: input.riderId }, select: { user: { select: { name: true } } } }))?.user.name ?? "the rider";
      } else if (parcel.status !== "ASSIGNED" && parcel.status !== "RETRY_SCHEDULED")
        return { ok: false, outcome: "NOT_READY", message: `${parcel.trackingId} is ${parcelStatusLabel(parcel.status as ParcelStatus).toLowerCase()}; it can't go out for delivery.`, code: parcel.trackingId };
      await this.parcels.setStatus(actor, parcel.trackingId, { status: "OUT_FOR_DELIVERY", note: undefined }, meta, { code: input.code, source: input.source });
      return { ok: true, outcome: "OUT_FOR_DELIVERY", message: `${parcel.trackingId} is out for delivery with ${riderName ?? "the rider"}.`, code: parcel.trackingId, parcel: { ...this.summary(parcel), status: "OUT_FOR_DELIVERY" } };
    } catch (error) {
      if (error instanceof AppError) return { ok: false, outcome: "REFUSED", message: `${parcel.trackingId}: ${error.message}`, code: parcel.trackingId };
      throw error;
    }
  }
}

