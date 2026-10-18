import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { periodChecks, periodQueryShape, periodView, resolvePeriod } from "../../common/period";

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export const METRICS = { pageview: "pageview", visit: "visit", trackingLookup: "tracking_lookup" } as const;

export const pageviewSchema = z.object({
  path: z.string("Send the page path").trim().min(1).max(500),
  referrer: z.string().trim().max(1000).optional().nullable(),
});
/** `days`: the last N days (default 30). from / to (Dhaka days) instead: that period, with the previous one for comparison. */
export const trafficQuerySchema = z
  .object({ days: z.coerce.number().int().min(1).max(90).default(30), ...periodQueryShape })
  .superRefine(periodChecks);

/** Crawlers, link previews, monitors and automation: not counted. */
const BOT_UA =
  /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|headless|phantom|puppeteer|playwright|selenium|lighthouse|pagespeed|pingdom|uptime|monitor|curl|wget|python|httpclient|java\/|go-http|okhttp|axios|node-fetch|postman|insomnia/i;
const SEARCH = /(^|\.)(google|bing|yahoo|duckduckgo|baidu|yandex|ecosia|brave)\./i;
const SOCIAL = /(^|\.)(facebook|fb|instagram|linkedin|twitter|x|t|youtube|tiktok|whatsapp|messenger|pinterest|reddit)\.(com|co|me)$/i;

/** Dhaka calendar day (as a UTC midnight date for the DATE column). */
export const dhakaDay = (at = new Date()) => {
  const local = new Date(at.getTime() + DHAKA_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
};
const hourStart = (at = new Date()) => new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);

/**
 * Normalises a page path so no personal data is stored: query strings are dropped, the hash
 * route is kept to its first part, and segments that look like IDs (digits, long tokens)
 * become ":id". Returns null for anything that isn't a site path.
 */
export function normalizePath(raw: string): string | null {
  let value = raw.trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      value = url.pathname + url.hash;
    } catch {
      return null;
    }
  }
  if (!value.startsWith("/")) return null;
  const [beforeHash, hash = ""] = value.split("#", 2);
  const clean = (part: string) =>
    part
      .split("?")[0]
      .split("/")
      .filter(Boolean)
      .slice(0, 2)
      .map(seg => (/\d/.test(seg) || seg.length > 24 ? ":id" : seg.toLowerCase().replace(/[^a-z0-9._-]/g, "")))
      .filter(Boolean)
      .join("/");
  const path = `/${clean(beforeHash)}`;
  const route = hash.startsWith("/") ? clean(hash) : "";
  return (route ? `${path === "/" ? "/" : `${path}/`}#/${route}` : path).slice(0, 120);
}

/** Where a visit came from: direct, search, social, referral, or null for an internal navigation. */
export function sourceOf(referrer: string | null | undefined, hosts: (string | undefined)[]): "direct" | "search" | "social" | "referral" | null {
  if (!referrer) return "direct";
  let refHost: string;
  try {
    refHost = new URL(referrer).hostname.toLowerCase();
  } catch {
    return "direct";
  }
  const own = hosts.map(h => (h ?? "").split(",")[0].trim().split(":")[0].toLowerCase()).filter(Boolean);
  if (own.some(h => refHost === h || refHost.endsWith(`.${h}`))) return null;
  if (SEARCH.test(refHost)) return "search";
  if (SOCIAL.test(refHost)) return "social";
  return "referral";
}

