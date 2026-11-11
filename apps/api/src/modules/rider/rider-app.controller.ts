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
import { kycUploadSchema, locationBatchSchema, locationPointSchema, nearestHubSchema } from "./rider.schemas";
import { NetworkService } from "../network/network.service";

/** The signed-in rider's own data (rider app). */
@ApiTags("rider")
@RequirePermissions("parcel:rider-update")
@Controller("rider")
export class RiderAppController {
  constructor(
    private readonly locations: RiderLocationService,
    private readonly pay: RiderPayService,
    private readonly kyc: RiderKycService,
    private readonly network: NetworkService,
  ) {}

  /** Live position while on shift (the app sends one after a move of the configured distance, else every 2 / 5 / 10 minutes: GET /settings/location). */
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post("location")
  @HttpCode(202)
  @ApiZodBody(locationPointSchema)
  async location(@CurrentUser() actor: UserActor, @ZBody(locationPointSchema) body: z.infer<typeof locationPointSchema>) {
    const recorded = await this.locations.record(actor, body);
    // A rider on several hubs works at the nearest one (cash and hand-overs go there).
    if (actor.riderId) await this.network.moveToNearestHub(actor.riderId, body.lat, body.lng).catch(() => null);
    return recorded;
  }

  /**
   * App start: a rider on several hubs works at the nearest one (cash and hand-overs go there). Not a tracking point.
   * Returns the hub they work at now.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("me/nearest-hub")
  @HttpCode(200)
  @ApiZodBody(nearestHubSchema)
  async nearestHub(@CurrentUser() actor: UserActor, @ZBody(nearestHubSchema) body: z.infer<typeof nearestHubSchema>) {
    if (!actor.riderId) return { hub: null, changed: false };
    const changed = await this.network.moveToNearestHub(actor.riderId, body.lat, body.lng);
    const me = await this.network.getRider(actor.riderId);
    return { hub: me.hub, hubs: me.hubs, changed: !!changed };
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
