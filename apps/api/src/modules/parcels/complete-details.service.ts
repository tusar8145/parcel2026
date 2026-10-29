import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import {
  ADDRESS_CATEGORIES,
  PARCEL_STATUS_LABEL,
  SERVICE_LEVELS,
  TERMINAL_STATUSES,
  phoneSchema,
  parseSpeedOption,
  quoteParcel,
  speedOptionSchema,
  type SpeedOption,
  rateCardConfigSchema,
  type ParcelStatus,
  type ServiceLevel,
} from "@paira-express/shared";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { actorLabel, merchantIdsOf, type Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, forbidden } from "../../common/errors";
import type { Parcel, Prisma, Segment } from "../../generated/prisma/client";
import { PricingService, type PricingOrigin } from "../pricing/pricing.service";
import { slaDueDates } from "../sla/sla-policy";
import { ParcelsService } from "./parcels.service";
import { ParcelWorkflowService, parcelEvent, type AfterCommit } from "./parcel-workflow.service";
import { opsHubScope } from "./ops-scope";
import { describeMissing, missingFieldsOf } from "./incomplete";
import { resolvePlace } from "./places";
import { PackagesService } from "../packages/packages.service";

const optionalText = (max: number) => z.string().trim().max(max, `Use at most ${max} characters`).optional();
const upper = (values: readonly string[], message: string) =>
  z
    .string()
    .transform(v => v.trim().toUpperCase().replace(/\s+/g, "_"))
    .pipe(z.enum(values as [string, ...string[]], message));

/** Missing (or defaulted) details of an incomplete order. Only the fields sent change. */
export const completeParcelSchema = z
  .object({
    recipient: z.object({ name: z.string().trim().min(1, "Enter the recipient's name").max(120).optional(), phone: phoneSchema.optional() }).optional(),
    delivery: z
      .object({
        street: z.string().trim().min(1, "Enter the delivery address").max(200).optional(),
        area: optionalText(120),
        district: z.string().trim().min(1).max(80).optional(),
        zone: z.string().trim().min(1).max(80).optional(),
        category: upper(ADDRESS_CATEGORIES, "Choose Home, Office or Other").optional(),
      })
      .optional(),
    weightKg: z.coerce.number("Enter the weight in kg").positive("Weight must be more than 0").max(50, "Weight can be at most 50 kg").optional(),
    /** Old field (Regular / Express; "Same day" still means Express). The forms send `speed`. */
    serviceLevel: upper(SERVICE_LEVELS, "Choose Regular, Same day or Express").optional(),
    /** The service from the parcel's package (Regular, Express, On-demand, B2B, Trade, Corporate Urgent). */
    speed: speedOptionSchema.optional(),
    /** Why (internal; staff only). */
    note: optionalText(500).transform(v => v || undefined),
    expectedVersion: z.number().int().min(0).optional(),
  })
  .refine(v => v.recipient?.name || v.recipient?.phone || v.delivery || v.weightKg !== undefined || v.serviceLevel || v.speed, { message: "Send at least one detail" });

type Snapshot = { config?: unknown; discountPercent?: number; segment?: Segment; origin?: PricingOrigin; destination?: unknown } & Record<string, unknown>;
const MERCHANT_EDITABLE: ParcelStatus[] = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];
const STAFF_LOCKED: ParcelStatus[] = [...TERMINAL_STATUSES, "OUT_FOR_DELIVERY"];

/**
 * Completing an incomplete order (booked by a spreadsheet import with delivery details missing):
 * the merchant while it is waiting for pickup, operations until it goes out for delivery. The
 * parcel is re-priced with the tariff frozen at booking, the change is tracked and audited, and
 * once nothing is missing the steps it blocked (delivery rider, hub transfer) are allowed.
 */
