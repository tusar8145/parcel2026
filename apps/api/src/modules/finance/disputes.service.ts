import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { quoteParcel, type RateCardConfig, type ServiceLevel } from "@delivery-fast/shared";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { StorageService } from "../../common/storage.service";
import { RealtimeService } from "../../common/realtime.service";
import { nextNumber } from "../../common/counters";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import { merchantIdsOf, type Actor, type UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { env } from "../../config/env";
import { Prisma, type Dispute, type DisputeStatus } from "../../generated/prisma/client";
import { NotifyService } from "../notifications/notify.service";
import { OutboxService } from "../notifications/outbox.service";
import type { Attachment } from "../support/support.schemas";
import { money } from "./finance.scope";
import { LedgerService, type LedgerVia } from "./ledger.service";
import type { approveDisputeSchema, createDisputeSchema, disputeNoteSchema, listDisputesQuerySchema, rejectDisputeSchema } from "./disputes.schemas";
import { pricedDestination } from "../parcels/incomplete";

const STATUS_LABEL: Record<DisputeStatus, string> = { OPEN: "Received", UNDER_REVIEW: "Under review", APPROVED: "Approved", REJECTED: "Rejected" };
const KIND_LABEL: Record<string, string> = { DAMAGED: "Damaged parcel", LOST: "Lost parcel", OVERCHARGE: "Overcharge", WEIGHT_DISCREPANCY: "Weight discrepancy", OTHER: "Other" };
const EXTENSIONS: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "application/pdf": ".pdf" };

/** Finance and support staff work disputes; only finance approves money. */
export const isDisputeStaff = (actor: Actor) => actor.permissions.has("finance:manage") || actor.permissions.has("support:manage");

const disputeInclude = {
  parcel: { select: { id: true, trackingId: true, weightKg: true, totalCharge: true, declaredValue: true, codAmount: true, status: true } },
  merchant: { select: { id: true, code: true, name: true } },
  evidence: { select: { id: true, filename: true, mimeType: true, sizeBytes: true, messageId: true, createdAt: true }, orderBy: { createdAt: "asc" } },
} satisfies Prisma.DisputeInclude;
type DisputeRow = Prisma.DisputeGetPayload<{ include: typeof disputeInclude }>;

type ParcelForPricing = {
  pickupDistrict: string;
  pickupZone: string;
  deliveryDistrict: string | null;
  deliveryZone: string | null;
  serviceLevel: string;
  codAmount: Prisma.Decimal;
  type: string;
  documentType: string | null;
  totalCharge: Prisma.Decimal;
  pricingSnapshot: Prisma.JsonValue;
};

/** Re-prices a parcel with another weight using the rate card frozen on it at booking. */
export function repriceWithWeight(p: ParcelForPricing, weightKg: number) {
  const snap = (p.pricingSnapshot ?? {}) as { config?: RateCardConfig; discountPercent?: number; origin?: { district: string; zone: string } };
  if (!snap.config) throw new AppError("CANNOT_REPRICE", "This parcel has no pricing snapshot to re-price with", HttpStatus.UNPROCESSABLE_ENTITY);
  const q = quoteParcel(snap.config, {
    // Hub drop-offs were priced from the hub (pricingSnapshot.origin), not the pickup address.
    pickupDistrict: snap.origin?.district ?? p.pickupDistrict,
    pickupZone: snap.origin?.zone ?? p.pickupZone,
    // Incomplete orders were priced to a default destination (pricingSnapshot.destination).
    deliveryDistrict: pricedDestination(p).district,
    deliveryZone: pricedDestination(p).zone,
    weightKg,
    serviceLevel: p.serviceLevel as ServiceLevel,
    codAmount: Number(p.codAmount),
    discountPercent: snap.discountPercent,
    parcelType: p.type,
    documentType: p.documentType ?? undefined,
  });
  return new Prisma.Decimal(q.totalCharge);
}

/**
 * Refunds, claims and weight discrepancies. Customers and merchants raise them on their own
 * parcels (staff on any, e.g. a hub re-weighing a parcel); finance / support review; finance
 * approves (money moves: ledger REFUND_PAID / CLAIM_PAID / ADJUSTMENT, merchant balance
 * adjustments applied to the next settlement) or rejects. The raiser is notified at each step.
 */
