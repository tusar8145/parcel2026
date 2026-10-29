import { HttpStatus, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { quoteRequestSchema, SERVICE_LEVEL_LABEL } from "@paira-express/shared";
import { CurrentActor, Public, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { catalogSchema, createRateCardSchema, listRateCardsQuerySchema, merchantRateSchema, PricingService } from "./pricing.service";
import type { SubmitResult } from "../approvals/approvals.service";
import { AppError } from "../../common/errors";
import { legacyCardOf, PackagesService, quoteResponse } from "../packages/packages.service";
import { placeIn } from "../geography/place-in-text";

/** GET /catalog/place: the typed address (at most 500 characters). */
const placeQuerySchema = z.object({ address: z.string().trim().max(500, "Use at most 500 characters").default("") });
import { quoteRequestOf } from "../packages/packages.controller";

/** Rate cards and merchant tariffs are retired (service packages v2): prices are set per package. */
const retired = () => new AppError("PRICING_RETIRED", "Rate cards and merchant tariffs are retired: set prices in Service plans & pricing (service packages)", HttpStatus.GONE);

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

  /** Service packages (global module; property injection keeps the constructor stable). */
  @Inject(PackagesService) private readonly packages!: PackagesService;

  /**
   * The district, zone and area named in a typed address (every address form fills its dropdowns from
   * it; the user can still change them): catalog names found in the text, Bangla names and small
   * spelling slips forgiven, a zone bringing its district. Empty when nothing matches.
   */
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get("catalog/place")
  @ApiZodQuery(placeQuerySchema)
  async place(@ZQuery(placeQuerySchema) query: z.infer<typeof placeQuerySchema>) {
    return placeIn(query.address, await this.pricing.catalog());
  }

  /** Everything the public booking form needs: places, options and the customer rate card. */
  @Public()
  @Get("catalog")
  async catalog() {
    // Prices and choices come from the website customer package (service packages).
    const [catalog, view] = await Promise.all([this.pricing.catalog(), this.packages.bookingView({ segment: "CUSTOMER" })]);
    return {
      ...catalog,
      // Products are the Customer & E-commerce parcel products only (Service plans → Products), never the
      // old catalog list (its `products` field is legacy and not read).
      products: view.products.map(p => p.name),
      /** Products whose "Send SMS & email" switch is off: the booking form disables its messages checklist. */
      productsWithoutMessages: view.products.filter(p => !p.sendMessages).map(p => p.name),
      serviceLevels: SERVICE_LEVEL_LABEL,
      customerRateCard: legacyCardOf(view.prices),
      customerPackage: {
        options: view.options,
        labels: view.labels,
        notifications: view.notifications,
        collectHubs: view.collectHubs,
        dropHubs: view.dropHubs,
        package: view.package,
        /** The active Customer & E-commerce products with their type (the booking form lists "Name · Type"). */
        products: view.products.map(p => ({ name: p.name, type: p.type, sendMessages: p.sendMessages })),
      },
    };
  }

  /** The website customer price with its breakdown (`lines`), from the website customer package. */
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post("pricing/quote")
  @HttpCode(200)
  @ApiZodBody(quoteRequestSchema)
  async quote(@ZBody(quoteRequestSchema) body: z.infer<typeof quoteRequestSchema>) {
    return quoteResponse(await this.packages.quote({ segment: "CUSTOMER" }, quoteRequestOf(body)));
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

  /** The card in force now for each segment (CUSTOMER, ECOMMERCE, BANKING_FINANCIAL); id is null while the defaults apply. */
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
    void [actor, body, meta, reply];
    throw retired();
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
    void [actor, id, body, meta, reply];
    throw retired();
  }
}
