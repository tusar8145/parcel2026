import { merchantPickupArea } from "../merchants/merchant-address";
import { addressText } from "../../common/address";
import { Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { createParcelSchema, PARCEL_STATUS_LABEL, PARCEL_STATUSES, SERVICE_LEVEL_LABEL, TERMINAL_STATUSES, type ParcelStatus, parseLastMile } from "@delivery-fast/shared";
import { PrismaService } from "../../common/prisma.service";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, forbidden, notFound } from "../../common/errors";
import { AuditService } from "../../common/audit.service";
import { Prisma } from "../../generated/prisma/client";
import { ParcelsService, type BookingOptions } from "../parcels/parcels.service";
import { addDays, dhakaDateRange, dhakaDayStart, dhakaMonthStart, opsHubScope } from "../parcels/ops-scope";
import { PricingService } from "../pricing/pricing.service";
import { PackagesService } from "../packages/packages.service";
import { zoneForArea } from "../parcels/places";
import { cashHubScope, isFinanceStaff } from "../finance/finance.scope";
import type { opsBookingSchema, riderReportQuerySchema, transfersQuerySchema } from "./ops.schemas";
import { NEEDS_PICKUP_RIDER } from "./ops-common";
import { periodView, resolvePeriod, type PeriodQuery } from "../../common/period";
import { periodMetricsWithPrevious } from "./period-metrics";

const ACTIVE_STATUSES = PARCEL_STATUSES.filter(s => !TERMINAL_STATUSES.includes(s));
const PICKUP_OPEN: ParcelStatus[] = ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];
const DELIVERY_OPEN: ParcelStatus[] = ["ASSIGNED", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "EXCEPTION"];
/** Waiting for operations to give it a rider: a pickup request, or a parcel at / heading to a hub. */
const UNASSIGNED_WHERE: Prisma.ParcelWhereInput = {
  OR: [NEEDS_PICKUP_RIDER, { status: { in: ["AT_HUB", "IN_TRANSIT"] }, deliveryRiderId: null }],
};
/** Promise-bearing statuses that count towards "SLA at risk" once the estimate has passed. */
const AT_RISK_STATUSES = ACTIVE_STATUSES.filter(s => s !== "PENDING_CONFIRMATION" && s !== "EXCEPTION");

type ServiceLine = "customer" | "ecommerce" | "documents";
const lineOf = (merchantType: string | null | undefined): ServiceLine =>
  merchantType === "ECOMMERCE" ? "ecommerce" : merchantType === "BANKING_FINANCIAL" ? "documents" : "customer";

