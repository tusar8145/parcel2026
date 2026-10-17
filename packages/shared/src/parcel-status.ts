/**
 * Parcel lifecycle (see the repo README). Every status change goes through
 * canTransition(), on the server, whoever makes it.
 */
export const PARCEL_STATUSES = [
  "PENDING_CONFIRMATION",
  "PICKUP_ASSIGNED",
  "PICKUP_CONFIRMED",
  "PICKED_UP",
  "PICKUP_CANCELLED",
  "AT_HUB",
  "ASSIGNED",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RETRY_SCHEDULED",
  "RETURN_SCHEDULED",
  "RETURNED",
  "EXCEPTION",
  /** Collect from hub: waiting at the collection hub for the recipient (appended). */
  "READY_FOR_COLLECTION",
] as const;
export type ParcelStatus = (typeof PARCEL_STATUSES)[number];

/** Exact strings the web panels display and filter on. */
export const PARCEL_STATUS_LABEL: Record<ParcelStatus, string> = {
  PENDING_CONFIRMATION: "Pending operations confirmation",
  PICKUP_ASSIGNED: "Pickup assigned",
  PICKUP_CONFIRMED: "Pickup confirmed",
  PICKED_UP: "Picked up",
  PICKUP_CANCELLED: "Pickup cancelled",
  AT_HUB: "At hub",
  ASSIGNED: "Assigned",
  IN_TRANSIT: "In transit",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  RETRY_SCHEDULED: "Retry scheduled",
  RETURN_SCHEDULED: "Return scheduled",
  RETURNED: "Returned",
  EXCEPTION: "Exception",
  READY_FOR_COLLECTION: "Ready for collection",
};

const BY_LABEL = new Map<string, ParcelStatus>([
  ...Object.entries(PARCEL_STATUS_LABEL).map(([k, v]) => [v.toLowerCase(), k as ParcelStatus] as const),
  ["pickup requested", "PENDING_CONFIRMATION"], // older label
  ["reattempt scheduled", "RETRY_SCHEDULED"],
]);

/** Accepts an enum value or a UI label ("At hub"). */
export function parseParcelStatus(value: string): ParcelStatus | undefined {
  if ((PARCEL_STATUSES as readonly string[]).includes(value)) return value as ParcelStatus;
  const label = value.trim().toLowerCase();
  if (label.startsWith("awaiting drop-off")) return "PENDING_CONFIRMATION"; // parcelStatusLabel() for drop-offs
  return BY_LABEL.get(label);
}

export const TERMINAL_STATUSES: readonly ParcelStatus[] = ["DELIVERED", "PICKUP_CANCELLED", "RETURNED"];

/** Who is acting: the booking customer/merchant, operations staff, or the assigned rider. */
export type TransitionActor = "owner" | "ops" | "rider";

const T = (ops: ParcelStatus[], rider: ParcelStatus[] = [], owner: ParcelStatus[] = []) => ({ ops, rider, owner });

/**
 * from -> actor -> allowed next statuses. Only the rider can mark a parcel DELIVERED, with
 * proof and COD, so operations can't skip those checks.
 */
const TRANSITIONS: Record<ParcelStatus, Record<TransitionActor, ParcelStatus[]>> = {
  PENDING_CONFIRMATION: T(["PICKUP_ASSIGNED", "PICKUP_CANCELLED", "EXCEPTION"], [], ["PICKUP_CANCELLED"]),
  PICKUP_ASSIGNED: T(
    ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED", "PICKED_UP", "AT_HUB", "OUT_FOR_DELIVERY", "EXCEPTION", "PICKUP_CANCELLED"],
    ["PICKUP_CONFIRMED", "PICKED_UP", "AT_HUB", "OUT_FOR_DELIVERY", "EXCEPTION"],
  ),
  PICKUP_CONFIRMED: T(
    ["PICKUP_ASSIGNED", "PICKED_UP", "AT_HUB", "OUT_FOR_DELIVERY", "EXCEPTION", "PICKUP_CANCELLED"],
    ["PICKED_UP", "AT_HUB", "OUT_FOR_DELIVERY", "EXCEPTION"],
  ),
  PICKED_UP: T(["AT_HUB", "IN_TRANSIT", "OUT_FOR_DELIVERY", "EXCEPTION"], ["AT_HUB", "OUT_FOR_DELIVERY", "EXCEPTION"]),
  AT_HUB: T(["ASSIGNED", "IN_TRANSIT", "OUT_FOR_DELIVERY", "RETURN_SCHEDULED", "EXCEPTION"]),
  IN_TRANSIT: T(["AT_HUB", "ASSIGNED", "OUT_FOR_DELIVERY", "EXCEPTION"]),
  ASSIGNED: T(
    ["ASSIGNED", "AT_HUB", "OUT_FOR_DELIVERY", "EXCEPTION"],
    ["OUT_FOR_DELIVERY", "DELIVERED", "RETRY_SCHEDULED", "AT_HUB", "EXCEPTION"],
  ),
  OUT_FOR_DELIVERY: T(
    ["RETRY_SCHEDULED", "AT_HUB", "EXCEPTION"],
    ["DELIVERED", "RETRY_SCHEDULED", "AT_HUB", "EXCEPTION"],
  ),
  RETRY_SCHEDULED: T(
    ["ASSIGNED", "OUT_FOR_DELIVERY", "AT_HUB", "RETURN_SCHEDULED", "EXCEPTION"],
    ["OUT_FOR_DELIVERY", "DELIVERED", "RETRY_SCHEDULED", "AT_HUB", "EXCEPTION"],
  ),
  RETURN_SCHEDULED: T(["RETURNED", "AT_HUB", "EXCEPTION"]),
  EXCEPTION: T(
    ["PICKUP_ASSIGNED", "AT_HUB", "ASSIGNED", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "RETURN_SCHEDULED", "PICKUP_CANCELLED"],
    ["OUT_FOR_DELIVERY", "DELIVERED", "RETRY_SCHEDULED", "AT_HUB"],
  ),
  DELIVERED: T([]),
  PICKUP_CANCELLED: T([]),
  RETURNED: T([]),
  // Collect from hub (lastMile HUB_COLLECT only, see collectRules): hub staff hand it over (DELIVERED) or it goes back.
  READY_FOR_COLLECTION: T(["DELIVERED", "RETURN_SCHEDULED", "AT_HUB", "EXCEPTION"]),
};

