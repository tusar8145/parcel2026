import type { z } from "zod";
import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { FastifyReply } from "fastify";
import { CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { listRunsQuerySchema, listSchedulesQuerySchema, reportScheduleSchema, runReportSchema, updateReportScheduleSchema } from "./reports.schemas";
import { ReportsService } from "./reports.service";

/** Operations reports: on-demand runs, Excel-compatible CSV downloads and emailed schedules. */
@ApiTags("reports")
@Controller("reports")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

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
