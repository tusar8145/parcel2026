import { describe, expect, it } from "vitest";
import {
  DEFAULT_PACKAGE_PRICES,
  defaultServicesFor,
  normalizeDistrict,
  packageOptions,
  packagePricesSchema,
  packageProblems,
  findDeliveryType,
  parseLastMile,
  priceParcel,
  proofMethodsFor,
  reattemptFeeFor,
  resolveSelection,
  routeTier,
  SEED_CATALOG,
  segmentOfMerchantType,
  type BookingSelection,
  type DeliveryTypeDef,
  type PackagePrices,
} from "./packages";
import { allowedNextStatuses, canTransition } from "./parcel-status";

const prices = (p: Partial<PackagePrices> = {}): PackagePrices => packagePricesSchema.parse({ ...p });
const sel = (s: Partial<BookingSelection> = {}): BookingSelection => ({
  firstMile: "RIDER_PICKUP",
  lastMile: "DOORSTEP",
  speed: "REGULAR",
  productType: "REGULAR",
  openBox: false,
  codAmount: 0,
  weightKg: 0.5,
  notifications: [],
  ...s,
});
const ALL_SEGMENTS = ["CUSTOMER", "ECOMMERCE", "BANKING_FINANCIAL"] as const;
/** The seeded delivery types (the database's in the app). */
const DT: DeliveryTypeDef[] = [
  { code: "REGULAR", name: "Regular", segments: ALL_SEGMENTS, slaLevel: "REGULAR" },
  { code: "EXPRESS", name: "Express", segments: ALL_SEGMENTS, slaLevel: "EXPRESS" },
  { code: "FOUR_HOUR", name: "4 Hour Delivery", segments: ALL_SEGMENTS, slaLevel: "EXPRESS" },
  { code: "SAME_DAY", name: "Same Day Delivery", segments: ALL_SEGMENTS, slaLevel: "SAME_DAY" },
  { code: "NIGHT", name: "Night Delivery", segments: ["BANKING_FINANCIAL"], slaLevel: "REGULAR", active: false },
];
const ECOM = defaultServicesFor("ECOMMERCE");
const BANK = defaultServicesFor("BANKING_FINANCIAL");
const amount = (r: ReturnType<typeof priceParcel>, code: string) => r.lines.find(l => l.code === code)?.amount;

describe("route tiers (district only)", () => {
  it("normalises the Dhaka city districts", () => {
    expect(["Dhaka North", "Dhaka Central", " dhaka  south ", "Dhaka"].map(normalizeDistrict)).toEqual(["Dhaka", "Dhaka", "Dhaka", "Dhaka"]);
    expect(normalizeDistrict("Dhaka (Sub-urban)")).toBe("Dhaka (Sub-urban)");
  });
  it.each([
    ["Dhaka North", "Gazipur", "DHAKA_SUBURBAN"],
    ["Narayanganj", "Dhaka Central", "DHAKA_SUBURBAN"],
    ["Dhaka South", "Dhaka (Sub-urban)", "DHAKA_SUBURBAN"],
    ["Dhaka North", "Dhaka South", "SAME_DISTRICT"],
    ["Gazipur", "Gazipur", "SAME_DISTRICT"],
    ["Gazipur", "Narayanganj", "DIFFERENT_DISTRICT"],
    ["Dhaka Central", "Chattogram", "DIFFERENT_DISTRICT"],
    ["Dhaka (Sub-urban)", "Gazipur", "DIFFERENT_DISTRICT"],
  ] as const)("%s → %s = %s", (a, b, tier) => expect(routeTier(a, b)).toBe(tier));
});

