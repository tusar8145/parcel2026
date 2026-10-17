import type { Parcel } from "../../generated/prisma/client";

/** Used when a parcel's frozen rate card has no returnPercent (older bookings). */
export const DEFAULT_RETURN_PERCENT = 50;

/**
 * Return (RTO) charge: the parcel's delivery charge × the return percentage frozen at booking (the
 * service package's "Default return charge", or the old rate card's), rounded up to whole taka.
 * Re-attempt fees aren't part of the base.
 */
export function returnChargeFor(parcel: Pick<Parcel, "totalCharge" | "pricingSnapshot"> & Partial<Pick<Parcel, "reattemptCharge">>): number {
  const snap = parcel.pricingSnapshot as { engine?: string; prices?: { returnPercent?: unknown }; config?: { returnPercent?: unknown } } | null;
  const value = snap?.engine === "package" || snap?.engine === "package-v2" ? snap.prices?.returnPercent : snap?.config?.returnPercent;
  const pct = typeof value === "number" && value >= 0 && value <= 100 ? value : DEFAULT_RETURN_PERCENT;
  return Math.ceil(((Number(parcel.totalCharge) - Number(parcel.reattemptCharge ?? 0)) * pct) / 100);
}
