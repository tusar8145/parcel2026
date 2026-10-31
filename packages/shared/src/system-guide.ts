/**
 * System guide (super admin › System guide, Courier Operations › Settings): what the numbers mean, the parcel
 * lifecycle and its notifications (in Bangla, for staff and clients), the money steps and roles of the platform. Shown as is by the panels (GET /guide). When a new numbered
 * document is added (nextNumber / nextCounter in the API), add its prefix here: an API test checks that every
 * prefix the code generates is listed.
 */
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
    prefix: "CNB",
    name: "CN stock batch",
    area: "Parcels",
    format: "CNB-YYMMDD-NNNN",
    example: "CNB-261015-0001",
    meaning: "A batch of tracking IDs printed on labels before booking: for a merchant they carry its type (EP / FD).",
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

/** Who does a step (System guide › Parcel lifecycle and Notifications). */
export type GuideActor = "MERCHANT" | "OPERATIONS" | "RIDER" | "SYSTEM" | "CUSTOMER";

export const GUIDE_ACTORS: Record<GuideActor, { label: string; where: string }> = {
  MERCHANT: { label: "Merchant", where: "Merchant panel ও Merchant App (পার্সেল তৈরি)" },
  OPERATIONS: { label: "Operations", where: "Courier Operations-এর **Parcel queue** (কাজের তালিকা) ও **Scan desk** (স্ক্যান করে গ্রহণ ও হস্তান্তর), Ops App" },
  RIDER: { label: "Rider", where: "মোবাইলের **Rider App**" },
  SYSTEM: { label: "System", where: "নিজে থেকেই হয়, কাউকে কিছু করতে হয় না" },
  CUSTOMER: { label: "Customer", where: "প্রাপক (গ্রাহক): SMS ও email পান, কোনো অ্যাপ লাগে না" },
};

export interface LifecycleStep {
  /** Several: any one of them does it. */
  actors: GuideActor[];
  /** The screen and option (option names in **bold**, as on screen). */
  where: string;
  what: string;
  /** The parcel's status afterwards. */
  status?: string;
}

/**
 * The parcel's journey for staff and clients, in Bangla with the option names as they appear on screen:
 * First mile → Middle mile → Last mile, each with its ways, who does each step and where.
 */