describe("pricing engine (Customer & E-commerce)", () => {
  const base = { segment: "ECOMMERCE" as const, services: ECOM };
  it("route prices from the defaults", () => {
    expect(priceParcel(DEFAULT_PACKAGE_PRICES, { ...base, tier: "SAME_DISTRICT", selection: sel() }).totalCharge).toBe(70);
    expect(priceParcel(DEFAULT_PACKAGE_PRICES, { ...base, tier: "DHAKA_SUBURBAN", selection: sel() }).totalCharge).toBe(100);
    expect(priceParcel(DEFAULT_PACKAGE_PRICES, { ...base, tier: "DIFFERENT_DISTRICT", selection: sel() }).totalCharge).toBe(130);
  });
  it("adds the product type charge", () => {
    const p = prices({ typeDocument: 5, typeBooks: 8 });
    // E-commerce: one route line with what is sent added; Customer: its own line.
    const doc = priceParcel(p, { ...base, segment: "ECOMMERCE", tier: "SAME_DISTRICT", selection: sel({ productType: "DOCUMENT" }) });
    expect(doc.lines[0]).toEqual({ code: "route", label: "Inside same district + Document", amount: (amount(priceParcel(p, { ...base, segment: "ECOMMERCE", tier: "SAME_DISTRICT", selection: sel() }), "route") ?? 0) + 5 });
    expect(amount(doc, "product_type")).toBeUndefined();
    expect(amount(priceParcel(p, { ...base, segment: "CUSTOMER", tier: "SAME_DISTRICT", selection: sel({ productType: "DOCUMENT" }) }), "product_type")).toBe(5);
    expect(priceParcel(p, { ...base, tier: "SAME_DISTRICT", selection: sel({ productType: "BOOKS" }) }).totalCharge).toBe(78);
  });
  it("0.5 kg is included; every started kg above costs extra", () => {
    const p = prices({ extraKg: 15 });
    expect(amount(priceParcel(p, { ...base, tier: "SAME_DISTRICT", selection: sel({ weightKg: 0.5 }) }), "weight")).toBeUndefined();
    expect(amount(priceParcel(p, { ...base, tier: "SAME_DISTRICT", selection: sel({ weightKg: 1 }) }), "weight")).toBe(15);
    expect(amount(priceParcel(p, { ...base, tier: "SAME_DISTRICT", selection: sel({ weightKg: 2.6 }) }), "weight")).toBe(45);
  });
  it("service, last mile (may be negative), first mile, open box, in order", () => {
    const p = prices({ sameDistrict: 70, deliveryFees: { EXPRESS: 40 }, hubPickupFee: -10, hubDropDiscount: 5, openBoxFee: 12, homeDeliveryFee: 3 });
    const r = priceParcel(p, { ...base, tier: "SAME_DISTRICT", deliveryTypeName: "Express", selection: sel({ speed: "EXPRESS", lastMile: "HUB_COLLECT", firstMile: "HUB_DROP", openBox: true }) });
    expect(r.lines.map(l => [l.code, l.amount])).toEqual([
      ["route", 70],
      ["speed", 40],
      ["last_mile", -10],
      ["first_mile", -5],
      ["open_box", 12],
    ]);
    expect(r.totalCharge).toBe(107);
    expect(r.lines.find(l => l.code === "speed")!.label).toBe("Express");
    expect(amount(priceParcel(p, { ...base, tier: "SAME_DISTRICT", selection: sel() }), "last_mile")).toBe(3);
    expect(priceParcel(prices({ onDemandPickupFee: 25 }), { ...base, tier: "SAME_DISTRICT", selection: sel({ firstMile: "ON_DEMAND_PICKUP" }) }).totalCharge).toBe(95);
  });
  it("COD fee: % rounded up, with a minimum", () => {
    expect(priceParcel(DEFAULT_PACKAGE_PRICES, { ...base, tier: "SAME_DISTRICT", selection: sel({ codAmount: 500 }) }).codFee).toBe(10);
    expect(priceParcel(DEFAULT_PACKAGE_PRICES, { ...base, tier: "SAME_DISTRICT", selection: sel({ codAmount: 2501 }) }).codFee).toBe(26);
  });
  it("never below zero; the floor line explains it", () => {
    const r = priceParcel(prices({ sameDistrict: 20, hubPickupFee: -30 }), { ...base, tier: "SAME_DISTRICT", selection: sel({ lastMile: "HUB_COLLECT", codAmount: 100 }) });
    expect(r.deliveryCharge).toBe(0);
    expect(amount(r, "floor")).toBe(10);
    expect(r.totalCharge).toBe(10);
    const c = r.columns;
    expect(c.baseCharge + c.weightCharge + c.serviceCharge + c.codFee - c.discount).toBe(r.totalCharge);
  });
  it("rounds every line to whole taka", () => {
    const r = priceParcel(prices({ sameDistrict: 64.4, deliveryFees: { REGULAR: 0.5 } }), { ...base, tier: "SAME_DISTRICT", selection: sel() });
    expect(r.lines.map(l => l.amount)).toEqual([64, 1]);
  });
});

