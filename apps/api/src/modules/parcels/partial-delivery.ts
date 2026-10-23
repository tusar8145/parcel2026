import { HttpStatus } from "@nestjs/common";
import { z } from "zod";
import { nextTrackingId } from "../../common/counters";
import { operationNow } from "../../common/operation-time";
import type { Db } from "../../common/prisma.service";
import { AppError } from "../../common/errors";
import type { Parcel, Prisma } from "../../generated/prisma/client";
import { returnChargeFor } from "../returns/return-charge";
import { parcelEvent, type AfterCommit } from "./parcel-workflow.service";

/**
 * Partial delivery (docs/architecture-contracts.md "Partial delivery"): at delivery the recipient keeps
 * part of the order. The rider (or the hub desk) ticks Partial delivery and enters the cash actually
 * collected (0 … the COD amount); the delivery charge doesn't change. The parcel is DELIVERED with
 * `partialDelivery`, and what came back goes to the merchant on a new return order: same merchant and
 * addresses, COD 0, no delivery charge, RETURN_SCHEDULED at the hub, so Return rider assign / Return
 * entry take it back. Its `returnCharge` (the package's return percent of the original delivery charge,
 * or 0 when operations waive it) is billed when it is returned, like any return.
 */
export const partialDeliveryFields = {
  /** Partial delivery: the recipient kept part of the order; `codCollected` is the cash actually collected. */
  partial: z.boolean().optional(),
};

/** The cash for a delivery: the full COD, or (partial) what was entered, from 0 to the COD amount. */
export function cashFor(parcel: Pick<Parcel, "trackingId" | "codAmount">, input: { partial?: boolean; codCollected?: number }) {
  const cod = Number(parcel.codAmount);
  if (!input.partial) return { cod, collected: cod };
  if (input.codCollected === undefined || input.codCollected === null || Number.isNaN(input.codCollected))
    throw new AppError("COD_COLLECTED_REQUIRED", "Enter the cash collected for this partial delivery.", HttpStatus.UNPROCESSABLE_ENTITY);
  const collected = Math.round(input.codCollected * 100) / 100;
  if (collected < 0 || collected > cod) throw new AppError("COD_COLLECTED_INVALID", `${parcel.trackingId}: the cash collected can be from ৳0 to the COD amount (৳${cod.toLocaleString("en-US")}).`, HttpStatus.UNPROCESSABLE_ENTITY);
  return { cod, collected };
}

/** The parcel columns of a partial delivery (with DELIVERED). */
export const partialData = (collected: number, note?: string | null) => ({ partialDelivery: true, codCollectedAmount: collected, partialNote: note?.trim() || null });

/** The new return order carrying back what the recipient didn't keep. */
export async function createPartialReturn(tx: Db, parcel: Parcel, input: { hubId: string | null; note?: string | null; by: string }, after: AfterCommit): Promise<Parcel> {
  const at = operationNow();
  const charge = returnChargeFor(parcel);
  const trackingId = await nextTrackingId(tx);
  const note = input.note?.trim() || null;
  const data: Prisma.ParcelUncheckedCreateInput = {
    trackingId,
    channel: parcel.channel,
    status: "RETURN_SCHEDULED",
    customerId: parcel.customerId,
    merchantId: parcel.merchantId,
    senderName: parcel.senderName,
    senderPhone: parcel.senderPhone,
    pickupCategory: parcel.pickupCategory,
    pickupStreet: parcel.pickupStreet,
    pickupArea: parcel.pickupArea,
    pickupZone: parcel.pickupZone,
    pickupDistrict: parcel.pickupDistrict,
    pickupLat: parcel.pickupLat,
    pickupLng: parcel.pickupLng,
    pickupHubId: parcel.pickupHubId,
    recipientName: parcel.recipientName,
    recipientPhone: parcel.recipientPhone,
    deliveryCategory: parcel.deliveryCategory,
    deliveryStreet: parcel.deliveryStreet,
    deliveryArea: parcel.deliveryArea,
    deliveryZone: parcel.deliveryZone,
    deliveryDistrict: parcel.deliveryDistrict,
    type: parcel.type,
    serviceLevel: parcel.serviceLevel,
    weightKg: parcel.weightKg,
    contents: note ?? parcel.contents,
    documentType: parcel.documentType,
    instructions: note,
    // Nothing to collect and no delivery charge: only the return charge, billed when it is returned.
    codAmount: 0,
    baseCharge: 0,
    weightCharge: 0,
    serviceCharge: 0,
    codFee: 0,
    discount: 0,
    totalCharge: 0,
    reattemptCharge: 0,
    pricingSnapshot: (parcel.pricingSnapshot ?? {}) as Prisma.InputJsonValue,
    currentHubId: input.hubId ?? parcel.currentHubId,
    intake: parcel.intake,
    packageVersionId: parcel.packageVersionId,
    firstMile: parcel.firstMile,
    lastMile: "DOORSTEP",
    speedOption: parcel.speedOption,
    productId: parcel.productId,
    productName: parcel.productName,
    productType: parcel.productType,
    services: parcel.services,
    notifications: [],
    returnReason: `Partial delivery of ${parcel.trackingId}${note ? `: ${note}` : ""}`.slice(0, 300),
    returnRequestedAt: at,
    returnRequestedBy: input.by,
    returnCharge: charge,
    returnOfId: parcel.id,
  };
  const created = await tx.parcel.create({ data });
  await tx.trackingEvent.create({
    data: {
      parcelId: created.id,
      createdAt: at,
      status: "RETURN_SCHEDULED",
      title: "Return order created",
      description: `What the recipient didn't keep on the partial delivery of ${parcel.trackingId} goes back to the sender.${note ? ` ${note}` : ""}`,
      metadata: { returnOf: parcel.trackingId, partialDelivery: true },
      actorLabel: input.by,
    },
  });
  await tx.trackingEvent.create({
    data: {
      parcelId: parcel.id,
      createdAt: at,
      status: "DELIVERED",
      title: "Return order created",
      description: `The items not kept go back to the sender as ${trackingId}.`,
      visibility: "INTERNAL",
      metadata: { returnOrder: trackingId },
      actorLabel: input.by,
    },
  });
  after.realtime.push(parcelEvent(created, "parcel.created"));
  return created;
}
