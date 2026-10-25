import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { forbidden } from "../../common/errors";
import type { Actor } from "../../common/auth/actor";
import { Prisma } from "../../generated/prisma/client";
import { dhakaDateRange, opsHubScope } from "../parcels/ops-scope";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-25");
export const riderReportQuerySchema = z
  .object({
    from: day,
    to: day,
    hubId: z.uuid().optional(),
    /** Parcels list: one rider only. */
    riderId: z.uuid().optional(),
  })
  .refine(v => v.to >= v.from, { message: "The end date can't be before the start", path: ["to"] })
  .refine(v => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 31, { message: "Choose up to 31 days", path: ["to"] });
type Query = z.infer<typeof riderReportQuerySchema>;

const n = (d: Prisma.Decimal | number | null | undefined) => Math.round(Number(d ?? 0) * 100) / 100;
const LEG_EVENTS = { PICKUP_ASSIGNED: "pickup", PICKED_UP: "pickup", ASSIGNED: "delivery", OUT_FOR_DELIVERY: "delivery" } as const;

/**
 * Courier Operations › Reports › Rider report: per rider for Dhaka days (default today) — pickups assigned and
 * picked up, deliveries assigned, out for delivery, delivered and failed, COD collected, cash handed in at the hub
 * (received slips), cash held now and the last position; and the parcels behind those counts (view / CSV).
 * Hub staff see their own hubs' riders.
 */
@Injectable()
export class RiderReportService {
  constructor(private readonly prisma: PrismaService) {}

  private riderScope(actor: Actor, hubId?: string): Prisma.RiderWhereInput {
    const scope = opsHubScope(actor);
    if (hubId && scope && !scope.includes(hubId)) throw forbidden("You can only see your own hub's riders");
    const hubs = hubId ? [hubId] : scope;
    return hubs ? { hubId: { in: hubs } } : {};
  }

