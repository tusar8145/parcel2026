import { Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiHeader, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { z } from "zod";
import { CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { UserActor } from "../../common/auth/actor";
import { ApiZodBody, ZBody } from "../../common/zod";
import { PrismaService } from "../../common/prisma.service";
import { withIdempotency } from "../../common/idempotency";
import { RiderLocationService } from "./location.service";
import { RiderPayService } from "./pay.service";
import { HandoverRequestsService } from "./handover-requests.service";
import { RiderKycService } from "./kyc.service";
import { handoverRequestSchema, kycUploadSchema, locationBatchSchema, locationPointSchema } from "./rider.schemas";

/** The signed-in rider's own data (rider app). */
@ApiTags("rider")
@RequirePermissions("parcel:rider-update")
@Controller("rider")
export class RiderAppController {
  constructor(
    private readonly locations: RiderLocationService,
    private readonly pay: RiderPayService,
    private readonly handovers: HandoverRequestsService,
    private readonly kyc: RiderKycService,
    private readonly prisma: PrismaService,
  ) {}

  /** Live position while on shift (the app sends one when the rider has moved ~50 m or every 2 minutes). */
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post("location")
  @HttpCode(202)
  @ApiZodBody(locationPointSchema)
  location(@CurrentUser() actor: UserActor, @ZBody(locationPointSchema) body: z.infer<typeof locationPointSchema>) {
    return this.locations.record(actor, body);
  }

  /** Positions recorded while offline, replayed together. Duplicates are ignored. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post("location/batch")
  @HttpCode(202)
  @ApiZodBody(locationBatchSchema)
  locationBatch(@CurrentUser() actor: UserActor, @ZBody(locationBatchSchema) body: z.infer<typeof locationBatchSchema>) {
    return this.locations.recordBatch(actor, body.points);
  }

  /** Real earnings: the plan in force, totals, this month's lines and payouts. */
  @Get("earnings")
  earnings(@CurrentUser() actor: UserActor) {
    return this.pay.myEarnings(actor);
  }

  @Get("payouts/:id")
  payout(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string) {
    return this.pay.getPayout(actor, id);
  }

  @RequirePermissions("cod:collect")
  @Get("handover-requests")
  handoverRequests(@CurrentUser() actor: UserActor) {
    return this.handovers.mine(actor);
  }

  /** Ask a hub to receive all COD cash in hand (GET /rider/cash). */
  @RequirePermissions("cod:collect")
  @Post("handover-requests")
  @ApiHeader({ name: "Idempotency-Key", required: false })
  @ApiZodBody(handoverRequestSchema)
  requestHandover(
    @CurrentUser() actor: UserActor,
    @ZBody(handoverRequestSchema) body: z.infer<typeof handoverRequestSchema>,
    @ReqMeta() meta: RequestMeta,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return withIdempotency(this.prisma, `rider:${actor.userId}`, idempotencyKey, { op: "handover-request", body }, () => this.handovers.create(actor, body, meta));
  }

  @RequirePermissions("cod:collect")
  @Post("handover-requests/:id/cancel")
  @HttpCode(200)
  cancelHandover(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.handovers.cancelMine(actor, id, meta);
  }

  /** KYC status, required documents and what's uploaded. */
  @Get("kyc")
  kycStatus(@CurrentUser() actor: UserActor) {
    return this.kyc.mine(actor);
  }

  @Throttle({ default: { limit: 20, ttl: 600_000 } })
  @Post("kyc/documents")
  @ApiZodBody(kycUploadSchema)
  uploadKyc(@CurrentUser() actor: UserActor, @ZBody(kycUploadSchema) body: z.infer<typeof kycUploadSchema>, @ReqMeta() meta: RequestMeta) {
    return this.kyc.upload(actor, body, meta);
  }

  @Post("kyc/submit")
  @HttpCode(200)
  submitKyc(@CurrentUser() actor: UserActor, @ReqMeta() meta: RequestMeta) {
    return this.kyc.submit(actor, meta);
  }
}
