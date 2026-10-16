import type { Db } from "../../common/prisma.service";

/**
 * The configured delivery zone for an address (areas → zone → hub). An entry listing the
 * area wins over one that covers the whole zone. Used by assignment suggestions, SLA and maps.
 */
export async function resolveZone(db: Db, address: { district: string; zone: string; area?: string | null }) {
  const zones = await db.deliveryZone.findMany({
    where: { active: true, district: { equals: address.district, mode: "insensitive" }, name: { equals: address.zone, mode: "insensitive" } },
    include: { route: { select: { id: true, code: true, name: true, defaultRiderId: true, active: true } } },
  });
  if (!zones.length) return null;
  const area = address.area?.trim().toLowerCase();
  return (area && zones.find(z => z.areas.some(a => a.toLowerCase() === area))) || zones.find(z => !z.areas.length) || zones[0];
}
