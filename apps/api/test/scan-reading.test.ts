import fs from "node:fs";
import path from "node:path";
import { ScanReaderService } from "../src/modules/parcel-scans/scan-reader";
import { parseLabel } from "../src/modules/parcel-scans/scan-parser";

/**
 * Photo → fields on real OCR (tesseract on this machine), for the label shapes seen in practice:
 * sideways / upside-down / tilted photos, taka amounts with commas (৳ read as "$5"), Bangla labels and
 * sender | receiver stickers. The catalog is a snapshot of the seeded Bangladesh geography.
 */
const dir = path.join(__dirname, "fixtures", "scan");
const catalog = JSON.parse(fs.readFileSync(path.join(dir, "catalog.json"), "utf8"));
const shopBari = {
  recipient_name: "Rahim Uddin",
  recipient_phone: "01712345678",
  address: "House 12, Road 5, Dhanmondi, Dhaka",
  district: "Dhaka Central",
  zone: "Dhanmondi",
  cod_amount: "1250",
  weight_kg: "1.5",
  order_ref: "INV-2045",
  instructions: "Call before delivery",
};
const fashionHub = {
  recipient_name: "Nusrat Jahan",
  recipient_phone: "01912334455",
  address: "Flat 4B, House 22, Road 7, Block C, Banani, Dhaka",
  district: "Dhaka North",
  zone: "Banani",
  area: "Banani",
  cod_amount: "1450",
  weight_kg: "0.5",
  order_ref: "SB-77821",
};
const CASES: [string, "ecommerce" | "customer", Record<string, string>][] = [
  ["../scan-label.png", "ecommerce", shopBari],
  ["rotated-90.png", "ecommerce", shopBari],
  ["rotated-180.png", "ecommerce", shopBari],
  ["skewed.jpg", "ecommerce", shopBari],
  ["taka.png", "ecommerce", fashionHub],
  ["taka-270.png", "ecommerce", fashionHub],
  ["bangla.png", "ecommerce", { recipient_name: "সুমন আহমেদ", recipient_phone: "01711223344", cod_amount: "850", district: "Dhaka Central", zone: "Mirpur", area: "Mirpur 10", instructions: "বিকেলে দিবেন" }],
  [
    "columns.png",
    "customer",
    { sender_name: "Gadget Ghor", sender_phone: "01811000222", recipient_name: "Tanvir Hasan", recipient_phone: "01555123456", address: "House 9, Sector 7, Uttara, Dhaka", district: "Dhaka North", zone: "Uttara", cod_amount: "2300", weight_kg: "1.2", order_ref: "GG-5521" },
  ],
];

describe("reading parcel photos", () => {
  const reader = new ScanReaderService();
  afterAll(() => reader.onModuleDestroy());

  it.each(CASES)("%s", async (file, kind, expected) => {
    const read = await reader.read(fs.readFileSync(path.join(dir, file)));
    expect(read.confidence, read.text).toBeGreaterThan(80);
    expect(parseLabel(read.text, kind, catalog), read.text).toMatchObject(expected);
  }, 60_000);
});
