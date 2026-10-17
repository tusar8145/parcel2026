import { HttpStatus, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { QueueService } from "../../common/queues";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import { env, runsJobs } from "../../config/env";
import type { UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { Prisma, type SupportTicket, type TicketPriority } from "../../generated/prisma/client";
import { NotifyService } from "../notifications/notify.service";
import { OutboxService } from "../notifications/outbox.service";
import { SUPPORT_SLA_KEY, readSlaConfig, type SlaConfig } from "./sla";
import { SupportService } from "./support.service";
import type { cannedResponseSchema, csatReportQuerySchema, csatSchema, listCannedQuerySchema, updateCannedResponseSchema } from "./support-desk.schemas";

const NEXT_PRIORITY: Record<TicketPriority, TicketPriority> = { LOW: "NORMAL", NORMAL: "HIGH", HIGH: "URGENT", URGENT: "URGENT" };
const PRIORITY_LABEL: Record<TicketPriority, string> = { LOW: "Low", NORMAL: "Normal", HIGH: "High", URGENT: "Urgent" };
const OPEN_STATUSES = ["OPEN", "IN_PROGRESS"] as const;

/** Canned responses, CSAT surveys and SLA settings / breach escalation for the support desk. */
@Injectable()
export class SupportDeskService implements OnApplicationBootstrap {
  private readonly logger = new Logger("SupportSla");

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queues: QueueService,
    private readonly notify: NotifyService,
    private readonly outbox: OutboxService,
    private readonly support: SupportService,
  ) {}

  onApplicationBootstrap() {
    if (!runsJobs() || env().NODE_ENV === "test") return;
    void this.queues
      .schedule("support-sla-check", "*/5 * * * *", async () => {
        const r = await this.checkSla();
        if (r.breaches) this.logger.log(`SLA check: ${r.breaches} breach(es) escalated`);
      })
      .catch(err => this.logger.error({ err }, "Could not schedule the support SLA check"));
  }

  // ───────────── canned responses ─────────────

  async listCanned(query: z.infer<typeof listCannedQuerySchema>) {
    return this.prisma.cannedResponse.findMany({
      where: {
        active: query.includeInactive ? undefined : true,
        category: query.category,
        ...(query.q
          ? { OR: [{ title: { contains: query.q, mode: "insensitive" } }, { body: { contains: query.q, mode: "insensitive" } }, { shortcut: { contains: query.q.toLowerCase() } }] }
          : {}),
      },
      orderBy: [{ category: "asc" }, { title: "asc" }],
      take: 500,
    });
  }

  async createCanned(actor: UserActor, input: z.infer<typeof cannedResponseSchema>, meta: RequestMeta) {
    return this.prisma.$transaction(async tx => {
      await this.assertShortcutFree(tx, input.shortcut);
      const row = await tx.cannedResponse.create({ data: { ...input, createdById: actor.userId, updatedById: actor.userId } });
      await this.audit.record(actor, { action: "support.canned.create", entityType: "canned_response", entityId: row.id, data: { title: row.title, shortcut: row.shortcut } }, meta, tx);
      return row;
    });
  }

  async updateCanned(actor: UserActor, id: string, input: z.infer<typeof updateCannedResponseSchema>, meta: RequestMeta) {
    return this.prisma.$transaction(async tx => {
      const existing = await tx.cannedResponse.findUnique({ where: { id } });
      if (!existing) throw notFound("Canned response");
      if (input.shortcut && input.shortcut !== existing.shortcut) await this.assertShortcutFree(tx, input.shortcut);
      const row = await tx.cannedResponse.update({ where: { id }, data: { ...input, updatedById: actor.userId } });
      await this.audit.record(actor, { action: "support.canned.update", entityType: "canned_response", entityId: id, data: input as Prisma.InputJsonObject }, meta, tx);
      return row;
    });
  }

  async deleteCanned(actor: UserActor, id: string, meta: RequestMeta) {
    await this.prisma.$transaction(async tx => {
      const existing = await tx.cannedResponse.findUnique({ where: { id } });
      if (!existing) throw notFound("Canned response");
      await tx.cannedResponse.delete({ where: { id } });
      await this.audit.record(actor, { action: "support.canned.delete", entityType: "canned_response", entityId: id, data: { title: existing.title } }, meta, tx);
    });
  }

  private async assertShortcutFree(db: Prisma.TransactionClient, shortcut?: string | null) {
    if (shortcut && (await db.cannedResponse.findUnique({ where: { shortcut } }))) throw conflict("SHORTCUT_TAKEN", `The shortcut "${shortcut}" is already used`);
  }

  // ───────────── CSAT ─────────────

  /** The requester rates a resolved / closed ticket once (1–5 and an optional comment). */
  async submitCsat(actor: UserActor, number: string, input: z.infer<typeof csatSchema>, meta: RequestMeta) {
    await this.prisma.$transaction(async tx => {
      const ticket = await tx.supportTicket.findUnique({ where: { number: number.toUpperCase() }, include: { survey: true } });
      if (!ticket || ticket.requesterId !== actor.userId) throw notFound("Ticket");
      if (ticket.status !== "RESOLVED" && ticket.status !== "CLOSED") throw new AppError("TICKET_NOT_RESOLVED", "You can rate a ticket once it's resolved", HttpStatus.CONFLICT);
      if (ticket.survey?.respondedAt) throw conflict("ALREADY_RATED", "You already rated this ticket. Thank you!");
      const data = { rating: input.rating, comment: input.comment ?? null, respondedAt: new Date() };
      if (ticket.survey) {
        const updated = await tx.ticketSurvey.updateMany({ where: { ticketId: ticket.id, respondedAt: null }, data });
        if (!updated.count) throw conflict("ALREADY_RATED", "You already rated this ticket. Thank you!");
      } else await tx.ticketSurvey.create({ data: { ticketId: ticket.id, agentId: ticket.assigneeId, ...data } });
      await this.audit.record(actor, { action: "support.csat.submit", entityType: "support_ticket", entityId: ticket.id, data: { number: ticket.number, rating: input.rating } }, meta, tx);
    });
    await this.support.publish(number);
    return this.support.detail(actor, number);
  }

  async csatReport(query: z.infer<typeof csatReportQuerySchema>) {
    const range = query.from || query.to ? { gte: query.from, lt: query.to } : undefined;
    const [requested, responses] = await Promise.all([
      this.prisma.ticketSurvey.count({ where: { requestedAt: range } }),
      this.prisma.ticketSurvey.findMany({
        where: { respondedAt: range ? range : { not: null }, rating: { not: null } },
        select: { rating: true, comment: true, respondedAt: true, agentId: true, ticket: { select: { number: true, subject: true } } },
        orderBy: { respondedAt: "desc" },
        take: 5000,
      }),
    ]);
    const ratings = responses.map(r => r.rating!);
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
    const agentIds = [...new Set(responses.map(r => r.agentId).filter((x): x is string => !!x))];
    const agents = await this.prisma.user.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } });
    return {
      requested,
      responded: responses.length,
      responseRate: requested ? Math.round((responses.length / requested) * 1000) / 10 : null,
      averageRating: avg(ratings),
      /** Share of 4–5 ratings, in percent. */
      satisfaction: ratings.length ? Math.round((ratings.filter(r => r >= 4).length / ratings.length) * 1000) / 10 : null,
      distribution: [1, 2, 3, 4, 5].map(rating => ({ rating, count: ratings.filter(r => r === rating).length })),
      byAgent: agentIds
        .map(id => {
          const mine = responses.filter(r => r.agentId === id).map(r => r.rating!);
          return { agent: agents.find(a => a.id === id) ?? { id, name: null }, responses: mine.length, averageRating: avg(mine) };
        })
        .sort((a, b) => b.responses - a.responses),
      recentComments: responses
        .filter(r => r.comment)
        .slice(0, 20)
        .map(r => ({ ticketNumber: r.ticket.number, subject: r.ticket.subject, rating: r.rating, comment: r.comment, respondedAt: r.respondedAt })),
    };
  }

  // ───────────── SLA ─────────────

  getSla() {
    return readSlaConfig(this.prisma);
  }

  async updateSla(actor: UserActor, input: SlaConfig, meta: RequestMeta) {
    await this.prisma.$transaction(async tx => {
      const before = await readSlaConfig(tx);
      await tx.setting.upsert({ where: { key: SUPPORT_SLA_KEY }, create: { key: SUPPORT_SLA_KEY, value: input }, update: { value: input } });
      await this.audit.record(actor, { action: "support.sla.update", entityType: "setting", entityId: SUPPORT_SLA_KEY, data: { from: before, to: input } as unknown as Prisma.InputJsonObject }, meta, tx);
    });
    return input;
  }

  /** Open tickets by SLA state, for the support dashboard. */
  async overview(now = new Date()) {
    const open = { status: { in: [...OPEN_STATUSES, "WAITING_FOR_REQUESTER" as const] } };
    const soon = new Date(now.getTime() + 3600_000);
    const [total, paused, breached, atRisk, unassigned] = await Promise.all([
      this.prisma.supportTicket.count({ where: open }),
      this.prisma.supportTicket.count({ where: { ...open, slaPausedAt: { not: null } } }),
      this.prisma.supportTicket.count({ where: { ...open, OR: [{ firstResponseAt: null, firstResponseDueAt: { lt: now } }, { slaPausedAt: null, resolutionDueAt: { lt: now } }] } }),
      this.prisma.supportTicket.count({
        where: { ...open, OR: [{ firstResponseAt: null, firstResponseDueAt: { gte: now, lt: soon } }, { slaPausedAt: null, resolutionDueAt: { gte: now, lt: soon } }] },
      }),
      this.prisma.supportTicket.count({ where: { ...open, assigneeId: null } }),
    ]);
    return { open: total, paused, breached, atRisk, unassigned };
  }

  /**
   * Finds newly breached tickets (first response or resolution target missed), marks the breach,
   * escalates (priority one step up, unassigned → least busy agent), adds an internal note and
   * alerts the assignee — and operations managers from the second escalation on.
   */
  async checkSla(now = new Date()) {
    const cfg = await readSlaConfig(this.prisma);
    const candidates = await this.prisma.supportTicket.findMany({
      where: {
        status: { in: [...OPEN_STATUSES] },
        OR: [
          { firstResponseAt: null, firstResponseDueAt: { lt: now }, firstResponseBreachedAt: null },
          { slaPausedAt: null, resolutionDueAt: { lt: now }, resolutionBreachedAt: null },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    let breaches = 0;
    const touched: string[] = [];
    for (const t of candidates) {
      const kind: "first response" | "resolution" = !t.firstResponseAt && t.firstResponseDueAt && t.firstResponseDueAt < now && !t.firstResponseBreachedAt ? "first response" : "resolution";
      const outboxIds = await this.prisma.$transaction(async tx => {
        const guard = kind === "first response" ? { firstResponseBreachedAt: null } : { resolutionBreachedAt: null };
        const priority = cfg.raisePriority ? NEXT_PRIORITY[t.priority] : t.priority;
        const assignee = t.assigneeId ? null : cfg.autoAssign ? await this.leastBusyAgent(tx) : null;
        const updated = await tx.supportTicket.updateMany({
          where: { id: t.id, ...guard },
          data: {
            ...(kind === "first response" ? { firstResponseBreachedAt: now } : { resolutionBreachedAt: now }),
            escalationLevel: { increment: 1 },
            priority,
            ...(assignee ? { assigneeId: assignee.id } : {}),
          },
        });
        if (!updated.count) return null;
        const notes = [`SLA breached: ${kind} target missed.`];
        if (priority !== t.priority) notes.push(`Priority raised to ${PRIORITY_LABEL[priority]}.`);
        if (assignee) notes.push(`Assigned to ${assignee.name}.`);
        await tx.ticketMessage.create({ data: { ticketId: t.id, authorId: null, authorLabel: "System", body: notes.join(" "), internal: true } });
        await this.audit.record("system", { action: "support.ticket.sla_breach", entityType: "support_ticket", entityId: t.id, data: { number: t.number, breach: kind, priority, assigneeId: assignee?.id ?? t.assigneeId, level: t.escalationLevel + 1 } }, {}, tx);
        return this.alert(tx, { ...t, priority, assigneeId: assignee?.id ?? t.assigneeId, escalationLevel: t.escalationLevel + 1 }, kind);
      });
      if (outboxIds === null) continue;
      await this.outbox.flush(outboxIds);
      breaches++;
      touched.push(t.number);
    }
    for (const n of touched) await this.support.publish(n);
    return { checked: candidates.length, breaches, tickets: touched };
  }

  private async alert(tx: Prisma.TransactionClient, t: SupportTicket, breach: string) {
    const recipients = new Set<string>();
    if (t.assigneeId) recipients.add(t.assigneeId);
    if (t.escalationLevel >= 2 || !t.assigneeId) {
      const managers = await tx.user.findMany({ where: { status: "ACTIVE", roles: { some: { role: "OPS_MANAGER" } } }, select: { id: true }, take: 20 });
      managers.forEach(m => recipients.add(m.id));
    }
    const ids: string[] = [];
    const pkg = await this.support.requesterPackage(tx, t);
    for (const userId of recipients) {
      ids.push(
        ...(await this.notify.notify(tx, {
          event: "support.sla_escalation",
          to: { userId },
          pkg,
          vars: { ticketNumber: t.number, subject: t.subject, breach, priority: PRIORITY_LABEL[t.priority], link: `${env().APP_URL}/courier-operation` },
        })),
      );
    }
    return ids;
  }

  /** Active support agent with the fewest open tickets. */
  private async leastBusyAgent(tx: Prisma.TransactionClient) {
    const agents = await tx.user.findMany({ where: { status: "ACTIVE", roles: { some: { role: "SUPPORT_AGENT" } } }, select: { id: true, name: true }, take: 200 });
    if (!agents.length) return null;
    const load = await tx.supportTicket.groupBy({ by: ["assigneeId"], where: { assigneeId: { in: agents.map(a => a.id) }, status: { in: [...OPEN_STATUSES, "WAITING_FOR_REQUESTER"] } }, _count: { _all: true } });
    const count = (id: string) => load.find(l => l.assigneeId === id)?._count._all ?? 0;
    return agents.sort((a, b) => count(a.id) - count(b.id) || a.name.localeCompare(b.name))[0];
  }

  /** Who may change SLA settings: super admins and operations managers. */
  static assertCanConfigure(actor: UserActor) {
    if (!actor.permissions.has("config:manage") && !actor.roles.some(r => r.role === "OPS_MANAGER")) throw forbidden("Only operations managers and super admins can change SLA targets");
  }
}
