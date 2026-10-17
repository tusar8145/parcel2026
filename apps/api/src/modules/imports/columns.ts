/**
 * The spreadsheet columns of the two import templates. One definition drives the template
 * (headers, dropdowns, instructions), the header matching on upload, validation and the
 * failed-rows download. Super admins choose which columns are required and their defaults
 * (ImportConfigService); `required` / `default` here are the built-in settings.
 */

export const IMPORT_KINDS = ["ecommerce", "document"] as const;
export type ImportKindKey = (typeof IMPORT_KINDS)[number];
export const KIND_ENUM = { ecommerce: "ECOMMERCE", document: "DOCUMENT" } as const;
export const kindKeyOf = (kind: "ECOMMERCE" | "DOCUMENT"): ImportKindKey => (kind === "DOCUMENT" ? "document" : "ecommerce");

/** Option lists, filled from live configuration (catalog, rate cards, platform settings). */
export type ListKey =
  | "merchants"
  | "districts"
  | "zones"
  | "areas"
  | "addressTypes"
  | "parcelTypes"
  | "products"
  | "speeds"
  | "weights"
  | "yesNo"
  | "packaging"
  | "documentTypes"
  | "documentItems"
  | "relations";

export type ColumnKey =
  | "merchant"
  | "order_ref"
  | "recipient_name"
  | "recipient_phone"
  | "address"
  | "district"
  | "zone"
  | "area"
  | "address_type"
  | "parcel_type"
  | "product_type"
  | "item_description"
  | "document_type"
  | "document_item"
  | "receiver_relationship"
  | "service_level"
  | "weight_kg"
  | "cod"
  | "cod_amount"
  | "declared_value"
  | "open_box"
  | "packaging"
  | "branch_code"
  | "instructions";

export interface ColumnDef {
  key: ColumnKey;
  header: string;
  /** Other header spellings accepted on upload (normalised: lower case, spaces → _). */
  aliases: string[];
  description: string;
  example: string;
  /** Required unless super admin changes it. */
  required: boolean;
  /** Super admin may toggle "required" (the merchant column follows the file instead). */
  configurable: boolean;
  /** Super admin may set a value used when the cell is empty. */
  defaultable: boolean;
  /** Built-in value used when the cell is empty. */
  default?: string;
  /** Dropdown values; strict lists refuse other values, others only suggest. */
  list?: ListKey;
  strictList?: boolean;
  /** Stored as text in Excel (keeps leading zeros). */
  text?: boolean;
  number?: { min: number; max: number };
  maxLength?: number;
  width: number;
  /** Only in operations templates (merchant per row). */
  opsOnly?: boolean;
  /** Shown only when the merchant's service package offers it (service packages); still read when present. */
  needs?: PackageNeed;
}

/** What a package must offer for a column to be in its template (see packageOptions in packages/shared). */
export type PackageNeed = "cod" | "speeds" | "openBox" | "weight";
export interface PackageColumnOptions {
  cod: boolean;
  /** More than Regular. */
  speeds: boolean;
  openBox: boolean;
  /** Customer & E-commerce only (Banking & Financial has no weight). */
  weight: boolean;
}

const c = (def: Omit<ColumnDef, "configurable" | "defaultable" | "aliases"> & Partial<Pick<ColumnDef, "configurable" | "defaultable" | "aliases">>): ColumnDef => ({
  configurable: true,
  defaultable: false,
  aliases: [],
  ...def,
});

const merchant = c({
  key: "merchant",
  header: "Merchant",
  aliases: ["merchant_code", "merchant_name", "client"],
  description: "The merchant the order is for: its code (e.g. MR-1001) or name. Leave empty when you chose the merchant for the whole file.",
  example: "MR-1001 · Northstar Store",
  required: false,
  configurable: false,
  list: "merchants",
  strictList: true,
  width: 30,
  opsOnly: true,
});
const orderRef = (header: string, example: string) =>
  c({
    key: "order_ref",
    header,
    aliases: ["order_ref", "order_id", "order_no", "reference_no", "reference", "ref", "merchant_order_ref", "external_id", "invoice_no"],
    description: "Your own order number. Each one is booked once: uploading the same file again doesn't book it twice. Without it, an identical row is also recognised.",
    example,
    required: false,
    text: true,
    maxLength: 80,
    width: 18,
  });
const recipientName = (header: string, example: string) =>
  c({ key: "recipient_name", header, aliases: ["customer_name", "recipient_name", "recipient", "receiver_name", "name", "customer"], description: "Who receives the delivery.", example, required: false, maxLength: 120, width: 24 });
