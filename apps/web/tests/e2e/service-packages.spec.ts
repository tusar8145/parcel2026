import { request as playwrightRequest, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { authenticator } from "otplib";
import { Fixtures, apiUrl, API_BASE, expect, opsNav, sql, test, type TempMerchant, type TempRider, type TempUser } from "./support";

/**
 * Service packages & pricing (spec v2) through the real UI:
 *  - a super admin creates an E-commerce package and assigns it to a merchant (maker-checker: a
 *    second super admin approves through the API), and the merchant's order form prices with it;
 *  - products have one "Send SMS & email" switch; a product with it off disables the messages
 *    checklist on the order form and its parcel stores no messages;
 *  - a Hub Pickup parcel waits at its collection hub and the hub operator hands it over at the
 *    Collect from hub (Courier Operations → Hub desk).
 * Every account is temporary (support.ts); the package the test creates is deleted afterwards.
 */
const WEB = { "x-df-client": "web" };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const fx = new Fixtures();
const PACKAGE_NAME = `E2E Gold ${fx.stamp}`;
/** A product the test creates with "Send SMS & email" off (deleted afterwards). */
const QUIET_PRODUCT = `E2E Quiet ${fx.stamp}`;
let maker: TempUser;
let checkerUser: TempUser;
let checker: APIRequestContext;
let checkerToken = "";
let shop: TempMerchant;
let owner: TempUser;
let rider: TempRider;
let hubOperator: TempUser;
let ops: TempUser;

test.beforeAll(async () => {
  maker = await fx.user(`E2E-Maker-${fx.stamp} Test`, [{ role: "SUPER_ADMIN" }]);
  checkerUser = await fx.user(`E2E-Checker-${fx.stamp} Test`, [{ role: "SUPER_ADMIN" }]);
  checker = await playwrightRequest.newContext({ baseURL: API_BASE, extraHTTPHeaders: { "x-df-client": "app" } });
  const login = await (await checker.post("/api/v1/auth/login", { data: { identifier: checkerUser.login, password: checkerUser.password } })).json();
  const setup = await (await checker.post("/api/v1/auth/mfa/setup", { data: { mfaToken: login.mfaToken } })).json();
  checkerToken = (await (await checker.post("/api/v1/auth/mfa/enable", { data: { mfaToken: login.mfaToken, code: authenticator.generate(setup.secret) } })).json()).accessToken;
  shop = await fx.merchant({ type: "ECOMMERCE", label: "Package Shop" });
  owner = await fx.member(shop, "MERCHANT_OWNER");
  rider = await fx.rider("Gulshan Sorting Hub");
  hubOperator = await fx.staff("HUB_OPERATOR", "Gulshan Sorting Hub");
  ops = await fx.staff("OPS_MANAGER");
});
test.afterAll(async () => {
  await checker?.dispose();
  await fx.cleanup();
  // The package only this test used (its versions cascade; the merchant's assignment went with the merchant).
  await sql(`DELETE FROM service_packages WHERE name = $1`, [PACKAGE_NAME]);
  await sql(`DELETE FROM parcel_products WHERE name = $1 AND NOT EXISTS (SELECT 1 FROM parcels WHERE "productId" = parcel_products.id)`, [QUIET_PRODUCT]);
});

const toast = (page: Page) => page.locator("#toast");
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function newPage(browser: Browser, errors: string[]) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("dialog", dialog => dialog.accept());
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/status of (401|404)/.test(message.text())) errors.push(message.text());
  });
  return page;
}

async function signIn(page: Page, user: TempUser, panel: RegExp) {
  for (let attempt = 0; ; attempt++) {
    await page.goto("/login");
    await page.waitForSelector("html.legacy-ready", { state: "attached" });
    await page.fill("#loginIdentity", user.login);
    await page.fill("#loginPassword", user.password);
    await page.click('form[data-form="login"] button[type="submit"]');
    if (await page.waitForURL(panel, { timeout: 15_000 }).then(() => true, () => false)) break;
    if (attempt >= 2 || !/too many/i.test(await page.content())) await expect(page).toHaveURL(panel);
    await page.waitForTimeout(61_000);
  }
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
}

async function approvePending() {
  const pending = await (await checker.get("/api/v1/admin/changes?status=PENDING", { headers: auth(checkerToken) })).json();
  const mine = pending.items.filter((c: { requestedBy: { id: string } }) => c.requestedBy.id === maker.id);
  expect(mine.length, "a pending change from the maker").toBeGreaterThan(0);
  for (const change of mine) {
    const res = await checker.post(`/api/v1/admin/changes/${change.id}/approve`, { headers: auth(checkerToken), data: { note: "E2E check" } });
    expect(res.ok(), await res.text()).toBe(true);
  }
}