/** Timestamps are stored as UTC `timestamp(3)`; compare against an explicit UTC literal. */
const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`;
const rate = (num: number, den: number) => (den ? Math.round((num / den) * 1000) / 10 : null);
const round1 = (n: number | null | undefined) => (n == null ? null : Math.round(Number(n) * 10) / 10);
const joinAddress = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(", ");
const riderLabel = (r: { code: string; user: { name: string } } | null | undefined) => (r ? `${r.code} · ${r.user.name}` : null);

@Injectable()
export class OpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly parcels: ParcelsService,
    private readonly pricing: PricingService,
    private readonly audit: AuditService,
  ) {}

  /** Service packages (global module; property injection keeps the constructor stable). */
  @Inject(PackagesService) private readonly packages!: PackagesService;

  // ───────────── live overview ─────────────

  /** Counters behind the command center, nav badges and alerts, computed in the database. */
  async overview(actor: Actor, query: PeriodQuery = {}) {
    const db = this.prisma;
    const now = new Date();
    const period = resolvePeriod(query, "today", now);
    const today = dhakaDayStart(now);
    const yesterday = addDays(today, -1);
    const month = dhakaMonthStart(now);
    const previousMonth = dhakaMonthStart(now, -1);
    const onTime = (from: Date, to?: Date) => {
      const where: Prisma.ParcelWhereInput = { status: "DELIVERED", deliveredAt: { gte: from, ...(to ? { lt: to } : {}) }, estimatedDeliveryAt: { not: null } };
      return Promise.all([
        db.parcel.count({ where }),
        db.parcel.count({ where: { ...where, AND: [{ deliveredAt: { lte: db.parcel.fields.estimatedDeliveryAt } }] } }),
      ]);
    };
    const hubScope = opsHubScope(actor);
    const seesCash = actor.permissions.has("cod:receive") || (actor.permissions.has("finance:read") && isFinanceStaff(actor));
    const cashScope = seesCash ? cashHubScope(actor) : [];

    const [
      byStatus,
      createdToday,
      createdYesterday,
      deliveredToday,
      deliveredYesterday,
      activeByMerchant,
      atRisk,
      unassigned,
      [monthDelivered, monthOnTime],
      [previousDelivered, previousOnTime],
      ridersByStatus,
      busyDelivery,
      busyPickup,
      hubs,
      hubLoad,
      inbound,
      outbound,
      exceptions,
      risky,
      cash,
      metrics,
    ] = await Promise.all([
      db.parcel.groupBy({ by: ["status"], _count: { _all: true } }),
      db.parcel.count({ where: { createdAt: { gte: today } } }),
      db.parcel.count({ where: { createdAt: { gte: yesterday, lt: today } } }),
      db.parcel.count({ where: { status: "DELIVERED", deliveredAt: { gte: today } } }),
      db.parcel.count({ where: { status: "DELIVERED", deliveredAt: { gte: yesterday, lt: today } } }),
      db.parcel.groupBy({ by: ["merchantId"], where: { status: { in: ACTIVE_STATUSES } }, _count: { _all: true } }),
      db.parcel.count({ where: { status: { in: AT_RISK_STATUSES }, estimatedDeliveryAt: { lt: now } } }),
      db.parcel.count({ where: UNASSIGNED_WHERE }),
      onTime(month),
      onTime(previousMonth, month),
      db.rider.groupBy({ by: ["status"], where: { active: true }, _count: { _all: true } }),
      db.parcel.groupBy({ by: ["deliveryRiderId"], where: { deliveryRiderId: { not: null }, status: { in: DELIVERY_OPEN } } }),
      db.parcel.groupBy({ by: ["pickupRiderId"], where: { pickupRiderId: { not: null }, status: { in: PICKUP_OPEN } } }),
      db.hub.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, code: true, name: true, district: true } }),
      db.parcel.groupBy({ by: ["currentHubId", "status"], where: { currentHubId: { not: null }, status: { in: ["AT_HUB", "IN_TRANSIT", "ASSIGNED"] } }, _count: { _all: true } }),
      // Arrivals today: AT_HUB events (hub id in metadata; older events only name the hub).
      db.$queryRaw<{ hub_id: string | null; n: number }[]>`
        SELECT COALESCE(e.metadata->>'hubId', h.id::text) AS hub_id, count(DISTINCT e."parcelId")::int AS n
        FROM tracking_events e LEFT JOIN hubs h ON h.name = e.location
        WHERE e."createdAt" >= ${ts(today)} AND e.visibility = 'PUBLIC' AND e.status = 'AT_HUB'
        GROUP BY 1`,
      // Departures today: assigned to a delivery rider from the hub, or transferred out.
      db.$queryRaw<{ hub_id: string | null; n: number }[]>`
        SELECT hub_id, count(DISTINCT parcel_id)::int AS n FROM (
          SELECT p."currentHubId"::text AS hub_id, e."parcelId" AS parcel_id
          FROM tracking_events e JOIN parcels p ON p.id = e."parcelId"
          WHERE e."createdAt" >= ${ts(today)} AND e.visibility = 'PUBLIC' AND e.status = 'ASSIGNED' AND p."currentHubId" IS NOT NULL
          UNION ALL
          SELECT e.metadata->>'fromHubId', e."parcelId"
          FROM tracking_events e
          WHERE e."createdAt" >= ${ts(today)} AND e.metadata->>'kind' = 'hub_transfer'
        ) moves GROUP BY hub_id`,
      db.parcel.findMany({
        where: { status: "EXCEPTION" },
        orderBy: { updatedAt: "desc" },
        take: 3,
        select: {
          trackingId: true,
          deliveryZone: true,
          updatedAt: true,
          deliveryRider: { select: { code: true, user: { select: { name: true } } } },
          pickupRider: { select: { code: true, user: { select: { name: true } } } },
          events: { where: { visibility: "PUBLIC" }, orderBy: { createdAt: "desc" }, take: 1, select: { description: true, createdAt: true } },
        },
      }),
      db.parcel.findMany({
        where: { status: { in: AT_RISK_STATUSES }, estimatedDeliveryAt: { lt: now } },
        orderBy: { estimatedDeliveryAt: "asc" },
        take: 2,
        select: { trackingId: true, deliveryZone: true, deliveryDistrict: true, estimatedDeliveryAt: true, deliveryRider: { select: { code: true, user: { select: { name: true } } } } },
      }),
      seesCash
        ? db.codCollection.aggregate({
            where: { state: "WITH_RIDER", ...(cashScope ? { rider: { hubId: { in: cashScope } } } : {}) },
            _sum: { amount: true },
            _count: { _all: true },
            _min: { collectedAt: true },
          })
        : null,
      periodMetricsWithPrevious(db, period),
    ]);

    const status = Object.fromEntries(PARCEL_STATUSES.map(s => [s, 0])) as Record<ParcelStatus, number>;
    for (const row of byStatus) status[row.status as ParcelStatus] = row._count._all;
    const merchantTypes = await this.merchantTypes(activeByMerchant.map(r => r.merchantId));
    const lines: Record<ServiceLine, number> = { customer: 0, ecommerce: 0, documents: 0 };
    for (const r of activeByMerchant) lines[lineOf(r.merchantId ? merchantTypes.get(r.merchantId) : null)] += r._count._all;
    const riders = { online: 0, onBreak: 0, offline: 0 };
    for (const r of ridersByStatus) riders[r.status === "ONLINE" ? "online" : r.status === "ON_BREAK" ? "onBreak" : "offline"] += r._count._all;
    const busy = new Set([...busyDelivery.map(r => r.deliveryRiderId), ...busyPickup.map(r => r.pickupRiderId)]);

    const countFor = (rows: { hub_id: string | null; n: number }[], hubId: string) => rows.filter(r => r.hub_id === hubId).reduce((n, r) => n + r.n, 0);
    const hubRows = hubs.map(h => {
      const load = (s: ParcelStatus) => hubLoad.find(r => r.currentHubId === h.id && r.status === s)?._count._all ?? 0;
      return { ...h, atHub: load("AT_HUB"), inbound: load("IN_TRANSIT"), awaitingDispatch: load("ASSIGNED"), inboundToday: countFor(inbound, h.id), outboundToday: countFor(outbound, h.id) };
    });

    const alerts: {
      kind: string;
      tone: "red" | "amber";
      icon: string;
      title: string;
      text: string;
      meta: string;
      at: Date | null;
      action: { exception?: string; page?: string; label: string };
    }[] = [];
    for (const p of exceptions.slice(0, 2)) {
      alerts.push({
        kind: "exception",
        tone: "red",
        icon: "alert",
        title: `Delivery exception · ${p.trackingId}`,
        text: p.events[0]?.description || `Needs operations review in ${p.deliveryZone ?? "an area still to be confirmed"}.`,
        meta: riderLabel(p.deliveryRider ?? p.pickupRider) ? `Assigned to ${riderLabel(p.deliveryRider ?? p.pickupRider)}` : "No rider assigned",
        at: p.events[0]?.createdAt ?? p.updatedAt,
        action: { exception: p.trackingId, label: "Review" },
      });
    }
    for (const p of risky.slice(0, alerts.length < 2 ? 2 : 1)) {
      alerts.push({
        kind: "sla",
        tone: "amber",
        icon: "clock",
        title: `SLA at risk · ${p.trackingId}`,
        text: `${joinAddress(p.deliveryZone, p.deliveryDistrict)} delivery is past its promised time.`,
        meta: riderLabel(p.deliveryRider) ? `Assigned to ${riderLabel(p.deliveryRider)}` : "No delivery rider yet",
        at: p.estimatedDeliveryAt,
        action: { exception: p.trackingId, label: "Review" },
      });
    }
    const backlog = [...hubRows].sort((a, b) => b.atHub - a.atHub)[0];
    if (backlog?.atHub) {
      alerts.push({
        kind: "hub",
        tone: "amber",
        icon: "box",
        title: `Hub backlog · ${backlog.name}`,
        text: `${backlog.atHub} parcel${backlog.atHub === 1 ? "" : "s"} waiting at the hub for a delivery rider.`,
        meta: `${backlog.inboundToday} received today · ${backlog.outboundToday} dispatched`,
        at: null,
        action: { page: "Hubs", label: "Hub" },
      });
    }
    if (cash && Number(cash._sum.amount ?? 0) > 0) {
      alerts.push({
        kind: "cod",
        tone: "amber",
        icon: "wallet",
        title: "COD with riders",
        text: ` ৳${Number(cash._sum.amount).toLocaleString("en-BD")} in ${cash._count._all} collection${cash._count._all === 1 ? "" : "s"} not yet handed to a hub.`,
        meta: "Oldest collected",
        at: cash._min.collectedAt,
        action: { page: "COD & finance", label: "Review" },
      });
    }

    const active = ACTIVE_STATUSES.reduce((n, s) => n + status[s], 0);
    return {
      generatedAt: now,
      me: this.me(actor, hubScope, hubs),
      shipments: {
        active,
        createdToday,
        createdYesterday,
        deliveredToday,
        deliveredYesterday,
        byStatus: status,
        unassigned,
        atRisk,
        exceptions: status.EXCEPTION,
        atHub: status.AT_HUB,
        inTransit: status.IN_TRANSIT,
        outForDelivery: status.OUT_FOR_DELIVERY,
        assigned: status.ASSIGNED,
        pendingConfirmation: status.PENDING_CONFIRMATION,
      },
      serviceLines: lines,
      onTime: {
        monthRate: rate(monthOnTime, monthDelivered),
        monthDelivered,
        previousMonthRate: rate(previousOnTime, previousDelivered),
      },
      riders: { ...riders, total: riders.online + riders.onBreak + riders.offline, withOpenTasks: busy.size },
      hubs: hubRows,
      cash: cash ? { withRiders: Number(cash._sum.amount ?? 0), collections: cash._count._all, oldestCollectedAt: cash._min.collectedAt } : null,
      alerts: alerts.slice(0, 4),
      /** What happened in the period (from / to; default today), network wide. The fields above are live "now" counts. */
      period: periodView(period),
      metrics,
    };
  }

  private me(actor: Actor, hubScope: string[] | null, hubs: { id: string; name: string }[]) {
    const can = (p: Parameters<Actor["permissions"]["has"]>[0]) => actor.permissions.has(p);
    return {
      roles: actor.kind === "user" ? [...new Set(actor.roles.map(r => r.role))] : [],
      hubIds: hubScope,
      hubs: hubScope ? hubs.filter(h => hubScope.includes(h.id)) : null,
      can: {
        dispatch: can("parcel:dispatch"),
        manageHubs: can("hub:manage"),
        manageRiders: can("rider:manage"),
        readRiders: can("rider:read"),
        receiveCash: can("cod:receive"),
        financeStaff: can("finance:read") && isFinanceStaff(actor),
        manageFinance: can("finance:manage"),
        manageConfig: can("config:manage"),
        /** Change merchant addresses and approve merchants' own address changes (the merchant's hub follows). */
        merchantAddress: can("merchant:address"),
        /** "Log in as" a merchant member or rider (Merchants / Riders lists); full access only with user:impersonate. */
        loginAs: actor.kind === "user" && !actor.impersonation && (can("user:impersonate") || can("user:login-as")),
        loginAsFull: actor.kind === "user" && !actor.impersonation && can("user:impersonate"),
      },
    };
  }

  private async merchantTypes(ids: (string | null)[]) {
    const wanted = ids.filter((id): id is string => !!id);
    if (!wanted.length) return new Map<string, string>();
    const rows = await this.prisma.merchant.findMany({ where: { id: { in: wanted } }, select: { id: true, type: true } });
    return new Map(rows.map(m => [m.id, m.type as string]));
  }

  // ───────────── dispatch ─────────────

  /** Assignment queue size and each rider's workload today (hub operators: their hub's riders). */
  async dispatch(actor: Actor) {
    const db = this.prisma;
    const now = new Date();
    const today = dhakaDayStart(now);
    const scope = opsHubScope(actor);
    const riders = await db.rider.findMany({
      where: { active: true, ...(scope ? { hubId: { in: scope } } : {}) },
      include: { user: { select: { name: true } }, hub: { select: { id: true, code: true, name: true } } },
      orderBy: { code: "asc" },
    });
    const ids = riders.map(r => r.id);
    const hubFilter: Prisma.ParcelWhereInput = scope ? { currentHubId: { in: scope } } : {};
    const [open, pickups, done, failed, overdue, readyAtHub, pendingPickup, urgent] = await Promise.all([
      db.parcel.groupBy({ by: ["deliveryRiderId", "status"], where: { deliveryRiderId: { in: ids }, status: { in: DELIVERY_OPEN } }, _count: { _all: true } }),
      db.parcel.groupBy({ by: ["pickupRiderId"], where: { pickupRiderId: { in: ids }, status: { in: PICKUP_OPEN } }, _count: { _all: true } }),
      db.parcel.groupBy({ by: ["deliveryRiderId"], where: { deliveryRiderId: { in: ids }, status: "DELIVERED", deliveredAt: { gte: today } }, _count: { _all: true } }),
      db.deliveryAttempt.groupBy({ by: ["riderId"], where: { riderId: { in: ids }, outcome: "FAILED", createdAt: { gte: today } }, _count: { _all: true } }),
      db.parcel.groupBy({ by: ["deliveryRiderId"], where: { deliveryRiderId: { in: ids }, status: { in: DELIVERY_OPEN }, estimatedDeliveryAt: { lt: now } }, _count: { _all: true } }),
      db.parcel.count({ where: { status: { in: ["AT_HUB", "IN_TRANSIT"] }, deliveryRiderId: null, ...hubFilter } }),
      db.parcel.count({ where: NEEDS_PICKUP_RIDER }),
      db.parcel.count({
        where: {
          AND: [
            scope ? { OR: [NEEDS_PICKUP_RIDER, { status: { in: ["AT_HUB", "IN_TRANSIT"] }, deliveryRiderId: null, ...hubFilter }] } : UNASSIGNED_WHERE,
            { OR: [{ onDemand: true }, { serviceLevel: { in: ["SAME_DAY", "EXPRESS"] } }, { estimatedDeliveryAt: { lt: now } }] },
          ],
        },
      }),
    ]);
    const count = <T extends { _count: { _all: number } }>(rows: T[], match: (r: T) => boolean) => rows.filter(match).reduce((n, r) => n + r._count._all, 0);
    const roster = riders.map(r => {
      const openDeliveries = count(open, x => x.deliveryRiderId === r.id);
      const exceptions = count(open, x => x.deliveryRiderId === r.id && x.status === "EXCEPTION");
      const openPickups = count(pickups, x => x.pickupRiderId === r.id);
      const completed = count(done, x => x.deliveryRiderId === r.id);
      const failedToday = count(failed, x => x.riderId === r.id);
      const late = count(overdue, x => x.deliveryRiderId === r.id);
      const remaining = openDeliveries + openPickups;
      const health = exceptions || failedToday ? "Issue" : late ? "At risk" : remaining ? "On track" : r.status === "ONLINE" ? "Available" : r.status === "ON_BREAK" ? "On break" : "Offline";
      return {
        rider: { id: r.id, code: r.code, name: r.user.name, label: `${r.code} · ${r.user.name}`, zone: r.zone, status: r.status, hub: r.hub },
        assignedToday: remaining + completed + failedToday,
        completed,
        failed: failedToday,
        remaining,
        openPickups,
        openDeliveries,
        overdue: late,
        health,
      };
    });
    const routes = roster.filter(r => r.remaining > 0);
    return {
      unassigned: { total: readyAtHub + pendingPickup, readyAtHub, pendingPickup, urgent },
      riders: { onShift: riders.filter(r => r.status === "ONLINE").length, available: roster.filter(r => r.rider.status === "ONLINE" && r.remaining === 0).length, total: riders.length },
      routesActive: routes.length,
      routesNeedReview: roster.filter(r => r.health === "Issue" || r.health === "At risk").length,
      avgStopsPerRoute: routes.length ? round1(routes.reduce((n, r) => n + r.assignedToday, 0) / routes.length) : 0,
      roster: roster.sort((a, b) => b.remaining - a.remaining || b.assignedToday - a.assignedToday || a.rider.code.localeCompare(b.rider.code)),
    };
  }

  // ───────────── analytics ─────────────

  /** Service-level metrics for today, this month and last month. */
  async analytics(query: PeriodQuery = {}) {
    const now = new Date();
    const chosen = resolvePeriod(query, "today", now);
    const periods = {
      today: [dhakaDayStart(now), now],
      month: [dhakaMonthStart(now), now],
      previousMonth: [dhakaMonthStart(now, -1), dhakaMonthStart(now)],
      period: [chosen.start, chosen.end < now ? chosen.end : now],
    } as const;
    const entries = await Promise.all(Object.entries(periods).map(async ([key, [from, to]]) => [key, await this.slaMetrics(from, to)] as const));
    const by = Object.fromEntries(entries) as Record<keyof typeof periods, Awaited<ReturnType<OpsService["slaMetrics"]>>>;
    const row = (key: keyof (typeof by)["today"], label: string, target: number, unit: "%" | "hrs", better: "higher" | "lower") => ({
      key,
      label,
      target,
      unit,
      better,
      today: by.today[key],
      month: by.month[key],
      previousMonth: by.previousMonth[key],
      /** The chosen period (from / to; default today). */
      period: by.period[key],
    });
    return {
      generatedAt: now,
      rows: [
        row("onTimeRate", "On-time delivery", 95, "%", "higher"),
        row("firstAttemptRate", "First-attempt success", 92, "%", "higher"),
        row("returnRate", "Return rate", 5, "%", "lower"),
        row("pickupHours", "Average first-mile pickup", 4, "hrs", "lower"),
        row("exceptionHours", "Exception resolution", 24, "hrs", "lower"),
      ],
      samples: { today: by.today.samples, month: by.month.samples, previousMonth: by.previousMonth.samples, period: by.period.samples },
      period: periodView(chosen),
    };
  }

  private async slaMetrics(from: Date, to: Date) {
    const db = this.prisma;
    const [[onTime], [firstAttempt], [returns], [pickup], [exceptions]] = await Promise.all([
      db.$queryRaw<{ ok: number; n: number }[]>`
        SELECT count(*) FILTER (WHERE "deliveredAt" <= "estimatedDeliveryAt")::int AS ok, count(*)::int AS n
        FROM parcels WHERE status = 'DELIVERED' AND "estimatedDeliveryAt" IS NOT NULL AND "deliveredAt" >= ${ts(from)} AND "deliveredAt" < ${ts(to)}`,
      db.$queryRaw<{ ok: number; n: number }[]>`
        SELECT count(*) FILTER (WHERE outcome = 'DELIVERED')::int AS ok, count(*)::int AS n FROM (
          SELECT DISTINCT ON ("parcelId") outcome, "createdAt" FROM delivery_attempts ORDER BY "parcelId", "createdAt"
        ) first_attempts WHERE "createdAt" >= ${ts(from)} AND "createdAt" < ${ts(to)}`,
      db.$queryRaw<{ returned: number; n: number }[]>`
        SELECT count(*) FILTER (WHERE status = 'RETURNED')::int AS returned, count(*)::int AS n
        FROM parcels WHERE status IN ('DELIVERED', 'RETURNED') AND COALESCE("deliveredAt", "updatedAt") >= ${ts(from)} AND COALESCE("deliveredAt", "updatedAt") < ${ts(to)}`,
      db.$queryRaw<{ hours: number | null; n: number }[]>`
        SELECT (avg(EXTRACT(EPOCH FROM ("pickedUpAt" - "createdAt"))) / 3600)::float AS hours, count(*)::int AS n
        FROM parcels WHERE "pickedUpAt" >= ${ts(from)} AND "pickedUpAt" < ${ts(to)}`,
      // Time from a parcel entering EXCEPTION to its next status change.
      db.$queryRaw<{ hours: number | null; n: number }[]>`
        SELECT (avg(EXTRACT(EPOCH FROM (resolved_at - raised_at))) / 3600)::float AS hours, count(*)::int AS n FROM (
          SELECT status, "createdAt" AS raised_at,
                 LEAD("createdAt") OVER w AS resolved_at, LEAD(status) OVER w AS next_status
          FROM tracking_events
          WHERE visibility = 'PUBLIC' AND "parcelId" IN (SELECT "parcelId" FROM tracking_events WHERE status = 'EXCEPTION')
          WINDOW w AS (PARTITION BY "parcelId" ORDER BY "createdAt")
        ) changes
        WHERE status = 'EXCEPTION' AND next_status IS NOT NULL AND next_status <> 'EXCEPTION'
          AND resolved_at >= ${ts(from)} AND resolved_at < ${ts(to)}`,
    ]);
    return {
      onTimeRate: rate(onTime.ok, onTime.n),
      firstAttemptRate: rate(firstAttempt.ok, firstAttempt.n),
      returnRate: rate(returns.returned, returns.n),
      pickupHours: pickup.n ? round1(pickup.hours) : null,
      exceptionHours: exceptions.n ? round1(exceptions.hours) : null,
      samples: { delivered: onTime.n, firstAttempts: firstAttempt.n, closed: returns.n, pickups: pickup.n, exceptionsResolved: exceptions.n },
    };
  }

  // ───────────── riders & hubs ─────────────

  /** Parcels each rider handled (by pickup date, else booking date) in a Dhaka date range, for run sheets. */
  async riderReport(actor: Actor, query: z.infer<typeof riderReportQuerySchema>) {
    const [start, end] = dhakaDateRange(query.from, query.to);
    const scope = opsHubScope(actor);
    const riders = await this.prisma.rider.findMany({
      where: { ...(query.riderId ? { id: query.riderId } : { active: true }), ...(scope ? { hubId: { in: scope } } : {}) },
      include: { user: { select: { name: true } }, hub: { select: { id: true, code: true, name: true } } },
      orderBy: { code: "asc" },
    });
    const ids = riders.map(r => r.id);
    const parcels = ids.length
      ? await this.prisma.parcel.findMany({
          where: {
            AND: [
              { OR: [{ pickupRiderId: { in: ids } }, { deliveryRiderId: { in: ids } }] },
              { OR: [{ pickedUpAt: { gte: start, lt: end } }, { pickedUpAt: null, createdAt: { gte: start, lt: end } }] },
            ],
          },
          include: { merchant: { select: { name: true, type: true } } },
          orderBy: { createdAt: "asc" },
          take: 5000,
        })
      : [];
    const openTasks = await this.prisma.parcel.groupBy({
      by: ["deliveryRiderId"],
      where: { deliveryRiderId: { in: ids }, status: { in: DELIVERY_OPEN } },
      _count: { _all: true },
    });
    return {
      from: query.from,
      to: query.to,
      riders: riders.map(r => {
        const mine = parcels.filter(p => p.pickupRiderId === r.id || p.deliveryRiderId === r.id);
        const counts: Record<string, number> = {};
        for (const p of mine) counts[PARCEL_STATUS_LABEL[p.status as ParcelStatus]] = (counts[PARCEL_STATUS_LABEL[p.status as ParcelStatus]] ?? 0) + 1;
        return {
          id: r.id,
          code: r.code,
          name: r.user.name,
          zone: r.zone,
          vehicle: r.vehicle,
          status: r.status,
          active: r.active,
          hub: r.hub,
          openDeliveries: openTasks.find(t => t.deliveryRiderId === r.id)?._count._all ?? 0,
          picked: mine.filter(p => p.pickupRiderId === r.id && p.pickedUpAt).length,
          counts,
          records: mine.map(p => ({
            trackingId: p.trackingId,
            role: p.deliveryRiderId === r.id ? "delivery" : "pickup",
            merchant: p.merchant?.name ?? p.senderName,
            recipient: p.recipientName,
            destination: addressText(p.deliveryStreet, p.deliveryArea, p.deliveryZone, p.deliveryDistrict),
            service: p.merchant
              ? `${lineOf(p.merchant.type) === "documents" ? "Document" : "E-commerce"} · ${SERVICE_LEVEL_LABEL[p.serviceLevel]}`
              : `Customer parcel · ${SERVICE_LEVEL_LABEL[p.serviceLevel]}`,
            codAmount: Number(p.codAmount),
            status: PARCEL_STATUS_LABEL[p.status as ParcelStatus],
            pickedUpAt: p.pickedUpAt,
            createdAt: p.createdAt,
          })),
        };
      }),
    };
  }

  /** Hub-to-hub transfers in a Dhaka date range (hub operators: transfers in or out of their hub). */
  async transfers(actor: Actor, query: z.infer<typeof transfersQuerySchema>) {
    const [start, end] = dhakaDateRange(query.from, query.to);
    const scope = opsHubScope(actor);
    const events = await this.prisma.trackingEvent.findMany({
      where: { createdAt: { gte: start, lt: end }, metadata: { path: ["kind"], equals: "hub_transfer" } },
      orderBy: { createdAt: "desc" },
      take: 1000,
      select: {
        createdAt: true,
        metadata: true,
        actorLabel: true,
        parcel: {
          select: {
            trackingId: true,
            status: true,
            deliveryRider: { select: { code: true, user: { select: { name: true } } } },
            pickupRider: { select: { code: true, user: { select: { name: true } } } },
          },
        },
      },
    });
    return events
      .map(e => ({ e, m: (e.metadata ?? {}) as { fromHubId?: string; fromHub?: string; toHubId?: string; toHub?: string } }))
      .filter(({ m }) => !scope || scope.includes(m.fromHubId ?? "") || scope.includes(m.toHubId ?? ""))
      .map(({ e, m }) => ({
        trackingId: e.parcel.trackingId,
        fromHub: m.fromHub ?? "—",
        toHub: m.toHub ?? "—",
        fromHubId: m.fromHubId ?? null,
        toHubId: m.toHubId ?? null,
        at: e.createdAt,
        by: e.actorLabel,
        rider: riderLabel(e.parcel.deliveryRider ?? e.parcel.pickupRider),
        status: PARCEL_STATUS_LABEL[e.parcel.status as ParcelStatus],
      }));
  }

  // ───────────── merchants ─────────────

  /** Merchant accounts with this month's volume and the service package they book with. */
  async merchants() {
    const month = dhakaMonthStart();
    const [merchants, mtd, active, ecommerce, banking] = await Promise.all([
      this.prisma.merchant.findMany({ orderBy: { name: "asc" }, take: 1000, include: { pickupHub: { select: { id: true, code: true, name: true } } } }),
      this.prisma.parcel.groupBy({ by: ["merchantId"], where: { merchantId: { not: null }, createdAt: { gte: month } }, _count: { _all: true }, _sum: { codAmount: true } }),
      this.prisma.parcel.groupBy({ by: ["merchantId"], where: { merchantId: { not: null }, status: { in: ACTIVE_STATUSES } }, _count: { _all: true } }),
      this.packages.assignments("ECOMMERCE"),
      this.packages.assignments("BANKING_FINANCIAL"),
    ]);
    const packages = new Map([...ecommerce, ...banking].map(a => [a.merchant.id, a.package]));
    return merchants.map(m => {
      const month = mtd.find(r => r.merchantId === m.id);
      return {
        id: m.id,
        code: m.code,
        name: m.name,
        type: m.type,
        status: m.status,
        /** The service package's name (service packages replaced service plans). */
        plan: packages.get(m.id)?.name ?? null,
        package: packages.get(m.id) ?? null,
        contactName: m.contactName,
        contactPhone: m.contactPhone,
        pickupDistrict: m.pickupDistrict,
        pickupArea: m.pickupArea,
        /** Structured pickup (null zone: an older free-text address not completed yet). */
        pickupZone: m.pickupZone,
        pickupAddress: m.pickupAddress,
        pickupContactName: m.pickupContactName,
        pickupContactPhone: m.pickupContactPhone,
        pickupTime: m.pickupTime,
        handover: m.handover,
        pickupHub: m.pickupHub,
        parcelsThisMonth: month?._count._all ?? 0,
        codThisMonth: Number(month?._sum.codAmount ?? 0),
        activeParcels: active.find(r => r.merchantId === m.id)?._count._all ?? 0,
        createdAt: m.createdAt,
      };
    });
  }

  // ───────────── bookings by operations ─────────────

  /**
   * Books a parcel for a merchant (sender and pickup default to the merchant's profile) or a
   * walk-in sender. Drop-off bookings are priced from the drop-off hub's location (PricingService.hubOrigin)
   * and wait at PENDING_CONFIRMATION until the drop-off hub receives them.
   */
  async book(actor: Actor, raw: z.infer<typeof opsBookingSchema>, meta: RequestMeta) {
    const { merchantId, intake, dropOffHubId, ...rest } = raw as z.infer<typeof opsBookingSchema> & Record<string, unknown>;
    const dropOff = intake === "DROP_OFF" ? await this.dropOffHub(actor, dropOffHubId) : undefined;
    const body: Record<string, unknown> = { ...rest, saveAddresses: false };
    if (merchantId) {
      const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId } });
      if (!merchant) throw notFound("Merchant");
      // Sender and pickup default to the merchant's primary pickup location (contact, structured zone, pin).
      body.sender ??= { name: merchant.name, phone: merchant.pickupContactPhone ?? merchant.contactPhone };
      body.pickup ??= {
        category: "OFFICE",
        street: merchant.pickupAddress,
        area: merchant.pickupZone ? (merchantPickupArea(merchant) ?? undefined) : merchant.pickupArea,
        zone: merchant.pickupZone ?? (await this.zoneFor(merchant.pickupDistrict, merchant.pickupArea)),
        district: merchant.pickupDistrict,
        ...(merchant.pickupLat != null && merchant.pickupLng != null ? { lat: merchant.pickupLat, lng: merchant.pickupLng } : {}),
      };
    }
    // A walk-in sender dropping the parcel at a hub may leave the address out: the drop-off hub stands in for it
    // (the parcel starts there, and a return goes back there for the sender to collect).
    const pickup = body.pickup as { street?: string; zone?: string; district?: string } | undefined;
    if (!merchantId && dropOff && !pickup?.street?.trim()) {
      const hub = await this.prisma.hub.findUniqueOrThrow({ where: { id: dropOff.hub.id }, select: { name: true, address: true, zone: true, district: true } });
      body.pickup = { category: "OTHER", street: `Drop-off at ${hub.name}${hub.address ? `, ${hub.address}` : ""}`.slice(0, 200), zone: pickup?.zone || hub.zone || (await this.zoneFor(hub.district, hub.name)), district: pickup?.district || hub.district };
    }
    // Hub Pickup: the recipient comes to the hub serving their zone, so the street may be left out.
    const delivery = body.delivery as { street?: string } | undefined;
    if (delivery && !delivery.street?.trim() && parseLastMile(String(body.lastMile ?? "")) === "HUB_COLLECT") body.delivery = { ...delivery, street: "Collects at the hub" };
    const input = createParcelSchema.parse(body); // ZodError -> 422 VALIDATION_FAILED
    return this.parcels.create(actor, input, meta, { merchantId, dropOff });
  }

  /**
   * The hub a drop-off is brought to. Hub operators book drop-offs at their own hubs (their only
   * hub when none is chosen); operations managers choose one.
   */
  async dropOffHub(actor: Actor, hubId: string | undefined): Promise<NonNullable<BookingOptions["dropOff"]>> {
    const scope = opsHubScope(actor);
    const id = hubId ?? (scope?.length === 1 ? scope[0] : undefined);
    if (!id) throw new AppError("HUB_REQUIRED", "Choose the hub the sender will bring the parcels to", 422);
    if (scope && !scope.includes(id)) throw forbidden("You can only book drop-offs at your own hub");
    const hub = await this.prisma.hub.findUnique({ where: { id }, select: { id: true, name: true, address: true, active: true } });
    if (!hub) throw notFound("Hub");
    if (!hub.active) throw new AppError("HUB_INACTIVE", `${hub.name} isn't operating`, 422);
    return { hub: { id: hub.id, name: hub.name, address: hub.address } };
  }

  /**
   * The catalog zone a merchant's pickup area belongs to (pricing compares zones). The merchant's
   * address is an existing record: a deactivated zone is still found (and the booking then refuses it).
   */
  private async zoneFor(district: string, area: string) {
    return zoneForArea(await this.pricing.catalog(undefined, { includeInactive: true }), district, area);
  }
}
