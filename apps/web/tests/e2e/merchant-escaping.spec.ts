import { type Browser } from "@playwright/test";
import { Fixtures, expect, test, type TempMerchant, type TempUser } from "./support";

// Text a merchant or their customer typed is data: it is shown as text on every merchant page and never runs.
// Each panel books an order whose fields hold markup, then every menu page is opened. Accounts are temporary.
const fx = new Fixtures();
const attack = (field: string) => `<img src=x onerror="window.__ran=(window.__ran||[]).concat('${field}')">`;

async function signIn(browser: Browser, user: TempUser) {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await page.goto("/login");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.fill("#loginIdentity", user.login);
  await page.fill("#loginPassword", user.password);
  await page.click('form[data-form="login"] button[type="submit"]');
  await page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 30_000 });
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return page;
}

test.afterAll(() => fx.cleanup());

for (const type of ["ECOMMERCE", "BANKING_FINANCIAL"] as const)
  test(`${type}: markup in an order is shown as text on every page`, async ({ browser }) => {
    test.setTimeout(240_000);
    const shop: TempMerchant = await fx.merchant({ type, plan: true });
    const owner = await fx.member(shop, "MERCHANT_OWNER");
    const page = await signIn(browser, owner);

    await page.click("#createOrder");
    await expect(page.locator("#orderModal")).toHaveClass(/open/);
    await page.fill("#customerName", `Karim${attack("name")}`);
    await page.fill("#customerPhone", "01812345678");
    await page.fill("#deliveryAddress", `House 7${attack("address")}`);
    await page.selectOption("#merchantDistrict", "Dhaka Central");
    await page.selectOption("#merchantZone", "Dhanmondi");
    await page.selectOption("#merchantArea", "Dhanmondi Road 7");
    if (type === "ECOMMERCE") await page.fill("#merchantSvcCodAmount", "1250");
    await page.click('#orderForm button[type="submit"]');
    await expect(page.locator(".toast, #toast").first()).toContainText(/created/, { timeout: 15_000 });

    const pages = await page.locator("#navigation a[href]").evaluateAll(links => [...new Set(links.map(a => (a as HTMLAnchorElement).href))]);
    expect(pages.length).toBeGreaterThan(3);
    for (const url of pages) {
      await page.goto(url);
      await page.waitForSelector("html.legacy-ready", { state: "attached" });
      await page.waitForTimeout(800);
      expect(await page.evaluate(() => (window as unknown as { __ran?: string[] }).__ran ?? []), url).toEqual([]);
      expect(await page.locator('img[src="x"]').count(), url).toBe(0);
    }
    // Overview's Recent orders shows the name as it was typed.
    await page.goto(pages[0]);
    await expect(page.locator("#mainContent")).toContainText("Karim<img", { timeout: 15_000 });
  });
