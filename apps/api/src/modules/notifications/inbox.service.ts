import { HttpStatus, Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import type { Role } from "@delivery-fast/shared";
import type { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { RealtimeService } from "../../common/realtime.service";
import { AppError } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import type { UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { NotificationEvent } from "./events";
import { EVENT_CATALOG, channelsOf } from "./catalog";
import { NotificationSettingsService } from "./notification-settings.service";
import { IN_APP, panelOf, panelUrl, type Panel, type Target } from "./in-app";
import type { listNotificationsQuerySchema } from "./inbox.schemas";

/** One in-app notification to write. `link` wins over `target` (resolved per recipient's panel). */
export interface InboxItem {
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  target?: Target;
  /** The panel the target is in (default: each recipient's own panel). */
  panel?: Panel;
}

/** Staff recipients by built-in role (custom roles count by their base role); hub roles optionally limited to hubs. */
export interface StaffAudience {
  roles: Role[];
  hubIds?: (string | null | undefined)[];
  /** Not this person (e.g. the maker of a change, the author of a reply). */
  except?: string | null;
}

const MAX_TITLE = 160;
const MAX_BODY = 500;
/** Checks after a write for the rows to be committed before announcing them (ms from the write). */
const ANNOUNCE_AFTER = [150, 1_000, 4_000, 12_000];

/**
 * Per-user in-app notifications: the bell and Notifications page of every panel (GET /me/notifications).
 *
 * Writers call `add` / `toStaff` / `toMerchant` with their transaction; the rows are announced on the live
 * stream (`notification.created`, to the recipients only) once they are committed, so a rolled-back change
 * never rings a bell. NotifyService writes the in-app copy of the events a user gets by SMS / email (in-app.ts).
 */
@Injectable()
export class InboxService implements OnModuleDestroy {
  private readonly logger = new Logger("InAppNotifications");
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly settings: NotificationSettingsService,
  ) {}

  onModuleDestroy() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /** Writes the item for each user (deduplicated); links resolve to each user's panel unless `link` / `panel` is given. */
  async add(db: Db, userIds: (string | null | undefined)[], item: InboxItem): Promise<number> {
    const ids = [...new Set(userIds.filter((id): id is string => !!id))];
    if (!ids.length) return 0;
    let panels = new Map<string, Panel>();
    if (!item.link && item.target && !item.panel) panels = await this.panelsOf(db, ids);
    const rows = await db.userNotification.createManyAndReturn({
      data: ids.map(userId => ({
        userId,
        type: item.type.slice(0, 80),
        title: item.title.slice(0, MAX_TITLE),
        body: item.body ? item.body.slice(0, MAX_BODY) : null,
        link: item.link ?? (item.target ? panelUrl(item.panel ?? panels.get(userId) ?? "/account", item.target) : null),
      })),
      select: { id: true },
    });
    this.announce(rows.map(r => r.id));
    return rows.length;
  }

  /** In-app copy of a NotifyService event for one user (in-app.ts decides the text; switched-off events get none). */
  async copyOf(db: Db, event: NotificationEvent, userId: string, vars: Record<string, string | number | null | undefined>) {
    const build = IN_APP[event];
    if (!build || !(await this.eventOn(event))) return;
    const roles = await db.userRole.findMany({ where: { userId }, select: { role: true, merchant: { select: { type: true } } } });
    const panel = panelOf(roles);
    const copy = build(vars, panel);
    await this.add(db, [userId], { type: event, title: copy.title, body: copy.body, target: copy.target ?? {}, panel });
  }

  /** Staff alerts: active users holding one of the roles (hub roles: only those hubs when given). */
  async toStaff(db: Db, audience: StaffAudience, item: InboxItem): Promise<number> {
    const hubIds = audience.hubIds?.filter((h): h is string => !!h);
    const grants = await db.userRole.findMany({
      where: {
        role: { in: audience.roles },
        user: { status: "ACTIVE" },
        ...(hubIds ? { OR: [{ role: { not: "HUB_OPERATOR" } }, { hubId: { in: hubIds } }] } : {}),
      },
      select: { userId: true },
    });
    return this.add(
      db,
      grants.map(g => g.userId).filter(id => id !== audience.except),
      item,
    );
  }

  /**
   * A merchant's team (owners and staff): their parcel outcomes and account events in the merchant panel.
   * NotifyService events follow the event's on/off switch.
   */
  async toMerchant(db: Db, merchantId: string, item: InboxItem & { event?: NotificationEvent }, opts: { ownersOnly?: boolean } = {}): Promise<number> {
    if (item.event && !(await this.eventOn(item.event))) return 0;
    const [merchant, members] = await Promise.all([
      db.merchant.findUnique({ where: { id: merchantId }, select: { type: true } }),
      db.userRole.findMany({
        where: { merchantId, role: { in: opts.ownersOnly ? ["MERCHANT_OWNER"] : ["MERCHANT_OWNER", "MERCHANT_STAFF"] }, user: { status: "ACTIVE" } },
        select: { userId: true },
      }),
    ]);
    if (!merchant || !members.length) return 0;
    const panel: Panel = merchant.type === "BANKING_FINANCIAL" ? "/banking-merchant" : "/ecommerce-merchant";
    return this.add(
      db,
      members.map(m => m.userId),
      { ...item, panel: item.panel ?? panel },
    );
  }

  /** The in-app copy of an event for a merchant's team (same text as a customer's; toMerchant links it to the merchant panel). */
  merchantCopy(event: NotificationEvent, vars: Record<string, string | number | null | undefined>): (InboxItem & { event: NotificationEvent }) | null {
    const build = IN_APP[event];
    if (!build) return null;
    const copy = build(vars, "/ecommerce-merchant");
    return { event, type: event, title: copy.title, body: copy.body, target: copy.target ?? {} };
  }

  // ───────────── the signed-in user's inbox ─────────────

  async list(actor: UserActor, query: z.infer<typeof listNotificationsQuerySchema>) {
    const rows = await this.prisma.userNotification.findMany({
      where: { userId: actor.userId, ...(query.unread ? { readAt: null } : {}) },
      ...pageArgs(query),
      select: { id: true, type: true, title: true, body: true, link: true, readAt: true, createdAt: true },
    });
    const page = toPage(rows, query.limit);
    return { ...page, unread: await this.unreadCount(actor.userId) };
  }

  async count(actor: UserActor) {
    return { unread: await this.unreadCount(actor.userId) };
  }

  async read(actor: UserActor, id: string, meta: RequestMeta) {
    const row = await this.prisma.userNotification.findFirst({ where: { id, userId: actor.userId }, select: { id: true, readAt: true } });
    if (!row) throw new AppError("NOT_FOUND", "Notification was not found", HttpStatus.NOT_FOUND);
    if (!row.readAt) {
      await this.prisma.$transaction(async tx => {
        await tx.userNotification.update({ where: { id }, data: { readAt: new Date() } });
        await this.audit.record(actor, { action: "notification.read", entityType: "user_notification", entityId: id }, meta, tx);
      });
      this.realtime.publish({ type: "notification.read", id, userIds: [actor.userId], staffPermission: NOBODY });
    }
    return { id, read: true, unread: await this.unreadCount(actor.userId) };
  }

  async readAll(actor: UserActor, meta: RequestMeta) {
    const updated = await this.prisma.$transaction(async tx => {
      const { count } = await tx.userNotification.updateMany({ where: { userId: actor.userId, readAt: null }, data: { readAt: new Date() } });
      if (count) await this.audit.record(actor, { action: "notification.read_all", entityType: "user", entityId: actor.userId, data: { count } }, meta, tx);
      return count;
    });
    if (updated) this.realtime.publish({ type: "notification.read", userIds: [actor.userId], staffPermission: NOBODY });
    return { updated, unread: 0 };
  }

  // ───────────── internals ─────────────

  private unreadCount(userId: string) {
    return this.prisma.userNotification.count({ where: { userId, readAt: null } });
  }

  /** On for at least one channel in super admin → Global notifications. */
  private async eventOn(event: NotificationEvent) {
    const def = EVENT_CATALOG[event];
    if (!def) return false;
    const snapshot = await this.settings.snapshot();
    return channelsOf(def).some(c => this.settings.resolve(snapshot, event, c)?.enabled);
  }

  private async panelsOf(db: Db, userIds: string[]) {
    const roles = await db.userRole.findMany({ where: { userId: { in: userIds } }, select: { userId: true, role: true, merchant: { select: { type: true } } } });
    const byUser = new Map<string, typeof roles>();
    for (const r of roles) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
    return new Map(userIds.map(id => [id, panelOf(byUser.get(id) ?? [])] as const));
  }

  /**
   * Announces committed rows to their recipients. Writers may still be inside a transaction, so the rows
   * are looked up (by primary key) a few times; rows that never appear were rolled back and stay silent.
   */
  private announce(ids: string[]) {
    let pending = new Set(ids);
    const check = async (attempt: number) => {
      try {
        const found = await this.prisma.userNotification.findMany({ where: { id: { in: [...pending] } }, select: { id: true, userId: true } });
        if (found.length) {
          for (const f of found) pending.delete(f.id);
          const users = [...new Set(found.map(f => f.userId))];
          this.realtime.publish({ type: "notification.created", userIds: users, staffPermission: NOBODY, data: { count: found.length } });
        }
      } catch (err) {
        this.logger.warn({ err }, "In-app notification announce failed");
      }
      if (pending.size && attempt + 1 < ANNOUNCE_AFTER.length) schedule(attempt + 1);
      else pending = new Set();
    };
    const schedule = (attempt: number) => {
      const delay = ANNOUNCE_AFTER[attempt] - (attempt ? ANNOUNCE_AFTER[attempt - 1] : 0);
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        void check(attempt);
      }, delay);
      timer.unref?.();
      this.timers.add(timer);
    };
    schedule(0);
  }
}

/** Realtime: no staff permission sees other people's notifications (only `userIds`). */
const NOBODY = "notification:own-only";
