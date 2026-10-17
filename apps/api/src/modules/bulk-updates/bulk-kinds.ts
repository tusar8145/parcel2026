import { PARCEL_STATUS_LABEL, type ParcelStatus, type Permission } from "@delivery-fast/shared";
import type { Prisma } from "../../generated/prisma/client";
import { ACTIONS, BULK_ACTION_IDS, type ActionTemplate, type BulkActionId } from "./bulk-actions";
import { BULK_ACTIONS, type BulkAction } from "./bulk-columns";

/**
 * The Courier Operations pages with a bulk update ("kinds"). Each page offers its own action
 * templates (bulk-actions.ts); the user picks one and downloads a file for just that action, holding
 * the page's parcels that can take it. All parcels offers every action.
 */

export const BULK_KINDS = ["new_orders", "pickup", "hub_desk", "delivery", "problems", "returns", "all"] as const;
export type BulkKind = (typeof BULK_KINDS)[number];

export interface BulkKindDef {
  kind: BulkKind;
  /** The Courier Operations page. */
  page: string;
  /** "New orders bulk update". */
  title: string;
  /** What the page's parcels are (the dialog). */
  scope: string;
  /** The page's actions, in the order the dialog lists them. */
  actions: BulkActionId[];
  /** The statuses the page's parcels can be in (the dialog's status filter). */
  statuses: readonly ParcelStatus[];
  /** Quick filters the dialog offers on this page. */
  presets: ("pending_review" | "at_hub_unassigned" | "needs_info")[];
}

const OPEN: ParcelStatus[] = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED", "PICKED_UP", "AT_HUB", "IN_TRANSIT", "ASSIGNED", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "RETURN_SCHEDULED", "EXCEPTION", "READY_FOR_COLLECTION"];

export const KINDS: Record<BulkKind, BulkKindDef> = {
  new_orders: {
    kind: "new_orders",
    page: "New orders",
    title: "New orders bulk update",
    scope: "orders waiting for operations (Pending operations confirmation: rider pickups awaiting review and drop-offs not yet brought in)",
    actions: ["accept_pickup", "cancel", "to_drop_off", "to_pickup", "complete_details", "add_note"],
    statuses: ["PENDING_CONFIRMATION"],
    presets: ["pending_review", "needs_info"],
  },
  pickup: {
    kind: "pickup",
    page: "Pickup",
    title: "Pickup bulk update",
    scope: "parcels with a pickup rider: pickup assigned, pickup confirmed and picked up",
    actions: ["reassign_pickup", "mark_picked_up", "cancel", "add_note"],
    statuses: ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED", "PICKED_UP"],
    presets: [],
  },
  hub_desk: {
    kind: "hub_desk",
    page: "Hub desk",
    title: "Hub desk bulk update",
    scope: "parcels to receive at a hub (picked up, in transit, drop-offs on their way) and parcels at a hub",
    actions: ["receive_at_hub", "mark_exception", "add_note"],
    statuses: ["PENDING_CONFIRMATION", "PICKED_UP", "IN_TRANSIT", "AT_HUB", "READY_FOR_COLLECTION"],
    presets: [],
  },
  delivery: {
    kind: "delivery",
    page: "Delivery",
    title: "Delivery bulk update",
    scope: "parcels at a hub without a delivery rider (doorstep delivery) and parcels assigned to a delivery rider",
    actions: ["assign_delivery", "complete_details", "add_note"],
    statuses: ["AT_HUB", "ASSIGNED"],
    presets: ["at_hub_unassigned", "needs_info"],
  },
  problems: {
    kind: "problems",
    page: "Problems",
    title: "Problems bulk update",
    scope: "exceptions, failed deliveries (retry scheduled), orders that need info and parcels at risk of missing or past their SLA",
    actions: ["resolve_status", "assign_delivery", "schedule_return", "complete_details", "add_note"],
    statuses: OPEN,
    presets: ["needs_info"],
  },
  returns: {
    kind: "returns",
    page: "Returns",
    title: "Returns bulk update",
    scope: "parcels that can go back to the sender (failed deliveries, exceptions, parcels back at a hub after a delivery attempt) and returns already scheduled",
    actions: ["schedule_return", "add_note"],
    statuses: ["AT_HUB", "READY_FOR_COLLECTION", "RETRY_SCHEDULED", "EXCEPTION", "RETURN_SCHEDULED"],
    presets: [],
  },
  all: {
    kind: "all",
    page: "All parcels",
    title: "All parcels bulk update",
    scope: "any parcels you filter, with every bulk action",
    actions: [...BULK_ACTION_IDS],
    statuses: [...OPEN, "DELIVERED", "PICKUP_CANCELLED", "RETURNED"],
    presets: ["pending_review", "at_hub_unassigned", "needs_info"],
  },
};

