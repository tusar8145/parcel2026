import { type Browser } from "@playwright/test";
import { Fixtures, expect, test, type TempMerchant, type TempUser } from "./support";

// The panels' menus are real links: "Open in new tab" (right click), Ctrl+click and middle click open the page in
// a new tab, signed in; a plain click still changes the page without reloading. Accounts are temporary.
const fx = new Fixtures();
let ops: TempUser;
let shop: TempMerchant;
let owner: TempUser;
test.beforeAll(async () => {
  ops = await fx.staff("OPS_MANAGER");
  shop = await fx.merchant({ type: "ECOMMERCE", plan: true });
  owner = await fx.member(shop, "MERCHANT_OWNER");
});
test.afterAll(() => fx.cleanup());

async function signIn(browser: Browser, user: TempUser, panel: RegExp, url: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto("/login");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.fill("#loginIdentity", user.login);
  await page.fill("#loginPassword", user.password);
  await page.click('form[data-form="login"] button[type="submit"]');
  await page.waitForURL(u => !u.pathname.startsWith("/login"), { timeout: 30_000 });
  if (!panel.test(page.url())) await page.goto(url);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(page.locator("#navigation a.nav-item").first()).toBeVisible({ timeout: 20_000 });
  return { context, page };
}

test("Courier Operations: menu links open in a new tab, and a plain click stays on the page", async ({ browser }) => {
  const { context, page } = await signIn(browser, ops, /courier-operation/, "/courier-operation");
  const item = page.locator('#navigation a[data-nav="Delivery"]');
  await expect(item).toHaveAttribute("href", /\/courier-operation\?page=delivery$/);
  await page.evaluate(() => ((window as unknown as { samePage: boolean }).samePage = true));

  const [tab] = await Promise.all([context.waitForEvent("page"), item.click({ modifiers: ["Control"] })]);
  await tab.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(tab).toHaveURL(/page=delivery/);
  await expect(tab.locator("#breadcrumbLabel")).toHaveText("Delivery", { timeout: 20_000 });
  // The first tab didn't move.
  await expect(page).not.toHaveURL(/page=delivery/);

  await item.click();
  await expect(page).toHaveURL(/page=delivery/);
  expect(await page.evaluate(() => (window as unknown as { samePage?: boolean }).samePage)).toBe(true);
  await context.close();
});

test("merchant panel: menu links open in a new tab, and a plain click stays on the page", async ({ browser }) => {
  const { context, page } = await signIn(browser, owner, /ecommerce-merchant/, "/ecommerce-merchant");
  const item = page.locator('#navigation a[data-page="Reports"]');
  await expect(item).toHaveAttribute("href", /\/ecommerce-merchant\?page=reports$/);
  await page.evaluate(() => ((window as unknown as { samePage: boolean }).samePage = true));

  const [tab] = await Promise.all([context.waitForEvent("page"), item.click({ modifiers: ["Control"] })]);
  await tab.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(tab.locator("#breadcrumbPage")).toHaveText("Reports", { timeout: 20_000 });

  await item.click();
  await expect(page.locator("#breadcrumbPage")).toHaveText("Reports");
  await expect(item).toHaveClass(/active/);
  expect(await page.evaluate(() => (window as unknown as { samePage?: boolean }).samePage)).toBe(true);
  await context.close();
});
