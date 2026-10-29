import { HttpStatus, Injectable } from "@nestjs/common";
import { z } from "zod";
import { PRODUCT_TYPE_LABEL, PRODUCT_TYPES, type ParcelStatus, type ProductType } from "@paira-express/shared";
import { AuditService } from "../../common/audit.service";
import { actorLabel, type Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, notFound } from "../../common/errors";
import { operationNow } from "../../common/operation-time";
import { PrismaService, type Db } from "../../common/prisma.service";
import { RealtimeService } from "../../common/realtime.service";
import type { Parcel, Prisma } from "../../generated/prisma/client";
import { PackagesService } from "../packages/packages.service";
import { returnChargeFor } from "../returns/return-charge";
import { parcelEvent } from "./parcel-workflow.service";
import { ParcelsService } from "./parcels.service";

export const productTypeChangeSchema = z.object({
  productType: z.enum(PRODUCT_TYPES, "Choose Regular, Document or Books"),
  expectedVersion: z.number().int().optional(),
});
export const returnChargeChangeSchema = z.object({
  /** true: the package's return charge; false: no return charge. */
  charge: z.boolean(),
  reason: z.string().trim().max(300).optional(),
});

const taka = (n: number) => `৳${Math.round(n).toLocaleString("en-US")}`;
const CLOSED: ParcelStatus[] = ["CANCELLED", "PICKUP_CANCELLED", "RETURNED"] as ParcelStatus[];

/**
 * Courier Operations › parcel › More: rare corrections.
 * - Change product type: what is sent (Regular / Document / Books) as priced; the delivery charge is
 *   re-priced with the parcel's frozen package. Until its cash is settled or it is on an invoice.
 * - Return charge: charge or don't charge a return (a partial delivery's return order, or a parcel being
 *   returned). Until it is returned (the charge is billed then).
 */
