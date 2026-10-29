import { canTransition, INTAKE_CHANGEABLE_STATUSES, PARCEL_INTAKES, PARCEL_STATUSES, TERMINAL_STATUSES, type ParcelStatus } from "@paira-express/shared";
import type { Prisma } from "../../generated/prisma/client";
import { BULK_COLUMNS, DETAIL_KEYS, OPS_SETTABLE, type BulkAction, type BulkColumn, type BulkColumnKey } from "./bulk-columns";

/**
 * Action templates of the bulk update (2026-10-18): one Excel file per action. The user picks an
 * action on a Courier Operations page and downloads only the parcels that can take it (lifecycle and
 * intake rules, ANDed with the page's parcels, the dialog's filters and the caller's hub scope), with
 * only the columns that action needs plus a few read-only info columns. The action is fixed by the
 * file (hidden `template` column = "<page kind>:<action id>"), so the sheet has no Action column.
 *
 * Every template runs an existing single action (bulk-columns.ts `BULK_ACTIONS`), sometimes with a
 * fixed or narrowed status ("Mark picked up" = Change status → Picked up); no new parcel behaviour.
 */

export const BULK_ACTION_IDS = [
  "accept_pickup",
  "reassign_pickup",
  "mark_picked_up",
  "receive_at_hub",
  "mark_exception",
  "assign_delivery",
  "resolve_status",
  "change_status",
  "cancel",
  "to_drop_off",
  "to_pickup",
  "schedule_return",
  "complete_details",
  "add_note",
  "transfer",
] as const;
export type BulkActionId = (typeof BULK_ACTION_IDS)[number];
export const isActionId = (v: string): v is BulkActionId => (BULK_ACTION_IDS as readonly string[]).includes(v);

/** An editable column of a template, with the header and help it has in that template. */
export interface InputSpec {
  key: BulkColumnKey;
  header?: string;
  description?: string;
  /** Required in every row that is applied (the header gets a "*"). */
  required?: boolean;
}

export interface ActionTemplate {
  id: BulkActionId;
  /** "Accept & assign pickup rider": the dialog, the file's title, history. */
  label: string;
  /** The Excel sheet tab (at most 31 characters, no / \ ? * [ ] :). */
  sheet: string;
  /** The single action it runs. */
  action: BulkAction;
  /** Change status: the one status this template sets. */
  status?: ParcelStatus;
  /** Change status: the statuses New status may take. */
  statuses?: readonly ParcelStatus[];
  /** Reason / note required (besides the actions that always need one). */
  noteRequired?: boolean;
  /**
   * true: a row whose input columns are all empty is skipped (the action needs input: a reason, a rider, details…).
   * false: every row in the file is applied; delete the rows you don't want to change.
   */
  skipBlank: boolean;
  /** One line for the action list. */
  summary: string;
  /** "Accept & assign pickup rider: fill Rider for each row …": the first line of the Instructions sheet and the dialog. */
  howTo: string;
  /** What applying a row does. */
  does: string;
  /** Which parcels the file lists. */
  parcels: string;
  /** Read-only columns shown before the input columns (after Tracking ID and Current status). */
  lead: BulkColumnKey[];
  inputs: InputSpec[];
  /** Read-only info columns after the input columns. */
  info: BulkColumnKey[];
  /** The parcels that can take this action now (lifecycle / intake rules); null = any parcel. */
  where: () => Prisma.ParcelWhereInput | null;
  /** The eligible parcels also depend on the caller's hubs and live data (transfer: TransferService.eligibleWhere). */
  scoped?: "transfer";
}

const NOT_COLLECT: Prisma.ParcelWhereInput = { OR: [{ lastMile: null }, { lastMile: { not: "HUB_COLLECT" } }] };

/**
 * Parcels that operations may move to one of `targets` by the lifecycle (canTransition with the
 * parcel's intake and last mile), optionally only from `only` statuses.
 */