async function apiToken(request: APIRequestContext, user: TempUser) {
  const res = await request.post(apiUrl("/api/v1/auth/login"), { data: { identifier: user.login, password: user.password } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).accessToken as string;
}

test("super admin creates a package and assigns it; the merchant's order form prices with it", async ({ browser }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const page = await newPage(browser, errors);
  // Two-step verification for the maker (first sign-in enrols it).
  const login = await (await page.request.post(apiUrl("/api/v1/auth/login"), { headers: WEB, data: { identifier: maker.login, password: maker.password } })).json();
  expect(login.mfaSetupRequired, JSON.stringify(login)).toBe(true);
  const setup = await (await page.request.post(apiUrl("/api/v1/auth/mfa/setup"), { headers: WEB, data: { mfaToken: login.mfaToken } })).json();
  const enabled = await page.request.post(apiUrl("/api/v1/auth/mfa/enable"), { headers: WEB, data: { mfaToken: login.mfaToken, code: authenticator.generate(setup.secret) } });
  expect(enabled.ok(), await enabled.text()).toBe(true);
  await page.goto("/super-admin");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });

  // ── Service plans & pricing → E-commerce → New package ──
  await page.click('#navigation [data-page="Service plans"]');
  await page.click('[data-pkg-segment="ECOMMERCE"]');
  await expect(page.locator("#pkgTable")).toContainText("E-commerce default");
  await page.click("[data-pkg-new]");
  await page.fill("#pkgName", PACKAGE_NAME);
  await page.fill("#pkgPrice-sameDistrict", "55");
  await page.fill("#pkgNote", "E2E package");
  await page.click("#pkgSave");
  await expect(toast(page)).toContainText(/approval/i);
  await approvePending();

  // ── Assign it to the merchant ──
  await page.reload();
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.click('#navigation [data-page="Service plans"]');
  await page.click('[data-pkg-segment="ECOMMERCE"]');
  await expect(page.locator("#pkgTable")).toContainText(PACKAGE_NAME);
  const row = page.locator(`#pkgAssignments tr[data-pkg-merchant="${shop.code}"]`);
  await row.locator("[data-pkg-assign-select]").selectOption({ label: PACKAGE_NAME });
  await row.locator("[data-pkg-assign]").click();
  await expect(toast(page)).toContainText(/approval/i);
  await approvePending();

  // ── Products: one "Send SMS & email" switch (add form + list) ──
  const products = page.locator("#pkgProductsPanel");
  await expect(products.locator("#pkgProducts thead")).toContainText("MESSAGES");
  await expect(products.locator("#pkgProducts thead")).not.toContainText("MESSAGES NOT SENT");
  await expect(products.locator("[data-pkg-product-mutes]")).toHaveCount(0);
  await products.locator("#pkgProductName").fill(QUIET_PRODUCT);
  await expect(products.locator("#pkgProductSendMessages")).toBeChecked();
  await products.locator("#pkgProductSendMessages").uncheck();
  await products.locator('#pkgProductForm button[type="submit"]').click();
  // Wait for the row itself: an earlier "sent for approval" toast may still be showing.
  const quietRow = () => page.locator(`#pkgProducts tr[data-pkg-product="${QUIET_PRODUCT}"]`);
  await expect(quietRow()).toBeVisible();
  await expect(quietRow()).toContainText("Messages: Off");
  const [created] = await sql<{ id: string; sendMessages: boolean }>(`SELECT id, "sendMessages" FROM parcel_products WHERE name = $1`, [QUIET_PRODUCT]);
  expect(created.sendMessages).toBe(false);
  await quietRow().locator("[data-pkg-product-messages]").check();
  await expect(quietRow()).toContainText("Messages: On");
  expect((await sql<{ sendMessages: boolean }>(`SELECT "sendMessages" FROM parcel_products WHERE id = $1`, [created.id]))[0].sendMessages).toBe(true);
  await quietRow().locator("[data-pkg-product-messages]").uncheck();
  await expect(quietRow()).toContainText("Messages: Off");
  await page.context().close();

  // ── The merchant's order form: live breakdown from the new package (same district ৳55) ──
  const merchantPage = await newPage(browser, errors);
  await signIn(merchantPage, owner, /\/ecommerce-merchant/);
  await merchantPage.click('#navigation [data-page="Orders"]');
  await merchantPage.click("#createOrder");
  await merchantPage.fill("#customerName", "E2E Package Buyer");
  await merchantPage.fill("#customerPhone", "01812345670");
  await merchantPage.fill("#deliveryAddress", "House 7, Road 2");
  await merchantPage.selectOption("#merchantDistrict", "Dhaka Central");
  await merchantPage.selectOption("#merchantZone", "Dhanmondi");
  await merchantPage.selectOption("#merchantArea", "Dhanmondi Road 7");
  // Prepaid: no cash on delivery (the COD amount field hides with the tick).
  await merchantPage.locator("#merchantSvcCod").uncheck();
  await expect(merchantPage.locator("#merchantSvcCodAmount")).toBeHidden();
  const breakdown = merchantPage.locator("#merchantPriceHint [data-price-breakdown]");
  await expect(breakdown).toContainText(PACKAGE_NAME, { timeout: 15_000 });
  await expect(breakdown).toContainText("Inside same district");
  // Every message in the package is pre-ticked; a product with messages off disables the checklist.
  const checklist = merchantPage.locator("#merchantSvcNotifications");
  await expect(checklist.locator("[data-svc-notify]:not(:checked)")).toHaveCount(0);
  await expect(checklist.locator("[data-svc-notify]").first()).toBeEnabled();
  await merchantPage.selectOption("#merchantProduct", QUIET_PRODUCT);
  await expect(checklist.locator("summary")).toContainText("this product doesn't send messages");
  await expect(checklist.locator("[data-svc-notify]:enabled")).toHaveCount(0);
  await checklist.locator("summary").click();
  await expect(checklist.locator("[data-svc-notify-off]")).toBeVisible();
  await merchantPage.click('#orderForm button[type="submit"]');
  await expect(toast(merchantPage)).toContainText(/created · delivery charge ৳/);
  const trackingId = (await toast(merchantPage).textContent())!.match(/PP-\d{6}-[0-9A-Z]{4,5}/)![0];
  const [parcel] = await sql<{ snapshot: { packageName?: string; engine?: string }; productName: string; notifications: string[] }>(
    `SELECT "pricingSnapshot" AS snapshot, "productName", notifications FROM parcels WHERE "trackingId" = $1`,
    [trackingId],
  );
  expect(parcel.snapshot).toMatchObject({ engine: "package-v2", packageName: PACKAGE_NAME });
  expect(parcel).toMatchObject({ productName: QUIET_PRODUCT, notifications: [] });
  expect(errors).toEqual([]);
});