@Injectable()
export class CompleteDetailsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly parcels: ParcelsService,
    private readonly workflow: ParcelWorkflowService,
    private readonly pricing: PricingService,
    private readonly audit: AuditService,
  ) {}

  /** Service packages (global module; property injection keeps the constructor stable). */
  @Inject(PackagesService) private readonly packages!: PackagesService;

  async complete(actor: Actor, trackingId: string, input: z.infer<typeof completeParcelSchema>, meta: RequestMeta) {
    const after = this.workflow.newAfterCommit();
    await this.prisma.$transaction(tx => this.apply(tx, actor, trackingId, input, meta, after));
    await this.workflow.flush(after);
    return this.parcels.detail(actor, trackingId);
  }

  /**
   * The charge a completion would give the parcel, without changing it (the bulk update preview):
   * the same engine and frozen package / rate card as `complete`. `input` holds resolved values
   * (district / zone already checked against the catalog). Throws what `complete` would throw for
   * the price (e.g. SERVICE_NOT_IN_PACKAGE).
   */
  async previewCharge(parcel: Parcel, input: { delivery?: { area?: string; district?: string; zone?: string }; weightKg?: number; serviceLevel?: ServiceLevel }, db: Db = this.prisma) {
    const district = input.delivery?.district ?? parcel.deliveryDistrict;
    const zone = input.delivery?.zone ?? (input.delivery?.district && input.delivery.district !== parcel.deliveryDistrict ? null : parcel.deliveryZone);
    const { price } = await this.priceOf(db, parcel, {
      deliveryArea: input.delivery?.area !== undefined ? input.delivery.area || null : parcel.deliveryArea,
      deliveryDistrict: district,
      deliveryZone: zone,
      weightKg: input.weightKg ?? Number(parcel.weightKg),
      serviceLevel: input.serviceLevel ?? (parcel.serviceLevel as ServiceLevel),
    });
    return { before: Number(parcel.totalCharge), after: price.totalCharge };
  }

  /** The parcel's price with the given details: the package frozen at booking (speed follows a changed service level); older parcels their rate card. */
  private async priceOf(
    db: Db,
    parcel: Parcel,
    next: { deliveryArea: string | null; deliveryDistrict: string | null; deliveryZone: string | null; weightKg: number; serviceLevel: ServiceLevel },
    speed?: SpeedOption,
  ) {
    const snap = (parcel.pricingSnapshot ?? {}) as Snapshot;
    const dest = { district: next.deliveryDistrict ?? (snap.destination as { district?: string } | undefined)?.district ?? parcel.pickupDistrict, zone: next.deliveryZone ?? (snap.destination as { zone?: string } | undefined)?.zone ?? parcel.pickupZone };
    const quoteInput = {
      pickupDistrict: snap.origin?.district ?? parcel.pickupDistrict,
      pickupZone: snap.origin?.zone ?? parcel.pickupZone,
      deliveryDistrict: dest.district,
      deliveryZone: dest.zone,
      weightKg: next.weightKg,
      serviceLevel: next.serviceLevel,
      codAmount: Number(parcel.codAmount),
      discountPercent: snap.discountPercent ?? 0,
      parcelType: parcel.type,
      documentType: parcel.documentType ?? undefined,
    };
    const packaged = await this.packages.reprice(
      { ...parcel, deliveryArea: next.deliveryArea ?? parcel.deliveryArea },
      { delivery: { district: dest.district, zone: dest.zone, area: next.deliveryArea }, weightKg: next.weightKg, ...(speed ? { speed } : next.serviceLevel !== parcel.serviceLevel ? { speed: parseSpeedOption(next.serviceLevel) ?? (next.serviceLevel === "SAME_DAY" ? "EXPRESS" : "REGULAR") } : {}) },
      db,
    );
    const frozen = rateCardConfigSchema.safeParse(snap.config);
    const price = packaged
      ? { ...packaged.columns, totalCharge: packaged.totalCharge + Number(parcel.reattemptCharge) }
      : frozen.success
        ? quoteParcel(frozen.data, quoteInput)
        : await this.pricing.quote(snap.segment ?? "ECOMMERCE", quoteInput, db, { merchantId: parcel.merchantId });
    return { price, packaged, dest, snap };
  }

  private async apply(tx: Db, actor: Actor, trackingId: string, input: z.infer<typeof completeParcelSchema>, meta: RequestMeta, after: AfterCommit) {
    const parcel = await this.parcels.loadForUpdate(actor, trackingId, tx);
    if (input.expectedVersion !== undefined && input.expectedVersion !== parcel.version)
      throw new AppError("PARCEL_CHANGED", "This parcel was just updated by someone else. Refresh and try again.", HttpStatus.CONFLICT);
    if (!parcel.incomplete)
      throw new AppError("PARCEL_COMPLETE", `${parcel.trackingId} already has every delivery detail. Use the regular corrections instead.`, HttpStatus.CONFLICT);
    const status = parcel.status as ParcelStatus;
    const isOwner = !!parcel.merchantId && merchantIdsOf(actor).includes(parcel.merchantId);
    const asStaff = !isOwner && actor.permissions.has("parcel:dispatch");
    if (!isOwner && !asStaff) throw forbidden("Only the merchant or operations can complete this order");
    if (isOwner && !MERCHANT_EDITABLE.includes(status))
      throw new AppError("PARCEL_LOCKED", `${parcel.trackingId} is "${PARCEL_STATUS_LABEL[status]}". Ask operations to complete its details.`, HttpStatus.CONFLICT, { status });
    if (asStaff && STAFF_LOCKED.includes(status))
      throw new AppError("PARCEL_LOCKED", `${parcel.trackingId} is "${PARCEL_STATUS_LABEL[status]}"; its details can no longer change.`, HttpStatus.CONFLICT, { status });
    const scope = asStaff ? opsHubScope(actor) : null;
    if (scope && parcel.currentHubId && !scope.includes(parcel.currentHubId)) throw forbidden(`${parcel.trackingId} is at another hub. Only that hub or an operations manager can update it`);

    // Destination: checked against the service catalog (a zone alone finds its district).
    const catalog = await this.pricing.catalog(tx);
    const district = input.delivery?.district ?? parcel.deliveryDistrict;
    const zone = input.delivery?.zone ?? (input.delivery?.district && input.delivery.district !== parcel.deliveryDistrict ? null : parcel.deliveryZone);
    const place = resolvePlace(catalog, district, zone);
    if (!place.ok) throw new AppError("VALIDATION_FAILED", `${place.column}: ${place.message}`, HttpStatus.UNPROCESSABLE_ENTITY, [{ path: `delivery.${place.column}`, message: place.message }]);

    const next = {
      recipientName: input.recipient?.name ?? parcel.recipientName,
      recipientPhone: input.recipient?.phone ?? parcel.recipientPhone,
      deliveryStreet: input.delivery?.street ?? parcel.deliveryStreet,
      deliveryArea: input.delivery?.area !== undefined ? input.delivery.area || null : parcel.deliveryArea,
      deliveryDistrict: place.district,
      deliveryZone: place.zone,
      deliveryCategory: (input.delivery?.category as (typeof ADDRESS_CATEGORIES)[number] | undefined) ?? parcel.deliveryCategory,
      weightKg: input.weightKg ?? Number(parcel.weightKg),
      serviceLevel: (input.serviceLevel as ServiceLevel | undefined) ?? (parcel.serviceLevel as ServiceLevel),
    };
    // A new service (package option): re-priced through the parcel's package.
    const speed = input.speed && input.speed !== parcel.speedOption ? input.speed : undefined;
    const changed = (
      [
        ["recipient name", next.recipientName !== parcel.recipientName],
        ["recipient phone", next.recipientPhone !== parcel.recipientPhone],
        ["delivery address", next.deliveryStreet !== parcel.deliveryStreet || next.deliveryArea !== parcel.deliveryArea || next.deliveryCategory !== parcel.deliveryCategory],
        ["destination", next.deliveryDistrict !== parcel.deliveryDistrict || next.deliveryZone !== parcel.deliveryZone],
        ["weight", next.weightKg !== Number(parcel.weightKg)],
        ["service", next.serviceLevel !== parcel.serviceLevel || !!speed],
      ] as const
    )
      .filter(([, c]) => c)
      .map(([label]) => label);
    if (!changed.length) throw new AppError("NOTHING_CHANGED", "These are already the order's details", HttpStatus.UNPROCESSABLE_ENTITY);
    const missing = missingFieldsOf(next);

    // Re-price to the (now known) destination with the tariff frozen at booking.
    const { price, packaged, dest, snap } = await this.priceOf(tx, parcel, next, speed);
    const { destination: _default, ...restSnap } = snap;
    const needsDefault = missing.includes("district") || missing.includes("zone");
    const pricingSnapshot = (packaged ? this.packages.snapshot(packaged, needsDefault ? { destination: dest } : {}) : needsDefault ? { ...restSnap, destination: dest } : restSnap) as Prisma.InputJsonObject;
    if (packaged) Object.assign(next, { serviceLevel: packaged.serviceLevel });
    const oldCharge = Number(parcel.totalCharge);

    // A pickup booking that hasn't been collected gets SLA due times for its real destination.
    const resetSla = status === "PENDING_CONFIRMATION" && parcel.intake === "PICKUP";
    const due = resetSla
      ? await slaDueDates(tx, { serviceLevel: next.serviceLevel, pickupDistrict: parcel.pickupDistrict, pickupZone: parcel.pickupZone, deliveryDistrict: dest.district, deliveryZone: dest.zone })
      : null;

    const data: Prisma.ParcelUncheckedUpdateManyInput = {
      ...next,
      incomplete: missing.length > 0,
      missingFields: missing,
      baseCharge: price.baseCharge,
      weightCharge: price.weightCharge,
      serviceCharge: price.serviceCharge,
      codFee: price.codFee,
      discount: price.discount,
      totalCharge: price.totalCharge,
      pricingSnapshot,
      ...(packaged ? { speedOption: packaged.selection.speed } : {}),
      ...(due ? { pickupDueAt: due.pickupDueAt, deliveryDueAt: due.deliveryDueAt } : {}),
      version: { increment: 1 },
    };
    // The delivery code goes to the recipient's phone, so a new number gets a fresh code.
    if (next.recipientPhone && next.recipientPhone !== parcel.recipientPhone && parcel.deliveryOtpEncrypted)
      data.deliveryOtpEncrypted = await this.workflow.issueDeliveryCode(tx, { ...parcel, recipientPhone: next.recipientPhone }, after);
    const { count } = await tx.parcel.updateMany({ where: { id: parcel.id, version: parcel.version }, data });
    if (!count) throw new AppError("PARCEL_CHANGED", "This parcel was just updated by someone else. Refresh and try again.", HttpStatus.CONFLICT);

    const by = isOwner ? "The sender" : "Operations";
    const priceText = price.totalCharge !== oldCharge ? ` Delivery charge ৳${oldCharge.toLocaleString("en-BD")} → ৳${price.totalCharge.toLocaleString("en-BD")}.` : "";
    await tx.trackingEvent.createMany({
      data: [
        {
          parcelId: parcel.id,
          status: parcel.status,
          title: missing.length ? "Order details updated" : "Order details completed",
          description: missing.length ? `${by} added delivery details. Still needed: ${describeMissing(missing)}.` : `${by} completed the delivery details.`,
          location: isOwner ? "Sender" : "Courier operations",
          visibility: "PUBLIC",
          actorUserId: actor.kind === "user" ? actor.userId : null,
          actorLabel: actorLabel(actor),
        },
        {
          parcelId: parcel.id,
          status: parcel.status,
          title: "Details changed",
          description: `Updated: ${changed.join(", ")}.${priceText}${input.note ? ` ${input.note}` : ""}`,
          visibility: "INTERNAL",
          actorUserId: actor.kind === "user" ? actor.userId : null,
          actorLabel: actorLabel(actor),
        },
      ],
    });
    await this.audit.record(
      actor,
      {
        action: "parcel.complete_details",
        entityType: "parcel",
        entityId: parcel.id,
        data: { trackingId: parcel.trackingId, changed, missingBefore: parcel.missingFields, missingAfter: missing, charge: { before: oldCharge, after: price.totalCharge } },
      },
      meta,
      tx,
    );
    after.realtime.push(parcelEvent({ ...parcel }));
  }
}
