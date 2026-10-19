import { type Browser, type Locator, type Page } from "@playwright/test";
import { Fixtures, expect, opsNav, sql, test, type TempMerchant, type TempUser } from "./support";

/**
 * The single-order booking forms (owner decisions 2026-10-18): Courier Operations "New order"
 * (merchant and walk-in sender), the e-commerce merchant order form and the Banking & Financial
 * request form.
 *   - the form's live price equals the booked price, with a Document-type product (the quote sends it);
 *   - the old fields are gone (service level, shipment / service type, document type, receiver
 *     relationship, packaging, origin branch code, pickup zone, separate intake) and nothing writes
 *     demo values into those columns;
 *   - Banking & Financial has no weight and no COD; weight above 5 kg is accepted elsewhere;
 *   - COD amount is separate from the product value;
 *   - +880 phone fields with inline errors; no horizontal overflow at 390 px.
 * Every account is temporary (support.ts) and deleted afterwards with its parcels; the walk-in
 * parcel (no merchant) is adopted for the cleanup.
 */

const fx = new Fixtures();
let shop: TempMerchant;
let bank: TempMerchant;
let shopOwner: TempUser;
let bankOwner: TempUser;
let OPS: TempUser;
test.beforeAll(async () => {
  shop = await fx.merchant({ type: "ECOMMERCE", label: "Form Shop" });
  bank = await fx.merchant({ type: "BANKING_FINANCIAL", label: "Form Bank" });
  shopOwner = await fx.member(shop, "MERCHANT_OWNER");
  bankOwner = await fx.member(bank, "MERCHANT_OWNER");
  OPS = await fx.staff("OPS_MANAGER");
});
test.afterAll(() => fx.cleanup());

const TRACKING = /PP-\d{6}-[0-9A-Z]{4,5}/;
const toast = (page: Page) => page.locator("#toast");
const taka = async (locator: Locator) => Number(((await locator.textContent()) || "").replace(/[^0-9.]/g, ""));

async function signedIn(browser: Browser, account: { login: string; password: string }, panel: RegExp, errors: string[], viewport?: { width: number; height: number }) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(`${account.login}: ${error.message}`));
  page.on("console", message => {
    // The login page probes the refresh cookie before anyone is signed in (401).
    if (message.type() === "error" && !/status of 401/.test(message.text())) errors.push(`${account.login}: ${message.text()}`);
  });
  for (let attempt = 0; ; attempt++) {
    await page.goto("/login");
    await page.waitForSelector("html.legacy-ready", { state: "attached" });
    await page.fill("#loginIdentity", account.login);
    await page.fill("#loginPassword", account.password);
    await page.click('form[data-form="login"] button[type="submit"]');
    const ok = await page.waitForURL(panel, { timeout: 15_000 }).then(() => true, () => false);
    if (ok) break;
    // Sign-in is rate limited per IP (shared with other suites on this machine).
    if (attempt >= 2 || !/too many/i.test(await page.content())) await expect(page).toHaveURL(panel);
    await page.waitForTimeout(61_000);
  }
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return page;
}

async function chooseOption(page: Page, selector: string, text: string) {
  const value = await page.locator(`${selector} option`, { hasText: text }).first().getAttribute("value");
  await page.selectOption(selector, value ?? { label: text });
}

/** No part of the dialog sticks out sideways (390 px phones). */
async function expectNoOverflow(page: Page, dialog: string) {
  const box = await page.evaluate(selector => {
    const el = document.querySelector(selector) as HTMLElement;
    const rect = el.getBoundingClientRect();
    const widest = Math.max(...[...el.querySelectorAll("input, select, label, .df-phone")].filter(x => (x as HTMLElement).offsetParent).map(x => x.getBoundingClientRect().right));
    return { left: rect.left, right: rect.right, scroll: el.scrollWidth, client: el.clientWidth, viewport: document.documentElement.clientWidth, widest };
  }, dialog);
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(box.viewport + 1);
  expect(box.scroll).toBeLessThanOrEqual(box.client + 1);
  expect(box.widest).toBeLessThanOrEqual(box.right + 1);
}

