/**
 * A parcel as staff see it (GET /parcels, GET /parcels/:id; apps/api/src/modules/parcels/parcel.views.ts) and the
 * rules the legacy panel shows on top of it: the next action, the rider and SLA columns, failed deliveries
 * (bridge.js toShipment, bridge-parcel.js nextAction, bridge-failed.js).
 */
import type { Hub } from "@/lib/types";

export interface RiderRef {
  id: string;
  code: string;
  name: string;
  phone?: string;
  label: string;
}
export interface Place {
  category?: string | null;
  street?: string | null;
  area?: string | null;
  zone?: string | null;
  district?: string | null;
  label: string;
  lat?: number | null;
  lng?: number | null;
}
export interface ParcelEvent {
  id: string;
  status: string;
  title: string;
  description?: string | null;
  location?: string | null;
  actor?: string | null;
  internal?: boolean;
  at: string;
}
export interface Attempt {
  id: string;
  outcome: "FAILED" | "DELIVERED" | string;
  reason?: string | null;
  nextAction?: string | null;
  note?: string | null;
  at: string;
  rider?: { code: string; name: string } | null;
}
export interface Parcel {
  id: string;
  trackingId: string;
  channel: string;
  status: string;
  statusLabel: string;
  version: number;
  merchant: { id: string; name: string; type?: string; code?: string } | null;
  merchantOrderRef?: string | null;
  sender: { name: string; phone: string };
  pickup: Place;
  recipient: { name: string; phone: string };
  delivery: Place;
  type: string;
  serviceLevel: string;
  serviceLevelLabel: string;
  weightKg: number | null;
  contents?: string | null;
  instructions?: string | null;
  receiverRelation?: string | null;
  statusChangedAt?: string | null;
  returnInfo: { reason?: string | null; requestedAt?: string | null; requestedBy?: string | null; charge?: number | null; chargeWaived?: boolean; runId?: string | null; onReturnRun?: boolean; receivedAt?: string | null } | null;
  partialDelivery: { codCollected: number; codAmount: number; note?: string | null; returnOrders: { trackingId: string; status: string }[] } | null;
  returnOf: string | null;
  productType: string;
  productName?: string | null;
  product?: string | null;
  /** The system product the file's / form's name was matched to (staff). */
  systemProduct?: string | null;
  priority?: string | null;
  deliveryType?: string | null;
  /** The package charged nothing: no price is shown. */
  chargesOff?: boolean;
  service?: { speedLabel?: string | null } | null;
  messagePlan?: import("@panel/ui/MessagePlan").MessagePlan;
  charges: { base?: number; weight?: number; service?: number; codFee?: number; discount?: number; reattempt?: number; total?: number; lines?: { label: string; amount: number }[] | null };
  codAmount: number | null;
  cod: { amount: number; state: string; collectedAt?: string | null } | null;
  pickupRider: RiderRef | null;
  deliveryRider: RiderRef | null;
  currentHub: Pick<Hub, "id" | "name" | "code"> | null;
  deliveryHub?: Pick<Hub, "id" | "name" | "code"> | null;
  intake: "PICKUP" | "DROP_OFF";
  dropOffHub: Pick<Hub, "id" | "name" | "code"> | null;
  droppedOffAt?: string | null;
  incomplete: boolean;
  missingFields: string[];
  missingLabels: string[];
  attemptCount: number;
  failedAttempts: number;
  lastFailedAttempt: { reason?: string | null; at: string; nextAction?: string | null; riderName?: string } | null;
  returnedAfterFailure: boolean;
  attempts?: Attempt[];
  proof: { method: string; receivedBy?: string | null; hasFile: boolean; fileId?: string | null; recordedAt: string } | null;
  estimatedDeliveryAt?: string | null;
  pickedUpAt?: string | null;
  deliveredAt?: string | null;
  cancelledAt?: string | null;
  cancelReason?: string | null;
  createdAt: string;
  updatedAt: string;
  events: ParcelEvent[];
  [key: string]: unknown;
}

