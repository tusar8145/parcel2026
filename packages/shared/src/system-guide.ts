/**
 * System guide (super admin › System guide, Courier Operations › Settings): what the numbers, parcel statuses,
 * money steps and roles of the platform mean. Shown as is by the panels (GET /guide). When a new numbered
 * document is added (nextNumber / nextCounter in the API), add its prefix here: an API test checks that every
 * prefix the code generates is listed.
 */
import { PARCEL_STATUSES, PARCEL_STATUS_LABEL, TERMINAL_STATUSES, allowedNextStatuses, type ParcelStatus } from "./parcel-status";
import { PANEL_FOR_ROLE, PERMISSION_INFO, ROLE_PERMISSIONS, ROLES, type Role } from "./roles";

/**
 * New parcels' tracking ID prefix by parcel type: EP (E-commerce), FD (Banking & Financial), CP (Customer: website,
 * walk-in). Parcels made before, and a hub's CN stock (its type not known yet), keep PP.
 */
export const parcelPrefix = (segment: "CUSTOMER" | "ECOMMERCE" | "BANKING_FINANCIAL") => (segment === "ECOMMERCE" ? "EP" : segment === "BANKING_FINANCIAL" ? "FD" : "CP");
/** The parcel prefix of a merchant (null = no merchant: a customer parcel). */
export const parcelPrefixOfMerchant = (type: "ECOMMERCE" | "BANKING_FINANCIAL" | null | undefined) => parcelPrefix(type ?? "CUSTOMER");

/** New merchants' code prefix: EC (E-commerce) or FM (Banking & Financial); merchants made before keep MR. */
export const merchantCodePrefix = (type: "ECOMMERCE" | "BANKING_FINANCIAL") => (type === "BANKING_FINANCIAL" ? "FM" : "EC");

export type GuideArea = "Parcels" | "Linehaul" | "Money" | "Accounts & people" | "Network" | "Support & files";

export interface NumberPrefix {
  prefix: string;
  name: string;
  area: GuideArea;
  /** YYMMDD = booking / creation day (Dhaka), YYMM = month, NNNN = running number, XXXXX = random letters and digits. */
  format: string;
  example: string;
  meaning: string;
  /** When the number is made. */
  created: string;
  /** Where to find it. */
  where: string;
  /** Typed by an administrator (not generated). */
  manual?: boolean;
}

