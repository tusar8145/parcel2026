import type { z } from "zod";
import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { FastifyReply } from "fastify";
import { CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { listRunsQuerySchema, listSchedulesQuerySchema, reportScheduleSchema, runReportSchema, updateReportScheduleSchema } from "./reports.schemas";
import { ReportsService } from "./reports.service";
import { RiderReportService, riderReportQuerySchema } from "./rider-report.service";
import { HubTransferReportService, hubTransferReportQuerySchema } from "./hub-transfer-report.service";

/** Operations reports: on-demand runs, Excel-compatible CSV downloads and emailed schedules. */
@ApiTags("reports")
@Controller("reports")
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly riderReport: RiderReportService,
    private readonly hubTransferReport: HubTransferReportService,
  ) {}

  /** Hub transfer report: per route and hub for Dhaka days — parcels sent, received, still on the way, missing, time on the road. */
  @RequirePermissions("parcel:read:any")
  @Get("hub-transfers")
  @ApiZodQuery(hubTransferReportQuerySchema)
  hubTransfers(@CurrentActor() actor: Actor, @ZQuery(hubTransferReportQuerySchema) query: z.infer<typeof hubTransferReportQuerySchema>) {
    return this.hubTransferReport.summary(actor, query);
  }

  /** The parcels behind the hub transfer report (one route with fromHubId / toHubId), for the list and the CSV. */
  @RequirePermissions("parcel:read:any")
  @Get("hub-transfers/parcels")
  @ApiZodQuery(hubTransferReportQuerySchema)
  hubTransferParcels(@CurrentActor() actor: Actor, @ZQuery(hubTransferReportQuerySchema) query: z.infer<typeof hubTransferReportQuerySchema>) {
    return this.hubTransferReport.parcels(actor, query);
  }

  /** Rider report: per rider for Dhaka days — pickups, deliveries, failed, COD collected, cash handed in, held now, position. */
  @RequirePermissions("parcel:read:any")
  @Get("riders")
  @ApiZodQuery(riderReportQuerySchema)
  riders(@CurrentActor() actor: Actor, @ZQuery(riderReportQuerySchema) query: z.infer<typeof riderReportQuerySchema>) {
    return this.riderReport.summary(actor, query);
  }

  /** The parcels behind the rider report (one rider with riderId), for the list and the CSV. */
  @RequirePermissions("parcel:read:any")
  @Get("riders/parcels")
  @ApiZodQuery(riderReportQuerySchema)
  riderParcels(@CurrentActor() actor: Actor, @ZQuery(riderReportQuerySchema) query: z.infer<typeof riderReportQuerySchema>) {
    return this.riderReport.parcels(actor, query);
  }

  @RequirePermissions("parcel:read:any")
  @Get("schedules")
  @ApiZodQuery(listSchedulesQuerySchema)
  schedules(@CurrentActor() actor: Actor, @ZQuery(listSchedulesQuerySchema) query: z.infer<typeof listSchedulesQuerySchema>) {
    return this.reports.listSchedules(actor, query);
  }

  @RequirePermissions("hub:manage")
  @Post("schedules")
  @ApiZodBody(reportScheduleSchema)
  create(@CurrentActor() actor: Actor, @ZBody(reportScheduleSchema) body: z.infer<typeof reportScheduleSchema>, @ReqMeta() meta: RequestMeta) {
    return this.reports.createSchedule(actor, body, meta);
  }

  @RequirePermissions("hub:manage")
  @Patch("schedules/:id")
  @ApiZodBody(updateReportScheduleSchema)
  update(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(updateReportScheduleSchema) body: z.infer<typeof updateReportScheduleSchema>, @ReqMeta() meta: RequestMeta) {
    return this.reports.updateSchedule(actor, id, body, meta);
  }

  @RequirePermissions("hub:manage")
  @Delete("schedules/:id")
  remove(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.reports.deleteSchedule(actor, id, meta);
  }

  /** Sends a scheduled report now for its last complete period. */
  @RequirePermissions("hub:manage")
  @Post("schedules/:id/run")
  @HttpCode(200)
  runSchedule(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.reports.runScheduleNow(actor, id, meta);
  }

  /** Builds a report now: returns the table and keeps a run for CSV download. */
  @RequirePermissions("parcel:read:any")
  @Post("run")
  @HttpCode(200)
  @ApiZodBody(runReportSchema)
  run(@CurrentActor() actor: Actor, @ZBody(runReportSchema) body: z.infer<typeof runReportSchema>, @ReqMeta() meta: RequestMeta) {
    return this.reports.run(actor, body, meta);
  }

  @RequirePermissions("parcel:read:any")
  @Get("runs")
  @ApiZodQuery(listRunsQuerySchema)
  runs(@CurrentActor() actor: Actor, @ZQuery(listRunsQuerySchema) query: z.infer<typeof listRunsQuerySchema>) {
    return this.reports.listRuns(actor, query);
  }

  @RequirePermissions("parcel:read:any")
  @Get("runs/:id")
  getRun(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string) {
    return this.reports.getRun(actor, id);
  }

  /** The run as an Excel-compatible CSV file (UTF-8 with BOM). */
  @RequirePermissions("parcel:read:any")
  @Get("runs/:id/download")
  async download(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const run = await this.reports.getRun(actor, id);
    const day = new Date(run.periodStart.getTime() + 6 * 3600_000).toISOString().slice(0, 10);
    reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="delivery-fast-${run.kind.toLowerCase()}-${day}.csv"`)
      .header("cache-control", "private, no-store");
    return run.csv;
  }
}