export const PARCEL_LIFECYCLE: {
  stages: { key: string; title: string; summary: string; ways: { title: string; steps: LifecycleStep[]; notes?: string[] }[]; notes?: string[] }[];
  journeys: { name: string; first: string; middle: string; last: string }[];
  tasks: { actor: GuideActor; items: [string, string][] }[];
  bottomLine: string;
} = {
  stages: [
    {
      key: "first",
      title: "First mile",
      summary: "মার্চেন্টের কাছ থেকে পার্সেল প্রথম হাবে পৌঁছানো পর্যন্ত।",
      ways: [
        {
          title: "উপায় ১: রাইডার মার্চেন্টের কাছ থেকে পিকআপ করেন",
          steps: [
            { actors: ["MERCHANT"], where: "পার্সেল তৈরি", what: "পিকআপের অনুরোধ যায়", status: "Pickup request submitted" },
            { actors: ["OPERATIONS"], where: "Parcel queue › **Pickups to assign**", what: "একজন রাইডার বেছে নিয়ে পিকআপের দায়িত্ব দেন", status: "Pickup accepted" },
            { actors: ["RIDER"], where: "Rider App › **Pickups to do**", what: "মার্চেন্টের কাছে গিয়ে পার্সেল নেন", status: "Picked up" },
            { actors: ["RIDER"], where: "Rider App › **Carrying (to hand over)**", what: "হাবে পার্সেল জমা দেন", status: "Handed over at Dhanmondi Hub" },
            { actors: ["OPERATIONS"], where: "Parcel queue › **Picked up · to receive at hub**", what: "স্ক্যান করে হাবে গ্রহণ করেন", status: "At hub" },
          ],
          notes: [
            "বিকল্প: রাইডার অ্যাপে পিকআপ চিহ্নিত না করে সরাসরি হাবে পার্সেল নিয়ে এলে, অপারেশন টিম **Out for pickup** থেকে স্ক্যান করে গ্রহণ করে (স্ট্যাটাস **At hub**)। সেখানে রাইডারের নাম আর হাব আগে থেকেই দেখা যায়।",
          ],
        },
        {
          title: "উপায় ২: মার্চেন্ট নিজে হাবে জমা দেন (Drop-off)",
          steps: [
            { actors: ["MERCHANT"], where: "পার্সেল তৈরির সময় হাবে জমা দেওয়ার অপশন", what: "হাবে আনার জন্য বুক হয়", status: "Booked for drop-off at Badda Delivery Hub" },
            { actors: ["OPERATIONS"], where: "Parcel queue › **Drop-offs to receive**", what: "মার্চেন্ট পার্সেল আনলে স্ক্যান করে গ্রহণ করেন", status: "Received at Badda Delivery Hub (drop-off)" },
          ],
          notes: ["এখানে রাইডারের কোনো কাজ নেই।"],
        },
      ],
    },
    {
      key: "middle",
      title: "Middle mile",
      summary: "এক হাব থেকে ডেলিভারি এলাকার হাবে পাঠানো। এই ধাপটি শুধু অপারেশন টিম করে, রাইডারের কোনো কাজ নেই।",
      ways: [
        {
          title: "হাব থেকে হাবে",
          steps: [
            { actors: ["OPERATIONS"], where: "Parcel queue › **Transfers to dispatch** (পাঠানো হাব)", what: "রুট দেখায় (যেমন Dhanmondi Hub → Rajshahi Hub), স্ক্যান করে পাঠান", status: "In transit to Rajshahi Hub" },
            { actors: ["OPERATIONS"], where: "Parcel queue › **Transfers to receive** (গন্তব্য হাব)", what: "পার্সেল পৌঁছালে স্ক্যান করে গ্রহণ করেন", status: "At hub" },
          ],
        },
      ],
      notes: ["প্রথম হাবই যদি ডেলিভারি এলাকার হাব হয়, Middle mile লাগে না। পার্সেল সরাসরি Last mile-এ যায়।"],
    },
    {
      key: "last",
      title: "Last mile",
      summary: "ডেলিভারি হাব থেকে গ্রাহকের হাতে পৌঁছানো।",
      ways: [
        {
          title: "উপায় ১: রাইডার গ্রাহকের বাসায় দেন (Home delivery)",
          steps: [
            { actors: ["OPERATIONS"], where: "Parcel queue › **Deliveries to assign**", what: "ডেলিভারি রাইডার বেছে নিয়ে স্ক্যান করেন", status: "Assigned to delivery rider" },
            { actors: ["RIDER"], where: "Rider App › **Deliveries to do**", what: "রাইডার তাঁর ডেলিভারি তালিকা দেখেন" },
            {
              actors: ["OPERATIONS", "RIDER"],
              where: "Parcel queue › **Assigned · ready to go out** (রাইডার বের হওয়ার সময় স্ক্যান), অথবা Rider App › পার্সেল খুলে **Start delivery**",
              what: "রাইডার ডেলিভারির জন্য বের হন। গ্রাহক SMS-এ OTP (ডেলিভারি কোড) পান",
              status: "Out for delivery",
            },
            { actors: ["RIDER"], where: "Rider App › **Delivered**", what: "গ্রাহকের কাছ থেকে OTP নিয়ে ডেলিভারি সম্পন্ন করেন", status: "Delivered" },
          ],
          notes: ["প্রয়োজনে হাব থেকেও **Scan desk**-এ ডেলিভারি সম্পন্ন করা যায়।"],
        },
        {
          title: "উপায় ২: গ্রাহক নিজে হাব থেকে নেন (Hub collection)",
          steps: [
            { actors: ["SYSTEM"], where: "নিজে থেকেই", what: "গন্তব্য হাবে পৌঁছালে সংগ্রহের জন্য প্রস্তুত হয়। গ্রাহক SMS-এ Collection code পান", status: "Ready for collection at Rajshahi Hub" },
            { actors: ["OPERATIONS"], where: "Parcel queue › **Waiting for collection at hub**", what: "কতগুলো পার্সেল অপেক্ষায় আছে, শুধু সংখ্যা দেখায়। কোনো কাজ নেই" },
            { actors: ["OPERATIONS"], where: "Scan desk › **Collect from hub**", what: "গ্রাহক এলে অপেক্ষমাণ পার্সেল দেখা যায়। Collection code মিলিয়ে হস্তান্তর করেন", status: "Delivered" },
          ],
          notes: ["এখানে রাইডারের কোনো কাজ নেই।"],
        },
      ],
    },
  ],
  journeys: [
    { name: "A: পিকআপ, তারপর বাসায় ডেলিভারি", first: "উপায় ১ (রাইডার পিকআপ)", middle: "দরকার হলে", last: "উপায় ১ (বাসায় ডেলিভারি)" },
    { name: "B: হাবে জমা, তারপর বাসায় ডেলিভারি", first: "উপায় ২ (Drop-off)", middle: "দরকার হলে", last: "উপায় ১ (বাসায় ডেলিভারি)" },
    { name: "C: হাবে জমা, তারপর হাব থেকে সংগ্রহ", first: "উপায় ২ (Drop-off)", middle: "দরকার হলে", last: "উপায় ২ (হাব থেকে সংগ্রহ)" },
  ],
  tasks: [
    {
      actor: "RIDER",
      items: [
        ["Pickups to do", "মার্চেন্টের কাছ থেকে পার্সেল নেওয়া"],
        ["Carrying (to hand over)", "হাবে পার্সেল জমা দেওয়া"],
        ["Deliveries to do", "তাঁর ডেলিভারি তালিকা দেখা"],
        ["Start delivery", "ডেলিভারির জন্য বের হওয়া"],
        ["Delivered", "OTP নিয়ে ডেলিভারি সম্পন্ন করা"],
      ],
    },
    {
      actor: "OPERATIONS",
      items: [
        ["Pickups to assign", "পিকআপ রাইডার নির্ধারণ"],
        ["Picked up · to receive at hub / Out for pickup", "রাইডারের আনা পার্সেল গ্রহণ"],
        ["Drop-offs to receive", "মার্চেন্টের জমা দেওয়া পার্সেল গ্রহণ"],
        ["Transfers to dispatch / Transfers to receive", "হাব থেকে হাবে পাঠানো ও গ্রহণ"],
        ["Deliveries to assign", "ডেলিভারি রাইডার নির্ধারণ"],
        ["Assigned · ready to go out", "রাইডার বের হওয়ার সময় স্ক্যান"],
        ["Collect from hub", "হাবে আসা গ্রাহককে পার্সেল হস্তান্তর"],
      ],
    },
  ],
  bottomLine:
    "রাইডার শুধু রাস্তার কাজ করেন (পার্সেল আনা ও পৌঁছে দেওয়া)। হাবের সব কাজ (রাইডার নির্ধারণ, স্ক্যান করে গ্রহণ, হাব থেকে হাবে পাঠানো, হাবে হস্তান্তর) অপারেশন টিম করে।",
};

