import { type Browser, type Page } from "@playwright/test";
import { DEMO_PASSWORD, Fixtures, apiUrl, expect, test, type TempUser } from "./support";

/**
 * Merchant panel features on the real API: product catalogue, reports, recurring pickups,
 * business verification (KYC) and API key scopes; operations returns and scheduled pickups.
 * The merchant and its owner are temporary (created before, deleted after: support.ts);
 * operations uses the seeded staff account.
 */
const OPS = { login: process.env.E2E_OPS_LOGIN ?? "ops@deliveryfast.example", password: DEMO_PASSWORD };

const fx = new Fixtures();
let owner: TempUser;
test.beforeAll(async () => {
  owner = await fx.member(await fx.merchant({ type: "ECOMMERCE", label: "Features Shop" }), "MERCHANT_OWNER");
});
test.afterAll(() => fx.cleanup());

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
const toast = (page: Page) => page.locator("#toast");

async function signIn(browser: Browser, user: { login: string; password: string }, panel: RegExp) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/status of (401|404|409)/.test(message.text())) errors.push(message.text());
  });
  page.on("dialog", dialog => dialog.accept());
  // Signs in through the API (sets the refresh cookie), then opens the panel, which restores the session.
  const login = await page.request.post(apiUrl("/api/v1/auth/login"), { headers: { "x-df-client": "web" }, data: { identifier: user.login, password: user.password } });
  expect(login.ok(), await login.text()).toBeTruthy();
  await page.goto(panel.source.replaceAll("\\", ""));
  await expect(page).toHaveURL(panel);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return { page, errors };
}

async function nav(page: Page, name: string) {
  await page.click(`#navigation [data-page="${name}"]`);
  await expect(page.locator("#breadcrumbPage")).toContainText(name);
}

test("e-commerce merchant: products prefill orders, reports export, recurring pickups", async ({ browser }) => {
  const { page, errors } = await signIn(browser, owner, /\/ecommerce-merchant/);

  // ── Products ──
  await nav(page, "Products");
  const sku = `E2E-${unique()}`;
  await page.click("#dfAddProduct");
  await page.fill("#dffProductName", `E2E Tote ${sku}`);
  await page.fill("#dffProductSku", sku);
  await page.fill("#dffProductCategory", "Clothing");
  await page.fill("#dffProductPrice", "1250");
  await page.fill("#dffProductWeight", "0.8");
  await page.click('#dffProductForm button[type="submit"]');
  await expect(toast(page)).toContainText("saved");
  const row = page.locator("#tableBody tr", { hasText: sku });
  await expect(row).toContainText("৳ 1,250");

  // The order form offers it and prefills the value.
  await nav(page, "Orders");
  await page.click("#createOrder");
  const pick = await page.locator("#dffCatalogPick option", { hasText: sku }).getAttribute("value");
  await page.selectOption("#dffCatalogPick", pick!);
  await expect(page.locator("#orderAmount")).toHaveValue("1250");
  await page.click("#cancelModal");

  // ── Reports ──
  await nav(page, "Reports");
  const download = page.waitForEvent("download");
  await page.click('[data-dff-report="orders"]');
  expect((await download).suggestedFilename()).toMatch(/orders-\d{4}-\d\d-\d\d\.csv$/);

  // ── Recurring pickup ──
  await nav(page, "Pickup requests");
  await page.click("#dffSchedules");
  await page.fill("#dffScheduleName", `E2E pickup ${sku}`);
  await page.fill("#dffScheduleStart", "22:00");
  await page.fill("#dffScheduleEnd", "23:30");
  await page.click('#dffScheduleForm button[type="submit"]');
  await expect(toast(page)).toContainText("Recurring pickup saved");
  const schedule = page.locator("#dfDialogBody tr", { hasText: `E2E pickup ${sku}` });
  await expect(schedule).toBeVisible();
  await schedule.locator("[data-dff-schedule-delete]").click();
  await expect(toast(page)).toContainText("removed");
  await page.click("#closeMerchantHistory");

  // Clean up the product.
  await nav(page, "Products");
  await page.locator("#tableBody tr", { hasText: sku }).locator("[data-dff-product-delete]").click();
  await expect(toast(page)).toContainText("removed");
  expect(errors).toEqual([]);
});

test("e-commerce merchant: business verification and scoped API keys", async ({ browser, api: request }) => {
  const { page, errors } = await signIn(browser, owner, /\/ecommerce-merchant/);
  await nav(page, "Settings");
  await page.locator("#tableBody tr", { hasText: "Business verification" }).locator("button").click();
  await expect(page.locator("#merchantHistoryTitle")).toContainText("Business verification");
  await expect(page.locator("#dfDialogBody")).toContainText("Trade license");
  await page.click("#closeMerchantHistory");

  await nav(page, "API & Webhooks");
  const name = `E2E scoped ${unique()}`;
  await page.fill("#dfApiKeyName", name);
  await page.uncheck('input[name="dfApiKeyScope"][value="parcels:write"]');
  await page.click('#dfApiKeyForm button[type="submit"]');
  const key = (await page.locator("#dfRevealedSecret").textContent())!.trim();
  const headers = { authorization: `Bearer ${key}` };
  expect((await request.get("/api/v1/parcels?limit=1", { headers })).status()).toBe(200);
  expect((await request.post("/api/v1/parcels", { headers, data: {} })).status()).toBe(403);
  await page.click("[data-df-dismiss]");
  const keyRow = page.locator("#mainContent tr", { hasText: name });
  await expect(keyRow).toContainText("parcels:read");
  await keyRow.locator("[data-df-revoke]").click();
  await expect(keyRow).toContainText("Revoked");
  expect(errors).toEqual([]);
});

test("operations: returns and scheduled pickups pages", async ({ browser }) => {
  const { page, errors } = await signIn(browser, OPS, /\/courier-operation/);
  await page.click('#navigation [data-page="Returns"]');
  await expect(page.locator("#mainContent h1")).toContainText("Returns (RTO)");
  await expect(page.locator("#mainContent")).toContainText("Return runs");
  await page.click('#navigation [data-page="Scheduled pickups"]');
  await expect(page.locator("#mainContent h1")).toContainText("Scheduled pickups");
  await page.click("[data-pu-generate]");
  await expect(toast(page)).toContainText("created from recurring schedules");
  expect(errors).toEqual([]);
});
