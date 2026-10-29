import type { Prisma } from "../../generated/prisma/client";
import { TERMINAL_STATUSES } from "@paira-express/shared";

/**
 * The work queue: every parcel's next operational step, derived from what the system already knows
 * (status, intake, last mile, the hub serving the delivery zone, the transfer a parcel is on). Each task
 * lists its parcels in groups (route, area, rider, hub…) and, where a scan can do the step, names the
 * action the scan box performs through the existing services.
 *
 * Actions:
 * - ASSIGN_PICKUP / ASSIGN_DELIVERY: give the scanned parcel to the rider chosen above the scan box.
 * - RECEIVE: receive at a hub (HubIntakeService.receive: drop-offs, pickups, transfers, bags).
 * - SEND: dispatch to the destination hub (In transit to the hub serving the delivery zone).
 * - OUT_FOR_DELIVERY: the assigned rider leaves with it (the recipient gets the delivery code).
 * - null: nothing a scan can finish (rider's work, needs a code, a return run or a decision); list and Excel only.
 */
export type QueueAction = "ASSIGN_PICKUP" | "ASSIGN_DELIVERY" | "RECEIVE" | "SEND" | "OUT_FOR_DELIVERY";
export type GroupBy = "pickupArea" | "pickupRider" | "dropOffHub" | "route" | "deliveryArea" | "deliveryRider" | "collectHub" | "merchant" | "currentHub";

export interface QueueTask {
  key: string;
  label: string;
  hint: string;
  /** The step's place in the journey (sorts the list). */
  stage: "Pickup" | "Hub" | "Transfer" | "Delivery" | "Problems";
  action: QueueAction | null;
  /** What the action is called on the button / in results. */
  actionLabel?: string;
  groupBy: GroupBy;
  /** Prisma filter; tasks marked `refine` are narrowed further after loading (derived destination). */
  where: Prisma.ParcelWhereInput;
  refine?: "localDelivery";
}

const NOT_COLLECT: Prisma.ParcelWhereInput = { OR: [{ lastMile: null }, { lastMile: { not: "HUB_COLLECT" } }] };

export const QUEUE_TASKS: QueueTask[] = [
  {
    key: "pickup-assign",
    label: "Pickups to assign",
    hint: "Pickup requests without a pickup rider.",
    stage: "Pickup",
    action: "ASSIGN_PICKUP",
    actionLabel: "Assign pickup rider",
    groupBy: "pickupArea",
    where: { intake: "PICKUP", OR: [{ status: "PENDING_CONFIRMATION" }, { status: { in: ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED"] }, pickupRiderId: null }] },
  },
  {
    key: "pickup-out",
    label: "Out for pickup",
    hint: "A rider is collecting these from the sender. Scan to receive one the rider brings straight to the hub.",
    stage: "Pickup",
    action: "RECEIVE",
    actionLabel: "Receive at hub",
    groupBy: "pickupRider",
    where: { status: { in: ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED"] }, pickupRiderId: { not: null } },
  },
  {
    key: "pickup-receive",
    label: "Picked up · to receive at hub",
    hint: "Collected by a rider, not yet received at the hub.",
    stage: "Hub",
    action: "RECEIVE",
    actionLabel: "Receive at hub",
    groupBy: "pickupRider",
    where: { status: "PICKED_UP" },
  },
  {
    key: "dropoff-receive",
    label: "Drop-offs to receive",
    hint: "Senders bring these to the hub.",
    stage: "Hub",
    action: "RECEIVE",
    actionLabel: "Receive at hub",
    groupBy: "dropOffHub",
    where: { status: "PENDING_CONFIRMATION", intake: "DROP_OFF" },
  },
  {
    key: "transfer-send",
    label: "Transfers to dispatch",
    hint: "At a hub that doesn't serve the delivery area: send them to the destination hub.",
    stage: "Transfer",
    action: "SEND",
    actionLabel: "Dispatch to destination hub",
    groupBy: "route",
    // Replaced by TransferService.eligibleWhere (the linehaul rule) when loading.
    where: { status: "AT_HUB" },
  },
  {
    key: "transfer-receive",
    label: "Transfers to receive",
    hint: "On the way between hubs: receive them at the destination hub.",
    stage: "Transfer",
    action: "RECEIVE",
    actionLabel: "Receive at destination hub",
    groupBy: "route",
    where: { status: "IN_TRANSIT" },
  },
  {
    key: "delivery-assign",
    label: "Deliveries to assign",
    hint: "At the hub serving the delivery area, with complete details: assign a delivery rider.",
    stage: "Delivery",
    action: "ASSIGN_DELIVERY",
    actionLabel: "Assign delivery rider",
    groupBy: "deliveryArea",
    where: { status: "AT_HUB", deliveryRiderId: null, incomplete: false, ...NOT_COLLECT },
    refine: "localDelivery",
  },
  {
    key: "delivery-dispatch",
    label: "Assigned · ready to go out",
    hint: "The rider has them: scan as the rider leaves for delivery.",
    stage: "Delivery",
    action: "OUT_FOR_DELIVERY",
    actionLabel: "Out for delivery",
    groupBy: "deliveryRider",
    where: { status: "ASSIGNED" },
  },
  {
    key: "delivery-out",
    label: "Out for delivery",
    hint: "With the rider on the road. The rider completes them in the rider app.",
    stage: "Delivery",
    action: null,
    groupBy: "deliveryRider",
    where: { status: "OUT_FOR_DELIVERY" },
  },
  {
    key: "failed-receive",
    label: "Failed deliveries · to receive back",
    hint: "Delivery attempt failed: receive them back at the hub for the next attempt or return.",
    stage: "Delivery",
    action: "RECEIVE",
    actionLabel: "Receive back at hub",
    groupBy: "deliveryRider",
    where: { status: "RETRY_SCHEDULED" },
  },
  {
    key: "collection",
    label: "Waiting for collection at hub",
    hint: "Collect-from-hub parcels waiting for the recipient. Hand over from the parcel with the collection code.",
    stage: "Delivery",
    action: null,
    groupBy: "collectHub",
    where: { status: "READY_FOR_COLLECTION" },
  },
  {
    key: "returns",
    label: "Returns to send back",
    hint: "Scheduled to return to the sender. Send them on a return run (Returns).",
    stage: "Problems",
    action: null,
    groupBy: "merchant",
    where: { status: "RETURN_SCHEDULED" },
  },
  {
    key: "exceptions",
    label: "Exceptions to resolve",
    hint: "Held with a problem: decide the next step from the parcel.",
    stage: "Problems",
    action: null,
    groupBy: "currentHub",
    where: { status: "EXCEPTION" },
  },
];

/** Shown apart: parcels that can't be delivered until their delivery details are completed. */
export const MISSING_DETAILS: QueueTask = {
  key: "missing-details",
  label: "Missing delivery details",
  hint: "Recipient, address or area missing: complete them before the parcel can be transferred or delivered.",
  stage: "Problems",
  action: null,
  groupBy: "merchant",
  where: { incomplete: true, status: { notIn: [...TERMINAL_STATUSES] } },
};

export const taskByKey = (key: string) => (key === MISSING_DETAILS.key ? MISSING_DETAILS : QUEUE_TASKS.find(t => t.key === key));
