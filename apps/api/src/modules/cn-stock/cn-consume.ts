import { HttpStatus } from "@nestjs/common";
import type { Db } from "../../common/prisma.service";
import { AppError } from "../../common/errors";
import { normalizeTrackingId } from "../../common/counters";

/**
 * Uses a pre-printed consignment number when a parcel is booked (inside the booking
 * transaction). The CN must be AVAILABLE and, when its batch was issued to a merchant,
 * booked for that merchant. Returns the tracking ID to use;
 * call `linkCn` once the parcel exists.
 */
export async function claimCn(tx: Db, rawCn: string, booking: { merchantId: string | null; channel: string }) {
  const cn = normalizeTrackingId(rawCn);
  // Labels are handed to merchants and hub counters; website senders get a new tracking ID.
  if (booking.channel === "WEBSITE") throw new AppError("CN_NOT_ALLOWED", "Pre-printed consignment numbers are used by merchants and hub counters only", 422);
  const stock = await tx.cnStock.findUnique({ where: { cn }, include: { batch: { select: { merchantId: true, number: true } } } });
  if (!stock) throw new AppError("CN_UNKNOWN", `${cn} isn't a consignment number from our stock`, 422);
  if (stock.batch.merchantId && stock.batch.merchantId !== booking.merchantId)
    throw new AppError("CN_NOT_YOURS", `${cn} was issued to another account`, HttpStatus.FORBIDDEN);
  // The conditional update makes two bookings of the same label race safely: only one wins.
  const { count } = await tx.cnStock.updateMany({ where: { id: stock.id, status: "AVAILABLE" }, data: { status: "USED", usedAt: new Date() } });
  if (!count)
    throw new AppError(
      stock.status === "VOID" ? "CN_VOID" : "CN_USED",
      stock.status === "VOID" ? `${cn} was voided and can't be used` : `${cn} has already been used for another parcel`,
      HttpStatus.CONFLICT,
    );
  return { cn, stockId: stock.id };
}

export function linkCn(tx: Db, stockId: string, parcelId: string) {
  return tx.cnStock.update({ where: { id: stockId }, data: { parcelId } });
}
