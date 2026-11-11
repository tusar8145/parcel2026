import type { z } from "zod";
import { Controller, Get, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentActor, Public, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ZBody } from "../../common/zod";
import { AppVersionsService, appMinVersionsSchema } from "./app-versions.service";

@ApiTags("app-versions")
@Controller("app-versions")
export class AppVersionsController {
  constructor(private readonly versions: AppVersionsService) {}

  /** Each Android app's minimum version and download link (the apps' update page, super admin › Mobile apps). */
  @Public()
  @Get()
  view() {
    return this.versions.view();
  }

  /** Super admin: the lowest version of each app that may still be used (empty = no minimum). */
  @RequirePermissions("config:manage")
  @Put()
  @ApiZodBody(appMinVersionsSchema)
  set(@CurrentActor() actor: Actor, @ZBody(appMinVersionsSchema) body: z.infer<typeof appMinVersionsSchema>, @ReqMeta() meta: RequestMeta) {
    return this.versions.set(actor, body, meta);
  }
}