const recipientPhone = (header: string) =>
  c({
    key: "recipient_phone",
    header,
    aliases: ["phone", "recipient_phone", "customer_phone", "receiver_phone", "mobile", "mobile_number", "phone_number", "contact"],
    description: "Bangladeshi mobile number. +880 is added for you: type 17XXXXXXXX or 017XXXXXXXX (8801… and +8801… also work).",
    example: "01712345678",
    required: true,
    text: true,
    width: 16,
  });
const address = c({
  key: "address",
  header: "Delivery address",
  aliases: ["address", "street", "delivery_address", "full_address", "street_address"],
  description: "House, road, building and landmark. Leave empty if unknown: the order is created as \"needs info\" and held before delivery until you complete it.",
  example: "House 12, Road 4",
  required: false,
  maxLength: 200,
  width: 32,
});
const district = c({
  key: "district",
  header: "District",
  aliases: ["district", "city", "delivery_district"],
  description: "Destination district from the coverage list. Leave empty if unknown: the order is created as \"needs info\" and priced to your own city until you complete it.",
  example: "Dhaka Central",
  required: false,
  list: "districts",
  strictList: true,
  width: 18,
});
const zone = c({
  key: "zone",
  header: "Zone",
  aliases: ["zone", "thana", "delivery_zone", "area_zone"],
  description: "Destination zone of that district (the dropdown follows the district). A zone alone also works when only one district has it.",
  example: "Dhanmondi",
  required: false,
  list: "zones",
  strictList: true,
  width: 18,
});
const area = c({ key: "area", header: "Area", aliases: ["area", "landmark", "locality"], description: "Area or landmark inside the zone (optional, free text; the list has suggestions).", example: "Dhanmondi Road 7", required: false, list: "areas", maxLength: 120, width: 20 });
const addressType = (example: string, dflt: string) =>
  c({ key: "address_type", header: "Address type", aliases: ["address_category", "address_type", "location_type"], description: "Home, Office or Other.", example, required: false, defaultable: true, default: dflt, list: "addressTypes", strictList: true, width: 14 });
const serviceLevel = c({
  key: "service_level",
  header: "Service",
  aliases: ["service_level", "delivery_service", "service", "service_type", "delivery_speed", "speed", "handling", "speed_+_handling", "speed_handling", "document_type", "doc_type", "document_category"],
  description: "The service from your package (one choice). Empty = Regular. E-commerce Express is same day, inside the same district only.",
  example: "Regular",
  required: false,
  defaultable: true,
  default: "Regular",
  list: "speeds",
  strictList: true,
  width: 22,
  needs: "speeds",
});
const product = (example: string) =>
  c({
    key: "product_type",
    header: "Product",
    aliases: ["product", "product_type", "product_name", "category", "product_category"],
    description: "Product from your list (optional): its type (Regular, Document or Books) prices the parcel. Empty = Regular.",
    example,
    required: false,
    defaultable: true,
    list: "products",
    strictList: true,
    width: 20,
  });
const openBox = c({
  key: "open_box",
  header: "Open box",
  aliases: ["open_box", "check_before_pay", "open_box_/_check_before_pay"],
  description: "Yes lets the customer open the box and check before paying. Empty = No.",
  example: "No",
  required: false,
  list: "yesNo",
  strictList: true,
  width: 10,
  needs: "openBox",
});
const weight = (dflt: string, example: string) =>
  c({
    key: "weight_kg",
    header: "Weight (kg)",
    aliases: ["weight_kg", "weight", "weight_(kg)", "kg", "parcel_weight"],
    description: "Weight in kg (0.01 to 50). Choose a band from the list or type the exact weight.",
    example,
    required: false,
    defaultable: true,
    default: dflt,
    list: "weights",
    number: { min: 0.01, max: 50 },
    width: 12,
    needs: "weight",
  });
const packaging = (example: string) =>
  c({ key: "packaging", header: "Packaging", aliases: ["packaging", "package", "packaging_type"], description: "Packaging from the list.", example, required: false, defaultable: true, list: "packaging", strictList: true, width: 18 });
const declaredValue = (header: string, description: string, example: string) =>
  c({ key: "declared_value", header, aliases: ["declared_value", "order_value", "product_value", "value", "invoice_value"], description, example, required: false, number: { min: 0, max: 1_000_000 }, width: 14 });
const instructions = c({ key: "instructions", header: "Delivery instructions", aliases: ["instructions", "note", "notes", "remarks", "comment"], description: "Anything the rider should know.", example: "Call before delivery", required: false, maxLength: 500, width: 28 });