async function parcelRow(trackingId: string) {
  const [row] = await sql<{
    merchantId: string | null;
    channel: string;
    senderName: string;
    weightKg: string;
    codAmount: string;
    declaredValue: string | null;
    totalCharge: string;
    productName: string | null;
    productType: string | null;
    receiverRelation: string | null;
    packaging: string | null;
    originBranchCode: string | null;
    contents: string | null;
    intake: string;
  }>(
    `SELECT "merchantId", channel, "senderName", "weightKg", "codAmount", "declaredValue", "totalCharge", "productName", "productType", "receiverRelation", packaging, "originBranchCode", contents, intake FROM parcels WHERE "trackingId" = $1`,
    [trackingId],
  );
  return row;
}

test("operations New order: product priced like the booking, no old fields, Banking without weight / COD, inline phone errors", async ({ browser }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  const ops = await signedIn(browser, OPS, /\/courier-operation/, errors);
  await opsNav(ops, "ecommerce");
  await ops.click('[data-action="newEcommerce"]');
  const fields = ops.locator("#modalFields");
  await expect(ops.locator("#modalTitle")).toHaveText("Create e-commerce order");

  // ── The old fields are gone; places start at "Choose …" ──
  for (const id of ["bkLevel", "bkIntake", "bkHub", "bkCod", "bkLine"]) await expect(ops.locator(`#${id}`)).toHaveCount(0);
  for (const text of ["Service level", "Service line", "Packaging", "Receiver relationship", "Origin branch", "Shipment type", "Document type", "Intake"]) await expect(fields).not.toContainText(text);
  await expect(ops.locator("#bkDistrict")).toHaveValue("");
  await expect(ops.locator("#bkZone")).toHaveValue("");
  await expect(ops.locator("#bkArea")).toHaveValue("");

  // ── Inline errors: +880 phone, required fields ──
  await expect(fields.locator(".df-phone #bkPhone")).toHaveCount(1); // fixed +880 prefix
  await ops.fill("#bkPhone", "0234");
  await ops.locator("#bkPhone").blur();
  await expect(fields.locator(".df-field-error", { hasText: "start with 1" })).toBeVisible();
  await ops.click("#modalSubmit");
  await expect(toast(ops)).toContainText("Check the highlighted fields");
  await expect(fields.locator(".df-field-error", { hasText: "Choose the merchant account" })).toBeVisible();
  await expect(fields.locator(".df-field-error", { hasText: "Choose the delivery district" })).toBeVisible();

  // ── An e-commerce booking with a Document-type product and 7.5 kg: the form price is the booked price ──
  await chooseOption(ops, "#bkMerchant", shop.name);
  await ops.fill("#bkRecipient", `E2E Form ${fx.stamp}`);
  await ops.fill("#bkPhone", "01812000001");
  await ops.selectOption("#bkDistrict", "Dhaka Central");
  await ops.selectOption("#bkZone", "Dhanmondi");
  await ops.fill("#bkStreet", "Road 7, Flat 3B");
  await expect(ops.locator("#bkSvcProduct option", { hasText: "Papers · Document" })).toHaveCount(1);
  await ops.selectOption("#bkSvcProduct", "Papers");
  await ops.fill("#bkWeight", "7.5");
  // One first-mile select (no separate intake), COD with its own amount (unticked by default here).
  await expect(ops.locator("#bkSvcCod")).not.toBeChecked();
  await expect(ops.locator("#bkSvcCodAmount")).toBeHidden();
  const price = ops.locator("#bkPrice [data-price-breakdown]");
  await expect(price).toContainText("What you send: Document", { timeout: 15_000 });
  await ops.waitForTimeout(500); // the last debounced quote
  const shown = await taka(price.locator("[data-price-total]"));
  await ops.click("#modalSubmit");
  await expect(toast(ops)).toContainText(`booked for ${shop.name}`);
  const trackingId = (await toast(ops).textContent())!.match(TRACKING)![0];
  // The new parcel's drawer opens, with the PDF label.
  await expect(ops.locator("#parcelDrawerTitle")).toHaveText(trackingId);
  await expect(ops.locator(`#parcelDrawer [data-drawer-labels="${trackingId}"]`)).toHaveText("Print label (PDF)");
  const booked = await parcelRow(trackingId);
  expect(Number(booked.totalCharge)).toBe(shown);
  expect(booked).toMatchObject({ productName: "Papers", productType: "DOCUMENT", receiverRelation: null, packaging: null, originBranchCode: null, channel: "OPERATIONS" });
  expect(Number(booked.weightKg)).toBe(7.5);

  // ── Banking & Financial: no weight, no COD; its own product list ──
  await opsNav(ops, "banking");
  await ops.click('[data-action="newDocument"]');
  await expect(ops.locator("#modalTitle")).toHaveText("Create Banking & Financial order");
  await chooseOption(ops, "#bkMerchant", bank.name);
  await expect(ops.locator("#bkSvcProduct option", { hasText: "Bank Statements · Document" })).toHaveCount(1, { timeout: 15_000 });
  await expect(ops.locator("#bkWeight")).toBeHidden();
  await expect(ops.locator("#bkSvcCod")).toHaveCount(0);
  await expect(ops.locator("#bkSvcCodAmount")).toHaveCount(0);
  await expect(fields.locator('label[for="bkContents"]')).toHaveText("Item description (optional)");
  await ops.fill("#bkRecipient", `E2E Form Bank ${fx.stamp}`);
  await ops.fill("#bkPhone", "01812000002");
  await ops.selectOption("#bkDistrict", "Dhaka Central");
  await ops.selectOption("#bkZone", "Dhanmondi");
  await ops.fill("#bkStreet", "Level 4, Tower 2");
  await ops.selectOption("#bkSvcProduct", "Bank Statements");
  await expect(ops.locator("#bkPrice [data-price-breakdown]")).toBeVisible({ timeout: 15_000 });
  await ops.waitForTimeout(500);
  const bankShown = await taka(ops.locator("#bkPrice [data-price-total]"));
  await ops.click("#modalSubmit");
  await expect(toast(ops)).toContainText(`booked for ${bank.name}`);
  const bankId = (await toast(ops).textContent())!.match(TRACKING)![0];
  const bankParcel = await parcelRow(bankId);
  expect(Number(bankParcel.totalCharge)).toBe(bankShown);
  expect(Number(bankParcel.codAmount)).toBe(0);
  expect(bankParcel).toMatchObject({ productName: "Bank Statements", receiverRelation: null, originBranchCode: null, packaging: null });
  expect(errors).toEqual([]);
  await ops.context().close();
});

