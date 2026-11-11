/// <reference types="vitest/globals" />
import { productKey } from "./import-ai.service";
import { matchProduct } from "./product-match";

describe("productKey (no duplicate products)", () => {
  it("gives the same key to spelling, plural, size and colour variants", () => {
    expect(productKey("T-Shirt")).toBe(productKey("T Shirts"));
    expect(productKey("T-Shirt")).toBe(productKey("tshirt XL black"));
    expect(productKey("Cheque Book")).toBe(productKey("cheque books"));
    expect(productKey("Watches")).toBe(productKey("Watch"));
    expect(productKey("Batteries")).toBe(productKey("Battery"));
    expect(productKey("Honey 500 gm")).toBe(productKey("Honey"));
    expect(productKey("Fashion & Apparel")).toBe(productKey("Fashion and Apparel"));
  });
  it("keeps different things apart", () => {
    expect(productKey("Shoes")).not.toBe(productKey("Shirt"));
    expect(productKey("Glass")).toBe("glass");
    expect(productKey("Earbuds")).not.toBe(productKey("Headphones"));
  });
  it("prefers the longer listed name inside a written one", () => {
    expect(matchProduct("Tshirt men XL", [{ name: "Shirt" }, { name: "T-Shirt" }])?.product.name).toBe("T-Shirt");
    expect(matchProduct("Blue cotton shirt x2", [{ name: "Shirt" }, { name: "Saree" }])?.product.name).toBe("Shirt");
    expect(matchProduct("Drone propeller set", [{ name: "Shirt" }, { name: "Books" }])).toBeNull();
  });
});
