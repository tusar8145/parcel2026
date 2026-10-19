import type { Db } from "../../common/prisma.service";
import type { AuditService } from "../../common/audit.service";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { Prisma } from "../../generated/prisma/client";
import { servingHub } from "./merchant-address";

/**
 * A merchant's hub is always the hub serving its pickup zone (Merchant.pickupHubId, derived, never set by
 * hand). When the network changes under it (a zone gets another serving hub, a zone is added or removed,
 * a hub is switched off or on), the merchants of the affected zones are derived again here, each move audited.
 */

/** Merchants whose pickup is in this zone. */
export const merchantsInZone = (district: string, zone: string): Prisma.MerchantWhereInput => ({
  pickupDistrict: { equals: district, mode: "insensitive" },
  pickupZone: { equals: zone, mode: "insensitive" },
});

/** Derives the hub of the matching merchants again; returns the ids of those that moved. */
export async function rederiveMerchantHubs(db: Db, audit: AuditService, actor: Actor, meta: RequestMeta, where: Prisma.MerchantWhereInput, reason: string) {
  const merchants = await db.merchant.findMany({
    where: { AND: [where, { pickupZone: { not: null } }] },
    select: { id: true, pickupDistrict: true, pickupZone: true, pickupArea: true, pickupHubId: true },
  });
  const moved: string[] = [];
  for (const m of merchants) {
    const hub = await servingHub(db, { district: m.pickupDistrict, zone: m.pickupZone!, area: m.pickupArea });
    const to = hub?.id ?? null;
    if (to === m.pickupHubId) continue;
    await db.merchant.update({ where: { id: m.id }, data: { pickupHubId: to } });
    await audit.record(actor, { action: "merchant.hub_rederived", entityType: "merchant", entityId: m.id, data: { reason, previousPickupHubId: m.pickupHubId, pickupHubId: to } }, meta, db);
    moved.push(m.id);
  }
  return moved;
}
