import type { z } from "zod";
import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZodPipe, ZQuery } from "../../common/zod";
import {
  attendanceReportQueryDoc,
  attendanceReportQuerySchema,
  checkInSchema,
  checkOutSchema,
  correctAttendanceSchema,
  listAttendanceQuerySchema,
  listSchedulesQuerySchema,
  scheduleSchema,
  updateScheduleSchema,
} from "./shifts.schemas";
import { ShiftsService } from "./shifts.service";

/** Rider shift schedules, attendance and reports (operations). */
@ApiTags("shifts")
@Controller("shifts")
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @RequirePermissions("rider:read")
  @Get("schedules")
  @ApiZodQuery(listSchedulesQuerySchema)
  schedules(@CurrentActor() actor: Actor, @ZQuery(listSchedulesQuerySchema) query: z.infer<typeof listSchedulesQuerySchema>) {
    return this.shifts.listSchedules(actor, query);
  }

  @RequirePermissions("rider:manage")
  @Post("schedules")
  @ApiZodBody(scheduleSchema)
  create(@CurrentActor() actor: Actor, @ZBody(scheduleSchema) body: z.infer<typeof scheduleSchema>, @ReqMeta() meta: RequestMeta) {
    return this.shifts.createSchedule(actor, body, meta);
  }

  @RequirePermissions("rider:manage")
  @Patch("schedules/:id")
  @ApiZodBody(updateScheduleSchema)
  update(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(updateScheduleSchema) body: z.infer<typeof updateScheduleSchema>, @ReqMeta() meta: RequestMeta) {
    return this.shifts.updateSchedule(actor, id, body, meta);
  }

  @RequirePermissions("rider:manage")
  @Delete("schedules/:id")
  remove(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.shifts.deleteSchedule(actor, id, meta);
  }

  /** Today's roster: scheduled, on shift, late, absent. */
  @RequirePermissions("rider:read")
  @Get("today")
  today(@CurrentActor() actor: Actor, @Query("hubId", new ParseUUIDPipe({ optional: true })) hubId?: string) {
    return this.shifts.today(actor, hubId);
  }

  @RequirePermissions("rider:read")
  @Get("attendance")
  @ApiZodQuery(listAttendanceQuerySchema)
  attendance(@CurrentActor() actor: Actor, @ZQuery(listAttendanceQuerySchema) query: z.infer<typeof listAttendanceQuerySchema>) {
    return this.shifts.listAttendance(actor, query);
  }

  /** Corrects a check-in / check-out (recorded as an operations correction with a reason). */
  @RequirePermissions("rider:manage")
  @Patch("attendance/:id")
  @ApiZodBody(correctAttendanceSchema)
  correct(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(correctAttendanceSchema) body: z.infer<typeof correctAttendanceSchema>, @ReqMeta() meta: RequestMeta) {
    return this.shifts.correct(actor, id, body, meta);
  }

  @RequirePermissions("rider:read")
  @Get("report")
  @ApiZodQuery(attendanceReportQueryDoc)
  report(@CurrentActor() actor: Actor, @Query(new ZodPipe(attendanceReportQuerySchema)) query: z.infer<typeof attendanceReportQuerySchema>) {
    return this.shifts.report(actor, query);
  }
}

/** The rider app's shift: today's schedule, check-in and check-out. */
@ApiTags("rider")
@Controller("rider/shift")
export class RiderShiftController {
  constructor(private readonly shifts: ShiftsService) {}

  @RequirePermissions("parcel:rider-update")
  @Get()
  mine(@CurrentUser() actor: UserActor) {
    return this.shifts.myShift(actor);
  }

  /** Starts the shift (the rider goes online). Optional position of the check-in. */
  @RequirePermissions("parcel:rider-update")
  @Post("check-in")
  @HttpCode(200)
  @ApiZodBody(checkInSchema)
  checkIn(@CurrentUser() actor: UserActor, @ZBody(checkInSchema) body: z.infer<typeof checkInSchema>, @ReqMeta() meta: RequestMeta) {
    return this.shifts.checkIn(actor, body, meta);
  }

  /** Ends the shift (the rider goes offline). */
  @RequirePermissions("parcel:rider-update")
  @Post("check-out")
  @HttpCode(200)
  @ApiZodBody(checkOutSchema)
  checkOut(@CurrentUser() actor: UserActor, @ZBody(checkOutSchema) body: z.infer<typeof checkOutSchema>, @ReqMeta() meta: RequestMeta) {
    return this.shifts.checkOut(actor, body, meta);
  }
}
