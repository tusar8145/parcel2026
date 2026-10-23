/**
 * The spreadsheet columns of the three bulk-create templates (Customer parcel, E-commerce,
 * Banking & Financial). One definition drives the template (headers, dropdowns, instructions),
 * the header matching on upload, validation and the failed-rows download. Super admins choose
 * which columns are required and their defaults (ImportConfigService); `required` / `default`
 * here are the built-in settings.
 *
 * There is no Merchant column: the merchant is chosen in the upload modal (operations) or is the
 * signed-in merchant. First / last mile, the drop hub and the messages are chosen there too.
 */
import type { PackageSegment } from "@delivery-fast/shared";

/** API kinds: `document` is Banking & Financial (the name is kept; `banking` is accepted as an alias). */
export const IMPORT_KINDS = ["ecommerce", "document", "customer"] as const;
export type ImportKindKey = (typeof IMPORT_KINDS)[number];
export const KIND_ENUM = { ecommerce: "ECOMMERCE", document: "DOCUMENT", customer: "CUSTOMER" } as const;
export type ImportKindEnum = (typeof KIND_ENUM)[ImportKindKey];
export const kindKeyOf = (kind: ImportKindEnum): ImportKindKey => (kind === "DOCUMENT" ? "document" : kind === "CUSTOMER" ? "customer" : "ecommerce");
/** What people see: "E-commerce", "Banking & Financial", "Customer parcel". */
export const KIND_LABEL: Record<ImportKindKey, string> = { ecommerce: "E-commerce", document: "Banking & Financial", customer: "Customer parcel" };
export const segmentOf = (kind: ImportKindKey): PackageSegment => (kind === "document" ? "BANKING_FINANCIAL" : kind === "customer" ? "CUSTOMER" : "ECOMMERCE");
/** The merchant type of a merchant template (the customer template has no merchant). */
export const merchantTypeOf = (kind: ImportKindKey): "ECOMMERCE" | "BANKING_FINANCIAL" | null => (kind === "document" ? "BANKING_FINANCIAL" : kind === "ecommerce" ? "ECOMMERCE" : null);

/** Option lists, filled from live data (geography, the category's products, the package). */
export type ListKey = "districts" | "zones" | "areas" | "products" | "speeds" | "weights" | "yesNo";

export type ColumnKey =
  | "sender_name"
  | "sender_phone"
  | "pickup_address"
  | "pickup_district"
  | "pickup_zone"
  | "pickup_area"
  | "recipient_name"
  | "recipient_phone"
  | "address"
  | "district"
  | "zone"
  | "area"
  | "product_type"
  | "cod_amount"
  | "declared_value"
  | "weight_kg"
  | "service_level"
  | "open_box"
  | "order_ref"
  | "instructions";

/** Column keys of older templates that no longer exist (dropped from stored settings; ignored on upload). */
export const REMOVED_COLUMN_KEYS = ["merchant", "address_type", "parcel_type", "item_description", "document_type", "document_item", "receiver_relationship", "cod", "packaging", "branch_code"] as const;

export interface ColumnDef {
  key: ColumnKey;
  header: string;
  /** Other header spellings accepted on upload (normalised: lower case, spaces → _). */
  aliases: string[];
  description: string;
  example: string;
  /** Required unless super admin changes it. */
  required: boolean;
  /** Super admin may toggle "required". */
  configurable: boolean;
  /** Super admin may set a value used when the cell is empty. */
  defaultable: boolean;
  /** Built-in value used when the cell is empty. */
  default?: string;
  /** Dropdown values; strict lists refuse other values, others only suggest. */
  list?: ListKey;
  strictList?: boolean;
  /** Dependent dropdown: the column whose value narrows this list (zone ← district, area ← zone). */
  parent?: ColumnKey;
  /** Stored as text in Excel (keeps leading zeros). */
  text?: boolean;
  number?: { min: number; max: number };
  maxLength?: number;
  width: number;
  /** Only in the template when the package offers it (still read when present, then checked against the package). */
  needs?: PackageNeed;
  /**
   * false: not a column of the blank template (district / zone / area are found from the full address,
   * import-places.ts), but still read when a file has it, and kept in files carrying rows (Scan with phone,
   * rows not created).
   */
  inTemplate?: boolean;
}

