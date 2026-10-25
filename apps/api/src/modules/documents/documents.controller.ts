import { dateRangeQuerySchema } from "../money/money.schemas";
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Res } from "@nestjs/common";
import { ApiProduces, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply } from "fastify";
import type { z } from "zod";
import { AllowApiKey, CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { RequireApiKeyScope } from "../merchants/api-key-scopes";
import { DocumentsService, type PdfFile } from "./documents.service";
import { hubReconciliationQuerySchema } from "../hub-reconciliation/hub-reconciliation.service";
import { cnSheetQuerySchema, invoicesQuerySchema, labelsQuerySchema, parcelListQuerySchema, runSheetQuerySchema, slaReportQuerySchema } from "./documents.schemas";

const PDF = "application/pdf";

/** Sends a generated PDF inline (opens in the browser's viewer) with a filename for saving. */
function send(reply: FastifyReply, file: PdfFile) {
  reply
    .status(200)
    .header("content-type", PDF)
    .header("content-disposition", `inline; filename="${file.fileName.replace(/["\\\r\n]/g, "_")}"`)
    .header("cache-control", "private, no-store")
    .header("x-content-type-options", "nosniff")
    .header("access-control-expose-headers", "content-disposition, x-document-count, x-document-pages, x-missing-count, x-missing");
  if (file.count != null) reply.header("x-document-count", String(file.count));
  if (file.pages != null) reply.header("x-document-pages", String(file.pages));
  if (file.missing) {
    reply.header("x-missing-count", String(file.missing.length));
    if (file.missing.length) reply.header("x-missing", file.missing.slice(0, 20).join(",").replace(/[^A-Za-z0-9,._-]/g, ""));
  }
  return reply.send(file.stream);
}

/**
 * Printable PDFs (A4, thermal labels, POS receipts) for every print button in the panels.
 * Each document checks the permissions and scope of the data it prints; generation is audited
 * (`document.generate`). Parcel batches take tracking IDs as `ids` (comma-separated on GET, an
 * array on POST for long lists) or a booking batch (`batchId`).
 */
@ApiTags("documents")
@Controller("documents")
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /** Shipping labels: A4 (4 per sheet) or 100 × 150 mm thermal; at most 2,000 per PDF. */
  @AllowApiKey()
  @RequireApiKeyScope("parcels:read", "parcels:write")
  @Get("labels")
  @ApiProduces(PDF)
  @ApiZodQuery(labelsQuerySchema)
  async labels(@CurrentActor() actor: Actor, @ZQuery(labelsQuerySchema) query: z.infer<typeof labelsQuerySchema>, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return send(reply, await this.documents.labels(actor, query, meta));
  }

  @AllowApiKey()
  @RequireApiKeyScope("parcels:read", "parcels:write")
  @Post("labels")
  @HttpCode(200)
  @ApiProduces(PDF)
  @ApiZodBody(labelsQuerySchema)
  async labelsPost(@CurrentActor() actor: Actor, @ZBody(labelsQuerySchema) body: z.infer<typeof labelsQuerySchema>, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return send(reply, await this.documents.labels(actor, body, meta));
  }

  /** Delivery invoices per shipment: A4, 4 or 8 per A4 page, or 80 mm POS; optionally one service line. */
  @AllowApiKey()
  @RequireApiKeyScope("parcels:read", "parcels:write")
  @Get("invoices")
  @ApiProduces(PDF)
  @ApiZodQuery(invoicesQuerySchema)
  async invoices(@CurrentActor() actor: Actor, @ZQuery(invoicesQuerySchema) query: z.infer<typeof invoicesQuerySchema>, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return send(reply, await this.documents.shipmentInvoices(actor, query, meta));
  }

  @AllowApiKey()
  @RequireApiKeyScope("parcels:read", "parcels:write")
  @Post("invoices")
  @HttpCode(200)
  @ApiProduces(PDF)
  @ApiZodBody(invoicesQuerySchema)
  async invoicesPost(@CurrentActor() actor: Actor, @ZBody(invoicesQuerySchema) body: z.infer<typeof invoicesQuerySchema>, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return send(reply, await this.documents.shipmentInvoices(actor, body, meta));
  }

  /** The order / shipment list as a landscape table with totals. */
  @AllowApiKey()
  @RequireApiKeyScope("parcels:read", "parcels:write")
  @Get("parcel-list")
  @ApiProduces(PDF)
  @ApiZodQuery(parcelListQuerySchema)
  async parcelList(@CurrentActor() actor: Actor, @ZQuery(parcelListQuerySchema) query: z.infer<typeof parcelListQuerySchema>, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return send(reply, await this.documents.parcelList(actor, query, meta));
  }

  @AllowApiKey()
  @RequireApiKeyScope("parcels:read", "parcels:write")
  @Post("parcel-list")
  @HttpCode(200)
  @ApiProduces(PDF)
  @ApiZodBody(parcelListQuerySchema)
  async parcelListPost(@CurrentActor() actor: Actor, @ZBody(parcelListQuerySchema) body: z.infer<typeof parcelListQuerySchema>, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return send(reply, await this.documents.parcelList(actor, body, meta));
  }

  /** Linehaul manifest (trip id or number): bags, parcels, totals and signatures. */
  @RequirePermissions("hub:read")
  @Get("manifest/:trip")
  @ApiProduces(PDF)
  async manifest(@CurrentActor() actor: Actor, @Param("trip") trip: string, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return send(reply, await this.documents.manifest(actor, trip, meta));
  }

  /** Linehaul bag tag (100 × 150 mm). */
  @RequirePermissions("hub:read")
  @Get("bag-label/:bag")
  @ApiProduces(PDF)
  async bagLabel(@CurrentActor() actor: Actor, @Param("bag") bag: string, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return send(reply, await this.documents.bagLabel(actor, bag, meta));
  }

  /** Rider run sheet for a Dhaka day (rider id or code): today's assigned work in route order. */
  @RequirePermissions("parcel:read:any", "rider:read")
  @Get("run-sheet/:rider")
  @ApiProduces(PDF)
  @ApiZodQuery(runSheetQuerySchema)
  async runSheet(@CurrentActor() actor: Actor, @Param("rider") rider: string, @ZQuery(runSheetQuerySchema) query: z.infer<typeof runSheetQuerySchema>, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return send(reply, await this.documents.runSheet(actor, rider, query, meta));
  }

  /** Pre-printed CN label sheet (A4, 3 × 8) for a batch; counts the print like POST /cn/batches/:id/print. */
  @RequirePermissions("parcel:dispatch")
  @Get("cn-sheet/:batchId")
  @ApiProduces(PDF)
  @ApiZodQuery(cnSheetQuerySchema)
  async cnSheet(@CurrentActor() actor: Actor, @Param("batchId", ParseUUIDPipe) batchId: string, @ZQuery(cnSheetQuerySchema) query: z.infer<typeof cnSheetQuerySchema>, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return send(reply, await this.documents.cnSheet(actor, batchId, query, meta));
  }

  @RequirePermissions("parcel:dispatch")
  @Post("cn-sheet/:batchId")
  @HttpCode(200)
  @ApiProduces(PDF)
  @ApiZodBody(cnSheetQuerySchema)
  async cnSheetPost(@CurrentActor() actor: Actor, @Param("batchId", ParseUUIDPipe) batchId: string, @ZBody(cnSheetQuerySchema) body: z.infer<typeof cnSheetQuerySchema>, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return send(reply, await this.documents.cnSheet(actor, batchId, body, meta));
  }

  /** Return run sheet: parcels going back to the merchant, with receipt signatures. */
  @RequirePermissions("parcel:dispatch")
  @Get("return-run/:id")
  @ApiProduces(PDF)
  async returnRun(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return send(reply, await this.documents.returnRun(actor, id, meta));
  }

  /** Accounts › settlement (ST-). Staff, and the account's merchant owner / customer. */
  @Get("payout/:id")
  @ApiProduces(PDF)
  async payout(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return send(reply, await this.documents.payout(actor, id, meta));
  }

  /** Accounts › a Financial merchant's bill (INV-). Staff, and the merchant's owner. */
  @Get("bill/:id")
  @ApiProduces(PDF)
  async bill(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return send(reply, await this.documents.bill(actor, id, meta));
  }

  /** Accounts › an account's statement for a date range (YYYY-MM-DD, Dhaka). Staff, and the account's owner. */
  @Get("account-statement/:id")
  @ApiProduces(PDF)
  @ApiZodQuery(dateRangeQuerySchema)
  async accountStatement(
    @CurrentActor() actor: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @ZQuery(dateRangeQuerySchema) query: z.infer<typeof dateRangeQuerySchema>,
    @ReqMeta() meta: RequestMeta,
    @Res() reply: FastifyReply,
  ) {
    return send(reply, await this.documents.accountStatement(actor, id, query, meta));
  }

  /** A rider's cash handover slip (HS-) with its barcode: the rider's own, hub staff's hubs'. */
  @Get("cash-slip/:key")
  @ApiProduces(PDF)
  async cashSlip(@CurrentActor() actor: Actor, @Param("key") key: string, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return send(reply, await this.documents.cashSlip(actor, key, meta));
  }

  /** A hub's cash transfer to the central hub (HT-). */
  @RequirePermissions("cod:receive")
  @Get("hub-transfer/:key")
  @ApiProduces(PDF)
  async hubTransfer(@CurrentActor() actor: Actor, @Param("key") key: string, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return send(reply, await this.documents.hubTransfer(actor, key, meta));
  }

  /** A stored report run (Reports page) as a table. */
  @RequirePermissions("parcel:read:any")
  @Get("report/:runId")
  @ApiProduces(PDF)
  async report(@CurrentActor() actor: Actor, @Param("runId", ParseUUIDPipe) runId: string, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return send(reply, await this.documents.report(actor, runId, meta));
  }

  /** End-of-day hub reconciliation for a hub and a Dhaka day (hub operators: their own hubs). */
  @RequirePermissions("hub:read", "parcel:read:any")
  @Get("hub-reconciliation")
  @ApiProduces(PDF)
  @ApiZodQuery(hubReconciliationQuerySchema)
  async hubReconciliation(@CurrentActor() actor: Actor, @ZQuery(hubReconciliationQuerySchema) query: z.infer<typeof hubReconciliationQuerySchema>, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return send(reply, await this.documents.hubReconciliation(actor, query, meta));
  }

  /** SLA attainment report for a Dhaka date range. */
  @RequirePermissions("parcel:read:any")
  @Get("sla-report")
  @ApiProduces(PDF)
  @ApiZodQuery(slaReportQuerySchema)
  async slaReport(@CurrentActor() actor: Actor, @ZQuery(slaReportQuerySchema) query: z.infer<typeof slaReportQuerySchema>, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return send(reply, await this.documents.slaReport(actor, query, meta));
  }
}
