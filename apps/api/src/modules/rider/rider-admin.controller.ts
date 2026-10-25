import { Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from "@nestjs/common";
import { RequireApiKeyScope } from "../merchants/api-key-scopes";
import { ApiProduces, ApiTags } from "@nestjs/swagger";
import type { FastifyReply } from "fastify";
import type { z } from "zod";
import { AllowApiKey, CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { RiderLocationService } from "./location.service";
import { ProofService } from "./proof.service";
import { RiderPayService } from "./pay.service";
import { RiderKycService } from "./kyc.service";
import {
  adjustmentSchema,
  cancelSchema,
  earningsQuerySchema,
  kycDecisionSchema,
  kycDocumentReviewSchema,
  kycQueueQuerySchema,
  locationHistoryQuerySchema,
  payoutRunSchema,
  payoutsQuerySchema,
  payPayoutSchema,
  payPlanSchema,
  riderLocationsQuerySchema,
  startOnboardingSchema,
  syncPlansSchema,
} from "./rider.schemas";
import { OutboxService } from "../notifications/outbox.service";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";

/** Operations, hub and finance views of riders: live map, pay, cash handover requests, KYC. Plus proof of delivery. */
@ApiTags("rider operations")
@Controller()
export class RiderAdminController {
  constructor(
    private readonly locations: RiderLocationService,
    private readonly proofs: ProofService,
    private readonly pay: RiderPayService,
    private readonly kyc: RiderKycService,
    private readonly outbox: OutboxService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── proof of delivery ──

  /** Proof of delivery with capture time and place; same visibility as the parcel. */
  @AllowApiKey()
  @RequireApiKeyScope("parcels:read")
  @Get("parcels/:trackingId/proof")
  proof(@CurrentActor() actor: Actor, @Param("trackingId") trackingId: string) {
    return this.proofs.forParcel(actor, trackingId);
  }

  // ── live locations ──

  /** Latest position of each rider on shift (hub operators: their hubs). Updates arrive as `rider.location` events. */
  @RequirePermissions("rider:read")
  @Get("ops/rider-locations")
  @ApiZodQuery(riderLocationsQuerySchema)
  riderLocations(@CurrentActor() actor: Actor, @ZQuery(riderLocationsQuerySchema) query: z.infer<typeof riderLocationsQuerySchema>) {
    return this.locations.latest(actor, query);
  }

  @RequirePermissions("rider:read")
  @Get("ops/rider-locations/:riderId/history")
  @ApiZodQuery(locationHistoryQuerySchema)
  locationHistory(@CurrentActor() actor: Actor, @Param("riderId", ParseUUIDPipe) riderId: string, @ZQuery(locationHistoryQuerySchema) query: z.infer<typeof locationHistoryQuerySchema>) {
    return this.locations.history(actor, riderId, query);
  }

  // ── pay plans, earnings, payouts (finance staff and rider managers) ──

  @Get("rider-pay/plans")
  plans(@CurrentActor() actor: Actor, @Query("riderId", new ParseUUIDPipe({ optional: true })) riderId?: string) {
    return this.pay.listPlans(actor, riderId);
  }

  /** The plan in force for a rider (stored, else derived from the super admin's rider plans). */
  @Get("rider-pay/plans/current/:riderId")
  currentPlan(@CurrentActor() actor: Actor, @Param("riderId", ParseUUIDPipe) riderId: string) {
    return this.pay.currentPlan(actor, riderId);
  }

  @Post("rider-pay/plans")
  @ApiZodBody(payPlanSchema)
  setPlan(@CurrentActor() actor: Actor, @ZBody(payPlanSchema) body: z.infer<typeof payPlanSchema>, @ReqMeta() meta: RequestMeta) {
    return this.pay.setPlan(actor, body, meta);
  }

  /** Seeds stored plans from the super admin's "Rider plans" (platform-config); manual plans are kept. */
  @Post("rider-pay/plans/sync-from-config")
  @HttpCode(200)
  @ApiZodBody(syncPlansSchema)
  syncPlans(@CurrentActor() actor: Actor, @ZBody(syncPlansSchema) body: z.infer<typeof syncPlansSchema>, @ReqMeta() meta: RequestMeta) {
    return this.pay.syncFromConfig(actor, body, meta);
  }

  @Get("rider-pay/earnings")
  @ApiZodQuery(earningsQuerySchema)
  earnings(@CurrentActor() actor: Actor, @ZQuery(earningsQuerySchema) query: z.infer<typeof earningsQuerySchema>) {
    return this.pay.listEarnings(actor, query);
  }

  /** Incentive or deduction on a rider's earnings. */
  @Post("rider-pay/adjustments")
  @ApiZodBody(adjustmentSchema)
  adjustment(@CurrentActor() actor: Actor, @ZBody(adjustmentSchema) body: z.infer<typeof adjustmentSchema>, @ReqMeta() meta: RequestMeta) {
    return this.pay.addAdjustment(actor, body, meta);
  }

  @Get("rider-payouts")
  @ApiZodQuery(payoutsQuerySchema)
  payouts(@CurrentActor() actor: Actor, @ZQuery(payoutsQuerySchema) query: z.infer<typeof payoutsQuerySchema>) {
    return this.pay.listPayouts(actor, query);
  }

  @Get("rider-payouts/:id")
  payout(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string) {
    return this.pay.getPayout(actor, id);
  }

  /** Prepares DRAFT payouts for a period (unpaid earnings + accrued salary). */
  @Post("rider-payouts/runs")
  @ApiZodBody(payoutRunSchema)
  payoutRun(@CurrentActor() actor: Actor, @ZBody(payoutRunSchema) body: z.infer<typeof payoutRunSchema>, @ReqMeta() meta: RequestMeta) {
    return this.pay.createRun(actor, body, meta);
  }

  /** Maker-checker: someone other than the preparer approves. */
  @Post("rider-payouts/:id/approve")
  @HttpCode(200)
  approve(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.pay.approve(actor, id, meta);
  }

  /** Finance marks an approved payout as paid (ledger RIDER_PAYOUT_PAID, rider notified). */
  @RequirePermissions("finance:manage")
  @Post("rider-payouts/:id/pay")
  @HttpCode(200)
  @ApiZodBody(payPayoutSchema)
  markPaid(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(payPayoutSchema) body: z.infer<typeof payPayoutSchema>, @ReqMeta() meta: RequestMeta) {
    return this.pay.markPaid(actor, id, body, meta);
  }

  @Post("rider-payouts/:id/cancel")
  @HttpCode(200)
  @ApiZodBody(cancelSchema)
  cancelPayout(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(cancelSchema) body: z.infer<typeof cancelSchema>, @ReqMeta() meta: RequestMeta) {
    return this.pay.cancel(actor, id, body.note, meta);
  }

  // ── onboarding / KYC review (rider:manage) ──

  /** Starts onboarding for an existing rider: they're asked to upload KYC documents. */
  @RequirePermissions("rider:manage")
  @Post("riders/:id/onboarding")
  @HttpCode(200)
  @ApiZodBody(startOnboardingSchema)
  async startOnboarding(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(startOnboardingSchema) body: z.infer<typeof startOnboardingSchema>, @ReqMeta() meta: RequestMeta) {
    const outboxIds = await this.prisma.$transaction(async tx => {
      const { outboxIds } = await this.kyc.startOnboarding(tx, { riderId: id, applicationId: body.applicationId, note: body.note });
      await this.audit.record(actor, { action: "rider.onboarding.start", entityType: "rider", entityId: id, data: body }, meta, tx);
      return outboxIds;
    });
    await this.outbox.flush(outboxIds);
    return this.kyc.detail(actor, id);
  }

  @RequirePermissions("rider:manage")
  @Get("rider-kyc")
  @ApiZodQuery(kycQueueQuerySchema)
  kycQueue(@CurrentActor() actor: Actor, @ZQuery(kycQueueQuerySchema) query: z.infer<typeof kycQueueQuerySchema>) {
    return this.kyc.queue(actor, query.status);
  }

  @RequirePermissions("rider:manage")
  @Get("rider-kyc/:riderId")
  kycDetail(@CurrentActor() actor: Actor, @Param("riderId", ParseUUIDPipe) riderId: string) {
    return this.kyc.detail(actor, riderId);
  }

  @RequirePermissions("rider:manage")
  @Post("rider-kyc/documents/:id/review")
  @HttpCode(200)
  @ApiZodBody(kycDocumentReviewSchema)
  reviewDocument(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(kycDocumentReviewSchema) body: z.infer<typeof kycDocumentReviewSchema>, @ReqMeta() meta: RequestMeta) {
    return this.kyc.reviewDocument(actor, id, body, meta);
  }

  @RequirePermissions("rider:manage")
  @Post("rider-kyc/:riderId/decision")
  @HttpCode(200)
  @ApiZodBody(kycDecisionSchema)
  decide(@CurrentActor() actor: Actor, @Param("riderId", ParseUUIDPipe) riderId: string, @ZBody(kycDecisionSchema) body: z.infer<typeof kycDecisionSchema>, @ReqMeta() meta: RequestMeta) {
    return this.kyc.decide(actor, riderId, body, meta);
  }

  /** The document's file: the rider who uploaded it, or rider:manage. `Accept: application/json` returns a data URL. */
  @Get("rider-kyc/documents/:id/file")
  @ApiProduces("image/png", "image/jpeg", "image/webp", "application/pdf", "application/json")
  async kycFile(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @Headers("accept") accept: string | undefined, @Res() reply: FastifyReply) {
    const { file, data } = await this.kyc.file(actor, id);
    reply.header("cache-control", "private, no-store").header("vary", "accept").header("x-content-type-options", "nosniff");
    if (accept && /(^|,)\s*application\/json\s*(;|,|$)/i.test(accept)) {
      return reply.status(200).send({ id, filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes, dataUrl: `data:${file.mimeType};base64,${data.toString("base64")}` });
    }
    return reply
      .status(200)
      .header("content-type", file.mimeType)
      .header("content-length", data.length)
      .header("content-disposition", `inline; filename="${file.filename.replace(/["\\\r\n]/g, "_")}"`)
      .send(data);
  }
}
