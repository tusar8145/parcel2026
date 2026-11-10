import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fromClaude } from "./scan-claude";

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../test/fixtures/scan/catalog.json"), "utf8"));

describe("Claude's reading of a label is checked for form", () => {
  it("keeps every field of a clean reading and matches places to the catalog", () => {
    const cells = fromClaude(
      {
        recipient_name: "Tanvir Hasan",
        recipient_phone: "+880 1555-123456",
        address: "House 9, Sector 7, Uttara",
        district: "Dhaka",
        zone: "Uttara",
        area: null,
        product_type: "Women's Shoes",
        cod_amount: "2,300",
        declared_value: null,
        weight_kg: "1.5",
        service_level: "express",
        open_box: "yes",
        order_ref: "ORD-1001",
        instructions: "Call before delivery",
      },
      "ecommerce",
      catalog,
    );
    expect(cells).toMatchObject({
      recipient_name: "Tanvir Hasan",
      recipient_phone: "01555123456",
      address: "House 9, Sector 7, Uttara",
      district: "Dhaka North",
      zone: "Uttara",
      product_type: "Women's Shoes",
      cod_amount: "2300",
      weight_kg: "1.5",
      service_level: "Express",
      open_box: "Yes",
      order_ref: "ORD-1001",
      instructions: "Call before delivery",
    });
  });

  it("drops values of the wrong form", () => {
    const cells = fromClaude({ recipient_name: "01712345678 Karim", recipient_phone: "12345", cod_amount: "abc", weight_kg: "900", service_level: "Same day", order_ref: "N/A" }, "ecommerce", catalog);
    expect(cells).toEqual({});
  });

  it("leaves out columns the template doesn't have (no COD or weight on Banking & Financial)", () => {
    const cells = fromClaude({ recipient_name: "Mahir Chowdhury", recipient_phone: "01712345678", cod_amount: "500", weight_kg: "1", sender_name: "City Bank" }, "document", catalog);
    expect(cells).toEqual({ recipient_name: "Mahir Chowdhury", recipient_phone: "01712345678" });
  });

  it("reads the pickup place of a customer parcel", () => {
    const cells = fromClaude({ sender_name: "Rafiq", sender_phone: "01812345678", pickup_address: "Road 7, Dhanmondi", pickup_zone: "Dhanmondi", pickup_district: "Dhaka", recipient_phone: "01812345678" }, "customer", catalog);
    expect(cells).toMatchObject({ sender_name: "Rafiq", pickup_zone: "Dhanmondi", recipient_phone: "01812345678" });
    expect(cells.pickup_district).toMatch(/^Dhaka/);
    // The same number for both: it is the recipient's.
    expect(cells.sender_phone).toBeUndefined();
  });
});