@Injectable()
export class DisputesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly ledger: LedgerService,
    private readonly notify: NotifyService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
  ) {}

  async create(actor: UserActor, input: z.infer<typeof createDisputeSchema>, meta: RequestMeta) {
    const { number, outboxIds } = await this.prisma.$transaction(
      async tx => {
        const parcel = await tx.parcel.findFirst({ where: { AND: [{ trackingId: input.trackingId }, this.parcelScope(actor)] } });
        if (!parcel) throw new AppError("UNKNOWN_PARCEL", `We couldn't find parcel ${input.trackingId} on your account`, HttpStatus.UNPROCESSABLE_ENTITY);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`dispute:${parcel.id}:${input.kind}`}))`;
        const open = await tx.dispute.findFirst({ where: { parcelId: parcel.id, kind: input.kind, status: { in: ["OPEN", "UNDER_REVIEW"] } }, select: { number: true } });
        if (open) throw conflict("DISPUTE_EXISTS", `Dispute ${open.number} about this parcel is already being reviewed`);
        if (input.kind === "LOST" && parcel.status === "DELIVERED") throw new AppError("PARCEL_DELIVERED", "This parcel was delivered; raise a damaged-parcel claim instead", HttpStatus.UNPROCESSABLE_ENTITY);

        const weight =
          input.kind === "WEIGHT_DISCREPANCY"
            ? { bookedWeightKg: parcel.weightKg, actualWeightKg: new Prisma.Decimal(input.actualWeightKg!), originalCharge: parcel.totalCharge, repricedCharge: repriceWithWeight(parcel, input.actualWeightKg!) }
            : {};
        const dispute = await tx.dispute.create({
          data: {
            number: await nextNumber(tx, "DSP"),
            kind: input.kind,
            parcelId: parcel.id,
            merchantId: parcel.merchantId,
            raisedById: actor.userId,
            description: input.description,
            claimedAmount: input.claimedAmount,
            ...weight,
          },
        });
        await this.saveEvidence(actor, dispute.id, dispute.number, input.evidence, tx);
        await this.audit.record(
          actor,
          { action: "dispute.create", entityType: "dispute", entityId: dispute.id, data: { number: dispute.number, kind: input.kind, trackingId: parcel.trackingId, claimedAmount: input.claimedAmount?.toFixed(2) ?? null, actualWeightKg: input.actualWeightKg ?? null, evidence: input.evidence.length } },
          meta,
          tx,
        );
        const outboxIds = await this.notifyRaiser(tx, dispute, parcel.trackingId, "We received your claim and will review it shortly.");
        return { number: dispute.number, outboxIds };
      },
      { timeout: 15_000 },
    );
    await this.outbox.flush(outboxIds);
    return this.detail(actor, number);
  }

  async list(actor: UserActor, query: z.infer<typeof listDisputesQuerySchema>) {
    const rows = await this.prisma.dispute.findMany({
      where: {
        AND: [
          this.scope(actor),
          {
            status: query.status,
            kind: query.kind,
            merchantId: query.merchantId,
            ...(query.q ? { OR: [{ number: { contains: query.q, mode: "insensitive" } }, { parcel: { trackingId: { contains: query.q, mode: "insensitive" } } }] } : {}),
          },
        ],
      },
      include: disputeInclude,
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { nextCursor: page.nextCursor, items: page.items.map(d => this.view(d)) };
  }

  async detail(actor: UserActor, number: string) {
    const d = await this.prisma.dispute.findFirst({ where: { AND: [{ number: number.toUpperCase() }, this.scope(actor)] }, include: disputeInclude });
    if (!d) throw notFound("Dispute");
    const staff = isDisputeStaff(actor);
    const notes = await this.prisma.disputeNote.findMany({ where: { disputeId: d.id, ...(staff ? {} : { internal: false }) }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const people = await this.prisma.user.findMany({ where: { id: { in: [d.raisedById, d.reviewerId, d.resolvedById].filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    const person = (id: string | null) => (id ? (people.find(p => p.id === id) ?? null) : null);
    return {
      ...this.view(d),
      raisedBy: person(d.raisedById),
      reviewer: person(d.reviewerId),
      resolvedBy: person(d.resolvedById),
      notes: notes.map(n => ({ id: n.id, author: { id: n.authorId, label: n.authorLabel }, body: n.body, internal: n.internal, createdAt: n.createdAt })),
    };
  }

  async addNote(actor: UserActor, number: string, input: z.infer<typeof disputeNoteSchema>, meta: RequestMeta) {
    const staff = isDisputeStaff(actor);
    if (input.internal && !staff) throw forbidden("Only staff can add internal notes");
    await this.prisma.$transaction(async tx => {
      const d = await this.lock(actor, number, tx);
      if (d.status === "APPROVED" || d.status === "REJECTED") throw conflict("DISPUTE_CLOSED", "This dispute has been decided");
      const note = await tx.disputeNote.create({ data: { disputeId: d.id, authorId: actor.userId, authorLabel: actor.name, body: input.body, internal: input.internal } });
      await this.saveEvidence(actor, d.id, d.number, input.evidence, tx);
      await tx.dispute.update({ where: { id: d.id }, data: { updatedAt: new Date() } });
      await this.audit.record(actor, { action: "dispute.note", entityType: "dispute", entityId: d.id, data: { noteId: note.id, internal: input.internal, evidence: input.evidence.length } }, meta, tx);
    });
    this.publish(number);
    return this.detail(actor, number);
  }

  /** OPEN → UNDER_REVIEW, taken by the reviewer. */
  async review(actor: UserActor, number: string, meta: RequestMeta) {
    const outboxIds = await this.prisma.$transaction(async tx => {
      const d = await this.lock(actor, number, tx);
      if (d.status !== "OPEN") throw conflict("DISPUTE_NOT_OPEN", "Only new disputes can be taken for review");
      const updated = await tx.dispute.update({ where: { id: d.id }, data: { status: "UNDER_REVIEW", reviewerId: actor.userId } });
      await this.audit.record(actor, { action: "dispute.review", entityType: "dispute", entityId: d.id, data: { number: d.number } }, meta, tx);
      const parcel = await tx.parcel.findUniqueOrThrow({ where: { id: d.parcelId }, select: { trackingId: true } });
      return this.notifyRaiser(tx, updated, parcel.trackingId);
    });
    await this.outbox.flush(outboxIds);
    this.publish(number);
    return this.detail(actor, number);
  }

  async approve(actor: UserActor, number: string, input: z.infer<typeof approveDisputeSchema>, meta: RequestMeta) {
    if (!actor.permissions.has("finance:manage")) throw forbidden("Only finance can approve refunds and claims");
    const outboxIds = await this.prisma.$transaction(
      async tx => {
        const d = await this.lock(actor, number, tx);
        if (d.status !== "OPEN" && d.status !== "UNDER_REVIEW") throw conflict("DISPUTE_CLOSED", "This dispute has already been decided");
        const parcel = await tx.parcel.findUniqueOrThrow({ where: { id: d.parcelId } });
        const now = new Date();
        const data: Prisma.DisputeUncheckedUpdateInput = { status: "APPROVED", resolution: input.resolution, resolvedById: actor.userId, resolvedAt: now, reviewerId: d.reviewerId ?? actor.userId };
        let details: string;

        if (d.kind === "WEIGHT_DISCREPANCY") {
          const actual = input.actualWeightKg ?? Number(d.actualWeightKg);
          const repriced = repriceWithWeight(parcel, actual);
          const diff = repriced.minus(parcel.totalCharge);
          Object.assign(data, { actualWeightKg: new Prisma.Decimal(actual), repricedCharge: repriced, approvedAmount: diff.abs() });
          if (diff.isZero()) details = "The re-priced charge is the same; no adjustment.";
          else if (parcel.merchantId) {
            // Merchant parcels: the difference goes through their balance (next settlement).
            await tx.merchantAdjustment.create({
              data: { merchantId: parcel.merchantId, kind: "WEIGHT_ADJUSTMENT", amount: diff, description: `${parcel.trackingId} re-priced at ${actual} kg (was ${parcel.weightKg} kg)`, reference: d.number, disputeId: d.id, createdById: actor.userId },
            });
            await this.ledger.record(tx, { type: "ADJUSTMENT", amount: diff, reference: d.number, merchantId: parcel.merchantId, occurredAt: now, memo: `Weight re-pricing ${parcel.trackingId}`, createdById: actor.userId });
            Object.assign(data, { payout: "MERCHANT_BALANCE" });
            details = diff.gt(0) ? `Tk ${diff.toFixed(2)} will be deducted from your next settlement.` : `Tk ${diff.abs().toFixed(2)} will be added to your next settlement.`;
          } else {
            if (diff.gt(0)) throw new AppError("CANNOT_CHARGE_CUSTOMER", "Customer parcels can't be charged more after delivery; reject or settle it another way", HttpStatus.UNPROCESSABLE_ENTITY);
            const payout = this.payoutFor(input, null);
            await this.ledger.record(tx, { type: "REFUND_PAID", amount: diff.abs(), reference: d.number, via: payout, hubId: parcel.currentHubId, occurredAt: now, memo: `Weight refund ${parcel.trackingId} ${input.payoutReference ?? ""}`.trim(), createdById: actor.userId });
            Object.assign(data, { payout, payoutReference: input.payoutReference });
            details = `Tk ${diff.abs().toFixed(2)} refunded${input.payoutReference ? ` (ref ${input.payoutReference})` : ""}.`;
          }
        } else {
          const amount = input.approvedAmount ?? d.claimedAmount;
          if (!amount) throw new AppError("AMOUNT_REQUIRED", "Enter the approved amount", HttpStatus.UNPROCESSABLE_ENTITY);
          if ((d.kind === "DAMAGED" || d.kind === "LOST") && parcel.declaredValue && amount.greaterThan(parcel.declaredValue.plus(parcel.totalCharge)))
            throw new AppError("ABOVE_LIABILITY", `Claims are limited to the declared value plus the delivery charge (৳${parcel.declaredValue.plus(parcel.totalCharge).toFixed(2)})`, HttpStatus.UNPROCESSABLE_ENTITY);
          const payout = this.payoutFor(input, d.merchantId);
          const type = d.kind === "OVERCHARGE" ? "REFUND_PAID" : "CLAIM_PAID";
          if (payout === "MERCHANT_BALANCE") {
            await tx.merchantAdjustment.create({
              data: { merchantId: d.merchantId!, kind: type === "REFUND_PAID" ? "REFUND" : "CLAIM", amount: amount.negated(), description: `${KIND_LABEL[d.kind]} ${parcel.trackingId} (${d.number})`, reference: d.number, disputeId: d.id, createdById: actor.userId },
            });
          }
          await this.ledger.record(tx, { type, amount, reference: d.number, merchantId: d.merchantId, hubId: parcel.currentHubId, via: payout, occurredAt: now, memo: `${KIND_LABEL[d.kind]} ${parcel.trackingId}`, createdById: actor.userId });
          Object.assign(data, { approvedAmount: amount, payout, payoutReference: input.payoutReference });
          details = payout === "MERCHANT_BALANCE" ? `Tk ${amount.toFixed(2)} will be added to your next settlement.` : `Tk ${amount.toFixed(2)} paid by ${payout === "BKASH" ? "bKash" : payout.toLowerCase()} (ref ${input.payoutReference}).`;
        }

        const updated = await tx.dispute.update({ where: { id: d.id }, data });
        await this.audit.record(
          actor,
          { action: "dispute.approve", entityType: "dispute", entityId: d.id, data: { number: d.number, approvedAmount: updated.approvedAmount?.toFixed(2) ?? null, payout: updated.payout, payoutReference: updated.payoutReference, resolution: input.resolution } },
          meta,
          tx,
        );
        return this.notifyRaiser(tx, updated, parcel.trackingId, details);
      },
      { timeout: 15_000 },
    );
    await this.outbox.flush(outboxIds);
    this.publish(number);
    return this.detail(actor, number);
  }

  async reject(actor: UserActor, number: string, input: z.infer<typeof rejectDisputeSchema>, meta: RequestMeta) {
    if (!actor.permissions.has("finance:manage")) throw forbidden("Only finance can decide refunds and claims");
    const outboxIds = await this.prisma.$transaction(async tx => {
      const d = await this.lock(actor, number, tx);
      if (d.status !== "OPEN" && d.status !== "UNDER_REVIEW") throw conflict("DISPUTE_CLOSED", "This dispute has already been decided");
      const updated = await tx.dispute.update({ where: { id: d.id }, data: { status: "REJECTED", resolution: input.resolution, resolvedById: actor.userId, resolvedAt: new Date(), reviewerId: d.reviewerId ?? actor.userId } });
      await this.audit.record(actor, { action: "dispute.reject", entityType: "dispute", entityId: d.id, data: { number: d.number, resolution: input.resolution } }, meta, tx);
      const parcel = await tx.parcel.findUniqueOrThrow({ where: { id: d.parcelId }, select: { trackingId: true } });
      return this.notifyRaiser(tx, updated, parcel.trackingId, input.resolution);
    });
    await this.outbox.flush(outboxIds);
    this.publish(number);
    return this.detail(actor, number);
  }

  // ───────────── helpers ─────────────

  private payoutFor(input: z.infer<typeof approveDisputeSchema>, merchantId: string | null): LedgerVia {
    const payout = input.payout ?? (merchantId ? "MERCHANT_BALANCE" : undefined);
    if (!payout) throw new AppError("PAYOUT_REQUIRED", "Choose how the money is paid (BANK, BKASH or CASH)", HttpStatus.UNPROCESSABLE_ENTITY);
    if (payout === "MERCHANT_BALANCE" && !merchantId) throw new AppError("NOT_A_MERCHANT_PARCEL", "Only merchant parcels can be credited to a merchant balance", HttpStatus.UNPROCESSABLE_ENTITY);
    if (payout !== "MERCHANT_BALANCE" && !input.payoutReference) throw new AppError("REFERENCE_REQUIRED", "Enter the payment reference", HttpStatus.UNPROCESSABLE_ENTITY);
    return payout;
  }

  /** Customers see disputes on their parcels / ones they raised; merchant owners their merchant's; staff all. */
  private scope(actor: UserActor): Prisma.DisputeWhereInput {
    if (isDisputeStaff(actor)) return {};
    const merchants = merchantIdsOf(actor);
    return { OR: [{ raisedById: actor.userId }, ...(merchants.length ? [{ merchantId: { in: merchants } }] : [])] };
  }

  /** Parcels a dispute may be raised on: staff any; merchants their merchant's; customers their own bookings. */
  private parcelScope(actor: UserActor): Prisma.ParcelWhereInput {
    if (isDisputeStaff(actor) || actor.permissions.has("parcel:read:any")) return {};
    const merchants = merchantIdsOf(actor);
    return { OR: [{ customerId: actor.userId }, ...(merchants.length ? [{ merchantId: { in: merchants } }] : [])] };
  }

  private async lock(actor: UserActor, number: string, tx: Db): Promise<Dispute> {
    const d = await tx.dispute.findFirst({ where: { AND: [{ number: number.toUpperCase() }, this.scope(actor)] }, select: { id: true } });
    if (!d) throw notFound("Dispute");
    await tx.$queryRaw`SELECT id FROM disputes WHERE id = ${d.id}::uuid FOR UPDATE`;
    return tx.dispute.findUniqueOrThrow({ where: { id: d.id } });
  }

  private async saveEvidence(actor: UserActor, disputeId: string, number: string, files: Attachment[], db: Db) {
    for (const [i, a] of files.entries()) {
      const ext = EXTENSIONS[a.dataUrl.slice(5, a.dataUrl.indexOf(";"))] ?? "";
      const file = await this.storage.saveDataUrl(a.dataUrl, a.filename ?? `${number}-evidence-${i + 1}${ext}`, actor.userId, db);
      await db.storedFile.update({ where: { id: file.id }, data: { disputeId } });
    }
  }

  private notifyRaiser(db: Db, d: Dispute, trackingId: string, details?: string) {
    return this.notify.notify(db, {
      event: "finance.dispute_update",
      to: { userId: d.raisedById },
      vars: { number: d.number, trackingId, status: STATUS_LABEL[d.status], details: details ?? "", link: `${env().APP_URL}/#/support` },
    });
  }

  private publish(number: string) {
    this.realtime.publish({ type: "dispute.updated", id: number.toUpperCase(), staffPermission: "finance:read" });
  }

  private view(d: DisputeRow) {
    return {
      id: d.id,
      number: d.number,
      kind: d.kind,
      kindLabel: KIND_LABEL[d.kind],
      status: d.status,
      statusLabel: STATUS_LABEL[d.status],
      parcel: { id: d.parcel.id, trackingId: d.parcel.trackingId, status: d.parcel.status, charge: money(d.parcel.totalCharge), declaredValue: d.parcel.declaredValue ? money(d.parcel.declaredValue) : null },
      merchant: d.merchant,
      description: d.description,
      claimedAmount: d.claimedAmount ? money(d.claimedAmount) : null,
      approvedAmount: d.approvedAmount ? money(d.approvedAmount) : null,
      weight:
        d.kind === "WEIGHT_DISCREPANCY"
          ? {
              bookedKg: d.bookedWeightKg ? Number(d.bookedWeightKg) : null,
              actualKg: d.actualWeightKg ? Number(d.actualWeightKg) : null,
              originalCharge: d.originalCharge ? money(d.originalCharge) : null,
              repricedCharge: d.repricedCharge ? money(d.repricedCharge) : null,
              difference: d.originalCharge && d.repricedCharge ? money(d.repricedCharge.minus(d.originalCharge)) : null,
            }
          : null,
      payout: d.payout,
      payoutReference: d.payoutReference,
      resolution: d.resolution,
      evidence: d.evidence.map(f => ({ id: f.id, filename: f.filename, mimeType: f.mimeType, sizeBytes: f.sizeBytes, url: `/api/v1/files/${f.id}`, createdAt: f.createdAt })),
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      resolvedAt: d.resolvedAt,
    };
  }
}
