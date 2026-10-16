import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { RealtimeService } from "../../common/realtime.service";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, forbidden, notFound } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import type { Prisma, RiderAttendance, RiderShiftSchedule } from "../../generated/prisma/client";
import { opsHubScope } from "../parcels/ops-scope";
import { dhakaDay } from "../ops/ops-common";
import type {
  attendanceReportQuerySchema,
  checkInSchema,
  checkOutSchema,
  correctAttendanceSchema,
  listAttendanceQuerySchema,
  listSchedulesQuerySchema,
  scheduleSchema,
  updateScheduleSchema,
} from "./shifts.schemas";

/** A check-in this long after the shift start counts as late. */
export const LATE_AFTER_MINUTES = 15;
const DAY_MS = 86_400_000;

/** "2026-10-16" → the @db.Date value Prisma stores for it. */
const dateOnly = (day: string) => new Date(`${day}T00:00:00Z`);
const weekdayOf = (day: string) => dateOnly(day).getUTCDay();
/** The shift's start and end instants on a Dhaka day (an end before the start is the next morning). */
function shiftWindow(s: Pick<RiderShiftSchedule, "startTime" | "endTime">, day: string) {
  const start = new Date(`${day}T${s.startTime}:00+06:00`);
  let end = new Date(`${day}T${s.endTime}:00+06:00`);
  if (end <= start) end = new Date(end.getTime() + DAY_MS);
  return { start, end };
}
const appliesOn = (s: RiderShiftSchedule, day: string) =>
  s.active && s.weekdays.includes(weekdayOf(day)) && dateOnly(day) >= s.validFrom && (!s.validTo || dateOnly(day) <= s.validTo);
const minutesBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 60_000);

const riderSelect = { id: true, code: true, hubId: true, status: true, active: true, user: { select: { name: true } }, hub: { select: { id: true, name: true } } } satisfies Prisma.RiderSelect;

/**
 * Rider shifts and attendance: recurring shift schedules, check-in / check-out from the rider
 * app (GET /rider/shift, POST /rider/shift/check-in | check-out), corrections by operations and
 * attendance reports (present, late, absent, hours).
 */
