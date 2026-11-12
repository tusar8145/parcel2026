import { z } from "zod";
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser, RequirePermissions } from "../../common/auth/decorators";
import type { UserActor } from "../../common/auth/actor";
import { ApiZodBody, ZBody } from "../../common/zod";
import { locationPointSchema } from "../rider/rider.schemas";
import { LiveMapService } from "./live-map.service";
import { StaffLocationService } from "./staff-location.service";

const day = z.iso.date().optional();

/** Super admin › Live map. */
@ApiTags("live-map")
@Controller("live-map")
export class LiveMapController {
  constructor(private readonly map: LiveMapService) {}

  /** Hubs, franchises, riders and Operations app users with their last positions. */
  @RequirePermissions("rider:manage", "user:read")
  @Get()
  overview() {
    return this.map.overview();
  }

  /** One rider's day (?date=YYYY-MM-DD, default today): path, parcels carried, parcels out with result and time taken. */
  @RequirePermissions("rider:manage")
  @Get("riders/:id")
  rider(@Param("id", ParseUUIDPipe) id: string, @Query("date") date?: string) {
    return this.map.rider(id, day.parse(date || undefined));
  }

  /** One staff member's path for a day. */
  @RequirePermissions("rider:manage", "user:read")
  @Get("staff/:userId")
  staff(@Param("userId", ParseUUIDPipe) userId: string, @Query("date") date?: string) {
    return this.map.staffPath(userId, day.parse(date || undefined));
  }
}

/** Operations app: the signed-in staff member's position while the app is open. */
@ApiTags("live-map")
@Controller("staff/location")
export class StaffLocationController {
  constructor(private readonly locations: StaffLocationService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post()
  @HttpCode(200)
  @ApiZodBody(locationPointSchema)
  record(@CurrentUser() actor: UserActor, @ZBody(locationPointSchema) body: z.infer<typeof locationPointSchema>) {
    return this.locations.record(actor, body);
  }
}
