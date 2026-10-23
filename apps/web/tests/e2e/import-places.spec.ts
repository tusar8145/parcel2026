import { type Page } from "@playwright/test";
import { Fixtures, expect, sql, test, type TempMerchant, type TempUser } from "./support";

// Excel import preview (shared/importer.js, the same dialog for operations and merchants): district /
// zone / area left out of the file are picked from the address (marked green); the address can be
// corrected inline and the places chosen from dropdowns; each change checks and prices the row again.
// Accounts are temporary (support.ts Fixtures).
const fx = new Fixtures();
let shop: TempMerchant;
let OWNER: TempUser;
test.beforeAll(async () => {
  shop = await fx.merchant({ label: "Import Places" });
  OWNER = await fx.member(shop, "MERCHANT_OWNER");
});
test.afterAll(() => fx.cleanup());

async function signIn(page: Page, user: TempUser) {
  for (let attempt = 0; ; attempt++) {
    await page.goto("/login");
    await page.waitForSelector("html.legacy-ready", { state: "attached" });
    await page.fill("#loginIdentity", user.login);
    await page.fill("#loginPassword", user.password);
    await page.click('form[data-form="login"] button[type="submit"]');
    const ok = await page.waitForURL(/\/ecommerce-merchant/, { timeout: 15_000 }).then(() => true, () => false);
    if (ok) break;
    if (attempt >= 2 || !/too many/i.test(await page.content())) throw new Error(`Couldn't sign in as ${user.name}`);
    await page.waitForTimeout(61_000);
  }
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
}

const HEADER = "Order ID,Customer name,Customer phone,Delivery address,District,Zone,Service,Weight (kg),COD amount (৳),Product";

test("import preview: places picked from the address, the address corrected inline, a zone chosen, then created", async ({ page }) => {
  await signIn(page, OWNER);
  await page.click('#navigation [data-page="Orders"]');
  const tag = fx.stamp.slice(-5);
  const csv = [
    HEADER,
    `PL-${tag}-1,Auto Places,01812000201,"House 9, Road 7, Dhanmondi, Dhaka",,,Regular,1,500,Fashion & Apparel`,
    `PL-${tag}-2,Unknown Place,01812000202,"Somewhere far",,,Regular,1,700,Fashion & Apparel`,
  ].join("\r\n");
  await page.click("#merchantBulkImport");
  await page.setInputFiles("#dfiFile", { name: `places-${tag}.csv`, mimeType: "text/csv", buffer: Buffer.from(`﻿${csv}`, "utf8") });
  await page.click('[data-dfi="check"]');
  await expect(page.locator("#dfImportTitle")).toContainText("Preview", { timeout: 30_000 });

  // ── Row 2: district and zone picked from the address, marked as picked ──
  const district = (row: number) => page.locator(`#dfiRows tr[data-row="${row}"] select[data-dfi-edit="district"]`);
  const zone = (row: number) => page.locator(`#dfiRows tr[data-row="${row}"] select[data-dfi-edit="zone"]`);
  await expect(district(2)).toHaveValue("Dhaka Central");
  await expect(zone(2)).toHaveValue("Dhanmondi");
  await expect(zone(2)).toHaveAttribute("title", /picked from the address/);
  // Row 3: nothing to pick: needs info.
  await expect(page.locator('#dfiRows tr[data-row="3"]')).toHaveAttribute("data-status", "INCOMPLETE");
  await expect(page.locator('#dfiSummary [data-count="incomplete"]')).toHaveText("1 needs info");

  // ── Row 3: the address corrected inline → its places are picked → valid ──
  const address = page.locator('#dfiRows tr[data-row="3"] input[data-dfi-edit="address"]');
  await address.fill("House 1, Sector 4, Uttara, Dhaka");
  await address.press("Enter");
  await expect(district(3)).toHaveValue("Dhaka North");
  await expect(zone(3)).toHaveValue("Uttara");
  await expect(page.locator('#dfiRows tr[data-row="3"]')).toHaveAttribute("data-status", "VALID");
  await expect(page.locator('#dfiSummary [data-count="valid"]')).toHaveText("2 valid");

  // ── Row 2: another zone chosen from the dropdown (no longer marked as picked) ──
  await zone(2).selectOption("Mirpur");
  await expect(zone(2)).toHaveValue("Mirpur");
  await expect(zone(2)).not.toHaveAttribute("title", /picked from the address/);
  await expect(district(2)).toHaveValue("Dhaka Central");

  // ── Created as corrected ──
  await page.click('[data-dfi="commit"]');
  await expect(page.locator("#dfiResultText")).toContainText("2 orders created", { timeout: 60_000 });
  const parcels = await sql<{ name: string; street: string; district: string; zone: string }>(
    `SELECT "recipientName" name, "deliveryStreet" street, "deliveryDistrict" district, "deliveryZone" zone FROM parcels WHERE "merchantId" = $1 AND "merchantOrderRef" LIKE $2 ORDER BY "merchantOrderRef"`,
    [shop.id, `PL-${tag}-%`],
  );
  expect(parcels).toEqual([
    { name: "Auto Places", street: "House 9, Road 7, Dhanmondi, Dhaka", district: "Dhaka Central", zone: "Mirpur" },
    { name: "Unknown Place", street: "House 1, Sector 4, Uttara, Dhaka", district: "Dhaka North", zone: "Uttara" },
  ]);
});
