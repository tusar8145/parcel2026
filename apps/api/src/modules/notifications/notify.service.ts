import { Injectable, Logger } from "@nestjs/common";
import { NOTIFICATION_SERVICE_OF_EVENT } from "@delivery-fast/shared";
import { PrismaService, type Db } from "../../common/prisma.service";
import { env } from "../../config/env";
import { OutboxService } from "./outbox.service";
import type { NotificationEvent } from "./events";
import { CHANNEL_OF, EVENT_CATALOG, OUTBOX_CHANNEL, channelsOf, type Channel } from "./catalog";
import { NotificationSettingsService, type Snapshot } from "./notification-settings.service";
import { emailLayout, escapeHtml, render, type Vars } from "./render";
import { InboxService } from "./inbox.service";

export interface NotifyInput {
  event: NotificationEvent;
  /** Who receives it. With userId, missing phone/email (and preferences) are looked up. */
  to: { userId?: string | null; phone?: string | null; email?: string | null; name?: string | null };
  /** Values for the template placeholders, e.g. { trackingId, amount, link }. */
  vars?: Record<string, string | number | null | undefined>;
  /** Restrict to these channels (default: whatever the event and settings allow). */
  channels?: ("sms" | "email")[];
  /**
   * Parcel messages: `Parcel.notifications`, the messages stored at booking (the ticked ones from the
   * package; empty when the product sends no messages). Parcels booked before packages (no version) aren't gated.
   */
  parcel?: { packageVersionId: string | null; notifications: readonly string[] } | null;
  /** Package-level messages (support, guest verification): the services of the recipient's package. */
  pkg?: { services: readonly string[] } | null;
}

export interface RenderedMessage {
  channel: Channel;
  subject?: string;
  body: string;
  html?: string;
}

/**
 * The one way modules send customer/staff notifications. Picks the template for the event,
 * applies admin toggles and user preferences, then writes outbox messages in the caller's
 * transaction (SMS rate limits are applied when the worker sends them). Returns outbox ids:
 * pass them to OutboxService.flush (or ParcelWorkflowService's AfterCommit.outbox) after commit.
 */
@Injectable()
export class NotifyService {
  private readonly logger = new Logger("Notifications");

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly settings: NotificationSettingsService,
    private readonly inbox: InboxService,
  ) {}

  async notify(db: Db, input: NotifyInput): Promise<string[]> {
    const def = EVENT_CATALOG[input.event];
    if (!def) {
      this.logger.warn(`Unknown notification event ${input.event}`);
      return [];
    }
    // Service packages (docs: "Service packages & pricing"): a parcel message goes only when it is in the
    // parcel's stored list (package, booking ticks and product switch were applied when it was stored).
    // Messages outside packages (sign-in codes…) pass.
    const service = NOTIFICATION_SERVICE_OF_EVENT[input.event];
    if (service && input.parcel?.packageVersionId && !input.parcel.notifications.includes(service)) return [];
    if (service && input.pkg && !input.pkg.services.includes(service)) return [];
    // In-app copy (the bell) for a known recipient: docs "In-app notifications" (in-app.ts has the rule).
    if (input.to.userId) await this.inbox.copyOf(db, input.event, input.to.userId, input.vars ?? {});
    const snapshot = await this.settings.snapshot();
    const wanted = channelsOf(def).filter(c => (!input.channels || input.channels.includes(c)) && this.settings.resolve(snapshot, input.event, c)?.enabled);
    if (!wanted.length) return [];

    // Recipient: explicit contact details win; a known user fills the gaps and brings preferences.
    let { phone = null, email = null, name = null } = input.to;
    let userId = input.to.userId ?? null;
    if (userId || (!def.mandatory && phone)) {
      const user = await db.user.findFirst({
        where: userId ? { id: userId } : { phone: phone! },
        select: { id: true, phone: true, email: true, name: true },
      });
      if (user) {
        userId = user.id;
        phone ??= user.phone;
        // Email only goes to the account's own address when we matched them by id or phone.
        email ??= user.email;
        name ??= user.name;
      }
    }
    let optedOut = new Set<Channel>();
    if (userId && !def.mandatory) {
      const prefs = await db.notificationPreference.findMany({ where: { userId, event: input.event, enabled: false }, select: { channel: true } });
      optedOut = new Set(prefs.map(p => CHANNEL_OF[p.channel]));
    }

    // Parcel messages are linked to their parcel (its message log in Courier Operations).
    const trackingId = typeof input.vars?.trackingId === "string" && input.vars.trackingId.trim() ? input.vars.trackingId.trim().toUpperCase().slice(0, 40) : null;
    const ids: string[] = [];
    for (const channel of wanted) {
      if (optedOut.has(channel)) continue;
      const to = channel === "sms" ? phone : email;
      if (!to) continue;
      const message = this.renderWith(snapshot, input.event, channel, { ...input.vars, name: name ?? input.vars?.name ?? "" });
      if (!message) continue;
      ids.push(
        await this.outbox.queue(db, {
          channel: OUTBOX_CHANNEL[channel],
          to,
          template: input.event,
          body: message.body,
          subject: message.subject,
          html: message.html,
          userId,
          trackingId,
        }),
      );
    }
    return ids;
  }

  /** Outside a transaction: write and queue immediately. */
  async notifyNow(input: NotifyInput): Promise<string[]> {
    const ids = await this.notify(this.prisma, input);
    await this.outbox.flush(ids);
    return ids;
  }

  /** Renders the current template (or the given draft) for an event × channel. */
  async render(event: NotificationEvent, channel: Channel, vars: Vars, draft?: { subject?: string; body?: string; html?: string }): Promise<RenderedMessage | undefined> {
    return this.renderWith(await this.settings.snapshot(), event, channel, vars, draft);
  }

  private renderWith(snapshot: Snapshot, event: NotificationEvent, channel: Channel, input: Vars, draft?: { subject?: string; body?: string; html?: string }): RenderedMessage | undefined {
    const template = this.settings.resolve(snapshot, event, channel);
    if (!template) return undefined;
    const brand = snapshot.brand;
    const vars: Vars = { appName: brand.appName, appUrl: env().APP_URL, support: brand.support, ...input };
    const body = render(draft?.body ?? template.body, vars).trim();
    if (channel === "sms") return { channel, body };
    const subject = render(draft?.subject ?? template.subject ?? "", vars).replace(/\s+/g, " ").trim();
    const html = emailLayout(render(draft?.html ?? template.html ?? "", vars, escapeHtml), { appName: brand.appName, appUrl: env().APP_URL, support: brand.support });
    return { channel, subject, body, html };
  }
}