export const CLOSED = ["DELIVERED", "PICKUP_CANCELLED", "RETURNED"];
export const PICKUP_STAGE = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];
export const INTAKE_CHANGEABLE = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];

/** Every status for the All parcels filter (labels; the API reads labels or enum values). */
export const ALL_STATUSES = ["Pending operations confirmation", "Pickup assigned", "Pickup confirmed", "Picked up", "At hub", "In transit", "Assigned", "Out for delivery", "Retry scheduled", "Ready for collection", "Exception", "Return scheduled", "Delivered", "Returned", "Pickup cancelled"];

export type Line = "CUSTOMER" | "ECOMMERCE" | "BANKING_FINANCIAL";
export const LINES: [Line, string][] = [
  ["BANKING_FINANCIAL", "Banking & Financial"],
  ["ECOMMERCE", "E-commerce"],
  ["CUSTOMER", "Customer parcel"],
];
export const lineOf = (p: Parcel): Line => (!p.merchant ? "CUSTOMER" : p.merchant.type === "BANKING_FINANCIAL" ? "BANKING_FINANCIAL" : "ECOMMERCE");
const LINE_LABEL: Record<Line, string> = { CUSTOMER: "Customer parcels", ECOMMERCE: "E-commerce", BANKING_FINANCIAL: "Documents" };
export const lineLabel = (p: Parcel) => LINE_LABEL[lineOf(p)];

export function serviceOf(p: Parcel) {
  const line = lineOf(p);
  if (line === "CUSTOMER") return "Customer parcel";
  if (line === "BANKING_FINANCIAL") return `Document ${String(p.serviceLevelLabel || "").toLowerCase()}`;
  return Number(p.codAmount) > 0 ? "Cash on delivery" : `${p.serviceLevelLabel} parcel`;
}

/** A drop-off booking waiting for the sender to bring it to the hub (never needs a pickup rider). */
export const awaitingDropOff = (p: Parcel) => p.status === "PENDING_CONFIRMATION" && p.intake === "DROP_OFF";

export function riderOf(p: Parcel) {
  if (awaitingDropOff(p)) return `Drop-off · ${p.dropOffHub?.name || "hub"}`;
  const pickup = p.pickupRider?.label;
  const delivery = p.deliveryRider?.label;
  switch (p.status) {
    case "PENDING_CONFIRMATION":
      return "Unassigned";
    case "PICKUP_ASSIGNED":
    case "PICKUP_CONFIRMED":
    case "PICKED_UP":
      return pickup || "Unassigned";
    case "AT_HUB":
    case "IN_TRANSIT":
      return delivery || "Unassigned";
    case "EXCEPTION":
      return delivery || pickup || "Unassigned";
    case "RETURN_SCHEDULED":
      return "Return to sender";
    case "RETURNED":
      return "Returned to sender";
    case "PICKUP_CANCELLED":
      return "—";
    default:
      return delivery || pickup || "Unassigned";
  }
}

export function slaOf(p: Parcel) {
  const promised = p.estimatedDeliveryAt ? new Date(p.estimatedDeliveryAt).getTime() : null;
  switch (p.status) {
    case "DELIVERED":
      return promised && p.deliveredAt && new Date(p.deliveredAt).getTime() > promised ? "Late" : "Met";
    case "PICKUP_CANCELLED":
      return "Cancelled";
    case "RETURNED":
      return "Returned";
    case "RETURN_SCHEDULED":
      return "Return scheduled";
    case "EXCEPTION":
      return "At risk";
    case "PENDING_CONFIRMATION":
      return awaitingDropOff(p) ? "Awaiting drop-off" : "Awaiting review";
  }
  if (promised && promised < Date.now()) return "At risk";
  if (riderOf(p) === "Unassigned") return "Assign now";
  if (p.status === "PICKUP_ASSIGNED" || p.status === "PICKUP_CONFIRMED") return "Pickup scheduled";
  return "On track";
}

