import { parseParcelStatus, type ParcelStatus } from "@delivery-fast/shared";

/**
 * The bulk update sheet ("Parcels"): read-only data columns (greyed, locked) describing each
 * parcel, and the editable action columns operations fill in. One definition drives the export,
 * the header matching on upload, the preview and the failed-rows download.
 */

export const BULK_ACTIONS = [
  "ACCEPT_PICKUP",
  "ASSIGN_DELIVERY",
  "SET_STATUS",
  "RECEIVE_AT_HUB",
  "CANCEL",
  "TO_DROP_OFF",
  "TO_PICKUP",
  "SCHEDULE_RETURN",
  "COMPLETE_DETAILS",
  "ADD_NOTE",
] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

export const ACTION_LABEL: Record<BulkAction, string> = {
  ACCEPT_PICKUP: "Accept & assign pickup rider",
  ASSIGN_DELIVERY: "Assign delivery rider",
  SET_STATUS: "Change status",
  RECEIVE_AT_HUB: "Receive at hub",
  CANCEL: "Cancel",
  TO_DROP_OFF: "Change to drop-off",
  TO_PICKUP: "Change to rider pickup",
  SCHEDULE_RETURN: "Schedule return",
  COMPLETE_DETAILS: "Complete details",
  ADD_NOTE: "Add note",
};

/** What each action does and which columns it reads (Instructions sheet). */
export const ACTION_HELP: Record<BulkAction, { needs: string; does: string }> = {
  ACCEPT_PICKUP: {
    needs: "Rider (empty = the Suggested rider)",
    does: "Accepts a pickup request (Pending operations confirmation) and assigns the pickup rider; also re-assigns another pickup rider while the pickup is assigned or confirmed.",
  },
  ASSIGN_DELIVERY: {
    needs: "Rider; the recipient name, phone, address, district and zone must be known (fill the Set … columns of a \"Needs info\" order in the same row)",
    does: "Assigns the delivery rider to a parcel at a hub (or re-assigns one). The recipient gets the delivery code by SMS.",
  },
  SET_STATUS: {
    needs: "New status; Hub for At hub / In transit (empty = the current hub)",
    does: "Moves the parcel to another status by the lifecycle rules. Assignments, cancellations and returns have their own actions; Delivered is only set by the rider with proof.",
  },
  RECEIVE_AT_HUB: {
    needs: "Hub (empty = the drop-off hub, or your own hub)",
    does: "Receives the parcel at a hub (At hub). A drop-off is received only at the hub it was booked for.",
  },
  CANCEL: { needs: "Reason / note", does: "Cancels the pickup request (before it is picked up). The sender is notified." },
  TO_DROP_OFF: {
    needs: "Hub (the drop-off hub; hub operators may leave it empty for their own hub)",
    does: "Turns a rider pickup into a drop-off at a hub, before pickup. An assigned pickup rider is released; the parcel is re-priced and the sender told where to bring it.",
  },
  TO_PICKUP: { needs: "Nothing else", does: "Turns a drop-off back into a rider pickup, before it is received. Re-priced; the sender is notified." },
  SCHEDULE_RETURN: { needs: "Reason / note", does: "Schedules the return to the sender (RTO) with the return charge." },
  COMPLETE_DETAILS: {
    needs: "At least one Set … column",
    does: "Completes a \"Needs info\" order (recipient, address, destination, weight, service). It is re-priced with the tariff frozen at booking.",
  },
  ADD_NOTE: { needs: "Reason / note", does: "Adds an internal note to the parcel's history (staff only)." },
};

/** Statuses operations may set with "Change status" (assignments, cancellations and returns have their own actions; never Delivered). */
export const OPS_SETTABLE: readonly ParcelStatus[] = ["PICKUP_CONFIRMED", "PICKED_UP", "AT_HUB", "IN_TRANSIT", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "RETURNED", "EXCEPTION"];

export const PRIORITIES = ["Normal", "High"] as const;
export const SERVICES = ["Regular", "Same day", "Express"] as const;

export type BulkColumnKey =
  | "tracking_id"
  | "cn"
  | "merchant"
  | "sender"
  | "recipient_name"
  | "recipient_phone"
  | "recipient_address"
  | "district"
  | "zone"
  | "intake"
  | "drop_off_hub"
  | "status"
  | "pickup_rider"
  | "delivery_rider"
  | "current_hub"
  | "cod"
  | "weight"
  | "service"
  | "created"
  | "sla_due"
  | "sla_state"
  | "missing"
  | "suggested_rider"
  | "action"
  | "rider"
  | "new_status"
  | "hub"
  | "note"
  | "priority"
  | "set_recipient_name"
  | "set_recipient_phone"
  | "set_address"
  | "set_district"
  | "set_zone"
  | "set_area"
  | "set_weight"
  | "set_service"
  | "version"
  | "template";

export type BulkListKey = "actions" | "riders" | "statuses" | "hubs" | "priorities" | "districts" | "zones" | "areas" | "services";

export interface BulkColumn {
  key: BulkColumnKey;
  header: string;
  /** Read-only data (grey, locked) or an editable action column. */
  editable: boolean;
  description: string;
  width: number;
  aliases?: string[];
  list?: BulkListKey;
  /** Strict lists refuse other values in Excel. */
  strict?: boolean;
  /** Kept as text (phone numbers). */
  text?: boolean;
  hidden?: boolean;
  number?: { min: number; max: number };
  maxLength?: number;
}

const ro = (key: BulkColumnKey, header: string, width: number, description: string, extra: Partial<BulkColumn> = {}): BulkColumn => ({ key, header, width, description, editable: false, ...extra });
const ed = (key: BulkColumnKey, header: string, width: number, description: string, extra: Partial<BulkColumn> = {}): BulkColumn => ({ key, header, width, description, editable: true, ...extra });

