import type { z } from "zod";
import { Controller, Get, HttpCode, Param, Post, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { PrismaService } from "../../common/prisma.service";
import { notFound } from "../../common/errors";
import { EVENT_CATALOG, type Channel } from "./catalog";
import type { NotificationEvent } from "./events";
import {
  channelSchema,
  emailGatewaySchema,
  eventSchema,
  outboxQuerySchema,
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

  /** Edit a template and/or switch it on or off. null fields go back to the default text. */
  @Put("templates/:event/:channel")
  @ApiZodBody(updateTemplateSchema)
  updateTemplate(
    @CurrentActor() actor: Actor,
    @Param("event") event: string,
    @Param("channel") channel: string,
    @ZBody(updateTemplateSchema) body: z.infer<typeof updateTemplateSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
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

  /** Recent messages (bodies hidden: they can contain codes). */
  @Get("outbox")
  @ApiZodQuery(outboxQuerySchema)
  async outbox(@ZQuery(outboxQuerySchema) query: z.infer<typeof outboxQuerySchema>) {
    const rows = await this.prisma.outboxMessage.findMany({
      where: { channel: query.channel, state: query.state },
      orderBy: { createdAt: "desc" },
      take: query.limit,
      select: { id: true, channel: true, to: true, template: true, state: true, attempts: true, lastError: true, provider: true, providerMessageId: true, notBefore: true, sentAt: true, createdAt: true },
    });
    return rows.map(r => ({ ...r, to: r.channel === "SMS" ? r.to.replace(/^(\+8801\d)\d{5}(\d{3})$/, "$1•••••$2") : r.to.replace(/^(.).*(@.*)$/, "$1•••$2") }));
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