export const NUMBER_PREFIXES: readonly NumberPrefix[] = [
  // ── parcels ──
  {
    prefix: "EP",
    name: "E-commerce parcel (tracking ID / CN)",
    area: "Parcels",
    format: "EP-YYMMDD-XXXXX",
    example: "EP-261026-7K3QF",
    meaning: "An E-commerce merchant's parcel number everywhere: label, tracking page, SMS, scans, reports. Also called the CN (consignment number).",
    created: "When an E-commerce merchant's parcel is booked (or a CN batch is made for such a merchant); a partial delivery's return part gets a new one.",
    where: "All parcels, the parcel drawer, the label, the public tracking page.",
  },
  {
    prefix: "FD",
    name: "Banking & Financial parcel (tracking ID / CN)",
    area: "Parcels",
    format: "FD-YYMMDD-XXXXX",
    example: "FD-261026-2M8RP",
    meaning: "A Banking & Financial merchant's parcel / document number, used everywhere like any tracking ID.",
    created: "When a Banking & Financial merchant's parcel is booked (or a CN batch is made for such a merchant).",
    where: "All parcels, the parcel drawer, the label, the public tracking page.",
  },
  {
    prefix: "CP",
    name: "Customer parcel (tracking ID / CN)",
    area: "Parcels",
    format: "CP-YYMMDD-XXXXX",
    example: "CP-261026-9HT4D",
    meaning: "A customer's parcel (booked on the website, or a walk-in sender at a hub).",
    created: "When a customer or walk-in parcel is booked.",
    where: "All parcels, the parcel drawer, the label, the public tracking page.",
  },
  {
    prefix: "PP",
    name: "Parcel tracking ID (older / hub CN stock)",
    area: "Parcels",
    format: "PP-YYMMDD-XXXXX",
    example: "PP-261025-5PTW8",
    meaning: "Parcels booked before EP / FD / CP, and CN labels printed for a hub (the parcel's type isn't known when they are printed). They keep working everywhere.",
    created: "CN stock made for a hub; no longer for new bookings without a pre-printed label.",
    where: "All parcels, the parcel drawer, the label, the public tracking page.",
  },
  {
    prefix: "CNB",
    name: "CN stock batch",
    area: "Parcels",
    format: "CNB-YYMMDD-NNNN",
    example: "CNB-261015-0001",
    meaning: "A batch of tracking IDs printed on labels before booking: for a merchant they carry its type (EP / FD), for a hub PP.",
    created: "When operations allocate CN stock.",
    where: "Courier Operations › CN stock.",
  },
  {
    prefix: "PR",
    name: "Pickup request",
    area: "Parcels",
    format: "PR-YYMMDD-NNNN",
    example: "PR-261024-0003",
    meaning: "A merchant's request to collect parcels from their address (one-off or a recurring schedule).",
    created: "When a merchant asks for a pickup.",
    where: "Merchant › Pickup requests; Courier Operations › Pickup (Scheduled pickups).",
  },
  {
    prefix: "RR",
    name: "Return run",
    area: "Parcels",
    format: "RR-YYMMDD-NNNN",
    example: "RR-261016-0001",
    meaning: "A batch of parcels going back to one merchant, taken by a rider.",
    created: "When operations start a return to the merchant.",
    where: "Courier Operations › Returns.",
  },
  // ── linehaul ──
  {
    prefix: "MF",
    name: "Linehaul manifest (trip)",
    area: "Linehaul",
    format: "MF-YYMMDD-NNNN",
    example: "MF-261015-0001",
    meaning: "A truck trip between two hubs with the bags it carries.",
    created: "When a hub creates a trip.",
    where: "Courier Operations › Transfers; Reports › Hub transfer report.",
  },
  {
    prefix: "BG",
    name: "Bag",
    area: "Linehaul",
    format: "BG-YYMMDD-NNNN",
    example: "BG-261015-0001",
    meaning: "A sealed bag of parcels going from one hub to another.",
    created: "When a hub opens a bag (or a bulk transfer file creates one).",
    where: "Courier Operations › Transfers.",
  },
  // ── money ──
  {
    prefix: "HS",
    name: "Cash handover slip",
    area: "Money",
    format: "HS-YYMMDD-NNNN",
    example: "HS-261025-0001",
    meaning: "A rider's COD cash handed in at the hub (with a barcode to scan).",
    created: "When a rider makes the slip in the rider app (or the hub makes it for a rider without a phone).",
    where: "Rider › Earnings › My cash; Courier Operations › Accounts › Rider cash.",
  },
  {
    prefix: "HT",
    name: "Hub transfer (cash)",
    area: "Money",
    format: "HT-YYMMDD-NNNN",
    example: "HT-261025-0001",
    meaning: "Cash a hub sends to the central hub, whole slips at a time.",
    created: "When a hub sends its cash on.",
    where: "Courier Operations › Accounts › Hub transfers.",
  },
  {
    prefix: "ST",
    name: "Settlement (payout)",
    area: "Money",
    format: "ST-YYMM-NNNN",
    example: "ST-2610-0001",
    meaning: "Money paid out to an E-commerce merchant or a customer (COD less charges).",
    created: "When finance creates a settlement; marked paid with the reference.",
    where: "Courier Operations › Accounts › E-commerce / Customer; merchant › Balance.",
  },
  {
    prefix: "INV",
    name: "Bill",
    area: "Money",
    format: "INV-YYMM-NNNN",
    example: "INV-2610-0001",
    meaning: "A Financial merchant's bill for the deliveries of a date range.",
    created: "When finance bills a Financial merchant.",
    where: "Courier Operations › Accounts › Financial; merchant › Balance.",
  },
  {
    prefix: "PAY",
    name: "Payment",
    area: "Money",
    format: "PAY-YYMM-NNNN",
    example: "PAY-2610-0001",
    meaning: "A payment from a Financial merchant (partial payments allowed; the oldest bill is paid first, extra stays as credit).",
    created: "When a payment is recorded or a merchant reports one.",
    where: "Courier Operations › Accounts › Financial; merchant › Balance.",
  },
  {
    prefix: "RPO",
    name: "Rider payout",
    area: "Money",
    format: "RPO-YYMM-NNNN",
    example: "RPO-2610-0001",
    meaning: "A rider's earnings for a period: prepared, approved, paid.",
    created: "When rider pay is prepared.",
    where: "Courier Operations › Accounts › Rider pay; Rider › Earnings.",
  },
  {
    prefix: "FRM",
    name: "Franchise deposit",
    area: "Money",
    format: "FRM-YYMM-NNNN",
    example: "FRM-2610-0001",
    meaning: "COD cash a franchise hub deposits (its commission may be kept from it).",
    created: "When a franchise deposits cash.",
    where: "Courier Operations › Accounts › Franchise; the franchise panel.",
  },
  {
    prefix: "FIN",
    name: "Franchise commission invoice",
    area: "Money",
    format: "FIN-YYMM-NNNN",
    example: "FIN-2610-0001",
    meaning: "A franchise's commission for a period, when commission is billed instead of kept from deposits.",
    created: "When finance bills franchise commission.",
    where: "Courier Operations › Accounts › Franchise.",
  },
  {
    prefix: "JE",
    name: "Ledger journal entry",
    area: "Money",
    format: "JE-YYMM-NNNN",
    example: "JE-2610-0001",
    meaning: "An internal accounting line for rider pay and franchise money (not shown to merchants).",
    created: "Automatically with rider payouts and franchise money.",
    where: "Audit and exports.",
  },
  // ── accounts & people ──
  {
    prefix: "EC",
    name: "E-commerce merchant code",
    area: "Accounts & people",
    format: "EC-NNNN",
    example: "EC-1040",
    meaning: "An E-commerce merchant's short, fixed name: on labels, PDFs, exports and in searches; stays when the merchant is renamed.",
    created: "When an E-commerce merchant account is created (one running number with FM, so a number is never used twice).",
    where: "Merchant lists, the merchant's panel, labels and statements.",
  },
  {
    prefix: "FM",
    name: "Banking & Financial merchant code",
    area: "Accounts & people",
    format: "FM-NNNN",
    example: "FM-1041",
    meaning: "A Banking & Financial merchant's short, fixed name: on labels, PDFs, bills, exports and in searches.",
    created: "When a Banking & Financial merchant account is created (one running number with EC).",
    where: "Merchant lists, the merchant's panel, labels, bills and statements.",
  },
  {
    prefix: "MR",
    name: "Merchant code (older)",
    area: "Accounts & people",
    format: "MR-NNNN",
    example: "MR-1031",
    meaning: "The code merchants created before EC / FM got (both types). They keep it.",
    created: "No longer made (new merchants get EC- or FM-).",
    where: "Merchant lists, the merchant's panel, labels and statements.",
  },
  {
    prefix: "R",
    name: "Rider code",
    area: "Accounts & people",
    format: "R-NNNN",
    example: "R-2107",
    meaning: "A rider's short code: on run sheets, scans, reports and rider lists.",
    created: "When a rider is added (from 2100), unless a code is typed.",
    where: "Courier Operations › Riders; the rider app.",
  },
  {
    prefix: "FR",
    name: "Franchise code",
    area: "Accounts & people",
    format: "FR-NNNN",
    example: "FR-1001",
    meaning: "A franchise partner's code.",
    created: "When a franchise is created.",
    where: "Super admin › Franchises.",
  },
  // ── network (typed by administrators) ──
  {
    prefix: "Hub code",
    name: "Hub code",
    area: "Network",
    format: "Typed (e.g. AREA-PLACE)",
    example: "DHK-TEJ",
    meaning: "A hub's short code.",
    created: "Typed when the hub is added.",
    where: "Super admin › Hubs & zones › Hubs.",
    manual: true,
  },
  {
    prefix: "Zone code",
    name: "Delivery zone code",
    area: "Network",
    format: "Typed",
    example: "DHN-GUL",
    meaning: "A delivery zone's code (the zone a hub serves).",
    created: "Made with the zone in Shared catalogs & locations.",
    where: "Super admin › Hubs & zones › Delivery zones.",
    manual: true,
  },
  {
    prefix: "Route code",
    name: "Route code",
    area: "Network",
    format: "Typed",
    example: "GUL-R1",
    meaning: "A delivery route of a hub (zones served together, a default rider).",
    created: "Typed when the route is added.",
    where: "Super admin › Hubs & zones › Routes.",
    manual: true,
  },
  // ── support & files ──
  {
    prefix: "DF-SUP",
    name: "Support ticket",
    area: "Support & files",
    format: "DF-SUP-YYMMDD-NNNN",
    example: "DF-SUP-261025-0001",
    meaning: "A support conversation; franchise and rider applications use the same number.",
    created: "When someone opens a ticket or applies.",
    where: "Support tickets in every panel.",
  },
  {
    prefix: "IMP",
    name: "Excel import",
    area: "Support & files",
    format: "IMP-YYMMDD-NNN",
    example: "IMP-261016-001",
    meaning: "One uploaded spreadsheet of orders (or other records), with its rows and results.",
    created: "When a file is uploaded to an import.",
    where: "Import history in each panel.",
  },
  {
    prefix: "BLK",
    name: "Excel bulk update",
    area: "Support & files",
    format: "BLK-YYMMDD-NNN",
    example: "BLK-261026-001",
    meaning: "One uploaded spreadsheet of changes to existing parcels (status, rider, hub…).",
    created: "When a bulk update file is applied.",
    where: "Courier Operations › Bulk update history.",
  },
];

