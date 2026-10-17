import { describe, expect, it } from "vitest";
import {
  DEFAULT_PACKAGE_PRICES,
  defaultServicesFor,
  normalizeDistrict,
  packageOptions,
  packagePricesSchema,
  packageProblems,
  parseLastMile,
  parseSpeedOption,
  priceParcel,
  proofMethodsFor,
  reattemptFeeFor,
  resolveSelection,
  routeProblems,
  routeTier,
  SEED_PRODUCTS,
  segmentOfMerchantType,
  type BookingSelection,
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
    expect(amount(priceParcel(p, { ...base, tier: "SAME_DISTRICT", selection: sel({ productType: "DOCUMENT" }) }), "product_type")).toBe(5);
    expect(priceParcel(p, { ...base, tier: "SAME_DISTRICT", selection: sel({ productType: "BOOKS" }) }).totalCharge).toBe(78);
  });
  it("0.5 kg is included; every started kg above costs extra", () => {
    const p = prices({ extraKg: 15 });
    expect(amount(priceParcel(p, { ...base, tier: "SAME_DISTRICT", selection: sel({ weightKg: 0.5 }) }), "weight")).toBeUndefined();
    expect(amount(priceParcel(p, { ...base, tier: "SAME_DISTRICT", selection: sel({ weightKg: 1 }) }), "weight")).toBe(15);
    expect(amount(priceParcel(p, { ...base, tier: "SAME_DISTRICT", selection: sel({ weightKg: 2.6 }) }), "weight")).toBe(45);
  });
  it("service, last mile (may be negative), first mile, open box, in order", () => {
    const p = prices({ sameDistrict: 70, expressFee: 40, hubPickupFee: -10, hubDropDiscount: 5, openBoxFee: 12, homeDeliveryFee: 3 });
    const r = priceParcel(p, { ...base, tier: "SAME_DISTRICT", selection: sel({ speed: "EXPRESS", lastMile: "HUB_COLLECT", firstMile: "HUB_DROP", openBox: true }) });
    expect(r.lines.map(l => [l.code, l.amount])).toEqual([
      ["route", 70],
      ["speed", 40],
      ["last_mile", -10],
      ["first_mile", -5],
      ["open_box", 12],
    ]);
    expect(r.totalCharge).toBe(107);
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
    const r = priceParcel(prices({ sameDistrict: 64.4, regularFee: 0.5 }), { ...base, tier: "SAME_DISTRICT", selection: sel() });
    expect(r.lines.map(l => l.amount)).toEqual([64, 1]);
  });
});

describe("pricing engine (Banking & Financial)", () => {
  const base = { segment: "BANKING_FINANCIAL" as const, services: BANK };
  const p = prices({ sameDistrict: 60, regularFee: 5, expressFee: 50, onDemandFee: 80, b2bRate: 10, tradeRate: 20, urgentRate: 70, typeDocument: 99, extraKg: 99 });
  it("no weight, no product-type, no COD", () => {
    const r = priceParcel(p, { ...base, tier: "SAME_DISTRICT", selection: sel({ weightKg: 9, productType: "DOCUMENT", codAmount: 1000 }) });
    expect(r.lines.map(l => l.code)).toEqual(["route", "speed"]);
    expect(r.totalCharge).toBe(65);
  });
  it("B2B / Trade add to Regular; Corporate Urgent without a speed fee; On-demand", () => {
    expect(priceParcel(p, { ...base, tier: "SAME_DISTRICT", selection: sel({ speed: "B2B" }) }).totalCharge).toBe(75);
    expect(priceParcel(p, { ...base, tier: "SAME_DISTRICT", selection: sel({ speed: "TRADE" }) }).totalCharge).toBe(85);
    const urgent = priceParcel(p, { ...base, tier: "DIFFERENT_DISTRICT", selection: sel({ speed: "URGENT" }) });
    expect(urgent.lines.map(l => l.code)).toEqual(["route", "handling"]);
    expect(urgent.totalCharge).toBe(130 + 70);
    expect(priceParcel(p, { ...base, tier: "SAME_DISTRICT", selection: sel({ speed: "ON_DEMAND" }) }).totalCharge).toBe(140);
  });
});

