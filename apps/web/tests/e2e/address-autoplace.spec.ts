import { type Browser, type Page } from "@playwright/test";
import { Fixtures, expect, opsNav, test, type TempUser } from "./support";

// Addresses everywhere: the address field holds the full address; district / zone / area are picked
// from it as it is typed (GET /catalog/place: shared/api.js DF.autoPlace in the panels,
// src/shared/usePlaceFromAddress.ts in React forms) and stay changeable. Accounts are temporary.
const fx = new Fixtures();
let OPS: TempUser;
test.beforeAll(async () => {
  OPS = await fx.staff("OPS_MANAGER");
});
test.afterAll(() => fx.cleanup());

const FULL = "Home, Flat 4B, House 22, Road 7, Block C, Banani, Dhaka";

async function signedIn(browser: Browser, user: TempUser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  for (let attempt = 0; ; attempt++) {
    await page.goto("/login");
    await page.waitForSelector("html.legacy-ready", { state: "attached" });
    await page.fill("#loginIdentity", user.login);
    await page.fill("#loginPassword", user.password);
    await page.click('form[data-form="login"] button[type="submit"]');
    const ok = await page.waitForURL(/courier-operation/, { timeout: 15_000 }).then(() => true, () => false);
    if (ok) break;
    if (attempt >= 2 || !/too many/i.test(await page.content())) throw new Error(`Couldn't sign in as ${user.name}`);
    await page.waitForTimeout(61_000);
  }
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return page;
}

test("Courier Operations New order: typing the full address picks district, zone and area; they stay changeable", async ({ browser }) => {
  const ops = await signedIn(browser, OPS);
  await opsNav(ops, "ecommerce");
  await ops.click('[data-action="newEcommerce"]');
  await expect(ops.locator("#bkDistrict")).toHaveValue("");

  // Typed, then a pause: picked.
  await ops.locator("#bkStreet").pressSequentially(FULL, { delay: 5 });
  await expect(ops.locator("#bkDistrict")).toHaveValue("Dhaka North");
  await expect(ops.locator("#bkZone")).toHaveValue("Banani");
  await expect(ops.locator("#bkArea")).toHaveValue("Banani");

  // The user's own choice stays…
  await ops.selectOption("#bkArea", "Banani Block C");
  await ops.locator("#bkRecipient").click();
  await ops.waitForTimeout(1500);
  await expect(ops.locator("#bkArea")).toHaveValue("Banani Block C");

  // …until the address is changed: picked again from the new address.
  await ops.fill("#bkStreet", "House 12, Road 5, Dhanmondi, Dhaka");
  await ops.locator("#bkRecipient").click();
  await expect(ops.locator("#bkDistrict")).toHaveValue("Dhaka Central");
  await expect(ops.locator("#bkZone")).toHaveValue("Dhanmondi");

  // An address naming no known place leaves the choices alone.
  await ops.fill("#bkStreet", "Road 7, Flat 3B");
  await ops.locator("#bkRecipient").click();
  await ops.waitForTimeout(1500);
  await expect(ops.locator("#bkZone")).toHaveValue("Dhanmondi");
});

test("website merchant application (React): the full address picks district, thana and area", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/merchant");
  const street = page.locator("#bizStreet");
  await expect(street).toBeVisible({ timeout: 30_000 });
  await street.fill(FULL);
  await expect(page.locator("#bizDistrict")).toHaveValue("Dhaka North", { timeout: 15_000 });
  await expect(page.locator("#bizZone")).toHaveValue("Banani");
  await expect(page.locator("#bizArea")).toHaveValue("Banani");
});
