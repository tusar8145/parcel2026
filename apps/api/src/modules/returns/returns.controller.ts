import type { z } from "zod";
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { AllowApiKey, CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { RequireApiKeyScope } from "../merchants/api-key-scopes";
import {
  ReturnsService,
  addToReturnRunSchema,
  completeReturnRunSchema,
  createReturnRunSchema,
  dispatchReturnRunSchema,
  listReturnRunsQuerySchema,
  listReturnsQuerySchema,
  returnRequestSchema,
  deskReturnAssignSchema,
  deskReturnRunsQuerySchema,
} from "./returns.service";

@ApiTags("returns")
@Controller()
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Get("returns/reasons")
  reasons() {
    return this.returns.reasons();
  }

  /** Returns (RTO) the actor can see: merchants their own, operations all. Filter by stage. */
  @AllowApiKey()
  @RequireApiKeyScope("parcels:read", "returns:write")
  @Get("returns")
  @ApiZodQuery(listReturnsQuerySchema)
  list(@CurrentActor() actor: Actor, @ZQuery(listReturnsQuerySchema) query: z.infer<typeof listReturnsQuerySchema>) {
    return this.returns.list(actor, query);
  }

  /** Ask for an undeliverable parcel to be returned to the merchant. */
  @AllowApiKey()
  @RequireApiKeyScope("returns:write")
  @RequirePermissions("parcel:read:own")
  @Post("parcels/:trackingId/return-request")
  @HttpCode(200)
  @ApiZodBody(returnRequestSchema)
  request(@CurrentActor() actor: Actor, @Param("trackingId") trackingId: string, @ZBody(returnRequestSchema) body: z.infer<typeof returnRequestSchema>, @ReqMeta() meta: RequestMeta) {
    return this.returns.request(actor, trackingId, body, meta);
  }

  /** The merchant confirms they received the returned parcel. */
  @AllowApiKey()
  @RequireApiKeyScope("returns:write")
  @RequirePermissions("parcel:read:own")
  @Post("parcels/:trackingId/return-received")
  @HttpCode(200)
  received(@CurrentActor() actor: Actor, @Param("trackingId") trackingId: string, @ReqMeta() meta: RequestMeta) {
    return this.returns.confirmReceived(actor, trackingId, meta);
  }

  // ── operations ──

  @RequirePermissions("parcel:dispatch")
  @Get("returns/runs")
  @ApiZodQuery(listReturnRunsQuerySchema)
  runs(@CurrentActor() actor: Actor, @ZQuery(listReturnRunsQuerySchema) query: z.infer<typeof listReturnRunsQuerySchema>) {
    return this.returns.listRuns(actor, query);
  }

  @RequirePermissions("parcel:dispatch")
  @Get("returns/runs/:id")
  run(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string) {
    return this.returns.run(actor, id);
  }

  @RequirePermissions("parcel:dispatch")
  @Post("returns/runs")
  @ApiZodBody(createReturnRunSchema)
  createRun(@CurrentActor() actor: Actor, @ZBody(createReturnRunSchema) body: z.infer<typeof createReturnRunSchema>, @ReqMeta() meta: RequestMeta) {
    return this.returns.createRun(actor, body, meta);
  }

  /** Adds parcels to a planned run (at a hub, awaiting retry, in exception, or scheduled for return without a run). */
  @RequirePermissions("parcel:dispatch")
  @Post("returns/runs/:id/parcels")
  @HttpCode(200)
  @ApiZodBody(addToReturnRunSchema)
  addParcels(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(addToReturnRunSchema) body: z.infer<typeof addToReturnRunSchema>, @ReqMeta() meta: RequestMeta) {
    return this.returns.addToRun(actor, id, body, meta);
  }

  @RequirePermissions("parcel:dispatch")
  @Post("returns/runs/:id/dispatch")
  @HttpCode(200)
  @ApiZodBody(dispatchReturnRunSchema)
  dispatch(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(dispatchReturnRunSchema) body: z.infer<typeof dispatchReturnRunSchema>, @ReqMeta() meta: RequestMeta) {
    return this.returns.dispatchRun(actor, id, body, meta);
  }

  @RequirePermissions("parcel:dispatch")
  @Post("returns/runs/:id/complete")
  @HttpCode(200)
  @ApiZodBody(completeReturnRunSchema)
  complete(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(completeReturnRunSchema) body: z.infer<typeof completeReturnRunSchema>, @ReqMeta() meta: RequestMeta) {
    return this.returns.completeRun(actor, id, body, meta);
  }

  @RequirePermissions("parcel:dispatch")
  @Post("returns/runs/:id/cancel")
  @HttpCode(200)
  cancel(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.returns.cancelRun(actor, id, meta);
  }

  /** Scan desk → Return rider assign: the scanned parcel joins the rider's planned run for its merchant (created when none). */
  @RequirePermissions("parcel:dispatch")
  @Post("hub-desk/return-assign")
  @HttpCode(200)
  @ApiZodBody(deskReturnAssignSchema)
  deskAssign(@CurrentActor() actor: Actor, @ZBody(deskReturnAssignSchema) body: z.infer<typeof deskReturnAssignSchema>, @ReqMeta() meta: RequestMeta) {
    return this.returns.deskAssign(actor, body, meta);
  }

  /** Scan desk: the planned return runs of the hub, to send out (POST /returns/runs/:id/dispatch). */
  @RequirePermissions("parcel:read:any")
  @Get("hub-desk/return-runs")
  @ApiZodQuery(deskReturnRunsQuerySchema)
  deskRuns(@CurrentActor() actor: Actor, @ZQuery(deskReturnRunsQuerySchema) query: z.infer<typeof deskReturnRunsQuerySchema>) {
    return this.returns.deskPlannedRuns(actor, query);
  }
}
