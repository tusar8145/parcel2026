import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../../common/prisma.service";
import type { Actor } from "../../common/auth/actor";
import { forbidden, notFound } from "../../common/errors";
import { dhakaDateRange, dhakaDayStart, opsHubScope } from "../parcels/ops-scope";

export const hubReconciliationQuerySchema = z.object({
  hubId: z.uuid(),
  /** A Dhaka calendar day (default: today). */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional(),
});
export type HubReconciliationQuery = z.infer<typeof hubReconciliationQuerySchema>;

const PICKUP_STAGE = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED"] as const;
const ZERO = new Prisma.Decimal(0);
const money = (v: Prisma.Decimal | null | undefined) => (v ?? ZERO).toFixed(2);
const today = () => new Date(dhakaDayStart().getTime() + 6 * 3600_000).toISOString().slice(0, 10);

/**
 * End-of-day hub reconciliation (read-only), for one hub and one Dhaka calendar day:
 *  - parcels: arrivals received that day vs still expected (inbound bags, drop-offs booked to the hub,
 *    parcels picked up by its riders), dispatched out (out for delivery with its riders, transferred
 *    in bags on departed trips), and what the hub holds now (at hub, ready for collection);
 *  - cash (with cod:receive or finance:read): COD collected by the hub's riders (and at its counter)
 *    that day vs cash handovers received at the hub vs what riders still hold, per rider.
 * Hub operators see their own hubs only.
 */
@Injectable()
export class HubReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  async report(actor: Actor, query: HubReconciliationQuery) {
    const scope = opsHubScope(actor);
    if (scope && !scope.includes(query.hubId)) throw forbidden("You can only reconcile your own hub");
    const hub = await this.prisma.hub.findUnique({ where: { id: query.hubId }, select: { id: true, code: true, name: true } });
    if (!hub) throw notFound("Hub");
    const date = query.date ?? today();
    const [from, to] = dhakaDateRange(date, date);
    const day = { gte: from, lt: to };
    const hubId = hub.id;

    const arrivedAtHub: Prisma.TrackingEventWhereInput = {
      status: "AT_HUB",
      createdAt: day,
      OR: [{ metadata: { path: ["hubId"], equals: hubId } }, { location: hub.name }],
    };
    const [received, inboundBags, dropOffsAwaiting, pickedUpByRiders, outForDelivery, delivered, transferItems, transferBags, heldNow, readyForCollection] = await Promise.all([
      this.prisma.trackingEvent.findMany({ where: arrivedAtHub, distinct: ["parcelId"], select: { parcelId: true } }).then(r => r.length),
      this.prisma.linehaulBagItem.count({ where: { state: "LOADED", bag: { destHubId: hubId, status: { in: ["SEALED", "IN_TRANSIT"] } } } }),
      this.prisma.parcel.count({ where: { intake: "DROP_OFF", dropOffHubId: hubId, currentHubId: null, status: { in: [...PICKUP_STAGE] } } }),
      this.prisma.parcel.count({ where: { status: "PICKED_UP", pickupRider: { hubId } } }),
      this.prisma.trackingEvent
        .findMany({ where: { status: "OUT_FOR_DELIVERY", createdAt: day, parcel: { deliveryRider: { hubId } } }, distinct: ["parcelId"], select: { parcelId: true } })
        .then(r => r.length),
      this.prisma.trackingEvent
        .findMany({ where: { status: "DELIVERED", createdAt: day, parcel: { deliveryRider: { hubId } } }, distinct: ["parcelId"], select: { parcelId: true } })
        .then(r => r.length),
      this.prisma.linehaulBagItem.count({ where: { bag: { originHubId: hubId, trip: { departedAt: day } } } }),
      this.prisma.linehaulBag.count({ where: { originHubId: hubId, trip: { departedAt: day } } }),
      this.prisma.parcel.count({ where: { status: "AT_HUB", currentHubId: hubId } }),
      this.prisma.parcel.count({ where: { status: "READY_FOR_COLLECTION", OR: [{ collectHubId: hubId }, { currentHubId: hubId }] } }),
    ]);
    const stillExpected = inboundBags + dropOffsAwaiting + pickedUpByRiders;