export const BULK_COLUMNS: BulkColumn[] = [
  ro("tracking_id", "Tracking ID", 18, "The parcel. Don't change it.", { aliases: ["tracking", "tracking_no", "consignment_id"] }),
  ro("status", "Current status", 24, "The status when you downloaded the file."),
  ro("suggested_rider", "Suggested rider", 30, "Routing suggestion (zone, route, load, distance) for parcels waiting for a pickup or delivery rider. Leave Rider empty to accept it."),
  ed("action", "Action", 28, "What to do with this parcel. Leave empty to skip the row.", { list: "actions", strict: true }),
  ed("rider", "Rider", 34, "Rider code · name · hub. Choose a Hub first to narrow the list to that hub's riders.", { list: "riders", strict: false }),
  ed("new_status", "New status", 22, "For Change status: the status to move to.", { list: "statuses", strict: true }),
  ed("hub", "Hub", 24, "For Receive at hub, Change to drop-off and At hub / In transit; for rider actions it narrows the Rider list.", { list: "hubs", strict: true }),
  ed("note", "Reason / note", 36, "Reason (cancel, return) or note; added to the parcel's history for staff.", { maxLength: 500, aliases: ["reason", "note", "remarks"] }),
  ed("priority", "Priority", 11, "High rows are applied first (they get riders before the others).", { list: "priorities", strict: true }),
  ro("cn", "CN", 16, "Pre-printed consignment number, if one was used."),
  ro("merchant", "Merchant", 26, "Merchant (or the website sender)."),
  ro("sender", "Pickup address", 34, "Sender and pickup address."),
  ro("recipient_name", "Recipient name", 22, "Recipient."),
  ro("recipient_phone", "Recipient phone", 16, "Recipient's phone.", { text: true }),
  ro("recipient_address", "Recipient address", 34, "Delivery address."),
  ro("district", "District", 16, "Delivery district."),
  ro("zone", "Zone", 16, "Delivery zone."),
  ro("intake", "Intake", 14, "Rider pickup or drop-off at a hub."),
  ro("drop_off_hub", "Drop-off hub", 20, "The hub a drop-off is brought to."),
  ro("pickup_rider", "Pickup rider", 26, "Current pickup rider."),
  ro("delivery_rider", "Delivery rider", 26, "Current delivery rider."),
  ro("current_hub", "Current hub", 20, "Hub holding the parcel."),
  ro("cod", "COD (৳)", 11, "Cash to collect."),
  ro("weight", "Weight (kg)", 11, "Weight."),
  ro("service", "Service", 12, "Service level."),
  ro("created", "Created", 17, "Booked at (Dhaka time)."),
  ro("sla_due", "SLA due", 17, "Pickup or delivery due time (Dhaka time)."),
  ro("sla_state", "SLA state", 16, "Awaiting review, On track, At risk or Breached."),
  ro("missing", "Missing fields", 26, "Details a \"Needs info\" order still misses (needed before delivery)."),
  ed("set_recipient_name", "Set recipient name", 22, "Complete details: recipient name.", { maxLength: 120 }),
  ed("set_recipient_phone", "Set recipient phone", 18, "Complete details: Bangladeshi mobile number (17XXXXXXXX or 017XXXXXXXX).", { text: true }),
  ed("set_address", "Set address", 34, "Complete details: delivery address.", { maxLength: 200 }),
  ed("set_district", "Set district", 18, "Complete details: delivery district.", { list: "districts", strict: true }),
  ed("set_zone", "Set zone", 18, "Complete details: delivery zone (the list follows Set district).", { list: "zones", strict: true }),
  ed("set_area", "Set area", 20, "Complete details: area / landmark (optional).", { list: "areas", strict: false, maxLength: 120 }),
  ed("set_weight", "Set weight (kg)", 13, "Complete details: weight in kg.", { number: { min: 0.01, max: 50 } }),
  ed("set_service", "Set service", 13, "Complete details: service level.", { list: "services", strict: true }),
  ro("version", "version", 8, "Optimistic locking: the parcel's version when downloaded. Don't change it.", { hidden: true }),
  ro("template", "template", 12, "The page this file was downloaded for (bulk-kinds.ts). Don't change it.", { hidden: true }),
];

export const DETAIL_KEYS = ["set_recipient_name", "set_recipient_phone", "set_address", "set_district", "set_zone", "set_area", "set_weight", "set_service"] as const satisfies readonly BulkColumnKey[];

export const SHEET_NAME = "Parcels";

const normHeader = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/\s*\*$/, "")
    .replace(/[^a-z0-9৳]+/g, "_")
    .replace(/^_|_$/g, "");

/** Matches a header row to column keys (by header, key or alias). */
export function matchBulkHeaders(headers: string[]) {
  const byName = new Map<string, BulkColumnKey>();
  for (const c of BULK_COLUMNS) for (const n of [c.header, c.key, ...(c.aliases ?? [])]) byName.set(normHeader(n), c.key);
  const map = headers.map(h => byName.get(normHeader(String(h ?? ""))) ?? null);
  return { map, unknown: headers.filter((h, i) => String(h ?? "").trim() && !map[i] && normHeader(String(h)) !== "error") };
}

export const headerOf = (key: string) => BULK_COLUMNS.find(c => c.key === key)?.header ?? (key === "row" ? "Row" : key);

/** A status label or enum value that operations may set with "Change status". */
export const parseSettableStatus = (value: string) => {
  const status = parseParcelStatus(value.trim());
  return status && OPS_SETTABLE.includes(status) ? status : undefined;
};

/** The rider code in "R-2048 · Jordan Rivera · Gulshan Hub" (or a bare code). */
export const riderCodeOf = (value: string) => value.split("·")[0].trim().toUpperCase();