/**
 * First-party website analytics: counters per Dhaka day and per hour, no cookies, no IPs, no
 * user ids. A "visit" is a page view that arrives from outside the site (or directly).
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  isBot(userAgent: string | undefined) {
    return !userAgent || userAgent.length < 10 || BOT_UA.test(userAgent);
  }

  /** `hosts`: this site's host names as the request shows them (Origin, X-Forwarded-Host, Host). */
  async pageview(input: z.infer<typeof pageviewSchema>, req: { userAgent?: string; hosts: (string | undefined)[] }) {
    if (this.isBot(req.userAgent)) return { counted: false };
    const path = normalizePath(input.path);
    if (!path) return { counted: false };
    const source = sourceOf(input.referrer, req.hosts);
    const rows: [string, string][] = [
      [METRICS.pageview, ""],
      [METRICS.pageview, `path:${path}`],
    ];
    if (source) rows.push([METRICS.visit, ""], [METRICS.visit, `source:${source}`]);
    await this.bump(rows, source ? [METRICS.pageview, METRICS.visit] : [METRICS.pageview]);
    return { counted: true };
  }

  /** A public tracking lookup (fire and forget). */
  countTrackingLookup() {
    void this.bump([[METRICS.trackingLookup, ""]], [METRICS.trackingLookup]).catch(err => this.logger.warn({ err }, "Could not count a tracking lookup"));
  }

  private async bump(daily: [string, string][], hourly: string[]) {
    // Literal values cast in SQL: "timestamp without time zone" columns hold UTC.
    const day = dhakaDay().toISOString().slice(0, 10);
    const hour = hourStart().toISOString();
    await this.prisma.$transaction([
      ...daily.map(
        ([metric, dimension]) => this.prisma.$executeRaw`
          INSERT INTO analytics_daily ("day", "metric", "dimension", "count") VALUES (${day}::date, ${metric}, ${dimension}, 1)
          ON CONFLICT ("day", "metric", "dimension") DO UPDATE SET "count" = analytics_daily."count" + 1`,
      ),
      ...hourly.map(
        metric => this.prisma.$executeRaw`
          INSERT INTO analytics_hourly ("hour", "metric", "count") VALUES ((${hour}::timestamptz AT TIME ZONE 'UTC'), ${metric}, 1)
          ON CONFLICT ("hour", "metric") DO UPDATE SET "count" = analytics_hourly."count" + 1`,
      ),
    ]);
  }

  /** Traffic for the super admin: last 24 hours by hour, last `days` days by day, top pages and sources. */
  /**
   * Traffic for a chosen period: daily rows from..to, totals for it and the previous period of the same
   * length, top pages and sources in it; the hourly chart is that day's 24 hours for a one-day period,
   * otherwise the last 24 hours.
   */
  async trafficForPeriod(query: { from: string; to: string }) {
    const p = resolvePeriod(query, "last_7_days");
    const date = (day: string) => new Date(`${day}T00:00:00Z`);
    const oneDay = p.days === 1;
    const since = oneDay ? p.start : hourStart(new Date(Date.now() - 23 * HOUR_MS));
    const [daily, hourly, dimensions] = await Promise.all([
      this.prisma.analyticsDaily.findMany({ where: { day: { gte: date(p.previous.from), lte: date(p.to) }, dimension: "" } }),
      this.prisma.analyticsHourly.findMany({ where: { hour: { gte: since, lt: new Date(since.getTime() + 24 * HOUR_MS) } } }),
      this.prisma.analyticsDaily.groupBy({ by: ["metric", "dimension"], where: { day: { gte: date(p.from), lte: date(p.to) }, dimension: { not: "" } }, _sum: { count: true } }),
    ]);
    const dayKey = (d: Date) => d.toISOString().slice(0, 10);
    const byDay = new Map<string, number>();
    for (const r of daily) byDay.set(`${dayKey(r.day)}|${r.metric}`, r.count);
    const rowsFor = (from: string, days: number) =>
      Array.from({ length: days }, (_, i) => {
        const day = dayKey(new Date(date(from).getTime() + i * DAY_MS));
        const get = (metric: string) => byDay.get(`${day}|${metric}`) ?? 0;
        return { day, pageviews: get(METRICS.pageview), visits: get(METRICS.visit), trackingLookups: get(METRICS.trackingLookup) };
      });
    const series = rowsFor(p.from, p.days);
    const previous = rowsFor(p.previous.from, p.days);
    const totals = (rows: typeof series) => ({
      pageviews: rows.reduce((a, r) => a + r.pageviews, 0),
      visits: rows.reduce((a, r) => a + r.visits, 0),
      trackingLookups: rows.reduce((a, r) => a + r.trackingLookups, 0),
    });
    const hours = Array.from({ length: 24 }, (_, i) => {
      const hour = new Date(since.getTime() + i * HOUR_MS);
      const get = (metric: string) => hourly.find(r => r.hour.getTime() === hour.getTime() && r.metric === metric)?.count ?? 0;
      return { hour: hour.toISOString(), pageviews: get(METRICS.pageview), visits: get(METRICS.visit), trackingLookups: get(METRICS.trackingLookup) };
    });
    const top = (prefix: string, metric: string, limit: number) =>
      dimensions
        .filter(d => d.metric === metric && d.dimension.startsWith(prefix))
        .map(d => ({ key: d.dimension.slice(prefix.length), count: d._sum.count ?? 0 }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
    return {
      generatedAt: new Date(),
      range: periodView(p),
      days: p.days,
      period: totals(series),
      previousPeriod: totals(previous),
      daily: series,
      hourly: hours,
      hourlyScope: oneDay ? ("day" as const) : ("last24h" as const),
      topPages: top("path:", METRICS.pageview, 10),
      sources: top("source:", METRICS.visit, 10),
    };
  }

  async traffic(days: number) {
    const today = dhakaDay();
    const from = new Date(today.getTime() - (days - 1) * DAY_MS);
    const since = hourStart(new Date(Date.now() - 23 * HOUR_MS));
    const [daily, hourly, dimensions] = await Promise.all([
      this.prisma.analyticsDaily.findMany({ where: { day: { gte: from }, dimension: "" } }),
      this.prisma.analyticsHourly.findMany({ where: { hour: { gte: since } } }),
      this.prisma.analyticsDaily.groupBy({ by: ["metric", "dimension"], where: { day: { gte: from }, dimension: { not: "" } }, _sum: { count: true } }),
    ]);
    const dayKey = (d: Date) => d.toISOString().slice(0, 10);
    const series = Array.from({ length: days }, (_, i) => {
      const day = dayKey(new Date(from.getTime() + i * DAY_MS));
      const get = (metric: string) => daily.find(r => dayKey(r.day) === day && r.metric === metric)?.count ?? 0;
      return { day, pageviews: get(METRICS.pageview), visits: get(METRICS.visit), trackingLookups: get(METRICS.trackingLookup) };
    });
    const hours = Array.from({ length: 24 }, (_, i) => {
      const hour = new Date(since.getTime() + i * HOUR_MS);
      const get = (metric: string) => hourly.find(r => r.hour.getTime() === hour.getTime() && r.metric === metric)?.count ?? 0;
      return { hour: hour.toISOString(), pageviews: get(METRICS.pageview), visits: get(METRICS.visit), trackingLookups: get(METRICS.trackingLookup) };
    });
    const sum = (rows: typeof series, key: "pageviews" | "visits" | "trackingLookups") => rows.reduce((a, r) => a + r[key], 0);
    const top = (prefix: string, metric: string, limit: number) =>
      dimensions
        .filter(d => d.metric === metric && d.dimension.startsWith(prefix))
        .map(d => ({ key: d.dimension.slice(prefix.length), count: d._sum.count ?? 0 }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
    const todayRow = series[series.length - 1];
    const last7 = series.slice(-7);
    return {
      generatedAt: new Date(),
      days,
      today: todayRow,
      last7Days: { pageviews: sum(last7, "pageviews"), visits: sum(last7, "visits"), trackingLookups: sum(last7, "trackingLookups") },
      period: { pageviews: sum(series, "pageviews"), visits: sum(series, "visits"), trackingLookups: sum(series, "trackingLookups") },
      daily: series,
      hourly: hours,
      topPages: top("path:", METRICS.pageview, 10),
      sources: top("source:", METRICS.visit, 10),
    };
  }
}
