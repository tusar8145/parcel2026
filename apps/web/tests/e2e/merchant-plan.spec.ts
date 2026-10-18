import { type Browser } from "@playwright/test";
import { Fixtures, expect, test, type TempUser } from "./support";

/**
 * "Services & pricing" in the merchant panels (2026-10-18): the merchant's plan in plain words — what every
 * merchant gets, what the package includes or not (with "Request this service"), the SMS & email per stage,
 * the prices, worked examples and a calculator priced by the API. Needs the API, the web app and the
 * default packages. Merchants and members are temporary (support.ts cleanup).
 */
const fx = new Fixtures();
test.afterAll(() => fx.cleanup());

async function signIn(browser: Browser, user: TempUser, to: RegExp) {
  const page = await (await browser.newContext()).newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/login");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.fill("#loginIdentity", user.login);
  await page.fill("#loginPassword", user.password);
  await page.click('form[data-form="login"] button[type="submit"]');
  await page.waitForURL(to);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return { page, errors };
}

test("e-commerce merchant: services, messages and pricing of their plan, with a working calculator", async ({ browser }) => {
  test.setTimeout(120_000);
  const shop = await fx.merchant();
  const owner = await fx.member(shop);
  const { page, errors } = await signIn(browser, owner, /\/ecommerce-merchant/);
  const plan = await page.evaluate(() => (window as unknown as { DF: { api(p: string): Promise<any> } }).DF.api("/merchants/me/plan"));

  // The menu item sits before Settings and the page has its own address.
  const item = page.locator('#navigation [data-page="Services & pricing"]');
  await expect(item).toBeVisible();
  await expect(page.locator('#navigation [data-page="Services & pricing"] + [data-page="Settings"]')).toHaveCount(1);
  await item.click();
  await expect(page).toHaveURL(/[?&]page=services-and-pricing/);
  await expect(page.locator("#dfpPlanName")).toHaveText(plan.package.name);
  await expect(page.locator("#breadcrumbPage")).toHaveText("Services & pricing");

  // Only the plan's own services (no "every merchant" list) and no Standard / Custom plan tag.
  await expect(page.locator("#dfpPanel")).not.toContainText("Included for every merchant");
  await expect(page.locator("#dfpPage")).not.toContainText("Standard plan");
  // Statuses follow the package (the dev default may differ from the seeded one, so read it from the API).
  const items = (plan.services as { items: { code: string; label: string; included: boolean }[] }[]).flatMap(s => s.items);
  const included = items.find(i => i.included)!;
  await expect(page.locator(`[data-dfp-service="${included.code}"] .dfp-ok`)).toHaveCount(1);
  await expect(page.locator(`[data-dfp-service="${included.code}"]`)).not.toContainText("Not in your plan");
  if (items.find(i => i.code === "payment.cod")?.included) await expect(page.locator('[data-dfp-service="payment.cod"]')).toContainText("of the cash collected");
  const missing = items.find(i => !i.included);
  // Only what's missing; "Request this service" opens a support ticket about it.
  await page.click('[data-dfp-filter="not"]');
  await expect(page.locator(`[data-dfp-service="${included.code}"]`)).toHaveCount(0);
  if (missing) {
    const row = page.locator(`[data-dfp-service="${missing.code}"]`);
    await expect(row).toContainText("Not in your plan");
    await row.locator("[data-dfp-request]").click();
    await expect(page.locator('input[name="subject"]')).toHaveValue(`Add "${missing.label}" to my plan`);
  }
  await page.goto("/ecommerce-merchant?page=services-and-pricing");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(page.locator("#dfpPlanName")).toHaveText(plan.package.name);

  // Messages: by stage, to whom, SMS / email.
  await page.click('[data-dfp-tab="messages"]');
  const booked = page.locator('[data-dfp-message="notify.booked"]');
  await expect(booked).toContainText("Pickup request received");
  await expect(booked).toContainText("You");
  await expect(booked.locator("td").nth(2)).toContainText("On");
  await expect(page.locator('[data-dfp-message="notify.delivery_code"]')).toContainText("Your customer");
  // Sample texts: one message opens in place; "Show all samples" opens every one.
  const sample = page.locator('[data-dfp-sample-row="notify.booked"]');
  await expect(sample).toBeHidden();
  await booked.locator("[data-dfp-sample]").click();
  await expect(sample).toBeVisible();
  await expect(sample.locator("[data-dfp-sms] .dfp-bubble")).toContainText("PP-261018-B54GG");
  await expect(sample.locator("[data-dfp-email] .dfp-mail-subject")).toContainText("PP-261018-B54GG");
  await booked.locator("[data-dfp-sample]").click();
  await expect(sample).toBeHidden();
  await page.click("[data-dfp-samples-all]");
  await expect(page.locator('[data-dfp-sample-row="notify.delivery_code"] [data-dfp-sms]')).toContainText("Give code");
  await expect(page.locator('[data-dfp-sample-row="notify.delivery_code"] [data-dfp-email]')).toHaveCount(0);
  await expect(page.locator("#dfpPanel")).toContainText("Always sent, for your security");

  // Pricing: the routes, examples and the calculator (the API's quote for the same parcel).
  await page.click('[data-dfp-tab="pricing"]');
  await expect(page.locator('[data-dfp-tier="SAME_DISTRICT"]')).toContainText(`৳${plan.prices.routes[0].amount}`);
  await expect(page.locator("#dfpPanel")).toContainText("Examples");
  await page.selectOption('#dfpCalcForm select[name="deliveryDistrict"]', "Chattogram");
  await page.fill('#dfpCalcForm input[name="weightKg"]', "1.5");
  await page.fill('#dfpCalcForm input[name="codAmount"]', "1500");
  await page.click('#dfpCalcForm button[type="submit"]');
  const quote = await page.evaluate(
    () =>
      (window as unknown as { DF: { api(p: string, o: unknown): Promise<any> } }).DF.api("/merchants/me/quote", {
        method: "POST",
        body: { pickupDistrict: "Dhaka North", deliveryDistrict: "Chattogram", weightKg: 1.5, codAmount: 1500, speed: "REGULAR", firstMile: "RIDER_PICKUP", lastMile: "DOORSTEP" },
      }),
  );
  await expect(page.locator("#dfpQuoteTotal")).toHaveText(`৳${quote.totalCharge.toLocaleString("en-US")}`);
  await expect(page.locator("#dfpCalcOut")).toContainText("Different district");
  expect(errors).toEqual([]);
});

test("banking merchant: their own services, no COD, and the page on a phone-width screen", async ({ browser }) => {
  const bank = await fx.merchant({ type: "BANKING_FINANCIAL" });
  const owner = await fx.member(bank);
  const { page, errors } = await signIn(browser, owner, /\/banking-merchant/);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/banking-merchant?page=services-and-pricing");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(page.locator("#dfpPlanName")).toHaveText(/Banking & Financial/);
  await expect(page.locator('[data-dfp-service="handling.b2b"]')).toHaveCount(1);
  await expect(page.locator('[data-dfp-service="payment.cod"]')).toHaveCount(0);
  await page.click('[data-dfp-tab="pricing"]');
  await expect(page.locator('#dfpCalcForm input[name="codAmount"]')).toHaveCount(0);
  await expect(page.locator('#dfpCalcForm input[name="weightKg"]')).toHaveCount(0);
  // Nothing wider than the screen, on every tab (messages with every sample open).
  for (const tab of ["services", "messages", "pricing"]) {
    await page.click(`[data-dfp-tab="${tab}"]`);
    if (tab === "messages") await page.click("[data-dfp-samples-all]");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, tab).toBeLessThanOrEqual(1);
  }
  expect(errors).toEqual([]);
});
