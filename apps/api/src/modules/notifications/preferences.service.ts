import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError } from "../../common/errors";
import type { UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { NOTIFICATION_EVENTS, type NotificationEvent } from "./events";
import { CHANNEL_OF, EVENT_CATALOG, OUTBOX_CHANNEL, channelsOf, type Channel, type EventDefinition } from "./catalog";
import { NotificationSettingsService } from "./notification-settings.service";

const STAFF = ["SUPER_ADMIN", "OPS_MANAGER", "HUB_OPERATOR", "FINANCE", "SUPPORT_AGENT"];
const MERCHANT = ["MERCHANT_OWNER", "MERCHANT_STAFF"];

/** Which groups of events concern someone with these roles. */
function relevant(def: EventDefinition, roles: string[]) {
  const has = (list: string[]) => roles.some(r => list.includes(r));
  switch (def.group) {
    case "Account & security":
    case "Parcel":
    case "Support":
    case "Partner":
      return true;
    case "Merchant":
    case "Finance":
      return has(MERCHANT) || has(STAFF);
    case "Rider":
      return roles.includes("RIDER");
    case "Operations":
      return has(STAFF);
  }
}

/** A user's own notification opt-outs. Security messages (codes, alerts) can't be switched off. */
@Injectable()
export class PreferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: NotificationSettingsService,
  ) {}

  async get(actor: UserActor) {
    const roles = actor.roles.map(r => r.role as string);
    const [rows, snapshot] = await Promise.all([this.prisma.notificationPreference.findMany({ where: { userId: actor.userId } }), this.settings.snapshot()]);
    const pref = (event: string, channel: Channel) => rows.find(r => r.event === event && CHANNEL_OF[r.channel] === channel)?.enabled;
    return {
      events: NOTIFICATION_EVENTS.filter(e => relevant(EVENT_CATALOG[e], roles)).map(event => {
        const def = EVENT_CATALOG[event];
        return {
          event,
          label: def.label,
          group: def.group,
          mandatory: !!def.mandatory,
          channels: Object.fromEntries(
            channelsOf(def).map(channel => {
              const platformOn = this.settings.resolve(snapshot, event, channel)?.enabled ?? false;
              return [channel, { enabled: def.mandatory ? true : (pref(event, channel) ?? true), locked: !!def.mandatory, available: platformOn }];
            }),
          ),
        };
      }),
    };
  }

  async update(actor: UserActor, input: { preferences: { event: string; channel: Channel; enabled: boolean }[] }, meta: RequestMeta) {
    for (const p of input.preferences) {
      const def = (EVENT_CATALOG as Record<string, EventDefinition | undefined>)[p.event];
      if (!def) throw new AppError("VALIDATION_FAILED", `Unknown notification ${p.event}`, 422, [{ path: "event", message: `Unknown: ${p.event}` }]);
      if (!channelsOf(def).includes(p.channel)) throw new AppError("VALIDATION_FAILED", `"${def.label}" isn't sent by ${p.channel === "sms" ? "SMS" : "email"}`, 422);
      if (def.mandatory && !p.enabled) throw new AppError("NOTIFICATION_LOCKED", `"${def.label}" is a security message and can't be switched off`, 422);
    }
    await this.prisma.$transaction(async tx => {
      for (const p of input.preferences) {
        const where = { userId_event_channel: { userId: actor.userId, event: p.event, channel: OUTBOX_CHANNEL[p.channel] } };
        // Only opt-outs are stored; switching back on removes the row.
        if (p.enabled) await tx.notificationPreference.deleteMany({ where: where.userId_event_channel });
        else await tx.notificationPreference.upsert({ where, create: { ...where.userId_event_channel, enabled: false }, update: { enabled: false } });
      }
      await this.audit.record(
        actor,
        { action: "notification_preferences.update", entityType: "user", entityId: actor.userId, data: { changes: input.preferences.map(p => `${p.event}:${p.channel}:${p.enabled ? "on" : "off"}`) } },
        meta,
        tx,
      );
    });
    return this.get(actor);
  }
}

export type { NotificationEvent };