/**
 * How SMS, email and push reach each panel and app along the parcel's journey (Bangla). Mirrors the API:
 * modules/notifications (catalog.ts defaults, in-app.ts, new-work.ts) and docs/architecture-contracts.md.
 */
export const NOTIFICATION_GUIDE: {
  channels: { name: string; to: string; detail: string }[];
  moments: { stage: string; moment: string; sms: string; email: string; push: string }[];
  apps: { app: string; gets: string }[];
  rules: string[];
} = {
  channels: [
    { name: "SMS", to: "প্রেরক (মার্চেন্ট/গ্রাহক) ও প্রাপক", detail: "ফোন নম্বরে যায়। সাইন-ইন কোড (OTP) আর Delivery code শুধু SMS-এই যায়।" },
    { name: "Email", to: "যাঁর email আছে", detail: "SMS-এর মতোই, তবে বিস্তারিত। OTP ও Delivery code email-এ যায় না; Collection code যায়।" },
    { name: "Push", to: "Merchant App, Rider App, Ops App", detail: "যে ফোনে অ্যাপে সাইন ইন করা আছে সেখানে আসে। ট্যাপ করলে পার্সেলটি খোলে।" },
    { name: "Bell (in-app)", to: "প্রতিটি প্যানেল", detail: "প্যানেলের ঘণ্টা আইকনে জমা থাকে। Push-এর লেখা আর Bell-এর লেখা একই।" },
  ],
  moments: [
    { stage: "First mile", moment: "Pickup request submitted / Booked for drop-off", sms: "প্রেরক: বুকিং পাওয়া গেছে", email: "প্রেরক: বুকিং পাওয়া গেছে", push: "Operations: নতুন অর্ডার বা পিকআপ অনুরোধ (Ops manager ও ওই হাবের অপারেটর)" },
    { stage: "First mile", moment: "Pickup accepted", sms: "— (চালু করা যায়)", email: "প্রেরক: রাইডার আসছেন", push: "Rider: New pickup" },
    { stage: "First mile", moment: "Picked up", sms: "— (চালু করা যায়)", email: "প্রেরক: পার্সেল নেওয়া হয়েছে", push: "—" },
    { stage: "Middle mile", moment: "In transit / At hub", sms: "—", email: "—", push: "—" },
    { stage: "Last mile", moment: "Assigned to delivery rider", sms: "—", email: "—", push: "Rider: New delivery" },
    { stage: "Last mile", moment: "Out for delivery", sms: "প্রাপক: Delivery code (OTP), সবসময় যায়, বন্ধ করা যায় না", email: "প্রাপক: ডেলিভারিতে বের হয়েছে", push: "—" },
    { stage: "Last mile", moment: "Delivered", sms: "প্রেরক: ডেলিভারি হয়েছে", email: "প্রেরক: ডেলিভারি হয়েছে", push: "Merchant: Delivered" },
    { stage: "Last mile", moment: "Ready for collection", sms: "প্রাপক: Collection code ও হাবের নাম; পরে মনে করিয়ে দেওয়া হয়", email: "প্রাপক: Collection code ও হাবের ঠিকানা", push: "—" },
    { stage: "সমস্যা হলে", moment: "Delivery attempt failed", sms: "প্রেরক", email: "প্রেরক", push: "—" },
    { stage: "সমস্যা হলে", moment: "Pickup cancelled / Return scheduled / Returned", sms: "প্রেরক", email: "প্রেরক", push: "Merchant: পার্সেলের ফল" },
  ],
  apps: [
    { app: "Merchant panel ও Merchant App", gets: "Bell ও Push: পার্সেলের চূড়ান্ত ফল (Delivered, Cancelled, Return scheduled, Returned), অনুমোদন, KYC, Settlement, Invoice, Excel import শেষ, Support reply। SMS ও email: প্যাকেজে চালু থাকা পার্সেল মেসেজ।" },
    { app: "Rider panel ও Rider App", gets: "Bell ও Push: New pickup, New delivery, Return run, KYC, Payout। ট্যাপ করলে পার্সেল বা পিকআপ খোলে।" },
    { app: "Courier Operations ও Ops App", gets: "Bell ও Push: নতুন অর্ডার ও পিকআপ অনুরোধ (Ops manager ও ওই হাবের অপারেটর), SLA breach, রাইডারের ক্যাশ জমার অনুরোধ, Support ticket। স্টাফের কাছে SMS যায় না।" },
    { app: "Super admin", gets: "Bell: নতুন মার্চেন্ট রেজিস্ট্রেশন, KYC জমা, দ্বিতীয় অনুমোদনের অপেক্ষায় থাকা পরিবর্তন।" },
    { app: "Website গ্রাহক ও প্রাপক", gets: "অ্যাপ নেই, তাই শুধু SMS ও email। Delivery code শুধু SMS-এ; Collection code SMS ও email দুটোতেই।" },
  ],
  rules: [
    "চালু/বন্ধ: Super admin › **Parcel notifications** (পার্সেল) ও **Global notifications** (অন্যান্য)। প্রতিটি মেসেজে SMS, Email ও Push আলাদা সুইচ। SMS ও email-এর লেখা বদলানো যায়।",
    "কোড (Sign-up, Sign-in, Password reset, Delivery code, Collection code) কখনো Push বা Bell-এ যায় না। Collection code ছাড়া বাকি সব কোড শুধু SMS-এ যায়।",
    "মার্চেন্টের সার্ভিস প্যাকেজ ঠিক করে তাঁর পার্সেলে কোন SMS/email যাবে (Super admin › **Service plans & pricing**)।",
    "SMS যায় mram দিয়ে, email যায় Mailjet দিয়ে (Super admin › **SMS, Email & Push**)। সবাইকে একসাথে Push মেসেজও সেখান থেকে পাঠানো যায়।",
  ],
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
    actors: GUIDE_ACTORS,
    lifecycle: PARCEL_LIFECYCLE,
    notifications: NOTIFICATION_GUIDE,
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