/** What a package must offer for a column to be in its template (see packageOptions in packages/shared). */
export type PackageNeed = "cod" | "openBox";
export interface PackageColumnOptions {
  cod: boolean;
  openBox: boolean;
}

const c = (def: Omit<ColumnDef, "configurable" | "defaultable" | "aliases"> & Partial<Pick<ColumnDef, "configurable" | "defaultable" | "aliases">>): ColumnDef => ({
  configurable: true,
  defaultable: false,
  aliases: [],
  ...def,
});

const phoneText = "Bangladeshi mobile number. +880 is added for you: type 17XXXXXXXX or 017XXXXXXXX (8801… and +8801… also work).";

// ───────────── sender and pickup (customer parcels: there is no merchant to take them from) ─────────────

const senderName = c({
  key: "sender_name",
  header: "Sender name",
  aliases: ["sender", "sender_name", "from_name", "pickup_name", "pickup_contact"],
  description: "Who sends the parcel (the walk-in or website customer).",
  example: "Karim Hossain",
  required: true,
  configurable: false,
  maxLength: 120,
  width: 22,
});
const senderPhone = c({
  key: "sender_phone",
  header: "Sender phone",
  aliases: ["sender_phone", "sender_mobile", "from_phone", "pickup_phone"],
  description: `${phoneText} The sender gets the parcel messages.`,
  example: "01712345678",
  required: true,
  configurable: false,
  text: true,
  width: 16,
});
const pickupAddress = c({
  key: "pickup_address",
  header: "Pickup address",
  aliases: ["pickup_address", "pickup_street", "sender_address", "from_address"],
  description: "The full pickup address: house, road, area, thana and district (e.g. House 5, Road 2, Gulshan 1, Dhaka). The pickup district and zone are found from it.",
  example: "House 5, Road 2, Gulshan 1, Dhaka",
  required: true,
  configurable: false,
  maxLength: 200,
  width: 30,
});
const pickupDistrict = c({
  key: "pickup_district",
  inTemplate: false,
  header: "Pickup district",
  aliases: ["pickup_district", "sender_district", "from_district", "pickup_city"],
  description: "District the parcel is collected from (from the coverage list). The price depends on the pickup and delivery districts.",
  example: "Dhaka North",
  required: true,
  configurable: false,
  list: "districts",
  strictList: true,
  width: 18,
});
const pickupZone = c({
  key: "pickup_zone",
  inTemplate: false,
  header: "Pickup zone",
  aliases: ["pickup_zone", "pickup_thana", "sender_zone", "from_zone"],
  description: "Zone of the pickup district (the dropdown follows the pickup district).",
  example: "Gulshan",
  required: true,
  configurable: false,
  list: "zones",
  strictList: true,
  parent: "pickup_district",
  width: 18,
});
const pickupArea = c({
  key: "pickup_area",
  inTemplate: false,
  header: "Pickup area",
  aliases: ["pickup_area", "pickup_landmark", "sender_area"],
  description: "Area or landmark inside the pickup zone (optional, free text; the list has suggestions).",
  example: "Gulshan 1",
  required: false,
  list: "areas",
  parent: "pickup_zone",
  maxLength: 120,
  width: 20,
});

// ───────────── recipient and delivery ─────────────

const recipientName = (header: string, example: string) =>
  c({ key: "recipient_name", header, aliases: ["customer_name", "recipient_name", "recipient", "receiver_name", "name", "customer"], description: "Who receives the delivery.", example, required: false, maxLength: 120, width: 24 });
const recipientPhone = (header: string) =>
  c({
    key: "recipient_phone",
    header,
    aliases: ["phone", "recipient_phone", "customer_phone", "receiver_phone", "mobile", "mobile_number", "phone_number", "contact"],
    description: `${phoneText} Required: a row without it is not created.`,
    example: "01812345678",
    required: true,
    configurable: false,
    text: true,
    width: 16,
  });
const address = (header: string) =>
  c({
    key: "address",
    header,
    aliases: ["address", "street", "delivery_address", "full_address", "street_address", "recipient_address"],
    description: "The full address: house, road, area, thana and district (e.g. Flat 4B, House 22, Road 7, Banani, Dhaka). District, zone and area are found from it, so write the area and district names in it. Leave empty if unknown: the parcel is created as \"Needs info\" and held before delivery until it is completed.",
    example: "Flat 4B, House 22, Road 7, Banani, Dhaka",
    required: false,
    maxLength: 200,
    width: 32,
  });
