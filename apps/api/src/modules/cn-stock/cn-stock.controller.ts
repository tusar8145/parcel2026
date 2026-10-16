import type { z } from "zod";
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { createBatchSchema, listBatchesQuerySchema, listStockQuerySchema, printSchema, updateBatchSchema, voidSchema } from "./cn-stock.schemas";
import { CnStockService } from "./cn-stock.service";

/** Pre-printed consignment-number stock (batches, labels, voids). Book with `cn` to use one. */
@ApiTags("cn-stock")
@Controller("cn")
export class CnStockController {
  constructor(private readonly cn: CnStockService) {}

  @RequirePermissions("hub:read")
  @Get("summary")
  summary(@CurrentActor() actor: Actor) {
    return this.cn.summary(actor);
  }

  @RequirePermissions("hub:read")
  @Get("batches")
  @ApiZodQuery(listBatchesQuerySchema)
  batches(@CurrentActor() actor: Actor, @ZQuery(listBatchesQuerySchema) query: z.infer<typeof listBatchesQuerySchema>) {
    return this.cn.listBatches(actor, query);
  }

  /** Allocates a batch of consignment numbers (up to 1000) for a hub and/or merchant. */
  @RequirePermissions("parcel:dispatch")
  @Post("batches")
  @ApiZodBody(createBatchSchema)
  create(@CurrentActor() actor: Actor, @ZBody(createBatchSchema) body: z.infer<typeof createBatchSchema>, @ReqMeta() meta: RequestMeta) {
    return this.cn.createBatch(actor, body, meta);
  }

  @RequirePermissions("hub:read")
  @Get("batches/:id")
  batch(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string) {
    return this.cn.getBatch(actor, id);
  }

  /** Re-assigns a batch to a hub or merchant. */
  @RequirePermissions("parcel:dispatch")
  @Patch("batches/:id")
  @ApiZodBody(updateBatchSchema)
  update(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(updateBatchSchema) body: z.infer<typeof updateBatchSchema>, @ReqMeta() meta: RequestMeta) {
    return this.cn.updateBatch(actor, id, body, meta);
  }

  /** Records a label print run and returns the CNs to print (unused ones unless listed). */
  @RequirePermissions("parcel:dispatch")
  @Post("batches/:id/print")
  @HttpCode(200)
  @ApiZodBody(printSchema)
  print(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(printSchema) body: z.infer<typeof printSchema>, @ReqMeta() meta: RequestMeta) {
    return this.cn.print(actor, id, body, meta);
  }

  @RequirePermissions("hub:read")
  @Get("stock")
  @ApiZodQuery(listStockQuerySchema)
  stock(@CurrentActor() actor: Actor, @ZQuery(listStockQuerySchema) query: z.infer<typeof listStockQuerySchema>) {
    return this.cn.listStock(actor, query);
  }

  @RequirePermissions("parcel:dispatch")
  @Post("stock/void")
  @HttpCode(200)
  @ApiZodBody(voidSchema)
  void(@CurrentActor() actor: Actor, @ZBody(voidSchema) body: z.infer<typeof voidSchema>, @ReqMeta() meta: RequestMeta) {
    return this.cn.voidStock(actor, body, meta);
  }

  @RequirePermissions("hub:read")
  @Get("stock/:cn")
  lookup(@CurrentActor() actor: Actor, @Param("cn") cn: string) {
    return this.cn.lookup(actor, cn);
  }
}
