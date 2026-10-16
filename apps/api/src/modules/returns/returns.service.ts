import { HttpStatus, Injectable } from "@nestjs/common";
import { z } from "zod";
import { TERMINAL_STATUSES, type ParcelStatus } from "@delivery-fast/shared";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { RealtimeService } from "../../common/realtime.service";
import { nextNumber } from "../../common/counters";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import { pageArgs, pageQuerySchema, toPage } from "../../common/pagination";
import { actorLabel, merchantIdsOf, type Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { Parcel, Prisma, ReturnRun } from "../../generated/prisma/client";
import { WebhooksService } from "../notifications/webhooks.service";
import { LedgerService } from "../finance/ledger.service";
import { ParcelWorkflowService, parcelEvent, type AfterCommit } from "../parcels/parcel-workflow.service";
import { opsHubScope } from "../parcels/ops-scope";
import { returnChargeFor } from "./return-charge";

/** Standard reasons (free text is also accepted). */
export const RETURN_REASONS = [
  "Recipient refused",
  "Recipient unreachable",
  "Wrong or incomplete address",
  "Recipient asked to cancel",
  "Damaged in transit",
  "Merchant cancelled the order",
  "Delivery attempts exhausted",
] as const;

/** Statuses from which a merchant may ask for a return (picked up, not delivered yet). */
const RETURNABLE: ParcelStatus[] = ["PICKED_UP", "AT_HUB", "IN_TRANSIT", "ASSIGNED", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "EXCEPTION"];
/** Statuses operations can put on a return run (the parcel is held by operations). */
const SCHEDULABLE: ParcelStatus[] = ["AT_HUB", "RETRY_SCHEDULED", "EXCEPTION"];

const reason = z.string().trim().min(3, "Enter the reason (at least 3 characters)").max(300, "Use at most 300 characters");
export const returnRequestSchema = z.object({ reason });
export const listReturnsQuerySchema = pageQuerySchema.extend({
  /** requested: asked for, not yet on a run · scheduled: on a run · returned: back with the merchant · received: merchant confirmed. */
  stage: z.enum(["requested", "scheduled", "returned", "received", "all"]).default("all"),
  merchantId: z.uuid().optional(),
  q: z.string().trim().max(60).optional(),
});
export const createReturnRunSchema = z.object({
  merchantId: z.uuid("Choose the merchant"),
  trackingIds: z.array(z.string().trim().min(4).max(40)).min(1, "Choose at least one parcel").max(200, "At most 200 parcels per run"),
  hubId: z.uuid().optional(),
  riderId: z.uuid().optional(),
  /** Used for parcels that have no return reason yet. */
  reason: reason.optional(),
  note: z.string().trim().max(500).optional(),
});
export const dispatchReturnRunSchema = z.object({ riderId: z.uuid().optional() });
export const completeReturnRunSchema = z.object({
  /** Parcels the merchant did not take back (they go back to the hub). Everything else is returned. */
  notReturned: z.array(z.string().trim().min(4).max(40)).max(200).default([]),
  note: z.string().trim().max(500).optional(),
});
export const listReturnRunsQuerySchema = pageQuerySchema.extend({
  status: z.enum(["PLANNED", "OUT_FOR_RETURN", "COMPLETED", "CANCELLED"]).optional(),
  merchantId: z.uuid().optional(),
});

const returnParcelSelect = {
  id: true,
  trackingId: true,
  merchantOrderRef: true,
  status: true,
  recipientName: true,
  recipientPhone: true,
  deliveryZone: true,
  deliveryDistrict: true,
  codAmount: true,
  totalCharge: true,
  attemptCount: true,
  returnReason: true,
  returnRequestedAt: true,
  returnRequestedBy: true,
  returnCharge: true,
  returnReceivedAt: true,
  returnRunId: true,
  updatedAt: true,
  merchant: { select: { id: true, code: true, name: true } },
  currentHub: { select: { id: true, code: true, name: true } },
  returnRun: { select: { id: true, number: true, status: true } },
} satisfies Prisma.ParcelSelect;
type ReturnParcel = Prisma.ParcelGetPayload<{ select: typeof returnParcelSelect }>;

const returnView = (p: ReturnParcel) => ({
  trackingId: p.trackingId,
  merchantOrderRef: p.merchantOrderRef,
  status: p.status,
  stage: p.returnReceivedAt ? "received" : p.status === "RETURNED" ? "returned" : p.status === "RETURN_SCHEDULED" ? "scheduled" : "requested",
  recipientName: p.recipientName,
  recipientPhone: p.recipientPhone,
  deliveryZone: p.deliveryZone,
  deliveryDistrict: p.deliveryDistrict,
  codAmount: Number(p.codAmount),
  totalCharge: Number(p.totalCharge),
  attemptCount: p.attemptCount,
  reason: p.returnReason,
  requestedAt: p.returnRequestedAt,
  requestedBy: p.returnRequestedBy,
  returnCharge: p.returnCharge == null ? null : Number(p.returnCharge),
  receivedAt: p.returnReceivedAt,
  merchant: p.merchant,
  hub: p.currentHub,
  run: p.returnRun,
  updatedAt: p.updatedAt,
});

const runInclude = {
  merchant: { select: { id: true, code: true, name: true, pickupAddress: true, pickupArea: true, pickupDistrict: true, contactPhone: true } },
  parcels: { select: returnParcelSelect, orderBy: { trackingId: "asc" } },
} satisfies Prisma.ReturnRunInclude;
type RunWithParcels = Prisma.ReturnRunGetPayload<{ include: typeof runInclude }>;

const runView = (r: RunWithParcels | (ReturnRun & { merchant: RunWithParcels["merchant"]; _count?: { parcels: number } })) => ({
  id: r.id,
  number: r.number,
  status: r.status,
  merchant: r.merchant,
  hubId: r.hubId,
  riderId: r.riderId,
  note: r.note,
  createdAt: r.createdAt,
  dispatchedAt: r.dispatchedAt,
  completedAt: r.completedAt,
  parcelCount: "parcels" in r ? r.parcels.length : (r._count?.parcels ?? 0),
  ...("parcels" in r ? { parcels: r.parcels.map(returnView), returnCharges: r.parcels.reduce((a, p) => a + Number(p.returnCharge ?? 0), 0) } : {}),
});

const isStaff = (actor: Actor) => actor.permissions.has("parcel:read:any");

/**
 * Return to merchant (RTO). Merchants ask for a return of a parcel that can't be delivered;
 * operations put returnable parcels on a return run (RETURN_SCHEDULED, with the return charge
 * from the rate card's returnPercent), take them back (RETURNED) and the merchant confirms
 * receipt. Status changes go through ParcelWorkflowService (webhooks, SMS, live updates).
 */
@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly workflow: ParcelWorkflowService,
    private readonly webhooks: WebhooksService,
    private readonly ledger: LedgerService,
    private readonly realtime: RealtimeService,
  ) {}

  reasons() {
    return { reasons: RETURN_REASONS };
  }

  private scope(actor: Actor): Prisma.ParcelWhereInput {
    if (isStaff(actor)) return {};
    const merchants = merchantIdsOf(actor);
    return merchants.length ? { merchantId: { in: merchants } } : { id: "00000000-0000-0000-0000-000000000000" };
  }

  private async ownParcel(db: Db, actor: Actor, trackingId: string) {
    const parcel = await db.parcel.findFirst({ where: { AND: [{ trackingId: trackingId.trim().toUpperCase() }, this.scope(actor), { merchantId: { not: null } }] } });
    if (!parcel) throw notFound("Parcel");
    return parcel;
  }

  // ───────────── merchant side ─────────────

  async list(actor: Actor, query: z.infer<typeof listReturnsQuerySchema>) {
    if (query.merchantId && !isStaff(actor) && !merchantIdsOf(actor).includes(query.merchantId)) throw forbidden("You're not a member of this merchant");
    const stageWhere: Record<string, Prisma.ParcelWhereInput> = {
      requested: { returnRequestedAt: { not: null }, status: { in: RETURNABLE } },
      scheduled: { status: "RETURN_SCHEDULED" },
      returned: { status: "RETURNED", returnReceivedAt: null },
      received: { status: "RETURNED", returnReceivedAt: { not: null } },
      all: { OR: [{ returnRequestedAt: { not: null } }, { status: { in: ["RETURN_SCHEDULED", "RETURNED"] } }] },
    };
    const q = query.q?.toUpperCase();
    const rows = await this.prisma.parcel.findMany({
      where: {
        AND: [
          this.scope(actor),
          { merchantId: query.merchantId ?? { not: null } },
          stageWhere[query.stage],
          q ? { OR: [{ trackingId: { contains: q } }, { merchantOrderRef: { contains: query.q, mode: "insensitive" } }, { recipientName: { contains: query.q, mode: "insensitive" } }] } : {},
        ],
      },
      select: returnParcelSelect,
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { items: page.items.map(returnView), nextCursor: page.nextCursor };
  }

  /** The merchant (or operations) asks for the parcel to come back instead of further delivery attempts. */
  async request(actor: Actor, trackingId: string, input: z.infer<typeof returnRequestSchema>, meta: RequestMeta) {
    const after = this.workflow.newAfterCommit();
    const updated = await this.prisma.$transaction(async tx => {
      const parcel = await this.ownParcel(tx, actor, trackingId);
      const status = parcel.status as ParcelStatus;
      if (status === "PENDING_CONFIRMATION" || status === "PICKUP_ASSIGNED" || status === "PICKUP_CONFIRMED")
        throw new AppError("NOT_PICKED_UP", "This parcel hasn't been picked up yet. Cancel the pickup instead.", HttpStatus.CONFLICT);
      if (status === "RETURN_SCHEDULED" || status === "RETURNED") throw conflict("RETURN_IN_PROGRESS", "This parcel is already being returned");
      if (TERMINAL_STATUSES.includes(status) || !RETURNABLE.includes(status)) throw conflict("NOT_RETURNABLE", "This parcel can no longer be returned");
      if (parcel.returnRequestedAt) throw conflict("RETURN_ALREADY_REQUESTED", "A return was already requested for this parcel");
      const by = actorLabel(actor);
      const { count } = await tx.parcel.updateMany({
        where: { id: parcel.id, version: parcel.version },
        data: { returnReason: input.reason, returnRequestedAt: new Date(), returnRequestedBy: by, version: { increment: 1 } },
      });
      if (!count) throw conflict("PARCEL_CHANGED", "This parcel was just updated by someone else. Refresh and try again.");
      await tx.trackingEvent.create({
        data: {
          parcelId: parcel.id,
          status: parcel.status,
          title: "Return requested",
          description: `Return to sender requested: ${input.reason}`,
          location: "Delivery Fast",
          actorUserId: actor.kind === "user" ? actor.userId : null,
          actorLabel: by,
        },
      });
      after.webhooks.push(...(await this.webhooks.emit(tx, parcel.merchantId, "shipment.return_requested", { trackingId: parcel.trackingId, merchantOrderRef: parcel.merchantOrderRef, reason: input.reason, at: new Date().toISOString() })));
      await this.audit.record(actor, { action: "parcel.return_request", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId, reason: input.reason } }, meta, tx);
      const fresh = await tx.parcel.findUniqueOrThrow({ where: { id: parcel.id } });
      after.realtime.push({ ...parcelEvent(fresh), staffPermission: "parcel:read:any" });
      return fresh;
    });
    await this.workflow.flush(after);
    return this.one(updated.id);
  }

  /** The merchant confirms the returned parcel reached them. */
  async confirmReceived(actor: Actor, trackingId: string, meta: RequestMeta) {
    const after = this.workflow.newAfterCommit();
    const updated = await this.prisma.$transaction(async tx => {
      const parcel = await this.ownParcel(tx, actor, trackingId);
      if (parcel.status !== "RETURNED") throw conflict("NOT_RETURNED", "Only returned parcels can be confirmed as received");
      if (parcel.returnReceivedAt) return parcel;
      const now = new Date();
      await tx.parcel.update({ where: { id: parcel.id }, data: { returnReceivedAt: now, version: { increment: 1 } } });
      await tx.trackingEvent.create({
        data: {
          parcelId: parcel.id,
          status: "RETURNED",
          title: "Return received",
          description: "The sender confirmed they received the returned parcel.",
          actorUserId: actor.kind === "user" ? actor.userId : null,
          actorLabel: actorLabel(actor),
        },
      });
      after.webhooks.push(...(await this.webhooks.emit(tx, parcel.merchantId, "shipment.return_received", { trackingId: parcel.trackingId, merchantOrderRef: parcel.merchantOrderRef, at: now.toISOString() })));
      await this.audit.record(actor, { action: "parcel.return_received", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId } }, meta, tx);
      const fresh = await tx.parcel.findUniqueOrThrow({ where: { id: parcel.id } });
      after.realtime.push({ ...parcelEvent(fresh), staffPermission: "parcel:read:any" });
      return fresh;
    });
    await this.workflow.flush(after);
    return this.one(updated.id);
  }

  private async one(id: string) {
    return returnView(await this.prisma.parcel.findUniqueOrThrow({ where: { id }, select: returnParcelSelect }));
  }

  // ───────────── operations: return runs ─────────────

  async listRuns(actor: Actor, query: z.infer<typeof listReturnRunsQuerySchema>) {
    const hubs = opsHubScope(actor);
    const rows = await this.prisma.returnRun.findMany({
      where: { status: query.status, merchantId: query.merchantId, ...(hubs ? { hubId: { in: hubs } } : {}) },
      include: { merchant: runInclude.merchant, _count: { select: { parcels: true } } },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { items: page.items.map(r => runView(r)), nextCursor: page.nextCursor };
  }

  async run(actor: Actor, id: string) {
    const run = await this.prisma.returnRun.findUnique({ where: { id }, include: runInclude });
    const hubs = opsHubScope(actor);
    if (!run || (hubs && run.hubId && !hubs.includes(run.hubId))) throw notFound("Return run");
    return runView(run);
  }

  private async rider(db: Db, riderId: string | undefined) {
    if (!riderId) return null;
    const rider = await db.rider.findUnique({ where: { id: riderId }, include: { user: { select: { status: true } } } });
    if (!rider || !rider.active || rider.user.status !== "ACTIVE") throw new AppError("RIDER_UNAVAILABLE", "That rider isn't active", HttpStatus.UNPROCESSABLE_ENTITY);
    return rider;
  }

  /** Plans a run for one merchant: each parcel moves to RETURN_SCHEDULED with its return charge. */
  async createRun(actor: Actor, input: z.infer<typeof createReturnRunSchema>, meta: RequestMeta) {
    const after = this.workflow.newAfterCommit();
    const hubs = opsHubScope(actor);
    if (hubs && input.hubId && !hubs.includes(input.hubId)) throw forbidden("You can only plan return runs for your own hub");
    const id = await this.prisma.$transaction(
      async tx => {
        const merchant = await tx.merchant.findUnique({ where: { id: input.merchantId }, select: { id: true } });
        if (!merchant) throw notFound("Merchant");
        await this.rider(tx, input.riderId);
        const ids = [...new Set(input.trackingIds.map(t => t.toUpperCase()))];
        const parcels = await tx.parcel.findMany({ where: { trackingId: { in: ids } } });
        const problems: { trackingId: string; message: string }[] = [];
        for (const t of ids) {
          const p = parcels.find(x => x.trackingId === t);
          if (!p) problems.push({ trackingId: t, message: "Not found" });
          else if (p.merchantId !== input.merchantId) problems.push({ trackingId: t, message: "Belongs to another merchant" });
          else if (!SCHEDULABLE.includes(p.status as ParcelStatus)) problems.push({ trackingId: t, message: `Is ${p.status}; only parcels at a hub, awaiting retry or in exception can be returned` });
          else if (!p.returnReason && !input.reason) problems.push({ trackingId: t, message: "Has no return reason; enter one for the run" });
          else if (hubs && p.currentHubId && !hubs.includes(p.currentHubId)) problems.push({ trackingId: t, message: "Is held at another hub" });
        }
        if (problems.length) throw new AppError("PARCELS_NOT_RETURNABLE", `${problems.length} parcel(s) can't go on this run`, HttpStatus.UNPROCESSABLE_ENTITY, { problems });
        const run = await tx.returnRun.create({
          data: {
            number: await nextNumber(tx, "RR"),
            merchantId: input.merchantId,
            hubId: input.hubId ?? parcels.find(p => p.currentHubId)?.currentHubId ?? null,
            riderId: input.riderId,
            note: input.note,
            createdById: actor.kind === "user" ? actor.userId : null,
          },
        });
        for (const parcel of parcels) await this.schedule(tx, actor, parcel, run, input.reason, meta, after);
        await this.audit.record(actor, { action: "return_run.create", entityType: "return_run", entityId: run.id, data: { number: run.number, merchantId: input.merchantId, trackingIds: ids } }, meta, tx);
        return run.id;
      },
      { timeout: 30_000 },
    );
    await this.workflow.flush(after);
    this.publishRun(id, input.merchantId);
    return this.run(actor, id);
  }

  private async schedule(tx: Db, actor: Actor, parcel: Parcel, run: ReturnRun, fallbackReason: string | undefined, meta: RequestMeta, after: AfterCommit) {
    const reasonText = parcel.returnReason ?? fallbackReason!;
    await this.workflow.transition(
      tx,
      parcel,
      {
        to: "RETURN_SCHEDULED",
        actorRole: "ops",
        data: {
          returnRunId: run.id,
          returnReason: reasonText,
          returnRequestedAt: parcel.returnRequestedAt ?? new Date(),
          returnRequestedBy: parcel.returnRequestedBy ?? actorLabel(actor),
          returnCharge: parcel.returnCharge ?? returnChargeFor(parcel),
          deliveryRiderId: null,
        },
        description: `The parcel will be returned to the sender (${reasonText}).`,
        metadata: { returnRunId: run.id, returnRun: run.number },
      },
      actor,
      meta,
      after,
    );
  }

  async dispatchRun(actor: Actor, id: string, input: z.infer<typeof dispatchReturnRunSchema>, meta: RequestMeta) {
    await this.prisma.$transaction(async tx => {
      const run = await this.runForUpdate(tx, actor, id);
      if (run.status !== "PLANNED") throw conflict("RUN_NOT_PLANNED", "Only planned runs can be dispatched");
      const riderId = input.riderId ?? run.riderId;
      if (!riderId) throw new AppError("RIDER_REQUIRED", "Choose the rider taking the parcels back", HttpStatus.UNPROCESSABLE_ENTITY);
      await this.rider(tx, riderId);
      await tx.returnRun.update({ where: { id }, data: { status: "OUT_FOR_RETURN", riderId, dispatchedAt: new Date() } });
      await this.audit.record(actor, { action: "return_run.dispatch", entityType: "return_run", entityId: id, data: { riderId } }, meta, tx);
    });
    const run = await this.run(actor, id);
    this.publishRun(id, run.merchant.id);
    return run;
  }

  /** Marks the run's parcels RETURNED (except those the merchant didn't take back, which go back to the hub). */
  async completeRun(actor: Actor, id: string, input: z.infer<typeof completeReturnRunSchema>, meta: RequestMeta) {
    const after = this.workflow.newAfterCommit();
    let merchantId = "";
    await this.prisma.$transaction(
      async tx => {
        const run = await this.runForUpdate(tx, actor, id);
        merchantId = run.merchantId;
        if (run.status !== "OUT_FOR_RETURN" && run.status !== "PLANNED") throw conflict("RUN_CLOSED", `This run is already ${run.status.toLowerCase()}`);
        const parcels = await tx.parcel.findMany({ where: { returnRunId: id, status: "RETURN_SCHEDULED" } });
        const notReturned = new Set(input.notReturned.map(t => t.toUpperCase()));
        for (const parcel of parcels) {
          if (notReturned.has(parcel.trackingId)) {
            await this.workflow.transition(
              tx,
              parcel,
              { to: "AT_HUB", actorRole: "ops", data: { returnRunId: null }, title: "Return not completed", description: "The return couldn't be completed; the parcel is back at the hub.", internalNote: input.note },
              actor,
              meta,
              after,
            );
            continue;
          }
          const returned = await this.workflow.transition(tx, parcel, { to: "RETURNED", actorRole: "ops", data: { deliveredAt: null }, metadata: { returnRunId: id } }, actor, meta, after);
          const charge = returned.returnCharge == null ? 0 : Number(returned.returnCharge);
          if (charge > 0)
            await this.ledger.record(tx, { type: "DELIVERY_CHARGE_EARNED", amount: charge, reference: `${returned.trackingId}:return`, merchantId: returned.merchantId, hubId: run.hubId, memo: "Return charge" });
        }
        await tx.returnRun.update({ where: { id }, data: { status: "COMPLETED", completedAt: new Date(), note: input.note ?? run.note } });
        await this.audit.record(actor, { action: "return_run.complete", entityType: "return_run", entityId: id, data: { notReturned: [...notReturned] } }, meta, tx);
      },
      { timeout: 30_000 },
    );
    await this.workflow.flush(after);
    this.publishRun(id, merchantId);
    return this.run(actor, id);
  }

  /** Cancels a planned run: its parcels go back to the hub (the return request stays). */
  async cancelRun(actor: Actor, id: string, meta: RequestMeta) {
    const after = this.workflow.newAfterCommit();
    let merchantId = "";
    await this.prisma.$transaction(
      async tx => {
        const run = await this.runForUpdate(tx, actor, id);
        merchantId = run.merchantId;
        if (run.status !== "PLANNED") throw conflict("RUN_NOT_PLANNED", "Only planned runs can be cancelled");
        const parcels = await tx.parcel.findMany({ where: { returnRunId: id, status: "RETURN_SCHEDULED" } });
        for (const parcel of parcels)
          await this.workflow.transition(
            tx,
            parcel,
            { to: "AT_HUB", actorRole: "ops", data: { returnRunId: null }, title: "Return run cancelled", description: "The parcel is back at the hub awaiting the next return run." },
            actor,
            meta,
            after,
          );
        await tx.returnRun.update({ where: { id }, data: { status: "CANCELLED", completedAt: new Date() } });
        await this.audit.record(actor, { action: "return_run.cancel", entityType: "return_run", entityId: id, data: {} }, meta, tx);
      },
      { timeout: 30_000 },
    );
    await this.workflow.flush(after);
    this.publishRun(id, merchantId);
    return this.run(actor, id);
  }

  private async runForUpdate(tx: Db, actor: Actor, id: string) {
    await tx.$executeRaw`SELECT 1 FROM return_runs WHERE id = ${id}::uuid FOR UPDATE`;
    const run = await tx.returnRun.findUnique({ where: { id } });
    const hubs = opsHubScope(actor);
    if (!run || (hubs && run.hubId && !hubs.includes(run.hubId))) throw notFound("Return run");
    return run;
  }

  private publishRun(id: string, merchantId: string) {
    this.realtime.publish({ type: "return_run.updated", id, staffPermission: "parcel:dispatch", data: { merchantId } });
  }
}