const district = (header: string) =>
  c({
    key: "district",
    header,
    inTemplate: false,
    aliases: ["district", "city", "delivery_district", "recipient_district"],
    description: "Destination district from the coverage list. Leave empty if unknown: the parcel is created as \"Needs info\" and priced to the default destination until it is completed.",
    example: "Dhaka Central",
    required: false,
    list: "districts",
    strictList: true,
    width: 18,
  });
const zone = (header: string) =>
  c({
    key: "zone",
    header,
    inTemplate: false,
    aliases: ["zone", "thana", "delivery_zone", "area_zone", "recipient_zone"],
    description: "Destination zone of that district (the dropdown follows the district). A zone alone also works when only one district has it.",
    example: "Dhanmondi",
    required: false,
    list: "zones",
    strictList: true,
    parent: "district",
    width: 18,
  });
const area = (header: string) =>
  c({
    key: "area",
    header,
    inTemplate: false,
    aliases: ["area", "landmark", "locality", "delivery_area"],
    description: "Area or landmark inside the zone (optional, free text; the list has suggestions and follows the zone).",
    example: "Dhanmondi Road 7",
    required: false,
    list: "areas",
    parent: "zone",
    maxLength: 120,
    width: 20,
  });

// ───────────── parcel ─────────────

const product = (list: string) =>
  c({
    key: "product_type",
    header: "Product",
    aliases: ["product", "product_type", "product_name", "category", "product_category"],
    description: `Product from the ${list} list (optional), shown with its type. ${list === "Banking & Financial" ? "Empty = no product." : "The type (Regular, Document or Books) prices the parcel; empty = Regular."}`,
    example: "",
    required: false,
    defaultable: true,
    list: "products",
    strictList: true,
    width: 30,
  });
const codAmount = c({
  key: "cod_amount",
  header: "COD amount (৳)",
  aliases: ["cod_amount", "cod_(৳)", "cod_amount_(৳)", "collect_amount", "cash_amount", "amount_to_collect"],
  description: "Cash to collect from the recipient, in taka (0 to 1,000,000). Empty or 0 = prepaid (no cash on delivery).",
  example: "1500",
  required: false,
  number: { min: 0, max: 1_000_000 },
  width: 14,
  needs: "cod",
});
const declaredValue = c({
  key: "declared_value",
  header: "Product value (৳)",
  aliases: ["declared_value", "order_value", "product_value", "value", "invoice_value", "product_value_(৳)", "declared_value_(৳)"],
  description: "The value of the goods, in taka (optional; for claims).",
  example: "1500",
  required: false,
  number: { min: 0, max: 1_000_000 },
  width: 14,
});
const weight = c({
  key: "weight_kg",
  header: "Weight (kg)",
  aliases: ["weight_kg", "weight", "weight_(kg)", "kg", "parcel_weight"],
  description: "Weight in kg (0.01 to 50). Choose a value from the list or type the exact weight. Weight above the included 0.5 kg is charged per started kg.",
  example: "0.5",
  required: false,
  defaultable: true,
  default: "0.5",
  list: "weights",
  number: { min: 0.01, max: 50 },
  width: 12,
});
const service = (description: string) =>
  c({
    key: "service_level",
    header: "Service",
    aliases: ["service_level", "delivery_service", "service", "service_type", "delivery_speed", "speed", "document_type"],
    description,
    example: "Regular",
    required: false,
    defaultable: true,
    default: "Regular",
    list: "speeds",
    strictList: true,
    width: 26,
  });
const openBox = c({
  key: "open_box",
  header: "Open box",
  aliases: ["open_box", "check_before_pay", "open_box_/_check_before_pay"],
  description: "Yes lets the recipient open the box and check before paying. Empty = No.",
  example: "No",
  required: false,
  list: "yesNo",
  strictList: true,
  width: 10,
  needs: "openBox",
});
const orderRef = (header: string, example: string) =>
  c({
    key: "order_ref",
    header,
    aliases: ["order_ref", "order_id", "order_no", "reference_no", "reference", "ref", "merchant_order_ref", "external_id", "invoice_no"],
    description: "Your own reference. Each one is booked once: uploading the same file again doesn't book it twice. Without it, an identical row is also recognised.",
    example,
    required: false,
    text: true,
    maxLength: 80,
    width: 18,
  });