export function reachable(targets: readonly ParcelStatus[], only?: readonly ParcelStatus[]): Prisma.ParcelWhereInput {
  const branches: Prisma.ParcelWhereInput[] = [];
  for (const intake of PARCEL_INTAKES)
    for (const collect of [false, true]) {
      const from = PARCEL_STATUSES.filter(s => (!only || only.includes(s)) && targets.some(t => canTransition(s, t, "ops", { intake, lastMile: collect ? "HUB_COLLECT" : null })));
      if (from.length) branches.push({ intake, status: { in: from }, ...(collect ? { lastMile: "HUB_COLLECT" } : NOT_COLLECT) });
    }
  return branches.length ? { OR: branches } : { id: { in: [] } };
}

const STAFF_LOCKED: ParcelStatus[] = [...TERMINAL_STATUSES, "OUT_FOR_DELIVERY"];
export const RESOLVE_STATUSES: readonly ParcelStatus[] = ["AT_HUB", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "EXCEPTION"];

const DETAILS: InputSpec[] = DETAIL_KEYS.map(key => ({ key }));
const note = (header = "Note", description = "Optional: added to the parcel's history for staff."): InputSpec => ({ key: "note", header, description });
const reason = (what: string): InputSpec => ({ key: "note", header: "Reason", required: true, description: `Why: ${what}. Required; added to the parcel's history.` });
const PRIORITY: InputSpec = { key: "priority" };
const riderHub: InputSpec = { key: "hub", description: "Optional: choose a hub to narrow the Rider list to that hub's riders." };

