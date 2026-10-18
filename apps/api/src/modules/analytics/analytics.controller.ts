import { Controller, Get, HttpCode, Post, Req } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import { Public, RequirePermissions } from "../../common/auth/decorators";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { AnalyticsService, pageviewSchema, trafficQuerySchema } from "./analytics.service";

@ApiTags("analytics")
@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /**
   * A website page view (sent by the website itself). Counts only: no cookies, IPs or user ids
   * are stored, paths are stripped of query strings and IDs, bots are ignored.
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post("pageview")
  @HttpCode(202)
  @ApiZodBody(pageviewSchema)
  pageview(@ZBody(pageviewSchema) body: z.infer<typeof pageviewSchema>, @Req() req: FastifyRequest) {
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
    return this.analytics.pageview(body, { userAgent: header("user-agent"), hosts: [originHost, header("x-forwarded-host"), header("host")] });
  }

  /** Website traffic and tracking lookups (last 24 hours by hour, last `days` days by day; or the period from / to, Dhaka days). */
  @RequirePermissions("analytics:read")
  @Get("traffic")
  @ApiZodQuery(trafficQuerySchema)
  traffic(@ZQuery(trafficQuerySchema) query: z.infer<typeof trafficQuerySchema>) {
    return query.from && query.to ? this.analytics.trafficForPeriod({ from: query.from, to: query.to }) : this.analytics.traffic(query.days);
  }
}