/** What each parcel status means. */
export const PARCEL_STATUS_INFO: Record<ParcelStatus, string> = {
  PENDING_CONFIRMATION: "Booked; operations still have to accept it (and assign a pickup rider, or wait for a hub drop-off).",
  PICKUP_ASSIGNED: "A pickup rider is assigned to collect it.",
  PICKUP_CONFIRMED: "The pickup rider confirmed the pickup.",
  PICKED_UP: "Collected from the sender; on the way to the hub.",
  PICKUP_CANCELLED: "Cancelled before pickup. Final.",
  AT_HUB: "At a hub, waiting for a delivery rider or a transfer.",
  ASSIGNED: "A delivery rider is assigned.",
  IN_TRANSIT: "Travelling between hubs (on a linehaul trip or moved by hand).",
  OUT_FOR_DELIVERY: "With the delivery rider on the way to the recipient.",
  DELIVERED: "Handed to the recipient (COD collected, proof taken). Final; its account lines are posted.",
  RETRY_SCHEDULED: "A delivery attempt failed; it will be tried again.",
  RETURN_SCHEDULED: "Going back to the sender (a return run).",
  RETURNED: "Back with the sender. Final; its account lines are posted.",
  EXCEPTION: "Needs attention (damaged, address problem, missing details…).",
  READY_FOR_COLLECTION: "Waiting at the hub for the recipient to collect it.",
};

