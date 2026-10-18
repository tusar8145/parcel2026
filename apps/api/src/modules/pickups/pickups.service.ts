import { merchantPickupArea } from "../merchants/merchant-address";
import { HttpStatus, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { z } from "zod";
import { phoneSchema } from "@delivery-fast/shared";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { RealtimeService } from "../../common/realtime.service";
import { QueueService } from "../../common/queues";
import { nextNumber } from "../../common/counters";
import { AppError, conflict, notFound } from "../../common/errors";
import { pageArgs, pageQuerySchema, toPage } from "../../common/pagination";
import type { Actor } from "../../common/auth/actor";
import { assertRiderAssignable } from "../parcels/ops-scope";
import type { RequestMeta } from "../../common/auth/decorators";
import { env, runsJobs } from "../../config/env";
import type { Merchant, PickupRequest, PickupSchedule, Prisma } from "../../generated/prisma/client";
import { WebhooksService, type WebhookEvent } from "../notifications/webhooks.service";
import { MerchantsService } from "../merchants/merchants.service";

const DHAKA_OFFSET_MS = 6 * 3600_000;
const DAY_MS = 86_400_000;
/** Recurring pickups are generated this many days ahead (today and tomorrow). */
const GENERATE_DAYS_AHEAD = 1;

const hhmm = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 10:00");
const text = (min: number, max: number) => z.string().trim().min(min, `Use at least ${min} characters`).max(max, `Use at most ${max} characters`);
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

const scheduleFields = {
  name: text(2, 80),
  /** Weekdays, 0 = Sunday … 6 = Saturday. */
  days: z
    .array(z.number().int().min(0).max(6), "Choose the weekdays")
    .min(1, "Choose at least one day")
    .transform(d => [...new Set(d)].sort()),
  windowStart: hhmm,
  windowEnd: hhmm,
  street: text(3, 300),
  area: text(2, 80).optional(),
  zone: text(2, 80),
  district: text(2, 80),
  contactName: text(2, 120),
  contactPhone: phoneSchema,
  expectedParcels: z.number().int().min(1).max(5000).default(1),
  note: text(1, 500).optional(),
  active: z.boolean().default(true),
};
const windowOk = (v: { windowStart?: string; windowEnd?: string }) => !v.windowStart || !v.windowEnd || minutes(v.windowEnd) - minutes(v.windowStart) >= 30;
const windowMessage = { message: "The window must end at least 30 minutes after it starts", path: ["windowEnd"] };

export const pickupScheduleSchema = z.object(scheduleFields).refine(windowOk, windowMessage);
export const updatePickupScheduleSchema = z
  .object({
    name: scheduleFields.name.optional(),
    days: scheduleFields.days.optional(),
    windowStart: hhmm.optional(),
    windowEnd: hhmm.optional(),
    street: scheduleFields.street.optional(),
    area: text(2, 80).nullable().optional(),
    zone: scheduleFields.zone.optional(),
    district: scheduleFields.district.optional(),
    contactName: scheduleFields.contactName.optional(),
    contactPhone: phoneSchema.optional(),
    expectedParcels: z.number().int().min(1).max(5000).optional(),
    note: text(1, 500).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine(v => Object.values(v).some(x => x !== undefined), "Send at least one field to change")
  .refine(windowOk, windowMessage);

/** A one-off pickup request (address defaults to the merchant's pickup address). */
export const pickupRequestSchema = z
  .object({
    date: z.iso.date("Use a date like 2026-10-20"),
    windowStart: hhmm,
    windowEnd: hhmm,
    street: text(3, 300).optional(),
    area: text(2, 80).optional(),
    zone: text(2, 80).optional(),
    district: text(2, 80).optional(),
    contactName: text(2, 120).optional(),
    contactPhone: phoneSchema.optional(),
    expectedParcels: z.number().int().min(1).max(5000).default(1),
    note: text(1, 500).optional(),
  })
  .refine(windowOk, windowMessage);

export const merchantSelector = z.object({ merchantId: z.uuid("merchantId must be a valid id").optional() });
export const listPickupRequestsQuerySchema = pageQuerySchema.extend({
  merchantId: z.uuid().optional(),
  date: z.iso.date().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  status: z.enum(["REQUESTED", "ASSIGNED", "COMPLETED", "CANCELLED", "MISSED"]).optional(),
});
export const assignPickupRequestSchema = z.object({ riderId: z.uuid("Choose a rider") });
export const closePickupRequestSchema = z.object({ note: z.string().trim().max(500).optional() });
export const generatePickupsSchema = z.object({ date: z.iso.date().optional() });

/** Dhaka calendar day "YYYY-MM-DD" → the instant HH:MM on that day. */
const at = (day: string, time: string) => new Date(`${day}T${time}:00+06:00`);
const dhakaToday = (now = new Date()) => new Date(now.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();

const scheduleView = (s: PickupSchedule) => ({
  id: s.id,
  name: s.name,
  days: s.days,
  windowStart: s.windowStart,
  windowEnd: s.windowEnd,
  street: s.street,
  area: s.area,
  zone: s.zone,
  district: s.district,
  contactName: s.contactName,
  contactPhone: s.contactPhone,
  expectedParcels: s.expectedParcels,
  note: s.note,
  active: s.active,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

type RequestRow = PickupRequest & { merchant?: Pick<Merchant, "id" | "code" | "name"> | null; schedule?: Pick<PickupSchedule, "id" | "name"> | null };
const requestView = (r: RequestRow) => ({
  id: r.id,
  number: r.number,
  merchant: r.merchant ?? { id: r.merchantId },
  schedule: r.schedule ?? (r.scheduleId ? { id: r.scheduleId } : null),
  date: r.date.toISOString().slice(0, 10),
  windowStart: r.windowStart,
  windowEnd: r.windowEnd,
  street: r.street,
  area: r.area,
  zone: r.zone,
  district: r.district,
  contactName: r.contactName,
  contactPhone: r.contactPhone,
  expectedParcels: r.expectedParcels,
  note: r.note,
  status: r.status,
  riderId: r.riderId,
  completedAt: r.completedAt,
  createdAt: r.createdAt,
});
const requestInclude = { merchant: { select: { id: true, code: true, name: true } }, schedule: { select: { id: true, name: true } } } satisfies Prisma.PickupRequestInclude;

/**
 * Pickup scheduling for merchants: recurring daily pickups (weekdays, time window, address)
 * generate pickup requests for operations each day; merchants can also request a one-off
 * pickup. Operations assign a rider and close each request.
 */
@Injectable()
export class PickupsService implements OnApplicationBootstrap {
  private readonly logger = new Logger("Pickups");

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly queues: QueueService,
    private readonly webhooks: WebhooksService,
    private readonly merchants: MerchantsService,
  ) {}

  onApplicationBootstrap() {
    if (!runsJobs()) return;
    // Shortly after midnight (Dhaka): today's and tomorrow's recurring pickups.
    void this.queues
      .schedule("pickup-schedules-generate", "5 0 * * *", async () => {
        const created = await this.generate();
        this.logger.log(`Generated ${created} pickup request(s) from recurring schedules`);
      })
      .catch(err => this.logger.error({ err }, "Could not schedule recurring pickup generation"));
  }

  private async activeMerchant(actor: Actor, merchantId: string | undefined) {
    const m = await this.merchants.resolveOwn(actor, merchantId);
    if (m.status !== "ACTIVE") throw new AppError("MERCHANT_NOT_ACTIVE", "Pickups are available once your merchant account is approved", HttpStatus.FORBIDDEN);
    return m;
  }

  private publish(r: Pick<PickupRequest, "id" | "merchantId" | "status">) {
    this.realtime.publish({ type: "pickup_request.updated", id: r.id, merchantId: r.merchantId, staffPermission: "parcel:dispatch", data: { status: r.status } });
  }

  // ───────────── recurring schedules (merchant) ─────────────

  async listSchedules(actor: Actor, merchantId: string | undefined) {
    const m = await this.merchants.resolveOwn(actor, merchantId);
    const rows = await this.prisma.pickupSchedule.findMany({ where: { merchantId: m.id }, orderBy: { createdAt: "asc" } });
    return { items: rows.map(scheduleView) };
  }

  async createSchedule(actor: Actor, merchantId: string | undefined, input: z.infer<typeof pickupScheduleSchema>, meta: RequestMeta) {
    const m = await this.activeMerchant(actor, merchantId);
    const schedule = await this.prisma.$transaction(async tx => {
      if ((await tx.pickupSchedule.count({ where: { merchantId: m.id } })) >= 20) throw new AppError("SCHEDULE_LIMIT", "You can have at most 20 recurring pickups", HttpStatus.UNPROCESSABLE_ENTITY);
      const created = await tx.pickupSchedule.create({ data: { ...input, merchantId: m.id } });
      await this.audit.record(actor, { action: "pickup_schedule.create", entityType: "pickup_schedule", entityId: created.id, data: { merchantId: m.id, days: input.days, window: `${input.windowStart}-${input.windowEnd}` } }, meta, tx);
      return created;
    });
    // Today's pickup (if the window hasn't started yet) and tomorrow's appear right away.
    await this.generate(undefined, { scheduleId: schedule.id });
    return scheduleView(schedule);
  }

  async updateSchedule(actor: Actor, merchantId: string | undefined, id: string, input: z.infer<typeof updatePickupScheduleSchema>, meta: RequestMeta) {
    const m = await this.merchants.resolveOwn(actor, merchantId);
    const schedule = await this.prisma.$transaction(async tx => {
      const current = await tx.pickupSchedule.findFirst({ where: { id, merchantId: m.id } });
      if (!current) throw notFound("Pickup schedule");
      const next = { windowStart: input.windowStart ?? current.windowStart, windowEnd: input.windowEnd ?? current.windowEnd };
      if (!windowOk(next)) throw new AppError("INVALID_WINDOW", windowMessage.message, HttpStatus.UNPROCESSABLE_ENTITY);
      const updated = await tx.pickupSchedule.update({ where: { id }, data: input });
      await this.audit.record(actor, { action: "pickup_schedule.update", entityType: "pickup_schedule", entityId: id, data: { changes: input } }, meta, tx);
      return updated;
    });
    if (schedule.active) await this.generate(undefined, { scheduleId: schedule.id });
    return scheduleView(schedule);
  }

  /** Deletes the schedule and cancels its upcoming (not yet assigned) pickups. */
  async deleteSchedule(actor: Actor, merchantId: string | undefined, id: string, meta: RequestMeta) {
    const m = await this.merchants.resolveOwn(actor, merchantId);
    await this.prisma.$transaction(async tx => {
      const current = await tx.pickupSchedule.findFirst({ where: { id, merchantId: m.id } });
      if (!current) throw notFound("Pickup schedule");
      await tx.pickupRequest.updateMany({ where: { scheduleId: id, status: "REQUESTED", date: { gte: new Date(`${dhakaToday()}T00:00:00Z`) } }, data: { status: "CANCELLED" } });
      await tx.pickupSchedule.delete({ where: { id } });
      await this.audit.record(actor, { action: "pickup_schedule.delete", entityType: "pickup_schedule", entityId: id, data: { merchantId: m.id } }, meta, tx);
    });
  }

  /**
   * Creates the pickup requests due from active schedules on `day` (default: today and
   * tomorrow, Dhaka). Idempotent: one request per schedule and day.
   */
  async generate(day?: string, opts: { scheduleId?: string } = {}) {
    const days = day ? [day] : Array.from({ length: GENERATE_DAYS_AHEAD + 1 }, (_, i) => addDays(dhakaToday(), i));
    let created = 0;
    for (const d of days) {
      const schedules = await this.prisma.pickupSchedule.findMany({
        where: { active: true, days: { has: weekday(d) }, merchant: { status: "ACTIVE" }, ...(opts.scheduleId ? { id: opts.scheduleId } : {}) },
      });
      for (const s of schedules) {
        const windowStart = at(d, s.windowStart);
        if (windowStart.getTime() < Date.now()) continue; // too late for today
        const hooks: string[] = [];
        const request = await this.prisma
          .$transaction(async tx => {
            if (await tx.pickupRequest.findUnique({ where: { scheduleId_date: { scheduleId: s.id, date: new Date(`${d}T00:00:00Z`) } }, select: { id: true } })) return null;
            const r = await tx.pickupRequest.create({
              data: {
                number: await nextNumber(tx, "PR"),
                merchantId: s.merchantId,
                scheduleId: s.id,
                date: new Date(`${d}T00:00:00Z`),
                windowStart,
                windowEnd: at(d, s.windowEnd),
                street: s.street,
                area: s.area,
                zone: s.zone,
                district: s.district,
                contactName: s.contactName,
                contactPhone: s.contactPhone,
                expectedParcels: s.expectedParcels,
                note: s.note,
              },
            });
            hooks.push(...(await this.webhooks.emit(tx, s.merchantId, "pickup.scheduled", this.hookData(r))));
            return r;
          })
          .catch(error => {
            // A concurrent run created it first (unique schedule + day).
            if ((error as { code?: string }).code === "P2002") return null;
            throw error;
          });
        if (request) {
          created++;
          await this.webhooks.flush(hooks);
          this.publish(request);
        }
      }
    }
    return created;
  }

  // ───────────── pickup requests ─────────────

  async listMine(actor: Actor, query: z.infer<typeof listPickupRequestsQuerySchema>) {
    const m = await this.merchants.resolveOwn(actor, query.merchantId);
    return this.listWhere({ merchantId: m.id }, query);
  }

  async listAll(query: z.infer<typeof listPickupRequestsQuerySchema>) {
    return this.listWhere(query.merchantId ? { merchantId: query.merchantId } : {}, query);
  }

  private async listWhere(where: Prisma.PickupRequestWhereInput, query: z.infer<typeof listPickupRequestsQuerySchema>) {
    const date = query.date
      ? { date: new Date(`${query.date}T00:00:00Z`) }
      : query.from || query.to
        ? { date: { ...(query.from ? { gte: new Date(`${query.from}T00:00:00Z`) } : {}), ...(query.to ? { lte: new Date(`${query.to}T00:00:00Z`) } : {}) } }
        : {};
    const rows = await this.prisma.pickupRequest.findMany({ where: { ...where, ...date, status: query.status }, include: requestInclude, ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    return { items: page.items.map(requestView), nextCursor: page.nextCursor };
  }

  async requestOnce(actor: Actor, merchantId: string | undefined, input: z.infer<typeof pickupRequestSchema>, meta: RequestMeta) {
    const m = await this.activeMerchant(actor, merchantId);
    const windowStart = at(input.date, input.windowStart);
    if (windowStart.getTime() < Date.now()) throw new AppError("WINDOW_PASSED", "Choose a time window that hasn't started yet", HttpStatus.UNPROCESSABLE_ENTITY);
    if (windowStart.getTime() > Date.now() + 30 * DAY_MS) throw new AppError("TOO_FAR_AHEAD", "Pickups can be requested up to 30 days ahead", HttpStatus.UNPROCESSABLE_ENTITY);
    const hooks: string[] = [];
    const request = await this.prisma.$transaction(async tx => {
      const r = await tx.pickupRequest.create({
        data: {
          number: await nextNumber(tx, "PR"),
          merchantId: m.id,
          date: new Date(`${input.date}T00:00:00Z`),
          windowStart,
          windowEnd: at(input.date, input.windowEnd),
          street: input.street ?? m.pickupAddress,
          area: input.area ?? (input.zone ? undefined : merchantPickupArea(m)),
          zone: input.zone ?? m.pickupZone ?? m.pickupArea,
          district: input.district ?? m.pickupDistrict,
          contactName: input.contactName ?? m.pickupContactName ?? m.contactName,
          contactPhone: input.contactPhone ?? m.pickupContactPhone ?? m.contactPhone,
          expectedParcels: input.expectedParcels,
          note: input.note,
        },
        include: requestInclude,
      });
      hooks.push(...(await this.webhooks.emit(tx, m.id, "pickup.scheduled", this.hookData(r))));
      await this.audit.record(actor, { action: "pickup_request.create", entityType: "pickup_request", entityId: r.id, data: { number: r.number, date: input.date } }, meta, tx);
      return r;
    });
    await this.webhooks.flush(hooks);
    this.publish(request);
    return requestView(request);
  }

  async cancelMine(actor: Actor, merchantId: string | undefined, id: string, meta: RequestMeta) {
    const m = await this.merchants.resolveOwn(actor, merchantId);
    return this.close(actor, id, "CANCELLED", meta, { merchantId: m.id });
  }

  async assign(actor: Actor, id: string, input: z.infer<typeof assignPickupRequestSchema>, meta: RequestMeta) {
    const updated = await this.prisma.$transaction(async tx => {
      const r = await tx.pickupRequest.findUnique({ where: { id } });
      if (!r) throw notFound("Pickup request");
      if (r.status !== "REQUESTED" && r.status !== "ASSIGNED") throw conflict("PICKUP_CLOSED", `This pickup is already ${r.status.toLowerCase()}`);
      const rider = await tx.rider.findUnique({ where: { id: input.riderId }, include: { user: { select: { status: true } } } });
      if (!rider || !rider.active || rider.user.status !== "ACTIVE") throw new AppError("RIDER_UNAVAILABLE", "That rider isn't active", HttpStatus.UNPROCESSABLE_ENTITY);
      await assertRiderAssignable(tx, actor, rider.id);
      const saved = await tx.pickupRequest.update({ where: { id }, data: { status: "ASSIGNED", riderId: rider.id }, include: requestInclude });
      await this.audit.record(actor, { action: "pickup_request.assign", entityType: "pickup_request", entityId: id, data: { riderId: rider.id } }, meta, tx);
      return saved;
    });
    this.publish(updated);
    return requestView(updated);
  }

  complete(actor: Actor, id: string, meta: RequestMeta) {
    return this.close(actor, id, "COMPLETED", meta);
  }

  missed(actor: Actor, id: string, input: z.infer<typeof closePickupRequestSchema>, meta: RequestMeta) {
    return this.close(actor, id, "MISSED", meta, { note: input.note });
  }

  cancelByOps(actor: Actor, id: string, input: z.infer<typeof closePickupRequestSchema>, meta: RequestMeta) {
    return this.close(actor, id, "CANCELLED", meta, { note: input.note });
  }

  private async close(actor: Actor, id: string, to: "COMPLETED" | "MISSED" | "CANCELLED", meta: RequestMeta, opts: { merchantId?: string; note?: string } = {}) {
    const hooks: string[] = [];
    const event: Record<typeof to, WebhookEvent> = { COMPLETED: "pickup.completed", MISSED: "pickup.missed", CANCELLED: "pickup.cancelled" };
    const updated = await this.prisma.$transaction(async tx => {
      const r = await tx.pickupRequest.findFirst({ where: { id, ...(opts.merchantId ? { merchantId: opts.merchantId } : {}) } });
      if (!r) throw notFound("Pickup request");
      if (r.status !== "REQUESTED" && r.status !== "ASSIGNED")
        throw conflict("PICKUP_CLOSED", `This pickup is already ${r.status.toLowerCase()}`);
      if (opts.merchantId && r.status === "ASSIGNED") throw conflict("PICKUP_ASSIGNED", "A rider is already on the way. Contact support to cancel.");
      const { count } = await tx.pickupRequest.updateMany({ where: { id, status: r.status }, data: { status: to, completedAt: to === "COMPLETED" ? new Date() : null, note: opts.note ? `${r.note ? `${r.note}\n` : ""}${opts.note}` : undefined } });
      if (!count) throw conflict("PICKUP_CHANGED", "This pickup was just updated. Refresh and try again.");
      const saved = await tx.pickupRequest.findUniqueOrThrow({ where: { id }, include: requestInclude });
      hooks.push(...(await this.webhooks.emit(tx, r.merchantId, event[to], this.hookData(saved))));
      await this.audit.record(actor, { action: `pickup_request.${to.toLowerCase()}`, entityType: "pickup_request", entityId: id, data: { number: r.number, note: opts.note ?? null } }, meta, tx);
      return saved;
    });
    await this.webhooks.flush(hooks);
    this.publish(updated);
    return requestView(updated);
  }

  private hookData(r: PickupRequest) {
    return {
      pickupRequestId: r.id,
      number: r.number,
      date: r.date.toISOString().slice(0, 10),
      windowStart: r.windowStart.toISOString(),
      windowEnd: r.windowEnd.toISOString(),
      status: r.status,
      expectedParcels: r.expectedParcels,
      recurring: !!r.scheduleId,
    };
  }
}
