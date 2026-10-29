import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import type { z } from "zod";
import { PARCEL_STATUS_LABEL, SERVICE_LEVEL_LABEL, type ParcelStatus } from "@paira-express/shared";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { RealtimeService } from "../../common/realtime.service";
import { QueueService } from "../../common/queues";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { conflict, forbidden, notFound } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import { env, runsJobs } from "../../config/env";
import { Prisma, type ServiceLevel, type SlaLeg, type SlaLevel, type SlaPolicy, type SlaState } from "../../generated/prisma/client";
import { NotifyService } from "../notifications/notify.service";
import { OutboxService } from "../notifications/outbox.service";
import { dhakaDateRange, opsHubScope } from "../parcels/ops-scope";
import { assertHubInScope } from "../ops/ops-common";
import { DEFAULT_SLA, policyScore } from "./sla-policy";
import type { acknowledgeSchema, listAlertsQuerySchema, listPoliciesQuerySchema, slaPolicySchema, slaReportQuerySchema, updateSlaPolicySchema } from "./sla.schemas";

const PICKUP_OPEN: ParcelStatus[] = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];
const DELIVERY_OPEN: ParcelStatus[] = ["PICKED_UP", "AT_HUB", "ASSIGNED", "IN_TRANSIT", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "EXCEPTION"];
/** Parcels due within this window (or already flagged) are checked on each run. */
const LOOKAHEAD_MS = 24 * 3600_000;
const BATCH = 2000;

