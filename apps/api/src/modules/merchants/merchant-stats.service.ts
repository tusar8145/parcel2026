import { Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import type { ParcelStatus, quoteRequestSchema } from "@delivery-fast/shared";
import { PrismaService } from "../../common/prisma.service";
import type { Actor, UserActor } from "../../common/auth/actor";
import { Prisma } from "../../generated/prisma/client";
import { PricingService } from "../pricing/pricing.service";
import { PackagesService, quoteResponse } from "../packages/packages.service";
import { quoteRequestOf } from "../packages/packages.controller";
import { MerchantsService } from "./merchants.service";
import type { merchantStatsQuerySchema } from "./merchants.schemas";
import { fillSeries, periodBuckets, periodView, resolvePeriod, type Period } from "../../common/period";

/** Bangladesh has no daylight saving time: local time is always UTC+6. */
const DHAKA_OFFSET_MS = 6 * 3600_000;
const DAY_MS = 86_400_000;

/** Status groups the merchant dashboards show. Awaiting pickup counts rider pickups only (hub drop-offs wait for the sender). */
export const AWAITING_PICKUP: ParcelStatus[] = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];
export const IN_TRANSIT: ParcelStatus[] = ["PICKED_UP", "AT_HUB", "IN_TRANSIT", "ASSIGNED", "OUT_FOR_DELIVERY"];
export const NEEDS_ATTENTION: ParcelStatus[] = ["EXCEPTION", "RETRY_SCHEDULED", "RETURN_SCHEDULED"];
const NOT_A_SALE: ParcelStatus[] = ["PICKUP_CANCELLED", "RETURN_SCHEDULED", "RETURNED"];

