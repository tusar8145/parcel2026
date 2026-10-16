import type { Parcel } from "../../generated/prisma/client";

/** Used when a parcel's frozen rate card has no returnPercent (older bookings). */
export const DEFAULT_RETURN_PERCENT = 50;

/**
 * Return (RTO) charge: the parcel's delivery charge × the returnPercent of the rate card
 * frozen at booking time, rounded up to whole taka.
 */
export function returnChargeFor(parcel: Pick<Parcel, "totalCharge" | "pricingSnapshot">): number {
  const config = (parcel.pricingSnapshot as { config?: { returnPercent?: unknown } } | null)?.config;
  const pct = typeof config?.returnPercent === "number" && config.returnPercent >= 0 && config.returnPercent <= 100 ? config.returnPercent : DEFAULT_RETURN_PERCENT;
  return Math.ceil((Number(parcel.totalCharge) * pct) / 100);
}