describe("pricing engine (Banking & Financial)", () => {
  const base = { segment: "BANKING_FINANCIAL" as const, services: BANK };
  const p = prices({ sameDistrict: 60, deliveryFees: { REGULAR: 5, EXPRESS: 50, FOUR_HOUR: 120, SAME_DAY: 80 }, typeDocument: 99, extraKg: 99 });
  it("no weight, no product-type, no COD", () => {
    const r = priceParcel(p, { ...base, tier: "SAME_DISTRICT", selection: sel({ weightKg: 9, productType: "DOCUMENT", codAmount: 1000 }) });
    expect(r.lines.map(l => l.code)).toEqual(["route", "speed"]);
    expect(r.totalCharge).toBe(65);
  });
  it("each delivery type adds its own + charge; a type without one adds 0", () => {
    expect(priceParcel(p, { ...base, tier: "SAME_DISTRICT", selection: sel({ speed: "FOUR_HOUR" }) }).totalCharge).toBe(180);
    expect(priceParcel(p, { ...base, tier: "DIFFERENT_DISTRICT", selection: sel({ speed: "SAME_DAY" }) }).totalCharge).toBe(130 + 80);
    expect(priceParcel(p, { ...base, tier: "SAME_DISTRICT", selection: sel({ speed: "NIGHT" }) }).totalCharge).toBe(60);
  });
});

