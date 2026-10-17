import { type Browser, type Page } from "@playwright/test";
import { Fixtures, expect, test, type TempRider, type TempUser } from "./support";

// The operations manager and the rider are temporary, and the customer who signs up is deleted
// afterwards with the parcel, its COD and messages (support.ts).
let OPS: TempUser;

const fx = new Fixtures();
let riderAccount: TempRider;
test.beforeAll(async () => {
  riderAccount = await fx.rider("Gulshan Sorting Hub");
  OPS = await fx.staff("OPS_MANAGER");
});
test.afterAll(() => fx.cleanup());

async function open(browser: Browser, path: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("dialog", dialog => dialog.accept());
  await page.goto(path);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return page;
}

async function signIn(page: Page, identifier: string, password: string) {
  await page.goto("/login");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.fill("#loginIdentity", identifier);
  await page.fill("#loginPassword", password);
  await page.click('form[data-form="login"] button[type="submit"]');
}

const toast = (page: Page) => page.locator("#toast");

/** Selects the first option whose text contains `text`. */
async function chooseOption(page: Page, selector: string, text: string) {
  const value = await page.locator(`${selector} option`, { hasText: text }).first().getAttribute("value");
  await page.selectOption(selector, value!);
}

test("customer books, operations dispatches, rider delivers with OTP", async ({ browser }) => {
  // ── Customer signs up with an SMS code ──
  const customer = await open(browser, "/signup");
  const phone = `019${String(Date.now()).slice(-8)}`;
  await customer.fill("#signupName", "E2E Customer");
  await customer.fill("#signupPhone", phone);
  await customer.fill("#signupEmail", `e2e${Date.now()}@example.com`);
  await customer.fill("#signupPassword", "E2ePassword2026");
  await customer.click('form[data-form="signup"] button[type="submit"]');
  const hint = customer.locator("#signupOtp + small");
  await expect(hint).toContainText("Development code:");
  const code = (await hint.textContent())!.match(/\d{6}/)![0];
  await customer.fill("#signupOtp", code);
  await customer.click('form[data-form="signup"] button[type="submit"]');
  await expect(customer).toHaveURL(/\/account$/);
  await fx.adoptUser(phone);

  // ── Customer books a pickup through the request wizard ──
  await customer.goto("/request");
  const form = customer.locator('form[data-form="request"]');
  await customer.fill("#requestName", "E2E Customer");
  await customer.fill("#requestPhone", phone);
  await customer.selectOption("#requestPickupDistrict", "Dhaka North");
  await customer.selectOption("#requestPickupZone", "Gulshan");
  await customer.fill("#requestPickup", "House 5, Road 2");
  await form.getByRole("button", { name: "Continue" }).click();
  await customer.fill("#requestReceiver", "Nabila Ahmed");
  await customer.fill("#requestReceiverPhone", "01812000000");
  await customer.selectOption("#requestDistrict", "Dhaka Central");
  await customer.selectOption("#requestZone", "Dhanmondi");
  await customer.selectOption("#requestArea", { index: 1 });
  await customer.fill("#requestDelivery", "Road 7, Flat 3B");
  await form.getByRole("button", { name: "Continue" }).click();
  // Express (same day) is offered inside the same district only: Gulshan → Dhanmondi are both Dhaka.
  await customer.selectOption("#requestServiceLevel", "EXPRESS");
  await customer.selectOption("#requestWeight", "2");
  await customer.check("#requestCodEnabled");
  await customer.fill("#requestCodAmount", "1500");
  while (!(await form.locator('button[type="submit"]').isVisible())) await form.getByRole("button", { name: "Continue" }).click();
  await form.locator('button[type="submit"]').click();
  await expect(customer).toHaveURL(/\/track\/PP-\d{6}-[0-9A-Z]{5}/);
  const trackingId = decodeURIComponent(new URL(customer.url()).pathname.split("/track/")[1]);
  // Priced by the Customer default package (route, weight, Express, COD fee).
  await expect(toast(customer)).toContainText(/৳[0-9]+/);
  await expect(customer.locator("#trackingResult")).toContainText("Pending operations confirmation");

  // ── Operations accepts and assigns the rider ──
  const ops = await open(browser, "/login");
  await signIn(ops, OPS.login, OPS.password);
  await expect(ops).toHaveURL(/\/courier-operation/);
  await ops.waitForSelector("html.legacy-ready", { state: "attached" });
  await ops.click('#navigation [data-page="Customer parcels"]');
  await ops.click(`[data-customer-confirm="${trackingId}"]`);
  await chooseOption(ops, "#assignRider", riderAccount.code);
  await ops.click("#modalSubmit");
  await expect(toast(ops)).toContainText(`${trackingId} assigned to ${riderAccount.code}`);

  // ── Rider collects it and hands it to a hub ──
  const rider = await open(browser, "/login");
  await signIn(rider, riderAccount.login, riderAccount.password);
  await expect(rider).toHaveURL(/\/rider/);
  await rider.waitForSelector("html.legacy-ready", { state: "attached" });
  await rider.click('#navigation [data-page="Pickup queue"]');
  await rider.click(`[data-pickup="${trackingId}"]`);
  await rider.selectOption("#pickupOutcome", { label: "Pickup collected — submit to hub" });
  await rider.selectOption("#pickupHub", { label: "Gulshan Sorting Hub" });
  await rider.click("#submitAction");
  await expect(toast(rider)).toContainText("handed to Gulshan Sorting Hub");

  // ── Operations assigns the delivery ──
  await ops.reload();
  await ops.waitForSelector("html.legacy-ready", { state: "attached" });
  await ops.evaluate(id => (window as unknown as { openModal: (k: string, id: string) => void }).openModal("assign", id), trackingId);
  await chooseOption(ops, "#assignRider", riderAccount.code);
  await ops.click("#modalSubmit");
  await expect(toast(ops)).toContainText("for delivery");

  // ── Rider delivers with the recipient's code and collects COD ──
  await rider.reload();
  await rider.waitForSelector("html.legacy-ready", { state: "attached" });
  await rider.click('#navigation [data-page="Deliveries"]');
  await rider.click(`[data-delivery="${trackingId}"]`);
  await rider.selectOption("#proofMethod", "OTP");
  const otpHint = rider.locator("#otpProof small");
  await expect(otpHint).toContainText("Development code:");
  await rider.fill("#deliveryOtp", (await otpHint.textContent())!.match(/\d{4}/)![0]);
  await rider.click("#submitAction");
  await expect(toast(rider)).toContainText(`${trackingId} delivered`);

  // ── Customer sees it delivered ──
  await customer.goto(`/track/${trackingId}`);
  await customer.reload();
  await customer.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(customer.locator("#trackingResult")).toContainText("Your shipment has been delivered");
  await expect(customer.locator("#trackingResult")).toContainText("OTP proof recorded");
});

test("panels require the right role", async ({ browser }) => {
  const page = await open(browser, "/login");
  await page.goto("/rider");
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, OPS.login, OPS.password);
  await expect(page).toHaveURL(/\/courier-operation/);
  await page.goto("/super-admin");
  await expect(page).toHaveURL(/\/login$/);
});
