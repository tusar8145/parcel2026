import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError } from "../../common/errors";
import { decrypt, encrypt } from "../../common/crypto";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { isProduction } from "../../config/env";
import type { NotificationGateway, OutboxChannel, Prisma } from "../../generated/prisma/client";
import {
  GatewayError,
  LogEmailGateway,
  LogSmsGateway,
  MailjetEmailGateway,
  MramSmsGateway,
  type EmailGateway,
  type SendResult,
  type SmsGateway,
} from "./providers";

export const DEFAULT_MRAM_URL = "https://msg.mram.com.bd";
export const DEFAULT_MAILJET_URL = "https://api.mailjet.com";

const httpUrl = z.url({ protocol: /^https?$/ }).max(300);
export const smsGatewaySchema = z.object({
  enabled: z.boolean().optional(),
  /** Write-only. Omit to keep the stored key; "" removes it. */
  apiKey: z.string().trim().max(500).optional(),
  senderId: z.string().trim().max(30).optional(),
  baseUrl: httpUrl.optional(),
});
export const emailGatewaySchema = z.object({
  enabled: z.boolean().optional(),
  apiKey: z.string().trim().max(500).optional(),
  apiSecret: z.string().trim().max(500).optional(),
  fromEmail: z.email().max(200).optional(),
  fromName: z.string().trim().min(1).max(100).optional(),
  baseUrl: httpUrl.optional(),
});

interface Secrets {
  apiKey?: string;
  apiSecret?: string;
}
interface SmsConfig {
  senderId?: string;
  baseUrl?: string;
}
interface EmailConfig {
  fromEmail?: string;
  fromName?: string;
  baseUrl?: string;
}

const PROVIDER: Record<OutboxChannel, string> = { SMS: "mram", EMAIL: "mailjet" };
const CHANNEL_LABEL: Record<OutboxChannel, string> = { SMS: "SMS", EMAIL: "Email" };
const mask = (secret?: string) => (secret ? `${"•".repeat(8)}${secret.slice(-4)}` : null);

/** Gateway settings (encrypted at rest), the gateway to use right now, and health. */
@Injectable()
export class GatewaysService {
  private readonly logger = new Logger("Notifications");
  private lastFallbackWarning = 0;
  private cache = new Map<OutboxChannel, { at: number; row: NotificationGateway | null }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async row(channel: OutboxChannel, fresh = false) {
    const cached = this.cache.get(channel);
    if (!fresh && cached && Date.now() - cached.at < 10_000) return cached.row;
    const row = await this.prisma.notificationGateway.findUnique({ where: { channel } });
    this.cache.set(channel, { at: Date.now(), row });
    return row;
  }

  private secrets(row: NotificationGateway | null): Secrets {
    if (!row?.secretsEncrypted) return {};
    try {
      return JSON.parse(decrypt(row.secretsEncrypted)) as Secrets;
    } catch (error) {
      this.logger.error({ err: error }, `Stored ${row.channel} gateway secrets can't be decrypted (ENCRYPTION_KEY changed?)`);
      return {};
    }
  }

  private configured(channel: OutboxChannel, row: NotificationGateway | null) {
    const s = this.secrets(row);
    if (channel === "SMS") return !!(s.apiKey && (row?.config as SmsConfig)?.senderId);
    const c = (row?.config ?? {}) as EmailConfig;
    return !!(s.apiKey && s.apiSecret && c.fromEmail);
  }