    const report = {
      hub,
      date,
      generatedAt: new Date(),
      isToday: date === today(),
      parcels: {
        expected: received + stillExpected,
        received,
        stillExpected,
        expectedParts: { inboundBags, dropOffs: dropOffsAwaiting, pickedUpByRiders },
        dispatched: outForDelivery + transferItems,
        outForDelivery,
        transferred: transferItems,
        transferBags,
        delivered,
        heldNow,
        readyForCollection,
      },
      cash: null as null | Awaited<ReturnType<HubReconciliationService["cash"]>>,
    };
    if (actor.permissions.has("cod:receive") || actor.permissions.has("finance:read")) report.cash = await this.cash(hubId, day);
    return report;
  }

  private async cash(hubId: string, day: { gte: Date; lt: Date }) {
    const collectedWhere: Prisma.CodCollectionWhereInput = { collectedAt: day, OR: [{ rider: { hubId } }, { riderId: null, hubId }] };
    const [collected, counter, handovers, outstanding, outstandingToday, byRiderCollected, byRiderHandedOver, byRiderOutstanding] = await Promise.all([
      this.prisma.codCollection.aggregate({ where: collectedWhere, _sum: { amount: true }, _count: true }),
      this.prisma.codCollection.aggregate({ where: { collectedAt: day, riderId: null, hubId }, _sum: { amount: true }, _count: true }),
      this.prisma.cashHandover.aggregate({ where: { hubId, createdAt: day }, _sum: { amount: true }, _count: true }),
      this.prisma.codCollection.aggregate({ where: { state: "WITH_RIDER", rider: { hubId } }, _sum: { amount: true }, _count: true }),
      this.prisma.codCollection.aggregate({ where: { state: "WITH_RIDER", rider: { hubId }, collectedAt: day }, _sum: { amount: true }, _count: true }),
      this.prisma.codCollection.groupBy({ by: ["riderId"], where: { collectedAt: day, rider: { hubId } }, _sum: { amount: true }, _count: true }),
      this.prisma.cashHandover.groupBy({ by: ["riderId"], where: { hubId, createdAt: day }, _sum: { amount: true }, _count: true }),
      this.prisma.codCollection.groupBy({ by: ["riderId"], where: { state: "WITH_RIDER", rider: { hubId } }, _sum: { amount: true }, _count: true }),
    ]);
    const riderIds = [...new Set([...byRiderCollected, ...byRiderHandedOver, ...byRiderOutstanding].map(r => r.riderId).filter((id): id is string => !!id))];
    const riders = await this.prisma.rider.findMany({ where: { id: { in: riderIds } }, select: { id: true, code: true, user: { select: { name: true } } } });
    const find = <T extends { riderId: string | null }>(rows: T[], id: string) => rows.find(r => r.riderId === id);
    const perRider = riders
      .map(r => {
        const c = find(byRiderCollected, r.id);
        const h = find(byRiderHandedOver, r.id);
        const o = find(byRiderOutstanding, r.id);
        return {
          rider: { id: r.id, code: r.code, name: r.user.name },
          collected: money(c?._sum.amount),
          collections: c?._count ?? 0,
          handedOver: money(h?._sum.amount),
          handovers: h?._count ?? 0,
          withRider: money(o?._sum.amount),
          withRiderCollections: o?._count ?? 0,
        };
      })
      .sort((a, b) => Number(b.withRider) - Number(a.withRider) || a.rider.code.localeCompare(b.rider.code));
    return {
      collected: money(collected._sum.amount),
      collections: collected._count,
      collectedAtCounter: money(counter._sum.amount),
      counterCollections: counter._count,
      handedOver: money(handovers._sum.amount),
      handovers: handovers._count,
      /** Collected that day and not yet handed over. */
      outstandingFromDay: money(outstandingToday._sum.amount),
      outstandingFromDayCollections: outstandingToday._count,
      /** Everything the hub's riders still hold (any day). */
      outstanding: money(outstanding._sum.amount),
      outstandingCollections: outstanding._count,
      perRider,
    };
  }
}
