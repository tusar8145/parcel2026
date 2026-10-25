import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { forbidden } from "../../common/errors";
import type { Actor } from "../../common/auth/actor";
import { Prisma } from "../../generated/prisma/client";
import { PARCEL_STATUS_LABEL, type ParcelStatus } from "@delivery-fast/shared";
import { addDays, dhakaDateRange, opsHubScope } from "../parcels/ops-scope";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-25");
export const hubTransferReportQuerySchema = z
  .object({
    from: day,
    to: day,
    /** Transfers into or out of this hub. */
    hubId: z.uuid().optional(),
    /** One direction: sent from this hub and / or to this hub. */
    fromHubId: z.uuid().optional(),
    toHubId: z.uuid().optional(),
  })
  .refine(v => v.to >= v.from, { message: "The end date can't be before the start", path: ["to"] })
  .refine(v => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 31, { message: "Choose up to 31 days", path: ["to"] });
type Query = z.infer<typeof hubTransferReportQuerySchema>;

/** How far back a transfer received in the dates may have been sent. */
const LOOKBACK_DAYS = 30;
const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`;
const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10;

interface Move {
  parcel_id: string;
  sent_at: Date;
  sent_by: string | null;
  from_id: string | null;
  from_name: string | null;
  to_id: string | null;
  to_name: string | null;
  trip: string | null;
  bag: string | null;
  received_at: Date | null;
  received_by: string | null;
  missing: boolean | null;
}

/**
 * Courier Operations › Reports › Hub transfer report: parcels moved hub to hub in Dhaka days (default today) —
 * per route and per hub, how many were sent, how many arrived, how many are still on the way or went missing, and
 * the average time on the road; and the parcels behind it (view / CSV). A transfer is the parcel's "hub_transfer"
 * tracking event (a departing linehaul trip, or a manual move to another hub); it arrived when the parcel was next
 * AT_HUB at the destination. Hub staff see transfers into or out of their hubs.
 */
@Injectable()
export class HubTransferReportService {
  constructor(private readonly prisma: PrismaService) {}

  /** Transfers sent in the dates, and transfers received in the dates (sent up to 30 days before). */
  private async moves(actor: Actor, query: Query) {
    const scope = opsHubScope(actor);
    if (query.hubId && scope && !scope.includes(query.hubId)) throw forbidden("You can only see your own hubs' transfers");
    const [start, end] = dhakaDateRange(query.from, query.to);
    const rows = await this.prisma.$queryRaw<Move[]>`
      SELECT * FROM (
        SELECT e."parcelId" AS parcel_id, e."createdAt" AS sent_at, e."actorLabel" AS sent_by,
               e.metadata->>'fromHubId' AS from_id, e.metadata->>'fromHub' AS from_name,
               e.metadata->>'toHubId' AS to_id, e.metadata->>'toHub' AS to_name,
               e.metadata->>'tripNumber' AS trip, e.metadata->>'bagNumber' AS bag,
               r."createdAt" AS received_at, r."actorLabel" AS received_by,
               (i.state = 'MISSING') AS missing
        FROM tracking_events e
        LEFT JOIN LATERAL (
          SELECT x."createdAt", x."actorLabel" FROM tracking_events x
          WHERE x."parcelId" = e."parcelId" AND x.status = 'AT_HUB' AND x."createdAt" > e."createdAt"
            AND x.metadata->>'hubId' = e.metadata->>'toHubId'
          ORDER BY x."createdAt" LIMIT 1
        ) r ON true
        LEFT JOIN linehaul_bags b ON b.number = e.metadata->>'bagNumber'
        LEFT JOIN linehaul_bag_items i ON i."bagId" = b.id AND i."parcelId" = e."parcelId"
        WHERE e.metadata->>'kind' = 'hub_transfer' AND e."createdAt" >= ${ts(addDays(start, -LOOKBACK_DAYS))} AND e."createdAt" < ${ts(end)}
      ) m
      WHERE m.sent_at >= ${ts(start)} OR (m.received_at >= ${ts(start)} AND m.received_at < ${ts(end)})
      ORDER BY m.sent_at`;
    const hubs = query.hubId ? [query.hubId] : scope;
    const inDates = (d: Date | null) => !!d && d >= start && d < end;
    return rows
      .filter(m => !hubs || hubs.includes(m.from_id ?? "") || hubs.includes(m.to_id ?? ""))
      .filter(m => (!query.fromHubId || m.from_id === query.fromHubId) && (!query.toHubId || m.to_id === query.toHubId))
      .map(m => ({ ...m, sentInDates: inDates(m.sent_at), receivedInDates: inDates(m.received_at) }));
  }

  private async hubNames(moves: Move[]) {
    const ids = [...new Set(moves.flatMap(m => [m.from_id, m.to_id]).filter((x): x is string => !!x))];
    const hubs = await this.prisma.hub.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, code: true } });
    const byId = new Map(hubs.map(h => [h.id, h]));
    return (id: string | null, fallback: string | null) => ({ id, name: (id && byId.get(id)?.name) || fallback || "—", code: (id && byId.get(id)?.code) || null });
  }

  async summary(actor: Actor, query: Query) {
    const moves = await this.moves(actor, query);
    const hub = await this.hubNames(moves);
    type Count = { sent: number; received: number; onTheWay: number; missing: number; transitMs: number; timed: number; lastSentAt: Date | null };
    const blank = (): Count => ({ sent: 0, received: 0, onTheWay: 0, missing: 0, transitMs: 0, timed: 0, lastSentAt: null });
    const add = (c: Count, m: (typeof moves)[number]) => {
      if (m.sentInDates) {
        c.sent++;
        if (!m.received_at) m.missing ? c.missing++ : c.onTheWay++;
        if (!c.lastSentAt || m.sent_at > c.lastSentAt) c.lastSentAt = m.sent_at;
      }
      if (m.receivedInDates) {
        c.received++;
        c.transitMs += m.received_at!.getTime() - m.sent_at.getTime();
        c.timed++;
      }
    };
    const routes = new Map<string, { from: ReturnType<typeof hub>; to: ReturnType<typeof hub>; c: Count }>();
    const hubs = new Map<string, { hub: ReturnType<typeof hub>; out: Count; in: Count }>();
    const total = blank();
    const hubRow = (h: ReturnType<typeof hub>) => {
      const key = h.id ?? h.name;
      let r = hubs.get(key);
      if (!r) hubs.set(key, (r = { hub: h, out: blank(), in: blank() }));
      return r;
    };
    for (const m of moves) {
      const from = hub(m.from_id, m.from_name);
      const to = hub(m.to_id, m.to_name);
      const key = `${from.id ?? from.name}>${to.id ?? to.name}`;
      let route = routes.get(key);
      if (!route) routes.set(key, (route = { from, to, c: blank() }));
      add(route.c, m);
      add(total, m);
      add(hubRow(from).out, m);
      add(hubRow(to).in, m);
    }
    const counts = (c: Count) => ({ sent: c.sent, received: c.received, onTheWay: c.onTheWay, missing: c.missing, avgHours: c.timed ? hours(c.transitMs / c.timed) : null });
    return {
      from: query.from,
      to: query.to,
      totals: { ...counts(total), routes: [...routes.values()].filter(r => r.c.sent || r.c.received).length },
      routes: [...routes.values()]
        .map(r => ({ from: r.from, to: r.to, ...counts(r.c), lastSentAt: r.c.lastSentAt }))
        .sort((a, b) => b.sent - a.sent || b.received - a.received || a.from.name.localeCompare(b.from.name) || a.to.name.localeCompare(b.to.name)),
      hubs: [...hubs.values()]
        .map(h => ({ hub: h.hub, sentOut: h.out.sent, receivedIn: h.in.received, onTheWayOut: h.out.onTheWay, onTheWayIn: h.in.onTheWay, missingOut: h.out.missing }))
        .sort((a, b) => b.sentOut + b.receivedIn - (a.sentOut + a.receivedIn) || a.hub.name.localeCompare(b.hub.name)),
    };
  }

  /** The parcels behind the report (a route: fromHubId + toHubId), for the list and the CSV. */
  async parcels(actor: Actor, query: Query) {
    const moves = await this.moves(actor, query);
    const hub = await this.hubNames(moves);
    const parcels = await this.prisma.parcel.findMany({
      where: { id: { in: [...new Set(moves.map(m => m.parcel_id))] } },
      select: { id: true, trackingId: true, status: true, recipientName: true, deliveryZone: true, deliveryDistrict: true, codAmount: true, senderName: true, merchant: { select: { name: true } } },
    });
    const byId = new Map(parcels.map(p => [p.id, p]));
    return {
      items: moves.flatMap(m => {
        const p = byId.get(m.parcel_id);
        if (!p) return [];
        return [
          {
            trackingId: p.trackingId,
            from: hub(m.from_id, m.from_name),
            to: hub(m.to_id, m.to_name),
            sender: p.merchant?.name ?? p.senderName,
            recipient: p.recipientName,
            zone: [p.deliveryZone, p.deliveryDistrict].filter(Boolean).join(", "),
            cod: Math.round(Number(p.codAmount) * 100) / 100,
            trip: m.trip,
            bag: m.bag,
            sentAt: m.sent_at,
            sentBy: m.sent_by,
            receivedAt: m.received_at,
            receivedBy: m.received_by,
            hours: m.received_at ? hours(m.received_at.getTime() - m.sent_at.getTime()) : null,
            state: m.received_at ? "Received" : m.missing ? "Missing" : "On the way",
            sentInDates: m.sentInDates,
            receivedInDates: m.receivedInDates,
            status: PARCEL_STATUS_LABEL[p.status as ParcelStatus],
          },
        ];
      }),
    };
  }
}
