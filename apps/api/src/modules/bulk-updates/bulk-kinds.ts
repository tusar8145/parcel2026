import { PARCEL_STATUS_LABEL, type ParcelStatus, type Permission } from "@delivery-fast/shared";
import type { Prisma } from "../../generated/prisma/client";
import { ACTION_HELP, ACTION_LABEL, BULK_ACTIONS, BULK_COLUMNS, OPS_SETTABLE, type BulkAction, type BulkColumn, type BulkColumnKey } from "./bulk-columns";

/**
 * Page templates ("kinds") of the bulk update: each Courier Operations page downloads its own
 * parcels with only that page's actions and the columns they need. Every choice is an existing
 * single action (bulk-columns.ts `BULK_ACTIONS`), sometimes under a page-specific label with a
 * fixed or narrowed status ("Mark picked up" = Change status → Picked up); no new parcel behaviour.
 *
 * A file carries its kind in the hidden `template` column. Uploading it on another page is refused;
 * All parcels takes any kind.
 */

export const BULK_KINDS = ["new_orders", "pickup", "hub_desk", "delivery", "problems", "returns", "all"] as const;
export type BulkKind = (typeof BULK_KINDS)[number];

/** One entry of the Action dropdown: an existing action, possibly with a page-specific label and status. */
export interface BulkChoice {
  /** The dropdown label; unique across every kind (it identifies the choice when the file comes back). */
  label: string;
  action: BulkAction;
  /** Change status: the one status this choice sets (no New status column needed). */
  status?: ParcelStatus;
  /** Change status: the statuses New status may take (default: every status operations may set). */
  statuses?: readonly ParcelStatus[];
  /** Reason / note is required (besides the actions that always require it). */
  noteRequired?: boolean;
  needs?: string;
  does?: string;
}

/** Every action as today (the All parcels template), under its own label. */
const BASE: Record<BulkAction, BulkChoice> = Object.fromEntries(BULK_ACTIONS.map(a => [a, { label: ACTION_LABEL[a], action: a, ...(a === "SET_STATUS" ? { statuses: OPS_SETTABLE } : {}) }])) as Record<BulkAction, BulkChoice>;

const RESOLVE_STATUSES: readonly ParcelStatus[] = ["AT_HUB", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "EXCEPTION"];

/** Page-specific labels of existing actions. */
const EXTRA: BulkChoice[] = [
  {
    label: "Assign / reassign pickup rider",
    action: "ACCEPT_PICKUP",
    needs: "Rider",
    does: "Assigns another pickup rider while the pickup is assigned or confirmed (the same as Accept & assign pickup rider).",
  },
  {
    label: "Mark picked up",
    action: "SET_STATUS",
    status: "PICKED_UP",
    needs: "Nothing else",
    does: "The pickup rider has collected the parcel: Picked up (normally the rider does this in the app). Follows the lifecycle: only an assigned or confirmed pickup.",
  },
  {
    label: "Mark exception",
    action: "SET_STATUS",
    status: "EXCEPTION",
    noteRequired: true,
    needs: "Reason / note (what is wrong: missing, damaged, wrong hub…)",
    does: "Puts the parcel on hold as an exception; it then shows under Problems to be resolved.",
  },
  {
    label: "Resolve: change status",
    action: "SET_STATUS",
    statuses: RESOLVE_STATUSES,
    needs: "New status (At hub, Out for delivery, Retry scheduled or Exception); Hub for At hub (empty = the current hub)",
    does: "Resolves an exception or failed delivery by moving it on by the lifecycle rules. To send it back use Schedule return; for another delivery rider use Assign delivery rider.",
  },
];

const CHOICES: BulkChoice[] = [...Object.values(BASE), ...EXTRA];
const lower = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** "Mark picked up", "Accept & assign pickup rider", "accept_pickup" → its choice (any kind). */
export function parseChoice(value: string): BulkChoice | undefined {
  const v = lower(value);
  return CHOICES.find(c => lower(c.label) === v) ?? Object.values(BASE).find(c => c.action.toLowerCase() === v.replace(/[\s-]+/g, "_"));
}