  /** A real gateway client from the stored settings (throws if incomplete). */
  private client(channel: "SMS", row: NotificationGateway | null): SmsGateway;
  private client(channel: "EMAIL", row: NotificationGateway | null): EmailGateway;
  private client(channel: OutboxChannel, row: NotificationGateway | null): SmsGateway | EmailGateway {
    if (!this.configured(channel, row))
      throw new AppError("GATEWAY_NOT_CONFIGURED", `Enter the ${CHANNEL_LABEL[channel]} gateway credentials first`, 422);
    const s = this.secrets(row);
    if (channel === "SMS") {
      const c = row!.config as SmsConfig;
      return new MramSmsGateway({ apiKey: s.apiKey!, senderId: c.senderId!, baseUrl: c.baseUrl || DEFAULT_MRAM_URL });
    }
    const c = row!.config as EmailConfig;
    return new MailjetEmailGateway({ apiKey: s.apiKey!, apiSecret: s.apiSecret!, fromEmail: c.fromEmail!, fromName: c.fromName || "Paira Express", baseUrl: c.baseUrl || DEFAULT_MAILJET_URL });
  }

  /**
   * The gateway for normal traffic. Development and tests only log messages. Production sends
   * through the configured gateway when it's enabled, and otherwise logs with a warning.
   */
  async smsGateway(): Promise<SmsGateway> {
    return (await this.live("SMS")) ?? new LogSmsGateway();
  }

  async emailGateway(): Promise<EmailGateway> {
    return (await this.live("EMAIL")) ?? new LogEmailGateway();
  }

  private async live(channel: "SMS"): Promise<SmsGateway | undefined>;
  private async live(channel: "EMAIL"): Promise<EmailGateway | undefined>;
  private async live(channel: OutboxChannel): Promise<SmsGateway | EmailGateway | undefined> {
    if (!isProduction()) return undefined;
    const row = await this.row(channel);
    if (row?.enabled && this.configured(channel, row)) return channel === "SMS" ? this.client("SMS", row) : this.client("EMAIL", row);
    if (Date.now() - this.lastFallbackWarning > 60_000) {
      this.lastFallbackWarning = Date.now();
      this.logger.warn(`${CHANNEL_LABEL[channel]} gateway is not enabled/configured: messages are only written to the log. Configure it in super admin → Integrations.`);
    }
    return undefined;
  }

  /** Records the latest outcome for the status cards. */
  async recordOutcome(channel: OutboxChannel, gatewayName: string, ok: boolean, error?: string) {
    if (gatewayName === "log") return;
    await this.prisma.notificationGateway
      .update({
        where: { channel },
        data: ok ? { lastSuccessAt: new Date() } : { lastErrorAt: new Date(), lastError: (error ?? "Unknown error").slice(0, 500) },
      })
      .catch(() => undefined);
  }

  // ───────────── admin ─────────────

