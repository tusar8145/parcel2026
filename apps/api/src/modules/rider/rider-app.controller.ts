import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { z } from "zod";
import { CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { UserActor } from "../../common/auth/actor";
import { ApiZodBody, ZBody } from "../../common/zod";
import { RiderLocationService } from "./location.service";
import { RiderPayService } from "./pay.service";
import { RiderKycService } from "./kyc.service";
import { kycUploadSchema, locationBatchSchema, locationPointSchema } from "./rider.schemas";

/** The signed-in rider's own data (rider app). */
@ApiTags("rider")
@RequirePermissions("parcel:rider-update")
@Controller("rider")
export class RiderAppController {
  constructor(
    private readonly locations: RiderLocationService,
    private readonly pay: RiderPayService,
    private readonly kyc: RiderKycService,
  ) {}

  /** Live position while on shift (the app sends one after a move of the configured distance, else every 2 / 5 / 10 minutes: GET /settings/location). */
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post("location")
  @HttpCode(202)
  @ApiZodBody(locationPointSchema)
  location(@CurrentUser() actor: UserActor, @ZBody(locationPointSchema) body: z.infer<typeof locationPointSchema>) {
    return this.locations.record(actor, body);
  }

  /** The rider's last position on record (status line: "Location sharing: On · last sent 1 min ago"). */
  @Get("location")
  myLocation(@CurrentUser() actor: UserActor) {
    return this.locations.mine(actor);
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
