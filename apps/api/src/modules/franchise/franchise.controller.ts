import type { z } from "zod";
import type { FastifyReply } from "fastify";
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { DocumentsService } from "../documents/documents.service";
import { FranchiseAdminService } from "./franchise-admin.service";
import { FranchisePanelService } from "./franchise-panel.service";
import { FranchiseMoneyService } from "./franchise-money.service";
import {
  createFranchiseSchema,
  franchiseAssignSchema,
  franchiseCompleteReturnSchema,
  franchiseHandoverSchema,
  franchiseParcelsQuerySchema,
  franchiseQuoteSchema,
  franchiseReceiveSchema,
  franchiseRemittanceSchema,
  franchiseReturnRunSchema,
  franchiseRiderSchema,
  franchiseSendSchema,
  franchiseStatusSchema,
  franchiseWalkInSchema,
  listFranchiseInvoicesQuerySchema,
  listRemittancesQuerySchema,
  payFranchiseInvoiceSchema,
  receiveRemittanceSchema,
  riderPaymentSchema,
  riderRatesSchema,
  updateFranchiseConfigSchema,
  updateFranchiseRiderSchema,
  updateFranchiseSchema,
} from "./franchise.schemas";

async function sendPdf(reply: FastifyReply, file: { fileName: string; stream: NodeJS.ReadableStream }) {
  reply
    .status(200)
    .header("content-type", "application/pdf")
    .header("content-disposition", `inline; filename="${file.fileName.replace(/["\\\r\n]/g, "_")}"`)
    .header("cache-control", "private, no-store")
    .header("x-content-type-options", "nosniff");
  return reply.send(file.stream);
}

/** The franchise panel: one account per franchise (Role FRANCHISE), everything at its own hub. */
@ApiTags("franchise")
@Controller("franchise")
@RequirePermissions("franchise:self")
export class FranchisePanelController {
  constructor(
    private readonly panel: FranchisePanelService,
    private readonly money: FranchiseMoneyService,
    private readonly documents: DocumentsService,
  ) {}

  @Get("me")
  me(@CurrentActor() actor: Actor) {
    return this.panel.me(actor);
  }

  @Get("overview")
  overview(@CurrentActor() actor: Actor) {
    return this.panel.overview(actor);
  }

  @Get("parcels")
  @ApiZodQuery(franchiseParcelsQuerySchema)
  parcels(@CurrentActor() actor: Actor, @ZQuery(franchiseParcelsQuerySchema) query: z.infer<typeof franchiseParcelsQuerySchema>) {
    return this.panel.parcelsList(actor, query);
  }

  /** Scan at the franchise hub: transfers, drop-offs and walk-ins arriving. */
  @Post("receive")
  @HttpCode(200)
  @ApiZodBody(franchiseReceiveSchema)
  receive(@CurrentActor() actor: Actor, @ZBody(franchiseReceiveSchema) body: z.infer<typeof franchiseReceiveSchema>, @ReqMeta() meta: RequestMeta) {
    return this.panel.receive(actor, body, meta);
  }

  @Post("parcels/:trackingId/assign")
  @HttpCode(200)
  @ApiZodBody(franchiseAssignSchema)
  assign(@CurrentActor() actor: Actor, @Param("trackingId") trackingId: string, @ZBody(franchiseAssignSchema) body: z.infer<typeof franchiseAssignSchema>, @ReqMeta() meta: RequestMeta) {
    return this.panel.assign(actor, trackingId, body, meta);
  }

  /** Sends a parcel at the franchise hub to another hub. */
  @Post("parcels/:trackingId/send")
  @HttpCode(200)
  @ApiZodBody(franchiseSendSchema)
  send(@CurrentActor() actor: Actor, @Param("trackingId") trackingId: string, @ZBody(franchiseSendSchema) body: z.infer<typeof franchiseSendSchema>, @ReqMeta() meta: RequestMeta) {
    return this.panel.send(actor, trackingId, body, meta);
  }

  /** Walk-in price at the counter (website customer default package). */
  @Post("walk-in/quote")
  @HttpCode(200)
  @ApiZodBody(franchiseQuoteSchema)
  quote(@CurrentActor() actor: Actor, @ZBody(franchiseQuoteSchema) body: z.infer<typeof franchiseQuoteSchema>) {
    return this.panel.quote(actor, body);
  }

  @Post("walk-in")
  @ApiZodBody(franchiseWalkInSchema)
  walkIn(@CurrentActor() actor: Actor, @ZBody(franchiseWalkInSchema) body: z.infer<typeof franchiseWalkInSchema>, @ReqMeta() meta: RequestMeta) {
    return this.panel.walkIn(actor, body, meta);
  }