@Injectable()
export class ParcelCorrectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly parcels: ParcelsService,
    private readonly packages: PackagesService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Settled or billed already (Accounts): one of its lines is in a settlement or on a bill that isn't cancelled / void. */
  private async billed(db: Db, parcel: Parcel) {
    const line = await db.accountEntry.findFirst({
      where: { parcelId: parcel.id, OR: [{ payout: { status: { not: "CANCELLED" } } }, { bill: { status: { not: "VOID" } } }] },
      select: { id: true },
    });
    return !!line;
  }

  async changeProductType(actor: Actor, trackingId: string, input: z.infer<typeof productTypeChangeSchema>, meta: RequestMeta) {
    const result = await this.prisma.$transaction(async tx => {
      const parcel = await this.parcels.loadForUpdate(actor, trackingId, tx);
      if (input.expectedVersion !== undefined && input.expectedVersion !== parcel.version)
        throw new AppError("PARCEL_CHANGED", "This parcel was just updated by someone else. Refresh and try again.", HttpStatus.CONFLICT);
      if (CLOSED.includes(parcel.status as ParcelStatus)) throw new AppError("PARCEL_LOCKED", `${parcel.trackingId} is closed; its price can no longer change.`, HttpStatus.CONFLICT);
      const from = (parcel.productType ?? "REGULAR") as ProductType;
      if (from === input.productType) throw new AppError("NO_CHANGE", `${parcel.trackingId} is already priced as ${PRODUCT_TYPE_LABEL[from]}.`, HttpStatus.CONFLICT);
      if (await this.billed(tx, parcel)) throw new AppError("PARCEL_BILLED", `${parcel.trackingId} is already settled or invoiced; its price can no longer change.`, HttpStatus.CONFLICT);
      const quote = await this.packages.reprice(parcel, { productType: input.productType }, tx);
      if (!quote) throw new AppError("NOT_PACKAGE_PRICED", `${parcel.trackingId} was booked before service packages; its product type doesn't price it.`, HttpStatus.CONFLICT);
      const totalCharge = quote.totalCharge + Number(parcel.reattemptCharge);
      const keep = parcel.pricingSnapshot as { destination?: unknown } | null;
      const updated = await tx.parcel.update({
        where: { id: parcel.id, version: parcel.version },
        data: {
          ...quote.columns,
          totalCharge,
          productType: input.productType,
          pricingSnapshot: this.packages.snapshot(quote, keep?.destination ? { destination: keep.destination } : {}) as Prisma.InputJsonObject,
          version: { increment: 1 },
        },
      });
      // Delivered and not settled / billed yet: its open delivery-charge line follows the new price (Accounts).
      await tx.accountEntry.updateMany({ where: { parcelId: parcel.id, type: "DELIVERY_CHARGE", payoutId: null, billId: null }, data: { amount: -totalCharge } });
      await tx.trackingEvent.create({
        data: {
          parcelId: parcel.id,
          createdAt: operationNow(),
          status: parcel.status,
          title: "Product type changed",
          description: `Priced as ${PRODUCT_TYPE_LABEL[input.productType]} instead of ${PRODUCT_TYPE_LABEL[from]}: delivery charge ${taka(Number(parcel.totalCharge))} → ${taka(totalCharge)}.`,
          visibility: "INTERNAL",
          actorUserId: actor.kind === "user" ? actor.userId : null,
          actorLabel: actorLabel(actor),
        },
      });
      await this.audit.record(
        actor,
        { action: "parcel.product_type_change", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId, from, to: input.productType, totalCharge: { from: Number(parcel.totalCharge), to: totalCharge } } },
        meta,
        tx,
      );
      return { updated, from, before: Number(parcel.totalCharge), totalCharge };
    });
    this.realtime.publish(parcelEvent(result.updated));
    return { trackingId: result.updated.trackingId, productType: input.productType, from: result.from, totalCharge: { from: result.before, to: result.totalCharge } };
  }

  async setReturnCharge(actor: Actor, trackingId: string, input: z.infer<typeof returnChargeChangeSchema>, meta: RequestMeta) {
    const result = await this.prisma.$transaction(async tx => {
      const parcel = await this.parcels.loadForUpdate(actor, trackingId, tx);
      const returning = !!parcel.returnOfId || parcel.returnRequestedAt !== null || parcel.status === "RETURN_SCHEDULED";
      if (!returning) throw new AppError("NOT_A_RETURN", `${parcel.trackingId} isn't being returned; a return charge applies only to returns.`, HttpStatus.CONFLICT);
      if (parcel.status === "RETURNED") throw new AppError("RETURN_BILLED", `${parcel.trackingId} is already returned and its return charge billed.`, HttpStatus.CONFLICT);
      // A return order is charged from the parcel it carries back; a returning parcel from its own price.
      const origin = parcel.returnOfId ? await tx.parcel.findUnique({ where: { id: parcel.returnOfId } }) : parcel;
      if (!origin) throw notFound("Parcel");
      const amount = input.charge ? returnChargeFor(origin) : 0;
      const updated = await tx.parcel.update({ where: { id: parcel.id }, data: { returnCharge: amount, returnChargeWaived: !input.charge, version: { increment: 1 } } });
      await tx.trackingEvent.create({
        data: {
          parcelId: parcel.id,
          createdAt: operationNow(),
          status: parcel.status,
          title: input.charge ? "Return charge applied" : "No return charge",
          description: `${input.charge ? `Return charge ${taka(amount)}` : "This return isn't charged"}${input.reason ? `: ${input.reason}` : ""}.`,
          visibility: "INTERNAL",
          actorUserId: actor.kind === "user" ? actor.userId : null,
          actorLabel: actorLabel(actor),
        },
      });
      await this.audit.record(
        actor,
        { action: "parcel.return_charge", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId, charge: input.charge, amount, from: parcel.returnCharge == null ? null : Number(parcel.returnCharge), reason: input.reason ?? null } },
        meta,
        tx,
      );
      return { updated, amount };
    });
    this.realtime.publish(parcelEvent(result.updated));
    return { trackingId: result.updated.trackingId, returnCharge: result.amount, waived: result.updated.returnChargeWaived };
  }
}
