import type { PrismaService } from "../../common/prisma.service";
import type { Prisma } from "../../generated/prisma/client";
import type { Period } from "../../common/period";

const rate = (num: number, den: number) => (den ? Math.round((num / den) * 1000) / 10 : null);

/**
 * What happened in a period (Courier Operations Today's metrics row): parcels booked, picked up,
 * delivered and returned, COD collected, delivery success and SLA met. Each figure is an indexed
 * range count (createdAt, pickedUpAt, deliveredAt, cod_collections.collectedAt); `scope` narrows
 * them (e.g. "my hub"). Live "now" counts are elsewhere (stage counts, overview).
 */
export async function periodMetrics(db: PrismaService, window: { start: Date; end: Date }, scope: Prisma.ParcelWhereInput = {}) {
  const range = { gte: window.start, lt: window.end };
  const where = (w: Prisma.ParcelWhereInput): Prisma.ParcelWhereInput => ({ AND: [scope, w] });
  const deliveredWhere: Prisma.ParcelWhereInput = { status: "DELIVERED", deliveredAt: range };
  const promised: Prisma.ParcelWhereInput = { ...deliveredWhere, estimatedDeliveryAt: { not: null } };
  const [booked, pickedUp, delivered, returned, withPromise, onTime, cod] = await Promise.all([
    db.parcel.count({ where: where({ createdAt: range }) }),
    db.parcel.count({ where: where({ pickedUpAt: range }) }),
    db.parcel.count({ where: where(deliveredWhere) }),
    db.parcel.count({ where: where({ status: "RETURNED", updatedAt: range }) }),
    db.parcel.count({ where: where(promised) }),
    db.parcel.count({ where: where({ ...promised, AND: [{ deliveredAt: { lte: db.parcel.fields.estimatedDeliveryAt } }] }) }),
    db.codCollection.aggregate({ where: { collectedAt: range, ...(Object.keys(scope).length ? { parcel: scope } : {}) }, _sum: { amount: true }, _count: { _all: true } }),
  ]);
  return {
    booked,
    pickedUp,
    delivered,
    returned,
    codCollected: Math.round(Number(cod._sum.amount ?? 0) * 100) / 100,
    codCollections: cod._count._all,
    /** Delivered share of the parcels that reached an outcome (delivered or returned). */
    successRate: rate(delivered, delivered + returned),
    /** Delivered by the promised time, of the deliveries that had one. */
    slaMetRate: rate(onTime, withPromise),
    slaSample: withPromise,
  };
}

/** The period's figures and the previous period's (same length) for "vs previous" trends. */
export async function periodMetricsWithPrevious(db: PrismaService, p: Period, scope: Prisma.ParcelWhereInput = {}) {
  const [current, previous] = await Promise.all([periodMetrics(db, p, scope), periodMetrics(db, p.previous, scope)]);
  return { ...current, previous };
}