describe("selection rules", () => {
  it("defaults and SERVICE_NOT_IN_PACKAGE", () => {
    const r = resolveSelection("ECOMMERCE", ECOM, {});
    expect(r.problems).toEqual([]);
    expect(r.selection).toMatchObject({ firstMile: "RIDER_PICKUP", lastMile: "DOORSTEP", speed: "REGULAR", productType: "REGULAR" });
    expect(r.selection.notifications).not.toContain("notify.guest_verification");
    const noRider = ECOM.filter(s => s !== "first.rider_pickup" && s !== "last.doorstep");
    expect(resolveSelection("ECOMMERCE", noRider, {}).selection).toMatchObject({ firstMile: "HUB_DROP", lastMile: "HUB_COLLECT" });
    const bare = ECOM.filter(s => !["speed.express", "payment.cod", "option.open_box", "notify.delivered"].includes(s));
    expect(resolveSelection("ECOMMERCE", bare, { speed: "EXPRESS", codAmount: 10, openBox: true, notifications: ["notify.delivered"] }).problems.map(p => p.message)).toEqual([
      "SERVICE_NOT_IN_PACKAGE: Express",
      "SERVICE_NOT_IN_PACKAGE: Cash on delivery (COD)",
      "SERVICE_NOT_IN_PACKAGE: Open box / Check before pay",
      "SERVICE_NOT_IN_PACKAGE: Delivered (sender)",
    ]);
  });
  it("Banking: no COD, banking services only; Customer/E-com: no banking services", () => {
    expect(resolveSelection("BANKING_FINANCIAL", BANK, { codAmount: 100 }).problems[0].field).toBe("codAmount");
    expect(resolveSelection("ECOMMERCE", ECOM, { speed: "B2B" }).problems[0].code).toBe("INVALID");
    expect(packageOptions("BANKING_FINANCIAL", BANK)).toMatchObject({ speeds: ["REGULAR", "EXPRESS", "ON_DEMAND", "B2B", "TRADE", "URGENT"], cod: false, weight: false, openBox: false });
    expect(packageOptions("CUSTOMER", defaultServicesFor("CUSTOMER"))).toMatchObject({ speeds: ["REGULAR", "EXPRESS"], cod: true, openBox: false });
  });
  it("Express only inside the same district (Customer / E-com)", () => {
    expect(routeProblems("ECOMMERCE", "SAME_DISTRICT", "EXPRESS")).toEqual([]);
    expect(routeProblems("CUSTOMER", "DHAKA_SUBURBAN", "EXPRESS")[0].code).toBe("EXPRESS_SAME_DISTRICT_ONLY");
    expect(routeProblems("BANKING_FINANCIAL", "DIFFERENT_DISTRICT", "EXPRESS")).toEqual([]);
  });
  it("package problems, proofs, parsing", () => {
    expect(packageProblems("CUSTOMER", [...defaultServicesFor("CUSTOMER"), "integration.api"])[0]).toMatch(/API integration isn't offered/);
    expect(packageProblems("ECOMMERCE", ["last.doorstep"])).toEqual(["Choose at least one first-mile option", "Choose at least one delivery proof method"]);
    expect(proofMethodsFor(ECOM, ["notify.delivery_code"])).toEqual(["OTP", "SIGNATURE", "PHOTO"]);
    expect(proofMethodsFor(ECOM, [])).toEqual(["SIGNATURE", "PHOTO"]);
    expect(parseSpeedOption("Same day")).toBe("EXPRESS");
    expect(parseSpeedOption("corporate urgent document")).toBe("URGENT");
    expect(parseLastMile("Hub Pickup")).toBe("HUB_COLLECT");
    expect(segmentOfMerchantType("ECOMMERCE")).toBe("ECOMMERCE");
    expect(segmentOfMerchantType("BANKING_FINANCIAL")).toBe("BANKING_FINANCIAL");
  });
  it("seeded product lists", () => {
    expect(SEED_PRODUCTS.ECOMMERCE.REGULAR).toHaveLength(19);
    expect(SEED_PRODUCTS.BANKING_FINANCIAL.BOOKS).toEqual(["Cheque Books", "Passbooks"]);
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
