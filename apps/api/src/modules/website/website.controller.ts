import { Controller, Get, Header, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { CurrentActor, Public, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ZBody } from "../../common/zod";
import { WebsiteService, websiteSettingsSchema } from "./website.service";

/** Website settings: sign-up switches, "Send a parcel" and the editable pages. */
@ApiTags("website")
@Controller("website")
export class WebsiteController {
  constructor(private readonly website: WebsiteService) {}

  /** What the public pages show (the web app caches it and clears the cache when it is saved). */
  @Public()
  @Get()
  @Header("Cache-Control", "no-cache")
  view() {
    return this.website.view();
  }

  /** The switches only. */
  @Public()
  @Get("status")
  @Header("Cache-Control", "no-cache")
  status() {
    return this.website.status();
  }

  @RequirePermissions("config:manage")
  @Get("admin")
  admin() {
    return this.website.admin();
  }

  @RequirePermissions("config:manage")
  @Put()
  @ApiZodBody(websiteSettingsSchema)
  save(@CurrentActor() actor: Actor, @ZBody(websiteSettingsSchema) body: z.infer<typeof websiteSettingsSchema>, @ReqMeta() meta: RequestMeta) {
    return this.website.save(actor, body, meta);
  }
}
