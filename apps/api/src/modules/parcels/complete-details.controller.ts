import { Controller, HttpCode, Param, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { AllowApiKey, CurrentActor, ReqMeta, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ZBody } from "../../common/zod";
import { RequireApiKeyScope } from "../merchants/api-key-scopes";
import { CompleteDetailsService, completeParcelSchema } from "./complete-details.service";

@ApiTags("parcels")
@Controller()
export class CompleteDetailsController {
  constructor(private readonly details: CompleteDetailsService) {}

  /**
   * Complete an incomplete order ("Needs info", booked by an import with delivery details missing):
   * recipient name/phone, address, district/zone, weight or service. All of the recipient and destination
   * fields are needed before a delivery rider is assigned. The merchant can while it waits for pickup;
   * operations until it goes out for delivery. Re-priced with the tariff frozen at booking; tracked and audited.
   */
  @AllowApiKey()
  @RequireApiKeyScope("parcels:write")
  @Post("parcels/:trackingId/complete")
  @HttpCode(200)
  @ApiZodBody(completeParcelSchema)
  complete(@CurrentActor() actor: Actor, @Param("trackingId") trackingId: string, @ZBody(completeParcelSchema) body: z.infer<typeof completeParcelSchema>, @ReqMeta() meta: RequestMeta) {
    return this.details.complete(actor, trackingId, body, meta);
  }
}