export const ACTIONS: Record<BulkActionId, ActionTemplate> = {
  accept_pickup: {
    id: "accept_pickup",
    label: "Accept & assign pickup rider",
    sheet: "Accept & assign pickup",
    action: "ACCEPT_PICKUP",
    skipBlank: false,
    summary: "Accept pickup requests and give each a pickup rider (the suggested rider unless you choose another).",
    howTo: "fill Rider for each row you want to accept with another rider; leave Rider empty to accept the suggested rider; delete rows you don't want to change.",
    does: "Accepts the pickup request (Pending operations confirmation → Pickup assigned) and assigns the pickup rider. The rider and the sender are notified.",
    parcels: "pickup requests waiting for operations (rider pickups; drop-offs are received at the hub instead)",
    lead: ["suggested_rider"],
    inputs: [{ key: "rider", description: "Rider code · name · hub. Empty = the Suggested rider. Choose a Hub first to narrow the list." }, riderHub, PRIORITY, note()],
    info: ["merchant", "sender", "recipient_name", "district", "zone", "cod", "weight", "created", "sla_due", "sla_state"],
    where: () => reachable(["PICKUP_ASSIGNED"], ["PENDING_CONFIRMATION"]),
  },
  reassign_pickup: {
    id: "reassign_pickup",
    label: "Assign / reassign pickup rider",
    sheet: "Reassign pickup rider",
    action: "ACCEPT_PICKUP",
    skipBlank: true,
    summary: "Give an assigned or confirmed pickup another pickup rider.",
    howTo: "fill Rider for each row whose pickup should go to another rider; rows with an empty Rider are skipped.",
    does: "Assigns another pickup rider while the pickup is assigned or confirmed. The new rider is notified.",
    parcels: "pickups that are assigned or confirmed (not yet picked up)",
    lead: ["pickup_rider"],
    inputs: [{ key: "rider", header: "New rider", required: true, description: "The new pickup rider (code · name · hub). Choose a Hub first to narrow the list." }, riderHub, PRIORITY, note()],
    info: ["merchant", "sender", "intake", "district", "zone", "cod", "created", "sla_due", "sla_state"],
    where: () => reachable(["PICKUP_ASSIGNED"], ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED"]),
  },
  mark_picked_up: {
    id: "mark_picked_up",
    label: "Mark picked up",
    sheet: "Mark picked up",
    action: "SET_STATUS",
    status: "PICKED_UP",
    skipBlank: false,
    summary: "The pickup rider has collected the parcels: Picked up.",
    howTo: "every row is marked Picked up; delete rows you don't want to change. Note is optional.",
    does: "Marks the parcel Picked up (normally the rider does this in the app). Only an assigned or confirmed pickup.",
    parcels: "pickups that are assigned or confirmed",
    lead: ["pickup_rider"],
    inputs: [note()],
    info: ["merchant", "sender", "district", "zone", "cod", "weight", "sla_due", "sla_state"],
    where: () => reachable(["PICKED_UP"]),
  },
  receive_at_hub: {
    id: "receive_at_hub",
    label: "Receive at hub",
    sheet: "Receive at hub",
    action: "RECEIVE_AT_HUB",
    skipBlank: false,
    summary: "Receive parcels at a hub (picked up, in transit, or drop-offs brought in).",
    howTo: "every row is received; choose the Hub that received it (empty = the drop-off hub, or your own hub); delete rows you don't want to change.",
    does: "Receives the parcel at the hub: At hub. A drop-off is received only at the hub it was booked for.",
    parcels: "parcels that can be received at a hub now: picked up, in transit, drop-offs on their way, and parcels coming back to a hub",
    lead: [],
    inputs: [{ key: "hub", header: "Receiving hub", description: "The hub that received it. Empty = the drop-off hub (drop-offs) or your own hub (hub operators)." }, note()],
    info: ["intake", "drop_off_hub", "current_hub", "pickup_rider", "merchant", "recipient_name", "district", "zone", "cod", "weight", "sla_state"],
    where: () => reachable(["AT_HUB"]),
  },
  mark_exception: {
    id: "mark_exception",
    label: "Mark exception",
    sheet: "Mark exception",
    action: "SET_STATUS",
    status: "EXCEPTION",
    noteRequired: true,
    skipBlank: true,
    summary: "Put parcels on hold as exceptions (missing, damaged, wrong hub…).",
    howTo: "write the Reason for each row to put on hold; rows with an empty Reason are skipped.",
    does: "Puts the parcel on hold as an exception; it then shows under Problems to be resolved.",
    parcels: "parcels that can be put on hold by the lifecycle",
    lead: [],
    inputs: [reason("what is wrong: missing, damaged, wrong hub…")],
    info: ["current_hub", "pickup_rider", "delivery_rider", "merchant", "recipient_name", "district", "zone", "cod", "sla_state"],
    where: () => reachable(["EXCEPTION"]),
  },
  assign_delivery: {
    id: "assign_delivery",
    label: "Assign delivery rider",
    sheet: "Assign delivery rider",
    action: "ASSIGN_DELIVERY",
    skipBlank: false,
    summary: "Give parcels at a hub (or already assigned) a delivery rider; complete missing details in the same row.",
    howTo: "fill Rider for each row with another rider; leave Rider empty to use the suggested rider; fill the Set … columns of a \"Needs info\" order; delete rows you don't want to change.",
    does: "Assigns (or re-assigns) the delivery rider. No delivery code is sent yet: the recipient gets it by SMS when the rider starts the delivery. The recipient name, phone, address, district and zone must be known first.",
    parcels: "parcels that can get a delivery rider now (at a hub for doorstep delivery, assigned, or a failed delivery to send out again)",
    lead: ["suggested_rider"],
    inputs: [{ key: "rider", description: "Rider code · name · hub. Empty = the Suggested rider. Choose a Hub first to narrow the list." }, riderHub, PRIORITY, note(), ...DETAILS],
    info: ["current_hub", "delivery_rider", "merchant", "recipient_name", "recipient_phone", "recipient_address", "district", "zone", "cod", "weight", "service", "sla_due", "sla_state", "missing"],
    where: () => reachable(["ASSIGNED"]),
  },
  resolve_status: {
    id: "resolve_status",
    label: "Resolve: change status",
    sheet: "Resolve change status",
    action: "SET_STATUS",
    statuses: RESOLVE_STATUSES,
    skipBlank: true,
    summary: "Resolve exceptions and failed deliveries: back to the hub, out for delivery, retry or exception.",
    howTo: "choose the New status for each row to resolve (At hub, Out for delivery, Retry scheduled or Exception); rows with an empty New status are skipped.",
    does: "Moves the parcel on by the lifecycle rules. To send it back use Schedule return; for another delivery rider use Assign delivery rider.",
    parcels: "exceptions and failed deliveries (retry scheduled)",
    lead: [],
    inputs: [
      { key: "new_status", required: true, description: "At hub, Out for delivery, Retry scheduled or Exception (only moves the lifecycle allows)." },
      { key: "hub", description: "For At hub: the hub it is at (empty = its current hub)." },
      note(),
    ],
    info: ["current_hub", "delivery_rider", "merchant", "recipient_name", "recipient_phone", "district", "zone", "cod", "sla_state"],
    where: () => reachable(RESOLVE_STATUSES, ["EXCEPTION", "RETRY_SCHEDULED"]),
  },
  change_status: {
    id: "change_status",
    label: "Change status",
    sheet: "Change status",
    action: "SET_STATUS",
    statuses: OPS_SETTABLE,
    skipBlank: true,
    summary: "Move parcels to another status by the lifecycle rules (never Delivered).",
    howTo: "choose the New status for each row to change; rows with an empty New status are skipped.",
    does: "Moves the parcel to another status by the lifecycle rules. Assignments, cancellations and returns have their own actions; Delivered is only set by the rider with proof.",
    parcels: "open parcels (not delivered, cancelled or returned)",
    lead: [],
    inputs: [
      { key: "new_status", required: true, description: "The status to move to (only moves the lifecycle allows)." },
      { key: "hub", description: "For At hub / In transit: the hub (empty = its current hub)." },
      note(),
    ],
    info: ["current_hub", "pickup_rider", "delivery_rider", "merchant", "recipient_name", "district", "zone", "cod", "sla_state"],
    where: () => reachable(OPS_SETTABLE),
  },
  cancel: {
    id: "cancel",
    label: "Cancel",
    sheet: "Cancel",
    action: "CANCEL",
    skipBlank: true,
    summary: "Cancel pickup requests before they are picked up (reason required).",
    howTo: "write the Reason for each row to cancel; rows with an empty Reason are skipped.",
    does: "Cancels the pickup request (only before pickup). The sender is notified.",
    parcels: "parcels that can still be cancelled (before pickup)",
    lead: [],
    inputs: [reason("e.g. merchant cancelled by phone")],
    info: ["intake", "pickup_rider", "merchant", "sender", "recipient_name", "district", "zone", "cod", "created", "sla_state"],
    where: () => reachable(["PICKUP_CANCELLED"]),
  },
  to_drop_off: {
    id: "to_drop_off",
    label: "Change to drop-off",
    sheet: "Change to drop-off",
    action: "TO_DROP_OFF",
    skipBlank: false,
    summary: "Turn rider pickups into drop-offs at a hub, before pickup (re-priced).",
    howTo: "choose the Drop-off hub for each row (hub operators: empty = your own hub); delete rows you don't want to change.",
    does: "Turns the rider pickup into a drop-off at the hub. An assigned pickup rider is released; the parcel is re-priced and the sender told where to bring it.",
    parcels: "rider pickups not yet picked up",
    lead: [],
    inputs: [{ key: "hub", header: "New drop-off hub", description: "The hub the sender brings it to. Hub operators may leave it empty for their own hub." }, note()],
    info: ["pickup_rider", "merchant", "sender", "district", "zone", "cod", "weight", "created"],
    where: () => ({ intake: "PICKUP", status: { in: [...INTAKE_CHANGEABLE_STATUSES] } }),
  },
  to_pickup: {
    id: "to_pickup",
    label: "Change to rider pickup",
    sheet: "Change to rider pickup",
    action: "TO_PICKUP",
    skipBlank: false,
    summary: "Turn drop-offs back into rider pickups, before they are received (re-priced).",
    howTo: "every row becomes a rider pickup; delete rows you don't want to change. Note is optional.",
    does: "Turns the drop-off back into a rider pickup, before it is received. Re-priced; the sender is notified.",
    parcels: "drop-offs not yet received at the hub",
    lead: [],
    inputs: [note()],
    info: ["drop_off_hub", "merchant", "sender", "district", "zone", "cod", "weight", "created"],
    where: () => ({ intake: "DROP_OFF", status: { in: [...INTAKE_CHANGEABLE_STATUSES] } }),
  },
  schedule_return: {
    id: "schedule_return",
    label: "Schedule return",
    sheet: "Schedule return",
    action: "SCHEDULE_RETURN",
    skipBlank: true,
    summary: "Send parcels back to the sender (RTO) with the return charge (reason required).",
    howTo: "write the Reason for each row to return; rows with an empty Reason are skipped.",
    does: "Schedules the return to the sender (RTO) with the return charge.",
    parcels: "parcels that can go back to the sender now (at a hub, failed deliveries, exceptions)",
    lead: [],
    inputs: [reason("e.g. recipient refused")],
    info: ["current_hub", "delivery_rider", "merchant", "sender", "recipient_name", "district", "zone", "cod", "sla_state"],
    where: () => reachable(["RETURN_SCHEDULED"]),
  },
  complete_details: {
    id: "complete_details",
    label: "Complete details",
    sheet: "Complete details",
    action: "COMPLETE_DETAILS",
    skipBlank: true,
    summary: "Fill in what \"Needs info\" orders miss (recipient, address, district → zone, weight, service).",
    howTo: "fill the Set … columns of each order to complete (Set zone follows Set district); rows with every Set … column empty are skipped.",
    does: "Completes the order's details. It is re-priced with the tariff frozen at booking (the preview shows the new price).",
    parcels: "orders with details missing (\"Needs info\") that can still change",
    lead: ["missing"],
    inputs: [...DETAILS, note()],
    info: ["merchant", "recipient_name", "recipient_phone", "recipient_address", "district", "zone", "weight", "service", "cod"],
    where: () => ({ incomplete: true, status: { notIn: STAFF_LOCKED } }),
  },
  add_note: {
    id: "add_note",
    label: "Add note",
    sheet: "Add note",
    action: "ADD_NOTE",
    skipBlank: true,
    summary: "Add an internal note to parcels' history (staff only).",
    howTo: "write the Note for each row; rows with an empty Note are skipped.",
    does: "Adds an internal note to the parcel's history (staff only).",
    parcels: "the page's parcels",
    lead: [],
    inputs: [{ key: "note", header: "Note", required: true, description: "The note, added to the parcel's history for staff." }],
    info: ["current_hub", "pickup_rider", "delivery_rider", "merchant", "recipient_name", "district", "zone", "cod", "sla_state"],
    where: () => null,
  },
  transfer: {
    id: "transfer",
    label: "Add to transfer bag",
    sheet: "Transfer to hub",
    action: "ADD_TO_BAG",
    skipBlank: false,
    summary: "Bag parcels at your hub that go to another hub (one bag per destination, or your own bag labels); optionally seal and load them on a trip.",
    howTo: "check the Destination hub of each row (prefilled with the hub serving the recipient's zone); optionally write a Bag: an open bag from the list or your own label to group parcels; delete rows you don't want to send now.",
    does: "Puts the parcel in a transfer bag from its hub to the destination hub (the open bag you name, or a new one per destination / label). After applying you can seal the bags and load them on a trip. The parcel stays \"At hub\" until the truck departs; then it is \"In transit\".",
    parcels: "parcels at your hub whose destination is another hub (the recipient zone's serving hub, or the collection hub) and that aren't in a bag yet",
    lead: ["dest_suggested"],
    inputs: [{ key: "dest_hub", description: "The hub this parcel travels to. Prefilled with the suggestion; choose another from the list if needed." }, { key: "bag" }, note()],
    info: ["current_hub", "recipient_name", "district", "zone", "weight", "cod", "merchant", "service"],
    where: () => ({ status: "AT_HUB" }),
    scoped: "transfer",
  },
};

const base = (key: BulkColumnKey) => BULK_COLUMNS.find(c => c.key === key)!;

/** The template's columns in sheet order, with its own headers and help: Tracking ID, Current status, lead info, inputs, info, hidden version / template. */
export function columnsOf(t: ActionTemplate): BulkColumn[] {
  const ro = (key: BulkColumnKey) => base(key);
  const inputs = t.inputs.map(i => {
    const c = base(i.key);
    const header = i.header ?? c.header;
    return { ...c, header: i.required ? `${header} *` : header, description: i.description ?? c.description, required: !!i.required, aliases: [...(c.aliases ?? []), c.header, header] };
  });
  return [ro("tracking_id"), ro("status"), ...t.lead.map(ro), ...inputs, ...t.info.map(ro), ro("version"), ro("template")];
}

/** The input columns whose emptiness makes a row "blank" (Priority doesn't count). */
export const inputKeys = (t: ActionTemplate) => t.inputs.map(i => i.key).filter(k => k !== "priority");

/** "new_orders:accept_pickup" in the hidden template column. */
export const templateValue = (kind: string, id: BulkActionId) => `${kind}:${id}`;
