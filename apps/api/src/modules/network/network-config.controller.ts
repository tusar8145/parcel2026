import type { z } from "zod";
import { Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { listRoutesQuerySchema, listZonesQuerySchema, routeSchema, updateRouteSchema, updateZoneSchema, zoneSchema } from "./network-config.schemas";
import { NetworkConfigService } from "./network-config.service";

/** Delivery zones (areas → zone → hub), operating routes and hub capacity. */
@ApiTags("network")
@Controller()
export class NetworkConfigController {
  constructor(private readonly config: NetworkConfigService) {}

  @RequirePermissions("hub:read")
  @Get("zones")
  @ApiZodQuery(listZonesQuerySchema)
  zones(@ZQuery(listZonesQuerySchema) query: z.infer<typeof listZonesQuerySchema>) {
    return this.config.listZones(query);
  }

  @RequirePermissions("hub:manage")
  @Post("zones")
  @ApiZodBody(zoneSchema)
  createZone(@CurrentActor() actor: Actor, @ZBody(zoneSchema) body: z.infer<typeof zoneSchema>, @ReqMeta() meta: RequestMeta) {
    return this.config.createZone(actor, body, meta);
  }

  @RequirePermissions("hub:manage")
  @Patch("zones/:id")
  @ApiZodBody(updateZoneSchema)
  updateZone(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(updateZoneSchema) body: z.infer<typeof updateZoneSchema>, @ReqMeta() meta: RequestMeta) {
    return this.config.updateZone(actor, id, body, meta);
  }

  @RequirePermissions("hub:manage")
  @Delete("zones/:id")
  deleteZone(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.config.deleteZone(actor, id, meta);
  }

  @RequirePermissions("hub:read")
  @Get("routes")
  @ApiZodQuery(listRoutesQuerySchema)
  routes(@ZQuery(listRoutesQuerySchema) query: z.infer<typeof listRoutesQuerySchema>) {
    return this.config.listRoutes(query);
  }

  @RequirePermissions("hub:manage")
  @Post("routes")
  @ApiZodBody(routeSchema)
  createRoute(@CurrentActor() actor: Actor, @ZBody(routeSchema) body: z.infer<typeof routeSchema>, @ReqMeta() meta: RequestMeta) {
    return this.config.createRoute(actor, body, meta);
  }

  @RequirePermissions("hub:manage")
  @Patch("routes/:id")
  @ApiZodBody(updateRouteSchema)
  updateRoute(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(updateRouteSchema) body: z.infer<typeof updateRouteSchema>, @ReqMeta() meta: RequestMeta) {
    return this.config.updateRoute(actor, id, body, meta);
  }

  @RequirePermissions("hub:manage")
  @Delete("routes/:id")
  deleteRoute(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.config.deleteRoute(actor, id, meta);
  }

  /** Load against capacity per hub (parcels held + inbound), with zone and route counts. */
  @RequirePermissions("hub:read")
  @Get("hubs/capacity")
  capacity(@CurrentActor() actor: Actor) {
    return this.config.hubCapacity(actor);
  }
}
