import type { z } from "zod";
import { Controller, Get, HttpCode, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { acceptSuggestionsSchema, geocodeSchema, mapQuerySchema, optimizeSchema, plansQuerySchema, suggestionsQuerySchema } from "./routing.schemas";
import { RoutingService } from "./routing.service";

/** Dispatch map, address geocoding, route optimisation and assignment suggestions. */
@ApiTags("routing")
@Controller("routing")
export class RoutingController {
  constructor(private readonly routing: RoutingService) {}

  /** Hubs, zone centres and open parcels with map pins. */
  @RequirePermissions("parcel:read:any", "hub:read")
  @Get("map")
  @ApiZodQuery(mapQuerySchema)
  map(@CurrentActor() actor: Actor, @ZQuery(mapQuerySchema) query: z.infer<typeof mapQuerySchema>) {
    return this.routing.map(actor, query);
  }

  /** Looks up missing delivery pins (cached on the parcel; zone centre when the address isn't found). */
  @RequirePermissions("parcel:dispatch")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("geocode")
  @HttpCode(200)
  @ApiZodBody(geocodeSchema)
  geocode(@CurrentActor() actor: Actor, @ZBody(geocodeSchema) body: z.infer<typeof geocodeSchema>) {
    return this.routing.geocodeParcels(actor, body);
  }

  /** Plans the rider's stop order (OSRM, nearest-neighbour fallback) and keeps it as today's plan. */
  @RequirePermissions("parcel:dispatch", "rider:read")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post("optimize")
  @HttpCode(200)
  @ApiZodBody(optimizeSchema)
  optimize(@CurrentActor() actor: Actor, @ZBody(optimizeSchema) body: z.infer<typeof optimizeSchema>, @ReqMeta() meta: RequestMeta) {
    return this.routing.optimize(actor, body, meta);
  }

  @RequirePermissions("parcel:read:any", "rider:read")
  @Get("plans")
  @ApiZodQuery(plansQuerySchema)
  plans(@CurrentActor() actor: Actor, @ZQuery(plansQuerySchema) query: z.infer<typeof plansQuerySchema>) {
    return this.routing.plans(actor, query);
  }

  /** A suggested rider for each unassigned parcel (zone, load, distance). */
  @RequirePermissions("parcel:dispatch", "rider:read")
  @Get("suggestions")
  @ApiZodQuery(suggestionsQuerySchema)
  suggestions(@CurrentActor() actor: Actor, @ZQuery(suggestionsQuerySchema) query: z.infer<typeof suggestionsQuerySchema>) {
    return this.routing.suggestions(actor, query);
  }

  /** Accepts suggestions in bulk: each is assigned through the normal parcel workflow. */
  @RequirePermissions("parcel:dispatch")
  @Post("suggestions/accept")
  @HttpCode(200)
  @ApiZodBody(acceptSuggestionsSchema)
  accept(@CurrentActor() actor: Actor, @ZBody(acceptSuggestionsSchema) body: z.infer<typeof acceptSuggestionsSchema>, @ReqMeta() meta: RequestMeta) {
    return this.routing.accept(actor, body, meta);
  }
}
