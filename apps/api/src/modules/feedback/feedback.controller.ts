import type { z } from "zod";
import { Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiQuery, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { OptionalActor, Public, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { feedbackSchema, listFeedbackQuerySchema } from "./feedback.schemas";
import { FeedbackService } from "./feedback.service";

@ApiTags("feedback")
@Controller()
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  /** The parcel's rating, for its owner (signed in) or the holder of a guest/feedback link (`t`). */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get("parcels/:trackingId/feedback")
  @ApiQuery({ name: "t", required: false, description: "Guest booking or feedback link token" })
  get(@OptionalActor() actor: Actor | undefined, @Param("trackingId") trackingId: string, @Query("t") token?: string) {
    return this.feedback.get(actor, trackingId, token);
  }

  /** Rate a delivered parcel (1–5 stars, optional comment). Once per parcel. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("parcels/:trackingId/feedback")
  @ApiZodBody(feedbackSchema)
  submit(
    @OptionalActor() actor: Actor | undefined,
    @Param("trackingId") trackingId: string,
    @ZBody(feedbackSchema) body: z.infer<typeof feedbackSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.feedback.submit(actor, trackingId, body, meta);
  }

  /** All delivery ratings with a summary (operations, super admin). */
  @RequirePermissions("parcel:read:any")
  @Get("feedback")
  @ApiZodQuery(listFeedbackQuerySchema)
  list(@ZQuery(listFeedbackQuerySchema) query: z.infer<typeof listFeedbackQuerySchema>) {
    return this.feedback.list(query);
  }
}
