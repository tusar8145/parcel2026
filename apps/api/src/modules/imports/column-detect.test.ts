import { describe, expect, it } from "vitest";
import { checkMapping, detectLayout, isExtraRow, type DetectLists } from "./column-detect";

const lists: DetectLists = {
  districts: ["Dhaka", "Gazipur", "Chattogram"],
  zones: ["Banani", "Mirpur", "Dhanmondi", "Tongi"],
  areas: ["Mirpur 10", "Banani DOHS"],
  products: ["Fashion & Apparel (Regular)", "Books (Books)"],
  speeds: ["Regular", "Express"],
};
const keyOf = (layout: ReturnType<typeof detectLayout>, header: string) => layout.columns.find(c => c.header === header)?.key ?? null;

describe("any merchant's file: header row, columns and extra lines", () => {
  it("skips title lines, matches other names for the columns, and leaves unknown columns out", () => {
    const rows = [
      ["Rahim Fashion House"],
      ["Order sheet 22 Oct 2026", "", "Prepared by Karim"],
      [],
      ["SL", "Invoice No", "Customer", "Mobile No.", "Shipping Address", "Thana", "Collectable Amount", "Delivery charge", "Remarks"],
      ["1", "INV-5521", "Ayesha Rahman", "01712345678", "House 22, Road 7, Banani", "Banani", "1,450", "60", "Call before delivery"],
      ["2", "INV-5522", "Kamal Hossain", "1812345678", "Flat 3B, Mirpur 10", "Mirpur", "890", "60", ""],
      ["3", "INV-5523", "Nusrat Jahan", "+8801912345678", "Sector 4, Tongi, Gazipur", "Tongi", "2,200", "110", "Fragile, please be careful"],
      [],
      ["", "", "", "", "", "Total", "4,540", "230"],
      ["Signature: ________"],
    ];
    const layout = detectLayout({ kind: "ecommerce", rows, lists });
    expect(layout.headerRow).toBe(4);
    expect(keyOf(layout, "Invoice No")).toBe("order_ref");
    expect(keyOf(layout, "Customer")).toBe("recipient_name");
    expect(keyOf(layout, "Mobile No.")).toBe("recipient_phone");
    expect(keyOf(layout, "Shipping Address")).toBe("address");
    expect(keyOf(layout, "Thana")).toBe("zone");
    expect(keyOf(layout, "Collectable Amount")).toBe("cod_amount");
    expect(keyOf(layout, "Remarks")).toBe("instructions");
    expect(keyOf(layout, "SL")).toBeNull();
    expect(keyOf(layout, "Delivery charge")).toBeNull();
    // Orders only: the totals line and the signature are not orders.
    const header = rows[3];
    expect(rows.slice(4).filter(r => !isExtraRow(r, header))).toHaveLength(3);
  });

  it("reads a file without headers from its data", () => {
    const rows = [
      ["Sadia Islam", "01711111111", "House 5, Road 2, Dhanmondi, Dhaka", "1200"],
      ["Rafiq Ahmed", "01822222222", "Holding 12, Mirpur 10, Dhaka", "850"],
      ["Mitu Akter", "01933333333", "Flat 2A, Banani DOHS, Dhaka", "0"],
    ];
    const layout = detectLayout({ kind: "ecommerce", rows, lists });
    expect(layout.headerRow).toBe(0);
    expect(layout.columns.map(c => c.key)).toEqual(["recipient_name", "recipient_phone", "address", "cod_amount"]);
  });

  it("adds district / thana columns the catalog doesn't know to the address, and the merchant's saved choice wins", () => {
    const rows = [
      ["Name", "Phone", "Address", "City", "Amount"],
      ["A", "01711111111", "House 1, Road 1", "Dhaka City", "500"],
      ["B", "01722222222", "House 2, Road 2", "Ctg City", "700"],
    ];
    const auto = detectLayout({ kind: "ecommerce", rows, lists });
    expect(keyOf(auto, "City")).toBe("__address_part");
    const saved = detectLayout({ kind: "ecommerce", rows, lists, saved: { amount: "declared_value", city: null } });
    expect(keyOf(saved, "Amount")).toBe("declared_value");
    expect(keyOf(saved, "City")).toBeNull();
    expect(saved.columns.find(c => c.header === "Amount")?.by).toBe("saved");
  });

  it("checks a matching from the dialog: each field once", () => {
    expect(checkMapping("ecommerce", ["recipient_phone", "address", "__address_part", "__address_part", null]).problems).toEqual([]);
    expect(checkMapping("ecommerce", ["recipient_phone", "recipient_phone"]).problems[0]).toMatch(/Columns A and B are both Customer phone/);
    expect(checkMapping("ecommerce", ["sender_phone"]).problems[0]).toMatch(/not a field/);
  });
});