const TERMINAL: ParcelStatus[] = ["DELIVERED", "PICKUP_CANCELLED", "RETURNED"];

/** The parcels a page lists (ANDed with the action's eligibility, the dialog's filters and the caller's hub scope). */
export function kindWhere(kind: BulkKind): Prisma.ParcelWhereInput | null {
  switch (kind) {
    case "new_orders":
      return { status: "PENDING_CONFIRMATION" };
    case "pickup":
      return { status: { in: ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED", "PICKED_UP"] } };
    case "hub_desk":
      return { OR: [{ status: { in: ["PICKED_UP", "IN_TRANSIT", "AT_HUB", "READY_FOR_COLLECTION"] } }, { status: "PENDING_CONFIRMATION", intake: "DROP_OFF" }] };
    case "delivery":
      return {
        OR: [{ status: "AT_HUB", deliveryRiderId: null, OR: [{ lastMile: null }, { lastMile: { not: "HUB_COLLECT" } }] }, { status: "ASSIGNED" }],
      };
    case "problems":
      return {
        OR: [
          { status: { in: ["EXCEPTION", "RETRY_SCHEDULED"] } },
          { incomplete: true, status: { notIn: TERMINAL } },
          { slaState: { in: ["AT_RISK", "BREACHED"] }, status: { notIn: TERMINAL } },
        ],
      };
    case "returns":
      return { OR: [{ status: { in: ["RETRY_SCHEDULED", "EXCEPTION", "RETURN_SCHEDULED"] } }, { status: { in: ["AT_HUB", "READY_FOR_COLLECTION"] }, attemptCount: { gt: 0 } }] };
    case "all":
      return null;
  }
}

/** Every bulk action is done by the service of the single action, which needs `parcel:dispatch`. */
const ACTION_PERMISSIONS: Record<BulkAction, Permission[]> = Object.fromEntries(BULK_ACTIONS.map(a => [a, ["parcel:dispatch"]])) as Record<BulkAction, Permission[]>;
export const canUse = (permissions: ReadonlySet<string>, t: ActionTemplate) => ACTION_PERMISSIONS[t.action].every(p => permissions.has(p));

/** The pages the caller can use, each with only the actions the caller may perform. */
export function kindsFor(permissions: ReadonlySet<string>) {
  return BULK_KINDS.map(k => KINDS[k])
    .map(def => ({ ...def, actions: def.actions.filter(a => canUse(permissions, ACTIONS[a])) }))
    .filter(def => def.actions.length > 0);
}

/** "Accept & assign pickup rider · New orders" (history, the file's title). */
export const jobTitle = (kind: BulkKind, action: BulkActionId) => `${ACTIONS[action].label} · ${KINDS[kind].page}`;

export const isKind = (v: string): v is BulkKind => (BULK_KINDS as readonly string[]).includes(v);
export const statusLabels = (statuses: readonly ParcelStatus[]) => statuses.map(s => PARCEL_STATUS_LABEL[s]);
