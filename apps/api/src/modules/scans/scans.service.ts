import { Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { operationNow } from "../../common/operation-time";
import type { Actor } from "../../common/auth/actor";
import { forbidden, notFound } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import { Prisma, type ScanSource } from "../../generated/prisma/client";
import { dhakaDateRange, opsHubScope } from "../parcels/ops-scope";
import { codeVariants } from "../ops/ops-common";
import type { complianceQuerySchema, listScansQuerySchema, recordScanSchema, ScanKind } from "./scans.schemas";

export interface ScanInput {
  code: string;
  kind: ScanKind;
  hubId?: string | null;
  riderId?: string | null;
  userId?: string | null;
  source?: ScanSource;
  ok?: boolean;
  message?: string | null;
}

const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`;
const rate = (num: number, den: number) => (den ? Math.round((num / den) * 1000) / 10 : null);

/**
 * Every barcode scan (hub console, linehaul, CN stock, rider app). Compliance compares the
 * scans a parcel should have had (arrivals at a hub, rider pickups and deliveries) with
 * the scans actually recorded.
 */
@Injectable()
export class ScansService {
  constructor(private readonly prisma: PrismaService) {}

  /** Records a scan; resolves the parcel from the code when it is a tracking ID. Pass `db` inside a transaction. */
  async record(input: ScanInput, db: Db = this.prisma) {
    const variants = codeVariants(input.code);
    const parcel = await db.parcel.findFirst({ where: { trackingId: { in: variants } }, select: { id: true, trackingId: true } });
    return db.scanEvent.create({
      data: {
        code: variants[0].slice(0, 64),
        trackingId: parcel?.trackingId,
        parcelId: parcel?.id,
        kind: input.kind,
        hubId: input.hubId ?? null,
        riderId: input.riderId ?? null,
        userId: input.userId ?? null,
        source: input.source ?? "KEYBOARD",
        ok: input.ok ?? true,
        message: input.message?.slice(0, 300) ?? null,
        // A Scan desk entry dated earlier counts at that time (common/operation-time.ts).
        createdAt: operationNow(),
      },
    });
  }

  /** Never throws: for scans recorded after a refused action. */
  recordQuietly(input: ScanInput) {
    return this.record(input).catch(() => undefined);
  }

  /** POST /scans from the hub console or the rider app. */
  async recordFor(actor: Actor, body: z.infer<typeof recordScanSchema>) {
    if (actor.kind !== "user") throw forbidden();
    const staff = actor.permissions.has("parcel:read:any");
    const rider = !!actor.riderId && actor.permissions.has("parcel:rider-update");
    if (!staff && !rider) throw forbidden("Only operations staff and riders record scans");
    if (body.kind.startsWith("RIDER_") && !rider) throw forbidden("Rider scans come from the rider app");
    if (body.hubId) {
      if (!(await this.prisma.hub.findUnique({ where: { id: body.hubId }, select: { id: true } }))) throw notFound("Hub");
      const scope = staff ? opsHubScope(actor) : null;
      if (scope && !scope.includes(body.hubId)) throw forbidden("You can only record scans at your own hub");
    }
    const scan = await this.record({ ...body, riderId: rider ? actor.riderId : null, userId: actor.userId });
    return { id: scan.id, code: scan.code, trackingId: scan.trackingId, kind: scan.kind, ok: scan.ok, createdAt: scan.createdAt };
  }

  async list(actor: Actor, query: z.infer<typeof listScansQuerySchema>) {
    const scope = opsHubScope(actor);
    if (scope && query.hubId && !scope.includes(query.hubId)) throw forbidden("You can only see your own hub's scans");
    const range = query.from || query.to ? dhakaDateRange(query.from ?? "2000-01-01", query.to ?? "2999-12-31") : null;
    const where: Prisma.ScanEventWhereInput = {
      hubId: query.hubId ?? (scope ? { in: scope } : undefined),
      riderId: query.riderId,
      kind: query.kind,
      source: query.source,
      ...(range ? { createdAt: { gte: range[0], lt: range[1] } } : {}),
      ...(query.q ? { OR: [{ code: { contains: query.q.toUpperCase() } }, { trackingId: { contains: query.q.toUpperCase() } }] } : {}),
    };
    const rows = await this.prisma.scanEvent.findMany({ where, ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    const [hubs, users, riders] = await Promise.all([
      this.prisma.hub.findMany({ where: { id: { in: unique(page.items.map(s => s.hubId)) } }, select: { id: true, name: true, code: true } }),
      this.prisma.user.findMany({ where: { id: { in: unique(page.items.map(s => s.userId)) } }, select: { id: true, name: true } }),
      this.prisma.rider.findMany({ where: { id: { in: unique(page.items.map(s => s.riderId)) } }, select: { id: true, code: true } }),
    ]);
    return {
      items: page.items.map(s => ({
        ...s,
        hub: hubs.find(h => h.id === s.hubId) ?? null,
        by: users.find(u => u.id === s.userId)?.name ?? null,
        rider: riders.find(r => r.id === s.riderId)?.code ?? null,
      })),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Expected vs actual scans in a Dhaka date range. Hubs: every parcel that arrived at the hub
   * should have a scan at that hub. Riders: every pickup and delivery should have a rider scan.
   */
  async compliance(actor: Actor, query: z.infer<typeof complianceQuerySchema>) {
    const [start, end] = dhakaDateRange(query.from, query.to);
    const scope = opsHubScope(actor);
    if (scope && query.hubId && !scope.includes(query.hubId)) throw forbidden("You can only see your own hub's scans");
    const hubFilter = query.hubId ? [query.hubId] : scope;
    // Scans may happen shortly before the status change is recorded (or after, when catching up).
    const scanFrom = new Date(start.getTime() - 12 * 3600_000);
    const scanTo = new Date(end.getTime() + 12 * 3600_000);

    const hubRows = await this.prisma.$queryRaw<{ hub_id: string; expected: number; scanned: number; camera: number }[]>`
      WITH arrivals AS (
        SELECT DISTINCT COALESCE(e.metadata->>'hubId', h.id::text) AS hub_id, e."parcelId" AS parcel_id
        FROM tracking_events e LEFT JOIN hubs h ON h.name = e.location
        WHERE e."createdAt" >= ${ts(start)} AND e."createdAt" < ${ts(end)} AND e.status = 'AT_HUB' AND e.visibility = 'PUBLIC'
      )
      SELECT a.hub_id,
             count(*)::int AS expected,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM scan_events s WHERE s."parcelId" = a.parcel_id AND s."hubId"::text = a.hub_id AND s.ok
                 AND s."createdAt" >= ${ts(scanFrom)} AND s."createdAt" < ${ts(scanTo)}))::int AS scanned,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM scan_events s WHERE s."parcelId" = a.parcel_id AND s."hubId"::text = a.hub_id AND s.ok AND s.source = 'CAMERA'
                 AND s."createdAt" >= ${ts(scanFrom)} AND s."createdAt" < ${ts(scanTo)}))::int AS camera
      FROM arrivals a WHERE a.hub_id IS NOT NULL GROUP BY a.hub_id`;

    const riderRows = await this.prisma.$queryRaw<{ rider_id: string; leg: string; expected: number; scanned: number }[]>`
      WITH legs AS (
        SELECT "pickupRiderId" AS rider_id, id AS parcel_id, 'PICKUP' AS leg FROM parcels
          WHERE "pickupRiderId" IS NOT NULL AND "pickedUpAt" >= ${ts(start)} AND "pickedUpAt" < ${ts(end)}
        UNION ALL
        SELECT "deliveryRiderId", id, 'DELIVERY' FROM parcels
          WHERE "deliveryRiderId" IS NOT NULL AND status = 'DELIVERED' AND "deliveredAt" >= ${ts(start)} AND "deliveredAt" < ${ts(end)}
      )
      SELECT l.rider_id::text AS rider_id, l.leg, count(*)::int AS expected,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM scan_events s WHERE s."parcelId" = l.parcel_id AND s."riderId" = l.rider_id AND s.ok
                 AND s.kind = ANY (CASE WHEN l.leg = 'PICKUP' THEN ARRAY['RIDER_PICKUP'] ELSE ARRAY['RIDER_DELIVERY', 'RIDER_OUT_FOR_DELIVERY'] END)
                 AND s."createdAt" >= ${ts(scanFrom)} AND s."createdAt" < ${ts(scanTo)}))::int AS scanned
      FROM legs l GROUP BY l.rider_id, l.leg`;

    const [hubs, riders, totals] = await Promise.all([
      this.prisma.hub.findMany({ where: hubFilter ? { id: { in: hubFilter } } : { active: true }, select: { id: true, code: true, name: true }, orderBy: { name: "asc" } }),
      this.prisma.rider.findMany({
        where: { id: { in: unique(riderRows.map(r => r.rider_id)) }, ...(hubFilter ? { hubId: { in: hubFilter } } : {}) },
        select: { id: true, code: true, hub: { select: { id: true, name: true } }, user: { select: { name: true } } },
      }),
      this.prisma.scanEvent.groupBy({
        by: ["source", "ok"],
        where: { createdAt: { gte: start, lt: end }, ...(hubFilter ? { hubId: { in: hubFilter } } : {}) },
        _count: { _all: true },
      }),
    ]);

    const hubItems = hubs.map(h => {
      const row = hubRows.find(r => r.hub_id === h.id);
      const expected = row?.expected ?? 0;
      const scanned = row?.scanned ?? 0;
      return { hub: h, expected, scanned, missed: expected - scanned, camera: row?.camera ?? 0, compliance: rate(scanned, expected) };
    });
    const riderItems = riders
      .map(r => {
        const legs = riderRows.filter(x => x.rider_id === r.id);
        const pick = legs.find(l => l.leg === "PICKUP");
        const drop = legs.find(l => l.leg === "DELIVERY");
        const expected = (pick?.expected ?? 0) + (drop?.expected ?? 0);
        const scanned = (pick?.scanned ?? 0) + (drop?.scanned ?? 0);
        return {
          rider: { id: r.id, code: r.code, name: r.user.name, label: `${r.code} · ${r.user.name}`, hub: r.hub },
          pickups: { expected: pick?.expected ?? 0, scanned: pick?.scanned ?? 0 },
          deliveries: { expected: drop?.expected ?? 0, scanned: drop?.scanned ?? 0 },
          expected,
          scanned,
          compliance: rate(scanned, expected),
        };
      })
      .sort((a, b) => (a.compliance ?? 101) - (b.compliance ?? 101) || a.rider.code.localeCompare(b.rider.code));
    const count = (pred: (r: (typeof totals)[number]) => boolean) => totals.filter(pred).reduce((n, r) => n + r._count._all, 0);
    const hubExpected = hubItems.reduce((n, h) => n + h.expected, 0);
    const hubScanned = hubItems.reduce((n, h) => n + h.scanned, 0);
    return {
      from: query.from,
      to: query.to,
      totals: {
        scans: count(() => true),
        refused: count(r => !r.ok),
        camera: count(r => r.source === "CAMERA"),
        keyboard: count(r => r.source === "KEYBOARD" || r.source === "MANUAL"),
        hubCompliance: rate(hubScanned, hubExpected),
        riderCompliance: rate(
          riderItems.reduce((n, r) => n + r.scanned, 0),
          riderItems.reduce((n, r) => n + r.expected, 0),
        ),
      },
      hubs: hubItems,
      riders: riderItems,
    };
  }
}

const unique = (ids: (string | null)[]) => [...new Set(ids.filter((id): id is string => !!id))];
