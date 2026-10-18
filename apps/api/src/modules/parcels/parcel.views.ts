import {
  FIRST_MILE_LABEL,
  LAST_MILE_LABEL,
  PARCEL_NOTIFICATIONS,
  proofMethodsFor,
  SPEED_LABEL,
  SERVICE_LEVEL_LABEL,
  TRACKING_STAGES,
  isCustomerCancellable,
  parcelStatusLabel,
  trackingStage,
  type ParcelStatus,
} from "@delivery-fast/shared";
import type { Prisma } from "../../generated/prisma/client";
import { MISSING_LABEL, type MissingField } from "./incomplete";

export const parcelInclude = {
  pickupRider: { select: { id: true, code: true, user: { select: { name: true, phone: true } } } },
  deliveryRider: { select: { id: true, code: true, user: { select: { name: true, phone: true } } } },
  currentHub: { select: { id: true, code: true, name: true } },
  dropOffHub: { select: { id: true, code: true, name: true, address: true } },
  collectHub: { select: { id: true, code: true, name: true, address: true } },
  bookingBatch: { select: { id: true, number: true } },
  merchant: { select: { id: true, code: true, name: true, type: true } },
  proof: { select: { method: true, receivedBy: true, fileId: true, otpVerified: true, createdAt: true } },
  codCollection: { select: { amount: true, state: true, collectedAt: true } },
  events: { orderBy: { createdAt: "asc" } },
  // Delivery attempts (a handful per parcel, loaded in one batched query for a whole list page).
  attempts: {
    orderBy: { createdAt: "asc" },
    select: { id: true, outcome: true, reason: true, nextAction: true, note: true, createdAt: true, rider: { select: { code: true, user: { select: { name: true } } } } },
  },
} satisfies Prisma.ParcelInclude;

export type ParcelWithRelations = Prisma.ParcelGetPayload<{ include: typeof parcelInclude }>;

const num = (d: Prisma.Decimal | null | undefined) => (d == null ? null : Number(d));
const CATEGORY_LABEL = { HOME: "Home", OFFICE: "Office", OTHER: "Other" } as const;
const riderLabel = (r: ParcelWithRelations["pickupRider"]) => (r ? `${r.code} · ${r.user.name}` : null);
const joinAddress = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(", ");
/** "Awaiting drop-off at Gulshan Hub" while a drop-off waits for the sender, else the status label. */
const statusLabelOf = (p: ParcelWithRelations) => parcelStatusLabel(p.status as ParcelStatus, { intake: p.intake, dropOffHubName: p.dropOffHub?.name });

/** The booked pickup window, e.g. { start, end, label: "Sat 17 Oct, 9:00 AM – 12:00 PM" } (Dhaka time). */
export function pickupWindowOf(p: { pickupWindowStart: Date | null; pickupWindowEnd: Date | null }) {
  if (!p.pickupWindowStart || !p.pickupWindowEnd) return null;
  const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) => d.toLocaleString("en-GB", { timeZone: "Asia/Dhaka", ...opts });
  // en-US: "12:00 PM" (en-GB writes noon as "0:00 pm").
  const time = (d: Date) => d.toLocaleString("en-US", { timeZone: "Asia/Dhaka", hour: "numeric", minute: "2-digit", hour12: true });
  return {
    start: p.pickupWindowStart,
    end: p.pickupWindowEnd,
    label: `${fmt(p.pickupWindowStart, { weekday: "short", day: "numeric", month: "short" })}, ${time(p.pickupWindowStart)} – ${time(p.pickupWindowEnd)}`,
  };
}

type Snapshot = { engine?: string; packageName?: string; version?: number; lines?: { code: string; label: string; amount: number }[]; tier?: string; deliveryCharge?: number } | null;

/**
 * The service package side of a parcel (null for parcels booked before packages): the choices made
 * at booking, the proof methods the rider may use and the frozen price lines.
 */
export function serviceView(p: ParcelWithRelations) {
  if (!p.packageVersionId) return null;
  const snap = p.pricingSnapshot as Snapshot;
  const has = new Set(p.services);
  return {
    package: snap?.packageName ? { name: snap.packageName, version: snap.version ?? null } : null,
    firstMile: p.firstMile,
    firstMileLabel: p.firstMile ? (FIRST_MILE_LABEL as Record<string, string>)[p.firstMile] ?? p.firstMile : null,
    lastMile: p.lastMile,
    lastMileLabel: p.lastMile ? (LAST_MILE_LABEL as Record<string, string>)[p.lastMile] ?? p.lastMile : null,
    speed: p.speedOption,
    speedLabel: p.speedOption ? (SPEED_LABEL as Record<string, string>)[p.speedOption] ?? p.speedOption : null,
    openBox: p.openBox,
    onDemand: p.onDemand,
    product: p.productName,
    notifications: p.notifications,
    /** The stored messages by name, e.g. "Out for delivery (recipient)" (what the merchant parcel drawer lists). */
    messages: PARCEL_NOTIFICATIONS.filter(n => p.notifications.includes(n.code)).map(n => `${n.label} (${n.audience})`),
    tier: snap?.tier ?? null,
    lines: snap?.lines ?? [],
    tracking: { liveLocation: has.has("tracking.live_location"), riderPhone: has.has("tracking.rider_phone") },
  };
}

