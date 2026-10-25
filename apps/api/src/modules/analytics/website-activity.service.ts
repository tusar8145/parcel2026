import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { PARCEL_STATUS_LABEL, type ParcelStatus } from "@delivery-fast/shared";
import { PrismaService } from "../../common/prisma.service";
import { RedisService } from "../../common/redis.service";
import { Prisma } from "../../generated/prisma/client";
import { addDays, dhakaDateRange, dhakaDayStart, dhakaMonthStart, dhakaWeekStart } from "../parcels/ops-scope";
import { dhakaDay, METRICS, normalizePath } from "./analytics.service";

export const pingSchema = z.object({
  /** A random id the open tab keeps for itself (sessionStorage); never stored beyond two minutes. */
  sid: z.string().trim().regex(/^[A-Za-z0-9_-]{8,40}$/, "Send the tab id"),
  path: z.string().trim().min(1).max(500),
});

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-25");
export const trackedParcelsQuerySchema = z
  .object({
    from: day,
    to: day,
    /** Tracking ID, recipient or sender. */
    q: z.string().trim().max(80).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .refine(v => v.to >= v.from, { message: "The end date can't be before the start", path: ["to"] });

const LIVE_SET = "analytics:live";
const LIVE_PATHS = "analytics:live:path";
/** A tab counts as online while it pinged in the last 70 seconds (it pings every 30). */
const ONLINE_MS = 70_000;
const MINUTE_KEY = (minute: number) => `analytics:pv:${minute}`;
/** The same parcel tracked again by the same visitor within 10 minutes (refreshes, live-location polling) isn't a new lookup. */
const REPEAT_SECONDS = 600;
const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`;

/**
 * Super admin › Platform activity, website side: who is on the site right now (tabs that pinged in the last
 * minute; a random tab id, kept two minutes in Redis), page views per minute, and which parcels were tracked on
 * the website (tracking_lookups: the parcel and the time, never the visitor).
 */
@Injectable()
export class WebsiteActivityService {
  private readonly logger = new Logger(WebsiteActivityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ───────────── recording ─────────────

  /** A parcel found on the public tracking page (fire and forget). `client`: IP and user agent, hashed for the 10-minute repeat check only. */
  recordTrackingLookup(trackingId: string, via: "search" | "link", client: { ip?: string; userAgent?: string }) {
    void (async () => {
      const parcel = await this.prisma.parcel.findUnique({ where: { trackingId }, select: { id: true } });
      if (!parcel) return;
      const who = createHash("sha256").update(`${client.ip ?? ""}|${client.userAgent ?? ""}`).digest("hex").slice(0, 24);
      const fresh = await this.redis.set(`analytics:seen:${parcel.id}:${who}`, "1", "EX", REPEAT_SECONDS, "NX");
      if (fresh !== "OK") return;
      await this.prisma.trackingLookup.create({ data: { parcelId: parcel.id, via } });
    })().catch(err => this.logger.warn({ err }, "Could not record a tracking lookup"));
  }

  /** One more page view this minute (the live chart). */
  countMinute() {
    const key = MINUTE_KEY(Math.floor(Date.now() / 60_000));
    void this.redis
      .multi()
      .incr(key)
      .expire(key, 3_900)
      .exec()
      .catch(err => this.logger.warn({ err }, "Could not count a live page view"));
  }

  /** An open website tab says it is still there, and on which page. */
  async ping(input: z.infer<typeof pingSchema>) {
    const path = normalizePath(input.path);
    if (!path) return { ok: false };
    await this.redis.multi().zadd(LIVE_SET, Date.now(), input.sid).hset(LIVE_PATHS, input.sid, path).expire(LIVE_SET, 120).expire(LIVE_PATHS, 120).exec();
    return { ok: true };
  }

  // ───────────── reading ─────────────

  /** Right now: tabs online and their pages, page views per minute (last 30), tracking lookups in the last hour, today's totals. */
  async live() {
    const now = Date.now();
    const cutoff = now - ONLINE_MS;
    const stale = await this.redis.zrangebyscore(LIVE_SET, "-inf", String(cutoff));
    if (stale.length) await this.redis.multi().zremrangebyscore(LIVE_SET, "-inf", String(cutoff)).hdel(LIVE_PATHS, ...stale).exec();
    const sids = await this.redis.zrange(LIVE_SET, "0", "-1");
    const paths = sids.length ? await this.redis.hmget(LIVE_PATHS, ...sids) : [];
    const pages = new Map<string, number>();
    for (const p of paths) pages.set(p ?? "/", (pages.get(p ?? "/") ?? 0) + 1);
    const minuteNow = Math.floor(now / 60_000);
    const minutes = Array.from({ length: 30 }, (_, i) => minuteNow - 29 + i);
    const counts = await this.redis.mget(...minutes.map(MINUTE_KEY));
    const hourAgo = new Date(now - 3_600_000);
    const [recent, lastHour, today] = await Promise.all([
      this.prisma.trackingLookup.findMany({ orderBy: { createdAt: "desc" }, take: 15, select: { parcelId: true, via: true, createdAt: true } }),
      this.prisma.trackingLookup.count({ where: { createdAt: { gte: hourAgo } } }),
      this.prisma.analyticsDaily.findMany({ where: { day: dhakaDay(), dimension: "" } }),
    ]);
    const parcels = await this.prisma.parcel.findMany({ where: { id: { in: recent.map(r => r.parcelId) } }, select: { id: true, trackingId: true, status: true } });
    const byId = new Map(parcels.map(p => [p.id, p]));
    const metric = (m: string) => today.find(r => r.metric === m)?.count ?? 0;
    return {
      at: new Date(now),
      online: sids.length,
      pages: [...pages.entries()].map(([path, visitors]) => ({ path, visitors })).sort((a, b) => b.visitors - a.visitors),
      perMinute: minutes.map((m, i) => ({ minute: new Date(m * 60_000), pageviews: Number(counts[i] ?? 0) })),
      lookupsLastHour: lastHour,
      today: { visits: metric(METRICS.visit), pageviews: metric(METRICS.pageview), trackingLookups: metric(METRICS.trackingLookup) },
      recentLookups: recent.map(r => {
        const p = byId.get(r.parcelId);
        return { trackingId: p?.trackingId ?? null, status: p ? PARCEL_STATUS_LABEL[p.status as ParcelStatus] : "Deleted", via: r.via, at: r.createdAt };
      }),
    };
  }

  /** Lookups and distinct parcels tracked: today, yesterday, this / last week, this / last month, last 30 days, this year, all time (Dhaka). */
  async trackingSummary() {
    const today = dhakaDayStart();
    const week = dhakaWeekStart();
    const month = dhakaMonthStart();
    const lastMonth = dhakaMonthStart(new Date(), -1);
    const yearDay = new Date(Date.now() + 6 * 3_600_000).getUTCFullYear();
    const [year] = dhakaDateRange(`${yearDay}-01-01`, `${yearDay}-01-01`);
    const ranges: Record<string, [Date | null, Date | null]> = {
      today: [today, null],
      yesterday: [addDays(today, -1), today],
      thisWeek: [week, null],
      lastWeek: [addDays(week, -7), week],
      thisMonth: [month, null],
      lastMonth: [lastMonth, month],
      last30Days: [addDays(today, -29), null],
      thisYear: [year, null],
      allTime: [null, null],
    };
    const parts = Object.entries(ranges).map(([key, [from, to]]) => {
      const cond = Prisma.sql`TRUE ${from ? Prisma.sql`AND "createdAt" >= ${ts(from)}` : Prisma.empty} ${to ? Prisma.sql`AND "createdAt" < ${ts(to)}` : Prisma.empty}`;
      return Prisma.sql`COUNT(*) FILTER (WHERE ${cond})::int AS ${Prisma.raw(`"${key}_n"`)}, COUNT(DISTINCT "parcelId") FILTER (WHERE ${cond})::int AS ${Prisma.raw(`"${key}_p"`)}`;
    });
    const [row] = await this.prisma.$queryRaw<Record<string, number>[]>`SELECT ${Prisma.join(parts)} FROM tracking_lookups`;
    return {
      periods: Object.fromEntries(
        Object.entries(ranges).map(([key, [from, to]]) => [key, { lookups: row?.[`${key}_n`] ?? 0, parcels: row?.[`${key}_p`] ?? 0, from, to }]),
      ),
    };
  }

  /** The parcels tracked on the website in the dates, latest first, a page at a time: how often, first / last time, current status. */
  async trackedParcels(query: z.infer<typeof trackedParcelsQuerySchema>) {
    const [start, end] = dhakaDateRange(query.from, query.to);
    const like = query.q ? `%${query.q.replace(/[%_\\]/g, m => `\\${m}`)}%` : null;
    const where = Prisma.sql`l."createdAt" >= ${ts(start)} AND l."createdAt" < ${ts(end)}
      AND (${like}::text IS NULL OR p."trackingId" ILIKE ${like} OR p."recipientName" ILIKE ${like} OR p."senderName" ILIKE ${like} OR m.name ILIKE ${like})`;
    const [rows, [total]] = await Promise.all([
      this.prisma.$queryRaw<{ parcel_id: string; lookups: number; links: number; first_at: Date; last_at: Date }[]>`
        SELECT l."parcelId" AS parcel_id, COUNT(*)::int AS lookups, COUNT(*) FILTER (WHERE l.via = 'link')::int AS links,
               MIN(l."createdAt") AS first_at, MAX(l."createdAt") AS last_at
        FROM tracking_lookups l JOIN parcels p ON p.id = l."parcelId" LEFT JOIN merchants m ON m.id = p."merchantId"
        WHERE ${where}
        GROUP BY l."parcelId" ORDER BY MAX(l."createdAt") DESC
        LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`,
      this.prisma.$queryRaw<{ parcels: number; lookups: number }[]>`
        SELECT COUNT(DISTINCT l."parcelId")::int AS parcels, COUNT(*)::int AS lookups
        FROM tracking_lookups l JOIN parcels p ON p.id = l."parcelId" LEFT JOIN merchants m ON m.id = p."merchantId"
        WHERE ${where}`,
    ]);
    const parcels = await this.prisma.parcel.findMany({
      where: { id: { in: rows.map(r => r.parcel_id) } },
      select: { id: true, trackingId: true, status: true, senderName: true, recipientName: true, deliveryZone: true, deliveryDistrict: true, createdAt: true, merchant: { select: { name: true } } },
    });
    const byId = new Map(parcels.map(p => [p.id, p]));
    return {
      from: query.from,
      to: query.to,
      page: query.page,
      limit: query.limit,
      total: total?.parcels ?? 0,
      lookups: total?.lookups ?? 0,
      pages: Math.max(1, Math.ceil((total?.parcels ?? 0) / query.limit)),
      items: rows.flatMap(r => {
        const p = byId.get(r.parcel_id);
        if (!p) return [];
        return [
          {
            trackingId: p.trackingId,
            status: PARCEL_STATUS_LABEL[p.status as ParcelStatus],
            sender: p.merchant?.name ?? p.senderName,
            recipient: p.recipientName,
            destination: [p.deliveryZone, p.deliveryDistrict].filter(Boolean).join(", "),
            bookedAt: p.createdAt,
            lookups: r.lookups,
            fromLink: r.links,
            firstAt: r.first_at,
            lastAt: r.last_at,
          },
        ];
      }),
    };
  }
}
