import type { Db } from "../../common/prisma.service";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { AuditService } from "../../common/audit.service";

/** Trip statuses on which a vehicle's location is still shared. */
export const SHAREABLE_TRIP_STATUSES = ["PLANNED", "DEPARTED"] as const;

export type ShareEndReason = "STOPPED" | "TRIP_ARRIVED" | "TRIP_CLOSED" | "TRIP_CANCELLED" | "REPLACED" | "TAKEN_OVER";

export const reasonForTripStatus = (status: string): ShareEndReason | null =>
  status === "ARRIVED" ? "TRIP_ARRIVED" : status === "CLOSED" ? "TRIP_CLOSED" : status === "CANCELLED" ? "TRIP_CANCELLED" : null;

/**
 * Ends every open vehicle-location share of a trip (the trip arrived, closed or was cancelled).
 * Call inside the transaction that changes the trip; audited as `vehicle_share.auto_stop`.
 */
export async function endTripShares(db: Db, audit: AuditService, actor: Actor | "system", tripId: string, reason: ShareEndReason, meta?: Partial<RequestMeta>) {
  const open = await db.vehicleShare.findMany({ where: { tripId, endedAt: null }, select: { id: true, userId: true } });
  if (!open.length) return 0;
  await db.vehicleShare.updateMany({ where: { id: { in: open.map(s => s.id) } }, data: { endedAt: new Date(), endReason: reason } });
  for (const share of open)
    await audit.record(actor, { action: "vehicle_share.auto_stop", entityType: "linehaul_trip", entityId: tripId, data: { shareId: share.id, userId: share.userId, reason } }, meta, db);
  return open.length;
}
