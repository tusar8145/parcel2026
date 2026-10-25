import { Controller, Get, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { forbidden } from "../../common/errors";
import {
  accountParcelsQuerySchema,
  adjustmentSchema,
  createBillSchema,
  createPayoutSchema,
  dateRangeQuerySchema,
  listAccountsQuerySchema,
  listBillsQuerySchema,
  listPaymentsQuerySchema,
  listPayoutsQuerySchema,
  paymentSchema,
  payPayoutSchema,
  payToSchema,
  rejectPaymentSchema,
  voidBillSchema,
} from "./money.schemas";
import { ACCOUNTS_CONFIG_KEY, readAccountsConfig, updateAccountsConfigSchema } from "./accounts-config";
import { AccountsService } from "./accounts.service";
import { PayoutsService } from "./payouts.service";
import { BillsService } from "./bills.service";

/**
 * Accounts: E-commerce / Financial merchants and customers (Courier Operations › Accounts; merchants' and
 * customers' Balance pages read their own account through the same routes).
 */
@ApiTags("accounts")
@Controller()
export class MoneyController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly payouts: PayoutsService,
    private readonly bills: BillsService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───────────── settings ─────────────

  /** The central hub (any staff; riders and merchants don't need it). */
  @Get("accounts/config")
  async config(@CurrentActor() actor: Actor) {
    if (actor.kind !== "user" || !(actor.permissions.has("cod:receive") || actor.permissions.has("finance:manage") || actor.permissions.has("config:manage"))) throw forbidden();
    const cfg = await readAccountsConfig(this.prisma);
    const hub = cfg.centralHubId ? await this.prisma.hub.findUnique({ where: { id: cfg.centralHubId }, select: { id: true, name: true, code: true } }) : null;
    return { centralHub: hub };
  }

  /** Super admins choose the central hub. */
  @RequirePermissions("config:manage")
  @Put("accounts/config")
  @ApiZodBody(updateAccountsConfigSchema)
  async setConfig(@CurrentUser() actor: UserActor, @ZBody(updateAccountsConfigSchema) body: z.infer<typeof updateAccountsConfigSchema>, @ReqMeta() meta: RequestMeta) {
    if (body.centralHubId && !(await this.prisma.hub.count({ where: { id: body.centralHubId, active: true, type: { not: "FRANCHISE" } } }))) throw forbidden("Choose an active Delivery Fast hub");
    await this.prisma.$transaction(async tx => {
      const before = await readAccountsConfig(tx);
      await tx.setting.upsert({ where: { key: ACCOUNTS_CONFIG_KEY }, create: { key: ACCOUNTS_CONFIG_KEY, value: body }, update: { value: body } });
      await this.audit.record(actor, { action: "accounts.config", entityType: "setting", entityId: ACCOUNTS_CONFIG_KEY, data: { from: before.centralHubId, to: body.centralHubId } }, meta, tx);
    });
    return this.config(actor);
  }

  /** Switching to Accounts: existing delivered / returned parcels get their lines, hub cash is placed (once; safe to repeat). */
  @RequirePermissions("config:manage")
  @Post("accounts/cutover")
  cutover(@CurrentUser() actor: UserActor, @ReqMeta() meta: RequestMeta) {
    return this.accounts.cutover(actor, meta);
  }

  // ───────────── accounts ─────────────

  @Get("accounts/overview")
  overview(@CurrentActor() actor: Actor) {
    return this.accounts.overview(actor);
  }

  @Get("accounts")
  @ApiZodQuery(listAccountsQuerySchema)
  list(@CurrentActor() actor: Actor, @ZQuery(listAccountsQuerySchema) query: z.infer<typeof listAccountsQuerySchema>) {
    return this.accounts.list(actor, query);
  }

  /** The signed-in merchant owner's / customer's own accounts (Balance page). */
  @Get("my-accounts")
  mine(@CurrentUser() actor: UserActor) {
    return this.accounts.mine(actor);
  }

  @Get("accounts/:id")
  detail(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string) {
    return this.accounts.detail(actor, id);
  }

  @Get("accounts/:id/parcels")
  @ApiZodQuery(accountParcelsQuerySchema)
  parcels(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZQuery(accountParcelsQuerySchema) query: z.infer<typeof accountParcelsQuerySchema>) {
    return this.accounts.parcels(actor, id, query);
  }

  @Get("accounts/:id/statement")
  @ApiZodQuery(dateRangeQuerySchema)
  statement(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZQuery(dateRangeQuerySchema) query: z.infer<typeof dateRangeQuerySchema>) {
    return this.accounts.statement(actor, id, query);
  }

  @Post("accounts/:id/adjustments")
  @ApiZodBody(adjustmentSchema)
  adjust(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ZBody(adjustmentSchema) body: z.infer<typeof adjustmentSchema>, @ReqMeta() meta: RequestMeta) {
    return this.accounts.adjust(actor, id, body, meta);
  }

  /** A customer chooses where COD payouts go. */
  @Put("accounts/:id/pay-to")
  @ApiZodBody(payToSchema)
  payTo(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ZBody(payToSchema) body: z.infer<typeof payToSchema>, @ReqMeta() meta: RequestMeta) {
    return this.accounts.setPayTo(actor, id, body, meta);
  }

  // ───────────── settlements (E-commerce, Customer) ─────────────

  @Post("accounts/:id/payouts")
  @ApiZodBody(createPayoutSchema)
  createPayout(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ZBody(createPayoutSchema) body: z.infer<typeof createPayoutSchema>, @ReqMeta() meta: RequestMeta) {
    return this.payouts.create(actor, id, body, meta);
  }

  @Get("payouts")
  @ApiZodQuery(listPayoutsQuerySchema)
  listPayouts(@CurrentActor() actor: Actor, @ZQuery(listPayoutsQuerySchema) query: z.infer<typeof listPayoutsQuerySchema>) {
    return this.payouts.list(actor, query);
  }

  @Get("payouts/:id")
  payout(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string) {
    return this.payouts.detail(actor, id);
  }

  @Post("payouts/:id/pay")
  @ApiZodBody(payPayoutSchema)
  payPayout(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ZBody(payPayoutSchema) body: z.infer<typeof payPayoutSchema>, @ReqMeta() meta: RequestMeta) {
    return this.payouts.pay(actor, id, body, meta);
  }

  @Post("payouts/:id/cancel")
  cancelPayout(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.payouts.cancel(actor, id, meta);
  }

  // ───────────── bills and payments (Financial) ─────────────

  @Post("accounts/:id/bills")
  @ApiZodBody(createBillSchema)
  createBill(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ZBody(createBillSchema) body: z.infer<typeof createBillSchema>, @ReqMeta() meta: RequestMeta) {
    return this.bills.create(actor, id, body, meta);
  }

  @Get("bills")
  @ApiZodQuery(listBillsQuerySchema)
  listBills(@CurrentActor() actor: Actor, @ZQuery(listBillsQuerySchema) query: z.infer<typeof listBillsQuerySchema>) {
    return this.bills.bills(actor, query);
  }

  @Get("bills/:id")
  bill(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string) {
    return this.bills.bill(actor, id);
  }

  @Post("bills/:id/void")
  @ApiZodBody(voidBillSchema)
  voidBill(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ZBody(voidBillSchema) body: z.infer<typeof voidBillSchema>, @ReqMeta() meta: RequestMeta) {
    return this.bills.void(actor, id, body, meta);
  }

  /** Staff record a payment (confirmed); the merchant's owner submits "I've paid" (pending). */
  @Post("accounts/:id/payments")
  @ApiZodBody(paymentSchema)
  pay(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ZBody(paymentSchema) body: z.infer<typeof paymentSchema>, @ReqMeta() meta: RequestMeta) {
    return this.bills.pay(actor, id, body, meta);
  }

  @Get("payments")
  @ApiZodQuery(listPaymentsQuerySchema)
  listPayments(@CurrentActor() actor: Actor, @ZQuery(listPaymentsQuerySchema) query: z.infer<typeof listPaymentsQuerySchema>) {
    return this.bills.payments(actor, query);
  }

  @Post("payments/:id/confirm")
  confirmPayment(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.bills.confirm(actor, id, meta);
  }

  @Post("payments/:id/reject")
  @ApiZodBody(rejectPaymentSchema)
  rejectPayment(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ZBody(rejectPaymentSchema) body: z.infer<typeof rejectPaymentSchema>, @ReqMeta() meta: RequestMeta) {
    return this.bills.reject(actor, id, body, meta);
  }
}
