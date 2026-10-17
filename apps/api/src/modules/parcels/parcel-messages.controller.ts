import { Controller, Get, Param } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentActor, RequirePermissions } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ParcelMessagesService } from "./parcel-messages.service";

@ApiTags("parcels")
@Controller()
export class ParcelMessagesController {
  constructor(private readonly messages: ParcelMessagesService) {}

  /**
   * The parcel's message log (read-only): SMS and email messages sent about it, newest first, with
   * channel, event, masked recipient, state, queued/sent time, provider and last error. Security codes
   * (delivery code, OTP, collection code) are masked in the text. Staff with parcel:read:any; hub
   * operators only for their hubs' parcels.
   */
  @RequirePermissions("parcel:read:any")
  @Get("parcels/:trackingId/messages")
  list(@CurrentActor() actor: Actor, @Param("trackingId") trackingId: string) {
    return this.messages.list(actor, trackingId);
  }
}
