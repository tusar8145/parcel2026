import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeAi } from "./scan-ai";
import { parseLabel } from "./scan-parser";

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../test/fixtures/scan/catalog.json"), "utf8"));

describe("label AI answers are checked against the label", () => {
  // Two blocks the rules can't tell apart: no To / From words.
  const text = `Gadget Ghor 01811-000222
Elephant Road
Deliver: Tanvir Hasan 01555-123456
House 9, Sector 7, Uttara
Payable 2,300`;

  it("takes the model's reading when the label supports it", () => {
    const rules = parseLabel(text, "ecommerce", catalog);
    const merged = mergeAi(rules, { recipient_name: "Tanvir Hasan", recipient_phone: "01555123456", address: "House 9, Sector 7, Uttara", zone: "Uttara", district: "Dhaka", cod_amount: "2300", sender_name: "Gadget Ghor" }, text, "ecommerce", catalog);
    expect(merged).toMatchObject({ recipient_name: "Tanvir Hasan", recipient_phone: "01555123456", address: "House 9, Sector 7, Uttara", district: "Dhaka North", zone: "Uttara", cod_amount: "2300" });
  });

  it("drops what isn't on the label: invented phone, name, amount, reference", () => {
    const merged = mergeAi({}, { recipient_name: "Karim Mia", recipient_phone: "01999888777", cod_amount: "5000", order_ref: "XYZ-1", weight_kg: "2" }, text, "ecommerce", catalog);
    expect(merged.recipient_name).toBeUndefined();
    expect(merged.recipient_phone).toBeUndefined();
    expect(merged.cod_amount).toBeUndefined();
    expect(merged.order_ref).toBeUndefined();
    expect(merged.weight_kg).toBeUndefined();
  });

  it("forgives OCR slips in names and maps Bangla places to the catalog", () => {
    const ocr = "প্রাপক: সুমন আহমেদ\nঠিকানা: বাসা 7, রোড 2, মিরপুর 10, ঢাকা\nRahim Uddln 01712345678";
    const merged = mergeAi({}, { recipient_name: "Rahim Uddin", recipient_phone: "01712345678", zone: "মিরপুর", area: "মিরপুর 10" }, ocr, "ecommerce", catalog);
    expect(merged).toMatchObject({ recipient_name: "Rahim Uddin", recipient_phone: "01712345678", district: "Dhaka Central", zone: "Mirpur", area: "Mirpur 10" });
  });

  it("labels without To / From: the model picks the recipient, not the shop on the first line", () => {
    const label = "Bhai Bhai Traders 01700-111222\nKarim Mia\n01818-556677\nKha-54/2, Pragati Sarani, Badda, Dhaka-1212\nTotal: Tk 980";
    const answer = { recipient_name: "Karim Mia", recipient_phone: "01818-556677", address: "Kha-54/2, Pragati Sarani, Badda, Dhaka-1212", district: "Dhaka", zone: "Badda", area: "Pragati Sarani", cod_amount: "980" };
    expect(mergeAi(parseLabel(label, "ecommerce", catalog), answer, label, "ecommerce", catalog)).toMatchObject({ recipient_name: "Karim Mia", recipient_phone: "01818556677", cod_amount: "980", district: "Dhaka North", zone: "Badda" });
  });

  it("rules: the amount after the keyword, and Bangla places matched as whole words", () => {
    expect(parseLabel("Name Karim Mia Mob 01818556677 Add: Road 3 Mohammadpur Dhaka bill 1,250/- Seller Fashion Point 01700111222", "ecommerce", catalog)).toMatchObject({ cod_amount: "1250", zone: "Mohammadpur" });
    // "রুমানা" (a name) is not the upazila "রুমা"; য় written either way.
    expect(parseLabel("নাম: রুমানা আক্তার\nফোন 01922-445566\nগ্রাম: চরপাড়া, ময়মনসিংহ সদর, ময়মনসিংহ\nCOD ৳ 1,120", "ecommerce", catalog)).toMatchObject({ district: "Mymensingh", zone: "Mymensingh Sadar", cod_amount: "1120" });
  });

  it("drops a 'note' that is really the order number", () => {
    const label = "SHIP TO Tanvir Hasan 01555123456\nCOD Tk. 2,300/- Order ID: GG-5521";
    expect(mergeAi({}, { instructions: "Order ID: GG-5521" }, label, "ecommerce", catalog).instructions).toBeUndefined();
  });

  it("keeps the rules' amount to collect (they follow the COD / total keywords)", () => {
    const label = "Price ৳1,300\nDelivery charge ৳150\nCollect ৳1,450";
    const merged = mergeAi(parseLabel(label, "ecommerce", catalog), { cod_amount: "1300" }, label, "ecommerce", catalog);
    expect(merged.cod_amount).toBe("1450");
  });
});
