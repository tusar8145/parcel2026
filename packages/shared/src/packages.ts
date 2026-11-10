import { z } from "zod";

/**
 * Service packages ("service plans"), spec v2: which services a merchant / customer may use and
 * the prices they pay. The service catalog, product types, route tiers and the price engine are
 * fixed in code (this file); packages, their versions, assignments and products live in the
 * database (apps/api modules/packages). See docs/architecture-contracts.md, "Service packages & pricing".
 */

/**
 * Merchant categories (the Prisma `Segment` values). BANKING_FINANCIAL is the Banking & Financial
 * category (the value is kept; the label changed). Website customers and walk-ins are CUSTOMER.
 */
export const PACKAGE_SEGMENTS = ["CUSTOMER", "ECOMMERCE", "BANKING_FINANCIAL"] as const;
export type PackageSegment = (typeof PACKAGE_SEGMENTS)[number];
export const SEGMENT_LABEL: Record<PackageSegment, string> = { CUSTOMER: "Customer", ECOMMERCE: "E-commerce", BANKING_FINANCIAL: "Banking & Financial" };
/** Banking & Financial: no weight, no COD, no product-type charge. */
export const isBanking = (segment: PackageSegment) => segment === "BANKING_FINANCIAL";
/** A merchant's category from its MerchantType (any value other than ECOMMERCE is Banking & Financial, before and after the rename). */
export const segmentOfMerchantType = (type: string | null | undefined): PackageSegment => (type === "ECOMMERCE" ? "ECOMMERCE" : "BANKING_FINANCIAL");

// ───────────── products ─────────────

/** The three fixed product types. No product means Regular. */
export const PRODUCT_TYPES = ["REGULAR", "DOCUMENT", "BOOKS"] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];
export const PRODUCT_TYPE_LABEL: Record<ProductType, string> = { REGULAR: "Regular", DOCUMENT: "Document", BOOKS: "Books" };
/** Product lists: Customer + E-commerce share the ECOMMERCE list; Banking & Financial has its own. */
export const productListOf = (segment: PackageSegment): "ECOMMERCE" | "BANKING_FINANCIAL" => (isBanking(segment) ? "BANKING_FINANCIAL" : "ECOMMERCE");

/** A seeded product category: its message channels and its products (name, pricing type). */
export interface SeedCategory {
  name: string;
  sms: boolean;
  email: boolean;
  push: boolean;
  products: readonly (readonly [string, ProductType])[];
}
/**
 * The seeded catalog (owner's lists, 2026-11-11): Customer & E-commerce share the ECOMMERCE list; Banking & Financial
 * has its own. Categories carry the message channels; the migration 20261111090000_catalog_priority_delivery_types
 * seeds the same lists.
 */
