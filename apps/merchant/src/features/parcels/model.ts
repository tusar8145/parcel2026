/** A parcel as GET /parcels returns it to a merchant (the merchant view: public events only, nothing internal). */
export interface Parcel {
  id: string;
  trackingId: string;
  type: "DOCUMENT" | "ECOMMERCE" | "PARCEL" | "FRAGILE" | string;
  status: string;
  statusLabel: string;
  merchantOrderRef?: string | null;
  originBranchCode?: string | null;
  receiverRelation?: string | null;
  contents?: string | null;
  packaging?: string | null;
  weightKg?: number | null;
  codAmount?: number;
  declaredValue?: number | null;
  serviceLevelLabel?: string;
  incomplete?: boolean;
  missingFields?: string[];
  canCancel?: boolean;
  createdAt: string;
  updatedAt: string;
  recipient: { name?: string | null; phone?: string | null };
  delivery: { label?: string | null; street?: string | null; area?: string | null; zone?: string | null; district?: string | null };
  charges: { base: number; weight: number; service: number; codFee: number; discount: number; total: number };
  returnInfo?: { receivedAt?: string | null } | null;
  events?: { status?: string; title?: string; description?: string | null; location?: string | null; at?: string; internal?: boolean; createdAt?: string }[];
  merchant?: { id: string; name?: string } | null;
}

/** Statuses that end a parcel's journey (no label to print). */
export const TERMINAL = ["DELIVERED", "PICKUP_CANCELLED", "RETURNED"];
/** "Needs info" can be completed while the parcel is still waiting for pickup. */
export const EDITABLE_INCOMPLETE = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];
export const NEEDS_INFO = "__needs_info";
/** The status filter of each list (shared/merchant-orders.js STATUSES). */
export const STATUSES = {
  new: ["Pending operations confirmation", "Pickup assigned", "Pickup confirmed"],
  all: ["Pending operations confirmation", "Pickup assigned", "Pickup confirmed", "Picked up", "At hub", "In transit", "Assigned", "Out for delivery", "Retry scheduled", "Ready for collection", "Exception", "Return scheduled", "Delivered", "Returned", "Pickup cancelled"],
};

/** Documents keep "Document type — item" in `contents`. */
export const splitContents = (contents?: string | null): [string, string] => {
  const [type, item] = String(contents || "").split(" — ");
  return [type || "", item || type || ""];
};
/** The document filter's value of a parcel (shared/merchant-orders.js contentOf). */
export const documentOf = (p: Parcel) => String(p.contents || "").split(/\s[-·|]\s|:/)[0].trim();
export const destination = (p: Parcel) => [p.delivery?.zone, p.delivery?.district].filter(Boolean).join(", ") || "—";

/** The status pill's tone. */
export function toneOf(status: string): "good" | "warn" | "bad" | "info" | undefined {
  if (status === "DELIVERED") return "good";
  if (["EXCEPTION", "PICKUP_CANCELLED", "RETURNED", "RETURN_SCHEDULED"].includes(status)) return "bad";
  if (["RETRY_SCHEDULED", "PENDING_CONFIRMATION"].includes(status)) return "warn";
  return "info";
}
