import { type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { Fixtures, expect, test, type TempMerchant, type TempRider, type TempUser } from "./support";

/**
 * The two merchant panels on the real API: booking, tracking, cancelling, billing, API keys
 * and webhooks. Needs the API and the web app. The merchants (e-commerce with an owner and a
 * staff member, documents with an owner) and the delivery rider are temporary: created in the
 * database before the tests and deleted afterwards with everything they produced (support.ts).
 * The operations manager and finance staff are temporary too.
 */
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
const toast = (page: Page) => page.locator("#toast");

const fx = new Fixtures();
let shop: TempMerchant;
let shopOwner: TempUser;
let shopStaff: TempUser;
let bank: TempMerchant;
let bankOwner: TempUser;
let rider: TempRider;
let OPS: TempUser;
let FINANCE: TempUser;

test.beforeAll(async () => {
  shop = await fx.merchant({ type: "ECOMMERCE", plan: true });
  shopOwner = await fx.member(shop, "MERCHANT_OWNER");
  shopStaff = await fx.member(shop, "MERCHANT_STAFF");
  bank = await fx.merchant({ type: "BANKING_FINANCIAL", plan: true });
  bankOwner = await fx.member(bank, "MERCHANT_OWNER");
  rider = await fx.rider("Gulshan Sorting Hub");
  OPS = await fx.staff("OPS_MANAGER");
  FINANCE = await fx.staff("FINANCE");
});
test.afterAll(() => fx.cleanup());

/** Signs in through the website and waits for the panel the account lands on. */
async function signIn(browser: Browser, user: { login: string; password: string }, panel: RegExp) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    // Expected: the website's session check before signing in (401) and the duplicate-reference booking (409).
    if (message.type() === "error" && !/status of (401|409)/.test(message.text())) errors.push(message.text());
  });
  page.on("dialog", dialog => dialog.accept());
  for (let attempt = 0; ; attempt++) {
    await page.goto("/login");
    await page.waitForSelector("html.legacy-ready", { state: "attached" });
    await page.fill("#loginIdentity", user.login);
    await page.fill("#loginPassword", user.password);
    await page.click('form[data-form="login"] button[type="submit"]');
    const ok = await page.waitForURL(panel, { timeout: 15_000 }).then(() => true, () => false);
    if (ok) break;
    // Sign-in is rate limited per IP (shared with other suites on this machine).
    if (attempt >= 2 || !/too many/i.test(await page.content())) await expect(page).toHaveURL(panel);
    await page.waitForTimeout(61_000);
  }
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return { page, errors };
}

