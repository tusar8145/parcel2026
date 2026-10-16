import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { StorageService } from "../../common/storage.service";
import { nextNumber } from "../../common/counters";
import { pageArgs, toPage } from "../../common/pagination";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import { merchantIdsOf, type Actor, type UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { Prisma, Role, SupportTicket, TicketStatus } from "../../generated/prisma/client";
import { ParcelsService } from "../parcels/parcels.service";
import { NotifyService } from "../notifications/notify.service";
import { OutboxService } from "../notifications/outbox.service";
import { RealtimeService } from "../../common/realtime.service";
import { env } from "../../config/env";
import { dueAfterPriorityChange, initialDue, readSlaConfig, slaView } from "./sla";
import { APPLICATION_CATEGORIES, type Attachment, type createTicketSchema, type listTicketsQuerySchema, type replySchema, type updateTicketSchema } from "./support.schemas";

const ASSIGNABLE_ROLES: Role[] = ["SUPPORT_AGENT", "OPS_MANAGER", "SUPER_ADMIN"];
const APPLICATION_CATEGORY_SET = new Set<string>(APPLICATION_CATEGORIES);
const EXTENSIONS: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "application/pdf": ".pdf" };

export const STATUS_LABELS: Record<TicketStatus, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  WAITING_FOR_REQUESTER: "Waiting for requester",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

export const isSupportStaff = (actor: Actor) => actor.permissions.has("support:manage");

export const fileUrl = (id: string) => `/api/v1/files/${id}`;

/** Messages the actor may read: requesters never see internal notes. */
const visibleMessages = (staff: boolean): Prisma.TicketMessageWhereInput => (staff ? {} : { internal: false });

const ticketInclude = (staff: boolean) =>
  ({
    requester: { select: { id: true, name: true, phone: true } },
    assignee: { select: { id: true, name: true } },
    merchant: { select: { id: true, code: true, name: true } },
    parcel: { select: { id: true, trackingId: true } },
    // Prisma batches these per page (one query per relation), so lists stay free of N+1.
    messages: { where: visibleMessages(staff), orderBy: { createdAt: "desc" }, take: 1, select: { authorLabel: true, body: true, internal: true, createdAt: true } },
    survey: { select: { rating: true, comment: true, requestedAt: true, respondedAt: true } },
    _count: { select: { messages: { where: visibleMessages(staff) } } },
  }) satisfies Prisma.SupportTicketInclude;

type TicketRow = Prisma.SupportTicketGetPayload<{ include: ReturnType<typeof ticketInclude> }>;

const messageInclude = {
  attachments: { select: { id: true, filename: true, mimeType: true, sizeBytes: true }, orderBy: { createdAt: "asc" } },
} satisfies Prisma.TicketMessageInclude;

type MessageRow = Prisma.TicketMessageGetPayload<{ include: typeof messageInclude }>;

function ticketView(t: TicketRow, staff: boolean) {
  const last = t.messages[0];
  return {
    id: t.id,
    number: t.number,
    category: t.category,
    subject: t.subject,
    status: t.status,
    statusLabel: STATUS_LABELS[t.status],
    priority: t.priority,
    requester: { id: t.requester.id, name: t.requester.name, ...(staff ? { phone: t.requester.phone } : {}) },
    assignee: t.assignee,
    merchant: t.merchant,
    parcel: t.parcel,
    relatedRef: t.parcel?.trackingId ?? null,
    messageCount: t._count.messages,
    lastMessage: last ? { authorLabel: last.authorLabel, preview: last.body.slice(0, 140), internal: last.internal, createdAt: last.createdAt } : null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    resolvedAt: t.resolvedAt,
    ...(staff ? { sla: slaView(t) } : {}),
    survey: t.survey ? { requested: true, rating: t.survey.rating, comment: t.survey.comment, respondedAt: t.survey.respondedAt } : null,
  };
}

/**
 * Status change side effects on the SLA clock: waiting for the requester (or resolved) pauses it;
 * leaving that state resumes it, pushing the resolution target back by the paused time.
 */
function slaOnStatus(ticket: SupportTicket, to: TicketStatus, now: Date): Prisma.SupportTicketUncheckedUpdateInput {
  const pausing = to === "WAITING_FOR_REQUESTER" || to === "RESOLVED";
  if (pausing) return ticket.slaPausedAt ? {} : { slaPausedAt: now };
  if (!ticket.slaPausedAt) return {};
  const resumed = ticket.resolutionDueAt && to !== "CLOSED" ? { resolutionDueAt: new Date(ticket.resolutionDueAt.getTime() + (now.getTime() - ticket.slaPausedAt.getTime())) } : {};
  return { slaPausedAt: null, ...resumed };
}

const supportLink = () => `${env().APP_URL}/#/support`;

