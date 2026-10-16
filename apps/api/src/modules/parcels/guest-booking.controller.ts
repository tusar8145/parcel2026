import { Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import { ApiHeader, ApiQuery, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { createParcelSchema, guestCancelSchema, guestVerificationConfirmSchema, guestVerificationRequestSchema } from "@delivery-fast/shared";
import { Public, ReqMeta, type RequestMeta } from "../../common/auth/decorators";
import { ApiZodBody, ZBody } from "../../common/zod";
import { PrismaService } from "../../common/prisma.service";
import { withIdempotency } from "../../common/idempotency";
import { GuestBookingService } from "./guest-booking.service";

const guestParcelSchema = createParcelSchema.extend({
  /** From POST /guest/verification/confirm. */
  verificationToken: z.string().trim().min(10, "Verify your phone number first").max(200),
});

/** Booking and tracking for senders without an account (website). */
@ApiTags("guest booking")
@Controller()
export class GuestBookingController {
  constructor(
    private readonly guest: GuestBookingService,
    private readonly prisma: PrismaService,
  ) {}

  /** Sends a 6-digit code to the sender's phone (60 s between codes; 429 with retryAfterSeconds). */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("guest/verification")
  @HttpCode(200)
  @ApiZodBody(guestVerificationRequestSchema)
  request(@ZBody(guestVerificationRequestSchema) body: z.infer<typeof guestVerificationRequestSchema>, @ReqMeta() meta: RequestMeta) {
    return this.guest.requestCode(body.phone, meta);
  }

  /** Checks the code and returns a verification token valid for one booking within 30 minutes. */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("guest/verification/confirm")
  @HttpCode(200)
  @ApiZodBody(guestVerificationConfirmSchema)
  confirm(@ZBody(guestVerificationConfirmSchema) body: z.infer<typeof guestVerificationConfirmSchema>) {
    return this.guest.confirm(body.phone, body.code);
  }

  /** Books a pickup as a guest. The sender's phone must be the verified one. Returns a tracking link with an access token. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("guest/parcels")
  @ApiHeader({ name: "Idempotency-Key", required: false })
  @ApiZodBody(guestParcelSchema)
  async book(@ZBody(guestParcelSchema) body: z.infer<typeof guestParcelSchema>, @Headers("idempotency-key") idempotencyKey: string | undefined, @ReqMeta() meta: RequestMeta) {
    const { verificationToken, ...input } = body;
    const verification = idempotencyKey ? await this.guest.verificationFor(verificationToken).catch(() => null) : null;
    // Retries of a successful booking (same key) get the original response even though the verification is used up.
    const scope = `guest:${verification?.id ?? verificationToken.split(".")[0]}`;
    return withIdempotency(this.prisma, scope, idempotencyKey, input, () => this.guest.book(verificationToken, input, meta));
  }

  /** Full timeline for the holder of a guest booking or feedback link (`t`). */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get("track/:trackingId/full")
  @ApiQuery({ name: "t", required: true, description: "Access token from the tracking link" })
  full(@Param("trackingId") trackingId: string, @Query("t") token: string) {
    return this.guest.fullView(trackingId, token);
  }

  /** Cancels a guest booking while it is still pending confirmation. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("track/:trackingId/cancel")
  @HttpCode(200)
  @ApiZodBody(guestCancelSchema)
  cancel(@Param("trackingId") trackingId: string, @ZBody(guestCancelSchema) body: z.infer<typeof guestCancelSchema>, @ReqMeta() meta: RequestMeta) {
    return this.guest.cancel(trackingId, body.token, body.reason, meta);
  }
}
