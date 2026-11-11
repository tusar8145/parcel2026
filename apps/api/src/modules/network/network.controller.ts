import type { z } from "zod";
import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { forbidden } from "../../common/errors";
import { appRiderSchema, createRiderSchema, hubSchema, riderPasswordSchema, listRidersQuerySchema, locateHubsSchema, riderStatusSchema, updateHubSchema, updateRiderSchema } from "./network.schemas";
import { HubLocateService } from "./hub-locate.service";
import { NetworkService } from "./network.service";

@ApiTags("network")
@Controller()
export class NetworkController {
  constructor(
    private readonly network: NetworkService,
    private readonly hubLocate: HubLocateService,
  ) {}

  /** Active hubs; any signed-in user (riders pick a hub when handing parcels over). */
  @Get("hubs")
  listHubs(@CurrentActor() actor: Actor, @Query("includeInactive") includeInactive?: string) {
    if (includeInactive === "true" && !actor.permissions.has("hub:manage")) throw forbidden();
    return this.network.listHubs(includeInactive === "true", actor.permissions.has("hub:manage"));
  }

  @RequirePermissions("hub:manage")
  @Post("hubs")
  @ApiZodBody(hubSchema)
  createHub(@CurrentActor() actor: Actor, @ZBody(hubSchema) body: z.infer<typeof hubSchema>, @ReqMeta() meta: RequestMeta) {
    return this.network.createHub(actor, body, meta);
  }

  /** Hubs without a map location get one (address → zone → zone centre); `overwrite`: every hub again. */
  @RequirePermissions("hub:manage")
  @Post("hubs/locate")
  @HttpCode(200)
  @ApiZodBody(locateHubsSchema)
  locateHubs(@CurrentActor() actor: Actor, @ZBody(locateHubsSchema) body: z.infer<typeof locateHubsSchema>, @ReqMeta() meta: RequestMeta) {
    return this.hubLocate.locate(actor, body, meta);
  }

  @RequirePermissions("hub:manage")
  @Patch("hubs/:id")
  @ApiZodBody(updateHubSchema)
  updateHub(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(updateHubSchema) body: z.infer<typeof updateHubSchema>, @ReqMeta() meta: RequestMeta) {
    return this.network.updateHub(actor, id, body, meta);
  }

  /** What references the hub (and how many records), e.g. before deleting it. */
  @RequirePermissions("hub:manage")
  @Get("hubs/:id/usage")
  hubUsage(@Param("id", ParseUUIDPipe) id: string) {
    return this.network.hubUsage(id);
  }

  /** Only a hub nothing references (409 IN_USE with the usage otherwise); deactivate it with PATCH { active: false }. */
  @RequirePermissions("hub:manage")
  @Delete("hubs/:id")
  deleteHub(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.network.deleteHub(actor, id, meta);
  }

  @RequirePermissions("rider:read")
  @Get("riders")
  @ApiZodQuery(listRidersQuerySchema)
  listRiders(@CurrentActor() actor: Actor, @ZQuery(listRidersQuerySchema) query: z.infer<typeof listRidersQuerySchema>) {
    return this.network.listRiders(query, actor);
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

  /** Operations app: add a rider with a password (operations managers anywhere, Hub Managers at their hub); no invitation. */
  @RequirePermissions("rider:read")
  @Post("riders/app")
  @ApiZodBody(appRiderSchema)
  createAppRider(@CurrentActor() actor: Actor, @ZBody(appRiderSchema) body: z.infer<typeof appRiderSchema>, @ReqMeta() meta: RequestMeta) {
    return this.network.createAppRider(actor, body, meta);
  }

  /** Operations app: a new password for a rider of the actor's hubs (operations managers: any rider). */
  @RequirePermissions("rider:read")
  @Post("riders/:id/password")
  @HttpCode(200)
  @ApiZodBody(riderPasswordSchema)
  setRiderPassword(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(riderPasswordSchema) body: z.infer<typeof riderPasswordSchema>, @ReqMeta() meta: RequestMeta) {
    return this.network.setRiderPassword(actor, id, body.password, meta);
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