export const SEED_CATALOG: Record<"ECOMMERCE" | "BANKING_FINANCIAL", readonly SeedCategory[]> = {
  BANKING_FINANCIAL: [
    { name: "Cards & PIN", sms: true, email: true, push: true, products: [["Debit Card", "REGULAR"], ["Credit Card", "REGULAR"], ["Prepaid Card", "REGULAR"], ["ATM Card", "REGULAR"], ["PIN Mailer", "DOCUMENT"]] },
    { name: "Cheque Book & Passbook", sms: true, email: true, push: true, products: [["Cheque Book", "BOOKS"], ["Passbook", "BOOKS"], ["Deposit Slip Book", "BOOKS"]] },
    { name: "Financial Instruments", sms: true, email: true, push: true, products: [["Pay Order", "DOCUMENT"], ["Demand Draft", "DOCUMENT"], ["Fixed Deposit Receipt (FDR)", "DOCUMENT"], ["DPS Certificate", "DOCUMENT"], ["Savings Certificate (Sanchayapatra)", "DOCUMENT"], ["Bond / Investment Certificate", "DOCUMENT"], ["Bank Guarantee", "DOCUMENT"]] },
    { name: "Statements & Certificates", sms: false, email: true, push: false, products: [["Bank Statement", "DOCUMENT"], ["Credit Card Statement", "DOCUMENT"], ["Solvency Certificate", "DOCUMENT"], ["Balance Confirmation Certificate", "DOCUMENT"], ["Tax / TDS Certificate", "DOCUMENT"], ["Interest Certificate", "DOCUMENT"]] },
    { name: "Account & Loan Documents", sms: false, email: false, push: false, products: [["Account Opening Kit", "REGULAR"], ["Welcome Kit", "REGULAR"], ["KYC Documents", "DOCUMENT"], ["Loan Documents", "DOCUMENT"], ["Loan Sanction Letter", "DOCUMENT"], ["Mortgage / Property Documents", "DOCUMENT"], ["Financial Agreement", "DOCUMENT"], ["Insurance Policy Documents", "DOCUMENT"], ["Insurance Claim Documents", "DOCUMENT"], ["Legal Notice / Demand Letter", "DOCUMENT"], ["Confidential Documents", "DOCUMENT"]] },
    { name: "Corporate & Trade Documents", sms: false, email: true, push: false, products: [["Corporate Banking Documents", "DOCUMENT"], ["LC Documents", "DOCUMENT"], ["Trade Finance Documents", "DOCUMENT"], ["Export / Import Documents", "DOCUMENT"], ["Payroll Documents", "DOCUMENT"], ["Tender Documents", "DOCUMENT"]] },
    { name: "Banking Devices", sms: true, email: true, push: true, products: [["POS Terminal", "REGULAR"], ["Security Token", "REGULAR"], ["Card Reader", "REGULAR"], ["QR Merchant Kit", "REGULAR"]] },
  ],
  ECOMMERCE: [
    { name: "Fashion & Clothing", sms: true, email: true, push: true, products: [["Saree", "REGULAR"], ["Three-Piece / Salwar Kameez", "REGULAR"], ["Kurti & Tops", "REGULAR"], ["Panjabi", "REGULAR"], ["Shirt", "REGULAR"], ["T-Shirt & Polo", "REGULAR"], ["Pants & Jeans", "REGULAR"], ["Hijab & Borka", "REGULAR"], ["Kids Clothing", "REGULAR"], ["Lungi & Gamcha", "REGULAR"], ["Winter Wear", "REGULAR"], ["Innerwear & Nightwear", "REGULAR"]] },
    { name: "Shoes, Bags & Accessories", sms: true, email: true, push: true, products: [["Men's Shoes", "REGULAR"], ["Women's Shoes", "REGULAR"], ["Sandals & Slippers", "REGULAR"], ["Handbag & Purse", "REGULAR"], ["Backpack", "REGULAR"], ["Wallet", "REGULAR"], ["Watch", "REGULAR"], ["Sunglasses", "REGULAR"], ["Belt", "REGULAR"], ["Jewelry & Ornaments", "REGULAR"]] },
    { name: "Beauty & Personal Care", sms: true, email: true, push: true, products: [["Skin Care", "REGULAR"], ["Makeup", "REGULAR"], ["Hair Care", "REGULAR"], ["Perfume & Attar", "REGULAR"], ["Men's Grooming", "REGULAR"], ["Personal Care Appliances", "REGULAR"]] },
    { name: "Electronics & Gadgets", sms: true, email: true, push: true, products: [["Mobile Phone", "REGULAR"], ["Mobile Accessories", "REGULAR"], ["Earbuds & Headphones", "REGULAR"], ["Smart Watch", "REGULAR"], ["Power Bank", "REGULAR"], ["Bluetooth Speaker", "REGULAR"], ["Computer Accessories", "REGULAR"], ["Laptop & Tablet", "REGULAR"], ["Camera & Accessories", "REGULAR"], ["Gaming Accessories", "REGULAR"], ["Networking Device", "REGULAR"]] },
    { name: "Home, Kitchen & Appliances", sms: true, email: true, push: true, products: [["Kitchenware", "REGULAR"], ["Dinner Set & Crockery", "REGULAR"], ["Small Kitchen Appliances", "REGULAR"], ["Home Appliances", "REGULAR"], ["Home Decor", "REGULAR"], ["Bedding & Curtains", "REGULAR"], ["Lighting", "REGULAR"], ["Cleaning Supplies", "REGULAR"], ["Furniture", "REGULAR"], ["Tools & Hardware", "REGULAR"]] },
    { name: "Food & Grocery", sms: true, email: true, push: true, products: [["Grocery", "REGULAR"], ["Rice, Dal & Spices", "REGULAR"], ["Oil & Ghee", "REGULAR"], ["Honey", "REGULAR"], ["Dates & Dry Fruits", "REGULAR"], ["Tea & Coffee", "REGULAR"], ["Snacks & Sweets", "REGULAR"], ["Organic Food", "REGULAR"], ["Seasonal Fruits", "REGULAR"], ["Fish & Meat (Frozen)", "REGULAR"], ["Homemade Food", "REGULAR"]] },
    { name: "Health, Baby & Kids", sms: true, email: true, push: true, products: [["Medicine & Health Care", "REGULAR"], ["Medical Devices", "REGULAR"], ["Baby Care", "REGULAR"], ["Diaper & Baby Food", "REGULAR"], ["Toys & Games", "REGULAR"], ["School Supplies", "REGULAR"]] },
    { name: "Books, Stationery & Documents", sms: true, email: true, push: true, products: [["Books", "BOOKS"], ["Islamic Books", "BOOKS"], ["Academic & Exam Books", "BOOKS"], ["Magazines", "BOOKS"], ["Notebooks & Stationery", "BOOKS"], ["Office Supplies", "REGULAR"], ["Papers & Documents", "DOCUMENT"], ["Invoices", "DOCUMENT"], ["Contracts & Agreements", "DOCUMENT"], ["Certificates", "DOCUMENT"], ["Warranty Documents", "DOCUMENT"]] },
    { name: "Lifestyle & Others", sms: true, email: true, push: true, products: [["Gifts & Crafts", "REGULAR"], ["Sports & Fitness", "REGULAR"], ["Automotive & Bike Accessories", "REGULAR"], ["Pet Supplies", "REGULAR"], ["Musical Instruments", "REGULAR"], ["Plants & Gardening", "REGULAR"], ["Agro Products", "REGULAR"], ["Industrial & Business Supplies", "REGULAR"]] },
  ],
};

// ───────────── routes (district only, never zone) ─────────────

/** The hard-coded Dhaka sub-urban districts. */
export const DHAKA_SUBURBAN_DISTRICTS: readonly string[] = ["Gazipur", "Narayanganj", "Dhaka (Sub-urban)"];
const DHAKA_CITY = new Set(["dhaka", "dhaka north", "dhaka central", "dhaka south"]);

/** "Dhaka North" / "Dhaka Central" / "Dhaka South" (city thanas) → "Dhaka"; other districts as given (trimmed). */
export function normalizeDistrict(district: string | null | undefined): string {
  const d = (district ?? "").trim().replace(/\s+/g, " ");
  return DHAKA_CITY.has(d.toLowerCase()) ? "Dhaka" : d;
}
const isSuburban = (d: string) => DHAKA_SUBURBAN_DISTRICTS.some(s => s.toLowerCase() === d.toLowerCase());

export const ROUTE_TIERS = ["DHAKA_SUBURBAN", "SAME_DISTRICT", "DIFFERENT_DISTRICT"] as const;
export type RouteTier = (typeof ROUTE_TIERS)[number];
export const ROUTE_TIER_LABEL: Record<RouteTier, string> = { DHAKA_SUBURBAN: "Dhaka ↔ Sub-urban", SAME_DISTRICT: "Inside same district", DIFFERENT_DISTRICT: "Different district" };

/** The route tier between two districts: Dhaka ↔ a sub-urban district (either way), else the same district, else different. */
export function routeTier(pickupDistrict: string | null | undefined, deliveryDistrict: string | null | undefined): RouteTier {
  const a = normalizeDistrict(pickupDistrict);
  const b = normalizeDistrict(deliveryDistrict);
  if ((a === "Dhaka" && isSuburban(b)) || (b === "Dhaka" && isSuburban(a))) return "DHAKA_SUBURBAN";
  if (a && a.toLowerCase() === b.toLowerCase()) return "SAME_DISTRICT";
  return "DIFFERENT_DISTRICT";
}

