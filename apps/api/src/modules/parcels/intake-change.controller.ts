import { Controller, HttpCode, Param, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ZBody } from "../../common/zod";
import { IntakeChangeService, changeIntakeSchema } from "./intake-change.service";

@ApiTags("parcels")
@Controller()
export class IntakeChangeController {
  constructor(private readonly intake: IntakeChangeService) {}

  /**
   * Switch a parcel between rider pickup and hub drop-off, or move a drop-off to another hub.
   * Only before pickup (PENDING_CONFIRMATION, PICKUP_ASSIGNED, PICKUP_CONFIRMED); a pickup
   * assignment is released. Re-priced from the new origin; the sender is notified.
   */
  @RequirePermissions("parcel:dispatch")
  @Post("parcels/:trackingId/intake")
  @HttpCode(200)
  @ApiZodBody(changeIntakeSchema)
  change(@CurrentActor() actor: Actor, @Param("trackingId") trackingId: string, @ZBody(changeIntakeSchema) body: z.infer<typeof changeIntakeSchema>, @ReqMeta() meta: RequestMeta) {
    return this.intake.change(actor, trackingId, body, meta);
  }
}