  @Get("return-runs")
  returnRuns(@CurrentActor() actor: Actor) {
    return this.panel.returnRuns(actor);
  }

  @Post("return-runs")
  @ApiZodBody(franchiseReturnRunSchema)
  createReturnRuns(@CurrentActor() actor: Actor, @ZBody(franchiseReturnRunSchema) body: z.infer<typeof franchiseReturnRunSchema>, @ReqMeta() meta: RequestMeta) {
    return this.panel.createReturnRuns(actor, body, meta);
  }

  @Post("return-runs/:id/complete")
  @HttpCode(200)
  @ApiZodBody(franchiseCompleteReturnSchema)
  completeReturnRun(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(franchiseCompleteReturnSchema) body: z.infer<typeof franchiseCompleteReturnSchema>, @ReqMeta() meta: RequestMeta) {
    return this.panel.completeReturnRun(actor, id, body, meta);
  }

  @Get("riders")
  riders(@CurrentActor() actor: Actor) {
    return this.panel.riders(actor);
  }

  @Post("riders")
  @ApiZodBody(franchiseRiderSchema)
  createRider(@CurrentActor() actor: Actor, @ZBody(franchiseRiderSchema) body: z.infer<typeof franchiseRiderSchema>, @ReqMeta() meta: RequestMeta) {
    return this.panel.createRider(actor, body, meta);
  }

  @Patch("riders/:id")
  @ApiZodBody(updateFranchiseRiderSchema)
  updateRider(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(updateFranchiseRiderSchema) body: z.infer<typeof updateFranchiseRiderSchema>, @ReqMeta() meta: RequestMeta) {
    return this.panel.updateRider(actor, id, body, meta);
  }

  /** What the franchise pays its riders per pickup / delivery / return. */
  @Put("rider-rates")
  @ApiZodBody(riderRatesSchema)
  riderRates(@CurrentActor() actor: Actor, @ZBody(riderRatesSchema) body: z.infer<typeof riderRatesSchema>, @ReqMeta() meta: RequestMeta) {
    return this.panel.setRiderRates(actor, body, meta);
  }

  @Get("riders/:id/earnings")
  riderEarnings(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string) {
    return this.panel.riderEarnings(actor, id);
  }

  @Post("riders/:id/payments")
  @ApiZodBody(riderPaymentSchema)
  payRider(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ZBody(riderPaymentSchema) body: z.infer<typeof riderPaymentSchema>, @ReqMeta() meta: RequestMeta) {
    return this.panel.payRider(actor, id, body, meta);
  }

  @Get("cash")
  cash(@CurrentActor() actor: Actor) {
    return this.money.cash(actor);
  }

  /** Cash a rider hands over at the franchise counter. */
  @Post("cash/handovers")
  @ApiZodBody(franchiseHandoverSchema)
  receiveRiderCash(@CurrentUser() actor: UserActor, @ZBody(franchiseHandoverSchema) body: z.infer<typeof franchiseHandoverSchema>, @ReqMeta() meta: RequestMeta) {
    return this.money.receiveRiderCash(actor, body, meta);
  }

  /** Deposit the cash on hand at a company hub (that hub confirms it). */
  @Post("deposits")
  @ApiZodBody(franchiseRemittanceSchema)
  deposit(@CurrentActor() actor: Actor, @ZBody(franchiseRemittanceSchema) body: z.infer<typeof franchiseRemittanceSchema>, @ReqMeta() meta: RequestMeta) {
    return this.money.requestDeposit(actor, body, meta);
  }

  @Post("deposits/:id/cancel")
  @HttpCode(200)
  cancelDeposit(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.money.cancelDeposit(actor, id, meta);
  }

  @Get("commissions")
  commissions(@CurrentActor() actor: Actor) {
    return this.money.commissions(actor);
  }

  @Post("invoices")
  createInvoice(@CurrentActor() actor: Actor, @ReqMeta() meta: RequestMeta) {
    return this.money.createMyInvoice(actor, meta);
  }

  @Get("invoices/:id/pdf")
  async invoicePdf(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    await this.panel.context(actor);
    const i = await this.money.invoiceDetail(actor, id);
    return sendPdf(reply, await this.documents.franchiseInvoice(actor, i, meta));
  }
}

/** Super admin: franchises, their rates, suspension and the global settlement settings. */
@ApiTags("franchise")
@Controller("franchises")
export class FranchiseAdminController {
  constructor(private readonly admin: FranchiseAdminService) {}