async function token(request: APIRequestContext, identifier: string, password: string) {
  const res = await request.post("/api/v1/auth/login", { data: { identifier, password } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).accessToken as string;
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function nav(page: Page, name: string) {
  await page.click(`#navigation [data-page="${name}"]`);
  await expect(page.locator("#breadcrumbPage")).toContainText(name === "Billing" ? "Billing" : name);
}

/** Fills the order modal's common fields. */
async function fillOrder(page: Page, recipient: string, phone: string) {
  await page.click("#createOrder");
  await expect(page.locator("#orderModal")).toHaveClass(/open/);
  await page.fill("#customerName", recipient);
  await page.fill("#customerPhone", phone);
  await page.fill("#deliveryAddress", "House 7, Road 2");
  await page.selectOption("#merchantDistrict", "Dhaka Central");
  await page.selectOption("#merchantZone", "Dhanmondi");
  await page.selectOption("#merchantArea", "Dhanmondi Road 7");
}

async function createdId(page: Page) {
  await expect(toast(page)).toContainText(/created · delivery charge ৳/);
  return (await toast(page).textContent())!.match(/PP-\d{6}-[0-9A-Z]{4,5}/)![0];
}

/** Takes a booked parcel through pickup and a signed delivery on the API. */
async function deliver(request: APIRequestContext, trackingId: string) {
  const ops = await token(request, OPS.login, OPS.password);
  const assign = await request.post(`/api/v1/parcels/${trackingId}/assign-pickup`, { headers: auth(ops), data: { riderId: rider.riderId } });
  expect(assign.ok(), await assign.text()).toBeTruthy();
  const riderToken = await token(request, rider.login, rider.password);
  const pickup = await request.post(`/api/v1/rider/parcels/${trackingId}/pickup`, { headers: auth(riderToken), data: { outcome: "COLLECTED_DELIVER_DIRECT" } });
  expect(pickup.ok(), await pickup.text()).toBeTruthy();
  const delivered = await request.post(`/api/v1/rider/parcels/${trackingId}/delivery`, {
    headers: auth(riderToken),
    data: { outcome: "DELIVERED", receivedBy: "Front desk", proof: { method: "SIGNATURE", image: PNG }, codCollected: 0 },
  });
  expect(delivered.ok(), await delivered.text()).toBeTruthy();
  return delivered.json();
}

test("e-commerce merchant: identity, booking, tracking, cancelling and the dashboard", async ({ browser }) => {
  const { page, errors } = await signIn(browser, shopOwner, /\/ecommerce-merchant/);
  await expect(page.locator(".workspace-meta strong")).toHaveText(shop.name);
  await expect(page.locator(".user-profile .profile-meta strong")).toHaveText(shopOwner.name);
  await expect(page.locator(".user-profile .profile-meta small")).toHaveText("Store owner");
  await expect(page.locator("#mainContent h1")).toContainText(shopOwner.name.split(" ")[0]);

  // ── Book an order: priced on the server from the service package, with a live breakdown ──
  await nav(page, "Orders");
  const recipient = `E2E Buyer ${unique()}`;
  await fillOrder(page, recipient, "01812345678");
  await page.selectOption("#orderType", "E-commerce parcel");
  await page.fill("#orderAmount", "1250");
  // Express (same day) is offered inside the same district (Gulshan → Dhanmondi are both Dhaka).
  await page.selectOption("#merchantSvcSpeed", "EXPRESS");
  const breakdown = page.locator("#merchantPriceHint [data-price-breakdown]");
  await expect(breakdown).toContainText("Inside same district", { timeout: 10_000 });
  await expect(breakdown).toContainText("Express");
  await expect(breakdown).toContainText("COD fee");
  await expect(breakdown.locator("[data-price-total]")).toContainText("৳");
  await page.click('#orderForm button[type="submit"]');
  const trackingId = await createdId(page);
  await expect(page.locator("#orderModal")).not.toHaveClass(/open/);

  // ── Listed, searchable, with real tracking history ──
  await page.fill("#tableSearch", recipient);
  const row = page.locator(`#tableBody tr[data-merchant-record-id="${trackingId}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText("৳ 1,250");
  await expect(row).toContainText("Pending operations confirmation");
  await expect(page.locator(".page-table-panel .table-footer > span")).toContainText("Showing 1–1 of 1 orders");
  await row.locator("[data-merchant-history]").click();
  await expect(page.locator("#merchantHistoryBackdrop")).toContainText("Pickup request submitted");
  await expect(page.locator("#merchantHistoryBackdrop")).toContainText("Dhanmondi Road 7");
  await page.click("#closeMerchantHistory");

  // ── Shipments and pickup requests show it too ──
  await nav(page, "Shipments");
  await expect(page.locator(`#tableBody tr[data-merchant-record-id="${trackingId}"]`)).toContainText("Dhanmondi, Dhaka Central");
  await nav(page, "Pickup requests");
  await expect(page.locator("#tableBody")).toContainText(trackingId);
  await nav(page, "Customers");
  await expect(page.locator("#tableBody")).toContainText(recipient);

  // ── The dashboard counts it ──
  await nav(page, "Overview");
  const total = Number(await page.locator(".metrics .metric").first().locator(".metric-value").textContent());
  expect(total).toBeGreaterThanOrEqual(1);
  await expect(page.locator(".activity-list")).not.toContainText("Payout completed — ৳ 24,680");
  await page.selectOption("#chartPeriod", "This year");
  await expect(page.locator("svg.chart .chart-labels")).toContainText("Jan");

  // ── Cancel before operations confirm ──
  await nav(page, "Orders");
  await page.fill("#tableSearch", recipient);
  await row.locator("[data-df-cancel]").click();
  await expect(toast(page)).toContainText(`${trackingId} cancelled`);
  await expect(row).toContainText("Pickup cancelled");
  await expect(row.locator("[data-df-cancel]")).toHaveCount(0);

  // ── Global search opens an order by tracking ID ──
  await page.fill("#globalSearch", trackingId);
  await page.press("#globalSearch", "Enter");
  await expect(page.locator("#merchantHistoryBackdrop")).toContainText("Pickup cancelled");
  await page.keyboard.press("Escape");

  expect(errors).toEqual([]);
});

test("e-commerce merchant: batch import is idempotent and labels print real orders", async ({ browser }) => {
  const { page, errors } = await signIn(browser, shopOwner, /\/ecommerce-merchant/);
  await nav(page, "Orders");
  const tag = unique();
  const csv = `customer_name,phone,address,district,zone,item,shipment_type,order_value,cod_amount,delivery_service,weight_kg,order_ref\r\nBatch One ${tag},01812000101,"House 1, Road 1",Dhaka Central,Mirpur,Clothing,E-commerce parcel,900,900,Regular,1,B-${tag}-1\r\nBatch Two ${tag},01812000102,"House 2, Sector 4",Dhaka North,Uttara,Electronics,E-commerce parcel,1500,1500,Express,2,B-${tag}-2\r\nNo Zone ${tag},01812000103,"Somewhere unknown",Atlantis,,Book,E-commerce parcel,100,100,Regular,1,B-${tag}-3`;
  // The shared importer (shared/importer.js): check the file, then create the valid rows.
  const upload = async () => {
    await page.click("#merchantBulkImport");
    await page.setInputFiles("#dfiFile", { name: `batch-${tag}.csv`, mimeType: "text/csv", buffer: Buffer.from(csv) });
    await page.click('[data-dfi="check"]');
    await expect(page.locator("#dfiSummary")).toContainText("3 rows", { timeout: 30_000 });
  };
  await upload();
  await expect(page.locator('#dfiRows tr[data-row="4"]')).toContainText('unknown district "Atlantis"');
  await page.click('[data-dfi="commit"]');
  await expect(page.locator("#dfiResultText")).toContainText("2 orders created. 1 row not created.", { timeout: 30_000 });
  await page.click('[data-dfi="close"]:has-text("Done")');
  await page.fill("#tableSearch", tag);
  await expect(page.locator("#tableBody tr:visible")).toHaveCount(2);

  // The same file again books nothing new: every row is refused before anything is created.
  await upload();
  await expect(page.locator('#dfiSummary [data-count="errors"]')).toHaveText("3 with errors");
  await expect(page.locator('#dfiRows tr[data-row="2"]')).toContainText(`B-${tag}-1 was already booked as`);
  await expect(page.locator('[data-dfi="commit"]')).toBeDisabled();
  await page.keyboard.press("Escape");

  // Labels for the filtered orders, with the real merchant on them.
  await page.fill("#tableSearch", tag);
  await page.selectOption("#merchantPrintFormat", "label");
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.click("#merchantPrint")]);
  await popup.waitForLoadState();
  const html = await popup.content();
  expect(html).toContain(`Batch One ${tag}`);
  expect(html).toContain(shop.code);
  expect(html).not.toContain("MER-10048");
  expect((html.match(/class="invoice /g) || []).length).toBe(2);
  await popup.close();
  expect(errors).toEqual([]);
});

test("e-commerce merchant: API keys and webhooks", async ({ browser, api: request }) => {
  const { page, errors } = await signIn(browser, shopOwner, /\/ecommerce-merchant/);
  await nav(page, "API & Webhooks");
  await expect(page.locator("#mainContent")).not.toContainText("Request API key");

  // ── Create a key: shown once, then it authenticates API calls ──
  const name = `E2E key ${unique()}`;
  await page.fill("#dfApiKeyName", name);
  await page.click('#dfApiKeyForm button[type="submit"]');
  await expect(page.locator("#dfRevealedSecret")).toContainText("df_live_");
  const key = (await page.locator("#dfRevealedSecret").textContent())!.trim();
  const viaKey = await request.get("/api/v1/parcels?limit=1", { headers: auth(key) });
  expect(viaKey.status()).toBe(200);
  await page.click("[data-df-dismiss]");
  await expect(page.locator("#dfRevealedSecret")).toHaveCount(0);
  const keyRow = page.locator("#mainContent tr", { hasText: name });
  await expect(keyRow).toContainText("Active");

  // ── Revoke it ──
  await keyRow.locator("[data-df-revoke]").click();
  await expect(toast(page)).toContainText("revoked");
  await expect(keyRow).toContainText("Revoked");
  expect((await request.get("/api/v1/parcels?limit=1", { headers: auth(key) })).status()).toBe(401);

  // ── A webhook: secret shown once, test delivery recorded, then removed ──
  const url = `https://e2e-${unique().toLowerCase()}.example.invalid/hooks`;
  await page.fill("#dfWebhookUrl", url);
  await page.check('input[name="dfWebhookEvent"][value="shipment.delivered"]');
  await page.click('#dfWebhookForm button[type="submit"]');
  await expect(page.locator("#dfRevealedSecret")).toContainText("whsec_");
  const hook = page.locator("[data-df-hook-item]", { hasText: url });
  await expect(hook).toContainText("shipment.delivered");
  await hook.locator("[data-df-hook-test]").click();
  await expect(toast(page)).toContainText("Test event queued");
  await hook.locator("[data-df-hook-deliveries]").click();
  await expect(page.locator("#merchantHistoryBackdrop")).toContainText("webhook.test");
  await page.keyboard.press("Escape");
  await hook.locator("[data-df-hook-rotate]").click();
  await expect(page.locator("#dfRevealedSecret")).toContainText("whsec_");
  await hook.locator("[data-df-hook-delete]").click();
  await expect(toast(page)).toContainText("Webhook removed");
  await expect(hook).toHaveCount(0);

  // ── Settings reflect the workspace ──
  await nav(page, "Settings");
  await expect(page.locator("#tableBody")).toContainText(`${shop.name} · ${shop.pickupArea}, ${shop.pickupDistrict}`);
  await expect(page.locator("#tableBody tr", { hasText: "Service package" })).toContainText(/· version [0-9]+/);
  await page.locator("#tableBody tr", { hasText: "Team & permissions" }).locator("button").click();
  await expect(page.locator("#merchantHistoryBackdrop")).toContainText(shopOwner.name);
  await expect(page.locator("#merchantHistoryBackdrop")).toContainText(shopStaff.name);
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("e-commerce merchant: a staff member works in the same workspace without the owner's tools", async ({ browser }) => {
  const { page, errors } = await signIn(browser, shopStaff, /\/ecommerce-merchant/);
  await expect(page.locator(".workspace-meta strong")).toHaveText(shop.name);
  await expect(page.locator(".user-profile .profile-meta strong")).toHaveText(shopStaff.name);
  await expect(page.locator(".user-profile .profile-meta small")).toHaveText("Store staff");
  await nav(page, "Settings");
  await expect(page.locator("#tableBody tr", { hasText: "Team & permissions" })).toContainText("Managed by workspace owners");
  expect(errors).toEqual([]);
});

test("banking & financial merchant: redirect, document booking, delivery and invoices", async ({ browser, api: request }) => {
  // Merchant owners land on the e-commerce panel; a Banking & Financial merchant is sent to its own.
  const { page, errors } = await signIn(browser, bankOwner, /\/(ecommerce|banking)-merchant/);
  await expect(page).toHaveURL(/\/banking-merchant/);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(page.locator(".workspace-meta strong")).toHaveText(bank.name);
  // The old panel URL (/document-merchant) redirects.
  await page.goto("/document-merchant");
  await expect(page).toHaveURL(/\/banking-merchant$/);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });

  // ── New document request ──
  await nav(page, "Orders");
  const recipient = `E2E Receiver ${unique()}`;
  const reference = `E2E-${unique()}`;
  await fillOrder(page, recipient, "01912345678");
  // Banking & Financial services come from the package (no weight, no COD).
  await page.selectOption("#merchantSvcSpeed", "B2B");
  await page.fill("#merchantBranchCode", "MBP-DHK-07");
  await page.fill("#merchantReferenceNo", reference);
  await page.selectOption("#merchantRelation", "Reception");
  await expect(page.locator("#merchantPriceHint [data-price-breakdown]")).toContainText("Inside same district", { timeout: 10_000 });
  await page.click('#orderForm button[type="submit"]');
  const trackingId = await createdId(page);
  await page.fill("#tableSearch", recipient);
  const row = page.locator(`#tableBody tr[data-merchant-record-id="${trackingId}"]`);
  await expect(row).toContainText("Document delivery");

  // The same reference can't be booked twice.
  await fillOrder(page, recipient, "01912345678");
  await page.fill("#merchantReferenceNo", reference);
  await page.click('#orderForm button[type="submit"]');
  await expect(toast(page)).toContainText(`already booked as ${trackingId}`);
  await page.click("#cancelModal");

  // ── Delivered by a rider, then invoiced by finance ──
  await deliver(request, trackingId);
  await page.waitForTimeout(1100); // the invoice period must have ended
  const parcel = await (await request.get(`/api/v1/parcels/${trackingId}`, { headers: auth(await token(request, bankOwner.login, bankOwner.password)) })).json();
  const finance = await token(request, FINANCE.login, FINANCE.password);
  const invoice = await request.post("/api/v1/invoices", {
    headers: auth(finance),
    data: { merchantId: parcel.merchant.id, periodStart: new Date(new Date(parcel.deliveredAt).getTime() - 500).toISOString(), periodEnd: new Date(Date.now() - 100).toISOString() },
  });
  expect(invoice.ok(), await invoice.text()).toBeTruthy();
  const { number } = await invoice.json();

  await page.reload();
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await nav(page, "Orders");
  await page.fill("#tableSearch", recipient);
  await expect(row).toContainText("Delivered");
  await row.locator("[data-merchant-history]").click();
  await expect(page.locator("#merchantHistoryBackdrop")).toContainText("MBP-DHK-07");
  await expect(page.locator("#merchantHistoryBackdrop")).toContainText("Signature");
  await page.keyboard.press("Escape");

  // ── Billing: the real invoice, printable with its lines ──
  await nav(page, "Billing");
  const bill = page.locator(`#documentBillRows tr[data-document-bill="${number}"]`);
  await expect(bill).toContainText("Due");
  await expect(page.locator("#documentBillRows [data-bill-paid]")).toHaveCount(0);
  const [popup] = await Promise.all([page.waitForEvent("popup"), bill.locator("[data-bill-view]").click()]);
  await popup.waitForLoadState();
  const html = await popup.content();
  expect(html).toContain(number);
  expect(html).toContain(trackingId);
  expect(html).toContain("MBP-DHK-07");
  expect(html).toContain(bank.name);
  expect(html).not.toContain("MER-10124");
  await popup.close();

  await nav(page, "Payments");
  await expect(page.locator("#tableBody")).toContainText(number);
  expect(errors).toEqual([]);
});
