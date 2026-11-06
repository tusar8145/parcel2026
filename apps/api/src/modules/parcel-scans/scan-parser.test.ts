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

describe("tables read word by word (sparse OCR of a real photo: labels lost, values kept)", () => {
  it("finds the name by the phone, the unlabelled order code, the place and the lone amount", () => {
    // test/fixtures/scan/real-table.jpg, sparse-text OCR with rows rebuilt (rowsText).
    const text = "Individual Customer Sales D\nDummy parcel delivery customer records — Bang!\nSale 1 — CUS-1001\nRahim Uddin\n01800000476\nNot provided\nddress Mirpur-10 Dhaka\nLOU 850";
    expect(parseLabel(text, "ecommerce", { districts: ["Dhaka"], zonesByDistrict: { Dhaka: ["Mirpur"] }, areasByZone: { Mirpur: ["Mirpur 10"] } })).toMatchObject({
      recipient_name: "Rahim Uddin",
      recipient_phone: "01800000476",
      order_ref: "CUS-1001",
      cod_amount: "850",
      zone: "Mirpur",
      area: "Mirpur 10",
    });
  });

  it("a lone number is not an amount when it is a house number or a date", () => {
    expect(parseLabel("To: Karim\n01712345678\nHouse 12\n2026", "ecommerce", { districts: [], zonesByDistrict: {}, areasByZone: {} }).cod_amount).toBeUndefined();
  });
});

describe("a Delivery Fast sticker photographed with the phone (real OCR text)", () => {
  it("name without OCR specks, the address over two lines, the phone beside a stray digit, no guessed COD", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../test/fixtures/scan/catalog.json"), "utf8"));
    const [first, sparse] = fs.readFileSync(path.join(__dirname, "../../../test/fixtures/scan/label-df-sticker.txt"), "utf8").split("— read word by word —");
    const cells = parseLabel(first, "ecommerce", catalog);
    expect(cells).toMatchObject({ recipient_name: "Nusrat Jahan", recipient_phone: "01912334455", address: "Flat 4B, House 22, Road 7 Block C. Banani, Dhaka", district: "Dhaka North", zone: "Banani" });
    // "b 151,450 a" (৳1,450 misread): not taken as the amount; the merchant code is not an order number.
    expect(cells.cod_amount).toBeUndefined();
    expect(parseLabel(sparse, "ecommerce", catalog).order_ref).toBeUndefined();
  });
});

describe("a table photographed with the phone, its phone printed masked (real OCR text)", () => {
  it("finds the name in the row read across its columns", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../test/fixtures/scan/catalog.json"), "utf8"));
    const [first, sparse] = fs.readFileSync(path.join(__dirname, "../../../test/fixtures/scan/label-masked-table.txt"), "utf8").split("— read word by word —");
    const cells = { ...parseLabel(sparse, "ecommerce", catalog), ...parseLabel(first, "ecommerce", catalog) };
    expect(cells).toMatchObject({ recipient_name: "Sadia Akter", recipient_phone: "019***545", address: "House 125, Niketon, Block A, Gulshan, Dhaka", order_ref: "CUS-1004", district: "Dhaka North", zone: "Gulshan" });
  });

  it("a clearer photo of the same sheet: the name, and the masked phone kept as written", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../test/fixtures/scan/catalog.json"), "utf8"));
    const [first, sparse] = fs.readFileSync(path.join(__dirname, "../../../test/fixtures/scan/label-masked-table-2.txt"), "utf8").split("— read word by word —");
    const cells = { ...parseLabel(sparse, "ecommerce", catalog), ...parseLabel(first, "ecommerce", catalog) };
    expect(cells).toMatchObject({ recipient_name: "Sadia Akter", recipient_phone: "019***545", address: "House 125, Niketon, Block A, Gulshan, Dhaka", order_ref: "CUS-1004" });
  });
});
