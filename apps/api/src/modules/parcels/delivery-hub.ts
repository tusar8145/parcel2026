import type { Db } from "../../common/prisma.service";

type Place = { id: string; deliveryDistrict: string | null; deliveryZone: string | null; lastMile: string | null; collectHubId: string | null };
export type DeliveryHub = { id: string; name: string };

const zoneKey = (district: string | null | undefined, zone: string | null | undefined) => `${(district ?? "").trim().toLowerCase()}|${(zone ?? "").trim().toLowerCase()}`;

/**
 * The hub that delivers each parcel (same rule as transfers, linehaul/transfer.service.ts): the
 * collection hub for Collect from hub, else the serving hub of its delivery zone (active zones); null
 * when no hub serves it. Courier Operations' "next step" compares it with the hub holding the parcel:
 * another hub → Add to transfer, this hub → Assign rider.
 */
export async function deliveryHubsOf(db: Pick<Db, "deliveryZone" | "hub">, parcels: Place[]): Promise<Map<string, DeliveryHub | null>> {
  const out = new Map<string, DeliveryHub | null>();
  if (!parcels.length) return out;
  const wanted = [...new Map(parcels.filter(p => p.deliveryZone && p.deliveryDistrict).map(p => [zoneKey(p.deliveryDistrict, p.deliveryZone), p])).values()];
  const zones = wanted.length
    ? await db.deliveryZone.findMany({
        where: {
          active: true,
          hubId: { not: null },
          OR: wanted.map(p => ({ district: { equals: p.deliveryDistrict!, mode: "insensitive" as const }, name: { equals: p.deliveryZone!, mode: "insensitive" as const } })),
        },
        select: { district: true, name: true, hubId: true },
      })
    : [];
  const byZone = new Map(zones.map(z => [zoneKey(z.district, z.name), z.hubId!]));
  const hubIds = [...new Set([...byZone.values(), ...parcels.map(p => (p.lastMile === "HUB_COLLECT" ? p.collectHubId : null)).filter((x): x is string => !!x)])];
  const hubs = new Map((hubIds.length ? await db.hub.findMany({ where: { id: { in: hubIds } }, select: { id: true, name: true } }) : []).map(h => [h.id, h]));
  for (const p of parcels) {
    const id = (p.lastMile === "HUB_COLLECT" && p.collectHubId) || byZone.get(zoneKey(p.deliveryDistrict, p.deliveryZone)) || null;
    out.set(p.id, id ? (hubs.get(id) ?? null) : null);
  }
  return out;
}