export const choiceHelp = (c: BulkChoice) => ({ needs: c.needs ?? ACTION_HELP[c.action].needs, does: c.does ?? ACTION_HELP[c.action].does });

export interface BulkKindDef {
  kind: BulkKind;
  /** The Courier Operations page. */
  page: string;
  /** "New orders bulk update" (history, Instructions sheet title). */
  title: string;
  /** What the page's file holds (Instructions, the dialog). */
  scope: string;
  choices: BulkChoice[];
  columns: BulkColumnKey[];
  /** The statuses the page's parcels can be in (the dialog's status filter). */
  statuses: readonly ParcelStatus[];
  /** Quick filters the dialog offers on this page. */
  presets: ("pending_review" | "at_hub_unassigned" | "needs_info")[];
}

const NOTE: BulkColumnKey[] = ["note", "priority"];
const DETAILS: BulkColumnKey[] = ["set_recipient_name", "set_recipient_phone", "set_address", "set_district", "set_zone", "set_area", "set_weight", "set_service"];
const TAIL: BulkColumnKey[] = ["version", "template"];
const OPEN: ParcelStatus[] = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED", "PICKED_UP", "AT_HUB", "IN_TRANSIT", "ASSIGNED", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "RETURN_SCHEDULED", "EXCEPTION", "READY_FOR_COLLECTION"];

