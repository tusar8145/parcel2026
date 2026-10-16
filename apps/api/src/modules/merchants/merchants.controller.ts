import type { z } from "zod";
import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { AllowApiKey, CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import { RequireApiKeyScope } from "./api-key-scopes";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { forbidden } from "../../common/errors";
import { quoteRequestSchema } from "@delivery-fast/shared";
import {
  addMemberSchema,
  adminUpdateMerchantSchema,
  createApiKeySchema,
  createWebhookSchema,
  listDeliveriesQuerySchema,
  listMerchantsQuerySchema,
  listPlansQuerySchema,
  merchantApplicationSchema,
  merchantSelectorSchema,
  merchantStatsQuerySchema,
  pageWithSelectorSchema,
  planSchema,
  updateMyMerchantSchema,
  updatePlanSchema,
  updateWebhookSchema,
} from "./merchants.schemas";
import { MerchantsService } from "./merchants.service";
import { MerchantIntegrationsService } from "./merchant-integrations.service";
import { PlansService } from "./plans.service";
import { MerchantStatsService } from "./merchant-stats.service";

type Selector = z.infer<typeof merchantSelectorSchema>;

@ApiTags("merchants")
@Controller("merchants")
export class MerchantsController {
  constructor(private readonly merchants: MerchantsService) {}

  /** Any signed-in user can apply; they become the owner of the new (pending) merchant. */
  @Post("applications")
  @ApiZodBody(merchantApplicationSchema)
  apply(@CurrentUser() actor: UserActor, @ZBody(merchantApplicationSchema) body: z.infer<typeof merchantApplicationSchema>, @ReqMeta() meta: RequestMeta) {
    return this.merchants.apply(actor, body, meta);
  }

  @RequirePermissions("merchant:read:any")
  @Get()
  @ApiZodQuery(listMerchantsQuerySchema)
  list(@ZQuery(listMerchantsQuerySchema) query: z.infer<typeof listMerchantsQuerySchema>) {
    return this.merchants.list(query);
  }

  @RequirePermissions("merchant:read:any")
  @Get(":id")
  detail(@Param("id", ParseUUIDPipe) id: string) {
    return this.merchants.detail(id);
  }

  /** Review (approve / suspend), assign a plan, correct details. */
  @RequirePermissions("merchant:manage")
  @Patch(":id")
  @ApiZodBody(adminUpdateMerchantSchema)
  update(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(adminUpdateMerchantSchema) body: z.infer<typeof adminUpdateMerchantSchema>, @ReqMeta() meta: RequestMeta) {
    return this.merchants.adminUpdate(actor, id, body, meta);
  }
}

/** The signed-in member's own merchant. Members of several merchants pass ?merchantId=. */
@ApiTags("merchant self-service")
@Controller("merchants/me")
export class MerchantSelfController {
  constructor(
    private readonly merchants: MerchantsService,
    private readonly integrations: MerchantIntegrationsService,
    private readonly stats: MerchantStatsService,
  ) {}

  /** Owners and staff. */
  @Get()
  @ApiZodQuery(merchantSelectorSchema)
  mine(@CurrentUser() actor: UserActor, @ZQuery(merchantSelectorSchema) query: Selector) {
    return this.merchants.mine(actor, query.merchantId);
  }

  @RequirePermissions("merchant:self")
  @Patch()
  @ApiZodQuery(merchantSelectorSchema)
  @ApiZodBody(updateMyMerchantSchema)
  updateMine(@CurrentActor() actor: Actor, @ZQuery(merchantSelectorSchema) query: Selector, @ZBody(updateMyMerchantSchema) body: z.infer<typeof updateMyMerchantSchema>, @ReqMeta() meta: RequestMeta) {
    return this.merchants.updateMine(actor, query.merchantId, body, meta);
  }

  /** Dashboard counters and the orders chart (owners and staff; money figures for owners only). */
  @Get("stats")
  @ApiZodQuery(merchantStatsQuerySchema)
  dashboard(@CurrentActor() actor: Actor, @ZQuery(merchantStatsQuerySchema) query: z.infer<typeof merchantStatsQuerySchema>) {
    return this.stats.stats(actor, query);
  }

  /** Price preview for the booking form, from the merchant's rate card and plan discount. The booking itself is priced again on the server. */
  @Post("quote")
  @HttpCode(200)
  @ApiZodQuery(merchantSelectorSchema)
  @ApiZodBody(quoteRequestSchema)
  quote(@CurrentActor() actor: Actor, @ZQuery(merchantSelectorSchema) query: Selector, @ZBody(quoteRequestSchema) body: z.infer<typeof quoteRequestSchema>) {
    return this.stats.quote(actor, query.merchantId, body);
  }

  // ── members ──

  @RequirePermissions("merchant:self")
  @Get("members")
  @ApiZodQuery(pageWithSelectorSchema)
  members(@CurrentActor() actor: Actor, @ZQuery(pageWithSelectorSchema) query: z.infer<typeof pageWithSelectorSchema>) {
    return this.merchants.listMembers(actor, query);
  }

  /** Existing users get the role; new phone numbers get a password-less account and an SMS invite. */
  @RequirePermissions("merchant:self")
  @Post("members")
  @ApiZodQuery(merchantSelectorSchema)
  @ApiZodBody(addMemberSchema)
  addMember(@CurrentActor() actor: Actor, @ZQuery(merchantSelectorSchema) query: Selector, @ZBody(addMemberSchema) body: z.infer<typeof addMemberSchema>, @ReqMeta() meta: RequestMeta) {
    return this.merchants.addMember(actor, query.merchantId, body, meta);
  }

  @RequirePermissions("merchant:self")
  @Delete("members/:userRoleId")
  @HttpCode(204)
  @ApiZodQuery(merchantSelectorSchema)
  removeMember(@CurrentActor() actor: Actor, @ZQuery(merchantSelectorSchema) query: Selector, @Param("userRoleId", ParseUUIDPipe) userRoleId: string, @ReqMeta() meta: RequestMeta) {
    return this.merchants.removeMember(actor, query.merchantId, userRoleId, meta);
  }

  // ── API keys ──

  @RequirePermissions("merchant:self")
  @Get("api-keys")
  @ApiZodQuery(pageWithSelectorSchema)
  apiKeys(@CurrentActor() actor: Actor, @ZQuery(pageWithSelectorSchema) query: z.infer<typeof pageWithSelectorSchema>) {
    return this.integrations.listApiKeys(actor, query);
  }

  /** The response is the only time the full key is shown. */
  @RequirePermissions("merchant:self")
  @Post("api-keys")
  @ApiZodQuery(merchantSelectorSchema)
  @ApiZodBody(createApiKeySchema)
  createApiKey(@CurrentActor() actor: Actor, @ZQuery(merchantSelectorSchema) query: Selector, @ZBody(createApiKeySchema) body: z.infer<typeof createApiKeySchema>, @ReqMeta() meta: RequestMeta) {
    return this.integrations.createApiKey(actor, query.merchantId, body, meta);
  }

  @RequirePermissions("merchant:self")
  @Delete("api-keys/:id")
  @ApiZodQuery(merchantSelectorSchema)
  revokeApiKey(@CurrentActor() actor: Actor, @ZQuery(merchantSelectorSchema) query: Selector, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.integrations.revokeApiKey(actor, query.merchantId, id, meta);
  }

  // ── webhooks (also API keys with the webhooks:manage scope) ──

  @AllowApiKey()
  @RequireApiKeyScope("webhooks:manage")
  @RequirePermissions("merchant:self")
  @Get("webhooks")
  @ApiZodQuery(merchantSelectorSchema)
  webhooks(@CurrentActor() actor: Actor, @ZQuery(merchantSelectorSchema) query: Selector) {
    return this.integrations.listWebhooks(actor, query.merchantId);
  }

  /** The response is the only time the signing secret is shown (until it is rotated). */
  @AllowApiKey()
  @RequireApiKeyScope("webhooks:manage")
  @RequirePermissions("merchant:self")
  @Post("webhooks")
  @ApiZodQuery(merchantSelectorSchema)
  @ApiZodBody(createWebhookSchema)
  createWebhook(@CurrentActor() actor: Actor, @ZQuery(merchantSelectorSchema) query: Selector, @ZBody(createWebhookSchema) body: z.infer<typeof createWebhookSchema>, @ReqMeta() meta: RequestMeta) {
    return this.integrations.createWebhook(actor, query.merchantId, body, meta);
  }

  @AllowApiKey()
  @RequireApiKeyScope("webhooks:manage")
  @RequirePermissions("merchant:self")
  @Patch("webhooks/:id")
  @ApiZodQuery(merchantSelectorSchema)
  @ApiZodBody(updateWebhookSchema)
  updateWebhook(
    @CurrentActor() actor: Actor,
    @ZQuery(merchantSelectorSchema) query: Selector,
    @Param("id", ParseUUIDPipe) id: string,
    @ZBody(updateWebhookSchema) body: z.infer<typeof updateWebhookSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.integrations.updateWebhook(actor, query.merchantId, id, body, meta);
  }

  @AllowApiKey()
  @RequireApiKeyScope("webhooks:manage")
  @RequirePermissions("merchant:self")
  @Delete("webhooks/:id")
  @HttpCode(204)
  @ApiZodQuery(merchantSelectorSchema)
  deleteWebhook(@CurrentActor() actor: Actor, @ZQuery(merchantSelectorSchema) query: Selector, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.integrations.deleteWebhook(actor, query.merchantId, id, meta);
  }

  @AllowApiKey()
  @RequireApiKeyScope("webhooks:manage")
  @RequirePermissions("merchant:self")
  @Post("webhooks/:id/rotate-secret")
  @HttpCode(200)
  @ApiZodQuery(merchantSelectorSchema)
  rotateSecret(@CurrentActor() actor: Actor, @ZQuery(merchantSelectorSchema) query: Selector, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.integrations.rotateWebhookSecret(actor, query.merchantId, id, meta);
  }

  @AllowApiKey()
  @RequireApiKeyScope("webhooks:manage")
  @RequirePermissions("merchant:self")
  @Get("webhooks/:id/deliveries")
  @ApiZodQuery(listDeliveriesQuerySchema)
  deliveries(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZQuery(listDeliveriesQuerySchema) query: z.infer<typeof listDeliveriesQuerySchema>) {
    return this.integrations.listDeliveries(actor, id, query);
  }

  /** Queues a signed "webhook.test" delivery to the endpoint. */
  @AllowApiKey()
  @RequireApiKeyScope("webhooks:manage")
  @RequirePermissions("merchant:self")
  @Post("webhooks/:id/test")
  @HttpCode(202)
  @ApiZodQuery(merchantSelectorSchema)
  testWebhook(@CurrentActor() actor: Actor, @ZQuery(merchantSelectorSchema) query: Selector, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.integrations.sendTest(actor, query.merchantId, id, meta);
  }
}

@ApiTags("plans")
@Controller("plans")
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  /** Active service plans; any signed-in user. */
  @Get()
  @ApiZodQuery(listPlansQuerySchema)
  list(@CurrentActor() actor: Actor, @ZQuery(listPlansQuerySchema) query: z.infer<typeof listPlansQuerySchema>) {
    if (query.includeInactive && !actor.permissions.has("config:manage")) throw forbidden();
    return this.plans.list(query);
  }

  @RequirePermissions("config:manage")
  @Post()
  @ApiZodBody(planSchema)
  create(@CurrentActor() actor: Actor, @ZBody(planSchema) body: z.infer<typeof planSchema>, @ReqMeta() meta: RequestMeta) {
    return this.plans.create(actor, body, meta);
  }

  @RequirePermissions("config:manage")
  @Patch(":id")
  @ApiZodBody(updatePlanSchema)
  update(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(updatePlanSchema) body: z.infer<typeof updatePlanSchema>, @ReqMeta() meta: RequestMeta) {
    return this.plans.update(actor, id, body, meta);
  }
}