const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`;
const rate = (num: number, den: number) => (den ? Math.round((num / den) * 1000) / 10 : null);

/**
 * SLA engine: due dates come from policies at booking (sla-policy.ts); a pg-boss job every
 * five minutes flags parcels at risk / breached, raises alerts, escalates new breaches to
 * operations (ops.sla_breach) and resolves alerts when the leg completes.
 */
@Injectable()
export class SlaService implements OnApplicationBootstrap {
  private readonly logger = new Logger("Sla");

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly queues: QueueService,
    private readonly notify: NotifyService,
    private readonly outbox: OutboxService,
  ) {}

  onApplicationBootstrap() {
    if (!runsJobs()) return;
    void this.queues
      .schedule("sla-monitor", "*/5 * * * *", async () => {
        const result = await this.monitor();
        if (result.newAlerts || result.resolved) this.logger.log(`SLA monitor: ${result.newAlerts} new alerts, ${result.resolved} resolved, ${result.escalated} escalations`);
      })
      .catch(err => this.logger.error({ err }, "Could not schedule the SLA monitor"));
  }

  // ───────────── policies ─────────────

  async listPolicies(query: z.infer<typeof listPoliciesQuerySchema>) {
    const rows = await this.prisma.slaPolicy.findMany({ where: { active: query.active }, ...pageArgs(query) });
    return { ...toPage(rows, query.limit), defaults: DEFAULT_SLA };
  }

  async createPolicy(actor: Actor, input: z.infer<typeof slaPolicySchema>, meta: RequestMeta) {
    return this.prisma.$transaction(async tx => {
      const policy = await tx.slaPolicy.create({ data: { ...input, createdById: actor.kind === "user" ? actor.userId : null } });
      await this.audit.record(actor, { action: "sla.policy_create", entityType: "sla_policy", entityId: policy.id, data: input }, meta, tx);
      return policy;
    });
  }

  async updatePolicy(actor: Actor, id: string, input: z.infer<typeof updateSlaPolicySchema>, meta: RequestMeta) {
    if (!(await this.prisma.slaPolicy.findUnique({ where: { id } }))) throw notFound("SLA policy");
    return this.prisma.$transaction(async tx => {
      const policy = await tx.slaPolicy.update({ where: { id }, data: input });
      await this.audit.record(actor, { action: "sla.policy_update", entityType: "sla_policy", entityId: id, data: input }, meta, tx);
      return policy;
    });
  }

  async deletePolicy(actor: Actor, id: string, meta: RequestMeta) {
    const policy = await this.prisma.slaPolicy.findUnique({ where: { id } });
    if (!policy) throw notFound("SLA policy");
    await this.prisma.$transaction(async tx => {
      await tx.slaPolicy.delete({ where: { id } });
      await this.audit.record(actor, { action: "sla.policy_delete", entityType: "sla_policy", entityId: id, data: { name: policy.name } }, meta, tx);
    });
    return { deleted: true };
  }

  // ───────────── monitor ─────────────

  /** One pass of the SLA engine. Safe to run concurrently with bookings and status changes. */
  async monitor(now = new Date()) {
    const policies = await this.prisma.slaPolicy.findMany({ where: { active: true } });
    const horizon = new Date(now.getTime() + LOOKAHEAD_MS);
    const select = {
      id: true,
      trackingId: true,
      status: true,
      serviceLevel: true,
      pickupDistrict: true,
      pickupZone: true,
      deliveryDistrict: true,
      deliveryZone: true,
      pickupDueAt: true,
      deliveryDueAt: true,
      slaState: true,
      currentHubId: true,
    } satisfies Prisma.ParcelSelect;
    const candidates = await this.prisma.parcel.findMany({
      where: {
        OR: [
          { status: { in: PICKUP_OPEN }, pickupDueAt: { lt: horizon } },
          { status: { in: DELIVERY_OPEN }, deliveryDueAt: { lt: horizon } },
          { status: { in: [...PICKUP_OPEN, ...DELIVERY_OPEN] }, slaState: { not: "ON_TRACK" } },
        ],
      },
      select,
      orderBy: { id: "asc" },
      take: BATCH * 5,
    });

    const states = new Map<SlaState, string[]>();
    const flagged: { parcelId: string; leg: SlaLeg; level: SlaLevel; dueAt: Date; hubId: string | null; trackingId: string }[] = [];
    for (const p of candidates) {
      const leg: SlaLeg = PICKUP_OPEN.includes(p.status as ParcelStatus) ? "PICKUP" : "DELIVERY";
      const due = leg === "PICKUP" ? p.pickupDueAt : p.deliveryDueAt;
      let state: SlaState = "ON_TRACK";
      if (due) {
        // Incomplete orders (no destination yet) use the pickup area's policy.
        const atRisk = this.atRiskMinutes(policies, { ...p, deliveryDistrict: p.deliveryDistrict ?? p.pickupDistrict, deliveryZone: p.deliveryZone ?? p.pickupZone });
        state = now > due ? "BREACHED" : now.getTime() > due.getTime() - atRisk * 60_000 ? "AT_RISK" : "ON_TRACK";
      }
      if (state !== p.slaState) states.set(state, [...(states.get(state) ?? []), p.id]);
      if (state !== "ON_TRACK" && due) flagged.push({ parcelId: p.id, leg, level: state === "BREACHED" ? "BREACHED" : "AT_RISK", dueAt: due, hubId: p.currentHubId, trackingId: p.trackingId });
    }
    for (const [state, ids] of states) await this.prisma.parcel.updateMany({ where: { id: { in: ids } }, data: { slaState: state } });

    // New alerts (one per parcel, leg and level).
    const existing = flagged.length
      ? await this.prisma.slaAlert.findMany({ where: { parcelId: { in: flagged.map(f => f.parcelId) } }, select: { parcelId: true, leg: true, level: true } })
      : [];
    const fresh = flagged.filter(f => !existing.some(e => e.parcelId === f.parcelId && e.leg === f.leg && e.level === f.level));
    if (fresh.length)
      await this.prisma.slaAlert.createMany({ data: fresh.map(({ trackingId: _t, ...a }) => ({ ...a, raisedAt: now })), skipDuplicates: true });

    // Alerts whose leg is done (picked up / delivered / closed) are resolved.
    const resolved = await this.prisma.$executeRaw`
      UPDATE sla_alerts a SET "resolvedAt" = ${ts(now)}
      FROM parcels p
      WHERE a."parcelId" = p.id AND a."resolvedAt" IS NULL
        AND ((a.leg = 'PICKUP' AND p.status NOT IN ('PENDING_CONFIRMATION', 'PICKUP_ASSIGNED', 'PICKUP_CONFIRMED'))
          OR (a.leg = 'DELIVERY' AND p.status IN ('DELIVERED', 'RETURN_SCHEDULED', 'RETURNED', 'PICKUP_CANCELLED')))`;

    const breaches = fresh.filter(f => f.level === "BREACHED");
    const escalated = breaches.length ? await this.escalate(breaches) : 0;
    if (fresh.length || resolved || states.size) {
      const hubIds = [...new Set(flagged.map(f => f.hubId))];
      this.realtime.publish({ type: "sla.updated", data: { newAlerts: fresh.length, breached: breaches.length }, hubIds, staffPermission: "parcel:read:any" });
    }
    return {
      checked: candidates.length,
      atRisk: flagged.filter(f => f.level === "AT_RISK").length,
      breached: flagged.filter(f => f.level === "BREACHED").length,
      newAlerts: fresh.length,
      resolved,
      escalated,
    };
  }

  /** New breaches → ops.sla_breach to operations managers and each hub's operators, one message per hub. */
  private async escalate(breaches: { hubId: string | null; trackingId: string }[]) {
    const byHub = new Map<string | null, string[]>();
    for (const b of breaches) byHub.set(b.hubId, [...(byHub.get(b.hubId) ?? []), b.trackingId]);
    const hubIds = [...byHub.keys()].filter((h): h is string => !!h);
    const [hubs, staff] = await Promise.all([
      this.prisma.hub.findMany({ where: { id: { in: hubIds } }, select: { id: true, name: true } }),
      this.prisma.userRole.findMany({
        where: { OR: [{ role: "OPS_MANAGER" }, { role: "HUB_OPERATOR", hubId: { in: hubIds } }], user: { status: "ACTIVE" } },
        select: { role: true, hubId: true, userId: true },
      }),
    ]);
    const managers = [...new Set(staff.filter(s => s.role === "OPS_MANAGER").map(s => s.userId))];
    const link = `${env().APP_URL.replace(/\/$/, "")}/courier-operation`;
    const ids: string[] = [];
    let sent = 0;
    await this.prisma.$transaction(async tx => {
      for (const [hubId, trackingIds] of byHub) {
        const hub = hubs.find(h => h.id === hubId);
        const recipients = new Set([...managers, ...staff.filter(s => s.role === "HUB_OPERATOR" && s.hubId === hubId).map(s => s.userId)]);
        for (const userId of recipients) {
          ids.push(...(await this.notify.notify(tx, { event: "ops.sla_breach", to: { userId }, vars: { count: trackingIds.length, hub: hub?.name ?? null, link } })));
          sent++;
        }
        await this.audit.record("system", { action: "sla.escalate", entityType: "hub", entityId: hubId ?? undefined, data: { hub: hub?.name ?? null, parcels: trackingIds.slice(0, 50), count: trackingIds.length, recipients: recipients.size } }, undefined, tx);
      }
    });
    await this.outbox.flush(ids);
    return sent;
  }

  private atRiskMinutes(policies: SlaPolicy[], p: { serviceLevel: ServiceLevel; pickupDistrict: string; pickupZone: string; deliveryDistrict: string; deliveryZone: string }) {
    const best = policies
      .filter(x => x.serviceLevel === p.serviceLevel)
      .map(x => ({ x, score: policyScore(x, p) }))
      .filter(x => x.score >= 0)
      .sort((a, b) => b.score - a.score)[0]?.x;
    return best?.atRiskMinutes ?? DEFAULT_SLA[p.serviceLevel].atRisk;
  }

  // ───────────── alerts ─────────────

  async listAlerts(actor: Actor, query: z.infer<typeof listAlertsQuerySchema>) {
    const scope = opsHubScope(actor);
    if (scope && query.hubId && !scope.includes(query.hubId)) throw forbidden("You can only see your own hub's alerts");
    const rows = await this.prisma.slaAlert.findMany({
      where: {
        leg: query.leg,
        level: query.level,
        hubId: query.hubId ?? (scope ? { in: scope } : undefined),
        ...(query.open === undefined ? {} : { resolvedAt: query.open ? null : { not: null } }),
        ...(query.acknowledged === undefined ? {} : { acknowledgedAt: query.acknowledged ? { not: null } : null }),
      },
      include: {
        parcel: {
          select: {
            trackingId: true,
            status: true,
            serviceLevel: true,
            recipientName: true,
            deliveryZone: true,
            deliveryDistrict: true,
            pickupZone: true,
            currentHub: { select: { id: true, name: true } },
            deliveryRider: { select: { code: true, user: { select: { name: true } } } },
            pickupRider: { select: { code: true, user: { select: { name: true } } } },
          },
        },
      },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return {
      items: page.items.map(a => {
        const rider = a.leg === "PICKUP" ? a.parcel.pickupRider : a.parcel.deliveryRider;
        return {
          id: a.id,
          leg: a.leg,
          level: a.level,
          dueAt: a.dueAt,
          raisedAt: a.raisedAt,
          acknowledgedAt: a.acknowledgedAt,
          acknowledgedBy: a.acknowledgedBy,
          note: a.note,
          resolvedAt: a.resolvedAt,
          parcel: {
            trackingId: a.parcel.trackingId,
            status: a.parcel.status,
            statusLabel: PARCEL_STATUS_LABEL[a.parcel.status as ParcelStatus],
            serviceLevel: SERVICE_LEVEL_LABEL[a.parcel.serviceLevel],
            recipient: a.parcel.recipientName,
            zone: a.leg === "PICKUP" ? a.parcel.pickupZone : a.parcel.deliveryZone,
            district: a.parcel.deliveryDistrict,
            hub: a.parcel.currentHub,
            rider: rider ? `${rider.code} · ${rider.user.name}` : null,
          },
        };
      }),
      nextCursor: page.nextCursor,
    };
  }

  async acknowledge(actor: Actor, id: string, input: z.infer<typeof acknowledgeSchema>, meta: RequestMeta) {
    const alert = await this.prisma.slaAlert.findUnique({ where: { id }, include: { parcel: { select: { trackingId: true } } } });
    if (!alert) throw notFound("SLA alert");
    if (alert.hubId) assertHubInScope(actor, alert.hubId, "acknowledge this hub's alerts");
    if (alert.acknowledgedAt) throw conflict("ALREADY_ACKNOWLEDGED", `Already acknowledged by ${alert.acknowledgedBy ?? "someone"}`);
    const updated = await this.prisma.$transaction(async tx => {
      const row = await tx.slaAlert.update({
        where: { id },
        data: { acknowledgedAt: new Date(), acknowledgedById: actor.kind === "user" ? actor.userId : null, acknowledgedBy: actor.name, note: input.note },
      });
      await this.audit.record(actor, { action: "sla.alert_acknowledge", entityType: "sla_alert", entityId: id, data: { trackingId: alert.parcel.trackingId, leg: alert.leg, level: alert.level, note: input.note ?? null } }, meta, tx);
      return row;
    });
    this.realtime.publish({ type: "sla.updated", id: alert.parcel.trackingId, hubIds: [alert.hubId], staffPermission: "parcel:read:any" });
    return updated;
  }

  /** Open parcels by SLA state and unacknowledged alerts, for the console's counters. */
  async summary(actor: Actor) {
    const scope = opsHubScope(actor);
    const hubWhere = scope ? { currentHubId: { in: scope } } : {};
    const [byState, alerts] = await Promise.all([
      this.prisma.parcel.groupBy({ by: ["slaState"], where: { status: { in: [...PICKUP_OPEN, ...DELIVERY_OPEN] }, ...hubWhere }, _count: { _all: true } }),
      this.prisma.slaAlert.groupBy({ by: ["level"], where: { resolvedAt: null, acknowledgedAt: null, ...(scope ? { hubId: { in: scope } } : {}) }, _count: { _all: true } }),
    ]);
    const state = (s: SlaState) => byState.find(r => r.slaState === s)?._count._all ?? 0;
    const alert = (l: SlaLevel) => alerts.find(r => r.level === l)?._count._all ?? 0;
    return { onTrack: state("ON_TRACK"), atRisk: state("AT_RISK"), breached: state("BREACHED"), openAlerts: { atRisk: alert("AT_RISK"), breached: alert("BREACHED") } };
  }

  // ───────────── reporting ─────────────

  /** SLA attainment in a Dhaka date range: pickups and deliveries on time, by service level, zone, hub and day. */
  async report(actor: Actor, query: z.infer<typeof slaReportQuerySchema>) {
    const [start, end] = dhakaDateRange(query.from, query.to);
    const scope = opsHubScope(actor);
    if (scope && query.hubId && !scope.includes(query.hubId)) throw forbidden("You can only see your own hub's SLA");
    const hubs = query.hubId ? [query.hubId] : scope;
    const hubSql = hubs ? Prisma.sql`AND "currentHubId" IN (${Prisma.join(hubs.map(h => Prisma.sql`${h}::uuid`))})` : Prisma.empty;
    const delivered = Prisma.sql`status = 'DELIVERED' AND "deliveryDueAt" IS NOT NULL AND "deliveredAt" >= ${ts(start)} AND "deliveredAt" < ${ts(end)} ${hubSql}`;
    const [pickups, byLevel, byZone, byHub, byDay, alerts] = await Promise.all([
      this.prisma.$queryRaw<{ ok: number; n: number }[]>`
        SELECT count(*) FILTER (WHERE "pickedUpAt" <= "pickupDueAt")::int AS ok, count(*)::int AS n FROM parcels
        WHERE "pickupDueAt" IS NOT NULL AND "pickedUpAt" >= ${ts(start)} AND "pickedUpAt" < ${ts(end)} ${hubSql}`,
      this.prisma.$queryRaw<{ level: ServiceLevel; ok: number; n: number; late_minutes: number | null }[]>`
        SELECT "serviceLevel" AS level, count(*) FILTER (WHERE "deliveredAt" <= "deliveryDueAt")::int AS ok, count(*)::int AS n,
               (avg(EXTRACT(EPOCH FROM ("deliveredAt" - "deliveryDueAt")) / 60) FILTER (WHERE "deliveredAt" > "deliveryDueAt"))::float AS late_minutes
        FROM parcels WHERE ${delivered} GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<{ district: string; zone: string; ok: number; n: number }[]>`
        SELECT "deliveryDistrict" AS district, "deliveryZone" AS zone, count(*) FILTER (WHERE "deliveredAt" <= "deliveryDueAt")::int AS ok, count(*)::int AS n
        FROM parcels WHERE ${delivered} GROUP BY 1, 2 ORDER BY n DESC LIMIT 100`,
      this.prisma.$queryRaw<{ hub_id: string | null; ok: number; n: number }[]>`
        SELECT "currentHubId"::text AS hub_id, count(*) FILTER (WHERE "deliveredAt" <= "deliveryDueAt")::int AS ok, count(*)::int AS n
        FROM parcels WHERE ${delivered} GROUP BY 1`,
      this.prisma.$queryRaw<{ day: string; ok: number; n: number }[]>`
        SELECT to_char(("deliveredAt" + interval '6 hours')::date, 'YYYY-MM-DD') AS day,
               count(*) FILTER (WHERE "deliveredAt" <= "deliveryDueAt")::int AS ok, count(*)::int AS n
        FROM parcels WHERE ${delivered} GROUP BY 1 ORDER BY 1`,
      this.prisma.slaAlert.groupBy({
        by: ["leg", "level"],
        where: { raisedAt: { gte: start, lt: end }, ...(hubs ? { hubId: { in: hubs } } : {}) },
        _count: { _all: true },
      }),
    ]);
    const hubRows = await this.prisma.hub.findMany({ where: { id: { in: byHub.map(h => h.hub_id).filter((h): h is string => !!h) } }, select: { id: true, code: true, name: true } });
    const deliveredTotal = byLevel.reduce((n, r) => n + r.n, 0);
    const deliveredOk = byLevel.reduce((n, r) => n + r.ok, 0);
    return {
      from: query.from,
      to: query.to,
      pickups: { total: pickups[0].n, onTime: pickups[0].ok, late: pickups[0].n - pickups[0].ok, rate: rate(pickups[0].ok, pickups[0].n) },
      deliveries: { total: deliveredTotal, onTime: deliveredOk, late: deliveredTotal - deliveredOk, rate: rate(deliveredOk, deliveredTotal) },
      byServiceLevel: byLevel.map(r => ({ serviceLevel: r.level, label: SERVICE_LEVEL_LABEL[r.level], total: r.n, onTime: r.ok, rate: rate(r.ok, r.n), avgLateMinutes: r.late_minutes == null ? null : Math.round(r.late_minutes) })),
      byZone: byZone.map(r => ({ district: r.district, zone: r.zone, total: r.n, onTime: r.ok, late: r.n - r.ok, rate: rate(r.ok, r.n) })),
      byHub: byHub.map(r => ({ hub: hubRows.find(h => h.id === r.hub_id) ?? null, total: r.n, onTime: r.ok, rate: rate(r.ok, r.n) })),
      byDay: byDay.map(r => ({ day: r.day, total: r.n, onTime: r.ok, rate: rate(r.ok, r.n) })),
      alerts: {
        pickupAtRisk: alerts.find(a => a.leg === "PICKUP" && a.level === "AT_RISK")?._count._all ?? 0,
        pickupBreached: alerts.find(a => a.leg === "PICKUP" && a.level === "BREACHED")?._count._all ?? 0,
        deliveryAtRisk: alerts.find(a => a.leg === "DELIVERY" && a.level === "AT_RISK")?._count._all ?? 0,
        deliveryBreached: alerts.find(a => a.leg === "DELIVERY" && a.level === "BREACHED")?._count._all ?? 0,
      },
    };
  }
}
