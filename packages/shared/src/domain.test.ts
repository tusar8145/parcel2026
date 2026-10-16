import { describe, expect, it } from "vitest";
import { allowedNextStatuses, canTransition, INTAKE_CHANGEABLE_STATUSES, parcelStatusLabel, parseParcelStatus, PARCEL_STATUSES, TERMINAL_STATUSES } from "./parcel-status";
import { applyRateOverride, DEFAULT_RATE_CARD, quoteParcel, rateCardConfigSchema } from "./pricing";
import { bdPhoneProblem, isBdMobile, normalizeBdPhone } from "./phone";
import { createParcelSchema } from "./schemas/parcel";

describe("pricing", () => {
  const base = { pickupDistrict: "Dhaka North", pickupZone: "Gulshan", deliveryDistrict: "Dhaka North", deliveryZone: "Gulshan", weightKg: 1, serviceLevel: "REGULAR" as const, codAmount: 0 };

  it("charges the same-zone rate inside one zone", () => {
    expect(quoteParcel(DEFAULT_RATE_CARD, base)).toMatchObject({ sameZone: true, baseCharge: 70, weightCharge: 0, totalCharge: 70 });
  });

  it("matches the original website formula", () => {
    const q = quoteParcel(DEFAULT_RATE_CARD, { ...base, deliveryDistrict: "Dhaka Central", deliveryZone: "Dhanmondi", weightKg: 2, serviceLevel: "SAME_DAY", codAmount: 1500 });
    expect(q).toMatchObject({ baseCharge: 120, weightCharge: 20, serviceCharge: 30, codFee: 15, totalCharge: 185 });
  });

  it("charges every started kg above the included weight and rounds COD fees up", () => {
    expect(quoteParcel(DEFAULT_RATE_CARD, { ...base, weightKg: 2.1 }).weightCharge).toBe(40);
    expect(quoteParcel(DEFAULT_RATE_CARD, { ...base, weightKg: 0.5 }).weightCharge).toBe(0);
    expect(quoteParcel(DEFAULT_RATE_CARD, { ...base, codAmount: 101 }).codFee).toBe(2);
  });

  it("prices document parcels by document type and leaves other parcels unchanged", () => {
    const card = rateCardConfigSchema.parse({ sameZone: 60, crossZone: 100, documentTypeRates: { "B2B Document": 65, "Corporate Urgent Document": 120 } });
    expect(quoteParcel(card, { ...base, parcelType: "DOCUMENT", documentType: "b2b document" })).toMatchObject({ baseCharge: 65, documentType: "B2B Document", totalCharge: 65 });
    const cross = { ...base, deliveryDistrict: "Dhaka Central", deliveryZone: "Dhanmondi", parcelType: "DOCUMENT", documentType: "Corporate Urgent Document" };
    expect(quoteParcel(card, cross).baseCharge).toBe(160); // 120 + (100 − 60)
    expect(quoteParcel(card, { ...base, parcelType: "DOCUMENT", documentType: "Unknown" }).baseCharge).toBe(60);
    expect(quoteParcel(card, { ...base, parcelType: "PARCEL", documentType: "B2B Document" }).baseCharge).toBe(60);
    expect(quoteParcel(DEFAULT_RATE_CARD, base)).not.toHaveProperty("documentType");
  });

  it("applies merchant overrides on top of the segment card", () => {
    const card = applyRateOverride(rateCardConfigSchema.parse({ documentTypeRates: { A: 10, B: 20 } }), { sameZone: 50, serviceFees: { EXPRESS: 90 }, documentTypeRates: { B: 25 } });
    expect(card).toMatchObject({ sameZone: 50, crossZone: 120, serviceFees: { REGULAR: 0, SAME_DAY: 30, EXPRESS: 90 }, documentTypeRates: { A: 10, B: 25 } });
  });

  it("applies plan discounts to the delivery charge, not the COD fee", () => {
    const q = quoteParcel(DEFAULT_RATE_CARD, { ...base, codAmount: 1000, discountPercent: 10 });
    expect(q).toMatchObject({ discount: 7, codFee: 10, totalCharge: 73 });
  });
});

