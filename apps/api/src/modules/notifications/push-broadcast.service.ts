import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError } from "../../common/errors";
import { pageArgs, pageQuerySchema, toPage } from "../../common/pagination";
import type { UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { Prisma, Role } from "../../generated/prisma/client";
import { InboxService } from "./inbox.service";
import { PushService } from "./push.service";

export const BROADCAST_AUDIENCES = ["ALL", "MERCHANTS", "RIDERS", "USERS"] as const;

export const broadcastSchema = z
  .object({
    title: z.string().trim().min(3, "Write a title (at least 3 characters)").max(120, "Use at most 120 characters"),
    body: z.string().trim().min(1, "Write the message").max(500, "Use at most 500 characters"),
    audience: z.enum(BROADCAST_AUDIENCES),
    /** USERS: the chosen people. */
    userIds: z.array(z.uuid()).max(5000).default([]),
  })
  .refine(v => v.audience !== "USERS" || v.userIds.length > 0, { message: "Choose at least one person", path: ["userIds"] });

export const recipientsQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  kind: z.enum(["MERCHANTS", "RIDERS"]).optional(),
});

export const testPushSchema = z.object({ userId: z.uuid("Choose who gets the test") });

const MERCHANT_ROLES: Role[] = ["MERCHANT_OWNER", "MERCHANT_STAFF"];
const ROLES: Record<Exclude<(typeof BROADCAST_AUDIENCES)[number], "USERS">, Role[]> = {
  ALL: [...MERCHANT_ROLES, "RIDER"],
  MERCHANTS: MERCHANT_ROLES,
  RIDERS: ["RIDER"],
};

/**
 * Super admin › push messages: a message to every merchant and rider, to one group, or to chosen people. It
 * lands in each recipient's notifications (bell, app) and as a push on their phones (merchants: when their
 * service plan has push notifications). Every message is kept with its counts as the history.
 */
@Injectable()
export class PushBroadcastService {
  private readonly logger = new Logger("PushBroadcast");

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inbox: InboxService,
    private readonly push: PushService,
  ) {}

  private async audienceUsers(input: z.infer<typeof broadcastSchema>): Promise<string[]> {
    if (input.audience === "USERS") {
      const found = await this.prisma.user.findMany({ where: { id: { in: input.userIds }, status: "ACTIVE" }, select: { id: true } });
      return found.map(u => u.id);
    }
    const grants = await this.prisma.userRole.findMany({ where: { role: { in: ROLES[input.audience] }, user: { status: "ACTIVE" } }, select: { userId: true }, distinct: ["userId"] });
    return grants.map(g => g.userId);
  }

  async send(actor: UserActor, input: z.infer<typeof broadcastSchema>, meta: RequestMeta) {
    const users = await this.audienceUsers(input);
    if (!users.length) throw new AppError("NO_RECIPIENTS", "Nobody matches this audience", 422);
    const broadcast = await this.prisma.$transaction(
      async tx => {
        const row = await tx.pushBroadcast.create({
          data: { title: input.title, body: input.body, audience: input.audience, userIds: input.audience === "USERS" ? users : [], recipients: users.length, createdById: actor.userId },
        });
        await this.inbox.add(tx, users, { type: "broadcast", title: input.title, body: input.body, push: false });
        await this.audit.record(actor, { action: "push_broadcast.send", entityType: "push_broadcast", entityId: row.id, data: { audience: input.audience, recipients: users.length } }, meta, tx);
        return row;
      },
      { timeout: 60_000 },
    );
    // Phones get it after the commit; the history row shows the counts when Firebase has answered.
    void this.push
      .toUsers(users, { title: input.title, body: input.body, data: { type: "broadcast", broadcastId: broadcast.id, title: input.title, body: input.body, link: "" } })
      .then(r => this.prisma.pushBroadcast.update({ where: { id: broadcast.id }, data: { devices: r.devices, delivered: r.delivered, failed: r.failed, sentAt: new Date() } }))
      .catch(err => this.logger.warn({ err }, "Broadcast push failed"));
    return this.view(broadcast, null);
  }

  async list(query: z.infer<typeof pageQuerySchema>) {
    const rows = await this.prisma.pushBroadcast.findMany({ ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    const authors = await this.prisma.user.findMany({ where: { id: { in: [...new Set(page.items.map(r => r.createdById))] } }, select: { id: true, name: true } });
    const nameOf = new Map(authors.map(a => [a.id, a.name]));
    return { items: page.items.map(r => this.view(r, nameOf.get(r.createdById) ?? null)), nextCursor: page.nextCursor };
  }

  private view(r: Prisma.PushBroadcastGetPayload<object>, createdBy: string | null) {
    return {
      id: r.id,
      title: r.title,
      body: r.body,
      audience: r.audience,
      chosen: r.userIds.length,
      recipients: r.recipients,
      devices: r.devices,
      delivered: r.delivered,
      failed: r.failed,
      sending: !r.sentAt,
      createdBy,
      createdAt: r.createdAt,
      sentAt: r.sentAt,
    };
  }

  /** People to choose for a message: merchant users (with their merchant) and riders, with their phones' count. */
  async recipients(query: z.infer<typeof recipientsQuerySchema>) {
    const roles = query.kind ? ROLES[query.kind] : ROLES.ALL;
    const q = query.q?.trim();
    const digits = q?.replace(/\D/g, "").replace(/^(880|0)/, "");
    const users = await this.prisma.user.findMany({
      where: {
        status: "ACTIVE",
        roles: { some: { role: { in: roles } } },
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { email: { contains: q, mode: "insensitive" } },
                ...(digits && digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
                { roles: { some: { merchant: { name: { contains: q, mode: "insensitive" } } } } },
                { rider: { code: { contains: q, mode: "insensitive" } } },
              ],
            }
          : {}),
      },
      take: 30,
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        phone: true,
        roles: { select: { role: true, merchant: { select: { name: true, code: true } } } },
        rider: { select: { code: true } },
        _count: { select: { pushDevices: true } },
      },
    });
    return {
      items: users.map(u => {
        const m = u.roles.find(r => r.merchant)?.merchant;
        return { id: u.id, name: u.name, phone: u.phone, kind: u.rider ? "RIDER" : "MERCHANT", detail: u.rider ? `Rider ${u.rider.code}` : m ? `${m.name} (${m.code})` : "Merchant", devices: u._count.pushDevices };
      }),
    };
  }

  /** One test push to a person's phones. */
  async test(userId: string) {
    const result = await this.push.toUsers([userId], { title: "Test from Paira Express", body: "Push notifications are working.", data: { type: "test" } });
    if (!result.devices) throw new AppError("NO_DEVICES", "This person has no phone with the app signed in (or their merchant plan has no push notifications)", 422);
    return result;
  }
}
