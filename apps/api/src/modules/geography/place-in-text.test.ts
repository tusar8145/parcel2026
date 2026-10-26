import { describe, expect, it } from "vitest";
import { placeIn } from "./place-in-text";

const places = {
  districts: ["Dhaka North", "Dhaka Central"],
  zonesByDistrict: { "Dhaka North": ["Vatara", "Banani"], "Dhaka Central": ["Dhanmondi"] },
  areasByZone: { Vatara: ["Bashundhara R/A", "Nadda"], Banani: ["Banani"], Dhanmondi: ["Dhanmondi R/A"] },
};

describe("placeIn: R/A and Residential Area", () => {
  it.each([
    "Bashundhara residential area, F block, House 12, Road 15",
    "House 3, Bashundhara R/A, Dhaka",
    "House 3, Road 2, Bashundhara",
    "বসুন্ধরা আবাসিক এলাকা",
  ])("%s → Vatara, Bashundhara R/A", (text: string) => {
    expect(placeIn(text, places)).toEqual({ district: "Dhaka North", zone: "Vatara", area: "Bashundhara R/A" });
  });
  it("keeps other places as they were", () => {
    expect(placeIn("House 7, Road 11, Banani, Dhaka", places)).toEqual({ district: "Dhaka North", zone: "Banani", area: "Banani" });
  });
});