/**
 * How a parcel enters the network: collected by a pickup rider (PICKUP, the default) or
 * brought to a hub by the sender (DROP_OFF, e.g. a merchant arriving with a spreadsheet of parcels).
 */
export const PARCEL_INTAKES = ["PICKUP", "DROP_OFF"] as const;
export type ParcelIntake = (typeof PARCEL_INTAKES)[number];

/** Facts about the parcel that change which moves are allowed. */
export interface TransitionContext {
  intake?: ParcelIntake;
  /** Operations switching a pickup to hub drop-off before pickup: the pickup assignment is released. */
  intakeChange?: boolean;
  /** DOORSTEP (default) or HUB_COLLECT: collected parcels wait "Ready for collection" and get no delivery rider. */
  lastMile?: string | null;
}

/** Statuses in which operations may switch a parcel between rider pickup and hub drop-off (before pickup). */
export const INTAKE_CHANGEABLE_STATUSES: readonly ParcelStatus[] = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];

/**
 * Drop-off parcels never wait for a pickup rider: operations receive them at the declared hub
 * (PENDING_CONFIRMATION -> AT_HUB; the API checks the hub) instead of assigning a pickup.
 */
function rulesFor(from: ParcelStatus, actor: TransitionActor, context: TransitionContext): readonly ParcelStatus[] {
  const base = collectRules(from, actor, context.lastMile === "HUB_COLLECT", TRANSITIONS[from][actor]);
  if (context.intakeChange && actor === "ops" && (from === "PICKUP_ASSIGNED" || from === "PICKUP_CONFIRMED")) return [...base, "PENDING_CONFIRMATION"];
  if (context.intake !== "DROP_OFF" || from !== "PENDING_CONFIRMATION" || actor !== "ops") return base;
  return ["AT_HUB", ...base.filter(s => s !== "PICKUP_ASSIGNED")];
}

/**
 * Collect from hub: the collection hub marks it READY_FOR_COLLECTION and hands it over (DELIVERED by
 * operations, only from there); no delivery rider is assigned. Other parcels never use that status.
 */
function collectRules(from: ParcelStatus, actor: TransitionActor, collect: boolean, base: readonly ParcelStatus[]): readonly ParcelStatus[] {
  if (!collect) return from === "READY_FOR_COLLECTION" ? base.filter(s => s !== "DELIVERED") : base;
  if (actor !== "ops") return base.filter(s => s !== "OUT_FOR_DELIVERY" && s !== "DELIVERED");
  const allowed = base.filter(s => s !== "ASSIGNED" && s !== "OUT_FOR_DELIVERY");
  if (from === "AT_HUB" || from === "EXCEPTION") allowed.push("READY_FOR_COLLECTION");
  return allowed;
}

export function canTransition(from: ParcelStatus, to: ParcelStatus, actor: TransitionActor, context: TransitionContext = {}): boolean {
  return rulesFor(from, actor, context).includes(to);
}

export function allowedNextStatuses(from: ParcelStatus, actor: TransitionActor, context: TransitionContext = {}): readonly ParcelStatus[] {
  return rulesFor(from, actor, context);
}

/** "Awaiting drop-off at Gulshan Hub" while a drop-off parcel waits for the sender; else the status label. */
export function parcelStatusLabel(status: ParcelStatus, intake?: { intake?: ParcelIntake | string | null; dropOffHubName?: string | null }): string {
  if (status === "PENDING_CONFIRMATION" && intake?.intake === "DROP_OFF") return intake.dropOffHubName ? `Awaiting drop-off at ${intake.dropOffHubName}` : "Awaiting drop-off";
  return PARCEL_STATUS_LABEL[status];
}

/** Customers may cancel only before operations confirms the request. */
export const isCustomerCancellable = (status: ParcelStatus) => status === "PENDING_CONFIRMATION";

/** Progress bar on the public tracking page: Order received, Picked up, At local hub, Out for delivery, Delivered. */
export const TRACKING_STAGES = ["Order received", "Picked up", "At local hub", "Out for delivery", "Delivered"] as const;
export function trackingStage(status: ParcelStatus): number {
  switch (status) {
    case "DELIVERED":
      return 4;
    case "OUT_FOR_DELIVERY":
    case "RETRY_SCHEDULED":
      return 3;
    case "READY_FOR_COLLECTION":
      return 3;
    case "AT_HUB":
    case "ASSIGNED":
    case "IN_TRANSIT":
      return 2;
    case "PICKED_UP":
      return 1;
    default:
      return 0;
  }
}
