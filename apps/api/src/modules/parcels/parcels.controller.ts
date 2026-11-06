import { Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from "@nestjs/common";
import { ApiHeader, ApiProduces, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply } from "fastify";
import type { z } from "zod";
import {
  assignPickupHubSchema,
  assignRiderSchema,
  cancelParcelSchema,
  createParcelSchema,
  deliveryOutcomeSchema,
  pickupOutcomeSchema,
  updateStatusSchema,
} from "@delivery-fast/shared";
import { AllowApiKey, CurrentActor, CurrentUser, Public, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { PrismaService } from "../../common/prisma.service";
import { withIdempotency } from "../../common/idempotency";
import { ParcelsService } from "./parcels.service";
import { RiderTasksService } from "./rider-tasks.service";
import { ParcelExportService } from "./parcel-export.service";
import { exportParcelsQuerySchema, parcelNoteSchema, riderHandoverSchema, riderReturnSchema, riderHandoversQuerySchema, trackQuerySchema, updateParcelDetailsSchema } from "./parcels.schemas";
import { listParcelsWithStageSchema } from "./parcel-stages";
import { RequireApiKeyScope } from "../merchants/api-key-scopes";
import { AnalyticsService } from "../analytics/analytics.service";
import { WebsiteActivityService } from "../analytics/website-activity.service";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

@ApiTags("parcels")
@Controller()
export class ParcelsController {
  constructor(
    private readonly parcels: ParcelsService,
    private readonly riderTasks: RiderTasksService,
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    private readonly website: WebsiteActivityService,
    private readonly exports: ParcelExportService,
  ) {}

  /** Public tracking by ID (masked: no phones or street addresses). */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get("track/:trackingId")
  @ApiZodQuery(trackQuerySchema)
  async track(@Param("trackingId") trackingId: string, @ZQuery(trackQuerySchema) query: z.infer<typeof trackQuerySchema>, @ReqMeta() meta: RequestMeta) {
    // ?t= (the SMS / guest link) unlocks the delivery rider's live position; the ID alone doesn't.
    const result = await this.parcels.publicTrack(trackingId, query.t);
    this.analytics.countTrackingLookup(); // first-party analytics: the daily / hourly count
    // Which parcel was tracked and when (Platform activity › Parcel tracking); nothing about the visitor is kept.
    this.website.recordTrackingLookup(result.trackingId, query.t ? "link" : "search", meta);
    return result;
  }

  /** Book a parcel. Customers, merchants (portal or API key) and operations. Send an Idempotency-Key to retry safely. */
  @AllowApiKey()
  @RequireApiKeyScope("parcels:write")
  @RequirePermissions("parcel:create")
  @Post("parcels")
  @ApiHeader({ name: "Idempotency-Key", required: false })
  @ApiZodBody(createParcelSchema)
  create(
    @CurrentActor() actor: Actor,
    @ZBody(createParcelSchema) body: z.infer<typeof createParcelSchema>,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @ReqMeta() meta: RequestMeta,
    /** For users who belong to several merchants: which one this booking is for. */
    @Query("merchantId", new ParseUUIDPipe({ optional: true })) merchantId?: string,
  ) {
    const scope = actor.kind === "api_key" ? `merchant:${actor.merchantId}` : `user:${actor.userId}`;
    return withIdempotency(this.prisma, scope, idempotencyKey, { merchantId, body }, () => this.parcels.create(actor, body, meta, { merchantId }));
  }

  @AllowApiKey()
  @RequireApiKeyScope("parcels:read")
  @Get("parcels")
  @ApiZodQuery(listParcelsWithStageSchema)
  list(@CurrentActor() actor: Actor, @ZQuery(listParcelsWithStageSchema) query: z.infer<typeof listParcelsWithStageSchema>) {
    return this.parcels.list(actor, query);
  }

  /**
   * All parcels › Export: the filtered parcels (or the ticked `trackingIds`) as an .xlsx file. Columns follow
   * the filters: delivery details for Delivered, return details for Returned, COD for E-commerce.
   * Headers: X-Row-Count (rows in the file), X-Matched (parcels matching), X-Row-Limit.
   */
  @RequirePermissions("parcel:read:any")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("parcels/export")
  @ApiProduces(XLSX)
  @ApiZodQuery(exportParcelsQuerySchema)
  async export(@CurrentActor() actor: Actor, @ZQuery(exportParcelsQuerySchema) query: z.infer<typeof exportParcelsQuerySchema>, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return this.sendExport(reply, await this.exports.export(actor, query, meta));
  }

  /**
   * Merchant panels: the merchant's own filtered parcels (or the ticked `trackingIds`) as .xlsx, with no internal
   * data. Columns follow the merchant type and status; charges are for owners. `merchantId`: for users of several merchants.
   */
  @RequirePermissions("parcel:read:own")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("merchants/me/parcels/export")
  @ApiProduces(XLSX)
  @ApiZodQuery(exportParcelsQuerySchema)
  async merchantExport(@CurrentActor() actor: Actor, @ZQuery(exportParcelsQuerySchema) query: z.infer<typeof exportParcelsQuerySchema>, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    return this.sendExport(reply, await this.exports.merchantExport(actor, query, meta));
  }

  private sendExport(reply: FastifyReply, file: { buffer: Buffer; fileName: string; count: number; matched: number; maxRows: number }) {
    return reply
      .status(200)
      .header("content-type", XLSX)
      .header("content-disposition", `attachment; filename="${file.fileName}"`)
      .header("cache-control", "no-store")
      .header("x-row-count", String(file.count))
      .header("x-matched", String(file.matched))
      .header("x-row-limit", String(file.maxRows))
      .header("access-control-expose-headers", "x-row-count, x-matched, x-row-limit, content-disposition")
      .send(file.buffer);
  }

  @AllowApiKey()
  @RequireApiKeyScope("parcels:read")
  @Get("parcels/:trackingId")
  detail(@CurrentActor() actor: Actor, @Param("trackingId") trackingId: string) {
    return this.parcels.detail(actor, trackingId);
  }

  @AllowApiKey()
  @RequireApiKeyScope("parcels:cancel")
  @Post("parcels/:trackingId/cancel")
  @HttpCode(200)
  @ApiZodBody(cancelParcelSchema)
  cancel(@CurrentActor() actor: Actor, @Param("trackingId") trackingId: string, @ZBody(cancelParcelSchema) body: z.infer<typeof cancelParcelSchema>, @ReqMeta() meta: RequestMeta) {
    return this.parcels.cancel(actor, trackingId, body, meta);
  }

  // ── operations ──

  @RequirePermissions("parcel:dispatch")
  @Post("parcels/:trackingId/pickup-hub")
  @HttpCode(200)
  @ApiZodBody(assignPickupHubSchema)
  assignPickupHub(@CurrentActor() actor: Actor, @Param("trackingId") trackingId: string, @ZBody(assignPickupHubSchema) body: z.infer<typeof assignPickupHubSchema>, @ReqMeta() meta: RequestMeta) {
    return this.parcels.assignPickupHub(actor, trackingId, body, meta);
  }

  @RequirePermissions("parcel:dispatch")
  @Post("parcels/:trackingId/assign-pickup")
  @HttpCode(200)
  @ApiZodBody(assignRiderSchema)
  assignPickup(@CurrentActor() actor: Actor, @Param("trackingId") trackingId: string, @ZBody(assignRiderSchema) body: z.infer<typeof assignRiderSchema>, @ReqMeta() meta: RequestMeta) {
    return this.parcels.assignPickup(actor, trackingId, body, meta);
  }

  @RequirePermissions("parcel:dispatch")
  @Post("parcels/:trackingId/assign-delivery")
  @HttpCode(200)
  @ApiZodBody(assignRiderSchema)
  assignDelivery(@CurrentActor() actor: Actor, @Param("trackingId") trackingId: string, @ZBody(assignRiderSchema) body: z.infer<typeof assignRiderSchema>, @ReqMeta() meta: RequestMeta) {
    return this.parcels.assignDelivery(actor, trackingId, body, meta);
  }

  @RequirePermissions("parcel:dispatch")
  @Post("parcels/:trackingId/status")
  @HttpCode(200)
  @ApiZodBody(updateStatusSchema)
  setStatus(@CurrentActor() actor: Actor, @Param("trackingId") trackingId: string, @ZBody(updateStatusSchema) body: z.infer<typeof updateStatusSchema>, @ReqMeta() meta: RequestMeta) {
    return this.parcels.setStatus(actor, trackingId, body, meta);
  }

  /** Price-neutral corrections: recipient name/phone, street, area and instructions. */
  @RequirePermissions("parcel:dispatch")
  @Patch("parcels/:trackingId")
  @ApiZodBody(updateParcelDetailsSchema)
  updateDetails(
    @CurrentActor() actor: Actor,
    @Param("trackingId") trackingId: string,
    @ZBody(updateParcelDetailsSchema) body: z.infer<typeof updateParcelDetailsSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.parcels.updateDetails(actor, trackingId, body, meta);
  }

  /** Internal note on the parcel's timeline (staff only). */
  @RequirePermissions("parcel:dispatch")
  @Post("parcels/:trackingId/notes")
  @ApiZodBody(parcelNoteSchema)
  addNote(@CurrentActor() actor: Actor, @Param("trackingId") trackingId: string, @ZBody(parcelNoteSchema) body: z.infer<typeof parcelNoteSchema>, @ReqMeta() meta: RequestMeta) {
    return this.parcels.addNote(actor, trackingId, body, meta);
  }

  // ── rider ──

  /** Today's, this week's and this month's work for the signed-in rider. */
  @RequirePermissions("parcel:rider-update")
  @Get("rider/summary")
  summary(@CurrentUser() actor: UserActor) {
    return this.riderTasks.summary(actor);
  }

  @RequirePermissions("parcel:rider-update")
  @Get("rider/tasks")
  tasks(@CurrentUser() actor: UserActor) {
    return this.riderTasks.tasks(actor);
  }

  // Rider task updates accept an Idempotency-Key: the rider app queues them while offline and
  // replays them when the connection returns, so a retry after a lost response is harmless.

  @RequirePermissions("parcel:rider-update")
  @Post("rider/parcels/:trackingId/pickup")
  @HttpCode(200)
  @ApiHeader({ name: "Idempotency-Key", required: false })
  @ApiZodBody(pickupOutcomeSchema)
  pickup(
    @CurrentUser() actor: UserActor,
    @Param("trackingId") trackingId: string,
    @ZBody(pickupOutcomeSchema) body: z.infer<typeof pickupOutcomeSchema>,
    @ReqMeta() meta: RequestMeta,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return withIdempotency(this.prisma, `rider:${actor.userId}`, idempotencyKey, { op: "pickup", trackingId, body }, () => this.riderTasks.pickup(actor, trackingId, body, meta));
  }

  @RequirePermissions("parcel:rider-update")
  @Post("rider/parcels/:trackingId/start-delivery")
  @HttpCode(200)
  @ApiHeader({ name: "Idempotency-Key", required: false })
  startDelivery(@CurrentUser() actor: UserActor, @Param("trackingId") trackingId: string, @ReqMeta() meta: RequestMeta, @Headers("idempotency-key") idempotencyKey?: string) {
    return withIdempotency(this.prisma, `rider:${actor.userId}`, idempotencyKey, { op: "start-delivery", trackingId }, () => this.riderTasks.startDelivery(actor, trackingId, meta));
  }

  @RequirePermissions("parcel:rider-update")
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @Post("rider/parcels/:trackingId/resend-code")
  @HttpCode(200)
  resendCode(@CurrentUser() actor: UserActor, @Param("trackingId") trackingId: string) {
    return this.riderTasks.resendDeliveryCode(actor, trackingId);
  }

  @RequirePermissions("parcel:rider-update")
  @Post("rider/parcels/:trackingId/delivery")
  @HttpCode(200)
  @ApiHeader({ name: "Idempotency-Key", required: false })
  @ApiZodBody(deliveryOutcomeSchema)
  deliver(
    @CurrentUser() actor: UserActor,
    @Param("trackingId") trackingId: string,
    @ZBody(deliveryOutcomeSchema) body: z.infer<typeof deliveryOutcomeSchema>,
    @ReqMeta() meta: RequestMeta,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return withIdempotency(this.prisma, `rider:${actor.userId}`, idempotencyKey, { op: "delivery", trackingId, body }, () => this.riderTasks.deliver(actor, trackingId, body, meta));
  }

  /** "Hand over at hub" scan: puts a collected parcel on the rider's handover list for a hub (the hub scans it in). */
  @RequirePermissions("parcel:rider-update")
  @Post("rider/parcels/:trackingId/handover")
  @HttpCode(200)
  @ApiHeader({ name: "Idempotency-Key", required: false })
  @ApiZodBody(riderHandoverSchema)
  handover(
    @CurrentUser() actor: UserActor,
    @Param("trackingId") trackingId: string,
    @ZBody(riderHandoverSchema) body: z.infer<typeof riderHandoverSchema>,
    @ReqMeta() meta: RequestMeta,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return withIdempotency(this.prisma, `rider:${actor.userId}`, idempotencyKey, { op: "handover", trackingId, body }, () => this.riderTasks.handover(actor, trackingId, body, meta));
  }

  /** Undo of a handover scan, until the hub has scanned the parcel in. */
  @RequirePermissions("parcel:rider-update")
  @Post("rider/parcels/:trackingId/handover/withdraw")
  @HttpCode(200)
  @ApiHeader({ name: "Idempotency-Key", required: false })
  withdrawHandover(@CurrentUser() actor: UserActor, @Param("trackingId") trackingId: string, @ReqMeta() meta: RequestMeta, @Headers("idempotency-key") idempotencyKey?: string) {
    return withIdempotency(this.prisma, `rider:${actor.userId}`, idempotencyKey, { op: "handover-withdraw", trackingId }, () => this.riderTasks.withdrawHandover(actor, trackingId, meta));
  }

  /** Parcels riders handed over at a hub that the hub hasn't scanned in yet (for the receive desk). */
  @RequirePermissions("parcel:read:any")
  @Get("ops/rider-handovers")
  @ApiZodQuery(riderHandoversQuerySchema)
  hubHandovers(@CurrentActor() actor: Actor, @ZQuery(riderHandoversQuerySchema) query: z.infer<typeof riderHandoversQuerySchema>) {
    return this.riderTasks.hubHandovers(actor, query.hubId);
  }

  /** Return runs assigned to the rider (planned or out for return), with the parcels still to return. */
  @RequirePermissions("parcel:rider-update")
  @Get("rider/return-runs")
  returnRuns(@CurrentUser() actor: UserActor) {
    return this.riderTasks.returnRuns(actor);
  }

  /** "Return to merchant": the merchant took this parcel back from the rider of its return run: Returned. */
  @RequirePermissions("parcel:rider-update")
  @Post("rider/parcels/:trackingId/return")
  @HttpCode(200)
  @ApiHeader({ name: "Idempotency-Key", required: false })
  @ApiZodBody(riderReturnSchema)
  returnToMerchant(
    @CurrentUser() actor: UserActor,
    @Param("trackingId") trackingId: string,
    @ZBody(riderReturnSchema) body: z.infer<typeof riderReturnSchema>,
    @ReqMeta() meta: RequestMeta,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return withIdempotency(this.prisma, `rider:${actor.userId}`, idempotencyKey, { op: "return", trackingId, body }, () => this.riderTasks.returnToMerchant(actor, trackingId, body, meta));
  }

  @RequirePermissions("cod:collect")
  @Get("rider/cash")
  cash(@CurrentUser() actor: UserActor) {
    return this.riderTasks.cash(actor);
  }
}