test("operations walk-in sender: a customer parcel without a merchant, on the Customer package", async ({ browser }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  const ops = await signedIn(browser, OPS, /\/courier-operation/, errors);
  await opsNav(ops, "customerParcels");
  await ops.click('[data-action="newWalkIn"]');
  await expect(ops.locator("#modalTitle")).toHaveText("Create walk-in order");
  await expect(ops.locator("#bkMerchant")).toBeHidden();
  const senderPhone = `019${String(Date.now()).slice(-8)}`;
  const sender = `E2E Walk-in ${fx.stamp}`;
  await ops.fill("#bkSenderName", sender);
  await ops.fill("#bkSenderPhone", senderPhone);
  await ops.selectOption("#bkPickupDistrict", "Dhaka North");
  await ops.selectOption("#bkPickupZone", "Gulshan");
  await ops.fill("#bkPickupStreet", "House 5, Road 2");
  await ops.fill("#bkRecipient", `E2E Walk-in Receiver ${fx.stamp}`);
  await ops.fill("#bkPhone", "01812000003");
  await ops.selectOption("#bkDistrict", "Dhaka Central");
  await ops.selectOption("#bkZone", "Dhanmondi");
  await ops.fill("#bkStreet", "Road 9, Flat 2A");
  await ops.fill("#bkWeight", "12");
  const price = ops.locator("#bkPrice [data-price-breakdown]");
  await expect(price).toBeVisible({ timeout: 15_000 });
  await ops.waitForTimeout(500);
  const shown = await taka(price.locator("[data-price-total]"));
  await ops.click("#modalSubmit");
  await expect(toast(ops)).toContainText(`booked for ${sender} (walk-in)`);
  const trackingId = (await toast(ops).textContent())!.match(TRACKING)![0];
  fx.adoptParcel(trackingId, senderPhone);
  await expect(ops.locator("#parcelDrawerTitle")).toHaveText(trackingId);
  const parcel = await parcelRow(trackingId);
  expect(parcel).toMatchObject({ merchantId: null, channel: "OPERATIONS", senderName: sender });
  expect(Number(parcel.weightKg)).toBe(12);
  expect(Number(parcel.totalCharge)).toBe(shown);
  expect(errors).toEqual([]);
  await ops.context().close();
});

