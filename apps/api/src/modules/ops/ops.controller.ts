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

/** Courier Operations console: network counters, dispatch, analytics, reports and bookings by staff. */
@ApiTags("operations")
@Controller("ops")
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  /** Live counters for the command center, nav badges and priority alerts, plus what the caller may do. */
  @RequirePermissions("parcel:read:any")
  @Get("overview")
  overview(@CurrentActor() actor: Actor) {
    return this.ops.overview(actor);
  }

  /** Assignment queue size and each rider's workload today (hub operators: their hub). */
  @RequirePermissions("parcel:read:any", "rider:read")
  @Get("dispatch")
  dispatch(@CurrentActor() actor: Actor) {
    return this.ops.dispatch(actor);
  }

  /** On-time, first-attempt, return, pickup and exception-resolution metrics: today, this month, last month. */
  @RequirePermissions("parcel:read:any")
  @Get("analytics")
  analytics() {
    return this.ops.analytics();
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
