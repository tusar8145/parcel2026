import { describe, expect, it } from "vitest";
import { parseLabel, phonesIn } from "./scan-parser";

const catalog = {
  districts: ["Dhaka", "Chattogram", "Gazipur"],
  zonesByDistrict: { Dhaka: ["Dhanmondi", "Mirpur", "Gulshan"], Chattogram: ["Agrabad"], Gazipur: ["Tongi"] },
  areasByZone: { Dhanmondi: ["Road 27", "Shankar"], Mirpur: ["Mirpur 10"], Agrabad: ["Commerce College"] },
};

describe("scan parser", () => {
  it("reads a printed label (tesseract output of test/fixtures/scan-label.png)", () => {
    const text = `Shop Bari - Order #INV-2045

To: Rahim Uddin

Phone: 01712-345678

Address: House 12, Road 5, Dhanmondi, Dhaka
COD: 1,250 Tk

Weight: 1.5 kg

Note: Call before delivery

From: Shop Bari, 01811-000222`;
    expect(parseLabel(text, "ecommerce", catalog)).toEqual({
      recipient_name: "Rahim Uddin",
      recipient_phone: "01712345678",
      address: "House 12, Road 5, Dhanmondi, Dhaka",
      district: "Dhaka",
      zone: "Dhanmondi",
      cod_amount: "1250",
      weight_kg: "1.5",
      order_ref: "INV-2045",
      instructions: "Call before delivery",
    });
  });

  it("keeps the sender of a customer parcel apart from the recipient", () => {
    const cells = parseLabel("From: Karim Store, 01811 000222\nTo: Nusrat Jahan, 01912-334455\nHouse 4, Agrabad, Chattogram", "customer", catalog);
    expect(cells).toMatchObject({ sender_name: "Karim Store", sender_phone: "01811000222", recipient_name: "Nusrat Jahan", recipient_phone: "01912334455", district: "Chattogram", zone: "Agrabad" });
  });

  it("reads Bangla labels and digits", () => {
    const cells = parseLabel("প্রাপক: সুমন আহমেদ\nমোবাইল: ০১৭১১-২২৩৩৪৪\nঠিকানা: বাসা ৭, রোড ২, Mirpur 10, Mirpur\nটাকা: ৮৫০", "ecommerce", catalog);
    expect(cells).toMatchObject({ recipient_name: "সুমন আহমেদ", recipient_phone: "01711223344", cod_amount: "850", district: "Dhaka", zone: "Mirpur", area: "Mirpur 10" });
    expect(cells.address).toContain("Mirpur 10");
  });

  it("finds an unlabelled name and address next to the phone", () => {
    const cells = parseLabel("Tanvir Hasan\n+8801555123456\nFlat 3B, Road 11, Gulshan 2\nDhaka", "ecommerce", catalog);
    expect(cells).toMatchObject({ recipient_name: "Tanvir Hasan", recipient_phone: "01555123456", district: "Dhaka", zone: "Gulshan" });
    expect(cells.address).toContain("Road 11");
  });

  it("leaves out columns the template doesn't have (Banking & Financial: no COD)", () => {
    const cells = parseLabel("To: Bank Branch Manager\n01712345678\nCOD: 500", "document", catalog);
    expect(cells.cod_amount).toBeUndefined();
    expect(cells.recipient_phone).toBe("01712345678");
  });

  it("recognises phone formats and ignores other numbers", () => {
    expect(phonesIn("Call 017-1234-5678 or +880 1812 345678")).toEqual(["01712345678", "01812345678"]);
    expect(phonesIn("Order 20451234567890 · weight 2 kg")).toEqual([]);
  });
});
