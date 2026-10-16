import { Prisma } from "../../generated/prisma/client";
import type { Db } from "../../common/prisma.service";

/**
 * Return (RTO) charges: the returns module books each one in the ledger when a return run
 * completes (DELIVERY_CHARGE_EARNED, reference "<trackingId>:return": receivable + revenue/VAT).
 * Finance turns each booked charge into a RETURN_CHARGE merchant adjustment so it is billed
 * exactly once: deducted from the next settlement or, if an invoice comes first, billed on it.
 * Call under the merchant lock (lockMerchant). Returns the open, unbilled return charges.
 */
export async function syncReturnCharges(db: Db, merchantId: string) {
  const missing = await db.$queryRaw<{ reference: string; occurredAt: Date; amount: Prisma.Decimal }[]>`
    SELECT e.reference, e."occurredAt", SUM(l.debit) AS amount
    FROM journal_entries e JOIN journal_lines l ON l."entryId" = e.id
    WHERE e."merchantId" = ${merchantId}::uuid AND e."eventType" = 'DELIVERY_CHARGE_EARNED' AND e.reference LIKE '%:return'
      AND NOT EXISTS (SELECT 1 FROM merchant_adjustments a WHERE a."merchantId" = e."merchantId" AND a.kind = 'RETURN_CHARGE' AND a.reference = e.reference)
    GROUP BY e.id, e.reference, e."occurredAt"`;
  if (missing.length)
    await db.merchantAdjustment.createMany({
      data: missing.map(m => ({
        merchantId,
        kind: "RETURN_CHARGE" as const,
        amount: new Prisma.Decimal(m.amount),
        description: `Return charge ${m.reference.replace(/:return$/, "")}`,
        reference: m.reference,
        createdAt: m.occurredAt,
      })),
    });
}

export const returnTrackingId = (reference: string | null) => (reference ?? "").replace(/:return$/, "");