test("the operations booking dialog fits a 390 px phone", async ({ browser }) => {
  const errors: string[] = [];
  const ops = await signedIn(browser, OPS, /\/courier-operation/, errors, { width: 390, height: 844 });
  // The page's "New e-commerce order" button opens this (the menu is collapsed on phones).
  await ops.evaluate(() => (window as unknown as { DFOps: { modals: Record<string, () => void> } }).DFOps.modals.newEcommerce());
  await chooseOption(ops, "#bkMerchant", shop.name);
  await expect(ops.locator("#bkSvcProduct option", { hasText: "Papers" })).toHaveCount(1, { timeout: 15_000 });
  await expectNoOverflow(ops, "#modalBackdrop .modal");
  await ops.context().close();
});

test("e-commerce merchant order form: product priced like the booking, COD apart from value, weight above 5 kg, no old fields", async ({ browser }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  const page = await signedIn(browser, shopOwner, /\/ecommerce-merchant/, errors);
  await page.click('#navigation [data-page="Orders"]');
  await page.click("#createOrder");
  await expect(page.locator("#orderModal")).toHaveClass(/open/);
  const form = page.locator("#orderForm");
  for (const id of ["orderType", "merchantRelation", "merchantPackaging", "merchantPickupZone", "merchantServiceLevel", "merchantDocumentType", "merchantBranchCode"]) await expect(page.locator(`#${id}`)).toHaveCount(0);
  for (const text of ["Receiver relationship", "Packaging", "Pickup zone", "Shipment type", "Order value"]) await expect(form).not.toContainText(text);
  await expect(form.locator('label[for="customerName"]')).toHaveText("Recipient name");
  await expect(page.locator("#merchantDistrict")).toHaveValue("");
  await expect(page.locator("#merchantZone")).toHaveValue("");
  // Weight is a number (0.01–50, 0.5 by default).
  await expect(page.locator("#merchantWeight")).toHaveAttribute("type", "number");
  await expect(page.locator("#merchantWeight")).toHaveValue("0.5");

  // ── Inline errors (+880 phone) block the booking ──
  await page.fill("#customerPhone", "123");
  await page.click('#orderForm button[type="submit"]');
  await expect(form.locator(".df-field-error", { hasText: "10 digits" })).toBeVisible();
  await expect(form.locator(".df-field-error", { hasText: "Enter the recipient's name" })).toBeVisible();
  await expect(page.locator("#orderModal")).toHaveClass(/open/);

  // ── Book: Document-type product, 12 kg, COD ৳900 and a product value of ৳2,000 ──
  await page.fill("#customerName", `E2E Form Buyer ${fx.stamp}`);
  await page.fill("#customerPhone", "01812000004");
  await page.selectOption("#merchantDistrict", "Dhaka Central");
  await page.selectOption("#merchantZone", "Dhanmondi");
  await page.fill("#deliveryAddress", "House 7, Road 2");
  await expect(page.locator("#merchantProduct option", { hasText: "Papers · Document" })).toHaveCount(1, { timeout: 15_000 });
  await page.selectOption("#merchantProduct", "Papers");
  await page.fill("#merchantWeight", "12");
  await page.fill("#orderAmount", "2000");
  await expect(page.locator("#merchantSvcCod")).toBeChecked();
  await page.locator("#merchantSvcCod").uncheck();
  await expect(page.locator("#merchantSvcCodAmount")).toBeHidden();
  await page.locator("#merchantSvcCod").check();
  await page.click('#orderForm button[type="submit"]');
  await expect(form.locator(".df-field-error", { hasText: "Enter the cash to collect" })).toBeVisible();
  await page.fill("#merchantSvcCodAmount", "900");
  const price = page.locator("#merchantPriceHint [data-price-breakdown]");
  await expect(price).toContainText("What you send: Document", { timeout: 15_000 });
  await expect(price).toContainText("COD fee");
  await page.waitForTimeout(500);
  const shown = await taka(price.locator("[data-price-total]"));
  await page.click('#orderForm button[type="submit"]');
  await expect(toast(page)).toContainText(/created · delivery charge ৳/);
  const trackingId = (await toast(page).textContent())!.match(TRACKING)![0];
  // The order's details open, with the PDF label.
  await expect(page.locator(`#merchantHistoryBackdrop [data-df-label="${trackingId}"]`)).toHaveText("Print label (PDF)");
  const parcel = await parcelRow(trackingId);
  expect(Number(parcel.totalCharge)).toBe(shown);
  expect(Number(parcel.codAmount)).toBe(900);
  expect(Number(parcel.declaredValue)).toBe(2000);
  expect(Number(parcel.weightKg)).toBe(12);
  expect(parcel).toMatchObject({ productName: "Papers", productType: "DOCUMENT", receiverRelation: null, packaging: null, originBranchCode: null });
  expect(errors).toEqual([]);
  await page.context().close();
});

