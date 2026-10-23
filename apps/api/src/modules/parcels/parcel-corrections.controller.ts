import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { PrismaService } from "../../common/prisma.service";
import { receiverRelations } from "./receiver-relations";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ZBody } from "../../common/zod";
import { ParcelCorrectionsService, productTypeChangeSchema, returnChargeChangeSchema } from "./parcel-corrections.service";

/** Courier Operations › parcel › More: change the product type (re-priced), charge or waive a return. */
@ApiTags("parcels")
@Controller()
export class ParcelCorrectionsController {
  constructor(
    private readonly corrections: ParcelCorrectionsService,
    private readonly prisma: PrismaService,
  ) {}

  /** Who received a delivery, as related to the recipient (super admin's Receiver relations; Self first, the default). */
  @Get("delivery/receiver-relations")
  async relations() {
    return { relations: await receiverRelations(this.prisma) };
  }

  /** What is sent, as priced (Regular / Document / Books): the delivery charge is re-priced with the frozen package. */
  @RequirePermissions("parcel:dispatch")
  @Post("parcels/:trackingId/product-type")
  @HttpCode(200)
  @ApiZodBody(productTypeChangeSchema)
  productType(@CurrentActor() actor: Actor, @Param("trackingId") trackingId: string, @ZBody(productTypeChangeSchema) body: z.infer<typeof productTypeChangeSchema>, @ReqMeta() meta: RequestMeta) {
    return this.corrections.changeProductType(actor, trackingId, body, meta);
  }

  /** A return (e.g. a partial delivery's return order): charge the package's return charge, or not. Until it is returned. */
  @RequirePermissions("parcel:dispatch")
  @Post("parcels/:trackingId/return-charge")
  @HttpCode(200)
  @ApiZodBody(returnChargeChangeSchema)
  returnCharge(@CurrentActor() actor: Actor, @Param("trackingId") trackingId: string, @ZBody(returnChargeChangeSchema) body: z.infer<typeof returnChargeChangeSchema>, @ReqMeta() meta: RequestMeta) {
    return this.corrections.setReturnCharge(actor, trackingId, body, meta);
  }
}
