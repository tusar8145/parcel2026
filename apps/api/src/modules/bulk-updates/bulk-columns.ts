import { parseParcelStatus, type ParcelStatus } from "@paira-express/shared";

/**
 * The columns of the bulk update sheets: read-only data columns (greyed, locked) describing each
 * parcel, and the editable input columns operations fill in. Each action template (bulk-actions.ts)
 * picks its columns from these, sometimes with its own header and help; one definition drives the
 * export, the header matching on upload, the preview and the failed-rows download.
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
  "ADD_TO_BAG",
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
  ADD_TO_BAG: "Add to transfer bag",
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
  | "dest_suggested"
  | "dest_hub"
  | "bag"
  | "version"
  | "template";

export type BulkListKey = "riders" | "statuses" | "hubs" | "priorities" | "districts" | "zones" | "areas" | "services" | "dest_hubs" | "bags";

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
  /** Required in every applied row (action templates: the header ends with "*"). */
  required?: boolean;
  number?: { min: number; max: number };
  maxLength?: number;
}

const ro = (key: BulkColumnKey, header: string, width: number, description: string, extra: Partial<BulkColumn> = {}): BulkColumn => ({ key, header, width, description, editable: false, ...extra });
const ed = (key: BulkColumnKey, header: string, width: number, description: string, extra: Partial<BulkColumn> = {}): BulkColumn => ({ key, header, width, description, editable: true, ...extra });

export const BULK_COLUMNS: BulkColumn[] = [
  ro("tracking_id", "Tracking ID", 18, "The parcel. Don't change it.", { aliases: ["tracking", "tracking_no", "consignment_id"] }),
  ro("status", "Current status", 24, "The status when you downloaded the file."),
  ro("suggested_rider", "Suggested rider", 30, "Routing suggestion (zone, route, load, distance) for parcels waiting for a pickup or delivery rider. Leave Rider empty to accept it."),
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
  ro("dest_suggested", "Suggested destination", 24, "The hub serving the recipient's zone (or the collection hub). Empty: no hub serves that zone yet; choose the Destination hub."),
  ed("dest_hub", "Destination hub", 24, "The hub this parcel travels to (prefilled with the suggestion). Every hub of the network.", { list: "dest_hubs", strict: true, aliases: ["destination", "to_hub"] }),
  ed("bag", "Bag", 30, "Optional: an open bag (BG-…) from the list, or a label of your own to group parcels into a new bag (e.g. NORTH-1). Empty = one bag per destination for this upload.", { list: "bags", strict: false, maxLength: 60, aliases: ["bag_number", "bag_label"] }),
  ro("version", "version", 8, "Optimistic locking: the parcel's version when downloaded. Don't change it.", { hidden: true }),
  ro("template", "template", 26, "The page and action this file was downloaded for (page:action, bulk-actions.ts). Don't change it.", { hidden: true }),
];

export const DETAIL_KEYS = ["set_recipient_name", "set_recipient_phone", "set_address", "set_district", "set_zone", "set_area", "set_weight", "set_service"] as const satisfies readonly BulkColumnKey[];

const normHeader = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/\s*\*$/, "")
    .replace(/[^a-z0-9৳]+/g, "_")
    .replace(/^_|_$/g, "");

/** Matches a header row to the columns of a template (by its header, the base header, key or alias). */
export function matchBulkHeaders(headers: string[], columns: readonly BulkColumn[] = BULK_COLUMNS) {
  const byName = new Map<string, BulkColumnKey>();
  for (const c of columns) for (const n of [c.header, c.key, ...(c.aliases ?? [])]) byName.set(normHeader(n), c.key);
  const map = headers.map(h => byName.get(normHeader(String(h ?? ""))) ?? null);
  return {
    map,
    unknown: headers.filter((h, i) => String(h ?? "").trim() && !map[i] && normHeader(String(h)) !== "error"),
    /** The multi-action file of before 2026-10-18 had an Action column. */
    legacyAction: headers.some(h => normHeader(String(h ?? "")) === "action"),
  };
}

export const headerOf = (key: string, columns: readonly BulkColumn[] = BULK_COLUMNS) =>
  columns.find(c => c.key === key)?.header ?? BULK_COLUMNS.find(c => c.key === key)?.header ?? (key === "row" ? "Row" : key === "action" ? "Action" : key);

/** A status label or enum value that operations may set with "Change status". */
export const parseSettableStatus = (value: string) => {
  const status = parseParcelStatus(value.trim());
  return status && OPS_SETTABLE.includes(status) ? status : undefined;
};

/** The rider code in "R-2048 · Jordan Rivera · Gulshan Hub" (or a bare code). */
export const riderCodeOf = (value: string) => value.split("·")[0].trim().toUpperCase();
