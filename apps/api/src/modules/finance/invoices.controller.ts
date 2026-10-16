import type { z } from "zod";
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { createInvoiceSchema, listInvoicesQuerySchema, markInvoicePaidSchema, voidInvoiceSchema } from "./finance.schemas";
import { InvoicesService } from "./invoices.service";

@ApiTags("finance")
@Controller("invoices")
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  /** Bills a merchant's delivery charges for a closed period [periodStart, periodEnd). */
  @RequirePermissions("finance:manage")
  @Post()
  @ApiZodBody(createInvoiceSchema)
  create(@CurrentUser() actor: UserActor, @ZBody(createInvoiceSchema) body: z.infer<typeof createInvoiceSchema>, @ReqMeta() meta: RequestMeta) {
    return this.invoices.create(actor, body, meta);
  }

  /** Merchant owners see their own merchants' invoices. */
  @RequirePermissions("finance:read")
  @Get()
  @ApiZodQuery(listInvoicesQuerySchema)
  list(@CurrentActor() actor: Actor, @ZQuery(listInvoicesQuerySchema) query: z.infer<typeof listInvoicesQuerySchema>) {
    return this.invoices.list(actor, query);
  }

  @RequirePermissions("finance:read")
  @Get(":id")
  detail(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string) {
    return this.invoices.detail(actor, id);
  }

  /** ISSUED → PAID. */
  @RequirePermissions("finance:manage")
  @Post(":id/mark-paid")
  @HttpCode(200)
  @ApiZodBody(markInvoicePaidSchema)
  markPaid(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ZBody(markInvoicePaidSchema) body: z.infer<typeof markInvoicePaidSchema>, @ReqMeta() meta: RequestMeta) {
    return this.invoices.markPaid(actor, id, body, meta);
  }

  /** ISSUED → VOID (frees the period for a corrected invoice). */
  @RequirePermissions("finance:manage")
  @Post(":id/void")
  @HttpCode(200)
  @ApiZodBody(voidInvoiceSchema)
  void(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ZBody(voidInvoiceSchema) body: z.infer<typeof voidInvoiceSchema>, @ReqMeta() meta: RequestMeta) {
    return this.invoices.void(actor, id, body, meta);
  }
}
