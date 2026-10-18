import type { z } from "zod";
import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { forbidden } from "../../common/errors";
import { createSettlementSchema, listSettlementsQuerySchema, paySettlementSchema } from "./finance.schemas";
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
    return this.settlements.create(actor, body.merchantId, meta);
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