// ───────────── the service catalog ─────────────

export const SERVICE_GROUPS = ["firstMile", "lastMile", "payment", "options", "parcelNotifications", "supportNotifications", "proof", "tracking", "integrations"] as const;
export type ServiceGroup = (typeof SERVICE_GROUPS)[number];
export const SERVICE_GROUP_LABEL: Record<ServiceGroup, string> = {
  firstMile: "First mile",
  lastMile: "Last mile",
  payment: "Cash on delivery",
  options: "Open box",
  parcelNotifications: "Parcel notifications (SMS & email)",
  supportNotifications: "Support notifications",
  proof: "Delivery proof",
  tracking: "Tracking & support",
  integrations: "Integrations",
};

/** Where a service is chosen: at booking (per parcel), or a package-level entitlement. */
export type ServiceKind = "booking" | "entitlement";

export interface ServiceDef {
  code: string;
  label: string;
  group: ServiceGroup;
  segments: readonly PackageSegment[];
  kind: ServiceKind;
  /** Always on (can't be unticked), e.g. website tracking. */
  core?: boolean;
  /** Short help shown in the package editor. */
  hint?: string;
}

const ALL: readonly PackageSegment[] = PACKAGE_SEGMENTS;
const PARCELS: readonly PackageSegment[] = ["CUSTOMER", "ECOMMERCE"];
const MERCHANTS: readonly PackageSegment[] = ["ECOMMERCE", "BANKING_FINANCIAL"];

/** Parcel notifications: each event once, with its audience. Guest booking verification is for website customers only. */
export const PARCEL_NOTIFICATIONS = [
  { code: "notify.booked", label: "Pickup request received", audience: "sender", events: ["parcel.booked"] },
  { code: "notify.pickup_assigned", label: "Pickup rider assigned", audience: "sender", events: ["parcel.pickup_assigned"] },
  { code: "notify.picked_up", label: "Parcel picked up", audience: "sender", events: ["parcel.picked_up"] },
  { code: "notify.received_at_hub", label: "Received at first hub", audience: "recipient", events: ["parcel.received_at_hub"] },
  { code: "notify.out_for_delivery", label: "Out for delivery", audience: "recipient", events: ["parcel.out_for_delivery"] },
  { code: "notify.delivery_code", label: "Delivery code", audience: "recipient", events: ["parcel.delivery_code"] },
  { code: "notify.delivered", label: "Delivered", audience: "sender", events: ["parcel.delivered"] },
  { code: "notify.delivery_failed", label: "Delivery attempt failed", audience: "sender", events: ["parcel.delivery_failed"] },
  { code: "notify.cancelled", label: "Pickup cancelled", audience: "sender", events: ["parcel.cancelled"] },
  { code: "notify.return_scheduled", label: "Return scheduled", audience: "sender", events: ["parcel.return_scheduled"] },
  { code: "notify.returned", label: "Returned to sender", audience: "sender", events: ["parcel.returned"] },
  { code: "notify.feedback_request", label: "Feedback request", audience: "sender", events: ["parcel.feedback_request"] },
  { code: "notify.guest_verification", label: "Guest booking verification", audience: "sender", events: ["guest.booking_verification"], segments: ["CUSTOMER"] },
  { code: "notify.drop_off_booked", label: "Drop-off booking received", audience: "sender", events: ["parcel.drop_off_booked"] },
  { code: "notify.changed_to_drop_off", label: "Changed to hub drop-off", audience: "sender", events: ["parcel.changed_to_drop_off"] },
  { code: "notify.changed_to_pickup", label: "Changed to rider pickup", audience: "sender", events: ["parcel.changed_to_pickup"] },
  { code: "notify.collection", label: "Ready for collection / collection reminder", audience: "recipient", events: ["parcel.ready_for_collection", "parcel.collection_reminder"] },
] as const satisfies readonly { code: string; label: string; audience: "sender" | "recipient"; events: readonly string[]; segments?: readonly PackageSegment[] }[];
export type ParcelNotificationCode = (typeof PARCEL_NOTIFICATIONS)[number]["code"];

/** Not chosen per booking: guest verification is sent before a parcel exists (and never in the merchant modal). */
export const PACKAGE_LEVEL_PARCEL_NOTIFICATIONS: readonly string[] = ["notify.guest_verification"];

export const SUPPORT_NOTIFICATIONS = [
  { code: "notify.support_reply", label: "Support reply", events: ["support.ticket_reply"] },
  { code: "notify.support_status", label: "Ticket status changed", events: ["support.ticket_status"] },
  { code: "notify.support_csat", label: "Support satisfaction survey", events: ["support.csat_request"] },
  { code: "notify.support_escalation", label: "Support SLA escalation", events: ["support.sla_escalation"] },
] as const;

/** Notification event → the package service that gates it (events not listed are outside packages, e.g. sign-in codes). */
export const NOTIFICATION_SERVICE_OF_EVENT: Readonly<Record<string, string>> = Object.fromEntries([
  ...PARCEL_NOTIFICATIONS.flatMap(n => n.events.map(e => [e, n.code] as const)),
  ...SUPPORT_NOTIFICATIONS.flatMap(n => n.events.map(e => [e, n.code] as const)),
]);

