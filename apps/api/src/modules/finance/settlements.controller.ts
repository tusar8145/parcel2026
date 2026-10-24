import type { z } from "zod";
import { Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Res } from "@nestjs/common";
import { ApiProduces, ApiTags } from "@nestjs/swagger";
import type { FastifyReply } from "fastify";
import { CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { forbidden } from "../../common/errors";
import { createSettlementSchema, eligibleQuerySchema, listSettlementsQuerySchema, paySettlementSchema } from "./finance.schemas";
import { isFinanceStaff } from "./finance.scope";
import { SettlementsService } from "./settlements.service";
import { periodQuerySchema, type PeriodQuery } from "../../common/period";

@ApiTags("finance")
@Controller()
export class SettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  /** Drafts a payout of the merchant's COD cash at hubs, net of delivery charges. */
  @RequirePermissions("finance:manage")
  @Post("settlements")
  @ApiZodBody(createSettlementSchema)
  create(@CurrentUser() actor: UserActor, @ZBody(createSettlementSchema) body: z.infer<typeof createSettlementSchema>, @ReqMeta() meta: RequestMeta) {
    return this.settlements.create(actor, body.merchantId, meta, body.collectionIds);
  }

  /** Draft settlement dialog: the merchant's parcels with COD cash at hubs not yet settled, and its open adjustments. */
  @RequirePermissions("finance:manage")
  @Get("settlements/eligible")
  @ApiZodQuery(eligibleQuerySchema)
  eligible(@ZQuery(eligibleQuerySchema) query: z.infer<typeof eligibleQuerySchema>) {
    return this.settlements.eligible(query.merchantId);
  }

  /** Merchant owners see their own merchants' settlements. */
  @RequirePermissions("finance:read")
  @Get("settlements")
  @ApiZodQuery(listSettlementsQuerySchema)
  list(@CurrentActor() actor: Actor, @ZQuery(listSettlementsQuerySchema) query: z.infer<typeof listSettlementsQuerySchema>) {
    return this.settlements.list(actor, query);
  }

  @RequirePermissions("finance:read")
  @Get("settlements/:id")
  detail(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string) {
    return this.settlements.detail(actor, id);
  }

  /** The payment receipt photo (finance staff, and the merchant it was paid to). `Accept: application/json` returns a data URL. */
  @RequirePermissions("finance:read")
  @Get("settlements/:id/payment-proof")
  @ApiProduces("image/jpeg", "image/png", "image/webp", "application/json")
  async paymentProof(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @Headers("accept") accept: string | undefined, @Res() reply: FastifyReply) {
    const { file, data } = await this.settlements.paymentProof(actor, id);
    reply.header("cache-control", "private, no-store").header("vary", "accept").header("x-content-type-options", "nosniff");
    if (accept && /(^|,)\s*application\/json\s*(;|,|$)/i.test(accept))
      return reply.status(200).send({ id: file.id, mimeType: file.mimeType, dataUrl: `data:${file.mimeType};base64,${data.toString("base64")}` });
    return reply.status(200).header("content-type", file.mimeType).header("content-length", data.length).header("content-disposition", `inline; filename="${file.filename.replace(/["\\\r\n]/g, "_")}"`).send(data);
  }

  /** DRAFT → APPROVED by someone other than its maker. */
  @RequirePermissions("finance:manage")
  @Post("settlements/:id/approve")
  @HttpCode(200)
  approve(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.settlements.approve(actor, id, meta);
  }

  /** APPROVED → PAID; its collections become SETTLED and the merchant gets an SMS. */
  @RequirePermissions("finance:manage")
  @Post("settlements/:id/pay")
  @HttpCode(200)
  @ApiZodBody(paySettlementSchema)
  pay(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ZBody(paySettlementSchema) body: z.infer<typeof paySettlementSchema>, @ReqMeta() meta: RequestMeta) {
    return this.settlements.pay(actor, id, body, meta);
  }

  /** Discards a draft; its collections return to the unsettled pool. */
  @RequirePermissions("finance:manage")
  @Delete("settlements/:id")
  @HttpCode(204)
  async remove(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    await this.settlements.remove(actor, id, meta);
  }

  /** Company-wide money position now, plus `period` figures (from / to, Dhaka days; default this month); finance staff only. */
  @RequirePermissions("finance:read")
  @Get("finance/summary")
  @ApiZodQuery(periodQuerySchema)
  summary(@CurrentActor() actor: Actor, @ZQuery(periodQuerySchema) query: PeriodQuery) {
    if (!isFinanceStaff(actor)) throw forbidden("Only finance staff can see the company summary");
    return this.settlements.summary(query);
  }
}