/** Methods the delivery rider may use (all three for parcels booked before packages). */
export const proofMethodsOf = (p: Pick<ParcelWithRelations, "packageVersionId" | "services" | "notifications">) =>
  p.packageVersionId ? proofMethodsFor(p.services, p.notifications) : (["OTP", "SIGNATURE", "PHOTO"] as const).slice();

/** Collect from hub: the collection hub, when it became ready and the last day to collect. */
const collectView = (p: ParcelWithRelations) =>
  p.lastMile === "HUB_COLLECT" ? { hub: p.collectHub, readyAt: p.readyForCollectionAt, dueAt: p.collectionDueAt } : null;

/** Statuses where a parcel that failed delivery waits at a hub for the next step. */
const BACK_AT_HUB: ParcelStatus[] = ["AT_HUB", "READY_FOR_COLLECTION"];

/**
 * Failed deliveries: how many, the latest (reason, when, rider) and whether the parcel is back at a hub
 * after one (at a hub and its latest attempt failed: no delivery since). Rider names and the attempt
 * list are for staff only.
 */
export function failureView(p: Pick<ParcelWithRelations, "status" | "attempts">, internal: boolean) {
  const attempts = p.attempts ?? [];
  const failed = attempts.filter(a => a.outcome === "FAILED");
  const last = failed.at(-1);
  return {
    failedAttempts: failed.length,
    lastFailedAttempt: last ? { reason: last.reason, at: last.createdAt, nextAction: last.nextAction, riderName: internal ? last.rider.user.name : undefined } : null,
    returnedAfterFailure: BACK_AT_HUB.includes(p.status as ParcelStatus) && attempts.at(-1)?.outcome === "FAILED",
    attempts: internal
      ? attempts.map(a => ({ id: a.id, outcome: a.outcome, reason: a.reason, nextAction: a.nextAction, note: a.note, at: a.createdAt, rider: { code: a.rider.code, name: a.rider.user.name } }))
      : undefined,
  };
}

