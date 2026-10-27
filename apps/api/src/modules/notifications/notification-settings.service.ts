import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { RedisService } from "../../common/redis.service";
import { AuditService } from "../../common/audit.service";
import { AppError, notFound } from "../../common/errors";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { env } from "../../config/env";
import type { Prisma } from "../../generated/prisma/client";
import { NOTIFICATION_EVENTS, type NotificationEvent } from "./events";
import { CHANNEL_OF, COMMON_VARS, EVENT_CATALOG, EVENT_GROUPS, LEGACY_TOGGLE_EVENTS, OUTBOX_CHANNEL, channelsOf, definitionOf, type Channel, type EventDefinition } from "./catalog";
import { htmlFromText, placeholders, syntaxProblem } from "./render";
import { BrandingService } from "../branding/branding.service";

export const SETTINGS_KEY = "notification-settings";
const PLATFORM_CONFIG_KEY = "platform-config";
const VERSION_KEY = "notifications:config:version";
const MAX_AGE_MS = 30_000;

export const smsLimitsSchema = z.object({
  /** Non-urgent SMS to the same number wait at least this long after the previous one. */
  minIntervalSeconds: z.number().int().min(0).max(3600),
  perRecipientPerHour: z.number().int().min(1).max(1000),
  perRecipientPerDay: z.number().int().min(1).max(5000),
  /** Messages per minute through the gateway, platform-wide. */
  globalPerMinute: z.number().int().min(1).max(100_000),
});
export const otpLimitsSchema = z.object({
  /** Seconds before the same number may request another code (UIs show a countdown). */
  cooldownSeconds: z.number().int().min(15).max(900),
  perPhonePerHour: z.number().int().min(1).max(50),
  perIpPerHour: z.number().int().min(1).max(1000),
});
export const limitsSchema = z.object({ sms: smsLimitsSchema, otp: otpLimitsSchema });
export const brandSchema = z.object({
  appName: z.string().trim().min(1).max(40),
  /** How messages tell people to reach support, e.g. "16XXX" or "support@…". */
  support: z.string().trim().min(1).max(60),
});
export type SmsLimits = z.infer<typeof smsLimitsSchema>;
export type OtpLimits = z.infer<typeof otpLimitsSchema>;
export type Limits = z.infer<typeof limitsSchema>;
export type Brand = z.infer<typeof brandSchema>;

export const DEFAULT_LIMITS: Limits = {
  sms: { minIntervalSeconds: 20, perRecipientPerHour: 10, perRecipientPerDay: 30, globalPerMinute: 600 },
  otp: { cooldownSeconds: 60, perPhonePerHour: 5, perIpPerHour: 20 },
};
export const DEFAULT_BRAND: Brand = { appName: "Delivery Fast", support: "Delivery Fast support" };

interface TemplateOverride {
  enabled: boolean | null;
  subject: string | null;
  body: string | null;
  html: string | null;
  updatedAt: Date;
}

export interface Snapshot {
  overrides: Map<string, TemplateOverride>;
  limits: Limits;
  brand: Brand;
  /** Global channel switches from the super admin "Global notifications" page (platform-config.channels). */
  channels: { sms: boolean; email: boolean };
}

export interface ResolvedTemplate {
  enabled: boolean;
  locked: boolean;
  subject?: string;
  body: string;
  html?: string;
  customized: boolean;
}

const key = (event: string, channel: Channel) => `${event}:${channel}`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Templates, toggles, limits and brand settings, cached per process. Writes bump a Redis
 * version so every API/worker instance reloads on its next read.
 */
@Injectable()
export class NotificationSettingsService implements OnApplicationBootstrap {
  private readonly logger = new Logger("Notifications");
  private cache?: { version: string | null; at: number; snapshot: Snapshot };

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  async onApplicationBootstrap() {
    if (env().NODE_ENV === "test") return; // tests call migrateLegacyToggles() themselves
    await this.migrateLegacyToggles().catch(error => this.logger.warn({ err: error }, "Could not migrate legacy notification toggles"));
  }

  /** The company the platform runs for (Super admin › Branding & company; property injection). */
  @Inject(BrandingService) private readonly branding!: BrandingService;

  /**
   * The settings with the company: while "Name in messages" and the support line are still the defaults, they
   * follow the installation's company name ({{appName}}, {{support}}, the email header, PDF headers).
   */
  async snapshot(): Promise<Snapshot> {
    const s = await this.loadSnapshot();
    const name = (await this.branding.get()).companyName;
    if (name === DEFAULT_BRAND.appName) return s;
    return {
      ...s,
      brand: {
        appName: s.brand.appName === DEFAULT_BRAND.appName ? name.slice(0, 40) : s.brand.appName,
        support: s.brand.support === DEFAULT_BRAND.support ? `${name} support`.slice(0, 60) : s.brand.support,
      },
    };
  }