describe("selection rules", () => {
  it("defaults and SERVICE_NOT_IN_PACKAGE", () => {
    const r = resolveSelection("ECOMMERCE", ECOM, {}, DT);
    expect(r.problems).toEqual([]);
    expect(r.selection).toMatchObject({ firstMile: "RIDER_PICKUP", lastMile: "DOORSTEP", speed: "REGULAR", productType: "REGULAR" });
    expect(r.selection.notifications).not.toContain("notify.guest_verification");
    const noRider = ECOM.filter(s => s !== "first.rider_pickup" && s !== "last.doorstep");
    expect(resolveSelection("ECOMMERCE", noRider, {}, DT).selection).toMatchObject({ firstMile: "HUB_DROP", lastMile: "HUB_COLLECT" });
    const bare = ECOM.filter(s => !["payment.cod", "option.open_box", "notify.delivered"].includes(s));
    expect(resolveSelection("ECOMMERCE", bare, { speed: "EXPRESS", codAmount: 10, openBox: true, notifications: ["notify.delivered"] }, DT).problems.map(p => p.message)).toEqual([
      "SERVICE_NOT_IN_PACKAGE: Cash on delivery (COD)",
      "SERVICE_NOT_IN_PACKAGE: Open box / Check before pay",
      "SERVICE_NOT_IN_PACKAGE: Delivered (sender)",
    ]);
  });
  it("Banking: no COD; delivery types: active ones of the category, by code or name, on any route", () => {
    expect(resolveSelection("BANKING_FINANCIAL", BANK, { codAmount: 100 }, DT).problems[0].field).toBe("codAmount");
    expect(resolveSelection("ECOMMERCE", ECOM, { speed: "4 hour" }, DT).selection.speed).toBe("FOUR_HOUR");
    expect(resolveSelection("CUSTOMER", defaultServicesFor("CUSTOMER"), { speed: "Same day delivery" }, DT)).toMatchObject({ problems: [], selection: { speed: "SAME_DAY" } });
    // Unknown, inactive, or not for the category.
    expect(resolveSelection("ECOMMERCE", ECOM, { speed: "B2B" }, DT).problems[0]).toMatchObject({ field: "speed", code: "INVALID" });
    expect(resolveSelection("BANKING_FINANCIAL", BANK, { speed: "NIGHT" }, DT).problems[0].code).toBe("INVALID");
    expect(packageOptions("BANKING_FINANCIAL", BANK, DT)).toMatchObject({ speeds: ["REGULAR", "EXPRESS", "FOUR_HOUR", "SAME_DAY"], cod: false, weight: false, openBox: false });
    expect(packageOptions("CUSTOMER", defaultServicesFor("CUSTOMER"), DT)).toMatchObject({
      cod: true,
      openBox: false,
      deliveryTypes: [
        { code: "REGULAR", name: "Regular" },
        { code: "EXPRESS", name: "Express" },
        { code: "FOUR_HOUR", name: "4 Hour Delivery" },
        { code: "SAME_DAY", name: "Same Day Delivery" },
      ],
    });
  });
  it("package problems, proofs, parsing", () => {
    expect(packageProblems("CUSTOMER", [...defaultServicesFor("CUSTOMER"), "integration.api"])[0]).toMatch(/API integration isn't offered/);
    expect(packageProblems("ECOMMERCE", ["last.doorstep"])).toEqual(["Choose at least one first-mile option", "Choose at least one delivery proof method"]);
    expect(proofMethodsFor(ECOM, ["notify.delivery_code"])).toEqual(["OTP", "SIGNATURE", "PHOTO"]);
    expect(proofMethodsFor(ECOM, [])).toEqual(["SIGNATURE", "PHOTO"]);
    expect(findDeliveryType("Same day", DT)?.code).toBe("SAME_DAY");
    expect(findDeliveryType("EXPRESS", DT)?.code).toBe("EXPRESS");
    expect(findDeliveryType("four_hour", DT)?.code).toBe("FOUR_HOUR");
    expect(findDeliveryType("corporate urgent document", DT)).toBeUndefined();
    expect(parseLastMile("Hub Pickup")).toBe("HUB_COLLECT");
    expect(segmentOfMerchantType("ECOMMERCE")).toBe("ECOMMERCE");
    expect(segmentOfMerchantType("BANKING_FINANCIAL")).toBe("BANKING_FINANCIAL");
  });
  it("seeded catalog: few categories, no duplicate product, at most 100 e-commerce products", () => {
    for (const list of [SEED_CATALOG.ECOMMERCE, SEED_CATALOG.BANKING_FINANCIAL]) {
      const names = list.flatMap(c => c.products.map(([n]) => n.toLowerCase()));
      expect(new Set(names).size).toBe(names.length);
      expect(list.length).toBeLessThanOrEqual(10);
    }
    expect(SEED_CATALOG.ECOMMERCE.flatMap(c => c.products).length).toBeLessThanOrEqual(100);
    expect(SEED_CATALOG.BANKING_FINANCIAL.find(c => c.name === "Cheque Book & Passbook")!.products.map(([n]) => n)).toContain("Cheque Book");
  });
  it("re-attempt fees after the free ones", () => {
    expect([1, 2, 3].map(n => reattemptFeeFor(prices({ freeReattempts: 2, reattemptFee: 25 }), n))).toEqual([0, 0, 25]);
  });
});

describe("Hub Pickup lifecycle", () => {
  const collect = { lastMile: "HUB_COLLECT" };
  it("ready for collection, handed over by the hub, no delivery rider", () => {
    expect(canTransition("AT_HUB", "READY_FOR_COLLECTION", "ops", collect)).toBe(true);
    expect(canTransition("AT_HUB", "READY_FOR_COLLECTION", "ops")).toBe(false);
    expect(canTransition("READY_FOR_COLLECTION", "DELIVERED", "ops", collect)).toBe(true);
    expect(allowedNextStatuses("AT_HUB", "ops", collect)).not.toContain("ASSIGNED");
    expect(canTransition("PICKED_UP", "OUT_FOR_DELIVERY", "rider", collect)).toBe(false);
  });
});
