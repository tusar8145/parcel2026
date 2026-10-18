import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { z } from "zod";
import { quoteRequestSchema } from "@delivery-fast/shared";
import { AllowApiKey, CurrentActor, OptionalActor, Public, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import { hasRole, merchantIdsOf, type Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { forbidden } from "../../common/errors";
import { RequireApiKeyScope } from "../merchants/api-key-scopes";
import { changeResponse, PackagesService, quoteResponse } from "./packages.service";
import { HubGroupsService } from "./hub-groups.service";
import { ParcelProductsService } from "./parcel-products.service";
import {
  assignmentsQuerySchema,
  assignPackageSchema,
  createPackageSchema,
  effectiveQuerySchema,
  hubGroupHubsSchema,
  hubGroupSchema,
  hubHubGroupSchema,
  listPackagesQuerySchema,
  listProductsQuerySchema,
  packageSettingsSchema,
  packageVersionSchema,
  productSchema,
  simulateSchema,
  updateHubGroupSchema,
  updateProductSchema,
} from "./packages.schemas";

const isStaff = (actor: Actor) => actor.permissions.has("parcel:read:any");

/** Places and choices of a quote body (POST /packages/quote, merchant and public quotes share it). */
export function quoteRequestOf(body: z.infer<typeof quoteRequestSchema>) {
  return {
    pickup: { district: body.pickupDistrict, zone: body.pickupZone, area: body.pickupArea },
    delivery: { district: body.deliveryDistrict, zone: body.deliveryZone, area: body.deliveryArea },
    weightKg: body.weightKg,
    codAmount: body.codAmount,
    firstMile: body.firstMile ?? (body.dropOffHubId ? ("HUB_DROP" as const) : undefined),
    dropHubId: body.dropHubId ?? body.dropOffHubId,
    lastMile: body.lastMile,
    collectHubId: body.collectHubId,
    speed: body.speed,
    openBox: body.openBox,
    product: body.product,
    serviceLevel: body.serviceLevel,
    documentType: body.documentType,
  };
}

@ApiTags("packages")
@Controller()
export class PackagesController {
  constructor(
    private readonly packages: PackagesService,
    private readonly hubGroups: HubGroupsService,
    private readonly products: ParcelProductsService,
  ) {}

  /** The fixed service catalog, price fields and labels (package editor, forms). */
  @Public()
  @Get("service-catalog")
  catalog() {
    return this.packages.catalogView();
  }

  /**
   * The caller's package for booking: services, the choices it offers (first / last mile, speed and
   * handling, COD, open box, notifications), products, prices and hubs. Merchants (and their API
   * keys) get their package; customers and guests the website customer default.
   */
  @Public()
  @AllowApiKey()
  @RequireApiKeyScope("parcels:write", "parcels:read")
  @Get("packages/me")
  async me(@OptionalActor() actor?: Actor) {
    const merchants = actor ? merchantIdsOf(actor) : [];
    if (actor && merchants.length && !hasRole(actor, "CUSTOMER")) {
      // Prices and services open once the merchant account is active.
      await this.packages.assertActiveMerchant(merchants[0]);
      return this.packages.bookingView({ merchantId: merchants[0] });
    }
    return this.packages.bookingView({ segment: "CUSTOMER" });
  }

  /** Operations: the package a merchant (or a segment) books with. */
  @RequirePermissions("parcel:read:any")
  @Get("packages/effective")
  @ApiZodQuery(effectiveQuerySchema)
  effective(@ZQuery(effectiveQuerySchema) query: z.infer<typeof effectiveQuerySchema>) {
    return this.packages.bookingView(query.merchantId ? { merchantId: query.merchantId } : { segment: query.segment ?? "CUSTOMER" });
  }

  /**
   * Price for a merchant's package (operations, or a merchant / API key for itself) with the full
   * breakdown: `lines`, `deliveryCharge`, `codFee`, `totalCharge`, `tier`, hubs.
   */
  @AllowApiKey()
  @RequireApiKeyScope("parcels:write", "parcels:read")
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @Post("packages/quote")
  @HttpCode(200)
  @ApiZodBody(quoteRequestSchema)
  quote(@CurrentActor() actor: Actor, @ZBody(quoteRequestSchema) body: z.infer<typeof quoteRequestSchema>) {
    const own = merchantIdsOf(actor);
    const merchantId = body.merchantId ?? (own.length === 1 ? own[0] : undefined);
    if (merchantId && !own.includes(merchantId) && !isStaff(actor)) throw forbidden("You can only quote for your own merchant account");
    return this.packages.normalizePickup(quoteRequestOf(body)).then(input => this.packages.quote(merchantId ? { merchantId } : { segment: "CUSTOMER" }, input)).then(quoteResponse);
  }

  // ── administration ──

  @RequirePermissions("config:manage")
  @Get("packages")
  @ApiZodQuery(listPackagesQuerySchema)
  list(@ZQuery(listPackagesQuerySchema) query: z.infer<typeof listPackagesQuerySchema>) {
    return this.packages.list(query);
  }

  @RequirePermissions("config:manage")
  @Get("packages/settings")
  settings() {
    return this.packages.settings();
  }

  @RequirePermissions("config:manage")
  @Put("packages/settings")
  @ApiZodBody(packageSettingsSchema)
  saveSettings(@CurrentActor() actor: Actor, @ZBody(packageSettingsSchema) body: z.infer<typeof packageSettingsSchema>, @ReqMeta() meta: RequestMeta) {
    return this.packages.saveSettings(actor, body, meta);
  }

  /** Price simulator: a stored package, a merchant's package or the editor's draft (services + prices). */
  @RequirePermissions("config:manage")
  @Post("packages/simulate")
  @HttpCode(200)
  @ApiZodBody(simulateSchema)
  simulate(@ZBody(simulateSchema) body: z.infer<typeof simulateSchema>) {
    return this.packages.simulate({ ...quoteRequestOf(body), packageId: body.packageId, segment: body.segment, services: body.services, prices: body.prices, merchantId: body.merchantId });
  }

  @RequirePermissions("config:manage")
  @Get("packages/:id")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.packages.get(id);
  }

  /** New package (version 1). Needs a second super admin's approval when there is one (202). */
  @RequirePermissions("config:manage")
  @Post("packages")
  @ApiZodBody(createPackageSchema)
  async create(@CurrentActor() actor: Actor, @ZBody(createPackageSchema) body: z.infer<typeof createPackageSchema>, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) reply: FastifyReply) {
    return changeResponse(reply, await this.packages.create(actor, body, meta));
  }

  /** New services / prices from `effectiveFrom` (parcels keep the version they were booked with). Maker-checker. */
  @RequirePermissions("config:manage")
  @Post("packages/:id/versions")
  @ApiZodBody(packageVersionSchema)
  async addVersion(
    @CurrentActor() actor: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @ZBody(packageVersionSchema) body: z.infer<typeof packageVersionSchema>,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return changeResponse(reply, await this.packages.addVersion(actor, id, body, meta));
  }

  @RequirePermissions("config:manage")
  @Post("packages/:id/default")
  @HttpCode(200)
  async setDefault(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) reply: FastifyReply) {
    return changeResponse(reply, await this.packages.setDefault(actor, id, meta));
  }

  @RequirePermissions("config:manage")
  @Post("packages/:id/archive")
  @HttpCode(200)
  async archive(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) reply: FastifyReply) {
    return changeResponse(reply, await this.packages.archive(actor, id, meta));
  }

  /** Only a package nothing used (409 PACKAGE_IN_USE otherwise: archive it). */
  @RequirePermissions("config:manage")
  @Delete("packages/:id")
  remove(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.packages.remove(actor, id, meta);
  }

  /** Merchants of a segment with their package now and scheduled changes. */
  @RequirePermissions("config:manage")
  @Get("packages/assignments")
  @ApiZodQuery(assignmentsQuerySchema)
  assignments(@ZQuery(assignmentsQuerySchema) query: z.infer<typeof assignmentsQuerySchema>) {
    return this.packages.assignments(query.segment);
  }

  @RequirePermissions("merchant:read:any")
  @Get("merchants/:id/package")
  merchantPackage(@Param("id", ParseUUIDPipe) id: string) {
    return this.packages.merchantPackage(id);
  }

  /** Assigns a package (null = the segment default) from `effectiveFrom`. Maker-checker. */
  @RequirePermissions("config:manage")
  @Put("merchants/:id/package")
  @ApiZodBody(assignPackageSchema)
  async assign(
    @CurrentActor() actor: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @ZBody(assignPackageSchema) body: z.infer<typeof assignPackageSchema>,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return changeResponse(reply, await this.packages.assign(actor, id, body, meta));
  }

  // ── hub groups ──

  @Get("hub-groups")
  listHubGroups(@CurrentActor() actor: Actor) {
    if (!actor.permissions.has("hub:read") && !actor.permissions.has("config:manage")) throw forbidden();
    return this.hubGroups.list();
  }

  @RequirePermissions("config:manage")
  @Post("hub-groups")
  @ApiZodBody(hubGroupSchema)
  createHubGroup(@CurrentActor() actor: Actor, @ZBody(hubGroupSchema) body: z.infer<typeof hubGroupSchema>, @ReqMeta() meta: RequestMeta) {
    return this.hubGroups.create(actor, body, meta);
  }

  @RequirePermissions("config:manage")
  @Patch("hub-groups/:id")
  @ApiZodBody(updateHubGroupSchema)
  updateHubGroup(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(updateHubGroupSchema) body: z.infer<typeof updateHubGroupSchema>, @ReqMeta() meta: RequestMeta) {
    return this.hubGroups.update(actor, id, body, meta);
  }

  @RequirePermissions("config:manage")
  @Delete("hub-groups/:id")
  removeHubGroup(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.hubGroups.remove(actor, id, meta);
  }

  @RequirePermissions("config:manage")
  @Put("hub-groups/:id/hubs")
  @ApiZodBody(hubGroupHubsSchema)
  setHubGroupHubs(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(hubGroupHubsSchema) body: z.infer<typeof hubGroupHubsSchema>, @ReqMeta() meta: RequestMeta) {
    return this.hubGroups.setHubs(actor, id, body.hubIds, meta);
  }

  @RequirePermissions("hub:read")
  @Get("hubs/:id/hub-group")
  hubGroupOf(@Param("id", ParseUUIDPipe) id: string) {
    return this.hubGroups.hubGroupOf(id);
  }

  @RequirePermissions("config:manage")
  @Put("hubs/:id/hub-group")
  @ApiZodBody(hubHubGroupSchema)
  setHubGroup(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(hubHubGroupSchema) body: z.infer<typeof hubHubGroupSchema>, @ReqMeta() meta: RequestMeta) {
    return this.hubGroups.setHubGroup(actor, id, body.hubGroupId, meta);
  }

  // ── products ──

  /** Product lists (any signed-in user; website customers use the e-commerce list). */
  @Public()
  @Get("parcel-products")
  @ApiZodQuery(listProductsQuerySchema)
  listProducts(@ZQuery(listProductsQuerySchema) query: z.infer<typeof listProductsQuerySchema>, @OptionalActor() actor?: Actor) {
    if (query.includeInactive && !actor?.permissions.has("config:manage")) throw forbidden();
    return this.products.list(query);
  }

  @RequirePermissions("config:manage")
  @Post("parcel-products")
  @ApiZodBody(productSchema)
  createProduct(@CurrentActor() actor: Actor, @ZBody(productSchema) body: z.infer<typeof productSchema>, @ReqMeta() meta: RequestMeta) {
    return this.products.create(actor, body, meta);
  }

  @RequirePermissions("config:manage")
  @Patch("parcel-products/:id")
  @ApiZodBody(updateProductSchema)
  updateProduct(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(updateProductSchema) body: z.infer<typeof updateProductSchema>, @ReqMeta() meta: RequestMeta) {
    return this.products.update(actor, id, body, meta);
  }

  @RequirePermissions("config:manage")
  @Delete("parcel-products/:id")
  removeProduct(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.products.remove(actor, id, meta);
  }
}

