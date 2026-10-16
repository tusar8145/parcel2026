import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { QueueService } from "../../common/queues";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, forbidden, notFound } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import { env, runsJobs } from "../../config/env";
import { Prisma, type ReportKind, type ReportSchedule } from "../../generated/prisma/client";
import { NotifyService } from "../notifications/notify.service";
import { OutboxService } from "../notifications/outbox.service";
import { dhakaDateRange, opsHubScope } from "../parcels/ops-scope";
import { dhakaDay, toCsv } from "../ops/ops-common";
import type { listRunsQuerySchema, listSchedulesQuerySchema, reportScheduleSchema, runReportSchema, updateReportScheduleSchema } from "./reports.schemas";

const DAY_MS = 86_400_000;
const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`;
const pct = (num: number, den: number) => (den ? Math.round((num / den) * 1000) / 10 : null);
const money = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100;
const TITLE: Record<ReportKind, string> = { DELIVERIES: "Delivery summary", SLA: "SLA attainment by zone", COD: "COD by rider", RIDERS: "Rider performance" };

export interface ReportTable {
  kind: ReportKind;
  title: string;
  from: string;
  to: string;
  hub: { id: string; name: string } | null;
  header: string[];
  rows: (string | number | null)[][];
}

/** The next time a schedule is due (Dhaka time), strictly after `after`. */
export function nextRunAt(s: Pick<ReportSchedule, "frequency" | "weekday" | "hour">, after = new Date()): Date {
  const local = new Date(after.getTime() + 6 * 3600_000);
  const base = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), s.hour) - 6 * 3600_000;
  for (let i = 0; i <= 8; i++) {
    const candidate = new Date(base + i * DAY_MS);
    if (candidate <= after) continue;
    if (s.frequency === "WEEKLY" && new Date(candidate.getTime() + 6 * 3600_000).getUTCDay() !== s.weekday) continue;
    return candidate;
  }
  return new Date(base + 7 * DAY_MS);
}

/**
 * Operations reports (deliveries, SLA, COD, riders) as tables and Excel-compatible CSV, run on
 * demand or on daily / weekly schedules that email recipients a link (ops.scheduled_report).
 */
@Injectable()
export class ReportsService implements OnApplicationBootstrap {
  private readonly logger = new Logger("Reports");

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queues: QueueService,
    private readonly notify: NotifyService,
    private readonly outbox: OutboxService,
  ) {}

  onApplicationBootstrap() {
    if (!runsJobs()) return;
    void this.queues
      .schedule("scheduled-reports", "2 * * * *", async () => {
        const sent = await this.runDue();
        if (sent) this.logger.log(`Sent ${sent} scheduled report(s)`);
      })
      .catch(err => this.logger.error({ err }, "Could not schedule the report job"));
  }

  // ───────────── schedules ─────────────

  async listSchedules(actor: Actor, query: z.infer<typeof listSchedulesQuerySchema>) {
    const scope = opsHubScope(actor);
    const rows = await this.prisma.reportSchedule.findMany({ where: { active: query.active, ...(scope ? { hubId: { in: scope } } : {}) }, ...pageArgs(query) });
    return toPage(rows, query.limit);
  }

  async createSchedule(actor: Actor, input: z.infer<typeof reportScheduleSchema>, meta: RequestMeta) {
    if (input.hubId && !(await this.prisma.hub.findUnique({ where: { id: input.hubId }, select: { id: true } }))) throw notFound("Hub");
    const data = { ...input, weekday: input.frequency === "WEEKLY" ? (input.weekday ?? null) : null };
    return this.prisma.$transaction(async tx => {
      const schedule = await tx.reportSchedule.create({ data: { ...data, nextRunAt: nextRunAt(data), createdById: actor.kind === "user" ? actor.userId : null } });
      await this.audit.record(actor, { action: "report.schedule_create", entityType: "report_schedule", entityId: schedule.id, data }, meta, tx);
      return schedule;
    });
  }

  async updateSchedule(actor: Actor, id: string, input: z.infer<typeof updateReportScheduleSchema>, meta: RequestMeta) {
    const current = await this.prisma.reportSchedule.findUnique({ where: { id } });
    if (!current) throw notFound("Report schedule");
    if (input.hubId && !(await this.prisma.hub.findUnique({ where: { id: input.hubId }, select: { id: true } }))) throw notFound("Hub");
    const frequency = input.frequency ?? current.frequency;
    const weekday = frequency === "DAILY" ? null : input.weekday === undefined ? current.weekday : input.weekday;
    if (frequency === "WEEKLY" && weekday == null) throw new AppError("WEEKDAY_REQUIRED", "Choose the day of the week", 422);
    const hour = input.hour ?? current.hour;
    return this.prisma.$transaction(async tx => {
      const schedule = await tx.reportSchedule.update({ where: { id }, data: { ...input, weekday, nextRunAt: nextRunAt({ frequency, weekday, hour }) } });
      await this.audit.record(actor, { action: "report.schedule_update", entityType: "report_schedule", entityId: id, data: input }, meta, tx);
      return schedule;
    });
  }

  async deleteSchedule(actor: Actor, id: string, meta: RequestMeta) {
    const current = await this.prisma.reportSchedule.findUnique({ where: { id } });
    if (!current) throw notFound("Report schedule");
    await this.prisma.$transaction(async tx => {
      await tx.reportSchedule.delete({ where: { id } });
      await this.audit.record(actor, { action: "report.schedule_delete", entityType: "report_schedule", entityId: id, data: { name: current.name } }, meta, tx);
    });
    return { deleted: true };
  }

  /** Sends every schedule that is due. Returns how many reports were sent. */
  async runDue(now = new Date()) {
    const due = await this.prisma.reportSchedule.findMany({ where: { active: true, nextRunAt: { lte: now } }, take: 50 });
    let sent = 0;
    for (const schedule of due) {
      // Claim it first so a second worker doesn't send it again.
      const { count } = await this.prisma.reportSchedule.updateMany({ where: { id: schedule.id, nextRunAt: schedule.nextRunAt }, data: { lastRunAt: now, nextRunAt: nextRunAt(schedule, now) } });
      if (!count) continue;
      try {
        await this.send(schedule, now);
        sent++;
      } catch (err) {
        this.logger.error({ err, scheduleId: schedule.id }, "Scheduled report failed");
      }
    }
    return sent;
  }

  /** Runs a schedule now (for its last complete period) and emails it. */
  async runScheduleNow(actor: Actor, id: string, meta: RequestMeta) {
    const schedule = await this.prisma.reportSchedule.findUnique({ where: { id } });
    if (!schedule) throw notFound("Report schedule");
    const run = await this.send(schedule, new Date());
    await this.audit.record(actor, { action: "report.schedule_run", entityType: "report_schedule", entityId: id, data: { runId: run.id } }, meta);
    return this.runView(run);
  }

  private async send(schedule: ReportSchedule, now: Date) {
    const to = dhakaDay(new Date(now.getTime() - DAY_MS));
    const from = schedule.frequency === "WEEKLY" ? dhakaDay(new Date(now.getTime() - 7 * DAY_MS)) : to;
    let table: ReportTable | null = null;
    let error: string | null = null;
    try {
      table = await this.build(schedule.kind, from, to, schedule.hubId);
    } catch (err) {
      error = err instanceof Error ? err.message.slice(0, 500) : "Report failed";
    }
    const [start, end] = dhakaDateRange(from, to);
    const run = await this.prisma.reportRun.create({
      data: {
        scheduleId: schedule.id,
        kind: schedule.kind,
        periodStart: start,
        periodEnd: end,
        hubId: schedule.hubId,
        rowCount: table?.rows.length ?? 0,
        csv: table ? toCsv(table.header, table.rows) : "",
        status: table ? "OK" : "FAILED",
        error,
      },
    });
    if (!table) return run;
    const link = `${env().APP_URL.replace(/\/$/, "")}/courier-operation?report=${run.id}`;
    const period = from === to ? from : `${from} to ${to}`;
    const ids: string[] = [];
    await this.prisma.$transaction(async tx => {
      for (const email of schedule.recipients)
        ids.push(...(await this.notify.notify(tx, { event: "ops.scheduled_report", to: { email }, vars: { report: `${schedule.name} (${TITLE[schedule.kind]})`, period, link }, channels: ["email"] })));
    });
    await this.outbox.flush(ids);
    return run;
  }

  // ───────────── runs ─────────────

  /** Builds a report now and keeps it as a run (download it as CSV, print it as PDF in the browser). */
  async run(actor: Actor, input: z.infer<typeof runReportSchema>, meta: RequestMeta) {
    const hubId = this.hubFor(actor, input.hubId);
    const table = await this.build(input.kind, input.from, input.to, hubId);
    const [start, end] = dhakaDateRange(input.from, input.to);
    const run = await this.prisma.$transaction(async tx => {
      const created = await tx.reportRun.create({
        data: { kind: input.kind, periodStart: start, periodEnd: end, hubId, rowCount: table.rows.length, csv: toCsv(table.header, table.rows), createdById: actor.kind === "user" ? actor.userId : null },
      });
      await this.audit.record(actor, { action: "report.run", entityType: "report_run", entityId: created.id, data: { kind: input.kind, from: input.from, to: input.to, hubId } }, meta, tx);
      return created;
    });
    return { run: this.runView(run), table };
  }

  async listRuns(actor: Actor, query: z.infer<typeof listRunsQuerySchema>) {
    const scope = opsHubScope(actor);
    const rows = await this.prisma.reportRun.findMany({
      where: { kind: query.kind, scheduleId: query.scheduleId, ...(scope ? { hubId: { in: scope } } : {}) },
      omit: { csv: true },
      include: { schedule: { select: { id: true, name: true } } },
      ...pageArgs(query),
    });
    return toPage(rows, query.limit);
  }

  async getRun(actor: Actor, id: string) {
    const run = await this.prisma.reportRun.findUnique({ where: { id }, include: { schedule: { select: { id: true, name: true } } } });
    if (!run) throw notFound("Report");
    const scope = opsHubScope(actor);
    if (scope && (!run.hubId || !scope.includes(run.hubId))) throw forbidden("This report covers other hubs");
    return run;
  }

  private runView(run: { id: string; kind: ReportKind; periodStart: Date; periodEnd: Date; hubId: string | null; rowCount: number; status: string; error: string | null; createdAt: Date; scheduleId: string | null }) {
    const { id, kind, periodStart, periodEnd, hubId, rowCount, status, error, createdAt, scheduleId } = run;
    return { id, kind, title: TITLE[kind], from: dhakaDay(periodStart), to: dhakaDay(new Date(periodEnd.getTime() - 1)), hubId, rowCount, status, error, createdAt, scheduleId };
  }

  /** Hub operators always get their own hub's report. */
  private hubFor(actor: Actor, hubId?: string) {
    const scope = opsHubScope(actor);
    if (!scope) return hubId ?? null;
    if (hubId && !scope.includes(hubId)) throw forbidden("You can only report on your own hub");
    if (!hubId && scope.length !== 1) throw new AppError("HUB_REQUIRED", "Choose one of your hubs", 422);
    return hubId ?? scope[0];
  }

  // ───────────── report builders ─────────────

  async build(kind: ReportKind, from: string, to: string, hubId: string | null): Promise<ReportTable> {
    const hub = hubId ? await this.prisma.hub.findUnique({ where: { id: hubId }, select: { id: true, name: true } }) : null;
    if (hubId && !hub) throw notFound("Hub");
    const [start, end] = dhakaDateRange(from, to);
    const base = { kind, title: TITLE[kind], from, to, hub };
    switch (kind) {
      case "DELIVERIES":
        return { ...base, ...(await this.deliveries(from, to, hubId)) };
      case "SLA":
        return { ...base, ...(await this.sla(start, end, hubId)) };
      case "COD":
        return { ...base, ...(await this.cod(start, end, hubId)) };
      case "RIDERS":
        return { ...base, ...(await this.riders(from, to, start, end, hubId)) };
    }
  }

  private async deliveries(from: string, to: string, hubId: string | null) {
    const hub = hubId ? Prisma.sql`AND p."currentHubId" = ${hubId}::uuid` : Prisma.empty;
    const local = (col: string) => Prisma.raw(`(p."${col}" + interval '6 hours')::date`);
    const rows = await this.prisma.$queryRaw<
      { day: string; booked: number; picked: number; delivered: number; on_time: number; failed: number; returned: number; cancelled: number; cod: number }[]
    >`
      WITH days AS (SELECT generate_series(${from}::date, ${to}::date, interval '1 day')::date AS d)
      SELECT to_char(d, 'YYYY-MM-DD') AS day,
        (SELECT count(*) FROM parcels p WHERE ${local("createdAt")} = d ${hub})::int AS booked,
        (SELECT count(*) FROM parcels p WHERE ${local("pickedUpAt")} = d ${hub})::int AS picked,
        (SELECT count(*) FROM parcels p WHERE p.status = 'DELIVERED' AND ${local("deliveredAt")} = d ${hub})::int AS delivered,
        (SELECT count(*) FROM parcels p WHERE p.status = 'DELIVERED' AND ${local("deliveredAt")} = d AND p."deliveredAt" <= COALESCE(p."deliveryDueAt", p."estimatedDeliveryAt") ${hub})::int AS on_time,
        (SELECT count(*) FROM delivery_attempts a JOIN parcels p ON p.id = a."parcelId" WHERE a.outcome = 'FAILED' AND (a."createdAt" + interval '6 hours')::date = d ${hub})::int AS failed,
        (SELECT count(*) FROM parcels p WHERE p.status = 'RETURNED' AND ${local("updatedAt")} = d ${hub})::int AS returned,
        (SELECT count(*) FROM parcels p WHERE p.status = 'PICKUP_CANCELLED' AND ${local("cancelledAt")} = d ${hub})::int AS cancelled,
        (SELECT COALESCE(sum(p."codAmount"), 0) FROM parcels p WHERE p.status = 'DELIVERED' AND ${local("deliveredAt")} = d ${hub})::float AS cod
      FROM days ORDER BY d`;
    return {
      header: ["Date", "Booked", "Picked up", "Delivered", "Delivered on time", "On-time %", "Failed attempts", "Returned", "Cancelled", "COD delivered (BDT)"],
      rows: rows.map(r => [r.day, r.booked, r.picked, r.delivered, r.on_time, pct(r.on_time, r.delivered), r.failed, r.returned, r.cancelled, money(r.cod)]),
    };
  }

  private async sla(start: Date, end: Date, hubId: string | null) {
    const hub = hubId ? Prisma.sql`AND "currentHubId" = ${hubId}::uuid` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<{ district: string; zone: string; level: string; n: number; ok: number; late_minutes: number | null }[]>`
      SELECT "deliveryDistrict" AS district, "deliveryZone" AS zone, "serviceLevel"::text AS level, count(*)::int AS n,
             count(*) FILTER (WHERE "deliveredAt" <= "deliveryDueAt")::int AS ok,
             (avg(EXTRACT(EPOCH FROM ("deliveredAt" - "deliveryDueAt")) / 60) FILTER (WHERE "deliveredAt" > "deliveryDueAt"))::float AS late_minutes
      FROM parcels
      WHERE status = 'DELIVERED' AND "deliveryDueAt" IS NOT NULL AND "deliveredAt" >= ${ts(start)} AND "deliveredAt" < ${ts(end)} ${hub}
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
    return {
      header: ["District", "Zone", "Service level", "Delivered", "On time", "Late", "On-time %", "Avg. minutes late"],
      rows: rows.map(r => [r.district, r.zone, r.level, r.n, r.ok, r.n - r.ok, pct(r.ok, r.n), r.late_minutes == null ? null : Math.round(r.late_minutes)]),
    };
  }

  private async cod(start: Date, end: Date, hubId: string | null) {
    const riders = await this.prisma.rider.findMany({
      where: hubId ? { hubId } : {},
      select: { id: true, code: true, user: { select: { name: true } }, hub: { select: { name: true } } },
      orderBy: { code: "asc" },
    });
    const ids = riders.map(r => r.id);
    const [collected, handed, holding] = await Promise.all([
      this.prisma.codCollection.groupBy({ by: ["riderId"], where: { riderId: { in: ids }, collectedAt: { gte: start, lt: end } }, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.cashHandover.groupBy({ by: ["riderId"], where: { riderId: { in: ids }, createdAt: { gte: start, lt: end } }, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.codCollection.groupBy({ by: ["riderId"], where: { riderId: { in: ids }, state: "WITH_RIDER" }, _sum: { amount: true } }),
    ]);
    const rows = riders
      .map(r => {
        const c = collected.find(x => x.riderId === r.id);
        const h = handed.find(x => x.riderId === r.id);
        const w = holding.find(x => x.riderId === r.id);
        return [`${r.code} · ${r.user.name}`, r.hub?.name ?? "", c?._count._all ?? 0, money(c?._sum.amount), h?._count._all ?? 0, money(h?._sum.amount), money(w?._sum.amount)] as (string | number)[];
      })
      .filter(r => Number(r[2]) || Number(r[4]) || Number(r[6]));
    return { header: ["Rider", "Hub", "Collections", "COD collected (BDT)", "Handovers", "Handed over (BDT)", "Still with rider (BDT)"], rows };
  }

  private async riders(from: string, to: string, start: Date, end: Date, hubId: string | null) {
    const riders = await this.prisma.rider.findMany({
      where: { active: true, ...(hubId ? { hubId } : {}) },
      select: { id: true, code: true, user: { select: { name: true } }, hub: { select: { name: true } } },
      orderBy: { code: "asc" },
      take: 2000,
    });
    const ids = riders.map(r => r.id);
    const [delivered, failed, picked, attendance] = await Promise.all([
      this.prisma.parcel.groupBy({ by: ["deliveryRiderId"], where: { deliveryRiderId: { in: ids }, status: "DELIVERED", deliveredAt: { gte: start, lt: end } }, _count: { _all: true }, _sum: { codAmount: true } }),
      this.prisma.deliveryAttempt.groupBy({ by: ["riderId"], where: { riderId: { in: ids }, outcome: "FAILED", createdAt: { gte: start, lt: end } }, _count: { _all: true } }),
      this.prisma.parcel.groupBy({ by: ["pickupRiderId"], where: { pickupRiderId: { in: ids }, pickedUpAt: { gte: start, lt: end } }, _count: { _all: true } }),
      this.prisma.riderAttendance.findMany({
        where: { riderId: { in: ids }, workDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } },
        select: { riderId: true, workDate: true, checkInAt: true, checkOutAt: true },
      }),
    ]);
    const now = Date.now();
    return {
      header: ["Rider", "Hub", "Delivered", "Failed attempts", "Delivery success %", "Pickups", "COD delivered (BDT)", "Days present", "Hours on shift"],
      rows: riders.map(r => {
        const d = delivered.find(x => x.deliveryRiderId === r.id);
        const f = failed.find(x => x.riderId === r.id)?._count._all ?? 0;
        const mine = attendance.filter(a => a.riderId === r.id);
        const days = new Set(mine.map(a => a.workDate.toISOString().slice(0, 10))).size;
        const minutes = mine.reduce((n, a) => n + ((a.checkOutAt?.getTime() ?? now) - a.checkInAt.getTime()) / 60_000, 0);
        const done = d?._count._all ?? 0;
        return [`${r.code} · ${r.user.name}`, r.hub?.name ?? "", done, f, pct(done, done + f), picked.find(x => x.pickupRiderId === r.id)?._count._all ?? 0, money(d?._sum.codAmount), days, Math.round((minutes / 60) * 10) / 10];
      }),
    };
  }
}
