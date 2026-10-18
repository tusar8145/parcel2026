import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma.service";
import type { ParcelStatus, Role } from "../../generated/prisma/client";
import { fillSeries, periodBuckets, periodView, resolvePeriod, type Period, type PeriodQuery } from "../../common/period";

/** Roles that make someone a platform administrator / staff member. */
export const STAFF_ROLES: Role[] = ["SUPER_ADMIN", "OPS_MANAGER", "HUB_OPERATOR", "FINANCE", "SUPPORT_AGENT"];
const NOT_BOOKED: ParcelStatus[] = ["PICKUP_CANCELLED"];
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000; // Asia/Dhaka is UTC+6 all year

/** Start of the current day and month in Dhaka time, as UTC instants. */
export function dhakaPeriodStarts(now = new Date()) {
  const local = new Date(now.getTime() + DHAKA_OFFSET_MS);
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - DHAKA_OFFSET_MS;
  const month = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - DHAKA_OFFSET_MS;
  return { today: new Date(day), month: new Date(month) };
}

@Injectable()
export class OverviewService {
  constructor(private readonly prisma: PrismaService) {}

  /** Platform counts for the super admin dashboard and activity pages ("today"/"this month" in Dhaka time). */
  async overview(query: PeriodQuery = {}) {
    const { today, month } = dhakaPeriodStarts();
    const p = this.prisma;
    const chosen = resolvePeriod(query, "this_month");
    const [
      merchantsByStatus,
      newMerchants,
      approvedThisMonth,
      staffActive,
      staffByRole,
      parcelsToday,
      monthTotals,
      ridersByStatus,
      ridersTotal,
      auditThisMonth,
      merchantMonth,
      merchantLast,
      deliveredToday,
      pickedUpToday,
    ] = await Promise.all([
      p.merchant.groupBy({ by: ["status"], _count: { _all: true } }),
      p.merchant.count({ where: { createdAt: { gte: month } } }),
      p.auditLog.count({ where: { action: "merchant.approve", createdAt: { gte: month } } }),
      p.user.count({ where: { status: "ACTIVE", roles: { some: { role: { in: STAFF_ROLES } } } } }),
      p.userRole.groupBy({ by: ["role"], where: { role: { in: STAFF_ROLES }, user: { status: "ACTIVE" } }, _count: { _all: true } }),
      p.parcel.count({ where: { createdAt: { gte: today }, status: { notIn: NOT_BOOKED } } }),
      p.parcel.aggregate({
        where: { createdAt: { gte: month }, status: { notIn: NOT_BOOKED } },
        _count: { _all: true },
        _sum: { codAmount: true, totalCharge: true },
      }),
      p.rider.groupBy({ by: ["status"], where: { active: true }, _count: { _all: true } }),
      p.rider.count({ where: { active: true } }),
      p.auditLog.count({ where: { createdAt: { gte: month }, actorType: "USER" } }),
      p.parcel.groupBy({
        by: ["merchantId"],
        where: { merchantId: { not: null }, createdAt: { gte: month }, status: { notIn: NOT_BOOKED } },
        _count: { _all: true },
      }),
      p.parcel.groupBy({ by: ["merchantId"], where: { merchantId: { not: null } }, _max: { createdAt: true } }),
      p.parcel.groupBy({ by: ["deliveryRiderId"], where: { deliveryRiderId: { not: null }, deliveredAt: { gte: today } }, _count: { _all: true } }),
      p.parcel.groupBy({ by: ["pickupRiderId"], where: { pickupRiderId: { not: null }, pickedUpAt: { gte: today } }, _count: { _all: true } }),
    ]);

    const merchants: Partial<Record<string, number>> = Object.fromEntries(merchantsByStatus.map(r => [r.status, r._count._all]));
    const riders: Partial<Record<string, number>> = Object.fromEntries(ridersByStatus.map(r => [r.status, r._count._all]));
    const byMerchant = new Map<string, { merchantId: string; parcelsThisMonth: number; lastParcelAt: Date | null }>();
    for (const row of merchantLast) byMerchant.set(row.merchantId!, { merchantId: row.merchantId!, parcelsThisMonth: 0, lastParcelAt: row._max.createdAt });
    for (const row of merchantMonth) byMerchant.get(row.merchantId!)!.parcelsThisMonth = row._count._all;
    const byRider = new Map<string, { riderId: string; deliveredToday: number; pickedUpToday: number }>();
    const riderRow = (id: string) => byRider.get(id) ?? byRider.set(id, { riderId: id, deliveredToday: 0, pickedUpToday: 0 }).get(id)!;
    for (const row of deliveredToday) riderRow(row.deliveryRiderId!).deliveredToday = row._count._all;
    for (const row of pickedUpToday) riderRow(row.pickupRiderId!).pickedUpToday = row._count._all;

    // Two-step verification coverage (real numbers for the security widgets).
    const activeStaff = { status: "ACTIVE" as const, roles: { some: { role: { in: STAFF_ROLES } } } };
    const activeSuperAdmins = { status: "ACTIVE" as const, roles: { some: { role: "SUPER_ADMIN" as const } } };
    const enrolled = { mfa: { is: { enabledAt: { not: null } } } };
    const [superAdmins, superAdminsWithMfa, staffWithMfa, pendingChanges, activeSupportSessions] = await Promise.all([
      p.user.count({ where: activeSuperAdmins }),
      p.user.count({ where: { ...activeSuperAdmins, ...enrolled } }),
      p.user.count({ where: { ...activeStaff, ...enrolled } }),
      p.changeRequest.count({ where: { status: "PENDING", expiresAt: { gt: new Date() } } }),
      p.impersonationSession.count({ where: { endedAt: null, expiresAt: { gt: new Date() } } }),
    ]);

    const period = await this.periodFigures(chosen);
    return {
      generatedAt: new Date(),
      period,
      security: {
        superAdmins,
        superAdminsWithMfa,
        staff: staffActive,
        staffWithMfa,
        staffMfaPercent: staffActive ? Math.round((staffWithMfa / staffActive) * 100) : 0,
        pendingChanges,
        activeSupportSessions,
      },
      periodStarts: { today, month },
      merchants: {
        total: Object.values(merchants).reduce<number>((a, b) => a + (b ?? 0), 0),
        active: merchants.ACTIVE ?? 0,
        suspended: merchants.SUSPENDED ?? 0,
        pendingReview: merchants.PENDING_REVIEW ?? 0,
        newThisMonth: newMerchants,
        approvedThisMonth,
      },
      staff: { active: staffActive, byRole: Object.fromEntries(STAFF_ROLES.map(role => [role, staffByRole.find(r => r.role === role)?._count._all ?? 0])) },
      parcels: {
        today: parcelsToday,
        thisMonth: monthTotals._count._all,
        codThisMonth: Number(monthTotals._sum.codAmount ?? 0),
        chargesThisMonth: Number(monthTotals._sum.totalCharge ?? 0),
      },
      riders: { active: ridersTotal, online: riders.ONLINE ?? 0, onBreak: riders.ON_BREAK ?? 0, offline: riders.OFFLINE ?? 0 },
      auditEventsThisMonth: auditThisMonth,
      merchantActivity: [...byMerchant.values()],
      riderActivity: [...byRider.values()],
    };
  }