  private async loadSnapshot(): Promise<Snapshot> {
    const version = await this.redis.get(VERSION_KEY).catch(() => null);
    if (this.cache && this.cache.version === version && Date.now() - this.cache.at < MAX_AGE_MS) return this.cache.snapshot;
    const [rows, setting, platform] = await Promise.all([
      this.prisma.notificationTemplate.findMany(),
      this.prisma.setting.findUnique({ where: { key: SETTINGS_KEY } }),
      this.prisma.setting.findUnique({ where: { key: PLATFORM_CONFIG_KEY } }),
    ]);
    const stored = isObject(setting?.value) ? setting.value : {};
    const limits = limitsSchema.safeParse(stored.limits);
    const brand = brandSchema.safeParse(stored.brand);
    const channels = isObject(platform?.value) && isObject(platform.value.channels) ? platform.value.channels : {};
    const snapshot: Snapshot = {
      overrides: new Map(rows.map(r => [key(r.event, CHANNEL_OF[r.channel]), { enabled: r.enabled, subject: r.subject, body: r.body, html: r.html, updatedAt: r.updatedAt }])),
      limits: limits.success ? limits.data : DEFAULT_LIMITS,
      brand: brand.success ? brand.data : DEFAULT_BRAND,
      channels: { sms: channels.sms !== false, email: channels.email !== false },
    };
    this.cache = { version, at: Date.now(), snapshot };
    return snapshot;
  }

  async invalidate() {
    this.cache = undefined;
    await this.redis.incr(VERSION_KEY).catch(() => undefined);
  }

  async limits() {
    return (await this.snapshot()).limits;
  }

  /** The template to use for an event × channel (override or default), or undefined if the event has none. */
  resolve(snapshot: Snapshot, event: string, channel: Channel): ResolvedTemplate | undefined {
    const def = definitionOf(event);
    const defaults = def && defaultTemplate(def, channel);
    if (!def || !defaults) return undefined;
    const o = snapshot.overrides.get(key(event, channel));
    const locked = !!def.mandatory;
    const enabledByAdmin = o?.enabled ?? !def.defaultOff?.includes(channel);
    return {
      enabled: locked || (enabledByAdmin && snapshot.channels[channel]),
      locked,
      subject: channel === "email" ? (o?.subject ?? defaults.subject) : undefined,
      body: o?.body ?? defaults.body,
      html: channel === "email" ? (o?.html ?? defaults.html) : undefined,
      customized: !!o && (o.subject !== null || o.body !== null || o.html !== null),
    };
  }

  // ───────────── admin views ─────────────

  async catalog() {
    const snapshot = await this.snapshot();
    return {
      channels: snapshot.channels,
      commonVars: COMMON_VARS,
      /** Section order for the admin list. */
      groups: EVENT_GROUPS,
      events: [...NOTIFICATION_EVENTS].sort((a, b) => EVENT_GROUPS.indexOf(EVENT_CATALOG[a].group) - EVENT_GROUPS.indexOf(EVENT_CATALOG[b].group)).map(event => {
        const def = EVENT_CATALOG[event];
        return {
          event,
          label: def.label,
          group: def.group,
          audience: def.audience,
          mandatory: !!def.mandatory,
          vars: def.vars,
          required: def.required ?? [],
          sample: def.sample,
          channels: Object.fromEntries(
            channelsOf(def).map(channel => {
              const t = this.resolve(snapshot, event, channel)!;
              const o = snapshot.overrides.get(key(event, channel));
              return [channel, { ...t, enabledByAdmin: o?.enabled ?? !def.defaultOff?.includes(channel), default: defaultTemplate(def, channel), updatedAt: o?.updatedAt ?? null }];
            }),
          ),
        };
      }),
    };
  }

