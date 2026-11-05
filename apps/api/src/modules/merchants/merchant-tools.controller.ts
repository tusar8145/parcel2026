import type { z } from "zod";
import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { FastifyReply } from "fastify";
import { CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { AppError } from "../../common/errors";
import { listProductsQuerySchema, merchantSelectorSchema, productSchema, REPORT_KINDS, reportQuerySchema, updateProductSchema, type ReportKind } from "./merchants.schemas";
import { MerchantToolsService } from "./merchant-tools.service";

type Selector = z.infer<typeof merchantSelectorSchema>;

/** Product catalogue and report exports for merchant owners and staff. */
@ApiTags("merchant self-service")
@Controller("merchants/me")
export class MerchantToolsController {
  constructor(private readonly tools: MerchantToolsService) {}

  @RequirePermissions("parcel:create")
  @Get("products")
  @ApiZodQuery(listProductsQuerySchema)
  products(@CurrentActor() actor: Actor, @ZQuery(listProductsQuerySchema) query: z.infer<typeof listProductsQuerySchema>) {
    return this.tools.listProducts(actor, query);
  }

  @RequirePermissions("parcel:create")
  @Post("products")
  @ApiZodQuery(merchantSelectorSchema)
  @ApiZodBody(productSchema)
  createProduct(@CurrentActor() actor: Actor, @ZQuery(merchantSelectorSchema) query: Selector, @ZBody(productSchema) body: z.infer<typeof productSchema>, @ReqMeta() meta: RequestMeta) {
    return this.tools.createProduct(actor, query.merchantId, body, meta);
  }

  @RequirePermissions("parcel:create")
  @Patch("products/:id")
  @ApiZodQuery(merchantSelectorSchema)
  @ApiZodBody(updateProductSchema)
  updateProduct(
    @CurrentActor() actor: Actor,
    @ZQuery(merchantSelectorSchema) query: Selector,
    @Param("id", ParseUUIDPipe) id: string,
    @ZBody(updateProductSchema) body: z.infer<typeof updateProductSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.tools.updateProduct(actor, query.merchantId, id, body, meta);
  }

  @RequirePermissions("parcel:create")
  @Delete("products/:id")
  @HttpCode(204)
  @ApiZodQuery(merchantSelectorSchema)
  deleteProduct(@CurrentActor() actor: Actor, @ZQuery(merchantSelectorSchema) query: Selector, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.tools.deleteProduct(actor, query.merchantId, id, meta);
  }

  /**
   * Report rows from live data (see GET /merchants/me/reports). format=xlsx downloads Excel, format=csv
   * (default) a CSV file; format=json returns the columns, rows, totals and highlights.
   */
  /** The reports this person can open: by merchant type, and money reports for owners only. */
  @RequirePermissions("parcel:read:own")
  @Get("reports")
  @ApiZodQuery(merchantSelectorSchema)
  reports(@CurrentActor() actor: Actor, @ZQuery(merchantSelectorSchema) query: Selector) {
    return this.tools.reportCatalog(actor, query);
  }

  @RequirePermissions("parcel:read:own")
  @Get("reports/:kind")
  @ApiZodQuery(reportQuerySchema)
  async report(@CurrentActor() actor: Actor, @Param("kind") kind: string, @ZQuery(reportQuerySchema) query: z.infer<typeof reportQuerySchema>, @Res({ passthrough: true }) reply: FastifyReply) {
    if (!(REPORT_KINDS as readonly string[]).includes(kind)) throw new AppError("NOT_FOUND", `Unknown report. Choose one of ${REPORT_KINDS.join(", ")}`, 404);
    const report = await this.tools.report(actor, kind as ReportKind, query);
    if (query.format === "json") return report;
    const day = report.to.slice(0, 10);
    if (query.format === "xlsx") {
      reply
        .header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("content-disposition", `attachment; filename="${kind}-${report.from.slice(0, 10)}-to-${day}.xlsx"`)
        .header("cache-control", "private, no-store");
      return this.tools.reportXlsx(report);
    }
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${kind}-${day}.csv"`).header("cache-control", "private, no-store");
    return this.tools.reportCsv(report);
  }
}
