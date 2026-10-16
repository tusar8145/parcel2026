import { HttpStatus, Injectable } from "@nestjs/common";
import { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { RealtimeService } from "../../common/realtime.service";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import { pageArgs, pageQuerySchema, toPage } from "../../common/pagination";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { ChangeRequest, ChangeRequestStatus, Prisma } from "../../generated/prisma/client";

/** Pending changes expire after this long. */
const PENDING_DAYS = 7;

/**
 * One kind of sensitive change. `prepare` validates and normalises the request (runs at
 * submission and again right before applying, so stale requests fail cleanly); `apply` makes
 * the change inside the approval transaction; `afterCommit` refreshes caches.
 */
export interface ChangeHandler<P = unknown> {
  kind: string;
  prepare(payload: unknown, db: Db): Promise<P>;
  summary(payload: P): string;
  apply(tx: Db, payload: P, ctx: { actor: Actor; requestedById: string; meta: RequestMeta }): Promise<Prisma.InputJsonValue>;
  afterCommit?(payload: P, result: unknown): Promise<void>;
}

export type SubmitResult =
  | { status: "APPLIED"; result: unknown; approval: "sole_super_admin" }
  | { status: "PENDING"; changeRequest: ReturnType<typeof changeView> };

export const listChangesQuerySchema = pageQuerySchema.extend({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED", "EXPIRED", "FAILED"], "Unknown status").optional(),
});
export const decideChangeSchema = z.object({ note: z.string().trim().max(500, "Use at most 500 characters").optional() });
export const rejectChangeSchema = z.object({ note: z.string().trim().min(3, "Say why the change is rejected").max(500, "Use at most 500 characters") });

export const changeView = (c: ChangeRequest) => ({
  id: c.id,
  kind: c.kind,
  summary: c.summary,
  payload: c.payload,
  status: c.status === "PENDING" && c.expiresAt < new Date() ? ("EXPIRED" as ChangeRequestStatus) : c.status,
  requestedBy: { id: c.requestedById, name: c.requestedByName },
  reviewedBy: c.reviewedById ? { id: c.reviewedById, name: c.reviewedByName } : null,
  reviewNote: c.reviewNote,
  error: c.error,
  result: c.result,
  createdAt: c.createdAt,
  decidedAt: c.decidedAt,
  expiresAt: c.expiresAt,
});

/**
 * Maker-checker for sensitive configuration (rate cards, merchant tariffs, role permissions,
 * custom roles). A change by one administrator waits for a different super admin to approve
 * it. While the platform has only one active super admin, changes apply at once (there is no
 * second person) and the audit log records that.
 */
@Injectable()
export class ApprovalsService {
  private readonly handlers = new Map<string, ChangeHandler<any>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  register<P>(handler: ChangeHandler<P>) {
    this.handlers.set(handler.kind, handler);
  }

  /** Whether a change by this actor must wait for another super admin. */
  async approvalRequired(actor: Actor): Promise<boolean> {
    const others = await this.prisma.userRole.count({
      where: {
        role: "SUPER_ADMIN",
        customRoleId: null,
        user: { status: "ACTIVE" },
        ...(actor.kind === "user" ? { userId: { not: actor.userId } } : {}),
      },
    });
    return others > 0;
  }

  async submit(actor: Actor, kind: string, payload: unknown, meta: RequestMeta): Promise<SubmitResult> {
    if (actor.kind !== "user") throw forbidden("Only administrators can change this");
    const handler = this.handler(kind);
    const prepared = await handler.prepare(payload, this.prisma);
    const summary = handler.summary(prepared);

    if (!(await this.approvalRequired(actor))) {
      const result = await this.prisma.$transaction(async tx => {
        const out = await handler.apply(tx, prepared, { actor, requestedById: actor.userId, meta });
        await this.audit.record(actor, { action: "change.applied", entityType: "change", entityId: kind, data: { kind, summary, approval: "sole_super_admin" } }, meta, tx);
        return out;
      });
      await handler.afterCommit?.(prepared, result);
      return { status: "APPLIED", result, approval: "sole_super_admin" };
    }

    const request = await this.prisma.$transaction(async tx => {
      const created = await tx.changeRequest.create({
        data: {
          kind,
          summary,
          payload: prepared as Prisma.InputJsonValue,
          requestedById: actor.userId,
          requestedByName: actor.name,
          expiresAt: new Date(Date.now() + PENDING_DAYS * 86_400_000),
        },
      });
      await this.audit.record(actor, { action: "change.request", entityType: "change", entityId: created.id, data: { kind, summary } }, meta, tx);
      return created;
    });
    this.realtime.publish({ type: "change.updated", id: request.id, staffPermission: "change:approve" });
    return { status: "PENDING", changeRequest: changeView(request) };
  }

  async list(actor: Actor, query: z.infer<typeof listChangesQuerySchema>) {
    const now = new Date();
    const where: Prisma.ChangeRequestWhereInput =
      query.status === "PENDING"
        ? { status: "PENDING", expiresAt: { gt: now } }
        : query.status === "EXPIRED"
          ? { OR: [{ status: "EXPIRED" }, { status: "PENDING", expiresAt: { lte: now } }] }
          : { status: query.status };
    const rows = await this.prisma.changeRequest.findMany({ where, ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    const me = actor.kind === "user" ? actor.userId : null;
    return {
      ...page,
      items: page.items.map(c => {
        const view = changeView(c);
        return { ...view, canApprove: view.status === "PENDING" && c.requestedById !== me && actor.permissions.has("change:approve"), canCancel: view.status === "PENDING" && c.requestedById === me };
      }),
    };
  }

  async pendingCount() {
    return this.prisma.changeRequest.count({ where: { status: "PENDING", expiresAt: { gt: new Date() } } });
  }

  async approve(actor: Actor, id: string, note: string | undefined, meta: RequestMeta) {
    if (actor.kind !== "user") throw forbidden();
    const request = await this.pending(id);
    if (request.requestedById === actor.userId)
      throw new AppError("SELF_APPROVAL", "Another super admin has to approve your own change", HttpStatus.FORBIDDEN);
    const handler = this.handler(request.kind);
    let prepared: unknown;
    let result: unknown;
    try {
      prepared = await handler.prepare(request.payload, this.prisma);
      result = await this.prisma.$transaction(async tx => {
        const claimed = await tx.changeRequest.updateMany({
          where: { id, status: "PENDING" },
          data: { status: "APPROVED", reviewedById: actor.userId, reviewedByName: actor.name, reviewNote: note ?? null, decidedAt: new Date() },
        });
        if (!claimed.count) throw conflict("CHANGE_NOT_PENDING", "This change was already decided");
        const out = await handler.apply(tx, prepared, { actor, requestedById: request.requestedById, meta });
        await tx.changeRequest.update({ where: { id }, data: { result: out } });
        await this.audit.record(
          actor,
          { action: "change.approve", entityType: "change", entityId: id, data: { kind: request.kind, summary: request.summary, requestedBy: request.requestedByName, note: note ?? null } },
          meta,
          tx,
        );
        return out;
      });
    } catch (error) {
      if (!(error instanceof AppError && error.code === "CHANGE_NOT_PENDING")) {
        // The change can't be applied any more (e.g. a name was taken meanwhile): close it with the reason.
        const message = error instanceof AppError ? error.message : "The change could not be applied";
        await this.prisma.changeRequest.updateMany({
          where: { id, status: "PENDING" },
          data: { status: "FAILED", error: message, reviewedById: actor.userId, reviewedByName: actor.name, decidedAt: new Date() },
        });
        await this.audit.record(actor, { action: "change.failed", entityType: "change", entityId: id, data: { kind: request.kind, error: message } }, meta);
        this.realtime.publish({ type: "change.updated", id, staffPermission: "change:approve" });
      }
      throw error;
    }
    await handler.afterCommit?.(prepared, result);
    this.realtime.publish({ type: "change.updated", id, staffPermission: "change:approve" });
    return changeView(await this.prisma.changeRequest.findUniqueOrThrow({ where: { id } }));
  }

  async reject(actor: Actor, id: string, note: string, meta: RequestMeta) {
    if (actor.kind !== "user") throw forbidden();
    const request = await this.pending(id);
    if (request.requestedById === actor.userId) throw new AppError("SELF_APPROVAL", "Cancel your own change instead of rejecting it", HttpStatus.FORBIDDEN);
    return this.close(actor, request, "REJECTED", note, meta);
  }

  async cancel(actor: Actor, id: string, meta: RequestMeta) {
    if (actor.kind !== "user") throw forbidden();
    const request = await this.pending(id);
    if (request.requestedById !== actor.userId) throw forbidden("Only the person who asked for this change can cancel it");
    return this.close(actor, request, "CANCELLED", null, meta);
  }

  private async close(actor: Actor & { kind: "user" }, request: ChangeRequest, status: "REJECTED" | "CANCELLED", note: string | null, meta: RequestMeta) {
    await this.prisma.$transaction(async tx => {
      const { count } = await tx.changeRequest.updateMany({
        where: { id: request.id, status: "PENDING" },
        data: { status, reviewedById: actor.userId, reviewedByName: actor.name, reviewNote: note, decidedAt: new Date() },
      });
      if (!count) throw conflict("CHANGE_NOT_PENDING", "This change was already decided");
      await this.audit.record(
        actor,
        { action: status === "REJECTED" ? "change.reject" : "change.cancel", entityType: "change", entityId: request.id, data: { kind: request.kind, summary: request.summary, note } },
        meta,
        tx,
      );
    });
    this.realtime.publish({ type: "change.updated", id: request.id, staffPermission: "change:approve" });
    return changeView(await this.prisma.changeRequest.findUniqueOrThrow({ where: { id: request.id } }));
  }

  private async pending(id: string) {
    const request = await this.prisma.changeRequest.findUnique({ where: { id } });
    if (!request) throw notFound("Change request");
    if (request.status === "PENDING" && request.expiresAt <= new Date()) {
      await this.prisma.changeRequest.updateMany({ where: { id, status: "PENDING" }, data: { status: "EXPIRED", decidedAt: new Date() } });
      throw conflict("CHANGE_EXPIRED", "This change expired. Submit it again.");
    }
    if (request.status !== "PENDING") throw conflict("CHANGE_NOT_PENDING", "This change was already decided");
    return request;
  }

  private handler(kind: string) {
    const handler = this.handlers.get(kind);
    if (!handler) throw new AppError("UNKNOWN_CHANGE_KIND", `Unknown change kind ${kind}`, HttpStatus.UNPROCESSABLE_ENTITY);
    return handler;
  }
}