  async updateTemplate(actor: Actor, event: string, channel: Channel, input: { enabled?: boolean; subject?: string | null; body?: string | null; html?: string | null }, meta: RequestMeta) {
    const def = definitionOf(event);
    if (!def) throw notFound("Notification event");
    const defaults = defaultTemplate(def, channel);
    if (!defaults) throw new AppError("CHANNEL_NOT_AVAILABLE", `"${def.label}" has no ${channel === "sms" ? "SMS" : "email"} template`, 422);
    if (input.enabled === false && def.mandatory)
      throw new AppError("NOTIFICATION_LOCKED", `"${def.label}" is a security message and can't be switched off`, 422);
    if (channel === "sms" && (input.subject || input.html)) throw new AppError("VALIDATION_FAILED", "SMS templates have text only", 422);
    const allowed = new Set([...def.vars, ...COMMON_VARS]);
    for (const [field, text] of [["subject", input.subject], ["body", input.body], ["html", input.html]] as const) {
      if (typeof text !== "string") continue;
      const problem = syntaxProblem(text);
      if (problem) throw new AppError("INVALID_TEMPLATE", `${field}: ${problem}`, 422, [{ path: field, message: problem }]);
      const unknown = placeholders(text).filter(v => !allowed.has(v));
      if (unknown.length) throw new AppError("INVALID_TEMPLATE", `${field}: unknown placeholder ${unknown.map(v => `{{${v}}}`).join(", ")}`, 422, [{ path: field, message: `Unknown: ${unknown.join(", ")}` }]);
    }
    const textToCheck = input.body ?? null;
    if (typeof textToCheck === "string")
      for (const required of def.required ?? [])
        if (!placeholders(textToCheck).includes(required))
          throw new AppError("INVALID_TEMPLATE", `The ${channel === "sms" ? "SMS" : "email text"} must include {{${required}}}`, 422, [{ path: "body", message: `Include {{${required}}}` }]);
    const data = {
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.html !== undefined ? { html: input.html } : {}),
      updatedById: actor.kind === "user" ? actor.userId : null,
    };
    await this.prisma.$transaction(async tx => {
      await tx.notificationTemplate.upsert({
        where: { event_channel: { event, channel: OUTBOX_CHANNEL[channel] } },
        create: { event, channel: OUTBOX_CHANNEL[channel], ...data },
        update: data,
      });
      await this.audit.record(
        actor,
        { action: "notification_template.update", entityType: "notification_template", entityId: key(event, channel), data: { fields: Object.keys(input), enabled: input.enabled ?? null } },
        meta,
        tx,
      );
    });
    await this.invalidate();
    return this.eventView(event);
  }

  /** Back to the default text (the on/off switch is kept). */
  async resetTemplate(actor: Actor, event: string, channel: Channel, meta: RequestMeta) {
    if (!definitionOf(event)) throw notFound("Notification event");
    await this.prisma.$transaction(async tx => {
      await tx.notificationTemplate.updateMany({ where: { event, channel: OUTBOX_CHANNEL[channel] }, data: { subject: null, body: null, html: null } });
      await this.audit.record(actor, { action: "notification_template.reset", entityType: "notification_template", entityId: key(event, channel) }, meta, tx);
    });
    await this.invalidate();
    return this.eventView(event);
  }

  private async eventView(event: string) {
    return (await this.catalog()).events.find(e => e.event === event)!;
  }

  async settings() {
    const s = await this.snapshot();
    return { limits: s.limits, brand: s.brand, defaults: { limits: DEFAULT_LIMITS, brand: DEFAULT_BRAND } };
  }

  async saveSettings(actor: Actor, input: { limits?: Limits; brand?: Brand }, meta: RequestMeta) {
    await this.prisma.$transaction(async tx => {
      const previous = await tx.setting.findUnique({ where: { key: SETTINGS_KEY } });
      const value = { ...(isObject(previous?.value) ? previous.value : {}), ...input } as Prisma.InputJsonObject;
      await tx.setting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value }, update: { value } });
      await this.audit.record(actor, { action: "notification_settings.update", entityType: "setting", entityId: SETTINGS_KEY, data: input as Prisma.InputJsonObject }, meta, tx);
    });
    await this.invalidate();
    return this.settings();
  }

  /**
   * One-time: events switched off on the old "Global notifications" page (platform-config
   * notifications[], by display name) become template toggles. Idempotent.
   */
  async migrateLegacyToggles(): Promise<number> {
    const setting = await this.prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
    const stored = isObject(setting?.value) ? setting.value : {};
    if (stored.legacyTogglesMigrated) return 0;
    const platform = await this.prisma.setting.findUnique({ where: { key: PLATFORM_CONFIG_KEY } });
    const list = isObject(platform?.value) && Array.isArray(platform.value.notifications) ? platform.value.notifications : [];
    let changed = 0;
    await this.prisma.$transaction(async tx => {
      for (const item of list) {
        if (!isObject(item) || item.enabled !== false || typeof item.name !== "string") continue;
        for (const event of LEGACY_TOGGLE_EVENTS[item.name] ?? []) {
          const def = EVENT_CATALOG[event];
          if (def.mandatory) continue;
          for (const channel of channelsOf(def)) {
            await tx.notificationTemplate.upsert({
              where: { event_channel: { event, channel: OUTBOX_CHANNEL[channel] } },
              create: { event, channel: OUTBOX_CHANNEL[channel], enabled: false },
              update: { enabled: false },
            });
            changed++;
          }
        }
      }
      const value = { ...stored, legacyTogglesMigrated: true } as Prisma.InputJsonObject;
      await tx.setting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value }, update: { value } });
      if (changed) await this.audit.record("system", { action: "notification_template.migrate_legacy", entityType: "setting", entityId: SETTINGS_KEY, data: { changed } }, undefined, tx);
    });
    if (changed) this.logger.log(`Migrated ${changed} notification toggles from the platform settings`);
    await this.invalidate();
    return changed;
  }
}

/** The code default for an event × channel. */
export function defaultTemplate(def: EventDefinition, channel: Channel): { subject?: string; body: string; html?: string } | undefined {
  if (channel === "sms") return def.sms !== undefined ? { body: def.sms } : undefined;
  if (!def.email) return undefined;
  return { subject: def.email.subject, body: def.email.text, html: def.email.html ?? htmlFromText(def.email.text) };
}

export const isMandatory = (event: string) => !!definitionOf(event)?.mandatory;
export const eventChannels = (event: NotificationEvent) => channelsOf(EVENT_CATALOG[event]);