  @RequirePermissions("franchise:manage")
  @Get()
  list() {
    return this.admin.list();
  }

  @RequirePermissions("franchise:manage")
  @Get("config")
  config() {
    return this.admin.config();
  }

  @RequirePermissions("franchise:manage")
  @Put("config")
  @ApiZodBody(updateFranchiseConfigSchema)
  saveConfig(@CurrentActor() actor: Actor, @ZBody(updateFranchiseConfigSchema) body: z.infer<typeof updateFranchiseConfigSchema>, @ReqMeta() meta: RequestMeta) {
    return this.admin.saveConfig(actor, body, meta);
  }

  /** Approved franchise applications not turned into a franchise yet. */
  @RequirePermissions("franchise:manage")
  @Get("applications")
  applications() {
    return this.admin.pendingApplications();
  }

  @RequirePermissions("franchise:manage")
  @Post()
  @ApiZodBody(createFranchiseSchema)
  create(@CurrentActor() actor: Actor, @ZBody(createFranchiseSchema) body: z.infer<typeof createFranchiseSchema>, @ReqMeta() meta: RequestMeta) {
    return this.admin.create(actor, body, meta);
  }

  @RequirePermissions("franchise:manage")
  @Get(":id")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.admin.get(id);
  }

  @RequirePermissions("franchise:manage")
  @Patch(":id")
  @ApiZodBody(updateFranchiseSchema)
  update(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(updateFranchiseSchema) body: z.infer<typeof updateFranchiseSchema>, @ReqMeta() meta: RequestMeta) {
    return this.admin.update(actor, id, body, meta);
  }

  @RequirePermissions("franchise:manage")
  @Post(":id/status")
  @HttpCode(200)
  @ApiZodBody(franchiseStatusSchema)
  setStatus(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(franchiseStatusSchema) body: z.infer<typeof franchiseStatusSchema>, @ReqMeta() meta: RequestMeta) {
    return this.admin.setStatus(actor, id, body, meta);
  }
}

/** Company hubs and finance: franchise deposits to confirm, commission invoices to approve and pay. */
@ApiTags("franchise")
@Controller()
export class FranchiseFinanceController {
  constructor(
    private readonly money: FranchiseMoneyService,
    private readonly documents: DocumentsService,
  ) {}

  @RequirePermissions("cod:receive")
  @Get("franchise-deposits")
  @ApiZodQuery(listRemittancesQuerySchema)
  deposits(@CurrentActor() actor: Actor, @ZQuery(listRemittancesQuerySchema) query: z.infer<typeof listRemittancesQuerySchema>) {
    return this.money.listDeposits(actor, query);
  }

  @RequirePermissions("cod:receive")
  @Post("franchise-deposits/:id/receive")
  @HttpCode(200)
  @ApiZodBody(receiveRemittanceSchema)
  receiveDeposit(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(receiveRemittanceSchema) body: z.infer<typeof receiveRemittanceSchema>, @ReqMeta() meta: RequestMeta) {
    return this.money.receiveDeposit(actor, id, body, meta);
  }

  @RequirePermissions("finance:read")
  @Get("franchise-invoices")
  @ApiZodQuery(listFranchiseInvoicesQuerySchema)
  invoices(@ZQuery(listFranchiseInvoicesQuerySchema) query: z.infer<typeof listFranchiseInvoicesQuerySchema>) {
    return this.money.listInvoices(query);
  }

  /** BILL mode: invoice every franchise that is due now (the daily job does the same). */
  @RequirePermissions("finance:manage")
  @Post("franchise-invoices/run")
  @HttpCode(200)
  async run() {
    return { created: await this.money.runBilling() };
  }

  @RequirePermissions("finance:read")
  @Get("franchise-invoices/:id/pdf")
  async pdf(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return sendPdf(reply, await this.documents.franchiseInvoice(actor, await this.money.invoiceDetail(actor, id), meta));
  }

  @RequirePermissions("finance:manage")
  @Post("franchise-invoices/:id/approve")
  @HttpCode(200)
  approve(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.money.approveInvoice(actor, id, meta);
  }

  @RequirePermissions("finance:manage")
  @Post("franchise-invoices/:id/pay")
  @HttpCode(200)
  @ApiZodBody(payFranchiseInvoiceSchema)
  pay(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ZBody(payFranchiseInvoiceSchema) body: z.infer<typeof payFranchiseInvoiceSchema>, @ReqMeta() meta: RequestMeta) {
    return this.money.payInvoice(actor, id, body, meta);
  }
}