/** Full detail for the owner (customer/merchant), the assigned rider and staff. */
export function parcelView(p: ParcelWithRelations, opts: { internal: boolean }) {
  const status = p.status as ParcelStatus;
  return {
    id: p.id,
    trackingId: p.trackingId,
    channel: p.channel,
    status,
    statusLabel: statusLabelOf(p),
    version: p.version,
    stage: trackingStage(status),
    merchant: p.merchant,
    merchantOrderRef: p.merchantOrderRef,
    sender: { name: p.senderName, phone: p.senderPhone },
    pickup: {
      category: p.pickupCategory,
      street: p.pickupStreet,
      area: p.pickupArea,
      zone: p.pickupZone,
      district: p.pickupDistrict,
      label: joinAddress(CATEGORY_LABEL[p.pickupCategory], p.pickupStreet, p.pickupArea, p.pickupZone, p.pickupDistrict),
      lat: p.pickupLat,
      lng: p.pickupLng,
    },
    recipient: { name: p.recipientName, phone: p.recipientPhone },
    delivery: {
      category: p.deliveryCategory,
      street: p.deliveryStreet,
      area: p.deliveryArea,
      zone: p.deliveryZone,
      district: p.deliveryDistrict,
      label: joinAddress(CATEGORY_LABEL[p.deliveryCategory], p.deliveryStreet, p.deliveryArea, p.deliveryZone, p.deliveryDistrict),
      lat: p.deliveryLat,
      lng: p.deliveryLng,
    },
    pickupWindow: pickupWindowOf(p),
    type: p.type,
    serviceLevel: p.serviceLevel,
    serviceLevelLabel: SERVICE_LEVEL_LABEL[p.serviceLevel],
    weightKg: num(p.weightKg),
    packaging: p.packaging,
    contents: p.contents,
    declaredValue: num(p.declaredValue),
    instructions: p.instructions,
    receiverRelation: p.receiverRelation,
    originBranchCode: p.originBranchCode,
    /**
     * Return to merchant (RTO), when one was requested or scheduled. `requestedBy` (a person's name, often
     * staff) and the return run's id are staff only; merchants get `onReturnRun`.
     */
    returnInfo:
      p.returnReason || p.returnRequestedAt || p.returnRunId
        ? {
            reason: p.returnReason,
            requestedAt: p.returnRequestedAt,
            requestedBy: opts.internal ? p.returnRequestedBy : undefined,
            charge: num(p.returnCharge),
            runId: opts.internal ? p.returnRunId : undefined,
            onReturnRun: !!p.returnRunId,
            receivedAt: p.returnReceivedAt,
          }
        : null,
    charges: {
      base: num(p.baseCharge),
      weight: num(p.weightCharge),
      service: num(p.serviceCharge),
      codFee: num(p.codFee),
      discount: num(p.discount),
      reattempt: num(p.reattemptCharge),
      total: num(p.totalCharge),
      /** Itemised price frozen at booking (service packages). */
      lines: (p.pricingSnapshot as Snapshot)?.lines ?? null,
    },
    /** Service package choices (null: booked before packages). */
    service: serviceView(p),
    proofMethods: proofMethodsOf(p),
    openBox: p.openBox,
    onDemand: p.onDemand,
    product: p.productName,
    collect: collectView(p),
    codAmount: num(p.codAmount),
    cod: p.codCollection ? { amount: num(p.codCollection.amount), state: p.codCollection.state, collectedAt: p.codCollection.collectedAt } : null,
    pickupRider: p.pickupRider ? { id: p.pickupRider.id, code: p.pickupRider.code, name: p.pickupRider.user.name, label: riderLabel(p.pickupRider) } : null,
    deliveryRider: p.deliveryRider
      ? { id: p.deliveryRider.id, code: p.deliveryRider.code, name: p.deliveryRider.user.name, phone: opts.internal ? p.deliveryRider.user.phone : undefined, label: riderLabel(p.deliveryRider) }
      : null,
    currentHub: p.currentHub,
    /** PICKUP (rider collects it) or DROP_OFF (the sender brings it to dropOffHub). */
    intake: p.intake,
    dropOffHub: p.dropOffHub,
    droppedOffAt: p.droppedOffAt,
    bookingBatch: opts.internal ? p.bookingBatch : undefined,
    /** "Needs info": booked by an import with delivery details missing (parcels/incomplete.ts). */
    incomplete: p.incomplete,
    missingFields: p.missingFields,
    missingLabels: p.missingFields.map(f => MISSING_LABEL[f as MissingField] ?? f),
    attemptCount: p.attemptCount,
    /** failedAttempts, lastFailedAttempt { reason, at, riderName }, returnedAfterFailure, attempts (staff). */
    ...failureView(p, opts.internal),
    proof: p.proof ? { method: p.proof.method, receivedBy: p.proof.receivedBy, hasFile: !!p.proof.fileId, fileId: p.proof.fileId, recordedAt: p.proof.createdAt } : null,
    canCancel: isCustomerCancellable(status),
    estimatedDeliveryAt: p.estimatedDeliveryAt,
    pickedUpAt: p.pickedUpAt,
    deliveredAt: p.deliveredAt,
    cancelledAt: p.cancelledAt,
    cancelReason: p.cancelReason,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    events: p.events
      .filter(e => opts.internal || e.visibility === "PUBLIC")
      .map(e => ({
        id: e.id,
        status: e.status,
        title: e.title,
        description: e.description,
        location: e.location,
        actor: opts.internal ? e.actorLabel : undefined,
        internal: e.visibility === "INTERNAL",
        at: e.createdAt,
      })),
  };
}

/** "Nabila Ahmed" -> "Nabila A." */
const maskName = (name: string) => {
  const [first, ...rest] = name.trim().split(/\s+/);
  return rest.length ? `${first} ${rest.map(p => p[0].toUpperCase() + ".").join(" ")}` : first;
};

/** Public tracking by ID: no phone numbers, street addresses or internal notes. */
export function publicTrackingView(p: ParcelWithRelations) {
  const status = p.status as ParcelStatus;
  return {
    trackingId: p.trackingId,
    status,
    statusLabel: statusLabelOf(p),
    stage: trackingStage(status),
    stages: TRACKING_STAGES,
    serviceLevel: SERVICE_LEVEL_LABEL[p.serviceLevel],
    sender: maskName(p.senderName),
    recipient: p.recipientName ? maskName(p.recipientName) : null,
    origin: joinAddress(p.pickupZone, p.pickupDistrict),
    destination: joinAddress(p.deliveryArea, p.deliveryZone, p.deliveryDistrict),
    weightKg: num(p.weightKg),
    packaging: p.packaging,
    codAmount: num(p.codAmount),
    currentLocation: p.currentHub?.name ?? null,
    intake: p.intake,
    /** Where the sender hands a drop-off parcel over (hub name and address are public). */
    dropOffHub: p.dropOffHub ? { name: p.dropOffHub.name, address: p.dropOffHub.address } : null,
    /** Collect from hub: where the recipient collects it (hub name and address are public). */
    lastMile: p.lastMile,
    collect: p.lastMile === "HUB_COLLECT" ? { hub: p.collectHub ? { name: p.collectHub.name, address: p.collectHub.address } : null, readyAt: p.readyForCollectionAt, dueAt: p.collectionDueAt } : null,
    pickupWindow: pickupWindowOf(p),
    estimatedDeliveryAt: p.estimatedDeliveryAt,
    deliveredAt: p.deliveredAt,
    proofMethod: p.proof?.method ?? null,
    canCancel: isCustomerCancellable(status),
    events: p.events
      .filter(e => e.visibility === "PUBLIC")
      .map(e => ({ status: e.status, title: e.title, description: e.description, location: e.location, at: e.createdAt })),
  };
}