/** The fixed service catalog. Append; keep codes stable (they are stored on packages and parcels). */
export const SERVICES: readonly ServiceDef[] = [
  { code: "first.rider_pickup", label: "Rider pickup", group: "firstMile", segments: ALL, kind: "booking" },
  { code: "first.hub_drop", label: "Merchant drop at hub", group: "firstMile", segments: ALL, kind: "booking" },
  { code: "first.on_demand_pickup", label: "On-demand pickup", group: "firstMile", segments: ALL, kind: "booking", hint: "Top dispatch priority; no automatic instant dispatch yet." },
  { code: "last.doorstep", label: "Home delivery", group: "lastMile", segments: ALL, kind: "booking" },
  { code: "last.hub_collect", label: "Hub Pickup", group: "lastMile", segments: ALL, kind: "booking", hint: "The recipient collects it at the hub serving their zone." },
  { code: "payment.cod", label: "Cash on delivery (COD)", group: "payment", segments: PARCELS, kind: "booking" },
  { code: "option.open_box", label: "Open box / Check before pay", group: "options", segments: ["ECOMMERCE"], kind: "booking" },
  ...PARCEL_NOTIFICATIONS.map(
    (n): ServiceDef => ({
      code: n.code,
      label: `${n.label} (${n.audience})`,
      group: "parcelNotifications",
      segments: "segments" in n ? n.segments : ALL,
      kind: PACKAGE_LEVEL_PARCEL_NOTIFICATIONS.includes(n.code) ? "entitlement" : "booking",
      ...(n.code === "notify.guest_verification" ? { hint: "Off: guests can't verify their phone, so they can't book without an account." } : {}),
    }),
  ),
  ...SUPPORT_NOTIFICATIONS.map((n): ServiceDef => ({ code: n.code, label: n.label, group: "supportNotifications", segments: ALL, kind: "entitlement" })),
  { code: "proof.photo", label: "Scan POD (signed invoice photo)", group: "proof", segments: ALL, kind: "entitlement" },
  { code: "proof.otp", label: "OTP verification", group: "proof", segments: ALL, kind: "entitlement", hint: "Needs the Delivery code message." },
  { code: "proof.signature", label: "Recipient signature", group: "proof", segments: ALL, kind: "entitlement" },
  { code: "tracking.website", label: "Website tracking", group: "tracking", segments: ALL, kind: "entitlement", core: true },
  { code: "tracking.live_location", label: "Live rider location", group: "tracking", segments: ALL, kind: "entitlement" },
  { code: "support.tickets", label: "Support tickets", group: "tracking", segments: ALL, kind: "entitlement" },
  { code: "tracking.rider_phone", label: "Share rider phone number", group: "tracking", segments: ALL, kind: "entitlement", hint: "Only on the delivery day while out for delivery." },
  { code: "integration.api", label: "API integration", group: "integrations", segments: MERCHANTS, kind: "entitlement" },
  { code: "integration.webhooks", label: "Webhook", group: "integrations", segments: MERCHANTS, kind: "entitlement" },
  {
    code: "integration.push",
    label: "Firebase push notifications (mobile app)",
    group: "integrations",
    segments: MERCHANTS,
    kind: "entitlement",
    hint: "The merchant's Delivery Fast app shows their notifications as push messages on the phone.",
  },
];
export const SERVICE_BY_CODE: ReadonlyMap<string, ServiceDef> = new Map(SERVICES.map(s => [s.code, s]));
export const serviceLabel = (code: string) => SERVICE_BY_CODE.get(code)?.label ?? code;
export const servicesFor = (segment: PackageSegment) => SERVICES.filter(s => s.segments.includes(segment));
export const CORE_SERVICES = SERVICES.filter(s => s.core).map(s => s.code);

// ───────────── booking choices ─────────────

export const FIRST_MILES = ["RIDER_PICKUP", "HUB_DROP", "ON_DEMAND_PICKUP"] as const;
export type FirstMile = (typeof FIRST_MILES)[number];
export const LAST_MILES = ["DOORSTEP", "HUB_COLLECT"] as const;
export type LastMile = (typeof LAST_MILES)[number];
/**
 * Delivery types (Regular, Express, 4 Hour, Same Day…) are kept in the database (super admin › Delivery types): a
 * parcel stores the type's code (`speedOption`). Their + charge is per package version (prices.deliveryFees[code]).
 */
export type SpeedOption = string;
export interface DeliveryTypeDef {
  code: string;
  name: string;
  /** The categories it is offered to. */
  segments: readonly PackageSegment[];
  /** The SLA policies that time it. */
  slaLevel: "REGULAR" | "SAME_DAY" | "EXPRESS";
  active?: boolean;
}
/** The delivery type of a booking that doesn't choose one. */
export const DEFAULT_DELIVERY_TYPE = "REGULAR";
/** The seeded delivery types (a fresh database gets them; the migration seeds existing ones). */
export const SEED_DELIVERY_TYPES: readonly DeliveryTypeDef[] = [
  { code: "REGULAR", name: "Regular", segments: ["CUSTOMER", "ECOMMERCE", "BANKING_FINANCIAL"], slaLevel: "REGULAR" },
  { code: "EXPRESS", name: "Express", segments: ["CUSTOMER", "ECOMMERCE", "BANKING_FINANCIAL"], slaLevel: "EXPRESS" },
  { code: "FOUR_HOUR", name: "4 Hour Delivery", segments: ["CUSTOMER", "ECOMMERCE", "BANKING_FINANCIAL"], slaLevel: "EXPRESS" },
  { code: "SAME_DAY", name: "Same Day Delivery", segments: ["CUSTOMER", "ECOMMERCE", "BANKING_FINANCIAL"], slaLevel: "SAME_DAY" },
];
/** The seeded priorities per list (the first is the default). */
export const SEED_PRIORITIES: Record<"ECOMMERCE" | "BANKING_FINANCIAL", readonly string[]> = { BANKING_FINANCIAL: ["General", "Security"], ECOMMERCE: ["Online Product", "Fragile"] };
/** A type's code from its name ("4 Hour Delivery" → "FOUR_HOUR_DELIVERY"; digits are spelled for the first word). */
export const deliveryTypeCode = (name: string) =>
  name
    .trim()
    .toUpperCase()
    .replace(/^4\b/, "FOUR")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
/** The active delivery types of a category, in their order. */
export const deliveryTypesFor = (segment: PackageSegment, types: readonly DeliveryTypeDef[]) => types.filter(t => t.active !== false && t.segments.includes(segment));
const normType = (raw: string) => raw.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
/** The delivery type named in a cell or a request: its code or its name ("Same day", "SAME_DAY", "4 hour"). */
export function findDeliveryType(raw: string | null | undefined, types: readonly DeliveryTypeDef[]): DeliveryTypeDef | undefined {
  const v = normType(raw ?? "");
  if (!v) return undefined;
  const bare = (t: string) => normType(t).replace(/ delivery$/, "");
  return types.find(t => normType(t.code) === v || normType(t.name) === v || bare(t.name) === v.replace(/ delivery$/, "") || bare(t.code) === v.replace(/ delivery$/, ""));
}