test("a Hub Pickup parcel waits at its hub and the hub operator hands it over", async ({ browser, api }) => {
  test.setTimeout(240_000);
  const [hub] = await sql<{ id: string }>(`SELECT id FROM hubs WHERE name = 'Gulshan Sorting Hub'`);
  // The merchant books with Hub Pickup at Gulshan Sorting Hub (prepaid).
  const ownerToken = await apiToken(api, owner);
  const booked = await api.post(apiUrl("/api/v1/parcels"), {
    headers: auth(ownerToken),
    data: {
      sender: { name: "E2E Package Shop", phone: "01711000000" },
      recipient: { name: "E2E Hub Pickup Receiver", phone: "01812345671" },
      pickup: { category: "Home", street: shop.pickupAddress, zone: "Gulshan", district: "Dhaka North" },
      delivery: { category: "Home", street: "Road 3", zone: "Gulshan", district: "Dhaka North" },
      type: "ECOMMERCE",
      weightKg: 0.5,
      codAmount: 0,
      lastMile: "HUB_COLLECT",
      collectHubId: hub.id,
    },
  });
  expect(booked.status(), await booked.text()).toBe(201);
  const trackingId = (await booked.json()).trackingId as string;
  // Pickup by the rider, handed to Gulshan Sorting Hub: it is now ready for collection there.
  const opsToken = await apiToken(api, ops);
  const assigned = await api.post(apiUrl(`/api/v1/parcels/${trackingId}/assign-pickup`), { headers: auth(opsToken), data: { riderId: rider.riderId } });
  expect(assigned.ok(), await assigned.text()).toBeTruthy();
  const riderToken = await apiToken(api, rider);
  const picked = await api.post(apiUrl(`/api/v1/rider/parcels/${trackingId}/pickup`), { headers: auth(riderToken), data: { outcome: "COLLECTED_TO_HUB", hubId: hub.id } });
  expect(picked.ok(), await picked.text()).toBeTruthy();
  await expect.poll(async () => (await sql<{ status: string }>(`SELECT status FROM parcels WHERE "trackingId" = $1`, [trackingId]))[0].status).toBe("READY_FOR_COLLECTION");

  // ── Courier Operations → Hub desk → Collect from hub ──
  const errors: string[] = [];
  const page = await newPage(browser, errors);
  await signIn(page, hubOperator, /\/courier-operation/);
  await opsNav(page, "hubPickupCounter");
  const counter = page.locator("#collectCounter");
  await expect(counter.locator(`tr[data-collect-row="${trackingId}"]`)).toBeVisible();
  await counter.locator(`[data-collect-open="${trackingId}"]`).click();
  // The receiver lost the code: a photo of their ID instead.
  await page.setInputFiles("#collectPhoto", { name: "id.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") });
  await page.click('#collectForm button[type="submit"]');
  await expect(page.locator("#collectMessage")).toContainText(`${trackingId} handed over.`);
  await expect(counter.locator(`tr[data-collect-row="${trackingId}"]`)).toHaveCount(0);
  expect((await sql<{ status: string }>(`SELECT status FROM parcels WHERE "trackingId" = $1`, [trackingId]))[0].status).toBe("DELIVERED");
  expect(errors).toEqual([]);
});
