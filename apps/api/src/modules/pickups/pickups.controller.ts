import type { z } from "zod";
import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import {
  PickupsService,
  assignPickupRequestSchema,
  closePickupRequestSchema,
  generatePickupsSchema,
  listPickupRequestsQuerySchema,
  merchantSelector,
  pickupRequestSchema,
  pickupScheduleSchema,
  updatePickupScheduleSchema,
} from "./pickups.service";

type Selector = z.infer<typeof merchantSelector>;

/** Merchant pickup scheduling: recurring daily pickups and one-off pickup requests. */
@ApiTags("pickups")
@Controller("merchants/me")
export class MerchantPickupsController {
  constructor(private readonly pickups: PickupsService) {}

  @RequirePermissions("parcel:create")
  @Get("pickup-schedules")
  @ApiZodQuery(merchantSelector)
  schedules(@CurrentActor() actor: Actor, @ZQuery(merchantSelector) query: Selector) {
    return this.pickups.listSchedules(actor, query.merchantId);
  }

  @RequirePermissions("parcel:create")
  @Post("pickup-schedules")
  @ApiZodQuery(merchantSelector)
  @ApiZodBody(pickupScheduleSchema)
  createSchedule(@CurrentActor() actor: Actor, @ZQuery(merchantSelector) query: Selector, @ZBody(pickupScheduleSchema) body: z.infer<typeof pickupScheduleSchema>, @ReqMeta() meta: RequestMeta) {
    return this.pickups.createSchedule(actor, query.merchantId, body, meta);
  }

  @RequirePermissions("parcel:create")
  @Patch("pickup-schedules/:id")
  @ApiZodQuery(merchantSelector)
  @ApiZodBody(updatePickupScheduleSchema)
  updateSchedule(
    @CurrentActor() actor: Actor,
    @ZQuery(merchantSelector) query: Selector,
    @Param("id", ParseUUIDPipe) id: string,
    @ZBody(updatePickupScheduleSchema) body: z.infer<typeof updatePickupScheduleSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.pickups.updateSchedule(actor, query.merchantId, id, body, meta);
  }

  @RequirePermissions("parcel:create")
  @Delete("pickup-schedules/:id")
  @HttpCode(204)
  @ApiZodQuery(merchantSelector)
  deleteSchedule(@CurrentActor() actor: Actor, @ZQuery(merchantSelector) query: Selector, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.pickups.deleteSchedule(actor, query.merchantId, id, meta);
  }

  @RequirePermissions("parcel:create")
  @Get("pickup-requests")
  @ApiZodQuery(listPickupRequestsQuerySchema)
  requests(@CurrentActor() actor: Actor, @ZQuery(listPickupRequestsQuerySchema) query: z.infer<typeof listPickupRequestsQuerySchema>) {
    return this.pickups.listMine(actor, query);
  }

  @RequirePermissions("parcel:create")
  @Post("pickup-requests")
  @ApiZodQuery(merchantSelector)
  @ApiZodBody(pickupRequestSchema)
  request(@CurrentActor() actor: Actor, @ZQuery(merchantSelector) query: Selector, @ZBody(pickupRequestSchema) body: z.infer<typeof pickupRequestSchema>, @ReqMeta() meta: RequestMeta) {
    return this.pickups.requestOnce(actor, query.merchantId, body, meta);
  }

  @RequirePermissions("parcel:create")
  @Post("pickup-requests/:id/cancel")
  @HttpCode(200)
  @ApiZodQuery(merchantSelector)
  cancel(@CurrentActor() actor: Actor, @ZQuery(merchantSelector) query: Selector, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.pickups.cancelMine(actor, query.merchantId, id, meta);
  }
}

/** Operations: the day's pickup requests (from schedules and one-off requests). */
@ApiTags("pickups")
@Controller("pickup-requests")
export class OpsPickupsController {
  constructor(private readonly pickups: PickupsService) {}

  @RequirePermissions("parcel:read:any")
  @Get()
  @ApiZodQuery(listPickupRequestsQuerySchema)
  list(@ZQuery(listPickupRequestsQuerySchema) query: z.infer<typeof listPickupRequestsQuerySchema>) {
    return this.pickups.listAll(query);
  }

  /** Creates any due requests from recurring schedules now (normally a nightly job). */
  @RequirePermissions("parcel:dispatch")
  @Post("generate")
  @HttpCode(200)
  @ApiZodBody(generatePickupsSchema)
  async generate(@ZBody(generatePickupsSchema) body: z.infer<typeof generatePickupsSchema>) {
    return { created: await this.pickups.generate(body.date) };
  }

  @RequirePermissions("parcel:dispatch")
  @Post(":id/assign")
  @HttpCode(200)
  @ApiZodBody(assignPickupRequestSchema)
  assign(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(assignPickupRequestSchema) body: z.infer<typeof assignPickupRequestSchema>, @ReqMeta() meta: RequestMeta) {
    return this.pickups.assign(actor, id, body, meta);
  }

  @RequirePermissions("parcel:dispatch")
  @Post(":id/complete")
  @HttpCode(200)
  complete(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.pickups.complete(actor, id, meta);
  }

  @RequirePermissions("parcel:dispatch")
  @Post(":id/missed")
  @HttpCode(200)
  @ApiZodBody(closePickupRequestSchema)
  missed(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(closePickupRequestSchema) body: z.infer<typeof closePickupRequestSchema>, @ReqMeta() meta: RequestMeta) {
    return this.pickups.missed(actor, id, body, meta);
  }

  @RequirePermissions("parcel:dispatch")
  @Post(":id/cancel")
  @HttpCode(200)
  @ApiZodBody(closePickupRequestSchema)
  cancel(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(closePickupRequestSchema) body: z.infer<typeof closePickupRequestSchema>, @ReqMeta() meta: RequestMeta) {
    return this.pickups.cancelByOps(actor, id, body, meta);
  }
}