describe("parcel lifecycle", () => {
  it("has no way out of terminal statuses", () => {
    for (const status of TERMINAL_STATUSES) for (const actor of ["ops", "rider", "owner"] as const) expect(allowedNextStatuses(status, actor)).toEqual([]);
  });

  it("lets only riders mark parcels delivered", () => {
    for (const from of PARCEL_STATUSES) {
      expect(canTransition(from, "DELIVERED", "ops")).toBe(false);
      expect(canTransition(from, "DELIVERED", "owner")).toBe(false);
    }
    expect(canTransition("OUT_FOR_DELIVERY", "DELIVERED", "rider")).toBe(true);
  });

  it("lets owners cancel only while pending", () => {
    expect(canTransition("PENDING_CONFIRMATION", "PICKUP_CANCELLED", "owner")).toBe(true);
    expect(canTransition("PICKUP_ASSIGNED", "PICKUP_CANCELLED", "owner")).toBe(false);
  });

  it("lets operations receive drop-off parcels at a hub without a pickup rider", () => {
    expect(canTransition("PENDING_CONFIRMATION", "AT_HUB", "ops", { intake: "DROP_OFF" })).toBe(true);
    // Rider pickups still need a pickup rider first.
    expect(canTransition("PENDING_CONFIRMATION", "AT_HUB", "ops")).toBe(false);
    expect(canTransition("PENDING_CONFIRMATION", "AT_HUB", "ops", { intake: "PICKUP" })).toBe(false);
    // Only operations receive at a hub; owners and riders can't.
    expect(canTransition("PENDING_CONFIRMATION", "AT_HUB", "owner", { intake: "DROP_OFF" })).toBe(false);
    expect(canTransition("PENDING_CONFIRMATION", "AT_HUB", "rider", { intake: "DROP_OFF" })).toBe(false);
    // A drop-off never waits for a pickup rider, but can still be cancelled or flagged.
    expect(canTransition("PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "ops", { intake: "DROP_OFF" })).toBe(false);
    expect(canTransition("PENDING_CONFIRMATION", "PICKUP_CANCELLED", "ops", { intake: "DROP_OFF" })).toBe(true);
    expect(canTransition("PENDING_CONFIRMATION", "PICKUP_CANCELLED", "owner", { intake: "DROP_OFF" })).toBe(true);
    expect(canTransition("PENDING_CONFIRMATION", "EXCEPTION", "ops", { intake: "DROP_OFF" })).toBe(true);
    expect(allowedNextStatuses("PENDING_CONFIRMATION", "ops", { intake: "DROP_OFF" })).toEqual(["AT_HUB", "PICKUP_CANCELLED", "EXCEPTION"]);
    // After receipt, drop-off parcels follow the normal lifecycle.
    for (const from of PARCEL_STATUSES.filter(s => s !== "PENDING_CONFIRMATION"))
      for (const actor of ["ops", "rider", "owner"] as const) expect(allowedNextStatuses(from, actor, { intake: "DROP_OFF" })).toEqual(allowedNextStatuses(from, actor));
  });

  it("lets operations release a pickup assignment only when switching the parcel to drop-off", () => {
    for (const from of ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED"] as const) {
      expect(canTransition(from, "PENDING_CONFIRMATION", "ops", { intakeChange: true })).toBe(true);
      expect(canTransition(from, "PENDING_CONFIRMATION", "ops")).toBe(false);
      expect(canTransition(from, "PENDING_CONFIRMATION", "rider", { intakeChange: true })).toBe(false);
      expect(canTransition(from, "PENDING_CONFIRMATION", "owner", { intakeChange: true })).toBe(false);
    }
    expect(canTransition("PICKED_UP", "PENDING_CONFIRMATION", "ops", { intakeChange: true })).toBe(false);
    expect(INTAKE_CHANGEABLE_STATUSES).toEqual(["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED"]);
  });

  it("labels drop-off parcels waiting for the sender", () => {
    expect(parcelStatusLabel("PENDING_CONFIRMATION", { intake: "DROP_OFF", dropOffHubName: "Gulshan Hub" })).toBe("Awaiting drop-off at Gulshan Hub");
    expect(parcelStatusLabel("PENDING_CONFIRMATION", { intake: "DROP_OFF" })).toBe("Awaiting drop-off");
    expect(parcelStatusLabel("PENDING_CONFIRMATION", { intake: "PICKUP", dropOffHubName: null })).toBe("Pending operations confirmation");
    expect(parcelStatusLabel("AT_HUB", { intake: "DROP_OFF", dropOffHubName: "Gulshan Hub" })).toBe("At hub");
  });

  it("parses UI labels and old aliases", () => {
    expect(parseParcelStatus("At hub")).toBe("AT_HUB");
    expect(parseParcelStatus("pickup requested")).toBe("PENDING_CONFIRMATION");
    expect(parseParcelStatus("IN_TRANSIT")).toBe("IN_TRANSIT");
    expect(parseParcelStatus("Awaiting drop-off at Gulshan Hub")).toBe("PENDING_CONFIRMATION");
    expect(parseParcelStatus("Lost")).toBeUndefined();
  });
});

describe("phones and booking input", () => {
  it("normalises Bangladeshi mobile numbers", () => {
    expect(normalizeBdPhone("01712-345678")).toBe("+8801712345678");
    expect(normalizeBdPhone("+8801712345678")).toBe("+8801712345678");
    expect(isBdMobile("01212345678")).toBe(false);
    expect(normalizeBdPhone("1712345678")).toBe("+8801712345678");
    expect(normalizeBdPhone("8801712345678")).toBe("+8801712345678");
    expect(normalizeBdPhone("+880 1712-345678")).toBe("+8801712345678");
    expect(isBdMobile("171234567")).toBe(false);
    expect(bdPhoneProblem("1712345678")).toBeUndefined();
    expect(bdPhoneProblem("171234")).toMatch(/10 digits/);
    expect(bdPhoneProblem("2712345678")).toMatch(/start with 1/);
  });

  it("accepts the website's labels for categories and service levels", () => {
    const parsed = createParcelSchema.parse({
      sender: { name: "A B", phone: "01712345678" },
      pickup: { category: "Office", street: "Road 1", zone: "Gulshan", district: "Dhaka North" },
      recipient: { name: "C D", phone: "01812345678" },
      delivery: { street: "Road 2", zone: "Banani", district: "Dhaka North" },
      serviceLevel: "Same day",
      weightKg: "2",
    });
    expect(parsed).toMatchObject({ serviceLevel: "SAME_DAY", weightKg: 2, codAmount: 0, pickup: { category: "OFFICE" }, delivery: { category: "HOME" } });
  });
});
