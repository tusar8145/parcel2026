import { z } from "zod";
import { listParcelsQuerySchema, PARCEL_STATUSES, TERMINAL_STATUSES, type ParcelStatus } from "@delivery-fast/shared";
import type { Prisma } from "../../generated/prisma/client";
import type { Db } from "../../common/prisma.service";

/**
 * The parcel journey as Courier Operations shows it (read-only filters). Shared by the paged lists
 * (GET /parcels?stage=) and the stage counts (GET /ops/stage-counts), so a list and its count agree.
 *
 *   new               PENDING_CONFIRMATION: orders waiting for operations (rider pickups and drop-offs)
 *   pickup_waiting    accepted (pickup assigned / confirmed) but without a pickup rider
 *   pickup            being picked up: pickup assigned / confirmed with a rider, or picked up
 *   hub               at a hub: AT_HUB, READY_FOR_COLLECTION
 *   transfers         IN_TRANSIT between hubs
 *   delivery_waiting  at a hub, waiting for a delivery rider (AT_HUB)
 *   delivery          with a delivery rider: ASSIGNED, OUT_FOR_DELIVERY
 *   exceptions        EXCEPTION
 *   failed            RETRY_SCHEDULED (failed delivery, another attempt planned)
 *   needs_info        imported with details missing, still open
 *   sla_risk          past the promised delivery time and still on the way
 *   problems          exceptions + failed + needs_info
 *   returns           RETURN_SCHEDULED (on a return run); return requests are counted separately
 */
export const PARCEL_STAGES = [
  "new",
  "pickup_waiting",
  "pickup",
  "hub",
  "transfers",
  "delivery_waiting",
  "delivery",
  "exceptions",
  "failed",
  "needs_info",
  "sla_risk",
  "problems",
  "returns",
] as const;
export type ParcelStage = (typeof PARCEL_STAGES)[number];

/** Service lines: website customers (no merchant), e-commerce and banking & financial merchants. */
export const SERVICE_LINES = ["CUSTOMER", "ECOMMERCE", "BANKING_FINANCIAL"] as const;
export type ServiceLineFilter = (typeof SERVICE_LINES)[number];

const ACTIVE: ParcelStatus[] = PARCEL_STATUSES.filter(s => !TERMINAL_STATUSES.includes(s));
/** Promise-bearing statuses that count towards "SLA at risk" once the estimate has passed (as GET /ops/overview). */
export const AT_RISK_STATUSES: ParcelStatus[] = ACTIVE.filter(s => s !== "PENDING_CONFIRMATION" && s !== "EXCEPTION");
/** Return requests not yet on a run (as GET /returns?stage=requested). */
export const RETURN_REQUESTED: Prisma.ParcelWhereInput = {
  returnRequestedAt: { not: null },
  status: { in: ["PICKED_UP", "AT_HUB", "IN_TRANSIT", "ASSIGNED", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "EXCEPTION"] },
};

export function stageWhere(stage: ParcelStage, now = new Date()): Prisma.ParcelWhereInput {
  switch (stage) {
    case "new":
      return { status: "PENDING_CONFIRMATION" };
    case "pickup_waiting":
      return { status: { in: ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED"] }, pickupRiderId: null };
    case "pickup":
      return { OR: [{ status: { in: ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED"] }, pickupRiderId: { not: null } }, { status: "PICKED_UP" }] };
    case "hub":
      return { status: { in: ["AT_HUB", "READY_FOR_COLLECTION"] } };
    case "transfers":
      return { status: "IN_TRANSIT" };
    case "delivery_waiting":
      return { status: "AT_HUB" };
    case "delivery":
      return { status: { in: ["ASSIGNED", "OUT_FOR_DELIVERY"] } };
    case "exceptions":
      return { status: "EXCEPTION" };
    case "failed":
      return { status: "RETRY_SCHEDULED" };
    case "needs_info":
      return { incomplete: true, status: { in: ACTIVE } };
    case "sla_risk":
      return { status: { in: AT_RISK_STATUSES }, estimatedDeliveryAt: { lt: now } };
    case "problems":
      return { OR: [{ status: { in: ["EXCEPTION", "RETRY_SCHEDULED"] } }, { incomplete: true, status: { in: ACTIVE } }] };
    case "returns":
      return { status: "RETURN_SCHEDULED" };
  }
}

export function lineWhere(line: ServiceLineFilter): Prisma.ParcelWhereInput {
  return line === "CUSTOMER" ? { merchantId: null } : { merchant: { type: line } };
}

type ZoneReader = Pick<Db, "deliveryZone" | "hub">;

/**
 * Parcels that belong to these hubs now ("my hub"): held at or heading to them (current hub), drop-offs
 * booked to them, picked up by their riders, and pickups from the zones they serve (delivery zones,
 * plus the hub's own zone) that no hub holds yet.
 */
export async function forHubsWhere(db: ZoneReader, hubIds: string[]): Promise<Prisma.ParcelWhereInput> {
  const [zones, hubs] = await Promise.all([
    db.deliveryZone.findMany({ where: { hubId: { in: hubIds }, active: true }, select: { name: true, district: true } }),
    db.hub.findMany({ where: { id: { in: hubIds } }, select: { zone: true, district: true } }),
  ]);
  const places = new Map<string, { pickupZone: string; pickupDistrict: string }>();
  for (const z of zones) places.set(`${z.district}|${z.name}`, { pickupZone: z.name, pickupDistrict: z.district });
  for (const h of hubs) if (h.zone) places.set(`${h.district}|${h.zone}`, { pickupZone: h.zone, pickupDistrict: h.district });
  return {
    OR: [
      { currentHubId: { in: hubIds } },
      { currentHubId: null, dropOffHubId: { in: hubIds } },
      { currentHubId: null, pickupRider: { hubId: { in: hubIds } } },
      ...(places.size ? [{ currentHubId: null, intake: "PICKUP" as const, OR: [...places.values()] }] : []),
    ],
  };
}

const uuidList = z
  .string()
  .transform(v => v.split(",").map(s => s.trim()).filter(Boolean))
  .pipe(z.array(z.uuid()).min(1).max(20));

/** The read-only filters Courier Operations' paged lists add to GET /parcels. */
export const stageFilterSchema = z.object({
  /** A journey stage (see PARCEL_STAGES). */
  stage: z.enum(PARCEL_STAGES).optional(),
  /** CUSTOMER (website parcels), ECOMMERCE or BANKING_FINANCIAL. */
  line: z.enum(SERVICE_LINES).optional(),
  /** Comma-separated hub ids: only parcels that belong to these hubs now (forHubsWhere). */
  forHubIds: uuidList.optional(),
});

export const listParcelsWithStageSchema = listParcelsQuerySchema.extend(stageFilterSchema.shape);
export const stageCountsQuerySchema = stageFilterSchema.pick({ forHubIds: true });
