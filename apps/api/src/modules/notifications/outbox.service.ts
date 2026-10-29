import { Inject, Injectable, Logger } from "@nestjs/common";
import { withCompanyName } from "@paira-express/shared";
import { PrismaService, type Db } from "../../common/prisma.service";
import { QueueService } from "../../common/queues";
import { RedisService } from "../../common/redis.service";
import type { OutboxMessage } from "../../generated/prisma/client";
import { GatewaysService } from "./gateways.service";
import { NotificationSettingsService, isMandatory } from "./notification-settings.service";
import { SmsRateLimiter } from "./rate-limiter";
import { GatewayError, type SendResult } from "./providers";
import { BrandingService } from "../branding/branding.service";

export interface OutboxInput {
  channel: "SMS" | "EMAIL";
  to: string;
  /** Event key (or legacy template name). */
  template: string;
  body: string;
  subject?: string | null;
  html?: string | null;
  userId?: string | null;
  /** The parcel the message is about (the parcel's message log: GET /parcels/:trackingId/messages). */
  trackingId?: string | null;
}

const LOCK_MS = 90_000;

/**
 * Transactional outbox: messages are written in the caller's transaction, then queued
 * after commit (flush). The worker sends them in batches through the gateway (SMS rate
 * limits applied there); the sweeper re-queues anything a crash left behind.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly redis: RedisService,
    private readonly gateways: GatewaysService,
    private readonly settings: NotificationSettingsService,
    private readonly limiter: SmsRateLimiter,
  ) {}

  /** The company the platform runs for (property injection keeps the constructor stable). */
  @Inject(BrandingService) private readonly branding!: BrandingService;

  /**
   * Used by NotifyService only: other modules send through NotifyService (templates, switches, preferences).
   * The default company name in a message becomes the installation's own (Super admin › Branding & company).
   */
  async queue(db: Db, input: OutboxInput): Promise<string> {
    const name = (await this.branding.get()).companyName;
    const brand = (t: string | null | undefined) => (t == null ? null : withCompanyName(t, name));
    const message = await db.outboxMessage.create({
      data: { channel: input.channel, to: input.to, template: input.template, body: withCompanyName(input.body, name), subject: brand(input.subject), html: brand(input.html), userId: input.userId ?? null, trackingId: input.trackingId ?? null },
    });
    return message.id;
  }

  /** Queue messages created in a transaction that has now committed. */
  async flush(ids: string[]) {
    await Promise.all(
      ids.map(id =>
        this.queues
          .send("outbox", id)
          .catch(error => this.logger.warn({ err: error, id }, "Could not queue outbox message; the sweeper will retry")),
      ),
    );
  }

  /** Delivers one message (throws if it should be retried). */
  async deliver(id: string) {
    const failed = await this.deliverBatch([id]);
    const error = failed.get(id);
    if (error) throw new Error(error);
  }

  /**
   * Called by the worker with a batch of outbox ids. Sends what's due (SMS in as few
   * gateway requests as possible), reschedules SMS held back by rate limits, and returns
   * the ids that failed and should be retried, with the error.
   */
  async deliverBatch(ids: string[], finalAttempt: Set<string> = new Set()): Promise<Map<string, string>> {
    const failed = new Map<string, string>();
    const messages = await this.prisma.outboxMessage.findMany({ where: { id: { in: ids }, state: "PENDING" }, orderBy: { createdAt: "asc" } });
    const locked: string[] = [];
    const due: OutboxMessage[] = [];
    try {
      for (const m of messages) {
        if (m.notBefore && m.notBefore.getTime() > Date.now() + 500) {
          await this.queues.send("outbox", m.id, { startAfter: m.notBefore });
          continue;
        }
        // Another worker may hold the same message (duplicate job): skip it.
        if (!(await this.redis.set(`outbox:lock:${m.id}`, "1", "PX", LOCK_MS, "NX"))) continue;
        locked.push(m.id);
        due.push(m);
      }

      const sms: OutboxMessage[] = [];
      const limits = due.some(m => m.channel === "SMS") ? (await this.settings.limits()).sms : undefined;
      for (const m of due.filter(m => m.channel === "SMS")) {
        const decision = await this.limiter.check(m.to, isMandatory(m.template), limits!);
        if (decision.action === "send") sms.push(m);
        else if (decision.action === "wait") {
          const notBefore = new Date(Date.now() + decision.waitMs);
          await this.prisma.outboxMessage.update({ where: { id: m.id }, data: { notBefore } });
          await this.queues.send("outbox", m.id, { startAfter: notBefore });
          this.logger.debug(`SMS ${m.id} to ${m.to} waits ${Math.round(decision.waitMs / 1000)}s (${decision.reason})`);
        } else {
          await this.prisma.outboxMessage.update({ where: { id: m.id }, data: { state: "FAILED", lastError: `Not sent: ${decision.reason} reached` } });
          this.logger.warn(`SMS ${m.id} to ${m.to} dropped: ${decision.reason} reached`);
        }
      }
      const emails = due.filter(m => m.channel === "EMAIL");

      if (sms.length) {
        const gateway = await this.gateways.smsGateway();
        await this.apply("SMS", gateway.name, sms, () => gateway.sendSms(sms.map(m => ({ id: m.id, to: m.to, body: m.body }))), failed, finalAttempt);
      }
      if (emails.length) {
        const gateway = await this.gateways.emailGateway();
        const users = await this.prisma.user.findMany({ where: { id: { in: emails.map(m => m.userId).filter((v): v is string => !!v) } }, select: { id: true, name: true } });
        await this.apply(
          "EMAIL",
          gateway.name,
          emails,
          () =>
            gateway.sendEmail(
              emails.map(m => ({ id: m.id, to: m.to, toName: users.find(u => u.id === m.userId)?.name, subject: m.subject ?? "Paira Express", text: m.body, html: m.html ?? m.body })),
            ),
          failed,
          finalAttempt,
        );
      }
    } finally {
      if (locked.length) await this.redis.del(...locked.map(id => `outbox:lock:${id}`)).catch(() => undefined);
    }
    return failed;
  }

  private async apply(
    channel: "SMS" | "EMAIL",
    provider: string,
    messages: OutboxMessage[],
    send: () => Promise<SendResult[]>,
    failed: Map<string, string>,
    finalAttempt: Set<string>,
  ) {
    let results: SendResult[];
    try {
      results = await send();
    } catch (error) {
      const message = error instanceof GatewayError ? error.message : `Unexpected error: ${(error as Error).message}`;
      results = messages.map(m => ({ id: m.id, ok: false, error: message }));
      this.logger.warn({ err: error }, `${channel} gateway request failed`);
    }
    const now = new Date();
    for (const m of messages) {
      const r = results.find(x => x.id === m.id) ?? { id: m.id, ok: false, error: "No answer from the gateway for this message" };
      const common = { attempts: { increment: 1 }, provider, providerResponse: r.providerResponse ?? null };
      if (r.ok) {
        await this.prisma.outboxMessage.update({ where: { id: m.id }, data: { ...common, state: "SENT", sentAt: now, lastError: null, providerMessageId: r.providerMessageId ?? null } });
      } else if (r.permanent || finalAttempt.has(m.id)) {
        await this.prisma.outboxMessage.update({ where: { id: m.id }, data: { ...common, state: "FAILED", lastError: (r.error ?? "Rejected").slice(0, 500) } });
      } else {
        await this.prisma.outboxMessage.update({ where: { id: m.id }, data: { ...common, lastError: (r.error ?? "Failed").slice(0, 500) } });
        failed.set(m.id, r.error ?? "Failed");
      }
    }
    const firstError = results.find(r => !r.ok)?.error;
    if (results.some(r => r.ok)) await this.gateways.recordOutcome(channel, provider, true);
    if (firstError) await this.gateways.recordOutcome(channel, provider, false, firstError);
  }

  async markFailed(id: string) {
    await this.prisma.outboxMessage.update({ where: { id, state: "PENDING" }, data: { state: "FAILED" } }).catch(() => undefined);
  }

  /** Re-queue messages that were never attempted (e.g. the process died right after commit). */
  async sweep() {
    const cutoff = new Date(Date.now() - 120_000);
    const stale = await this.prisma.outboxMessage.findMany({
      where: {
        state: "PENDING",
        attempts: 0,
        createdAt: { lt: cutoff, gt: new Date(Date.now() - 86_400_000) },
        OR: [{ notBefore: null }, { notBefore: { lt: cutoff } }],
      },
      select: { id: true },
      take: 200,
    });
    if (stale.length) await this.flush(stale.map(m => m.id));
  }
}