test("Banking & Financial request form: no weight, no COD, its products, priced like the booking", async ({ browser }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  const page = await signedIn(browser, bankOwner, /\/banking-merchant/, errors);
  await page.click('#navigation [data-page="Orders"]');
  await page.click("#createOrder");
  const form = page.locator("#orderForm");
  for (const id of ["merchantWeight", "merchantSvcCod", "merchantSvcCodAmount", "orderType", "merchantBranchCode", "merchantDocumentType", "merchantRelation", "merchantPackaging", "merchantPickupZone", "merchantServiceLevel"])
    await expect(page.locator(`#${id}`)).toHaveCount(0);
  for (const text of ["Origin branch", "Receiver relationship", "Secure packaging", "Document type", "Service type", "Weight", "Same day"]) await expect(form).not.toContainText(text);
  await expect(form.locator('label[for="customerName"]')).toHaveText("Recipient name");
  await expect(page.locator("#merchantAddressType")).toHaveValue("Office");
  await expect(page.locator("#merchantProduct option", { hasText: "Bank Statements · Document" })).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator("#merchantProduct option", { hasText: "Fashion & Apparel" })).toHaveCount(0);
  await page.fill("#customerName", `E2E Form Recipient ${fx.stamp}`);
  await page.fill("#customerPhone", "1812000005");
  await page.selectOption("#merchantDistrict", "Dhaka Central");
  await page.selectOption("#merchantZone", "Dhanmondi");
  await page.fill("#deliveryAddress", "Level 3, Tower 1");
  await page.selectOption("#merchantProduct", "Bank Statements");
  const price = page.locator("#merchantPriceHint [data-price-breakdown]");
  await expect(price).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500);
  const shown = await taka(price.locator("[data-price-total]"));
  await page.click('#orderForm button[type="submit"]');
  await expect(toast(page)).toContainText(/created · delivery charge ৳/);
  const trackingId = (await toast(page).textContent())!.match(TRACKING)![0];
  const parcel = await parcelRow(trackingId);
  expect(Number(parcel.totalCharge)).toBe(shown);
  expect(Number(parcel.codAmount)).toBe(0);
  expect(parcel).toMatchObject({ productName: "Bank Statements", receiverRelation: null, packaging: null, originBranchCode: null });
  expect(errors).toEqual([]);
  await page.context().close();
});

test("the merchant order dialogs fit a 390 px phone", async ({ browser }) => {
  for (const [account, panel] of [
    [shopOwner, /\/ecommerce-merchant/],
    [bankOwner, /\/banking-merchant/],
  ] as const) {
    const errors: string[] = [];
    const page = await signedIn(browser, account, panel, errors, { width: 390, height: 844 });
    await page.evaluate(() => (window as unknown as { renderPage: (p: string) => void }).renderPage("Orders"));
    await page.click("#createOrder");
    await expect(page.locator("#merchantProduct option").nth(1)).toBeAttached({ timeout: 15_000 });
    await page.selectOption("#merchantDistrict", "Dhaka Central");
    await expectNoOverflow(page, "#orderModal .modal");
    await page.context().close();
  }
});
