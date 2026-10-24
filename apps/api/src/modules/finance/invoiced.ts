import type { Db } from "../../common/prisma.service";

export type InvoicedRef = { id: string; number: string; status: string };

/**
 * Delivered parcels already billed on an issued or paid invoice: tracking ID → the invoice. An invoice bills
 * the deliveries chosen for it (its lines; return-charge lines are kind RETURN), not everything in its period,
 * so the rest of the period can go on another invoice.
 */
export async function invoicedParcels(db: Db, merchantIds: string[]): Promise<Map<string, InvoicedRef>> {
  const billed = new Map<string, InvoicedRef>();
  if (!merchantIds.length) return billed;
  const invoices = await db.invoice.findMany({
    where: { merchantId: { in: merchantIds }, status: { not: "VOID" } },
    select: { id: true, number: true, status: true, lines: true },
    orderBy: { issuedAt: "asc" },
  });
  for (const i of invoices) for (const trackingId of deliveryTrackingIds(i.lines)) billed.set(trackingId, { id: i.id, number: i.number, status: i.status });
  return billed;
}

/** The tracking IDs an invoice bills deliveries for (its lines without the return charges). */
export const deliveryTrackingIds = (lines: unknown): string[] =>
  (Array.isArray(lines) ? (lines as { trackingId?: unknown; kind?: unknown }[]) : [])
    .filter(l => typeof l?.trackingId === "string" && l.kind !== "RETURN")
    .map(l => l.trackingId as string);