  /**
   * Bookings, revenue (COD + delivery charges), merchants and activity in a period, the previous
   * period of the same length, and the bookings chart (by hour / day / month). Indexed range queries.
   */
  private async periodFigures(period: Period) {
    const p = this.prisma;
    const buckets = periodBuckets(period);
    const figures = async (w: { start: Date; end: Date }) => {
      const range = { gte: w.start, lt: w.end };
      const [booked, delivered, newMerchants, approved, activeMerchants, auditEvents] = await Promise.all([
        p.parcel.aggregate({ where: { createdAt: range, status: { notIn: NOT_BOOKED } }, _count: { _all: true }, _sum: { codAmount: true, totalCharge: true } }),
        p.parcel.count({ where: { status: "DELIVERED", deliveredAt: range } }),
        p.merchant.count({ where: { createdAt: range } }),
        p.auditLog.count({ where: { action: "merchant.approve", createdAt: range } }),
        p.parcel.groupBy({ by: ["merchantId"], where: { merchantId: { not: null }, createdAt: range, status: { notIn: NOT_BOOKED } } }),
        p.auditLog.count({ where: { createdAt: range, actorType: "USER" } }),
      ]);
      const cod = Number(booked._sum.codAmount ?? 0);
      const charges = Number(booked._sum.totalCharge ?? 0);
      return { bookings: booked._count._all, cod, charges, gmv: cod + charges, delivered, newMerchants, approvedMerchants: approved, activeMerchants: activeMerchants.length, auditEvents };
    };
    const [current, previous, rows, byMerchant, delivered, pickedUp] = await Promise.all([
      figures(period),
      figures(period.previous),
      p.$queryRaw<{ key: string; n: number }[]>`
        SELECT to_char("createdAt" + interval '6 hours', ${buckets.format}) AS key, count(*)::int AS n
        FROM parcels
        WHERE "createdAt" >= ${period.previous.start.toISOString()}::timestamp AND "createdAt" < ${period.end.toISOString()}::timestamp AND status <> 'PICKUP_CANCELLED'
        GROUP BY 1`,
      p.parcel.groupBy({ by: ["merchantId"], where: { merchantId: { not: null }, createdAt: { gte: period.start, lt: period.end }, status: { notIn: NOT_BOOKED } }, _count: { _all: true } }),
      p.parcel.groupBy({ by: ["deliveryRiderId"], where: { deliveryRiderId: { not: null }, deliveredAt: { gte: period.start, lt: period.end } }, _count: { _all: true } }),
      p.parcel.groupBy({ by: ["pickupRiderId"], where: { pickupRiderId: { not: null }, pickedUpAt: { gte: period.start, lt: period.end } }, _count: { _all: true } }),
    ]);
    const riders = new Map<string, { riderId: string; delivered: number; pickedUp: number }>();
    const rider = (id: string) => riders.get(id) ?? riders.set(id, { riderId: id, delivered: 0, pickedUp: 0 }).get(id)!;
    for (const r of delivered) rider(r.deliveryRiderId!).delivered = r._count._all;
    for (const r of pickedUp) rider(r.pickupRiderId!).pickedUp = r._count._all;
    return {
      ...periodView(period),
      ...current,
      previous,
      series: { bucket: period.bucket, labels: buckets.labels, keys: buckets.keys, ...fillSeries(buckets, new Map(rows.map(r => [r.key, r.n]))) },
      merchants: byMerchant.map(r => ({ merchantId: r.merchantId!, parcels: r._count._all })),
      riders: [...riders.values()],
    };
  }
}