  async status() {
    const since = new Date(Date.now() - 86_400_000);
    const [rows, counts] = await Promise.all([
      this.prisma.notificationGateway.findMany(),
      this.prisma.outboxMessage.groupBy({ by: ["channel", "state"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    ]);
    const production = isProduction();
    return (["SMS", "EMAIL"] as const).map(channel => {
      const row = rows.find(r => r.channel === channel) ?? null;
      const secrets = this.secrets(row);
      const configured = this.configured(channel, row);
      const enabled = !!row?.enabled;
      const mode = production && enabled && configured ? "live" : "log";
      const warning = !production
        ? "Development: messages are only written to the API log. Use “Send test” to try the gateway."
        : !configured
          ? `Not configured: ${CHANNEL_LABEL[channel]} messages are only logged, nobody receives them.`
          : !enabled
            ? `Disabled: ${CHANNEL_LABEL[channel]} messages are only logged, nobody receives them.`
            : row?.lastErrorAt && (!row.lastSuccessAt || row.lastErrorAt > row.lastSuccessAt)
              ? `Last attempt failed: ${row.lastError}`
              : null;
      const count = (state: string) => counts.find(c => c.channel === channel && c.state === state)?._count._all ?? 0;
      const config = (row?.config ?? {}) as SmsConfig & EmailConfig;
      return {
        channel,
        provider: PROVIDER[channel],
        enabled,
        configured,
        mode,
        warning,
        settings:
          channel === "SMS"
            ? { senderId: config.senderId ?? "", baseUrl: config.baseUrl || DEFAULT_MRAM_URL, apiKey: mask(secrets.apiKey) }
            : {
                fromEmail: config.fromEmail ?? "",
                fromName: config.fromName ?? "Paira Express",
                baseUrl: config.baseUrl || DEFAULT_MAILJET_URL,
                apiKey: mask(secrets.apiKey),
                apiSecret: mask(secrets.apiSecret),
              },
        lastSuccessAt: row?.lastSuccessAt ?? null,
        lastErrorAt: row?.lastErrorAt ?? null,
        lastError: row?.lastError ?? null,
        updatedAt: row?.updatedAt ?? null,
        last24h: { sent: count("SENT"), failed: count("FAILED"), pending: count("PENDING") },
      };
    });
  }

  async save(actor: Actor, channel: OutboxChannel, input: z.infer<typeof smsGatewaySchema> & z.infer<typeof emailGatewaySchema>, meta: RequestMeta) {
    await this.prisma.$transaction(async tx => {
      const row = await tx.notificationGateway.findUnique({ where: { channel } });
      const secrets = { ...this.secrets(row) };
      for (const field of ["apiKey", "apiSecret"] as const) {
        if (input[field] === undefined) continue;
        if (input[field] === "") delete secrets[field];
        else secrets[field] = input[field];
      }
      const config: Record<string, string> = { ...((row?.config ?? {}) as Record<string, string>) };
      for (const field of channel === "SMS" ? (["senderId", "baseUrl"] as const) : (["fromEmail", "fromName", "baseUrl"] as const))
        if (input[field] !== undefined) config[field] = input[field]!;
      const data = {
        provider: PROVIDER[channel],
        enabled: input.enabled ?? row?.enabled ?? false,
        config: config as Prisma.InputJsonObject,
        secretsEncrypted: Object.keys(secrets).length ? encrypt(JSON.stringify(secrets)) : null,
        updatedById: actor.kind === "user" ? actor.userId : null,
      };
      if (data.enabled && !this.configured(channel, { ...(row ?? ({} as NotificationGateway)), ...data } as NotificationGateway))
        throw new AppError("GATEWAY_NOT_CONFIGURED", `Enter the ${CHANNEL_LABEL[channel]} gateway credentials before enabling it`, 422);
      await tx.notificationGateway.upsert({ where: { channel }, create: { channel, ...data }, update: data });
      // Never log secret values, only which fields changed.
      const changed = Object.keys(input).filter(k => input[k as keyof typeof input] !== undefined);
      await this.audit.record(actor, { action: "notification_gateway.update", entityType: "notification_gateway", entityId: channel, data: { changed, enabled: data.enabled } }, meta, tx);
    });
    this.cache.delete(channel);
    return (await this.status()).find(s => s.channel === channel)!;
  }

  /**
   * Sends one real message through the gateway, in every environment (the admin typed the
   * recipient). Returns the gateway's answer; never retried.
   */
  async sendTest(actor: Actor, channel: OutboxChannel, to: string, content: { body: string; subject?: string; html?: string }, meta: RequestMeta) {
    const row = await this.row(channel, true);
    let result: SendResult;
    try {
      result =
        channel === "SMS"
          ? (await this.client("SMS", row).sendSms([{ id: "test", to, body: content.body }]))[0]
          : (await this.client("EMAIL", row).sendEmail([{ id: "test", to, subject: content.subject ?? "Paira Express test email", text: content.body, html: content.html ?? `<p>${content.body}</p>` }]))[0];
    } catch (error) {
      if (error instanceof AppError) throw error;
      result = { id: "test", ok: false, error: error instanceof GatewayError ? error.message : `Unexpected error: ${(error as Error).message}` };
    }
    await this.recordOutcome(channel, "test", result.ok, result.error);
    await this.audit.record(actor, { action: "notification_gateway.test", entityType: "notification_gateway", entityId: channel, data: { ok: result.ok, error: result.error ?? null } }, meta);
    return { ok: result.ok, providerMessageId: result.providerMessageId ?? null, error: result.error ?? null, providerResponse: result.providerResponse ?? null };
  }
}
