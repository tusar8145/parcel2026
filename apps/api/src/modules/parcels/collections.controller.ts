import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { CollectionsService, collectSchema, listCollectionsQuerySchema } from "./collections.service";

/** Collect from hub (service packages): the hub counter. */
@ApiTags("collections")
@Controller()
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  /** Parcels waiting at the hub(s) for their recipients (hub operators: their hubs), soonest deadline first. */
  @RequirePermissions("parcel:read:any")
  @Get("ops/collections")
  @ApiZodQuery(listCollectionsQuerySchema)
  list(@CurrentActor() actor: Actor, @ZQuery(listCollectionsQuerySchema) query: z.infer<typeof listCollectionsQuerySchema>) {
    return this.collections.list(actor, query);
  }

  /** Hands a "Ready for collection" parcel over at the counter (collection code, or photo / signature) and takes the COD into hub cash. */
  @RequirePermissions("parcel:dispatch")
  @Post("parcels/:trackingId/collect")
  @HttpCode(200)
  @ApiZodBody(collectSchema)
  collect(@CurrentUser() actor: UserActor, @Param("trackingId") trackingId: string, @ZBody(collectSchema) body: z.infer<typeof collectSchema>, @ReqMeta() meta: RequestMeta) {
    return this.collections.collect(actor, trackingId, body, meta);
  }

  /** A new collection code, sent to the recipient by SMS again. */
  @RequirePermissions("parcel:dispatch")
  @Post("parcels/:trackingId/collection-code")
  @HttpCode(200)
  resendCode(@CurrentActor() actor: Actor, @Param("trackingId") trackingId: string, @ReqMeta() meta: RequestMeta) {
    return this.collections.resendCode(actor, trackingId, meta);
  }
}
