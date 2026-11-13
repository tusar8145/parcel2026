import type { z } from "zod";
import { Controller, Get, HttpCode, Param, Post, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { PrismaService } from "../../common/prisma.service";
import { AppError, notFound } from "../../common/errors";
import { EVENT_CATALOG, type Channel } from "./catalog";
import type { NotificationEvent } from "./events";
import {
  channelSchema,
  emailGatewaySchema,
  eventSchema,
  outboxQuerySchema,
  outboxByMerchantQuerySchema,
  preferencesSchema,
  previewSchema,
  settingsSchema,
  smsGatewaySchema,
  testEmailSchema,
  testSmsSchema,
  updateTemplateSchema,
} from "./notifications.schemas";
import { NotificationSettingsService } from "./notification-settings.service";
import { GatewaysService } from "./gateways.service";
import { NotifyService } from "./notify.service";
import { PreferencesService } from "./preferences.service";
import { smsSegments } from "./render";
import { definitionOf } from "./catalog";
import { maskBody } from "../parcels/parcel-messages.service";

/** Dhaka days (inclusive) as a createdAt range. */
const dayRange = (from?: string, to?: string) => (from || to ? { gte: new Date(`${from ?? "2000-01-01"}T00:00:00+06:00`), lt: new Date(new Date(`${to ?? "2999-12-31"}T00:00:00+06:00`).getTime() + 86_400_000) } : null);

const TEST_SEND = { default: { limit: 10, ttl: 60_000 } };

function parseTarget(event: string, channel: string): { event: NotificationEvent; channel: Channel } {
  const e = eventSchema.safeParse(event);
  const c = channelSchema.safeParse(channel);
  if (!e.success || !c.success) throw notFound("Notification template");
  return { event: e.data, channel: c.data };
}

/** Super admin: gateways, templates, toggles and limits. */
@ApiTags("notifications")
@ApiBearerAuth()
@Controller("notifications")
@RequirePermissions("config:manage")
export class NotificationsAdminController {
  constructor(
    private readonly settings: NotificationSettingsService,
    private readonly gateways: GatewaysService,
    private readonly notify: NotifyService,
    private readonly prisma: PrismaService,
  ) {}

  /** Every event with its templates (current and default), variables and on/off state. */
  @Get("events")
  events() {
    return this.settings.catalog();
  }

  /** Edit a template and/or switch it on or off. null fields go back to the default text. Push (`/push`): on / off only. */
  @Put("templates/:event/:channel")
  @ApiZodBody(updateTemplateSchema)
  updateTemplate(
    @CurrentActor() actor: Actor,
    @Param("event") event: string,
    @Param("channel") channel: string,
    @ZBody(updateTemplateSchema) body: z.infer<typeof updateTemplateSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    if (channel === "push") {
      const e = eventSchema.safeParse(event);
      if (!e.success) throw notFound("Notification template");
      if (body.enabled === undefined || body.subject !== undefined || body.body !== undefined || body.html !== undefined)
        throw new AppError("VALIDATION_FAILED", "Push notifications use the in-app notification's text: only switch them on or off", 422);
      return this.settings.setPush(actor, e.data, body.enabled, meta);
    }
    const t = parseTarget(event, channel);
    return this.settings.updateTemplate(actor, t.event, t.channel, body, meta);
  }

  /** Back to the default text (keeps the on/off switch). */
  @Post("templates/:event/:channel/reset")
  @HttpCode(200)
  reset(@CurrentActor() actor: Actor, @Param("event") event: string, @Param("channel") channel: string, @ReqMeta() meta: RequestMeta) {
    const t = parseTarget(event, channel);
    return this.settings.resetTemplate(actor, t.event, t.channel, meta);
  }

  /** Renders a saved template or a draft with sample (or given) values. */
  @Post("preview")
  @HttpCode(200)
  @ApiZodBody(previewSchema)
  async preview(@ZBody(previewSchema) body: z.infer<typeof previewSchema>) {
    const def = EVENT_CATALOG[body.event];
    const rendered = await this.notify.render(body.event, body.channel, { name: "Nabila Ahmed", ...def.sample, ...body.vars }, { subject: body.subject, body: body.body, html: body.html });
    if (!rendered) throw notFound("Notification template");
    return { ...rendered, ...(body.channel === "sms" ? { sms: smsSegments(rendered.body) } : {}) };
  }

  @Get("settings")
  getSettings() {
    return this.settings.settings();
  }

  /** SMS rate limits, OTP limits and the names used in messages. */
  @Put("settings")
  @ApiZodBody(settingsSchema)
  saveSettings(@CurrentActor() actor: Actor, @ZBody(settingsSchema) body: z.infer<typeof settingsSchema>, @ReqMeta() meta: RequestMeta) {
    return this.settings.saveSettings(actor, body, meta);
  }

  /** Gateway status cards: configuration (secrets masked), mode, health and 24h counts. */
  @Get("gateways")
  gatewayStatus() {
    return this.gateways.status();
  }

  /** mram SMS settings. apiKey is write-only (omit to keep it). */
  @Put("gateways/sms")
  @ApiZodBody(smsGatewaySchema)
  saveSms(@CurrentActor() actor: Actor, @ZBody(smsGatewaySchema) body: z.infer<typeof smsGatewaySchema>, @ReqMeta() meta: RequestMeta) {
    return this.gateways.save(actor, "SMS", body, meta);
  }

  /** Mailjet settings. apiKey / apiSecret are write-only (omit to keep them). */
  @Put("gateways/email")
  @ApiZodBody(emailGatewaySchema)
  saveEmail(@CurrentActor() actor: Actor, @ZBody(emailGatewaySchema) body: z.infer<typeof emailGatewaySchema>, @ReqMeta() meta: RequestMeta) {
    return this.gateways.save(actor, "EMAIL", body, meta);
  }

  /** Sends ONE real SMS through the gateway to the number given (also in development). */
  @Throttle(TEST_SEND)
  @Post("gateways/sms/test")
  @HttpCode(200)
  @ApiZodBody(testSmsSchema)
  testSms(@CurrentActor() actor: Actor, @ZBody(testSmsSchema) body: z.infer<typeof testSmsSchema>, @ReqMeta() meta: RequestMeta) {
    return this.gateways.sendTest(actor, "SMS", body.phone, { body: body.message ?? "Delivery Fast test message: your SMS gateway works." }, meta);
  }

  /** Sends ONE real email through the gateway to the address given (also in development). */
  @Throttle(TEST_SEND)
  @Post("gateways/email/test")
  @HttpCode(200)
  @ApiZodBody(testEmailSchema)
  testEmail(@CurrentActor() actor: Actor, @ZBody(testEmailSchema) body: z.infer<typeof testEmailSchema>, @ReqMeta() meta: RequestMeta) {
    const text = body.message ?? "This is a test email from Delivery Fast. Your email gateway works.";
    return this.gateways.sendTest(actor, "EMAIL", body.email, { subject: body.subject ?? "Delivery Fast test email", body: text, html: `<p>${text.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</p>` }, meta);
  }

  /**
   * Recent messages: what was sent (the text, with codes and private links masked), the event, the parcel and its
   * merchant, to whom (masked) and how it went. Filters: channel, status, period (Dhaka days), merchant, search.
   */
  @Get("outbox")
  @ApiZodQuery(outboxQuerySchema)
  async outbox(@ZQuery(outboxQuerySchema) query: z.infer<typeof outboxQuerySchema>) {
    const range = dayRange(query.from, query.to);
    const term = query.q?.trim();
    const merchantTracking = query.merchantId ? (await this.prisma.parcel.findMany({ where: { merchantId: query.merchantId }, select: { trackingId: true }, take: 20_000 })).map(p => p.trackingId) : null;
    const rows = await this.prisma.outboxMessage.findMany({
      where: {
        channel: query.channel,
        state: query.state,
        ...(range ? { createdAt: range } : {}),
        ...(merchantTracking ? { trackingId: { in: merchantTracking } } : {}),
        ...(term ? { OR: [{ trackingId: { contains: term.toUpperCase() } }, { to: { contains: term.replace(/^0/, "") } }] } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: query.limit,
      select: { id: true, channel: true, to: true, template: true, body: true, subject: true, trackingId: true, state: true, attempts: true, lastError: true, provider: true, providerMessageId: true, notBefore: true, sentAt: true, createdAt: true },
    });
    const ids = [...new Set(rows.map(r => r.trackingId).filter((v): v is string => !!v))];
    const parcels = ids.length ? await this.prisma.parcel.findMany({ where: { trackingId: { in: ids } }, select: { trackingId: true, merchant: { select: { id: true, code: true, name: true } } } }) : [];
    const merchantOf = new Map(parcels.map(p => [p.trackingId, p.merchant]));
    return rows.map(({ body, ...r }) => ({
      ...r,
      to: r.channel === "SMS" ? r.to.replace(/^(\+8801\d)\d{5}(\d{3})$/, "$1•••••$2") : r.to.replace(/^(.).*(@.*)$/, "$1•••$2"),
      eventLabel: r.template.startsWith("broadcast:") ? "Message (Messaging)" : (definitionOf(r.template)?.label ?? r.template),
      text: maskBody(r.template, body).slice(0, 600),
      parts: r.channel === "SMS" ? smsSegments(body).segments : undefined,
      merchant: r.trackingId ? (merchantOf.get(r.trackingId) ?? null) : null,
    }));
  }

  /** How many SMS (or emails) each merchant's parcels got in a period (Dhaka days): sent, failed, waiting, SMS parts. */
  @Get("outbox/by-merchant")
  @ApiZodQuery(outboxByMerchantQuerySchema)
  async outboxByMerchant(@ZQuery(outboxByMerchantQuerySchema) query: z.infer<typeof outboxByMerchantQuerySchema>) {
    const range = dayRange(query.from, query.to)!;
    const rows = await this.prisma.$queryRaw<{ merchantId: string | null; total: number; sent: number; failed: number; pending: number }[]>`
      SELECT p."merchantId" AS "merchantId", count(*)::int AS total,
             (count(*) FILTER (WHERE o.state = 'SENT'))::int AS sent,
             (count(*) FILTER (WHERE o.state = 'FAILED'))::int AS failed,
             (count(*) FILTER (WHERE o.state = 'PENDING'))::int AS pending
      FROM outbox_messages o LEFT JOIN parcels p ON p."trackingId" = o."trackingId"
      WHERE o.channel::text = ${query.channel} AND o."createdAt" >= ${range.gte.toISOString()}::timestamp AND o."createdAt" < ${range.lt.toISOString()}::timestamp
      GROUP BY 1 ORDER BY total DESC`;
    const merchants = await this.prisma.merchant.findMany({ where: { id: { in: rows.map(r => r.merchantId).filter((v): v is string => !!v) } }, select: { id: true, code: true, name: true, type: true } });
    const byId = new Map(merchants.map(m => [m.id, m]));
    const items = rows.map(r => ({ merchant: r.merchantId ? (byId.get(r.merchantId) ?? null) : null, total: r.total, sent: r.sent, failed: r.failed, pending: r.pending }));
    return { channel: query.channel, from: query.from, to: query.to, total: items.reduce((a, r) => a + r.total, 0), items };
  }
}

/** The signed-in user's notification preferences. */
@ApiTags("profile")
@ApiBearerAuth()
@Controller("me")
export class NotificationPreferencesController {
  constructor(private readonly preferences: PreferencesService) {}

  /** Events that concern you, per channel: enabled, locked (security messages) and available (switched on by the platform). */
  @Get("notification-preferences")
  get(@CurrentUser() actor: UserActor) {
    return this.preferences.get(actor);
  }

  /** Switch notifications on or off. Security messages (codes, alerts) can't be switched off. */
  @Put("notification-preferences")
  @ApiZodBody(preferencesSchema)
  update(@CurrentUser() actor: UserActor, @ZBody(preferencesSchema) body: z.infer<typeof preferencesSchema>, @ReqMeta() meta: RequestMeta) {
    return this.preferences.update(actor, body, meta);
  }
}