@Injectable()
export class ShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  // ───────────── schedules ─────────────

  async listSchedules(actor: Actor, query: z.infer<typeof listSchedulesQuerySchema>) {
    const scope = opsHubScope(actor);
    const rows = await this.prisma.riderShiftSchedule.findMany({
      where: {
        riderId: query.riderId,
        active: query.active,
        ...(query.hubId ? { OR: [{ hubId: query.hubId }, { rider: { hubId: query.hubId } }] } : {}),
        ...(scope ? { rider: { hubId: { in: scope } } } : {}),
      },
      include: { rider: { select: riderSelect } },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { items: page.items.map(({ rider, ...s }) => ({ ...s, rider: { id: rider.id, code: rider.code, label: `${rider.code} · ${rider.user.name}`, hub: rider.hub } })), nextCursor: page.nextCursor };
  }

  async createSchedule(actor: Actor, input: z.infer<typeof scheduleSchema>, meta: RequestMeta) {
    const rider = await this.rider(input.riderId);
    if (input.hubId && !(await this.prisma.hub.findUnique({ where: { id: input.hubId }, select: { id: true } }))) throw notFound("Hub");
    const schedule = await this.prisma.$transaction(async tx => {
      await this.assertNoOverlap(tx, input.riderId, input.weekdays, input.validFrom, input.validTo ?? null);
      const created = await tx.riderShiftSchedule.create({
        data: {
          riderId: input.riderId,
          hubId: input.hubId ?? rider.hubId,
          weekdays: input.weekdays,
          startTime: input.startTime,
          endTime: input.endTime,
          validFrom: dateOnly(input.validFrom),
          validTo: input.validTo ? dateOnly(input.validTo) : null,
          note: input.note,
          createdById: actor.kind === "user" ? actor.userId : null,
        },
      });
      await this.audit.record(actor, { action: "shift.schedule_create", entityType: "rider_shift_schedule", entityId: created.id, data: { rider: rider.code, ...input } }, meta, tx);
      return created;
    });
    this.publish(rider);
    return schedule;
  }

  async updateSchedule(actor: Actor, id: string, input: z.infer<typeof updateScheduleSchema>, meta: RequestMeta) {
    const current = await this.prisma.riderShiftSchedule.findUnique({ where: { id } });
    if (!current) throw notFound("Shift schedule");
    const rider = await this.rider(current.riderId);
    if (input.hubId && !(await this.prisma.hub.findUnique({ where: { id: input.hubId }, select: { id: true } }))) throw notFound("Hub");
    const start = input.startTime ?? current.startTime;
    const end = input.endTime ?? current.endTime;
    if (start === end) throw new AppError("INVALID_SHIFT", "The shift must end at a different time", 422);
    const validTo = input.validTo === undefined ? current.validTo : input.validTo ? dateOnly(input.validTo) : null;
    if (validTo && validTo < current.validFrom) throw new AppError("INVALID_SHIFT", "The schedule would end before it starts", 422);
    const updated = await this.prisma.$transaction(async tx => {
      if ((input.active ?? current.active) && (input.weekdays || input.validTo !== undefined || input.active))
        await this.assertNoOverlap(tx, current.riderId, input.weekdays ?? current.weekdays, current.validFrom.toISOString().slice(0, 10), validTo?.toISOString().slice(0, 10) ?? null, id);
      const row = await tx.riderShiftSchedule.update({
        where: { id },
        data: { hubId: input.hubId, weekdays: input.weekdays, startTime: input.startTime, endTime: input.endTime, validTo, active: input.active, note: input.note },
      });
      await this.audit.record(actor, { action: "shift.schedule_update", entityType: "rider_shift_schedule", entityId: id, data: { rider: rider.code, ...input } }, meta, tx);
      return row;
    });
    this.publish(rider);
    return updated;
  }

  async deleteSchedule(actor: Actor, id: string, meta: RequestMeta) {
    const current = await this.prisma.riderShiftSchedule.findUnique({ where: { id } });
    if (!current) throw notFound("Shift schedule");
    const rider = await this.rider(current.riderId);
    await this.prisma.$transaction(async tx => {
      // Attendance keeps its history; it just no longer points at the schedule.
      await tx.riderShiftSchedule.delete({ where: { id } });
      await this.audit.record(actor, { action: "shift.schedule_delete", entityType: "rider_shift_schedule", entityId: id, data: { rider: rider.code } }, meta, tx);
    });
    this.publish(rider);
    return { deleted: true };
  }

  private async assertNoOverlap(db: Db, riderId: string, weekdays: number[], from: string, to: string | null, exceptId?: string) {
    const others = await db.riderShiftSchedule.findMany({ where: { riderId, active: true, ...(exceptId ? { id: { not: exceptId } } : {}) } });
    const clash = others.find(o => o.weekdays.some(d => weekdays.includes(d)) && (!o.validTo || o.validTo >= dateOnly(from)) && (!to || o.validFrom <= dateOnly(to)));
    if (clash)
      throw new AppError("SHIFT_OVERLAP", `The rider already has a ${clash.startTime}–${clash.endTime} shift on some of these days. End or edit it first.`, HttpStatus.CONFLICT, { scheduleId: clash.id });
  }

  // ───────────── rider app ─────────────

  /** Today's shift, the open check-in and the last seven days. */
  async myShift(actor: UserActor) {
    const rider = await this.myRider(actor);
    const today = dhakaDay();
    const [schedules, open, recent] = await Promise.all([
      this.prisma.riderShiftSchedule.findMany({ where: { riderId: rider.id, active: true } }),
      this.prisma.riderAttendance.findFirst({ where: { riderId: rider.id, checkOutAt: null }, orderBy: { checkInAt: "desc" }, include: { schedule: true } }),
      this.prisma.riderAttendance.findMany({ where: { riderId: rider.id, workDate: { gte: dateOnly(dhakaDay(new Date(Date.now() - 6 * DAY_MS))) } }, orderBy: { checkInAt: "desc" }, take: 30, include: { schedule: true } }),
    ]);
    const schedule = schedules.find(s => appliesOn(s, today)) ?? null;
    const window = schedule ? shiftWindow(schedule, today) : null;
    return {
      rider: { id: rider.id, code: rider.code, status: rider.status },
      today,
      schedule: schedule && window ? { id: schedule.id, startTime: schedule.startTime, endTime: schedule.endTime, startsAt: window.start, endsAt: window.end, hubId: schedule.hubId } : null,
      checkedIn: !!open,
      current: open ? this.attendanceView(open) : null,
      recent: recent.map(a => this.attendanceView(a)),
      upcoming: schedules.map(s => ({ id: s.id, weekdays: s.weekdays, startTime: s.startTime, endTime: s.endTime, validFrom: s.validFrom, validTo: s.validTo })),
    };
  }

  async checkIn(actor: UserActor, input: z.infer<typeof checkInSchema>, meta: RequestMeta) {
    const rider = await this.myRider(actor);
    const now = new Date();
    const today = dhakaDay(now);
    const attendance = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shift:${rider.id}`}))`;
      const open = await tx.riderAttendance.findFirst({ where: { riderId: rider.id, checkOutAt: null } });
      if (open) throw new AppError("ALREADY_CHECKED_IN", `You checked in at ${open.checkInAt.toLocaleTimeString("en-GB", { timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit" })}. Check out first.`, HttpStatus.CONFLICT);
      const schedules = await tx.riderShiftSchedule.findMany({ where: { riderId: rider.id, active: true } });
      const schedule = schedules.find(s => appliesOn(s, today));
      const created = await tx.riderAttendance.create({
        data: { riderId: rider.id, scheduleId: schedule?.id, hubId: schedule?.hubId ?? rider.hubId, workDate: dateOnly(today), checkInAt: now, checkInLat: input.lat, checkInLng: input.lng, note: input.note },
        include: { schedule: true },
      });
      await tx.rider.update({ where: { id: rider.id }, data: { status: "ONLINE" } });
      await this.audit.record(actor, { action: "shift.check_in", entityType: "rider", entityId: rider.id, data: { attendanceId: created.id, scheduled: !!schedule } }, meta, tx);
      return created;
    });
    this.publish(rider);
    return this.attendanceView(attendance);
  }

  async checkOut(actor: UserActor, input: z.infer<typeof checkOutSchema>, meta: RequestMeta) {
    const rider = await this.myRider(actor);
    const attendance = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shift:${rider.id}`}))`;
      const open = await tx.riderAttendance.findFirst({ where: { riderId: rider.id, checkOutAt: null }, orderBy: { checkInAt: "desc" } });
      if (!open) throw new AppError("NOT_CHECKED_IN", "You aren't checked in", HttpStatus.CONFLICT);
      const updated = await tx.riderAttendance.update({
        where: { id: open.id },
        data: { checkOutAt: new Date(), checkOutLat: input.lat, checkOutLng: input.lng, note: input.note ? [open.note, input.note].filter(Boolean).join(" · ") : undefined },
        include: { schedule: true },
      });
      await tx.rider.update({ where: { id: rider.id }, data: { status: "OFFLINE" } });
      await this.audit.record(actor, { action: "shift.check_out", entityType: "rider", entityId: rider.id, data: { attendanceId: open.id } }, meta, tx);
      return updated;
    });
    this.publish(rider);
    return this.attendanceView(attendance);
  }

  // ───────────── attendance (operations) ─────────────

  async listAttendance(actor: Actor, query: z.infer<typeof listAttendanceQuerySchema>) {
    const scope = opsHubScope(actor);
    if (scope && query.hubId && !scope.includes(query.hubId)) throw forbidden("You can only see your own hub's riders");
    const where: Prisma.RiderAttendanceWhereInput = {
      riderId: query.riderId,
      ...(query.hubId ? { rider: { hubId: query.hubId } } : scope ? { rider: { hubId: { in: scope } } } : {}),
      ...(query.from || query.to ? { workDate: { gte: query.from ? dateOnly(query.from) : undefined, lte: query.to ? dateOnly(query.to) : undefined } } : {}),
    };
    const rows = await this.prisma.riderAttendance.findMany({ where, include: { rider: { select: riderSelect }, schedule: true }, ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    return {
      items: page.items.map(a => ({ ...this.attendanceView(a), rider: { id: a.rider.id, code: a.rider.code, label: `${a.rider.code} · ${a.rider.user.name}`, hub: a.rider.hub } })),
      nextCursor: page.nextCursor,
    };
  }

  async correct(actor: Actor, id: string, input: z.infer<typeof correctAttendanceSchema>, meta: RequestMeta) {
    const current = await this.prisma.riderAttendance.findUnique({ where: { id }, include: { rider: { select: riderSelect } } });
    if (!current) throw notFound("Attendance record");
    const checkInAt = input.checkInAt ?? current.checkInAt;
    const checkOutAt = input.checkOutAt === undefined ? current.checkOutAt : input.checkOutAt;
    if (checkOutAt && checkOutAt <= checkInAt) throw new AppError("INVALID_TIMES", "Check-out must be after check-in", 422);
    if (checkInAt > new Date() || (checkOutAt && checkOutAt > new Date())) throw new AppError("INVALID_TIMES", "Times can't be in the future", 422);
    const updated = await this.prisma.$transaction(async tx => {
      const row = await tx.riderAttendance.update({
        where: { id },
        data: { checkInAt, checkOutAt, workDate: dateOnly(dhakaDay(checkInAt)), source: "OPERATIONS", note: [current.note, `Corrected by ${actor.name}: ${input.note}`].filter(Boolean).join(" · ").slice(0, 1000) },
        include: { schedule: true },
      });
      await this.audit.record(
        actor,
        { action: "shift.attendance_correct", entityType: "rider_attendance", entityId: id, data: { rider: current.rider.code, from: { checkInAt: current.checkInAt, checkOutAt: current.checkOutAt }, to: { checkInAt, checkOutAt }, note: input.note } },
        meta,
        tx,
      );
      return row;
    });
    this.publish(current.rider);
    return this.attendanceView(updated);
  }

  /** Who is scheduled today and who has checked in (hub operators: their hubs). */
  async today(actor: Actor, hubId?: string) {
    const scope = opsHubScope(actor);
    if (scope && hubId && !scope.includes(hubId)) throw forbidden("You can only see your own hub's riders");
    const day = dhakaDay();
    const hubs = hubId ? [hubId] : scope;
    const riders = await this.prisma.rider.findMany({
      where: { active: true, ...(hubs ? { hubId: { in: hubs } } : {}) },
      select: { ...riderSelect, shiftSchedules: { where: { active: true } }, attendance: { where: { workDate: dateOnly(day) }, orderBy: { checkInAt: "asc" } } },
      orderBy: { code: "asc" },
      take: 1000,
    });
    const now = new Date();
    return riders.map(r => {
      const schedule = r.shiftSchedules.find(s => appliesOn(s, day)) ?? null;
      const window = schedule ? shiftWindow(schedule, day) : null;
      const first = r.attendance[0];
      const open = r.attendance.find(a => !a.checkOutAt);
      const lateBy = window && first ? minutesBetween(window.start, first.checkInAt) : null;
      const state = open
        ? "On shift"
        : first
          ? "Checked out"
          : window && now.getTime() > window.start.getTime() + LATE_AFTER_MINUTES * 60_000
            ? now > window.end
              ? "Absent"
              : "Late"
            : window
              ? "Scheduled"
              : "Off";
      return {
        rider: { id: r.id, code: r.code, label: `${r.code} · ${r.user.name}`, status: r.status, hub: r.hub },
        schedule: schedule && window ? { startTime: schedule.startTime, endTime: schedule.endTime, startsAt: window.start, endsAt: window.end } : null,
        checkInAt: first?.checkInAt ?? null,
        checkOutAt: open ? null : (r.attendance.at(-1)?.checkOutAt ?? null),
        late: lateBy != null && lateBy > LATE_AFTER_MINUTES ? lateBy : 0,
        state,
      };
    });
  }

  /** Per rider in a Dhaka date range: scheduled shifts, present, late, absent and hours worked. */
  async report(actor: Actor, query: z.infer<typeof attendanceReportQuerySchema>) {
    const scope = opsHubScope(actor);
    if (scope && query.hubId && !scope.includes(query.hubId)) throw forbidden("You can only see your own hub's riders");
    const hubs = query.hubId ? [query.hubId] : scope;
    const riders = await this.prisma.rider.findMany({
      where: { ...(query.riderId ? { id: query.riderId } : { active: true }), ...(hubs ? { hubId: { in: hubs } } : {}) },
      select: {
        ...riderSelect,
        shiftSchedules: true,
        attendance: { where: { workDate: { gte: dateOnly(query.from), lte: dateOnly(query.to) } }, orderBy: { checkInAt: "asc" } },
      },
      orderBy: { code: "asc" },
      take: 2000,
    });
    const days: string[] = [];
    for (let t = Date.parse(`${query.from}T00:00:00Z`); t <= Date.parse(`${query.to}T00:00:00Z`); t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
    const now = new Date();
    const rows = riders.map(r => {
      let scheduled = 0;
      let present = 0;
      let late = 0;
      let absent = 0;
      let lateMinutes = 0;
      for (const day of days) {
        const schedule = r.shiftSchedules.find(s => appliesOn(s, day));
        const first = r.attendance.find(a => a.workDate.toISOString().slice(0, 10) === day);
        if (!schedule) {
          if (first) present++;
          continue;
        }
        const window = shiftWindow(schedule, day);
        if (window.start > now) continue; // not started yet
        scheduled++;
        if (!first) {
          if (window.end < now) absent++;
          continue;
        }
        present++;
        const by = minutesBetween(window.start, first.checkInAt);
        if (by > LATE_AFTER_MINUTES) {
          late++;
          lateMinutes += by;
        }
      }
      const minutes = r.attendance.reduce((n, a) => n + minutesBetween(a.checkInAt, a.checkOutAt ?? now), 0);
      return {
        rider: { id: r.id, code: r.code, label: `${r.code} · ${r.user.name}`, hub: r.hub },
        scheduled,
        present,
        late,
        absent,
        attendanceRate: scheduled ? Math.round(((scheduled - absent) / scheduled) * 1000) / 10 : null,
        avgLateMinutes: late ? Math.round(lateMinutes / late) : 0,
        hoursWorked: Math.round((minutes / 60) * 10) / 10,
        openCheckIn: r.attendance.some(a => !a.checkOutAt),
      };
    });
    return { from: query.from, to: query.to, lateAfterMinutes: LATE_AFTER_MINUTES, riders: rows };
  }

  // ───────────── helpers ─────────────

  private attendanceView(a: RiderAttendance & { schedule?: RiderShiftSchedule | null }) {
    const day = a.workDate.toISOString().slice(0, 10);
    const window = a.schedule ? shiftWindow(a.schedule, day) : null;
    const lateBy = window ? minutesBetween(window.start, a.checkInAt) : null;
    return {
      id: a.id,
      workDate: day,
      checkInAt: a.checkInAt,
      checkOutAt: a.checkOutAt,
      minutes: a.checkOutAt ? minutesBetween(a.checkInAt, a.checkOutAt) : null,
      late: lateBy != null && lateBy > LATE_AFTER_MINUTES ? lateBy : 0,
      scheduleId: a.scheduleId,
      shift: a.schedule ? `${a.schedule.startTime}–${a.schedule.endTime}` : null,
      source: a.source,
      note: a.note,
      checkIn: a.checkInLat != null ? { lat: a.checkInLat, lng: a.checkInLng } : null,
      checkOut: a.checkOutLat != null ? { lat: a.checkOutLat, lng: a.checkOutLng } : null,
    };
  }

  private async rider(id: string) {
    const rider = await this.prisma.rider.findUnique({ where: { id }, select: riderSelect });
    if (!rider) throw notFound("Rider");
    return rider;
  }

  private async myRider(actor: UserActor) {
    if (!actor.riderId) throw forbidden("Only riders have shifts");
    const rider = await this.rider(actor.riderId);
    if (!rider.active) throw forbidden("Your rider account isn't active");
    return rider;
  }

  private publish(rider: { id: string; code: string; hubId: string | null }) {
    this.realtime.publish({ type: "rider.shift", id: rider.code, riderIds: [rider.id], hubIds: [rider.hubId], staffPermission: "rider:read" });
  }
}
