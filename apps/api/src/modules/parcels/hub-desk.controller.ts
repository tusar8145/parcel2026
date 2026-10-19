import type { z } from "zod";
import { Controller, HttpCode, Post } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ZBody } from "../../common/zod";
import { HubDeskService, deskDeliverySchema, deskDispatchSchema, deskFailedSchema, deskPickupSchema, deskReceiveBackSchema, deskReturnSchema, deskTransferSchema } from "./hub-desk.service";

/** Hub desk scans (Courier Operations → Hub desk): delivered entry from signed slips, and out for delivery. */
@ApiTags("hub desk")
@Controller("hub-desk")
export class HubDeskController {
  constructor(private readonly desk: HubDeskService) {}

  /** A rider's signed delivery slip handed in at the hub: delivered for that rider (or, already delivered, its proof updated). */
  @RequirePermissions("parcel:dispatch")
  @Post("deliver")
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiZodBody(deskDeliverySchema)
  @ApiOkResponse({ description: "{ ok, outcome: DELIVERED | UPDATED | ALREADY_DELIVERED | NOT_FOUND | OTHER_HUB | NOT_WITH_RIDER | COD_MISMATCH | REFUSED, message, code, parcel? }" })
  deliver(@CurrentActor() actor: Actor, @ZBody(deskDeliverySchema) body: z.infer<typeof deskDeliverySchema>, @ReqMeta() meta: RequestMeta) {
    return this.desk.deliver(actor, body, meta);
  }

  /** Out for delivery by scanning; a parcel still at the hub is first given to `riderId`. */
  @RequirePermissions("parcel:dispatch")
  @Post("dispatch")
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiZodBody(deskDispatchSchema)
  @ApiOkResponse({ description: "{ ok, outcome: OUT_FOR_DELIVERY | ALREADY_OUT | RIDER_REQUIRED | NOT_READY | NOT_FOUND | OTHER_HUB | REFUSED, message, code, parcel? }" })
  dispatch(@CurrentActor() actor: Actor, @ZBody(deskDispatchSchema) body: z.infer<typeof deskDispatchSchema>, @ReqMeta() meta: RequestMeta) {
    return this.desk.dispatch(actor, body, meta);
  }

  /** A pickup rider's collected parcels brought to the hub: picked up for that rider and received at the hub. */
  @RequirePermissions("parcel:dispatch")
  @Post("pickup")
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiZodBody(deskPickupSchema)
  @ApiOkResponse({ description: "{ ok, outcome: RECEIVED | ALREADY_RECEIVED | NOT_A_PICKUP | NOT_WITH_PICKUP_RIDER | HUB_REQUIRED | NOT_FOUND | REFUSED, message, code }" })
  pickup(@CurrentActor() actor: Actor, @ZBody(deskPickupSchema) body: z.infer<typeof deskPickupSchema>, @ReqMeta() meta: RequestMeta) {
    return this.desk.pickupEntry(actor, body, meta);
  }

  /** A failed delivery attempt reported at the desk: RETRY (stays with the rider) or RETURN_TO_HUB. */
  @RequirePermissions("parcel:dispatch")
  @Post("failed")
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiZodBody(deskFailedSchema)
  @ApiOkResponse({ description: "{ ok, outcome: RETRY_SCHEDULED | BACK_AT_HUB | NOT_WITH_RIDER | HUB_REQUIRED | NOT_FOUND | OTHER_HUB | REFUSED, message, code }" })
  failed(@CurrentActor() actor: Actor, @ZBody(deskFailedSchema) body: z.infer<typeof deskFailedSchema>, @ReqMeta() meta: RequestMeta) {
    return this.desk.failedDelivery(actor, body, meta);
  }

  /** Parcels a rider brings back after a failed delivery or an unfinished return: received at the hub. */
  @RequirePermissions("parcel:dispatch")
  @Post("receive-back")
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiZodBody(deskReceiveBackSchema)
  @ApiOkResponse({ description: "{ ok, outcome: RECEIVED | ALREADY_RECEIVED | RECORD_FAILED_FIRST | NOT_WITH_RIDER | HUB_REQUIRED | NOT_FOUND | REFUSED, message, code }" })
  receiveBack(@CurrentActor() actor: Actor, @ZBody(deskReceiveBackSchema) body: z.infer<typeof deskReceiveBackSchema>, @ReqMeta() meta: RequestMeta) {
    return this.desk.receiveBack(actor, body, meta);
  }

  /** A parcel at this hub sent to another hub (in transit); default destination: the hub serving its delivery zone. */
  @RequirePermissions("parcel:dispatch")
  @Post("transfer")
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiZodBody(deskTransferSchema)
  @ApiOkResponse({ description: "{ ok, outcome: IN_TRANSIT | ALREADY_IN_TRANSIT | NOT_AT_HUB | IN_BAG | NO_DESTINATION | DELIVERED_FROM_HERE | NOT_FOUND | OTHER_HUB | REFUSED, message, code }" })
  transfer(@CurrentActor() actor: Actor, @ZBody(deskTransferSchema) body: z.infer<typeof deskTransferSchema>, @ReqMeta() meta: RequestMeta) {
    return this.desk.transfer(actor, body, meta);
  }

  /** The sender took a returned parcel back: Returned (the run completes with its last parcel). */
  @RequirePermissions("parcel:dispatch")
  @Post("return")
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiZodBody(deskReturnSchema)
  @ApiOkResponse({ description: "{ ok, outcome: RETURNED | ALREADY_RETURNED | NOT_ON_RETURN | OTHER_HUB | NOT_FOUND | REFUSED, message, code }" })
  returned(@CurrentActor() actor: Actor, @ZBody(deskReturnSchema) body: z.infer<typeof deskReturnSchema>, @ReqMeta() meta: RequestMeta) {
    return this.desk.returnEntry(actor, body, meta);
  }
}
