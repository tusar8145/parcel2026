import type { z } from "zod";
import { Controller, Get, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZodPipe } from "../../common/zod";
import {
  opsBookingDocSchema,
  opsBookingSchema,
  riderReportQueryDoc,
  riderReportQuerySchema,
  transfersQueryDoc,
  transfersQuerySchema,
} from "./ops.schemas";
import { OpsService } from "./ops.service";
import { StageCountsService } from "./stage-counts.service";
import { stageCountsQuerySchema } from "../parcels/parcel-stages";
import { periodQueryShape, periodChecks, periodQuerySchema, type PeriodQuery } from "../../common/period";

/** Stage counts, plus the period's metrics when from / to are sent. */
const opsStageCountsQuerySchema = stageCountsQuerySchema.extend(periodQueryShape).superRefine(periodChecks);

/** Courier Operations console: network counters, dispatch, analytics, reports and bookings by staff. */
@ApiTags("operations")
@Controller("ops")
export class OpsController {
  constructor(
    private readonly ops: OpsService,
    private readonly stages: StageCountsService,
  ) {}

  /**
   * Live counters for the command center, nav badges and priority alerts, plus what the caller may do;
   * `metrics` = what happened in the period (from / to, Dhaka days; default today).
   */
  @RequirePermissions("parcel:read:any")
  @Get("overview")
  @ApiZodQuery(periodQuerySchema)
  overview(@CurrentActor() actor: Actor, @Query(new ZodPipe(periodQuerySchema)) query: PeriodQuery) {
    return this.ops.overview(actor, query);
  }

  /**
   * Parcels per journey stage (menu badges, Today cards, stage metrics); `forHubIds` counts "my hub" only.
   * With from / to (Dhaka days) also `metrics`: booked, picked up, delivered, COD collected… in that period.
   */
  @RequirePermissions("parcel:read:any")
  @Get("stage-counts")
  @ApiZodQuery(opsStageCountsQuerySchema)
  stageCounts(@Query(new ZodPipe(opsStageCountsQuerySchema)) query: z.infer<typeof opsStageCountsQuerySchema>) {
    return this.stages.counts(query);
  }

  /** Assignment queue size and each rider's workload today (hub operators: their hub). */
  @RequirePermissions("parcel:read:any", "rider:read")
  @Get("dispatch")
  dispatch(@CurrentActor() actor: Actor) {
    return this.ops.dispatch(actor);
  }

  /** On-time, first-attempt, return, pickup and exception-resolution metrics: today, this month, last month and the period (from / to; default today). */
  @RequirePermissions("parcel:read:any")
  @Get("analytics")
  @ApiZodQuery(periodQuerySchema)
  analytics(@Query(new ZodPipe(periodQuerySchema)) query: PeriodQuery) {
    return this.ops.analytics(query);
  }

  /** Parcels per rider in a date range (Dhaka days), with the records for run sheets. */
  @RequirePermissions("parcel:read:any", "rider:read")
  @Get("rider-report")
  @ApiZodQuery(riderReportQueryDoc)
  riderReport(@CurrentActor() actor: Actor, @Query(new ZodPipe(riderReportQuerySchema)) query: z.infer<typeof riderReportQuerySchema>) {
    return this.ops.riderReport(actor, query);
  }

  /** Hub-to-hub transfers in a date range (default: the last 30 days). */
  @RequirePermissions("parcel:read:any")
  @Get("transfers")
  @ApiZodQuery(transfersQueryDoc)
  transfers(@CurrentActor() actor: Actor, @Query(new ZodPipe(transfersQuerySchema)) query: z.infer<typeof transfersQuerySchema>) {
    return this.ops.transfers(actor, query);
  }

  /** Merchant accounts with this month's parcel volume and COD. */
  @RequirePermissions("merchant:read:any")
  @Get("merchants")
  merchants() {
    return this.ops.merchants();
  }

  /** Book a parcel for a merchant (sender and pickup default to its profile) or a walk-in sender. */
  @RequirePermissions("parcel:dispatch")
  @Post("parcels")
  @ApiZodBody(opsBookingDocSchema)
  book(@CurrentActor() actor: Actor, @ZBody(opsBookingSchema) body: z.infer<typeof opsBookingSchema>, @ReqMeta() meta: RequestMeta) {
    return this.ops.book(actor, body, meta);
  }
}
