import { HttpStatus, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { RealtimeService } from "../../common/realtime.service";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import { nextNumber } from "../../common/counters";
import { pageArgs, toPage } from "../../common/pagination";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { Prisma, type RiderEarningType } from "../../generated/prisma/client";
import { LedgerService } from "../finance/ledger.service";
import { NotifyService } from "../notifications/notify.service";
import { OutboxService } from "../notifications/outbox.service";
import { dhakaDayStart, dhakaMonthStart, dhakaWeekStart } from "../parcels/ops-scope";
import { activePlan, planFromConfig } from "./earnings";
import type { adjustmentSchema, earningsQuerySchema, payoutRunSchema, payoutsQuerySchema, payPayoutSchema, payPlanSchema, syncPlansSchema } from "./rider.schemas";

const ZERO = new Prisma.Decimal(0);
const money = (d: Prisma.Decimal | number | null | undefined) => Number(new Prisma.Decimal(d ?? 0).toFixed(2));
const DAY_MS = 86_400_000;

/** Company staff who may see rider pay: finance (FINANCE, SUPER_ADMIN) and rider managers (OPS_MANAGER). */
export const canReadPay = (a: Actor) =>
  a.kind === "user" && (a.permissions.has("rider:manage") || a.roles.some(r => r.role === "FINANCE" || r.role === "SUPER_ADMIN"));
export const canManagePay = (a: Actor) => a.permissions.has("rider:manage") || a.permissions.has("finance:manage");

const earningView = (e: {
  id: string;
  type: RiderEarningType;
  amount: Prisma.Decimal;
  trackingId: string | null;
  serviceLine: string | null;
  description: string;
  earnedAt: Date;
  payoutId: string | null;
}) => ({ id: e.id, type: e.type, amount: money(e.amount), trackingId: e.trackingId, serviceLine: e.serviceLine, description: e.description, earnedAt: e.earnedAt, payoutId: e.payoutId });

const payoutInclude = { rider: { select: { id: true, code: true, user: { select: { name: true } } } }, _count: { select: { earnings: true } } } satisfies Prisma.RiderPayoutInclude;
type PayoutRow = Prisma.RiderPayoutGetPayload<{ include: typeof payoutInclude }>;
const payoutView = (p: PayoutRow) => ({
  id: p.id,
  number: p.number,
  rider: { id: p.rider.id, code: p.rider.code, name: p.rider.user.name },
  periodStart: p.periodStart,
  periodEnd: p.periodEnd,
  amount: money(p.amount),
  status: p.status,
  earnings: p._count.earnings,
  createdById: p.createdById,
  approvedById: p.approvedById,
  approvedAt: p.approvedAt,
  paidAt: p.paidAt,
  paymentMethod: p.paymentMethod,
  paymentReference: p.paymentReference,
  note: p.note,
  createdAt: p.createdAt,
});

/** Salary owed for [start, end): each day earns 1/(days in that month) of the monthly salary. */
export function salaryFor(monthlySalary: number, start: Date, end: Date) {
  let total = 0;
  for (let t = dhakaDayStart(start).getTime(); t < end.getTime(); t += DAY_MS) {
    const day = new Date(Math.max(t, start.getTime()));
    const local = new Date(day.getTime() + 6 * 3600_000);
    const daysInMonth = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();
    const covered = (Math.min(t + DAY_MS, end.getTime()) - day.getTime()) / DAY_MS;
    total += (monthlySalary / daysInMonth) * covered;
  }
  return Math.round(total * 100) / 100;
}

@Injectable()
export class RiderPayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly ledger: LedgerService,
    private readonly notify: NotifyService,
    private readonly outbox: OutboxService,
  ) {}

  // ───────────── rider app ─────────────

  /** The rider's real earnings: plan, totals, this month's ledger lines and payouts. */
  async myEarnings(actor: UserActor) {
    if (!actor.riderId) throw forbidden("Only riders have earnings");
    const riderId = actor.riderId;
    const now = new Date();
    const [today, week, month] = [dhakaDayStart(now), dhakaWeekStart(now), dhakaMonthStart(now)];
    const total = (where: Prisma.RiderEarningWhereInput) => this.prisma.riderEarning.aggregate({ where: { riderId, ...where }, _sum: { amount: true }, _count: { _all: true } });
    const [plan, t, w, m, unpaid, byType, items, payouts, paid] = await Promise.all([
      activePlan(this.prisma, riderId, now),
      total({ earnedAt: { gte: today } }),
      total({ earnedAt: { gte: week } }),
      total({ earnedAt: { gte: month } }),
      total({ OR: [{ payoutId: null }, { payout: { status: { in: ["DRAFT", "APPROVED"] } } }] }),
      this.prisma.riderEarning.groupBy({ by: ["type"], where: { riderId, earnedAt: { gte: today } }, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.riderEarning.findMany({ where: { riderId, earnedAt: { gte: month } }, orderBy: { earnedAt: "desc" }, take: 100 }),
      this.prisma.riderPayout.findMany({ where: { riderId, status: { not: "CANCELLED" } }, include: payoutInclude, orderBy: { createdAt: "desc" }, take: 12 }),
      this.prisma.riderPayout.aggregate({ where: { riderId, status: "PAID" }, _sum: { amount: true } }),
    ]);
    const typeTotal = (type: RiderEarningType) => {
      const row = byType.find(b => b.type === type);
      return { amount: money(row?._sum.amount), count: row?._count._all ?? 0 };
    };
    return {
      plan,
      totals: {
        today: money(t._sum.amount),
        week: money(w._sum.amount),
        month: money(m._sum.amount),
        unpaid: money(unpaid._sum.amount),
        paidToDate: money(paid._sum.amount),
      },
      today: { delivery: typeTotal("DELIVERY"), pickup: typeTotal("PICKUP"), incentive: typeTotal("INCENTIVE"), deduction: typeTotal("DEDUCTION"), salary: typeTotal("SALARY") },
      /** Salary accrues daily and is added to the payout for the period. */
      salaryToday: plan.mode === "PER_PARCEL" ? 0 : salaryFor(plan.monthlySalary, today, new Date(today.getTime() + DAY_MS)),
      items: items.map(earningView),
      payouts: payouts.map(payoutView),
    };
  }

  // ───────────── plans ─────────────

  async listPlans(actor: Actor, riderId?: string) {
    if (!canReadPay(actor)) throw forbidden();
    const plans = await this.prisma.riderPayPlan.findMany({
      where: riderId ? { riderId } : { effectiveTo: null },
      include: { rider: { select: { code: true, user: { select: { name: true } } } } },
      orderBy: [{ riderId: "asc" }, { effectiveFrom: "desc" }],
      take: 1000,
    });
    return plans.map(p => ({
      id: p.id,
      riderId: p.riderId,
      rider: { code: p.rider.code, name: p.rider.user.name },
      name: p.name,
      mode: p.mode,
      rates: { ecommerce: money(p.ecommerceRate), document: money(p.documentRate), parcel: money(p.parcelRate) },
      pickupRate: money(p.pickupRate),
      monthlySalary: money(p.monthlySalary),
      source: p.source,
      effectiveFrom: p.effectiveFrom,
      effectiveTo: p.effectiveTo,
    }));
  }

  /** The plan a rider is paid on right now (stored, else from the platform settings). */
  async currentPlan(actor: Actor, riderId: string) {
    if (!canReadPay(actor)) throw forbidden();
    if (!(await this.prisma.rider.findUnique({ where: { id: riderId } }))) throw notFound("Rider");
    return activePlan(this.prisma, riderId);
  }

  /** Puts a new plan in force from `effectiveFrom` (now by default), closing the previous one. */
  async setPlan(actor: Actor, input: z.infer<typeof payPlanSchema>, meta: RequestMeta, source: "manual" | "platform-config" = "manual", db?: Db) {
    if (!canManagePay(actor)) throw forbidden();
    const from = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date();
    const work = async (tx: Db) => {
      if (!(await tx.rider.findUnique({ where: { id: input.riderId } }))) throw notFound("Rider");
      if (await tx.riderPayPlan.findFirst({ where: { riderId: input.riderId, effectiveFrom: { gt: from } } }))
        throw conflict("PLAN_SCHEDULED", "A later plan is already scheduled for this rider");
      await tx.riderPayPlan.updateMany({ where: { riderId: input.riderId, effectiveTo: null }, data: { effectiveTo: from } });
      const plan = await tx.riderPayPlan.create({
        data: {
          riderId: input.riderId,
          name: input.name,
          mode: input.mode,
          ecommerceRate: input.ecommerceRate,
          documentRate: input.documentRate,
          parcelRate: input.parcelRate,
          pickupRate: input.pickupRate,
          monthlySalary: input.monthlySalary,
          source,
          effectiveFrom: from,
          createdById: actor.kind === "user" ? actor.userId : null,
        },
      });
      await this.audit.record(actor, { action: "rider.pay_plan.set", entityType: "rider", entityId: input.riderId, data: { ...input, source, planId: plan.id } }, meta, tx);
      return plan;
    };
    const plan = db ? await work(db) : await this.prisma.$transaction(work);
    return (await this.listPlans(actor, input.riderId)).find(p => p.id === plan.id)!;
  }

  /**
   * Seeds stored plans from the super admin's "Rider plans" settings (platform-config) for
   * every active rider. Riders on a manually set plan are left alone.
   */
  async syncFromConfig(actor: Actor, input: z.infer<typeof syncPlansSchema>, meta: RequestMeta) {
    if (!canManagePay(actor)) throw forbidden();
    const [setting, riders] = await Promise.all([
      this.prisma.setting.findUnique({ where: { key: "platform-config" } }),
      this.prisma.rider.findMany({ where: { active: true }, select: { id: true, code: true } }),
    ]);
    let created = 0;
    let unchanged = 0;
    let manual = 0;
    for (const rider of riders) {
      const current = await this.prisma.riderPayPlan.findFirst({ where: { riderId: rider.id, effectiveTo: null }, orderBy: { effectiveFrom: "desc" } });
      if (current?.source === "manual") {
        manual++;
        continue;
      }
      if (current && !input.overwriteSeeded) {
        unchanged++;
        continue;
      }
      const plan = planFromConfig(setting?.value, rider.code);
      const same =
        current &&
        current.mode === plan.mode &&
        money(current.ecommerceRate) === plan.rates.ecommerce &&
        money(current.documentRate) === plan.rates.document &&
        money(current.parcelRate) === plan.rates.parcel &&
        money(current.monthlySalary) === plan.monthlySalary;
      if (same) {
        unchanged++;
        continue;
      }
      await this.setPlan(
        actor,
        {
          riderId: rider.id,
          name: plan.name,
          mode: plan.mode,
          ecommerceRate: plan.rates.ecommerce,
          documentRate: plan.rates.document,
          parcelRate: plan.rates.parcel,
          pickupRate: current ? money(current.pickupRate) : 0,
          monthlySalary: plan.monthlySalary,
        },
        meta,
        "platform-config",
      );
      created++;
    }
    return { riders: riders.length, created, unchanged, manual };
  }

  // ───────────── earnings ─────────────

  async listEarnings(actor: Actor, query: z.infer<typeof earningsQuerySchema>) {
    if (!canReadPay(actor)) throw forbidden();
    const rows = await this.prisma.riderEarning.findMany({
      where: {
        riderId: query.riderId,
        earnedAt: query.from || query.to ? { gte: query.from ? new Date(query.from) : undefined, lt: query.to ? new Date(query.to) : undefined } : undefined,
        payoutId: query.unpaid === undefined ? undefined : query.unpaid ? null : { not: null },
      },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { ...page, items: page.items.map(e => ({ ...earningView(e), riderId: e.riderId })) };
  }

  /** Incentive (positive) or deduction (negative) line on a rider's earnings, audited. */
  async addAdjustment(actor: Actor, input: z.infer<typeof adjustmentSchema>, meta: RequestMeta) {
    if (!canManagePay(actor)) throw forbidden();
    const rider = await this.prisma.rider.findUnique({ where: { id: input.riderId } });
    if (!rider) throw notFound("Rider");
    const amount = input.type === "DEDUCTION" ? -input.amount : input.amount;
    const earning = await this.prisma.$transaction(async tx => {
      const row = await tx.riderEarning.create({
        data: {
          riderId: rider.id,
          type: input.type,
          amount,
          sourceKey: `ADJ:${randomUUID()}`,
          description: input.description,
          earnedAt: input.earnedAt ? new Date(input.earnedAt) : new Date(),
          createdById: actor.kind === "user" ? actor.userId : null,
        },
      });
      await this.audit.record(actor, { action: `rider.earning.${input.type.toLowerCase()}`, entityType: "rider", entityId: rider.id, data: { amount, description: input.description, earningId: row.id } }, meta, tx);
      return row;
    });
    this.realtime.publish({ type: "rider.earnings", id: rider.id, riderIds: [rider.id], staffPermission: "rider:manage" });
    return earningView(earning);
  }

  // ───────────── payouts ─────────────

  async listPayouts(actor: Actor, query: z.infer<typeof payoutsQuerySchema>) {
    if (!canReadPay(actor)) throw forbidden();
    const rows = await this.prisma.riderPayout.findMany({ where: { riderId: query.riderId, status: query.status }, include: payoutInclude, ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    return { ...page, items: page.items.map(payoutView) };
  }

  async getPayout(actor: Actor, id: string) {
    const p = await this.prisma.riderPayout.findUnique({ where: { id }, include: { ...payoutInclude, earnings: { orderBy: { earnedAt: "asc" } } } });
    const own = actor.kind === "user" && !!actor.riderId && p?.riderId === actor.riderId;
    if (!p || (!own && !canReadPay(actor))) throw notFound("Payout");
    return { ...payoutView(p), lines: p.earnings.map(earningView) };
  }

  /**
   * Creates DRAFT payouts for a period: each rider's unpaid earnings up to periodEnd plus the
   * salary accrued in the period. Riders with an overlapping payout or nothing owed are skipped.
   */
  async createRun(actor: Actor, input: z.infer<typeof payoutRunSchema>, meta: RequestMeta) {
    if (!canManagePay(actor)) throw forbidden();
    const start = new Date(input.periodStart);
    const end = new Date(input.periodEnd);
    if (end.getTime() > Date.now() + DAY_MS) throw new AppError("PERIOD_IN_FUTURE", "The pay period can't end in the future", 422);
    const riders = await this.prisma.rider.findMany({
      where: input.riderIds ? { id: { in: input.riderIds } } : { OR: [{ active: true }, { earnings: { some: { payoutId: null } } }] },
      select: { id: true, code: true, user: { select: { name: true } } },
      orderBy: { code: "asc" },
    });
    const created: ReturnType<typeof payoutView>[] = [];
    const skipped: { riderId: string; code: string; reason: string }[] = [];
    for (const rider of riders) {
      const result = await this.prisma.$transaction(
        async tx => {
          const overlap = await tx.riderPayout.findFirst({ where: { riderId: rider.id, status: { not: "CANCELLED" }, periodStart: { lt: end }, periodEnd: { gt: start } } });
          if (overlap) return { skip: `PERIOD_OVERLAP:${overlap.number}` };
          const plan = await activePlan(tx, rider.id, new Date(end.getTime() - 1));
          if (plan.mode !== "PER_PARCEL" && plan.monthlySalary > 0) {
            const salary = salaryFor(plan.monthlySalary, start, end);
            if (salary > 0)
              await tx.riderEarning.createMany({
                data: [
                  {
                    riderId: rider.id,
                    type: "SALARY",
                    amount: salary,
                    sourceKey: `SALARY:${rider.id}:${start.toISOString()}:${end.toISOString()}`,
                    description: `Salary ${start.toISOString().slice(0, 10)} – ${new Date(end.getTime() - 1).toISOString().slice(0, 10)}`,
                    earnedAt: start,
                    planId: plan.id,
                  },
                ],
                skipDuplicates: true,
              });
          }
          const lines = await tx.riderEarning.findMany({ where: { riderId: rider.id, payoutId: null, earnedAt: { lt: end } }, select: { id: true, amount: true } });
          const amount = lines.reduce((a, l) => a.plus(l.amount), ZERO);
          if (!lines.length) return { skip: "NOTHING_OWED" };
          if (amount.lte(0)) return { skip: "NEGATIVE_BALANCE" };
          const payout = await tx.riderPayout.create({
            data: {
              number: await nextNumber(tx, "RPO", "month"),
              riderId: rider.id,
              periodStart: start,
              periodEnd: end,
              amount,
              note: input.note,
              createdById: actor.kind === "user" ? actor.userId : null,
            },
            include: payoutInclude,
          });
          const linked = await tx.riderEarning.updateMany({ where: { id: { in: lines.map(l => l.id) }, payoutId: null }, data: { payoutId: payout.id } });
          if (linked.count !== lines.length) throw conflict("EARNINGS_CHANGED", "Earnings changed while the payout was being prepared. Try again.");
          await this.audit.record(actor, { action: "rider.payout.create", entityType: "rider_payout", entityId: payout.id, data: { number: payout.number, riderId: rider.id, amount: amount.toFixed(2), lines: lines.length } }, meta, tx);
          return { payout: payoutView({ ...payout, _count: { earnings: lines.length } }) };
        },
        { timeout: 15_000 },
      );
      if ("payout" in result && result.payout) created.push(result.payout);
      else skipped.push({ riderId: rider.id, code: rider.code, reason: result.skip! });
    }
    if (created.length) this.realtime.publish({ type: "rider.payout", id: "run", staffPermission: "finance:manage", riderIds: created.map(p => p.rider.id) });
    return { periodStart: start, periodEnd: end, created, skipped, total: Math.round(created.reduce((a, p) => a + p.amount, 0) * 100) / 100 };
  }

  /** Checker step: a different person approves a DRAFT payout. */
  async approve(actor: Actor, id: string, meta: RequestMeta) {
    if (!canManagePay(actor) || actor.kind !== "user") throw forbidden();
    await this.prisma.$transaction(async tx => {
      const p = await tx.riderPayout.findUnique({ where: { id } });
      if (!p) throw notFound("Payout");
      if (p.status !== "DRAFT") throw conflict("PAYOUT_NOT_DRAFT", `Payout ${p.number} is ${p.status.toLowerCase()}`);
      if (p.createdById === actor.userId) throw new AppError("MAKER_CHECKER", "Another person must approve a payout you prepared", HttpStatus.FORBIDDEN);
      const { count } = await tx.riderPayout.updateMany({ where: { id, status: "DRAFT" }, data: { status: "APPROVED", approvedById: actor.userId, approvedAt: new Date() } });
      if (!count) throw conflict("PAYOUT_CHANGED", "This payout was just changed by someone else");
      await this.audit.record(actor, { action: "rider.payout.approve", entityType: "rider_payout", entityId: id, data: { number: p.number } }, meta, tx);
    });
    return this.publishPayout(id);
  }

  /** Finance records the money sent: ledger RIDER_PAYOUT_PAID and an SMS/email to the rider. */
  async markPaid(actor: Actor, id: string, input: z.infer<typeof payPayoutSchema>, meta: RequestMeta) {
    if (!actor.permissions.has("finance:manage") || actor.kind !== "user") throw forbidden("Only finance can mark payouts as paid");
    const outboxIds = await this.prisma.$transaction(async tx => {
      const p = await tx.riderPayout.findUnique({ where: { id }, include: { rider: { select: { userId: true, hubId: true, code: true, user: { select: { name: true } } } } } });
      if (!p) throw notFound("Payout");
      if (p.status !== "APPROVED") throw conflict("PAYOUT_NOT_APPROVED", `Payout ${p.number} must be approved before it is paid`);
      const paidAt = new Date();
      const { count } = await tx.riderPayout.updateMany({
        where: { id, status: "APPROVED" },
        data: { status: "PAID", paidById: actor.userId, paidAt, paymentMethod: input.paymentMethod, paymentReference: input.paymentReference, note: input.note ?? p.note },
      });
      if (!count) throw conflict("PAYOUT_CHANGED", "This payout was just changed by someone else");
      await this.ledger.record(tx, {
        type: "RIDER_PAYOUT_PAID",
        amount: p.amount,
        reference: p.number,
        riderId: p.riderId,
        hubId: p.rider.hubId,
        occurredAt: paidAt,
        memo: `${input.paymentMethod} ${input.paymentReference}`,
      });
      await this.audit.record(actor, { action: "rider.payout.pay", entityType: "rider_payout", entityId: id, data: { number: p.number, amount: p.amount.toFixed(2), ...input } }, meta, tx);
      return this.notify.notify(tx, {
        event: "rider.payout_paid",
        to: { userId: p.rider.userId, name: p.rider.user.name },
        vars: { name: p.rider.user.name, number: p.number, amount: `৳${money(p.amount).toLocaleString("en-BD")}`, method: input.paymentMethod, reference: input.paymentReference },
      });
    });
    await this.outbox.flush(outboxIds);
    return this.publishPayout(id);
  }

  /** Cancels a payout that hasn't been paid; its earnings become unpaid again (accrued salary is removed). */
  async cancel(actor: Actor, id: string, note: string | undefined, meta: RequestMeta) {
    if (!canManagePay(actor)) throw forbidden();
    await this.prisma.$transaction(async tx => {
      const p = await tx.riderPayout.findUnique({ where: { id } });
      if (!p) throw notFound("Payout");
      if (p.status === "PAID" || p.status === "CANCELLED") throw conflict("PAYOUT_CLOSED", `Payout ${p.number} is ${p.status.toLowerCase()}`);
      const { count } = await tx.riderPayout.updateMany({ where: { id, status: p.status }, data: { status: "CANCELLED", note: note ?? p.note } });
      if (!count) throw conflict("PAYOUT_CHANGED", "This payout was just changed by someone else");
      await tx.riderEarning.deleteMany({ where: { payoutId: id, type: "SALARY" } });
      await tx.riderEarning.updateMany({ where: { payoutId: id }, data: { payoutId: null } });
      await this.audit.record(actor, { action: "rider.payout.cancel", entityType: "rider_payout", entityId: id, data: { number: p.number, note: note ?? null } }, meta, tx);
    });
    return this.publishPayout(id);
  }

  private async publishPayout(id: string) {
    const p = await this.prisma.riderPayout.findUniqueOrThrow({ where: { id }, include: payoutInclude });
    this.realtime.publish({ type: "rider.payout", id: p.number, riderIds: [p.riderId], staffPermission: "finance:manage", data: { status: p.status } });
    return payoutView(p);
  }
}