/** The money steps (Accounts). */
export const MONEY_FLOW: readonly { step: string; detail: string; number?: string }[] = [
  { step: "Delivered or returned", detail: "The parcel posts its account lines: COD (for the merchant or customer) and the delivery / return charge." },
  { step: "Rider → hub", detail: "The rider hands the COD in with a cash slip; the hub scans it, counts the cash and receives it.", number: "HS" },
  { step: "Hub → central hub", detail: "Hubs send the cash they received to the central hub, whole slips at a time; the central hub receives it.", number: "HT" },
  { step: "Settle (E-commerce merchants, customers)", detail: "Only cash that reached the central hub is ready to settle; finance creates a settlement and marks it paid.", number: "ST" },
  { step: "Bill (Financial merchants)", detail: "Financial merchants get a bill for a date range and pay it, in parts if needed (oldest bill first; extra stays as credit).", number: "INV · PAY" },
  { step: "Riders and franchises", detail: "Rider pay and franchise money are prepared and paid from Accounts (Rider pay, Franchise).", number: "RPO · FRM · FIN" },
];

const ROLE_INFO: Record<Role, { label: string; description: string }> = {
  CUSTOMER: { label: "Customer", description: "Books and tracks their own parcels on the website." },
  MERCHANT_OWNER: { label: "Merchant owner", description: "Runs a merchant account: orders, pickups, balance, settings and staff." },
  MERCHANT_STAFF: { label: "Merchant staff", description: "Books and follows the merchant's parcels." },
  RIDER: { label: "Rider", description: "Picks up and delivers parcels, collects COD and hands it in (rider app)." },
  HUB_OPERATOR: { label: "Hub operator", description: "Works one hub: receives parcels, assigns riders, receives rider cash." },
  OPS_MANAGER: { label: "Operations manager", description: "Runs the whole network: parcels, riders, hubs, merchants, support and money." },
  FINANCE: { label: "Finance", description: "Settlements, bills, payments and finance settings." },
  SUPPORT_AGENT: { label: "Support agent", description: "Answers tickets and looks up parcels, merchants and riders." },
  SUPER_ADMIN: { label: "Super admin", description: "Platform control: settings, prices, hubs, roles and approvals (two-step verification required)." },
  FRANCHISE: { label: "Franchise", description: "The one account of a franchise hub (its own panel)." },
  APPLICANT: { label: "Applicant", description: "Applied to ride or run a franchise; sees only the application page." },
};

