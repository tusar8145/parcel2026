import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { RealtimeService } from "../../common/realtime.service";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { Prisma } from "../../generated/prisma/client";
import { cashHubScope } from "../finance/finance.scope";
import { InboxService } from "../notifications/inbox.service";
import type { completeHandoverRequestSchema, handoverRequestSchema, handoverRequestsQuerySchema } from "./rider.schemas";
import { cashHubProblem } from "../parcels/ops-scope";

const include = {
  rider: { select: { id: true, code: true, user: { select: { name: true, phone: true } } } },
  hub: { select: { id: true, code: true, name: true } },
} satisfies Prisma.CashHandoverRequestInclude;
type Row = Prisma.CashHandoverRequestGetPayload<{ include: typeof include }>;

const view = (r: Row) => ({
  id: r.id,
  rider: { id: r.rider.id, code: r.rider.code, name: r.rider.user.name, phone: r.rider.user.phone },
  hub: r.hub,
  amount: Number(r.amount.toFixed(2)),
  collectionIds: r.collectionIds,
  collections: r.collectionIds.length,
  status: r.status,
  note: r.note,
  handoverId: r.handoverId,
  createdAt: r.createdAt,
  completedAt: r.completedAt,
  cancelledAt: r.cancelledAt,
});

/**
 * A rider asks a hub to receive their COD cash. Hub staff receive it through the finance
 * module's POST /cod/handovers (riderId, hubId, collectionIds, amountReceived from the
 * request), then link it with POST /cod/handover-requests/:id/complete. A request whose
 * collections were all handed over is also completed automatically when it is next read.
 */
