import type { z } from "zod";
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { deliveryOutcomeSchema, pickupOutcomeSchema } from "@delivery-fast/shared";
import { CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ZBody } from "../../common/zod";
import { collectSchema } from "../parcels/collections.service";
import { riderReturnSchema } from "../parcels/parcels.schemas";
import { FranchisePanelService } from "./franchise-panel.service";
import { franchiseReturnAssignSchema, franchiseReturnTransferSchema, franchiseTransferScanSchema } from "./franchise.schemas";

/**
 * The franchise app's Scan (the Operations app's Scan without CN labels): hub transfer, hub return, return rider
 * assign, hub collection and Rider operation, at the franchise's own hub with its own riders. Receive at hub and
 * Delivery rider assign are POST /franchise/receive and /franchise/assign-scan; Assign pickup rider is
 * POST /franchise/parcels/:id/assign.
 */
@ApiTags("franchise")
@Controller("franchise")
@RequirePermissions("franchise:self")
export class FranchiseScanController {
  constructor(private readonly panel: FranchisePanelService) {}

  @Post("transfer-scan")
  @HttpCode(200)
  @ApiZodBody(franchiseTransferScanSchema)
  transfer(@CurrentActor() actor: Actor, @ZBody(franchiseTransferScanSchema) body: z.infer<typeof franchiseTransferScanSchema>, @ReqMeta() meta: RequestMeta) {
    return this.panel.transferScan(actor, body, meta);
  }

  @Post("return-transfer")
  @HttpCode(200)
  @ApiZodBody(franchiseReturnTransferSchema)
  returnTransfer(@CurrentActor() actor: Actor, @ZBody(franchiseReturnTransferSchema) body: z.infer<typeof franchiseReturnTransferSchema>, @ReqMeta() meta: RequestMeta) {
    return this.panel.returnTransfer(actor, body, meta);
  }

  @Get("returns-summary")
  returnsSummary(@CurrentActor() actor: Actor) {
    return this.panel.returnsSummary(actor);
  }

  @Post("return-assign")
  @HttpCode(200)
  @ApiZodBody(franchiseReturnAssignSchema)
  returnAssign(@CurrentActor() actor: Actor, @ZBody(franchiseReturnAssignSchema) body: z.infer<typeof franchiseReturnAssignSchema>, @ReqMeta() meta: RequestMeta) {
    return this.panel.returnAssign(actor, body, meta);
  }

  @Get("parcels/:trackingId")
  parcel(@CurrentActor() actor: Actor, @Param("trackingId") trackingId: string) {
    return this.panel.parcelDetail(actor, trackingId);
  }

  @Post("parcels/:trackingId/collect")
  @HttpCode(200)
  @ApiZodBody(collectSchema)
  collect(@CurrentUser() actor: UserActor, @Param("trackingId") trackingId: string, @ZBody(collectSchema) body: z.infer<typeof collectSchema>, @ReqMeta() meta: RequestMeta) {
    return this.panel.collect(actor, trackingId, body, meta);
  }

  // ── Rider operation: one of the franchise's riders, the rider app's steps ──

  @Get("rider-op/:riderId/tasks")
  tasks(@CurrentUser() actor: UserActor, @Param("riderId", ParseUUIDPipe) riderId: string) {
    return this.panel.riderOperation(actor, t => t.tasks(actor, riderId));
  }

  @Get("rider-op/:riderId/return-runs")
  returnRuns(@CurrentUser() actor: UserActor, @Param("riderId", ParseUUIDPipe) riderId: string) {
    return this.panel.riderOperation(actor, t => t.returnRuns(actor, riderId));
  }

  @Post("rider-op/:riderId/parcels/:trackingId/pickup")
  @HttpCode(200)
  @ApiZodBody(pickupOutcomeSchema)
  pickup(@CurrentUser() actor: UserActor, @Param("riderId", ParseUUIDPipe) riderId: string, @Param("trackingId") trackingId: string, @ZBody(pickupOutcomeSchema) body: z.infer<typeof pickupOutcomeSchema>, @ReqMeta() meta: RequestMeta) {
    return this.panel.riderOperation(actor, t => t.pickup(actor, trackingId, body, meta, riderId));
  }

  @Post("rider-op/:riderId/parcels/:trackingId/start-delivery")
  @HttpCode(200)
  startDelivery(@CurrentUser() actor: UserActor, @Param("riderId", ParseUUIDPipe) riderId: string, @Param("trackingId") trackingId: string, @ReqMeta() meta: RequestMeta) {
    return this.panel.riderOperation(actor, t => t.startDelivery(actor, trackingId, meta, riderId));
  }

  @Post("rider-op/:riderId/parcels/:trackingId/resend-code")
  @HttpCode(200)
  resendCode(@CurrentUser() actor: UserActor, @Param("riderId", ParseUUIDPipe) riderId: string, @Param("trackingId") trackingId: string) {
    return this.panel.riderOperation(actor, t => t.resendDeliveryCode(actor, trackingId, riderId));
  }

  @Post("rider-op/:riderId/parcels/:trackingId/delivery")
  @HttpCode(200)
  @ApiZodBody(deliveryOutcomeSchema)
  deliver(@CurrentUser() actor: UserActor, @Param("riderId", ParseUUIDPipe) riderId: string, @Param("trackingId") trackingId: string, @ZBody(deliveryOutcomeSchema) body: z.infer<typeof deliveryOutcomeSchema>, @ReqMeta() meta: RequestMeta) {
    return this.panel.riderOperation(actor, t => t.deliver(actor, trackingId, body, meta, riderId));
  }

  @Post("rider-op/:riderId/parcels/:trackingId/return")
  @HttpCode(200)
  @ApiZodBody(riderReturnSchema)
  returnToMerchant(@CurrentUser() actor: UserActor, @Param("riderId", ParseUUIDPipe) riderId: string, @Param("trackingId") trackingId: string, @ZBody(riderReturnSchema) body: z.infer<typeof riderReturnSchema>, @ReqMeta() meta: RequestMeta) {
    return this.panel.riderOperation(actor, t => t.returnToMerchant(actor, trackingId, body, meta, riderId));
  }
}