export const FIRST_MILE_SERVICE: Record<FirstMile, string> = { RIDER_PICKUP: "first.rider_pickup", HUB_DROP: "first.hub_drop", ON_DEMAND_PICKUP: "first.on_demand_pickup" };
export const LAST_MILE_SERVICE: Record<LastMile, string> = { DOORSTEP: "last.doorstep", HUB_COLLECT: "last.hub_collect" };
export const FIRST_MILE_LABEL: Record<FirstMile, string> = { RIDER_PICKUP: "Rider pickup", HUB_DROP: "Drop at hub", ON_DEMAND_PICKUP: "On-demand pickup" };
export const LAST_MILE_LABEL: Record<LastMile, string> = { DOORSTEP: "Home delivery", HUB_COLLECT: "Hub Pickup" };
export function parseFirstMile(raw: string | null | undefined): FirstMile | undefined {
  const v = (raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if ((FIRST_MILES as readonly string[]).includes(v)) return v as FirstMile;
  if (v === "PICKUP") return "RIDER_PICKUP";
  if (v === "DROP_OFF" || v === "DROP_AT_HUB") return "HUB_DROP";
  return undefined;
}
export function parseLastMile(raw: string | null | undefined): LastMile | undefined {
  const v = (raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if ((LAST_MILES as readonly string[]).includes(v)) return v as LastMile;
  if (v === "HOME_DELIVERY" || v === "HOME" || v === "DOORSTEP_DELIVERY") return "DOORSTEP";
  if (v === "HUB_PICKUP" || v === "COLLECT_FROM_HUB" || v === "COLLECT") return "HUB_COLLECT";
  return undefined;
}

// ───────────── price fields ─────────────

const money = z.coerce.number().min(0, "can't be negative").max(1_000_000, "is too large");
/** Last-mile charges may be negative (a discount). */
const signedMoney = z.coerce.number().min(-1_000_000).max(1_000_000, "is too large");
const percent = z.coerce.number().min(0, "can't be negative").max(100, "can't be more than 100%");
/** Weight included in the route price (Customer & E-commerce). */
export const INCLUDED_WEIGHT_KG = 0.5;

/** A package version's prices (৳, VAT-inclusive). Fields a category doesn't use are ignored. Defaults: the owner's initial values. */
export const packagePricesSchema = z.object({
  dhakaSuburban: money.default(100),
  sameDistrict: money.default(70),
  differentDistrict: money.default(130),
  typeRegular: money.default(0),
  typeDocument: money.default(0),
  typeBooks: money.default(0),
  extraKg: money.default(15),
  /** Delivery type + charge by code (REGULAR, EXPRESS, FOUR_HOUR, SAME_DAY…); a type without one adds ৳0. */
  deliveryFees: z.record(z.string().regex(/^[A-Z0-9_]{1,40}$/), money).default({ REGULAR: 0, EXPRESS: 40 }),
  homeDeliveryFee: signedMoney.default(0),
  hubPickupFee: signedMoney.default(0),
  hubDropDiscount: money.default(0),
  onDemandPickupFee: money.default(0),
  codPercent: percent.default(1),
  codMin: money.default(10),
  openBoxFee: money.default(0),
  returnPercent: percent.default(50),
  freeReattempts: z.coerce.number().int().min(0).max(20).default(2),
  reattemptFee: money.default(0),
});
export type PackagePrices = z.infer<typeof packagePricesSchema>;
export const DEFAULT_PACKAGE_PRICES: PackagePrices = packagePricesSchema.parse({});

export type PriceUnit = "৳" | "%" | "count";
/** Price fields per category, in the editor's groups and order. `sign` marks subtracted / added adjustments. */
export const PRICE_FIELDS: readonly { key: Exclude<keyof PackagePrices, "deliveryFees">; group: string; label: string; unit: PriceUnit; segments: readonly PackageSegment[]; sign?: "-" | "+"; signed?: boolean }[] = [
  { key: "dhakaSuburban", group: "Route", label: "Dhaka ↔ Sub-urban", unit: "৳", segments: ALL },
  { key: "sameDistrict", group: "Route", label: "Inside same district", unit: "৳", segments: ALL },
  { key: "differentDistrict", group: "Route", label: "Different district", unit: "৳", segments: ALL },
  { key: "typeRegular", group: "What are you sending (+ charge)", label: "Regular", unit: "৳", segments: PARCELS },
  { key: "typeDocument", group: "What are you sending (+ charge)", label: "Document", unit: "৳", segments: PARCELS },
  { key: "typeBooks", group: "What are you sending (+ charge)", label: "Books", unit: "৳", segments: PARCELS },
  { key: "extraKg", group: "Weight (0.5 kg included in the route price)", label: "Each additional started kg", unit: "৳", segments: PARCELS },
  { key: "homeDeliveryFee", group: "Last mile (+ charge)", label: "Home delivery", unit: "৳", segments: ALL, signed: true },
  { key: "hubPickupFee", group: "Last mile (+ charge)", label: "Hub Pickup (may be negative)", unit: "৳", segments: ALL, signed: true },
  { key: "hubDropDiscount", group: "First mile", label: "Drop at hub", unit: "৳", segments: ALL, sign: "-" },
  { key: "onDemandPickupFee", group: "First mile", label: "On-demand pickup", unit: "৳", segments: ALL, sign: "+" },
  { key: "codPercent", group: "Cash to collect", label: "COD fee", unit: "%", segments: PARCELS },
  { key: "codMin", group: "Cash to collect", label: "Minimum COD fee", unit: "৳", segments: PARCELS },
  { key: "openBoxFee", group: "Open box", label: "Open box fee", unit: "৳", segments: ["ECOMMERCE"] },
  { key: "returnPercent", group: "Failed delivery", label: "Return charge (% of delivery fee, added on return)", unit: "%", segments: ALL },
  { key: "freeReattempts", group: "Failed delivery", label: "Free re-attempts", unit: "count", segments: ALL },
  { key: "reattemptFee", group: "Failed delivery", label: "Re-attempt fee", unit: "৳", segments: ALL },
];

/** Problems with a package's services for its category (unknown codes, missing first / last mile or proof). */
export function packageProblems(segment: PackageSegment, services: readonly string[]): string[] {
  const problems: string[] = [];
  const has = new Set(services);
  for (const code of services) {
    const def = SERVICE_BY_CODE.get(code);
    if (!def) problems.push(`Unknown service "${code}"`);
    else if (!def.segments.includes(segment)) problems.push(`${def.label} isn't offered to ${SEGMENT_LABEL[segment]} packages`);
  }
  if (!FIRST_MILES.some(f => has.has(FIRST_MILE_SERVICE[f]))) problems.push("Choose at least one first-mile option");
  if (!LAST_MILES.some(l => has.has(LAST_MILE_SERVICE[l]))) problems.push("Choose at least one last-mile option");
  if (!["proof.photo", "proof.otp", "proof.signature"].some(p => has.has(p))) problems.push("Choose at least one delivery proof method");
  return problems;
}

/** The package's services with the core ones always on, limited to the category, in catalog order. */
export function normalizeServices(segment: PackageSegment, services: readonly string[]): string[] {
  const allowed = new Set(servicesFor(segment).map(s => s.code));
  return [...new Set([...services, ...CORE_SERVICES])].filter(c => allowed.has(c)).sort((a, b) => SERVICES.findIndex(s => s.code === a) - SERVICES.findIndex(s => s.code === b));
}

/** The services of a new default package: everything of the category except on-demand pickup, live location and the rider's phone. */
export function defaultServicesFor(segment: PackageSegment): string[] {
  const off = new Set(["first.on_demand_pickup", "tracking.live_location", "tracking.rider_phone"]);
  return normalizeServices(segment, servicesFor(segment).map(s => s.code).filter(c => !off.has(c)));
}

// ───────────── selection: defaults and enforcement ─────────────

export interface BookingSelection {
  firstMile: FirstMile;
  lastMile: LastMile;
  speed: SpeedOption;
  productType: ProductType;
  openBox: boolean;
  codAmount: number;
  weightKg: number;
  /** Parcel notification codes chosen for this booking (package-level ones excluded). */
  notifications: string[];
}

export interface SelectionInput {
  firstMile?: FirstMile | null;
  lastMile?: LastMile | null;
  speed?: SpeedOption | null;
  productType?: ProductType | null;
  openBox?: boolean | null;
  codAmount?: number | null;
  weightKg?: number | null;
  /** Omitted: every parcel notification in the package. */
  notifications?: readonly string[] | null;
}

export interface SelectionProblem {
  /** The input field (firstMile, lastMile, speed, openBox, codAmount, notifications). */
  field: string;
  code: "SERVICE_NOT_IN_PACKAGE" | "INVALID";
  message: string;
}

const asSet = (services: ReadonlySet<string> | readonly string[]) => (services instanceof Set ? services : new Set(services as readonly string[]));
export const defaultFirstMile = (services: ReadonlySet<string> | readonly string[]): FirstMile | undefined => {
  const has = asSet(services);
  return has.has("first.rider_pickup") ? "RIDER_PICKUP" : has.has("first.hub_drop") ? "HUB_DROP" : has.has("first.on_demand_pickup") ? "ON_DEMAND_PICKUP" : undefined;
};
export const defaultLastMile = (services: ReadonlySet<string> | readonly string[]): LastMile | undefined => {
  const has = asSet(services);
  return has.has("last.doorstep") ? "DOORSTEP" : has.has("last.hub_collect") ? "HUB_COLLECT" : undefined;
};

/** The parcel notifications a booking may choose from in this package (pre-selected by default). */
export const bookableNotifications = (services: readonly string[]) => {
  const has = new Set(services);
  return PARCEL_NOTIFICATIONS.filter(n => has.has(n.code) && !PACKAGE_LEVEL_PARCEL_NOTIFICATIONS.includes(n.code)).map(n => n.code as string);
};

/** Choices offered for a package (forms, import modal, template columns and dropdowns). */
export function packageOptions(segment: PackageSegment, services: readonly string[], deliveryTypes: readonly DeliveryTypeDef[]) {
  const has = new Set(services);
  const types = deliveryTypesFor(segment, deliveryTypes);
  return {
    firstMiles: FIRST_MILES.filter(f => has.has(FIRST_MILE_SERVICE[f])),
    lastMiles: LAST_MILES.filter(l => has.has(LAST_MILE_SERVICE[l])),
    /** Delivery type codes, in order (the first is the default). */
    speeds: types.map(t => t.code),
    deliveryTypes: types.map(t => ({ code: t.code, name: t.name })),
    cod: !isBanking(segment) && has.has("payment.cod"),
    openBox: segment === "ECOMMERCE" && has.has("option.open_box"),
    weight: !isBanking(segment),
    notifications: bookableNotifications(services),
    defaultFirstMile: defaultFirstMile(has),
    defaultLastMile: defaultLastMile(has),
  };
}

/**
 * Applies the package defaults to a booking and checks it against the package. Sending a service
 * the package doesn't include is an error (SERVICE_NOT_IN_PACKAGE: <service>); a delivery type must be an active one
 * of the category (no route rule: any type on any route).
 */
export function resolveSelection(segment: PackageSegment, services: readonly string[], input: SelectionInput, deliveryTypes: readonly DeliveryTypeDef[]): { selection: BookingSelection; problems: SelectionProblem[] } {
  const has = new Set(services);
  const problems: SelectionProblem[] = [];
  const notIn = (field: string, code: string) => problems.push({ field, code: "SERVICE_NOT_IN_PACKAGE", message: `SERVICE_NOT_IN_PACKAGE: ${serviceLabel(code)}` });
  const firstMile = input.firstMile ?? defaultFirstMile(has) ?? "RIDER_PICKUP";
  if (!has.has(FIRST_MILE_SERVICE[firstMile])) notIn("firstMile", FIRST_MILE_SERVICE[firstMile]);
  const lastMile = input.lastMile ?? defaultLastMile(has) ?? "DOORSTEP";
  if (!has.has(LAST_MILE_SERVICE[lastMile])) notIn("lastMile", LAST_MILE_SERVICE[lastMile]);
  const offered = deliveryTypesFor(segment, deliveryTypes);
  const wanted = input.speed ? findDeliveryType(input.speed, deliveryTypes) : undefined;
  const speed = wanted?.code ?? input.speed ?? offered.find(t => t.code === DEFAULT_DELIVERY_TYPE)?.code ?? offered[0]?.code ?? DEFAULT_DELIVERY_TYPE;
  if (input.speed && !offered.some(t => t.code === speed))
    problems.push({ field: "speed", code: "INVALID", message: `${wanted?.name ?? input.speed} isn't a ${SEGMENT_LABEL[segment]} delivery type (choose ${offered.map(t => t.name).join(", ") || "none offered"})` });
  const codAmount = Math.max(0, input.codAmount ?? 0);
  if (codAmount > 0) {
    if (isBanking(segment)) problems.push({ field: "codAmount", code: "INVALID", message: "Banking & Financial parcels can't be cash on delivery" });
    else if (!has.has("payment.cod")) notIn("codAmount", "payment.cod");
  }
  const openBox = !!input.openBox;
  if (openBox && (segment !== "ECOMMERCE" || !has.has("option.open_box"))) notIn("openBox", "option.open_box");
  const bookable = bookableNotifications(services);
  let notifications = bookable;
  if (input.notifications) {
    notifications = [];
    for (const code of input.notifications) {
      if (!SERVICE_BY_CODE.has(code) || SERVICE_BY_CODE.get(code)!.group !== "parcelNotifications") problems.push({ field: "notifications", code: "INVALID", message: `Unknown notification "${code}"` });
      else if (!bookable.includes(code)) notIn("notifications", code);
      else if (!notifications.includes(code)) notifications.push(code);
    }
  }
  const weightKg = isBanking(segment) ? 0.5 : (input.weightKg ?? INCLUDED_WEIGHT_KG);
  return { selection: { firstMile, lastMile, speed, productType: input.productType ?? "REGULAR", openBox, codAmount, weightKg, notifications }, problems };
}

/** Proof methods the rider may use for a parcel: the package's, without OTP when the delivery code isn't sent. */
export function proofMethodsFor(services: readonly string[], notifications: readonly string[]): ("PHOTO" | "OTP" | "SIGNATURE")[] {
  const has = new Set(services);
  const methods: ("PHOTO" | "OTP" | "SIGNATURE")[] = [];
  if (has.has("proof.otp") && notifications.includes("notify.delivery_code")) methods.push("OTP");
  if (has.has("proof.signature")) methods.push("SIGNATURE");
  if (has.has("proof.photo")) methods.push("PHOTO");
  return methods;
}

// ───────────── the pricing engine ─────────────

export type PriceLineCode = "route" | "product_type" | "weight" | "speed" | "handling" | "last_mile" | "first_mile" | "open_box" | "floor" | "cod_fee";
export interface PriceLine {
  code: PriceLineCode;
  label: string;
  amount: number;
}

export interface PriceInput {
  segment: PackageSegment;
  services: readonly string[];
  tier: RouteTier;
  selection: Pick<BookingSelection, "firstMile" | "lastMile" | "speed" | "productType" | "openBox" | "codAmount" | "weightKg">;
  /** The delivery type's name for its price line (default: its code). */
  deliveryTypeName?: string;
}

export interface PriceBreakdown {
  tier: RouteTier;
  lines: PriceLine[];
  /** Before COD, never below 0. */
  deliveryCharge: number;
  codFee: number;
  /** What the sender pays (the recipient separately pays the COD amount). */
  totalCharge: number;
  /** Legacy columns (Parcel.baseCharge / weightCharge / serviceCharge / codFee / discount). */
  columns: { baseCharge: number; weightCharge: number; serviceCharge: number; codFee: number; discount: number };
}

const whole = (n: number) => Math.round(n + 1e-9);
/** The flat ৳ / % / count price fields (not the delivery type fees). */
type NumericPrice = Exclude<keyof PackagePrices, "deliveryFees">;
const PRODUCT_FEE: Record<ProductType, NumericPrice> = { REGULAR: "typeRegular", DOCUMENT: "typeDocument", BOOKS: "typeBooks" };
const ROUTE_FEE: Record<RouteTier, NumericPrice> = { DHAKA_SUBURBAN: "dhakaSuburban", SAME_DISTRICT: "sameDistrict", DIFFERENT_DISTRICT: "differentDistrict" };

/**
 * The one price formula (website, merchant forms, imports, API, operations, bulk updates, intake
 * changes, completing details, re-weighing). Pure: the caller resolves the route tier and the
 * package. Order: route · product type (E-commerce: one route line with it) · weight · service · last mile · first mile · open box →
 * delivery charge (never below 0) → COD fee. VAT-inclusive; every line whole taka (COD rounds up).
 */
export function priceParcel(prices: PackagePrices, input: PriceInput): PriceBreakdown {
  const s = input.selection;
  const banking = isBanking(input.segment);
  const lines: PriceLine[] = [];
  const add = (code: PriceLineCode, label: string, amount: number) => {
    if (amount !== 0 || code === "route") lines.push({ code, label, amount });
  };
  // E-commerce: the route and what is sent are one line, their sum ("Inside same district + Regular").
  if (input.segment === "ECOMMERCE")
    add("route", `${ROUTE_TIER_LABEL[input.tier]} + ${PRODUCT_TYPE_LABEL[s.productType]}`, whole(prices[ROUTE_FEE[input.tier]]) + whole(prices[PRODUCT_FEE[s.productType]]));
  else add("route", ROUTE_TIER_LABEL[input.tier], whole(prices[ROUTE_FEE[input.tier]]));
  if (!banking) {
    if (input.segment !== "ECOMMERCE") add("product_type", `What you send: ${PRODUCT_TYPE_LABEL[s.productType]}`, whole(prices[PRODUCT_FEE[s.productType]]));
    const extraKg = Math.max(0, Math.ceil(s.weightKg - INCLUDED_WEIGHT_KG - 1e-9));
    add("weight", `Weight (${extraKg} kg over ${INCLUDED_WEIGHT_KG} kg)`, whole(extraKg * prices.extraKg));
  }
  // Delivery type: its + charge from the package (a type without one adds ৳0).
  add("speed", input.deliveryTypeName ?? s.speed, whole(prices.deliveryFees?.[s.speed] ?? 0));
  add("last_mile", LAST_MILE_LABEL[s.lastMile], whole(s.lastMile === "HUB_COLLECT" ? prices.hubPickupFee : prices.homeDeliveryFee));
  if (s.firstMile === "HUB_DROP") add("first_mile", FIRST_MILE_LABEL.HUB_DROP, -whole(prices.hubDropDiscount));
  else if (s.firstMile === "ON_DEMAND_PICKUP") add("first_mile", FIRST_MILE_LABEL.ON_DEMAND_PICKUP, whole(prices.onDemandPickupFee));
  if (s.openBox && input.segment === "ECOMMERCE") add("open_box", "Open box", whole(prices.openBoxFee));
  const sum = lines.reduce((t, l) => t + l.amount, 0);
  if (sum < 0) add("floor", "Delivery charge can't go below ৳0", -sum);
  const deliveryCharge = Math.max(0, sum);
  const codFee = !banking && s.codAmount > 0 ? Math.max(Math.ceil(prices.codMin - 1e-9), Math.ceil((s.codAmount * prices.codPercent) / 100 - 1e-9)) : 0;
  if (codFee) lines.push({ code: "cod_fee", label: `COD fee (${prices.codPercent}%${prices.codMin ? `, min ৳${prices.codMin}` : ""})`, amount: codFee });
  const positive = (...codes: PriceLineCode[]) => lines.filter(l => codes.includes(l.code)).reduce((t, l) => t + Math.max(0, l.amount), 0);
  const baseCharge = positive("route", "product_type");
  const weightCharge = positive("weight");
  const serviceCharge = positive("speed", "handling", "last_mile", "first_mile", "open_box", "floor");
  return {
    tier: input.tier,
    lines,
    deliveryCharge,
    codFee,
    totalCharge: deliveryCharge + codFee,
    columns: { baseCharge, weightCharge, serviceCharge, codFee, discount: baseCharge + weightCharge + serviceCharge - deliveryCharge },
  };
}

/**
 * Price lines as shown: E-commerce shows the route and what is sent as one line, their sum
 * ("Inside same district + Regular"), also for parcels priced before priceParcel did so.
 */
export function displayPriceLines<L extends { code: string; label: string; amount: number }>(lines: L[], segment: string | null | undefined): L[] {
  if (segment !== "ECOMMERCE") return lines;
  const route = lines.find(l => l.code === "route");
  const type = lines.find(l => l.code === "product_type");
  if (!route || !type) return lines;
  const what = type.label.replace(/^What you send:\s*/i, "");
  return lines.filter(l => l !== type).map(l => (l === route ? { ...l, label: `${route.label} + ${what}`, amount: route.amount + type.amount } : l));
}

/** Re-attempt fee for the n-th failed attempt (1-based): free for the first `freeReattempts`. */
export function reattemptFeeFor(prices: Pick<PackagePrices, "freeReattempts" | "reattemptFee">, failedAttempts: number): number {
  return failedAttempts > prices.freeReattempts ? whole(prices.reattemptFee) : 0;
}

// ───────────── booking request fields (API) ─────────────

export const firstMileSchema = z.preprocess(v => (typeof v === "string" ? (parseFirstMile(v) ?? v) : v), z.enum(FIRST_MILES, "Choose RIDER_PICKUP, HUB_DROP or ON_DEMAND_PICKUP"));
export const lastMileSchema = z.preprocess(v => (typeof v === "string" ? (parseLastMile(v) ?? v) : v), z.enum(LAST_MILES, "Choose DOORSTEP (home delivery) or HUB_COLLECT (Hub Pickup)"));
/** A delivery type: its code or name (checked against the database's types where it is used). */
export const speedOptionSchema = z.string().trim().min(1, "Choose the delivery type").max(60);
export const notificationCodesSchema = z.array(z.string().trim().min(1).max(60)).max(40);

/** Optional service fields of a booking / quote (POST /parcels, quotes). */
export const serviceSelectionSchema = z.object({
  /** Default: rider pickup, else drop at hub (if rider pickup isn't in the package). */
  firstMile: firstMileSchema.optional(),
  /** HUB_DROP: the hub the sender brings the parcel to. */
  dropHubId: z.uuid().optional(),
  /** Default: home delivery, else Hub Pickup. */
  lastMile: lastMileSchema.optional(),
  /** HUB_COLLECT: the collection hub; default the hub serving the recipient's zone. */
  collectHubId: z.uuid().optional(),
  /** The delivery type (code or name: Regular, Express, 4 Hour Delivery, Same Day Delivery…). Default Regular. */
  speed: speedOptionSchema.optional(),
  /** E-commerce: open box / check before pay. */
  openBox: z.boolean().optional(),
  /** Product name (or id) from the category's product list; its type prices it. Optional: none = Regular. */
  product: z.string().trim().min(1).max(120).optional(),
  /** Parcel notifications to send (codes from the package); default every one in the package. */
  notifications: notificationCodesSchema.optional(),
  /** The product category (name or id); default the product's. Its channels decide where messages go. */
  category: z.string().trim().min(1).max(80).optional(),
  /** The priority tag (name or id: General, Security, Online Product…); default the list's default. */
  priority: z.string().trim().min(1).max(80).optional(),
});
export type ServiceSelectionInput = z.infer<typeof serviceSelectionSchema>;
