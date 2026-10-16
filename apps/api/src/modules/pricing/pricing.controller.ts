import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { z } from "zod";
import { quoteRequestSchema, SERVICE_LEVEL_LABEL } from "@delivery-fast/shared";
import { CurrentActor, Public, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { catalogSchema, createRateCardSchema, listRateCardsQuerySchema, merchantRateSchema, PricingService } from "./pricing.service";
import type { SubmitResult } from "../approvals/approvals.service";

/** Applied at once → the result (as before); waiting for a second super admin → 202 { status: "PENDING", changeRequest }. */
function changeResponse(reply: FastifyReply, result: SubmitResult) {
  if (result.status === "APPLIED") return result.result;
  reply.status(202);
  return result;
}

@ApiTags("pricing")
@Controller()
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  /** Everything the public booking form needs: places, options and the customer rate card. */
  @Public()
  @Get("catalog")
  async catalog() {
    const [catalog, card] = await Promise.all([this.pricing.catalog(), this.pricing.activeCard("CUSTOMER")]);
    return { ...catalog, serviceLevels: SERVICE_LEVEL_LABEL, customerRateCard: card.config };
  }

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post("pricing/quote")
  @HttpCode(200)
  @ApiZodBody(quoteRequestSchema)
  quote(@ZBody(quoteRequestSchema) body: z.infer<typeof quoteRequestSchema>) {
    return this.pricing.quote("CUSTOMER", body);
  }

  @RequirePermissions("config:manage")
  @Put("catalog")
  @ApiZodBody(catalogSchema)
  saveCatalog(@CurrentActor() actor: Actor, @ZBody(catalogSchema) body: z.infer<typeof catalogSchema>, @ReqMeta() meta: RequestMeta) {
    return this.pricing.saveCatalog(actor, body, meta);
  }

  /** Every rate card, newest first per segment (history included). */
  @RequirePermissions("config:manage")
  @Get("rate-cards")
  @ApiZodQuery(listRateCardsQuerySchema)
  listCards(@ZQuery(listRateCardsQuerySchema) query: z.infer<typeof listRateCardsQuerySchema>) {
    return this.pricing.listCards(query.segment);
  }

  /** The card in force now for each segment (CUSTOMER, ECOMMERCE, CORPORATE_DOCUMENT); id is null while the defaults apply. */
  @RequirePermissions("config:manage")
  @Get("rate-cards/current")
  currentCards() {
    return this.pricing.currentCards();
  }

  @RequirePermissions("config:manage")
  @Post("rate-cards")
  @ApiZodBody(createRateCardSchema)
  async createCard(
    @CurrentActor() actor: Actor,
    @ZBody(createRateCardSchema) body: z.infer<typeof createRateCardSchema>,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return changeResponse(reply, await this.pricing.createCard(actor, body, meta));
  }

  @RequirePermissions("config:manage")
  @Delete("rate-cards/:id")
  async deactivateCard(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) reply: FastifyReply) {
    return changeResponse(reply, await this.pricing.deactivateCard(actor, id, meta));
  }

  /** A merchant's own tariff: its segment card, the override and the effective prices. */
  @RequirePermissions("config:manage")
  @Get("merchants/:id/tariff")
  merchantTariff(@Param("id", ParseUUIDPipe) id: string) {
    return this.pricing.merchantTariff(id);
  }

  /** Sets (or with `config: null` removes) a merchant's own tariff. Needs a second super admin's approval. */
  @RequirePermissions("config:manage")
  @Put("merchants/:id/tariff")
  @ApiZodBody(merchantRateSchema)
  async setMerchantTariff(
    @CurrentActor() actor: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @ZBody(merchantRateSchema) body: z.infer<typeof merchantRateSchema>,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return changeResponse(reply, await this.pricing.setMerchantTariff(actor, id, body, meta));
  }
}