/** Midnight (Dhaka) of the day containing `t`, as a UTC instant. */
const dhakaDay = (t: number) => Math.floor((t + DHAKA_OFFSET_MS) / DAY_MS) * DAY_MS - DHAKA_OFFSET_MS;
/** First instant of a Dhaka calendar month (month may overflow, e.g. -1 or 12). */
const dhakaMonth = (year: number, month: number) => Date.UTC(year, month, 1) - DHAKA_OFFSET_MS;
const dhakaParts = (t: number) => {
  const local = new Date(t + DHAKA_OFFSET_MS);
  return { year: local.getUTCFullYear(), month: local.getUTCMonth() };
};
/** "YYYY-MM-DD" / "YYYY-MM" of a UTC instant, in Dhaka time. */
const dayKey = (t: number) => new Date(t + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
const monthKey = (t: number) => new Date(t + DHAKA_OFFSET_MS).toISOString().slice(0, 7);
/** A UTC instant as a `timestamp` literal (the columns store UTC without a zone). */
const ts = (t: number) => new Date(t).toISOString().replace("T", " ").replace("Z", "");

const MONTH_LABEL = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const money = (d: Prisma.Decimal | number | null | undefined) => Math.round(Number(d ?? 0) * 100) / 100;
const rate = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

type Window = { start: number; end: number };

@Injectable()
export class MerchantStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly merchants: MerchantsService,
    private readonly pricing: PricingService,
  ) {}

  /** Service packages (global module). */
  @Inject(PackagesService) private readonly packages!: PackagesService;

  /**
   * Counters and the orders chart for the merchant dashboards, computed over every parcel
   * (not just the page the browser has loaded). Money figures are for owners only.
   */
  async stats(actor: Actor, query: z.infer<typeof merchantStatsQuerySchema>) {
    const merchant = await this.merchants.resolveOwn(actor, query.merchantId);
    const merchantId = merchant.id;
    const now = Date.now();
    const today = dhakaDay(now);
    const { year, month } = dhakaParts(now);
    const thisMonth: Window = { start: dhakaMonth(year, month), end: now };
    const lastMonth: Window = { start: dhakaMonth(year, month - 1), end: dhakaMonth(year, month) };
    const inMonth = (w: Window) => ({ gte: new Date(w.start), lt: new Date(w.end) });
    const base = { merchantId } satisfies Prisma.ParcelWhereInput;

    const range = resolvePeriod(query, "this_month", new Date(now));
    const owner = this.isOwner(actor, merchantId);
    const [byStatus, awaitingDropOff, createdToday, deliveredToday, pickedUpToday, monthStats, series, customers, rangeFigures] = await Promise.all([
      this.prisma.parcel.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
      // Booked for hub drop-off and not yet handed over (no pickup rider will come).
      this.prisma.parcel.count({ where: { ...base, intake: "DROP_OFF", status: { in: AWAITING_PICKUP } } }),
      this.prisma.parcel.count({ where: { ...base, createdAt: { gte: new Date(today) } } }),
      this.prisma.parcel.count({ where: { ...base, status: "DELIVERED", deliveredAt: { gte: new Date(today) } } }),
      this.prisma.parcel.count({ where: { ...base, pickedUpAt: { gte: new Date(today) } } }),
      Promise.all([thisMonth, lastMonth].map(w => this.monthFigures(merchantId, inMonth(w)))),
      this.series(merchantId, query.period, now),
      this.customers(merchantId, thisMonth.start),
      this.rangeFigures(merchantId, range, owner),
    ]);

    const counts = Object.fromEntries(byStatus.map(g => [g.status, g._count._all])) as Partial<Record<ParcelStatus, number>>;
    const total = (statuses: ParcelStatus[]) => statuses.reduce((n, s) => n + (counts[s] ?? 0), 0);
    const inTransit = total(IN_TRANSIT);
    const awaitingPickup = total(AWAITING_PICKUP) - awaitingDropOff;
    const needsAttention = total(NEEDS_ATTENTION);
    // "Today's shipments": everything still moving plus what was delivered today.
    const todayTotal = inTransit + awaitingPickup + awaitingDropOff + needsAttention + deliveredToday;

    return {
      merchantId,
      generatedAt: new Date(now).toISOString(),
      timezone: "Asia/Dhaka",
      parcels: {
        total: byStatus.reduce((n, g) => n + g._count._all, 0),
        byStatus: counts,
        awaitingPickup,
        awaitingDropOff,
        inTransit,
        needsAttention,
        delivered: counts.DELIVERED ?? 0,
        cancelled: counts.PICKUP_CANCELLED ?? 0,
        returned: (counts.RETURNED ?? 0) + (counts.RETURN_SCHEDULED ?? 0),
      },
      today: {
        created: createdToday,
        pickedUp: pickedUpToday,
        delivered: deliveredToday,
        shipments: todayTotal,
        completionRate: rate(deliveredToday, todayTotal),
      },
      thisMonth: monthStats[0],
      lastMonth: monthStats[1],
      series,
      customers,
      /** The dashboard period (from / to; default this month) with the previous period of the same length. */
      range: rangeFigures,
      money: owner ? await this.money(merchantId, now) : null,
    };
  }

  /** Figures and the orders chart for a period, with the previous period; money for owners only. */
  private async rangeFigures(merchantId: string, p: Period, owner: boolean) {
    const win = (w: { start: Date; end: Date }) => ({ gte: w.start, lt: w.end });
    const buckets = periodBuckets(p);
    const [current, previous, pickedUp, cancelled, rows, money, previousMoney] = await Promise.all([
      this.monthFigures(merchantId, win(p)),
      this.monthFigures(merchantId, win(p.previous)),
      this.prisma.parcel.count({ where: { merchantId, pickedUpAt: win(p) } }),
      this.prisma.parcel.count({ where: { merchantId, status: "PICKUP_CANCELLED", createdAt: win(p) } }),
      this.prisma.$queryRaw<{ key: string; n: number }[]>`
        SELECT to_char("createdAt" + interval '6 hours', ${buckets.format}) AS key, count(*)::int AS n
        FROM parcels
        WHERE "merchantId" = ${merchantId}::uuid AND "createdAt" >= ${ts(p.previous.start.getTime())}::timestamp AND "createdAt" < ${ts(p.end.getTime())}::timestamp
        GROUP BY 1`,
      owner ? this.rangeMoney(merchantId, win(p)) : null,
      owner ? this.rangeMoney(merchantId, win(p.previous)) : null,
    ]);
    const series = fillSeries(buckets, new Map(rows.map(r => [r.key, r.n])));
    return {
      ...periodView(p),
      ...current,
      pickedUp,
      cancelled,
      previous: { ...previous, ...(previousMoney ? { money: previousMoney } : {}) },
      series: { bucket: p.bucket, labels: buckets.labels, keys: buckets.keys, ...series },
      money,
    };
  }

  /** COD collected from recipients in the window, the delivery charges deducted from it, and what was paid out. */
  private async rangeMoney(merchantId: string, window: { gte: Date; lt: Date }) {
    const [[cod], paid] = await Promise.all([
      this.prisma.$queryRaw<{ n: number; cod: number; charges: number }[]>`
        SELECT count(*)::int AS n, coalesce(sum(c.amount), 0)::float8 AS cod, coalesce(sum(p."totalCharge"), 0)::float8 AS charges
        FROM cod_collections c JOIN parcels p ON p.id = c."parcelId"
        WHERE p."merchantId" = ${merchantId}::uuid AND c."collectedAt" >= ${ts(window.gte.getTime())}::timestamp AND c."collectedAt" < ${ts(window.lt.getTime())}::timestamp`,
      this.prisma.merchantSettlement.aggregate({ where: { merchantId, status: "PAID", paidAt: window }, _sum: { netPayable: true }, _count: { _all: true } }),
    ]);
    return {
      codCollected: money(cod.cod),
      collections: cod.n,
      chargesOnCollected: money(cod.charges),
      /** COD collected less the delivery charges of those parcels: what the merchant is owed for the period. */
      payable: money(cod.cod - cod.charges),
      paidOut: money(paid._sum.netPayable),
      payouts: paid._count._all,
    };
  }

  /** The merchant's price for a parcel: its segment's rate card less the plan discount. */
  /**
   * The merchant's price with its package (service packages): the breakdown (`lines`), the old flat
   * fields, and the return charge it would add if the parcel came back.
   */
  async quote(actor: Actor, merchantId: string | undefined, input: z.infer<typeof quoteRequestSchema>) {
    const merchant = await this.merchants.resolveOwn(actor, merchantId);
    const quote = quoteResponse(await this.packages.quote({ merchantId: merchant.id }, quoteRequestOf(input)));
    return {
      ...quote,
      // Plan discounts are part of the package prices now.
      discountPercent: 0,
      plan: merchant.plan ? { id: merchant.plan.id, name: merchant.plan.name } : null,
    };
  }

  private isOwner(actor: Actor, merchantId: string) {
    return actor.kind === "user" && (actor as UserActor).roles.some(r => r.role === "MERCHANT_OWNER" && r.merchantId === merchantId);
  }

  /** Orders created in the window, their value and charges, and how deliveries resolved. */
  private async monthFigures(merchantId: string, window: { gte: Date; lt: Date }) {
    const [created, sales, delivered, returned] = await Promise.all([
      this.prisma.parcel.count({ where: { merchantId, createdAt: window } }),
      this.prisma.parcel.aggregate({
        where: { merchantId, createdAt: window, status: { notIn: NOT_A_SALE } },
        _sum: { codAmount: true, declaredValue: true, totalCharge: true },
      }),
      this.prisma.parcel.count({ where: { merchantId, status: "DELIVERED", deliveredAt: window } }),
      this.prisma.parcel.count({ where: { merchantId, status: { in: ["RETURN_SCHEDULED", "RETURNED"] }, updatedAt: window } }),
    ]);
    return {
      created,
      codValue: money(sales._sum.codAmount),
      declaredValue: money(sales._sum.declaredValue),
      deliveryCharges: money(sales._sum.totalCharge),
      delivered,
      returned,
      /** Delivered share of the parcels that reached an outcome in the window (null if none). */
      deliverySuccessRate: rate(delivered, delivered + returned),
    };
  }

  /** Orders per day (7d / 30d) or per month (year), with the previous period for comparison. */
  private async series(merchantId: string, period: "7d" | "30d" | "year", now: number) {
    if (period === "year") {
      const { year, month } = dhakaParts(now);
      const rows = await this.countBy(merchantId, "YYYY-MM", dhakaMonth(year - 1, 0));
      const months = Array.from({ length: month + 1 }, (_, m) => m);
      return {
        period,
        bucket: "month" as const,
        labels: months.map(m => MONTH_LABEL[m]),
        current: months.map(m => rows.get(monthKey(dhakaMonth(year, m))) ?? 0),
        previous: months.map(m => rows.get(monthKey(dhakaMonth(year - 1, m))) ?? 0),
      };
    }
    const days = period === "7d" ? 7 : 30;
    const first = dhakaDay(now) - (days - 1) * DAY_MS;
    const rows = await this.countBy(merchantId, "YYYY-MM-DD", first - days * DAY_MS);
    const starts = Array.from({ length: days }, (_, i) => first + i * DAY_MS);
    return {
      period,
      bucket: "day" as const,
      labels: starts.map(t => {
        const d = new Date(t + DHAKA_OFFSET_MS);
        return `${MONTH_LABEL[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, "0")}`;
      }),
      dates: starts.map(dayKey),
      current: starts.map(t => rows.get(dayKey(t)) ?? 0),
      previous: starts.map(t => rows.get(dayKey(t - days * DAY_MS)) ?? 0),
    };
  }

  private async countBy(merchantId: string, format: "YYYY-MM-DD" | "YYYY-MM", since: number) {
    const rows = await this.prisma.$queryRaw<{ key: string; n: number }[]>`
      SELECT to_char("createdAt" + interval '6 hours', ${format}) AS key, count(*)::int AS n
      FROM parcels
      WHERE "merchantId" = ${merchantId}::uuid AND "createdAt" >= ${ts(since)}::timestamp
      GROUP BY 1`;
    return new Map(rows.map(r => [r.key, r.n]));
  }

  /** Recipients, keyed by phone number. */
  private async customers(merchantId: string, monthStart: number) {
    const [row] = await this.prisma.$queryRaw<{ total: number; repeat: number; new_this_month: number }[]>`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE n > 1)::int AS repeat,
             count(*) FILTER (WHERE first_at >= ${ts(monthStart)}::timestamp)::int AS new_this_month
      FROM (
        SELECT "recipientPhone", count(*) AS n, min("createdAt") AS first_at
        FROM parcels
        WHERE "merchantId" = ${merchantId}::uuid AND status <> 'PICKUP_CANCELLED' AND "recipientPhone" IS NOT NULL
        GROUP BY "recipientPhone"
      ) recipients`;
    return { total: row.total, newThisMonth: row.new_this_month, repeat: row.repeat, repeatRate: rate(row.repeat, row.total) };
  }

  /** COD, payouts and invoices: what the merchant is owed and owes. */
  private async money(merchantId: string, now: number) {
    const { year, month } = dhakaParts(now);
    const quarterStart = new Date(dhakaMonth(year, month - (month % 3)));
    const [cod, [ready], settlements, lastPaid, outstanding, overdue, paidThisQuarter, billedPeriods] = await Promise.all([
      this.prisma.codCollection.groupBy({ by: ["state"], where: { parcel: { merchantId } }, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.$queryRaw<{ n: number; cod: number; charges: number }[]>`
        SELECT count(*)::int AS n, coalesce(sum(c.amount), 0)::float8 AS cod, coalesce(sum(p."totalCharge"), 0)::float8 AS charges
        FROM cod_collections c JOIN parcels p ON p.id = c."parcelId"
        WHERE p."merchantId" = ${merchantId}::uuid AND c.state = 'AT_HUB' AND c."settlementId" IS NULL`,
      this.prisma.merchantSettlement.groupBy({ by: ["status"], where: { merchantId }, _sum: { netPayable: true }, _count: { _all: true } }),
      this.prisma.merchantSettlement.findFirst({ where: { merchantId, status: "PAID" }, orderBy: { paidAt: "desc" }, select: { number: true, netPayable: true, paidAt: true } }),
      this.prisma.invoice.aggregate({ where: { merchantId, status: "ISSUED" }, _sum: { subtotal: true }, _count: { _all: true }, _min: { dueAt: true } }),
      this.prisma.invoice.count({ where: { merchantId, status: "ISSUED", dueAt: { lt: new Date(now) } } }),
      this.prisma.invoice.aggregate({ where: { merchantId, status: "PAID", paidAt: { gte: quarterStart } }, _sum: { subtotal: true }, _count: { _all: true } }),
      this.prisma.invoice.findMany({ where: { merchantId, status: { in: ["ISSUED", "PAID"] } }, select: { periodStart: true, periodEnd: true } }),
    ]);
    // Delivered prepaid parcels (no COD to deduct from) outside every issued invoice's period.
    const unbilled = await this.prisma.parcel.aggregate({
      where: {
        merchantId,
        status: "DELIVERED",
        codCollection: { is: null },
        NOT: billedPeriods.map(p => ({ deliveredAt: { gte: p.periodStart, lt: p.periodEnd } })),
      },
      _sum: { totalCharge: true },
      _count: { _all: true },
    });
    const codBy = (state: "WITH_RIDER" | "AT_HUB" | "SETTLED") => cod.find(g => g.state === state);
    const settlementBy = (status: "DRAFT" | "APPROVED" | "PAID") => settlements.find(g => g.status === status);
    return {
      cod: {
        withRiders: money(codBy("WITH_RIDER")?._sum.amount),
        atHubs: money(codBy("AT_HUB")?._sum.amount),
        settled: money(codBy("SETTLED")?._sum.amount),
        /** Collected COD not yet in a settlement, less the delivery charges deducted from it. */
        readyToSettle: { parcels: ready.n, cod: money(ready.cod), charges: money(ready.charges), net: money(ready.cod - ready.charges) },
      },
      payouts: {
        pendingApproval: money(settlementBy("DRAFT")?._sum.netPayable),
        awaitingPayment: money(settlementBy("APPROVED")?._sum.netPayable),
        paidTotal: money(settlementBy("PAID")?._sum.netPayable),
        lastPaid: lastPaid ? { number: lastPaid.number, amount: money(lastPaid.netPayable), paidAt: lastPaid.paidAt } : null,
      },
      invoices: {
        outstanding: money(outstanding._sum.subtotal),
        outstandingCount: outstanding._count._all,
        overdueCount: overdue,
        nextDueAt: outstanding._min.dueAt,
        paidThisQuarter: money(paidThisQuarter._sum.subtotal),
        paidThisQuarterCount: paidThisQuarter._count._all,
      },
      unbilled: { parcels: unbilled._count._all, charges: money(unbilled._sum.totalCharge) },
    };
  }
}
