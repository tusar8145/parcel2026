import { Prisma } from "../../generated/prisma/client";
import type { Db } from "../../common/prisma.service";
import { credit, debit, type LedgerService } from "../finance/ledger.service";

/**
 * Franchise commission and franchise rider pay, called inside the transactions that complete parcel events
 * (rider pickup / delivery, drop-off received at a franchise hub, return to the merchant). Plain functions, so the
 * parcels, rider and returns modules use them without a module dependency on modules/franchise.
 *
 * Commission = max(minimum, delivery charge × percent) for the event type; each (type, parcel) counts once.
 * Ledger: Dr Franchise commission (expense) / Cr Franchise commission payable, both with the franchise hub.
 */

export type CommissionType = "PICKUP" | "DELIVERY" | "RETURN";

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface FranchiseRates {
  id: string;
  hubId: string;
  code: string;
  pickupPercent: Prisma.Decimal;
  pickupMin: Prisma.Decimal;
  deliveryPercent: Prisma.Decimal;
  deliveryMin: Prisma.Decimal;
  returnPercent: Prisma.Decimal;
  returnMin: Prisma.Decimal;
  riderPickupRate: Prisma.Decimal;
  riderDeliveryRate: Prisma.Decimal;
  riderReturnRate: Prisma.Decimal;
}

/** The active franchise running this hub, or null (company hubs, suspended franchises). */
export async function franchiseOfHub(db: Db, hubId: string | null | undefined): Promise<FranchiseRates | null> {
  if (!hubId) return null;
  return db.franchise.findFirst({ where: { hubId, status: "ACTIVE", hub: { type: "FRANCHISE" } } });
}

/** The active franchise a rider works for (its hub is a franchise hub), or null. */
export async function franchiseOfRider(db: Db, riderId: string | null | undefined): Promise<FranchiseRates | null> {
  if (!riderId) return null;
  const rider = await db.rider.findUnique({ where: { id: riderId }, select: { hubId: true } });
  return franchiseOfHub(db, rider?.hubId);
}

/** The commission on a delivery charge for an event type (whole taka cents). */
export function commissionFor(f: Pick<FranchiseRates, "pickupPercent" | "pickupMin" | "deliveryPercent" | "deliveryMin" | "returnPercent" | "returnMin">, type: CommissionType, deliveryCharge: number) {
  const percent = Number(type === "PICKUP" ? f.pickupPercent : type === "DELIVERY" ? f.deliveryPercent : f.returnPercent);
  const minimum = Number(type === "PICKUP" ? f.pickupMin : type === "DELIVERY" ? f.deliveryMin : f.returnMin);
  if (!(percent > 0) && !(minimum > 0)) return { percent, minimum, amount: 0 };
  return { percent, minimum, amount: round2(Math.max(minimum, (Math.max(0, deliveryCharge) * percent) / 100)) };
}

/** The parcel's delivery charge: what the sender pays without the COD fee. */
export async function deliveryChargeOf(db: Db, parcelId: string) {
  const p = await db.parcel.findUniqueOrThrow({ where: { id: parcelId }, select: { totalCharge: true, codFee: true, trackingId: true } });
  return { trackingId: p.trackingId, charge: round2(Number(p.totalCharge) - Number(p.codFee ?? 0)) };
}

/** Records the franchise's commission for a parcel event (once per type and parcel) and its ledger entry. */
export async function recordFranchiseCommission(db: Db, ledger: LedgerService | undefined, input: { franchise: FranchiseRates; parcelId: string; type: CommissionType; at?: Date }) {
  const { franchise, parcelId, type } = input;
  const sourceKey = `${type}:${parcelId}`;
  if (await db.franchiseCommission.findUnique({ where: { sourceKey }, select: { id: true } })) return;
  const { trackingId, charge } = await deliveryChargeOf(db, parcelId);
  const c = commissionFor(franchise, type, charge);
  if (!(c.amount > 0)) return;
  const at = input.at ?? new Date();
  const created = await db.franchiseCommission.createMany({
    data: [{ franchiseId: franchise.id, parcelId, type, base: charge, percent: c.percent, minimum: c.minimum, amount: c.amount, sourceKey, earnedAt: at }],
    skipDuplicates: true,
  });
  if (!created.count || !ledger) return;
  await ledger.post(db, {
    eventType: "FRANCHISE_COMMISSION",
    reference: `${trackingId}:${type.toLowerCase()}`,
    memo: `${franchise.code} ${type.toLowerCase()} commission`,
    occurredAt: at,
    hubId: franchise.hubId,
    idempotencyKey: `FRANCHISE_COMMISSION:${sourceKey}`,
    lines: [debit("FRANCHISE_COMMISSION_EXPENSE", c.amount, { hubId: franchise.hubId }), credit("FRANCHISE_PAYABLE", c.amount, { hubId: franchise.hubId })],
  });
}

/** A franchise rider's pay for a task, from its franchise's rates (outside Paira Express payroll). */
export function franchiseRiderRate(f: Pick<FranchiseRates, "riderPickupRate" | "riderDeliveryRate" | "riderReturnRate">, type: CommissionType) {
  return Number(type === "PICKUP" ? f.riderPickupRate : type === "DELIVERY" ? f.riderDeliveryRate : f.riderReturnRate);
}

/**
 * A franchise rider returned a parcel to its merchant: the rider's RETURN pay and the franchise's RETURN commission.
 * (Pickups and deliveries go through recordTaskEarning.)
 */
export async function recordFranchiseReturn(db: Db, ledger: LedgerService | undefined, input: { riderId: string; parcel: { id: string; trackingId: string }; at?: Date }) {
  const franchise = await franchiseOfRider(db, input.riderId);
  if (!franchise) return;
  const at = input.at ?? new Date();
  const pay = franchiseRiderRate(franchise, "RETURN");
  if (pay > 0)
    await db.riderEarning.createMany({
      data: [{ riderId: input.riderId, type: "RETURN", amount: pay, sourceKey: `RETURN:${input.parcel.id}`, parcelId: input.parcel.id, trackingId: input.parcel.trackingId, description: `Return to merchant · ${input.parcel.trackingId}`, earnedAt: at }],
      skipDuplicates: true,
    });
  await recordFranchiseCommission(db, ledger, { franchise, parcelId: input.parcel.id, type: "RETURN", at });
}