  async summary(actor: Actor, query: Query) {
    const [start, end] = dhakaDateRange(query.from, query.to);
    const range = { gte: start, lt: end };
    const riders = await this.prisma.rider.findMany({
      where: { ...this.riderScope(actor, query.hubId), active: true },
      select: { id: true, code: true, user: { select: { name: true, phone: true } }, hub: { select: { id: true, name: true } }, location: true },
      orderBy: { code: "asc" },
    });
    const ids = riders.map(r => r.id);
    const [events, pickedUp, attempts, cod, slips, holding, dues] = await Promise.all([
      this.prisma.trackingEvent.findMany({
        where: { createdAt: range, status: { in: ["PICKUP_ASSIGNED", "ASSIGNED", "OUT_FOR_DELIVERY"] }, parcel: { OR: [{ pickupRiderId: { in: ids } }, { deliveryRiderId: { in: ids } }] } },
        select: { status: true, parcelId: true, parcel: { select: { pickupRiderId: true, deliveryRiderId: true } } },
      }),
      this.prisma.parcel.groupBy({ by: ["pickupRiderId"], where: { pickupRiderId: { in: ids }, pickedUpAt: range }, _count: { _all: true } }),
      this.prisma.deliveryAttempt.groupBy({ by: ["riderId", "outcome"], where: { riderId: { in: ids }, createdAt: range }, _count: { _all: true } }),
      this.prisma.codCollection.groupBy({ by: ["riderId"], where: { riderId: { in: ids }, collectedAt: range }, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.cashSlip.groupBy({ by: ["riderId"], where: { riderId: { in: ids }, status: "RECEIVED", receivedAt: range }, _sum: { received: true }, _count: { _all: true } }),
      this.prisma.codCollection.groupBy({ by: ["riderId"], where: { riderId: { in: ids }, state: "WITH_RIDER" }, _sum: { amount: true } }),
      this.prisma.cashDue.groupBy({ by: ["riderId"], where: { riderId: { in: ids }, clearedAt: null }, _sum: { amount: true } }),
    ]);
    // Distinct parcels per rider and kind of event (a parcel reassigned to another rider counts for its current rider).
    const sets = new Map<string, Record<"pickupAssigned" | "deliveryAssigned" | "outForDelivery", Set<string>>>();
    const of = (rid: string) => {
      let s = sets.get(rid);
      if (!s) sets.set(rid, (s = { pickupAssigned: new Set(), deliveryAssigned: new Set(), outForDelivery: new Set() }));
      return s;
    };
    for (const e of events) {
      if (e.status === "PICKUP_ASSIGNED" && e.parcel.pickupRiderId) of(e.parcel.pickupRiderId).pickupAssigned.add(e.parcelId);
      if (e.status === "ASSIGNED" && e.parcel.deliveryRiderId) of(e.parcel.deliveryRiderId).deliveryAssigned.add(e.parcelId);
      if (e.status === "OUT_FOR_DELIVERY" && e.parcel.deliveryRiderId) of(e.parcel.deliveryRiderId).outForDelivery.add(e.parcelId);
    }
    const items = riders.map(r => {
      const s = sets.get(r.id);
      const attempt = (o: "DELIVERED" | "FAILED") => attempts.find(a => a.riderId === r.id && a.outcome === o)?._count._all ?? 0;
      const c = cod.find(x => x.riderId === r.id);
      const sl = slips.find(x => x.riderId === r.id);
      return {
        rider: { id: r.id, code: r.code, name: r.user.name, phone: r.user.phone, hub: r.hub },
        pickups: { assigned: s?.pickupAssigned.size ?? 0, pickedUp: pickedUp.find(x => x.pickupRiderId === r.id)?._count._all ?? 0 },
        deliveries: { assigned: s?.deliveryAssigned.size ?? 0, outForDelivery: s?.outForDelivery.size ?? 0, delivered: attempt("DELIVERED"), failed: attempt("FAILED") },
        cash: {
          collected: n(c?._sum.amount),
          collections: c?._count._all ?? 0,
          handedIn: n(sl?._sum.received),
          slips: sl?._count._all ?? 0,
          holdingNow: n(holding.find(x => x.riderId === r.id)?._sum.amount) + n(dues.find(x => x.riderId === r.id)?._sum.amount),
        },
        location: r.location ? { lat: r.location.lat, lng: r.location.lng, at: r.location.at } : null,
      };
    });
    const active = items.filter(i => i.pickups.assigned || i.pickups.pickedUp || i.deliveries.assigned || i.deliveries.outForDelivery || i.deliveries.delivered || i.deliveries.failed || i.cash.collected || i.cash.handedIn || i.cash.holdingNow);
    const total = (f: (i: (typeof items)[number]) => number) => n(items.reduce((t, i) => t + f(i), 0));
    return {
      from: query.from,
      to: query.to,
      totals: {
        riders: items.length,
        active: active.length,
        pickupsAssigned: total(i => i.pickups.assigned),
        pickedUp: total(i => i.pickups.pickedUp),
        deliveriesAssigned: total(i => i.deliveries.assigned),
        outForDelivery: total(i => i.deliveries.outForDelivery),
        delivered: total(i => i.deliveries.delivered),
        failed: total(i => i.deliveries.failed),
        collected: total(i => i.cash.collected),
        handedIn: total(i => i.cash.handedIn),
        holdingNow: total(i => i.cash.holdingNow),
      },
      items,
    };
  }

  /** The parcels behind the counts: each pickup / delivery a rider worked in the dates, with its outcome and cash. */
  async parcels(actor: Actor, query: Query) {
    const [start, end] = dhakaDateRange(query.from, query.to);
    const range = { gte: start, lt: end };
    const riders = await this.prisma.rider.findMany({
      where: { ...this.riderScope(actor, query.hubId), ...(query.riderId ? { id: query.riderId } : {}) },
      select: { id: true, code: true, user: { select: { name: true } } },
    });
    const ids = riders.map(r => r.id);
    if (!ids.length) return { items: [] };
    const [events, attempts, picked] = await Promise.all([
      this.prisma.trackingEvent.findMany({
        where: { createdAt: range, status: { in: ["PICKUP_ASSIGNED", "PICKED_UP", "ASSIGNED", "OUT_FOR_DELIVERY"] }, parcel: { OR: [{ pickupRiderId: { in: ids } }, { deliveryRiderId: { in: ids } }] } },
        select: { status: true, parcelId: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.deliveryAttempt.findMany({ where: { riderId: { in: ids }, createdAt: range }, select: { parcelId: true, riderId: true, outcome: true, reason: true, createdAt: true }, orderBy: { createdAt: "asc" } }),
      this.prisma.parcel.findMany({ where: { pickupRiderId: { in: ids }, pickedUpAt: range }, select: { id: true } }),
    ]);
    const parcelIds = [...new Set([...events.map(e => e.parcelId), ...attempts.map(a => a.parcelId), ...picked.map(p => p.id)])];
    const parcels = await this.prisma.parcel.findMany({
      where: { id: { in: parcelIds } },
      select: {
        id: true,
        trackingId: true,
        status: true,
        merchantOrderRef: true,
        recipientName: true,
        recipientPhone: true,
        deliveryStreet: true,
        deliveryZone: true,
        deliveryDistrict: true,
        codAmount: true,
        pickupRiderId: true,
        deliveryRiderId: true,
        pickedUpAt: true,
        merchant: { select: { name: true } },
        senderName: true,
        codCollection: { select: { amount: true, riderId: true, collectedAt: true } },
      },
    });
    const riderOf = new Map(riders.map(r => [r.id, `${r.code} · ${r.user.name}`]));
    const rows: Record<string, unknown>[] = [];
    for (const p of parcels) {
      const evs = events.filter(e => e.parcelId === p.id);
      // Pickup leg: assigned in the dates or picked up in the dates, by this parcel's pickup rider.
      if (p.pickupRiderId && riderOf.has(p.pickupRiderId) && (evs.some(e => LEG_EVENTS[e.status as keyof typeof LEG_EVENTS] === "pickup") || (p.pickedUpAt && p.pickedUpAt >= start && p.pickedUpAt < end)))
        rows.push({
          riderId: p.pickupRiderId,
          rider: riderOf.get(p.pickupRiderId),
          leg: "Pickup",
          trackingId: p.trackingId,
          sender: p.merchant?.name ?? p.senderName,
          recipient: p.recipientName,
          outcome: p.pickedUpAt && p.pickedUpAt >= start && p.pickedUpAt < end ? "Picked up" : "Assigned",
          at: p.pickedUpAt ?? evs.find(e => e.status === "PICKUP_ASSIGNED")?.createdAt ?? null,
          cod: 0,
          status: p.status,
        });
      // Delivery leg: assigned / out for delivery / attempted in the dates, by the rider who did it.
      const tries = attempts.filter(a => a.parcelId === p.id);
      const deliveryRider = tries.at(-1)?.riderId ?? p.deliveryRiderId;
      if (deliveryRider && riderOf.has(deliveryRider) && (tries.length || evs.some(e => LEG_EVENTS[e.status as keyof typeof LEG_EVENTS] === "delivery"))) {
        const last = tries.at(-1);
        const out = evs.filter(e => e.status === "OUT_FOR_DELIVERY").at(-1);
        rows.push({
          riderId: deliveryRider,
          rider: riderOf.get(deliveryRider),
          leg: "Delivery",
          trackingId: p.trackingId,
          sender: p.merchant?.name ?? p.senderName,
          recipient: p.recipientName,
          recipientPhone: p.recipientPhone,
          address: [p.deliveryStreet, p.deliveryZone, p.deliveryDistrict].filter(Boolean)[0] ?? "",
          zone: [p.deliveryZone, p.deliveryDistrict].filter(Boolean).join(", "),
          outcome: last ? (last.outcome === "DELIVERED" ? "Delivered" : `Failed${last.reason ? `: ${last.reason}` : ""}`) : out ? "Out for delivery" : "Assigned",
          at: last?.createdAt ?? out?.createdAt ?? evs.find(e => e.status === "ASSIGNED")?.createdAt ?? null,
          cod: p.codCollection && p.codCollection.riderId === deliveryRider && p.codCollection.collectedAt >= start && p.codCollection.collectedAt < end ? n(p.codCollection.amount) : 0,
          codDue: n(p.codAmount),
          status: p.status,
        });
      }
    }
    rows.sort((a, b) => String(a.rider).localeCompare(String(b.rider)) || new Date(String(a.at ?? 0)).getTime() - new Date(String(b.at ?? 0)).getTime());
    return { items: rows };
  }
}