export const COLUMNS: Record<ImportKindKey, ColumnDef[]> = {
  ecommerce: [
    merchant,
    orderRef("Order ID", "ORDER-1001"),
    recipientName("Customer name", "Ayesha Rahman"),
    recipientPhone("Customer phone"),
    address,
    district,
    zone,
    area,
    addressType("Home", "Home"),
    c({
      key: "parcel_type",
      header: "Parcel type",
      aliases: ["parcel_type", "shipment_type", "type", "delivery_type"],
      description: "E-commerce parcel, Fragile parcel, Domestic parcel or Document (documents can't be cash on delivery).",
      example: "E-commerce parcel",
      required: false,
      defaultable: true,
      default: "E-commerce parcel",
      list: "parcelTypes",
      strictList: true,
      width: 18,
    }),
    product("Dress"),
    c({ key: "item_description", header: "Item description", aliases: ["item_description", "item", "items", "contents", "description", "product_name"], description: "What is inside (free text).", example: "Everyday tote bag", required: false, maxLength: 120, width: 24 }),
    serviceLevel,
    weight("0.5", "0.5"),
    c({
      key: "cod",
      header: "Cash on delivery",
      aliases: ["cod", "is_cod", "cash_on_delivery", "collect_cash"],
      description: "Yes to collect the COD amount from the customer; No for prepaid orders. Empty: Yes when a COD amount is given.",
      example: "Yes",
      required: false,
      defaultable: true,
      list: "yesNo",
      strictList: true,
      width: 14,
      needs: "cod",
    }),
    c({
      key: "cod_amount",
      header: "COD amount (৳)",
      aliases: ["cod_amount", "cod_(৳)", "cod_amount_(৳)", "collect_amount", "cash_amount", "amount_to_collect"],
      description: "Cash to collect, in taka (0 to 1,000,000). Not allowed for documents.",
      example: "2450",
      required: false,
      number: { min: 0, max: 1_000_000 },
      width: 14,
      needs: "cod",
    }),
    declaredValue("Product value (৳)", "The value of the goods, in taka (for claims).", "2450"),
    openBox,
    packaging("Poly mailer"),
    instructions,
  ],
  document: [
    merchant,
    orderRef("Reference no.", "LOAN-2026-00481"),
    recipientName("Recipient name", "Mahir Chowdhury"),
    recipientPhone("Recipient phone"),
    address,
    district,
    zone,
    area,
    addressType("Office", "Office"),
    product("Credit card"),
    c({ key: "document_item", header: "Document description", aliases: ["document_item", "document_description", "item", "description", "contents"], description: "What the envelope holds (free text; the list has suggestions).", example: "Contract", required: false, list: "documentItems", maxLength: 120, width: 22 }),
    c({
      key: "receiver_relationship",
      header: "Receiver relationship",
      aliases: ["receiver_relationship", "receiver_relation", "relationship", "relation", "receiver"],
      description: "Who may receive it for the recipient.",
      example: "Authorized representative",
      required: false,
      defaultable: true,
      list: "relations",
      strictList: true,
      width: 24,
    }),
    serviceLevel,
    packaging("Security pouch"),
    c({ key: "branch_code", header: "Origin branch code", aliases: ["branch_code", "branch", "origin_branch", "origin_branch_code"], description: "Your branch the document comes from.", example: "MBP-DHK-01", required: false, text: true, maxLength: 40, width: 16 }),
    declaredValue("Declared value (৳)", "Declared value of the documents, in taka (for claims).", "0"),
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

/** Columns of a template for merchants or operations (operations have the merchant column). */
export const columnsFor = (kind: ImportKindKey, forOps: boolean, pkg?: PackageColumnOptions | null) =>
  COLUMNS[kind].filter(col => (forOps || !col.opsOnly) && (!pkg || !col.needs || pkg[col.needs]));

/** Maps each header cell to a column (or null when unknown / ignored); duplicates map once. */
export function matchHeaders(kind: ImportKindKey, headers: string[]): { map: (ColumnKey | "__cod" | null)[]; unknown: string[]; forbidden: string[] } {
  const cols = COLUMNS[kind];
  const used = new Set<ColumnKey>();
  const unknown: string[] = [];
  const forbidden: string[] = [];
  const map = headers.map((raw): ColumnKey | "__cod" | null => {
    const h = normalizeHeader(raw);
    if (!h || IGNORED_HEADERS.has(h)) return null;
    const col = cols.find(x => normalizeHeader(x.header) === h || x.key === h) ?? cols.find(x => x.aliases.includes(h));
    if (!col) {
      // A COD column on the document template: values are checked (documents can't be COD).
      if (kind === "document" && ["cod", "cod_amount", "cod_(৳)", "cod_amount_(৳)", "cash_on_delivery", "collect_amount"].includes(h)) {
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