/** Where things are changed. */
export const SETTING_LOCATIONS: readonly { what: string; where: string }[] = [
  { what: "Company name, logo, browser tab icon, contact details, About page (white label)", where: "Super admin › Branding & company" },
  { what: "Prices, service packages, COD fee", where: "Super admin › Service plans & pricing" },
  { what: "Excel import columns and defaults", where: "Super admin › Excel Import settings" },
  { what: "Parcel SMS / email texts", where: "Super admin › Parcel notifications" },
  { what: "Other SMS / email texts", where: "Super admin › Global notifications" },
  { what: "SMS / email on or off, SMS limits, gateways, push notifications and messages to merchants and riders", where: "Super admin › SMS, Email & Push" },
  { what: "Hubs, delivery zones, routes, the central hub", where: "Super admin › Hubs & zones" },
  { what: "Districts, zones, areas, return reasons", where: "Super admin › Shared catalogs & locations" },
  { what: "Staff accounts, roles, permissions, approvals", where: "Super admin › Admin users & roles" },
  { what: "Rider earnings", where: "Super admin › Rider earning plans" },
  { what: "SLA due times", where: "Courier Operations › Reports › Analytics & SLA" },
  { what: "Riders, shifts, verification", where: "Courier Operations › Riders" },
  { what: "Merchant pickup address (the hub follows it)", where: "Courier Operations › Merchants › Change address" },
];

/** Everything the System guide shows. */
export function systemGuide() {
  return {
    numbers: NUMBER_PREFIXES,
    statuses: PARCEL_STATUSES.map(status => ({
      status,
      label: PARCEL_STATUS_LABEL[status],
      meaning: PARCEL_STATUS_INFO[status],
      final: TERMINAL_STATUSES.includes(status),
      next: {
        operations: allowedNextStatuses(status, "ops").filter(s => s !== status).map(s => PARCEL_STATUS_LABEL[s]),
        rider: allowedNextStatuses(status, "rider").filter(s => s !== status).map(s => PARCEL_STATUS_LABEL[s]),
      },
    })),
    money: MONEY_FLOW,
    roles: ROLES.map(role => ({
      role,
      ...ROLE_INFO[role],
      panel: PANEL_FOR_ROLE.find(([r]) => r === role)?.[1] ?? null,
      permissions: ROLE_PERMISSIONS[role].map(p => PERMISSION_INFO[p]?.label ?? p),
    })),
    settings: SETTING_LOCATIONS,
  };
}
