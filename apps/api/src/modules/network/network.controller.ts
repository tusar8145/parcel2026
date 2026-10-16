import type { z } from "zod";
import { Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { forbidden } from "../../common/errors";
import { createRiderSchema, hubSchema, listRidersQuerySchema, riderStatusSchema, updateHubSchema, updateRiderSchema } from "./network.schemas";
import { NetworkService } from "./network.service";

@ApiTags("network")
@Controller()
export class NetworkController {
  constructor(private readonly network: NetworkService) {}

  /** Active hubs; any signed-in user (riders pick a hub when handing parcels over). */
  @Get("hubs")
  listHubs(@CurrentActor() actor: Actor, @Query("includeInactive") includeInactive?: string) {
    if (includeInactive === "true" && !actor.permissions.has("hub:manage")) throw forbidden();
    return this.network.listHubs(includeInactive === "true");
  }

  @RequirePermissions("hub:manage")
  @Post("hubs")
  @ApiZodBody(hubSchema)
  createHub(@CurrentActor() actor: Actor, @ZBody(hubSchema) body: z.infer<typeof hubSchema>, @ReqMeta() meta: RequestMeta) {
    return this.network.createHub(actor, body, meta);
  }

  @RequirePermissions("hub:manage")
  @Patch("hubs/:id")
  @ApiZodBody(updateHubSchema)
  updateHub(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(updateHubSchema) body: z.infer<typeof updateHubSchema>, @ReqMeta() meta: RequestMeta) {
    return this.network.updateHub(actor, id, body, meta);
  }

  @RequirePermissions("rider:read")
  @Get("riders")
  @ApiZodQuery(listRidersQuerySchema)
  listRiders(@ZQuery(listRidersQuerySchema) query: z.infer<typeof listRidersQuerySchema>) {
    return this.network.listRiders(query);
  }

  @RequirePermissions("rider:read")
  @Get("riders/:id")
  getRider(@Param("id", ParseUUIDPipe) id: string) {
    return this.network.getRider(id);
  }

  @RequirePermissions("rider:manage")
  @Post("riders")
  @ApiZodBody(createRiderSchema)
  createRider(@CurrentActor() actor: Actor, @ZBody(createRiderSchema) body: z.infer<typeof createRiderSchema>, @ReqMeta() meta: RequestMeta) {
    return this.network.createRider(actor, body, meta);
  }

  @RequirePermissions("rider:manage")
  @Patch("riders/:id")
  @ApiZodBody(updateRiderSchema)
  updateRider(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(updateRiderSchema) body: z.infer<typeof updateRiderSchema>, @ReqMeta() meta: RequestMeta) {
    return this.network.updateRider(actor, id, body, meta);
  }

  @RequirePermissions("parcel:rider-update")
  @Get("rider/me")
  me(@CurrentUser() actor: UserActor) {
    return this.network.myRiderProfile(actor);
  }

  @RequirePermissions("parcel:rider-update")
  @Patch("rider/me/status")
  @ApiZodBody(riderStatusSchema)
  setStatus(@CurrentUser() actor: UserActor, @ZBody(riderStatusSchema) body: { status: "OFFLINE" | "ONLINE" | "ON_BREAK" }) {
    return this.network.setMyStatus(actor, body.status);
  }
}
