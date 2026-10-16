import type { Db } from "../../common/prisma.service";
import type { ServiceLevel, SlaPolicy } from "../../generated/prisma/client";

/** Built-in targets (minutes) when no configured policy matches. */
export const DEFAULT_SLA: Record<ServiceLevel, { pickup: number; delivery: number; deliveryOtherDistrict: number; atRisk: number }> = {
  SAME_DAY: { pickup: 180, delivery: 600, deliveryOtherDistrict: 600, atRisk: 90 },
  EXPRESS: { pickup: 240, delivery: 1440, deliveryOtherDistrict: 1440, atRisk: 120 },
  REGULAR: { pickup: 1440, delivery: 2880, deliveryOtherDistrict: 4320, atRisk: 240 },
};

export interface SlaRoute {
  serviceLevel: ServiceLevel;
  pickupDistrict: string;
  pickupZone: string;
  deliveryDistrict: string;
  deliveryZone: string;
}

const same = (a: string | null, b: string) => a === null || a.toLowerCase() === b.toLowerCase();

/** How specific a policy is for this route (-1 = doesn't apply). Zones count more than districts. */
export function policyScore(p: Pick<SlaPolicy, "originDistrict" | "originZone" | "destDistrict" | "destZone">, r: SlaRoute) {
  if (!same(p.originDistrict, r.pickupDistrict) || !same(p.originZone, r.pickupZone) || !same(p.destDistrict, r.deliveryDistrict) || !same(p.destZone, r.deliveryZone)) return -1;
  return (p.originZone ? 4 : 0) + (p.destZone ? 4 : 0) + (p.originDistrict ? 1 : 0) + (p.destDistrict ? 1 : 0);
}

/** The policy that applies: the most specific active one for the service level and zone pair, else the defaults. */
export async function slaTargets(db: Db, route: SlaRoute) {
  const policies = await db.slaPolicy.findMany({ where: { active: true, serviceLevel: route.serviceLevel } });
  const best = policies
    .map(p => ({ p, score: policyScore(p, route) }))
    .filter(x => x.score >= 0)
    .sort((a, b) => b.score - a.score || b.p.createdAt.getTime() - a.p.createdAt.getTime())[0]?.p;
  if (best) return { policyId: best.id, name: best.name, pickupMinutes: best.pickupMinutes, deliveryMinutes: best.deliveryMinutes, atRiskMinutes: best.atRiskMinutes };
  const d = DEFAULT_SLA[route.serviceLevel];
  const sameDistrict = route.pickupDistrict.toLowerCase() === route.deliveryDistrict.toLowerCase();
  return { policyId: null, name: "Default", pickupMinutes: d.pickup, deliveryMinutes: sameDistrict ? d.delivery : d.deliveryOtherDistrict, atRiskMinutes: d.atRisk };
}

/**
 * Due times for a new booking: pickup by the end of the chosen pickup window (or the pickup
 * target after booking); delivery the delivery target after booking.
 */
export async function slaDueDates(db: Db, route: SlaRoute & { bookedAt?: Date; pickupWindowEnd?: Date | null }) {
  const targets = await slaTargets(db, route);
  const booked = route.bookedAt ?? new Date();
  const pickupDueAt = route.pickupWindowEnd ?? new Date(booked.getTime() + targets.pickupMinutes * 60_000);
  const deliveryDueAt = new Date(Math.max(booked.getTime() + targets.deliveryMinutes * 60_000, pickupDueAt.getTime()));
  return { pickupDueAt, deliveryDueAt, policy: targets };
}