// ── failed deliveries (bridge-failed.js) ──
const failedCount = (p?: Parcel | null) => Number(p?.failedAttempts) || 0;
export const failedDelivery = (p?: Parcel | null) => !!p && (p.status === "RETRY_SCHEDULED" || !!p.returnedAfterFailure);
export function failureText(p: Parcel, when: (iso: string) => string) {
  const last = p.lastFailedAttempt;
  const by = last?.riderName ? ` by ${last.riderName}` : "";
  return `Delivery failed ×${failedCount(p)}${last ? ` · last ${when(last.at)}${by}${last.reason ? `: ${last.reason}` : ""}` : ""}${p.returnedAfterFailure ? " · back at the hub" : p.status === "RETRY_SCHEDULED" ? " · retry scheduled" : ""}`;
}
export const failureBadge = (p: Parcel) => (failedCount(p) && !["DELIVERED", "PICKUP_CANCELLED"].includes(p.status) ? { count: failedCount(p), reason: p.lastFailedAttempt?.reason || "" } : null);

// ── next action (bridge-parcel.js Ops.nextAction + bridge-failed.js) ──
export type NextKind = "resolve" | "edit" | "receive" | "accept" | "transfer" | "assign" | "handover" | "returnRun";
export interface NextAction {
  kind: NextKind;
  label: string;
  title: string;
}

/** The hub that delivers a parcel (the API's deliveryHub; else the hubs' own zones). */
export function servingHub(p: Parcel, hubs: Hub[]) {
  if ("deliveryHub" in p) return p.deliveryHub ?? null;
  const zone = p.delivery?.zone;
  if (!zone) return null;
  return hubs.find(h => h.active !== false && h.zone === zone && h.district === p.delivery?.district) ?? null;
}
const needsTransfer = (p: Parcel, hubs: Hub[]) => {
  const hub = servingHub(p, hubs);
  return !!(hub && p.currentHub && hub.id !== p.currentHub.id);
};

export function nextAction(p: Parcel | null | undefined, hubs: Hub[], when: (iso: string) => string): NextAction | null {
  if (!p || CLOSED.includes(p.status)) return null;
  let next: NextAction | null = null;
  if (p.status === "EXCEPTION") next = { kind: "resolve", label: "Resolve", title: "Record an operations decision for this exception" };
  else if (p.incomplete) next = { kind: "edit", label: "Edit details", title: `Complete the missing details: ${(p.missingLabels || []).join(", ")}` };
  else if (p.status === "PENDING_CONFIRMATION")
    next = awaitingDropOff(p)
      ? { kind: "receive", label: "Receive", title: `Receive it at ${p.dropOffHub?.name || "the hub"} when the sender brings it` }
      : { kind: "accept", label: "Accept & assign rider", title: "Accept the order and assign a pickup rider" };
  else if (p.status === "AT_HUB") {
    const hub = servingHub(p, hubs);
    next = needsTransfer(p, hubs)
      ? { kind: "transfer", label: "Add to transfer", title: `${hub?.name} serves ${p.delivery.zone}: bag it for the transfer` }
      : { kind: "assign", label: "Assign rider", title: "Assign a delivery rider" };
  } else if (p.status === "READY_FOR_COLLECTION") next = { kind: "handover", label: "Hand over", title: "Hand it to the receiver on Collect from hub" };
  else if (p.status === "RETURN_SCHEDULED" && !p.returnInfo?.runId) next = { kind: "returnRun", label: "Add to return run", title: "Plan a return run to the merchant" };
  // Failed deliveries: re-attempt with a rider (also instead of "Add to transfer": it went out from this hub).
  if (failedDelivery(p) && !p.incomplete && (!next || next.kind === "assign" || next.kind === "transfer"))
    return { kind: "assign", label: "Re-attempt (Assign rider)", title: `${failureText(p, when)}. Assign a delivery rider for another attempt.` };
  return next;
}

/** A pickup assignment (before pickup, or an exception before pickup) or a delivery one. */
export const isPickupAssignment = (p: Parcel) => PICKUP_STAGE.includes(p.status) || (p.status === "EXCEPTION" && !p.pickedUpAt && !p.currentHub);
