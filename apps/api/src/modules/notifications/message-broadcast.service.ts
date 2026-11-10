import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError } from "../../common/errors";
import { pageArgs, pageQuerySchema, toPage } from "../../common/pagination";
import type { UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { Prisma, Role } from "../../generated/prisma/client";
import { OutboxService } from "./outbox.service";
import { GatewaysService } from "./gateways.service";

export const MESSAGE_AUDIENCES = ["ALL", "MERCHANTS", "ECOMMERCE", "BANKING", "RIDERS", "STAFF", "CUSTOMERS", "USERS"] as const;
export type MessageAudience = (typeof MESSAGE_AUDIENCES)[number];

const audienceShape = {
  audience: z.enum(MESSAGE_AUDIENCES),
  /** USERS: the chosen people. */
  userIds: z.array(z.uuid()).max(5000).default([]),
};
export const messageAudienceSchema = z.object(audienceShape).refine(v => v.audience !== "USERS" || v.userIds.length > 0, { message: "Choose at least one person", path: ["userIds"] });

export const messageBroadcastSchema = z
  .object({
    ...audienceShape,
    subject: z.string().trim().max(150, "Use at most 150 characters").optional(),
    body: z.string().trim().min(1, "Write the message").max(2000, "Use at most 2000 characters"),
  })
  .refine(v => v.audience !== "USERS" || v.userIds.length > 0, { message: "Choose at least one person", path: ["userIds"] });

export const messageHistoryQuerySchema = pageQuerySchema;

const MERCHANT_ROLES: Role[] = ["MERCHANT_OWNER", "MERCHANT_STAFF"];
const STAFF_ROLES: Role[] = ["OPS_MANAGER", "HUB_OPERATOR", "FINANCE", "SUPPORT_AGENT", "FRANCHISE"];

/**
 * Super admin › Messaging › SMS messages / Email messages: one message to a group (every merchant and rider, one
 * merchant type, riders, staff, website customers) or to chosen people. One outbox message per person with a phone
 * (SMS) or an email (EMAIL); the gateways send them (off in Integration settings: nothing is sent). Each message is
 * kept with its counts as the page's history.
 */
@Injectable()
export class MessageBroadcastService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly gateways: GatewaysService,
  ) {}

  private where(audience: MessageAudience, userIds: string[]): Prisma.UserWhereInput {
    const active: Prisma.UserWhereInput = { status: "ACTIVE" };
    switch (audience) {
      case "USERS":
        return { ...active, id: { in: userIds } };
      case "ALL":
        return { ...active, roles: { some: { role: { in: [...MERCHANT_ROLES, "RIDER"] } } } };
      case "MERCHANTS":
        return { ...active, roles: { some: { role: { in: MERCHANT_ROLES } } } };
      case "ECOMMERCE":
        return { ...active, roles: { some: { role: { in: MERCHANT_ROLES }, merchant: { type: "ECOMMERCE" } } } };
      case "BANKING":
        return { ...active, roles: { some: { role: { in: MERCHANT_ROLES }, merchant: { type: "BANKING_FINANCIAL" } } } };
      case "RIDERS":
        return { ...active, roles: { some: { role: "RIDER" } } };
      case "STAFF":
        return { ...active, roles: { some: { role: { in: STAFF_ROLES } } } };
      case "CUSTOMERS":
        return { ...active, roles: { some: { role: "CUSTOMER" } } };
    }
  }

  private async people(channel: "SMS" | "EMAIL", audience: MessageAudience, userIds: string[]) {
    const users = await this.prisma.user.findMany({ where: this.where(audience, userIds), select: { id: true, phone: true, email: true } });
    // One message per phone / email (a person with two roles gets one).
    const seen = new Set<string>();
    const out: { id: string; to: string }[] = [];
    for (const u of users) {
      const to = channel === "SMS" ? u.phone : u.email;
      if (!to || seen.has(to.toLowerCase())) continue;
      seen.add(to.toLowerCase());
      out.push({ id: u.id, to });
    }
    return { matched: users.length, people: out };
  }

  /** The count before sending (the page asks to confirm it). */
  async preview(channel: "SMS" | "EMAIL", input: z.infer<typeof messageAudienceSchema>) {
    const { matched, people } = await this.people(channel, input.audience, input.userIds);
    const gateway = (await this.gateways.status()).find(g => g.channel === channel);
    return { matched, recipients: people.length, missing: matched - people.length, gatewayOn: !(await this.prisma.notificationGateway.findFirst({ where: { channel, enabled: false }, select: { channel: true } })), gatewayMode: gateway?.mode ?? "log" };
  }

  async send(actor: UserActor, channel: "SMS" | "EMAIL", input: z.infer<typeof messageBroadcastSchema>, meta: RequestMeta) {
    if (channel === "EMAIL" && !input.subject?.trim()) throw new AppError("INVALID", "Write the email's subject", 422);
    const off = await this.prisma.notificationGateway.findFirst({ where: { channel, enabled: false }, select: { channel: true } });
    if (off) throw new AppError("GATEWAY_OFF", `${channel === "SMS" ? "SMS" : "Email"} is switched off in Integration settings`, 422);
    const { people } = await this.people(channel, input.audience, input.userIds);
    if (!people.length) throw new AppError("NO_RECIPIENTS", `Nobody in this audience has ${channel === "SMS" ? "a phone number" : "an email"}`, 422);
    const html = channel === "EMAIL" ? `<p>${escapeHtml(input.body).replace(/\n/g, "<br>")}</p>` : null;
    const { row, ids } = await this.prisma.$transaction(
      async tx => {
        const row = await tx.messageBroadcast.create({
          data: { channel, subject: channel === "EMAIL" ? input.subject!.trim() : null, body: input.body, audience: input.audience, userIds: input.audience === "USERS" ? people.map(p => p.id) : [], recipients: people.length, queued: people.length, createdById: actor.userId },
        });
        const ids: string[] = [];
        for (const p of people) {
          ids.push(await this.outbox.queue(tx, { channel, to: p.to, template: `broadcast:${row.id}`, body: input.body, subject: row.subject, html, userId: p.id }));
        }
        await this.audit.record(actor, { action: `${channel.toLowerCase()}_broadcast.send`, entityType: "message_broadcast", entityId: row.id, data: { audience: input.audience, recipients: people.length } }, meta, tx);
        return { row, ids };
      },
      { timeout: 120_000 },
    );
    await this.outbox.flush(ids);
    return this.view(row, actor.name, null);
  }

  async list(channel: "SMS" | "EMAIL", query: z.infer<typeof pageQuerySchema>) {
    const rows = await this.prisma.messageBroadcast.findMany({ where: { channel }, ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    const authors = await this.prisma.user.findMany({ where: { id: { in: [...new Set(page.items.map(r => r.createdById))] } }, select: { id: true, name: true } });
    const nameOf = new Map(authors.map(a => [a.id, a.name]));
    // Sent / failed / waiting so far: the outbox messages of each broadcast (template broadcast:<id>).
    const states = page.items.length
      ? await this.prisma.outboxMessage.groupBy({ by: ["template", "state"], where: { channel, template: { in: page.items.map(r => `broadcast:${r.id}`) } }, _count: { _all: true } })
      : [];
    const stateOf = (id: string) => Object.fromEntries(states.filter(s => s.template === `broadcast:${id}`).map(s => [s.state, s._count._all]));
    return {
      items: page.items.map(r => this.view(r, nameOf.get(r.createdById) ?? null, stateOf(r.id))),
      nextCursor: page.nextCursor,
    };
  }

  private view(r: Prisma.MessageBroadcastGetPayload<object>, createdBy: string | null, states: Record<string, number> | null) {
    return {
      id: r.id,
      channel: r.channel,
      subject: r.subject,
      body: r.body,
      audience: r.audience,
      chosen: r.userIds.length,
      recipients: r.recipients,
      queued: r.queued,
      sent: states?.SENT ?? 0,
      failed: states?.FAILED ?? 0,
      pending: states ? (states.PENDING ?? 0) : r.queued,
      createdBy,
      createdAt: r.createdAt,
    };
  }
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
