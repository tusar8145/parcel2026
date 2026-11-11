import type { z } from "zod";
import { Controller, Get, HttpCode, Post, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ZBody } from "../../common/zod";
import { riderRouteSchema } from "./routing.schemas";
import { RoutingService } from "./routing.service";
import { AddressAiService, updateAddressAiSettingsSchema } from "./address-ai.service";

/** Rider app › Best route: the rider's own stops in the best order (the same planner as Courier Operations). */
@ApiTags("routing")
@Controller("rider/route")
export class RiderRouteController {
  constructor(private readonly routing: RoutingService) {}

  /** Today's latest plan (the delivery list follows its order). */
  @RequirePermissions("parcel:rider-update")
  @Get()
  plan(@CurrentUser() actor: UserActor) {
    return this.routing.riderPlan(actor.userId);
  }

  /** Plans the rider's open stops from where they are now. Addresses not on the map yet are looked up first (slower). */
  @RequirePermissions("parcel:rider-update")
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Post()
  @HttpCode(200)
  @ApiZodBody(riderRouteSchema)
  optimize(@CurrentUser() actor: UserActor, @ZBody(riderRouteSchema) body: z.infer<typeof riderRouteSchema>, @ReqMeta() meta: RequestMeta) {
    return this.routing.riderOptimize(actor, actor.userId, body, meta);
  }
}

/** Operational settings › AI address reading: on / off, limits and usage. */
@ApiTags("routing")
@Controller("routing/address-ai")
export class AddressAiController {
  constructor(private readonly ai: AddressAiService) {}

  @RequirePermissions("config:manage")
  @Get()
  overview() {
    return this.ai.overview();
  }

  @RequirePermissions("config:manage")
  @Put()
  @ApiZodBody(updateAddressAiSettingsSchema)
  save(@CurrentActor() actor: Actor, @ZBody(updateAddressAiSettingsSchema) body: z.infer<typeof updateAddressAiSettingsSchema>, @ReqMeta() meta: RequestMeta) {
    return this.ai.saveSettings(actor, body, meta);
  }
}
