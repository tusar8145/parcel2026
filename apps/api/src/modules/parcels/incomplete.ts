import { HttpStatus } from "@nestjs/common";
import type { ParcelStatus } from "@paira-express/shared";
import { AppError } from "../../common/errors";

/**
 * Incomplete orders (spreadsheet imports booked with delivery details missing). The parcel keeps
 * the missing columns null, `incomplete = true` and `missingFields` lists what is missing; it is
 * priced with defaults (pricingSnapshot.destination). See docs/architecture-contracts.md.
 */
export const MISSING_FIELDS = ["recipientName", "recipientPhone", "address", "district", "zone"] as const;
export type MissingField = (typeof MISSING_FIELDS)[number];

export const MISSING_LABEL: Record<MissingField, string> = {
  recipientName: "recipient name",
  recipientPhone: "recipient phone",
  address: "delivery address",
  district: "district",
  zone: "zone",
};

/** Everything a delivery rider needs: who receives it, how to reach them and where. */
export const NEEDED_FOR_DELIVERY: readonly MissingField[] = ["recipientName", "recipientPhone", "address", "district", "zone"];

/**
 * Delivery details a parcel needs before each step (an incomplete parcel can still be picked up
 * and received at a hub). The recipient name is optional at import time (super-admin import
 * settings) but required before delivery.
 */
const NEEDED_FOR: Partial<Record<ParcelStatus, readonly MissingField[]>> = {
  ASSIGNED: NEEDED_FOR_DELIVERY,
  OUT_FOR_DELIVERY: NEEDED_FOR_DELIVERY,
  IN_TRANSIT: ["district", "zone"],
};

type ParcelDetails = {
  trackingId: string;
  recipientName: string | null;
  recipientPhone: string | null;
  deliveryStreet: string | null;
  deliveryDistrict: string | null;
  deliveryZone: string | null;
};

/** What is still missing, from the stored columns. */
export function missingFieldsOf(p: Omit<ParcelDetails, "trackingId">): MissingField[] {
  const empty = (v: string | null | undefined) => !v || !v.trim();
  const missing: MissingField[] = [];
  if (empty(p.recipientName)) missing.push("recipientName");
  if (empty(p.recipientPhone)) missing.push("recipientPhone");
  if (empty(p.deliveryStreet)) missing.push("address");
  if (empty(p.deliveryDistrict)) missing.push("district");
  if (empty(p.deliveryZone)) missing.push("zone");
  return missing;
}

export const describeMissing = (fields: readonly string[]) => fields.map(f => MISSING_LABEL[f as MissingField] ?? f).join(", ");

/** What the parcel still lacks for a step (empty when it may go there). */
export function missingFor(p: Omit<ParcelDetails, "trackingId">, to: ParcelStatus): MissingField[] {
  const needed = NEEDED_FOR[to];
  return needed ? missingFieldsOf(p).filter(f => needed.includes(f)) : [];
}

/** Refuses a status change that needs details the parcel doesn't have yet (ParcelWorkflowService.transition). */
export function assertDetailsFor(p: ParcelDetails, to: ParcelStatus) {
  const missing = missingFor(p, to);
  if (!missing.length) return;
  throw new AppError(
    "PARCEL_INCOMPLETE",
    `${p.trackingId} still needs the ${describeMissing(missing)}. Complete the order before ${to === "IN_TRANSIT" ? "moving it between hubs" : "assigning a delivery rider"}.`,
    HttpStatus.CONFLICT,
    { missingFields: missing, to },
  );
}

/**
 * Where the parcel was priced to: its destination, or for an incomplete parcel the default the
 * import used (pricingSnapshot.destination), else the pickup area.
 */
export function pricedDestination(p: { deliveryDistrict: string | null; deliveryZone: string | null; pickupDistrict: string; pickupZone: string; pricingSnapshot?: unknown }) {
  const snap = (p.pricingSnapshot ?? {}) as { destination?: { district?: string; zone?: string } };
  return {
    district: p.deliveryDistrict ?? snap.destination?.district ?? p.pickupDistrict,
    zone: p.deliveryZone ?? snap.destination?.zone ?? p.pickupZone,
  };
}