function messageView(m: MessageRow, requesterId: string) {
  return {
    id: m.id,
    author: { id: m.authorId, label: m.authorLabel, kind: m.authorId === null ? "system" : m.authorId === requesterId ? "requester" : "staff" },
    body: m.body,
    internal: m.internal,
    createdAt: m.createdAt,
    attachments: m.attachments.map(a => ({ ...a, url: fileUrl(a.id) })),
  };
}

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly parcels: ParcelsService,
  ) {}

  // Property injection keeps the constructor stable for other modules / parallel edits.
  @Inject(NotifyService) private readonly notify!: NotifyService;
  @Inject(OutboxService) private readonly outbox!: OutboxService;
  @Inject(RealtimeService) private readonly realtime!: RealtimeService;

  // ───────────── reads ─────────────

  async list(actor: UserActor, query: z.infer<typeof listTicketsQuerySchema>) {
    const staff = isSupportStaff(actor);
    if (!staff && (query.assigneeId || query.merchantId)) throw forbidden("Only support staff can filter by assignee or merchant");
    const where: Prisma.SupportTicketWhereInput = {
      ...(staff ? {} : { requesterId: actor.userId }),
      status: query.status,
      category: query.category,
      merchantId: query.merchantId,
      ...(query.assigneeId ? { assigneeId: query.assigneeId === "me" ? actor.userId : query.assigneeId === "unassigned" ? null : query.assigneeId } : {}),
      ...(query.q
        ? { OR: [{ number: { contains: query.q, mode: "insensitive" } }, { subject: { contains: query.q, mode: "insensitive" } }] }
        : {}),
    };
    const rows = await this.prisma.supportTicket.findMany({ where, include: ticketInclude(staff), ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    return { items: page.items.map(t => ticketView(t, staff)), nextCursor: page.nextCursor };
  }

  async detail(actor: UserActor, number: string, db: Db = this.prisma) {
    const staff = isSupportStaff(actor);
    const ticket = await db.supportTicket.findFirst({ where: { AND: [{ number: number.toUpperCase() }, this.scope(actor)] }, include: ticketInclude(staff) });
    if (!ticket) throw notFound("Ticket");
    const messages = await db.ticketMessage.findMany({
      where: { ticketId: ticket.id, ...visibleMessages(staff) },
      include: messageInclude,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return { ...ticketView(ticket, staff), messages: messages.map(m => messageView(m, ticket.requesterId)) };
  }

  // ───────────── writes ─────────────

  async create(actor: UserActor, input: z.infer<typeof createTicketSchema>, meta: RequestMeta) {
    const number = await this.prisma.$transaction(async tx => {
      let parcel: { id: string; merchantId: string | null } | null = null;
      if (input.relatedRef) {
        parcel = await tx.parcel.findFirst({ where: { AND: [{ trackingId: input.relatedRef }, this.parcels.scope(actor)] }, select: { id: true, merchantId: true } });
        if (!parcel) throw new AppError("UNKNOWN_PARCEL", `We couldn't find parcel ${input.relatedRef} on your account`, HttpStatus.UNPROCESSABLE_ENTITY);
      }
      const merchants = merchantIdsOf(actor);
      const merchantId = parcel?.merchantId && merchants.includes(parcel.merchantId) ? parcel.merchantId : (merchants[0] ?? null);
      const { ticket, messageId } = await this.openTicket(
        actor,
        { category: input.category, subject: input.subject, priority: input.priority, message: input.message, merchantId, parcelId: parcel?.id },
        tx,
      );
      await this.saveAttachments(actor, ticket.number, messageId, input.attachments, tx);
      await this.audit.record(
        actor,
        { action: "support.ticket.create", entityType: "support_ticket", entityId: ticket.id, data: { number: ticket.number, category: ticket.category, parcelId: parcel?.id ?? null, attachments: input.attachments.length } },
        meta,
        tx,
      );
      return ticket.number;
    });
    await this.publish(number);
    return this.detail(actor, number);
  }

  async reply(actor: UserActor, number: string, input: z.infer<typeof replySchema>, meta: RequestMeta) {
    const staff = isSupportStaff(actor);
    if (input.internal && !staff) throw forbidden("Only support staff can add internal notes");
    const outboxIds = await this.prisma.$transaction(async tx => {
      const ticket = await this.lockTicket(actor, number, tx);
      if (ticket.status === "CLOSED") throw conflict("TICKET_CLOSED", "This ticket is closed. Support must reopen it before anyone can reply.");
      const fromRequester = ticket.requesterId === actor.userId;
      const now = new Date();
      const message = await tx.ticketMessage.create({
        data: { ticketId: ticket.id, authorId: actor.userId, authorLabel: actor.name, body: input.body, internal: input.internal },
      });
      await this.saveAttachments(actor, ticket.number, message.id, input.attachments, tx);
      const status: TicketStatus = input.internal ? ticket.status : fromRequester ? "OPEN" : "WAITING_FOR_REQUESTER";
      const firstResponse = !fromRequester && !input.internal && !ticket.firstResponseAt ? { firstResponseAt: now } : {};
      await tx.supportTicket.update({
        where: { id: ticket.id },
        data: {
          status,
          updatedAt: now,
          ...(status !== ticket.status && ticket.status === "RESOLVED" ? { resolvedAt: null } : {}),
          ...(status !== ticket.status ? slaOnStatus(ticket, status, now) : {}),
          ...firstResponse,
        },
      });
      // A partner applicant answering a request for information puts the application back in review.
      if (fromRequester) await tx.partnerApplication.updateMany({ where: { ticketId: ticket.id, status: "INFO_REQUESTED" }, data: { status: "UNDER_REVIEW" } });
      await this.audit.record(
        actor,
        { action: "support.ticket.reply", entityType: "support_ticket", entityId: ticket.id, data: { messageId: message.id, internal: input.internal, from: ticket.status, to: status, attachments: input.attachments.length } },
        meta,
        tx,
      );
      if (fromRequester || input.internal) return [];
      return this.notify.notify(tx, {
        event: "support.ticket_reply",
        to: { userId: ticket.requesterId },
        vars: { ticketNumber: ticket.number, subject: ticket.subject, link: supportLink() },
      });
    });
    await this.outbox.flush(outboxIds);
    await this.publish(number);
    return this.detail(actor, number);
  }

  async update(actor: UserActor, number: string, input: z.infer<typeof updateTicketSchema>, meta: RequestMeta) {
    const staff = isSupportStaff(actor);
    const outboxIds = await this.prisma.$transaction(async tx => {
      const ticket = await this.lockTicket(actor, number, tx);
      if (!staff) this.assertRequesterChange(ticket, input);

      const now = new Date();
      const data: Prisma.SupportTicketUncheckedUpdateInput = { updatedAt: now };
      const notes: { body: string; internal: boolean }[] = [];
      if (input.priority && input.priority !== ticket.priority) {
        data.priority = input.priority;
        Object.assign(data, dueAfterPriorityChange(await readSlaConfig(tx), ticket, input.priority));
      }
      if (input.assigneeId !== undefined && input.assigneeId !== ticket.assigneeId) {
        const assignee = input.assigneeId ? await this.assignee(input.assigneeId, tx) : null;
        data.assigneeId = assignee?.id ?? null;
        notes.push({ body: assignee ? `Assigned to ${assignee.name}` : "Unassigned", internal: true });
      }
      if (input.status && input.status !== ticket.status) {
        data.status = input.status;
        if (input.status === "RESOLVED") data.resolvedAt = now;
        else if (input.status !== "CLOSED") data.resolvedAt = null;
        Object.assign(data, slaOnStatus(ticket, input.status, now));
        notes.push({ body: `Status changed to ${STATUS_LABELS[input.status]}`, internal: false });
      }
      if (Object.keys(data).length === 1) return [] as string[]; // nothing changed

      await tx.supportTicket.update({ where: { id: ticket.id }, data });
      for (const note of notes) await tx.ticketMessage.create({ data: { ticketId: ticket.id, authorId: null, authorLabel: "System", ...note } });
      const { updatedAt: _, ...changes } = data;
      await this.audit.record(
        actor,
        { action: "support.ticket.update", entityType: "support_ticket", entityId: ticket.id, data: { from: { status: ticket.status, priority: ticket.priority, assigneeId: ticket.assigneeId }, to: changes as Prisma.InputJsonObject } },
        meta,
        tx,
      );
      return this.afterStatusChange(tx, ticket, input.status, actor);
    });
    await this.outbox.flush(outboxIds);
    await this.publish(number);
    return this.detail(actor, number);
  }

  /**
   * Inserts a ticket and its first message inside the caller's transaction. The caller validates
   * the input and writes the audit entry. Also used for partner applications (modules/applications).
   */
  async openTicket(
    actor: UserActor,
    input: { category: string; subject: string; priority: "LOW" | "NORMAL" | "HIGH"; message: string; merchantId?: string | null; parcelId?: string },
    tx: Db,
  ) {
    const due = initialDue(await readSlaConfig(tx), input.priority, new Date());
    const ticket = await tx.supportTicket.create({
      data: {
        number: await nextNumber(tx, "DF-SUP"),
        requesterId: actor.userId,
        merchantId: input.merchantId ?? null,
        parcelId: input.parcelId,
        category: input.category,
        subject: input.subject,
        priority: input.priority,
        ...due,
      },
    });
    const message = await tx.ticketMessage.create({ data: { ticketId: ticket.id, authorId: actor.userId, authorLabel: actor.name, body: input.message } });
    return { ticket, messageId: message.id };
  }

  /** People a ticket can be assigned to: active support agents, operations managers and super admins. */
  async assignees() {
    const users = await this.prisma.user.findMany({
      where: { status: "ACTIVE", roles: { some: { role: { in: ASSIGNABLE_ROLES } } } },
      select: { id: true, name: true, roles: { where: { role: { in: ASSIGNABLE_ROLES } }, select: { role: true } } },
      orderBy: { name: "asc" },
      take: 500,
    });
    return users.map(u => ({ id: u.id, name: u.name, roles: [...new Set(u.roles.map(r => r.role))] }));
  }

  /**
   * After a status change by staff: tell the requester (support.ticket_status) and, when it
   * was resolved, ask for a satisfaction rating once (support.csat_request + survey row).
   */
  private async afterStatusChange(tx: Db, ticket: SupportTicket, to: TicketStatus | undefined, actor: UserActor): Promise<string[]> {
    if (!to || to === ticket.status || actor.userId === ticket.requesterId) return [];
    if (APPLICATION_CATEGORY_SET.has(ticket.category)) return []; // applications send their own updates
    const ids = await this.notify.notify(tx, {
      event: "support.ticket_status",
      to: { userId: ticket.requesterId },
      vars: { ticketNumber: ticket.number, subject: ticket.subject, status: STATUS_LABELS[to], link: supportLink() },
    });
    if (to === "RESOLVED") {
      const existing = await tx.ticketSurvey.findUnique({ where: { ticketId: ticket.id } });
      if (!existing) {
        await tx.ticketSurvey.create({ data: { ticketId: ticket.id, agentId: ticket.assigneeId ?? actor.userId } });
        ids.push(...(await this.notify.notify(tx, { event: "support.csat_request", to: { userId: ticket.requesterId }, vars: { ticketNumber: ticket.number, link: supportLink() } })));
      }
    }
    return ids;
  }

  /** ticket.updated to the requester, the assignee and support staff. */
  async publish(number: string) {
    const t = await this.prisma.supportTicket.findUnique({ where: { number: number.toUpperCase() }, select: { number: true, requesterId: true, assigneeId: true } });
    if (t) this.realtime.publish({ type: "ticket.updated", id: t.number, userIds: [t.requesterId, t.assigneeId], staffPermission: "support:manage" });
  }

  // ───────────── helpers ─────────────

  /** Tickets the actor may see: staff see all, everyone else their own. */
  private scope(actor: UserActor): Prisma.SupportTicketWhereInput {
    return isSupportStaff(actor) ? {} : { requesterId: actor.userId };
  }

  /** Loads within scope and row-locks the ticket so concurrent replies and status changes serialise. */
  private async lockTicket(actor: UserActor, number: string, tx: Db): Promise<SupportTicket> {
    const ticket = await tx.supportTicket.findFirst({ where: { AND: [{ number: number.toUpperCase() }, this.scope(actor)] } });
    if (!ticket) throw notFound("Ticket");
    await tx.$queryRaw`SELECT id FROM support_tickets WHERE id = ${ticket.id}::uuid FOR UPDATE`;
    return (await tx.supportTicket.findUnique({ where: { id: ticket.id } }))!;
  }

  /** Requesters may close their ticket, or reopen it once resolved; nothing else. */
  private assertRequesterChange(ticket: SupportTicket, input: z.infer<typeof updateTicketSchema>) {
    const onlyStatus = input.priority === undefined && input.assigneeId === undefined && input.status !== undefined;
    const allowed = onlyStatus && (input.status === "CLOSED" || (input.status === "OPEN" && ticket.status === "RESOLVED"));
    if (!allowed) throw forbidden("You can close your ticket, or reopen it after it was resolved");
  }

  private async assignee(userId: string, db: Db) {
    const user = await db.user.findFirst({
      where: { id: userId, status: "ACTIVE", roles: { some: { role: { in: ASSIGNABLE_ROLES } } } },
      select: { id: true, name: true },
    });
    if (!user) throw new AppError("INVALID_ASSIGNEE", "Tickets can only be assigned to active support agents, operations managers or super admins", HttpStatus.UNPROCESSABLE_ENTITY);
    return user;
  }

  private async saveAttachments(actor: UserActor, number: string, messageId: string, attachments: Attachment[], db: Db) {
    for (const [i, a] of attachments.entries()) {
      const ext = EXTENSIONS[a.dataUrl.slice(5, a.dataUrl.indexOf(";"))] ?? "";
      await this.storage.saveDataUrl(a.dataUrl, a.filename ?? `${number}-${i + 1}${ext}`, actor.userId, db, messageId);
    }
  }
}
