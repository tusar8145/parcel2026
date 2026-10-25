import { Controller, Get, HttpCode, Post, Req } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import { Public, RequirePermissions } from "../../common/auth/decorators";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { AnalyticsService, pageviewSchema, trafficQuerySchema } from "./analytics.service";
import { pingSchema, trackedParcelsQuerySchema, WebsiteActivityService } from "./website-activity.service";

@ApiTags("analytics")
@Controller("analytics")
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly website: WebsiteActivityService,
  ) {}

  /**
   * A website page view (sent by the website itself). Counts only: no cookies, IPs or user ids
   * are stored, paths are stripped of query strings and IDs, bots are ignored.
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post("pageview")
  @HttpCode(202)
  @ApiZodBody(pageviewSchema)
  async pageview(@ZBody(pageviewSchema) body: z.infer<typeof pageviewSchema>, @Req() req: FastifyRequest) {
    const header = (name: string) => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const origin = header("origin");
    let originHost: string | undefined;
    try {
      originHost = origin ? new URL(origin).host : undefined;
    } catch {
      originHost = undefined;
    }
    const counted = await this.analytics.pageview(body, { userAgent: header("user-agent"), hosts: [originHost, header("x-forwarded-host"), header("host")] });
    if (counted.counted) this.website.countMinute();
    return counted;
  }

  /** An open website tab is still there (every 30 s, with analytics consent): "visitors online now". A random tab id only. */
  @Public()
  // Several tabs behind one office / mobile network address: 2 pings a minute each.
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Post("ping")
  @HttpCode(202)
  @ApiZodBody(pingSchema)
  ping(@ZBody(pingSchema) body: z.infer<typeof pingSchema>, @Req() req: FastifyRequest) {
    const ua = req.headers["user-agent"];
    if (this.analytics.isBot(Array.isArray(ua) ? ua[0] : ua)) return { ok: false };
    return this.website.ping(body);
  }

  /** Live website: visitors online and their pages, page views per minute, the latest tracking lookups. */
  @RequirePermissions("analytics:read")
  @Get("live")
  live() {
    return this.website.live();
  }

  /** Parcels tracked on the website: lookups and parcels today, yesterday, this / last week, this / last month, last 30 days, this year, all time. */
  @RequirePermissions("analytics:read")
  @Get("tracking/summary")
  trackingSummary() {
    return this.website.trackingSummary();
  }

  /** The parcels tracked on the website in the dates (Dhaka), latest first, a page at a time. */
  @RequirePermissions("analytics:read")
  @Get("tracking/parcels")
  @ApiZodQuery(trackedParcelsQuerySchema)
  trackedParcels(@ZQuery(trackedParcelsQuerySchema) query: z.infer<typeof trackedParcelsQuerySchema>) {
    return this.website.trackedParcels(query);
  }

  /** Website traffic and tracking lookups (last 24 hours by hour, last `days` days by day; or the period from / to, Dhaka days). */
  @RequirePermissions("analytics:read")
  @Get("traffic")
  @ApiZodQuery(trafficQuerySchema)
  traffic(@ZQuery(trafficQuerySchema) query: z.infer<typeof trafficQuerySchema>) {
    return query.from && query.to ? this.analytics.trafficForPeriod({ from: query.from, to: query.to }) : this.analytics.traffic(query.days);
  }
}