@Injectable()
export class HandoverRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  @Inject(InboxService) private readonly inbox!: InboxService;

  /** Requests all of the rider's cash (GET /rider/cash) that isn't already in a pending request. */
  async create(actor: UserActor, input: z.infer<typeof handoverRequestSchema>, meta: RequestMeta) {
    if (!actor.riderId) throw forbidden("Only riders can request a cash handover");
    const riderId = actor.riderId;
    const request = await this.prisma.$transaction(async tx => {
      const hub = await tx.hub.findUnique({ where: { id: input.hubId } });
      if (!hub || !hub.active) throw notFound("Hub");
      const me = await tx.rider.findUniqueOrThrow({ where: { id: riderId }, select: { hubId: true, hub: { select: { type: true, name: true } } } });
      const problem = cashHubProblem(me, hub);
      if (problem) throw new AppError("WRONG_CASH_HUB", problem, HttpStatus.UNPROCESSABLE_ENTITY);
      // One pending request per rider: serialises concurrent taps.
      await tx.$queryRaw`SELECT id FROM riders WHERE id = ${riderId}::uuid FOR UPDATE`;
      const pending = await tx.cashHandoverRequest.findFirst({ where: { riderId, status: "PENDING" }, include });
      if (pending) throw new AppError("HANDOVER_ALREADY_REQUESTED", `You already asked ${pending.hub.name} to receive ৳${pending.amount.toFixed(2)}`, HttpStatus.CONFLICT, { requestId: pending.id });
      const collections = await tx.codCollection.findMany({ where: { riderId, state: "WITH_RIDER", handoverId: null }, select: { id: true, amount: true } });
      if (!collections.length) throw new AppError("NO_CASH_TO_HAND_OVER", "You have no COD cash to hand over", HttpStatus.UNPROCESSABLE_ENTITY);
      const amount = collections.reduce((a, c) => a.plus(c.amount), new Prisma.Decimal(0));
      const row = await tx.cashHandoverRequest.create({ data: { riderId, hubId: hub.id, amount, collectionIds: collections.map(c => c.id), note: input.note }, include });
      await this.audit.record(actor, { action: "cod.handover_request.create", entityType: "cash_handover_request", entityId: row.id, data: { hubId: hub.id, amount: amount.toFixed(2), collections: collections.length } }, meta, tx);
      // The hub's operators: cash to receive (Courier Operations › COD & settlement).
      // A franchise hub's riders hand cash to the franchise (its panel › Money).
      const franchiseHub = hub.type === "FRANCHISE";
      await this.inbox.toStaff(
        tx,
        { roles: [franchiseHub ? "FRANCHISE" : "HUB_OPERATOR"], hubIds: [hub.id] },
        {
          type: "staff.cash_handover",
          title: `Cash handover: ${row.rider.user.name}`,
          body: `Tk ${amount.toFixed(2)} · ${collections.length} COD collection${collections.length === 1 ? "" : "s"} · ${hub.name}`,
          target: { page: franchiseHub ? "money" : "cod-and-settlement" },
          panel: franchiseHub ? "/franchise" : "/courier-operation",
        },
      );
      return row;
    });
    this.publish(request);
    return view(request);
  }

  async mine(actor: UserActor) {
    if (!actor.riderId) throw forbidden();
    await this.reconcile({ riderId: actor.riderId });
    const rows = await this.prisma.cashHandoverRequest.findMany({ where: { riderId: actor.riderId }, include, orderBy: { createdAt: "desc" }, take: 20 });
    return rows.map(view);
  }

  async cancelMine(actor: UserActor, id: string, meta: RequestMeta) {
    const row = await this.prisma.cashHandoverRequest.findUnique({ where: { id } });
    if (!row || row.riderId !== actor.riderId) throw notFound("Handover request");
    return this.cancel(actor, row.id, meta);
  }

  /** Hub staff: requests at their hubs (all hubs for network-wide cash roles). */
  async list(actor: Actor, query: z.infer<typeof handoverRequestsQuerySchema>) {
    const scope = cashHubScope(actor);
    if (query.hubId && scope && !scope.includes(query.hubId)) throw forbidden("You can only view cash at your own hub");
    const hubFilter = query.hubId ? { hubId: query.hubId } : scope ? { hubId: { in: scope } } : {};
    await this.reconcile(hubFilter);
    const rows = await this.prisma.cashHandoverRequest.findMany({
      where: { ...hubFilter, status: query.status ?? "PENDING" },
      include,
      orderBy: { createdAt: query.status && query.status !== "PENDING" ? "desc" : "asc" },
      take: 200,
    });
    return rows.map(view);
  }

  /** Links the handover hub staff recorded with POST /cod/handovers and closes the request. */
  async complete(actor: UserActor, id: string, input: z.infer<typeof completeHandoverRequestSchema>, meta: RequestMeta) {
    const row = await this.prisma.$transaction(async tx => {
      const request = await tx.cashHandoverRequest.findUnique({ where: { id } });
      if (!request) throw notFound("Handover request");
      const scope = cashHubScope(actor);
      if (scope && !scope.includes(request.hubId)) throw notFound("Handover request");
      if (request.status !== "PENDING") throw conflict("HANDOVER_REQUEST_CLOSED", `This request is already ${request.status.toLowerCase()}`);
      const handover = await tx.cashHandover.findUnique({ where: { id: input.handoverId }, include: { collections: { select: { id: true } }, request: { select: { id: true } } } });
      if (!handover) throw notFound("Handover");
      if (handover.request && handover.request.id !== id) throw conflict("HANDOVER_ALREADY_LINKED", "That handover completes another request");
      if (handover.riderId !== request.riderId) throw new AppError("HANDOVER_MISMATCH", "That handover is for a different rider", HttpStatus.UNPROCESSABLE_ENTITY);
      const received = new Set(handover.collections.map(c => c.id));
      const missing = request.collectionIds.filter(c => !received.has(c));
      if (missing.length) throw new AppError("HANDOVER_MISMATCH", "That handover doesn't include all of the requested collections", HttpStatus.UNPROCESSABLE_ENTITY, { missing });
      const { count } = await tx.cashHandoverRequest.updateMany({ where: { id, status: "PENDING" }, data: { status: "COMPLETED", handoverId: handover.id, completedAt: new Date() } });
      if (!count) throw conflict("HANDOVER_REQUEST_CLOSED", "This request was just closed by someone else");
      await this.audit.record(actor, { action: "cod.handover_request.complete", entityType: "cash_handover_request", entityId: id, data: { handoverId: handover.id } }, meta, tx);
      return tx.cashHandoverRequest.findUniqueOrThrow({ where: { id }, include });
    });
    this.publish(row);
    return view(row);
  }

  /** Hub staff or the rider withdraw a pending request. */
  async cancel(actor: Actor, id: string, meta: RequestMeta) {
    const request = await this.prisma.cashHandoverRequest.findUnique({ where: { id } });
    if (!request) throw notFound("Handover request");
    const isRider = actor.kind === "user" && actor.riderId === request.riderId;
    const scope = cashHubScope(actor);
    if (!isRider && (!actor.permissions.has("cod:receive") || (scope && !scope.includes(request.hubId)))) throw notFound("Handover request");
    const { count } = await this.prisma.cashHandoverRequest.updateMany({ where: { id, status: "PENDING" }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    if (!count) throw conflict("HANDOVER_REQUEST_CLOSED", `This request is already ${request.status.toLowerCase()}`);
    await this.audit.record(actor, { action: "cod.handover_request.cancel", entityType: "cash_handover_request", entityId: id }, meta);
    const row = await this.prisma.cashHandoverRequest.findUniqueOrThrow({ where: { id }, include });
    this.publish(row);
    return view(row);
  }

  /**
   * Completes pending requests whose collections were all handed over (e.g. received through
   * the regular COD screen without linking the request).
   */
  private async reconcile(where: Prisma.CashHandoverRequestWhereInput) {
    const pending = await this.prisma.cashHandoverRequest.findMany({ where: { ...where, status: "PENDING" }, select: { id: true, collectionIds: true } });
    for (const request of pending) {
      const rows = await this.prisma.codCollection.findMany({ where: { id: { in: request.collectionIds } }, select: { handoverId: true, state: true } });
      const handovers = new Set(rows.map(r => r.handoverId));
      if (rows.length !== request.collectionIds.length || rows.some(r => r.state === "WITH_RIDER" || !r.handoverId)) continue;
      // Linked only when one handover covered the request; otherwise just closed.
      const handoverId = handovers.size === 1 ? [...handovers][0]! : null;
      const taken = handoverId ? await this.prisma.cashHandoverRequest.findUnique({ where: { handoverId } }) : null;
      await this.prisma.cashHandoverRequest.updateMany({
        where: { id: request.id, status: "PENDING" },
        data: { status: "COMPLETED", completedAt: new Date(), handoverId: taken ? null : handoverId },
      });
    }
  }

  private publish(r: Row) {
    this.realtime.publish({ type: "cod.handover_request", id: r.id, riderIds: [r.riderId], hubIds: [r.hubId], staffPermission: "cod:receive", data: { status: r.status } });
  }
}