const instructions = c({ key: "instructions", header: "Delivery instructions", aliases: ["instructions", "note", "notes", "remarks", "comment"], description: "Anything the rider should know.", example: "Call before delivery", required: false, maxLength: 500, width: 28 });

const parcelService = "The service from the package (one choice). Empty = Regular. Express is same-day delivery, only inside the same district.";

export const COLUMNS: Record<ImportKindKey, ColumnDef[]> = {
  ecommerce: [
    recipientName("Customer name", "Ayesha Rahman"),
    recipientPhone("Customer phone"),
    address("Delivery address"),
    district("District"),
    zone("Zone"),
    area("Area"),
    product("E-commerce"),
    codAmount,
    declaredValue,
    weight,
    service(parcelService),
    openBox,
    orderRef("Order ID", "ORDER-1001"),
    instructions,
  ],
  document: [
    recipientName("Recipient name", "Mahir Chowdhury"),
    recipientPhone("Recipient phone"),
    address("Delivery address"),
    district("District"),
    zone("Zone"),
    area("Area"),
    product("Banking & Financial"),
    service("The service from the package (one choice). Empty = Regular."),
    orderRef("Reference no.", "LOAN-2026-00481"),
    instructions,
  ],
  customer: [
    senderName,
    senderPhone,
    pickupAddress,
    pickupDistrict,
    pickupZone,
    pickupArea,
    recipientName("Recipient name", "Nabila Ahmed"),
    recipientPhone("Recipient phone"),
    address("Delivery address"),
    district("Delivery district"),
    zone("Delivery zone"),
    area("Delivery area"),
    product("Customer"),
    codAmount,
    declaredValue,
    weight,
    service(parcelService),
    openBox,
    orderRef("Reference no.", "WALKIN-1001"),
    instructions,
  ],
};

/** Headers on old files that are recognised but not imported (e.g. the Error column of a failed-rows download). */
export const IGNORED_HEADERS = new Set(["error", "errors", "problem", "status", "result", "tracking_id", "row", "#"]);

/** "Customer phone *" → "customer_phone" */
export const normalizeHeader = (h: string) =>
  h
    .replace(/\*/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-/.]+/g, "_")
    .replace(/^_+|_+$/g, "");

/** Columns of a template for a package (COD and open box only when the package offers them). */
export const columnsFor = (kind: ImportKindKey, pkg?: PackageColumnOptions | null) => COLUMNS[kind].filter(col => !pkg || !col.needs || pkg[col.needs]);

const COD_HEADERS = ["cod", "cod_amount", "cod_(৳)", "cod_amount_(৳)", "cash_on_delivery", "collect_amount"];

/** The "Scan ID" column of a Scan with phone workbook (parcel-scans): kept with the row (cells.__scan), not a field. */
export const SCAN_HEADER = "Scan ID";
const SCAN_HEADERS = ["scan_id", "scan_ref"];

/** Maps each header cell to a column (or null when unknown / ignored); duplicates map once. */
export function matchHeaders(kind: ImportKindKey, headers: string[]): { map: (ColumnKey | "__cod" | "__scan" | null)[]; unknown: string[]; forbidden: string[] } {
  const cols = COLUMNS[kind];
  const used = new Set<ColumnKey>();
  const unknown: string[] = [];
  const forbidden: string[] = [];
  let scan = false;
  const map = headers.map((raw): ColumnKey | "__cod" | "__scan" | null => {
    const h = normalizeHeader(raw);
    if (!h || IGNORED_HEADERS.has(h)) return null;
    if (SCAN_HEADERS.includes(h) && !scan) {
      scan = true;
      return "__scan";
    }
    const col = cols.find(x => normalizeHeader(x.header) === h || x.key === h) ?? cols.find(x => x.aliases.includes(h));
    if (!col) {
      // A COD column on the Banking & Financial template: values are checked (never cash on delivery).
      if (kind === "document" && COD_HEADERS.includes(h)) {
        forbidden.push(raw.trim());
        return "__cod";
      }
      unknown.push(raw.trim());
      return null;
    }
    if (used.has(col.key)) return null;
    used.add(col.key);
    return col.key;
  });
  return { map, unknown, forbidden };
}