export const KINDS: Record<BulkKind, BulkKindDef> = {
  new_orders: {
    kind: "new_orders",
    page: "New orders",
    title: "New orders bulk update",
    scope: "orders waiting for operations (Pending operations confirmation: rider pickups awaiting review and drop-offs not yet brought in)",
    choices: [BASE.ACCEPT_PICKUP, BASE.CANCEL, BASE.TO_DROP_OFF, BASE.TO_PICKUP, BASE.COMPLETE_DETAILS, BASE.ADD_NOTE],
    columns: [
      "tracking_id", "status", "suggested_rider", "action", "rider", "hub", ...NOTE,
      "cn", "merchant", "sender", "recipient_name", "recipient_phone", "recipient_address", "district", "zone", "intake", "drop_off_hub", "cod", "weight", "service", "created", "sla_due", "sla_state", "missing",
      ...DETAILS, ...TAIL,
    ],
    statuses: ["PENDING_CONFIRMATION"],
    presets: ["pending_review", "needs_info"],
  },
  pickup: {
    kind: "pickup",
    page: "Pickup",
    title: "Pickup bulk update",
    scope: "parcels with a pickup rider: pickup assigned, pickup confirmed and picked up",
    choices: [EXTRA[0], EXTRA[1], BASE.CANCEL, BASE.ADD_NOTE],
    columns: ["tracking_id", "status", "action", "rider", "hub", ...NOTE, "pickup_rider", "cn", "merchant", "sender", "intake", "district", "zone", "cod", "weight", "created", "sla_due", "sla_state", ...TAIL],
    statuses: ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED", "PICKED_UP"],
    presets: [],
  },
  hub_desk: {
    kind: "hub_desk",
    page: "Hub desk",
    title: "Hub desk bulk update",
    scope: "parcels to receive at a hub (picked up, in transit, drop-offs on their way) and parcels at a hub",
    choices: [BASE.RECEIVE_AT_HUB, EXTRA[2], BASE.ADD_NOTE],
    columns: ["tracking_id", "status", "action", "hub", ...NOTE, "intake", "drop_off_hub", "current_hub", "pickup_rider", "cn", "merchant", "recipient_name", "district", "zone", "cod", "weight", "service", "created", "sla_state", ...TAIL],
    statuses: ["PENDING_CONFIRMATION", "PICKED_UP", "IN_TRANSIT", "AT_HUB", "READY_FOR_COLLECTION"],
    presets: [],
  },
  delivery: {
    kind: "delivery",
    page: "Delivery",
    title: "Delivery bulk update",
    scope: "parcels at a hub without a delivery rider (doorstep delivery) and parcels assigned to a delivery rider",
    choices: [BASE.ASSIGN_DELIVERY, BASE.COMPLETE_DETAILS, BASE.ADD_NOTE],
    columns: [
      "tracking_id", "status", "suggested_rider", "action", "rider", "hub", ...NOTE,
      "current_hub", "delivery_rider", "cn", "merchant", "recipient_name", "recipient_phone", "recipient_address", "district", "zone", "cod", "weight", "service", "sla_due", "sla_state", "missing",
      ...DETAILS, ...TAIL,
    ],
    statuses: ["AT_HUB", "ASSIGNED"],
    presets: ["at_hub_unassigned", "needs_info"],
  },
  problems: {
    kind: "problems",
    page: "Problems",
    title: "Problems bulk update",
    scope: "exceptions, failed deliveries (retry scheduled), orders that need info and parcels at risk of missing or past their SLA",
    choices: [EXTRA[3], BASE.ASSIGN_DELIVERY, BASE.SCHEDULE_RETURN, BASE.COMPLETE_DETAILS, BASE.ADD_NOTE],
    columns: [
      "tracking_id", "status", "suggested_rider", "action", "rider", "new_status", "hub", ...NOTE,
      "current_hub", "pickup_rider", "delivery_rider", "cn", "merchant", "recipient_name", "recipient_phone", "recipient_address", "district", "zone", "cod", "weight", "service", "created", "sla_due", "sla_state", "missing",
      ...DETAILS, ...TAIL,
    ],
    statuses: OPEN,
    presets: ["needs_info"],
  },
  returns: {
    kind: "returns",
    page: "Returns",
    title: "Returns bulk update",
    scope: "parcels that can go back to the sender (failed deliveries, exceptions, parcels back at a hub after a delivery attempt) and returns already scheduled",
    choices: [BASE.SCHEDULE_RETURN, BASE.ADD_NOTE],
    columns: ["tracking_id", "status", "action", ...NOTE, "current_hub", "delivery_rider", "cn", "merchant", "sender", "recipient_name", "district", "zone", "cod", "created", "sla_state", ...TAIL],
    statuses: ["AT_HUB", "READY_FOR_COLLECTION", "RETRY_SCHEDULED", "EXCEPTION", "RETURN_SCHEDULED"],
    presets: [],
  },
  all: {
    kind: "all",
    page: "All parcels",
    title: "All parcels bulk update",
    scope: "any parcels you filter, with every bulk action",
    choices: Object.values(BASE),
    columns: BULK_COLUMNS.map(c => c.key),
    statuses: [...OPEN, "DELIVERED", "PICKUP_CANCELLED", "RETURNED"],
    presets: ["pending_review", "at_hub_unassigned", "needs_info"],
  },
};

const TERMINAL: ParcelStatus[] = ["DELIVERED", "PICKUP_CANCELLED", "RETURNED"];

/** The parcels a page's file holds (ANDed with the dialog's filters and the caller's hub scope). */
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

/** The page templates the caller can use, each with only the actions the caller may perform. */
export function kindsFor(permissions: ReadonlySet<string>) {
  return BULK_KINDS.map(k => KINDS[k])
    .map(def => ({ ...def, choices: def.choices.filter(c => ACTION_PERMISSIONS[c.action].every(p => permissions.has(p))) }))
    .filter(def => def.choices.length > 0);
}

export const columnsOf = (kind: BulkKind): BulkColumn[] => KINDS[kind].columns.map(key => BULK_COLUMNS.find(c => c.key === key)!);

/** The statuses New status offers for a kind (its choices without a fixed status). */
export const newStatusesOf = (kind: BulkKind) => [...new Set(KINDS[kind].choices.filter(c => c.action === "SET_STATUS" && !c.status).flatMap(c => c.statuses ?? OPS_SETTABLE))];

export const isKind = (v: string): v is BulkKind => (BULK_KINDS as readonly string[]).includes(v);
export const statusLabels = (statuses: readonly ParcelStatus[]) => statuses.map(s => PARCEL_STATUS_LABEL[s]);
