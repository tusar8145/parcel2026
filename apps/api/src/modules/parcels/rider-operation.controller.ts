import { Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiHeader, ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { deliveryOutcomeSchema, pickupOutcomeSchema } from "@delivery-fast/shared";
import { CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { UserActor } from "../../common/auth/actor";
import { ApiZodBody, ZBody } from "../../common/zod";
import { PrismaService } from "../../common/prisma.service";
import { withIdempotency } from "../../common/idempotency";
import { RiderTasksService } from "./rider-tasks.service";
import { riderReturnSchema } from "./parcels.schemas";

/**
 * Scan desk / Operations app › Rider Operation: operations staff choose a rider and do the rider app's steps for them
 * (pickup from merchant, start deliveries, deliver, could not deliver, returned to merchant), with exactly the rider
 * app's rules (RiderTasksService with the chosen rider). The staff member is the actor in the tracking and audit log.
 */
@ApiTags("hub-desk")
@Controller("hub-desk/riders/:riderId")
@RequirePermissions("parcel:dispatch")
export class RiderOperationController {
  constructor(
    private readonly riderTasks: RiderTasksService,
    private readonly prisma: PrismaService,
  ) {}

  /** The rider's pickups, deliveries and parcels carried (as the rider app's GET /rider/tasks). */
  @Get("tasks")
  tasks(@CurrentUser() actor: UserActor, @Param("riderId", ParseUUIDPipe) riderId: string) {
    return this.riderTasks.tasks(actor, riderId);
  }

  /** The rider's return runs with the parcels still to return (GET /rider/return-runs). */
  @Get("return-runs")
  returnRuns(@CurrentUser() actor: UserActor, @Param("riderId", ParseUUIDPipe) riderId: string) {
    return this.riderTasks.returnRuns(actor, riderId);
  }

  @Post("parcels/:trackingId/pickup")
  @HttpCode(200)
  @ApiHeader({ name: "Idempotency-Key", required: false })
  @ApiZodBody(pickupOutcomeSchema)
  pickup(
    @CurrentUser() actor: UserActor,
    @Param("riderId", ParseUUIDPipe) riderId: string,
    @Param("trackingId") trackingId: string,
    @ZBody(pickupOutcomeSchema) body: z.infer<typeof pickupOutcomeSchema>,
    @ReqMeta() meta: RequestMeta,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return withIdempotency(this.prisma, `rider-op:${actor.userId}`, idempotencyKey, { op: "pickup", riderId, trackingId, body }, () => this.riderTasks.pickup(actor, trackingId, body, meta, riderId));
  }

  @Post("parcels/:trackingId/start-delivery")
  @HttpCode(200)
  @ApiHeader({ name: "Idempotency-Key", required: false })
  startDelivery(@CurrentUser() actor: UserActor, @Param("riderId", ParseUUIDPipe) riderId: string, @Param("trackingId") trackingId: string, @ReqMeta() meta: RequestMeta, @Headers("idempotency-key") idempotencyKey?: string) {
    return withIdempotency(this.prisma, `rider-op:${actor.userId}`, idempotencyKey, { op: "start-delivery", riderId, trackingId }, () => this.riderTasks.startDelivery(actor, trackingId, meta, riderId));
  }

  @Post("parcels/:trackingId/resend-code")
  @HttpCode(200)
  resendCode(@CurrentUser() actor: UserActor, @Param("riderId", ParseUUIDPipe) riderId: string, @Param("trackingId") trackingId: string) {
    return this.riderTasks.resendDeliveryCode(actor, trackingId, riderId);
  }

  /** Deliver (code, signature or photo; cash; partial) or Could not deliver (reason; try again / return to sender). */
  @Post("parcels/:trackingId/delivery")
  @HttpCode(200)
  @ApiHeader({ name: "Idempotency-Key", required: false })
  @ApiZodBody(deliveryOutcomeSchema)
  deliver(
    @CurrentUser() actor: UserActor,
    @Param("riderId", ParseUUIDPipe) riderId: string,
    @Param("trackingId") trackingId: string,
    @ZBody(deliveryOutcomeSchema) body: z.infer<typeof deliveryOutcomeSchema>,
    @ReqMeta() meta: RequestMeta,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return withIdempotency(this.prisma, `rider-op:${actor.userId}`, idempotencyKey, { op: "delivery", riderId, trackingId, body }, () => this.riderTasks.deliver(actor, trackingId, body, meta, riderId));
  }

  /** Returned to merchant: the merchant took this parcel of the rider's return run back. */
  @Post("parcels/:trackingId/return")
  @HttpCode(200)
  @ApiHeader({ name: "Idempotency-Key", required: false })
  @ApiZodBody(riderReturnSchema)
  returnToMerchant(
    @CurrentUser() actor: UserActor,
    @Param("riderId", ParseUUIDPipe) riderId: string,
    @Param("trackingId") trackingId: string,
    @ZBody(riderReturnSchema) body: z.infer<typeof riderReturnSchema>,
    @ReqMeta() meta: RequestMeta,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return withIdempotency(this.prisma, `rider-op:${actor.userId}`, idempotencyKey, { op: "return", riderId, trackingId, body }, () => this.riderTasks.returnToMerchant(actor, trackingId, body, meta, riderId));
  }
}
