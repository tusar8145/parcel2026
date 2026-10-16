import { type Browser, type Page } from "@playwright/test";
import { DEMO_PASSWORD, Fixtures, expect, test, type TempMerchant, type TempRider } from "./support";

// Operations staff use the seeded staff accounts (*@deliveryfast.example). The merchant and the
// rider are temporary: created in the database before the tests and deleted afterwards with the
// parcel, its COD and the cash handover (support.ts).
const OPS = "ops@deliveryfast.example";
const HUB_GULSHAN = "hub.gulshan@deliveryfast.example";

const fx = new Fixtures();
let shop: TempMerchant;
let rider: TempRider;
test.beforeAll(async () => {
  shop = await fx.merchant({ type: "ECOMMERCE", label: "Ops Shop" });
  rider = await fx.rider("Gulshan Sorting Hub");
});
test.afterAll(() => fx.cleanup());

/** Signs in on a fresh browser context and waits for the panel. Collects page errors. */
async function signedIn(browser: Browser, identifier: string, panel: RegExp, errors: string[], password = DEMO_PASSWORD) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("dialog", dialog => dialog.accept());
  page.on("pageerror", error => errors.push(`${identifier}: ${error.message}`));
  page.on("console", message => {
    // The login page probes the refresh cookie before anyone is signed in (401).
    if (message.type() === "error" && !/status of 401/.test(message.text())) errors.push(`${identifier}: ${message.text()}`);
  });
  // Sign-in is rate limited per IP (10 a minute), shared with other suites on this machine.
  for (let attempt = 0; ; attempt++) {
    await page.goto("/login");
    await page.waitForSelector("html.legacy-ready", { state: "attached" });
    await page.fill("#loginIdentity", identifier);
    await page.fill("#loginPassword", password);
    await page.click('form[data-form="login"] button[type="submit"]');
    const ok = await page.waitForURL(panel, { timeout: 10_000 }).then(() => true, () => false);
    if (ok) break;
    if (attempt >= 2 || !/too many/i.test(await page.content())) await expect(page).toHaveURL(panel);
    await page.waitForTimeout(61_000);
  }
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return page;
}

async function reload(page: Page) {
  await page.reload();
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
}

const nav = (page: Page, name: string) => page.click(`#navigation [data-page="${name}"]`);
const toast = (page: Page) => page.locator("#toast");

/** Selects the first option whose text contains `text`. */
async function chooseOption(page: Page, selector: string, text: string) {
  const value = await page.locator(`${selector} option`, { hasText: text }).first().getAttribute("value");
  await page.selectOption(selector, value ?? { label: text });
}

test("merchant parcel through hubs, rider delivery with COD and the cash handover", async ({ browser }) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  const recipient = `Ops E2E ${Date.now().toString(36)}`;

  const riderLabel = `${rider.code} · ${rider.name}`;
  // ── Operations books an e-commerce order for the (temporary) merchant ──
  const ops = await signedIn(browser, OPS, /\/courier-operation/, errors);
  await nav(ops, "E-commerce operations");
  await ops.click('[data-action="newEcommerce"]');
  await chooseOption(ops, "#bkMerchant", shop.name);
  await ops.fill("#bkRecipient", recipient);
  await ops.fill("#bkPhone", "01812000000");
  await ops.selectOption("#bkDistrict", "Dhaka Central");
  await ops.selectOption("#bkZone", "Dhanmondi");
  await ops.fill("#bkStreet", "Road 7, Flat 3B");
  await ops.fill("#bkWeight", "1");
  await ops.fill("#bkCod", "750");
  await ops.click("#modalSubmit");
  await expect(toast(ops)).toContainText(`booked for ${shop.name}`);
  const trackingId = (await toast(ops).textContent())!.match(/PP-\d{6}-[0-9A-Z]{4,5}/)![0];
  // It's a merchant parcel: listed under E-commerce operations, not Customer parcels.
  await expect(ops.locator(`#shipmentBody tr[data-shipment-id="${trackingId}"]`)).toContainText(shop.name);
  await nav(ops, "Customer parcels");
  await expect(ops.locator(`#shipmentBody tr[data-shipment-id="${trackingId}"]`)).toHaveCount(0);

  // ── Dispatch assigns the pickup to the rider ──
  await nav(ops, "Dispatch");
  await ops.click('.heading-actions [data-action="assign"]');
  await ops.selectOption("#assignShipment", trackingId);
  await chooseOption(ops, "#assignRider", rider.code);
  await ops.click("#modalSubmit");
  await expect(toast(ops)).toContainText(`${trackingId} assigned to ${riderLabel} for pickup`);

  // ── The rider collects it and hands it to Gulshan Sorting Hub ──
  const riderPage = await signedIn(browser, rider.login, /\/rider/, errors, rider.password);
  await nav(riderPage, "Pickup queue");
  await riderPage.click(`[data-pickup="${trackingId}"]`);
  await riderPage.selectOption("#pickupOutcome", { label: "Pickup collected — submit to hub" });
  await riderPage.selectOption("#pickupHub", { label: "Gulshan Sorting Hub" });
  await riderPage.click("#submitAction");
  await expect(toast(riderPage)).toContainText("handed to Gulshan Sorting Hub");

  // ── Gulshan's hub operator transfers it to Dhanmondi ──
  const hub = await signedIn(browser, HUB_GULSHAN, /\/courier-operation/, errors);
  await nav(hub, "Hubs");
  await expect(hub.locator("#hubShipmentRows")).toContainText(trackingId);
  // Hub operators scan and receive only at their own hub.
  await expect(hub.locator("#hubScanLocation option")).toHaveText(["Gulshan Sorting Hub"]);
  await hub.fill('#hubTransferForm input[name="tracking"]', trackingId);
  await hub.selectOption('#hubTransferForm select[name="hub"]', { label: "Dhanmondi Hub" });
  await hub.click('#hubTransferForm button[type="submit"]');
  await expect(toast(hub)).toContainText(`${trackingId} transfer from Gulshan Sorting Hub to Dhanmondi Hub recorded`);
  await expect(hub.locator("#mainContent")).toContainText("Shipment transfer report");
  await expect(hub.locator("#mainContent table").last()).toContainText(trackingId);

  // ── Dhanmondi receives it (operations manager at the hub console) ──
  await reload(ops);
  await nav(ops, "Hubs");
  await ops.fill('#hubReceiveForm input[name="tracking"]', trackingId);
  await ops.fill('#hubReceiveForm input[name="sender"]', shop.name);
  await ops.fill('#hubReceiveForm input[name="recipient"]', recipient);
  await ops.selectOption('#hubReceiveForm select[name="line"]', "E-commerce");
  await ops.selectOption('#hubReceiveForm select[name="hub"]', { label: "Dhanmondi Hub" });
  await ops.click('#hubReceiveForm button[type="submit"]');
  await expect(toast(ops)).toContainText(`${trackingId} received at Dhanmondi Hub`);
  // Scanning it again at the same hub is recognised.
  await ops.fill("#hubScanId", trackingId);
  await ops.selectOption("#hubScanEvent", "Received at hub");
  await ops.selectOption("#hubScanLocation", { label: "Dhanmondi Hub" });
  await ops.click('#hubScanForm button[type="submit"]');
  await expect(ops.locator("#hubScanFeedback")).toContainText(`${trackingId} is already at Dhanmondi Hub`);

  // ── Dispatch assigns the delivery to the rider ──
  await nav(ops, "Dispatch");
  await ops.click('.heading-actions [data-action="assign"]');
  await ops.selectOption("#assignShipment", trackingId);
  await chooseOption(ops, "#assignRider", rider.code);
  await ops.click("#modalSubmit");
  await expect(toast(ops)).toContainText("for delivery");

  // ── The rider scans it out for delivery, then delivers with the code and collects COD ──
  await reload(riderPage);
  await nav(riderPage, "Scan parcel");
  await riderPage.fill("#trackingInput", trackingId);
  await riderPage.selectOption("#scanAction", "Mark out for delivery");
  await riderPage.click('#scanForm button[type="submit"]');
  await expect(toast(riderPage)).toContainText(`${trackingId} is out for delivery`);
  await expect(riderPage.locator("#scanHistory")).toContainText(trackingId);

  await nav(riderPage, "Deliveries");
  await expect(riderPage.locator("#tableBody")).toContainText("Out for delivery");
  await riderPage.click(`[data-delivery="${trackingId}"]`);
  await riderPage.selectOption("#proofMethod", "OTP");
  const otpHint = riderPage.locator("#otpProof small");
  await expect(otpHint).toContainText("Development code:");
  await riderPage.fill("#deliveryOtp", (await otpHint.textContent())!.match(/\d{4}/)![0]);
  await riderPage.click("#submitAction");
  await expect(toast(riderPage)).toContainText(`${trackingId} delivered`);

  // ── The rider's cash page shows the collection ──
  await nav(riderPage, "Earnings");
  const cash = riderPage.locator(".panel", { hasText: "Cash reconciliation" });
  await expect(cash).toContainText(`Cash collected · ${trackingId}`);
  await expect(cash).toContainText("৳ 750");

  // ── Gulshan receives the rider's cash ──
  await reload(hub);
  await nav(hub, "COD & finance");
  const row = hub.locator("#codRiderCash tr", { hasText: rider.code });
  await row.locator("[data-cod-receive]").click();
  await expect(hub.locator("#codCollections")).toContainText(trackingId);
  const expected = (await hub.locator("#modalDescription").textContent())!.match(/৳\s*([\d,.]+)/)![1].replace(/,/g, "");
  expect(Number(expected)).toBe(750);
  await hub.fill("#codAmount", expected);
  await hub.click("#modalSubmit");
  await expect(toast(hub)).toContainText(`received from ${riderLabel} at Gulshan Sorting Hub`);
  await expect(hub.locator("#mainContent")).toContainText(riderLabel);

  await reload(riderPage);
  await nav(riderPage, "Earnings");
  await expect(riderPage.locator(".panel", { hasText: "Cash reconciliation" })).toContainText("No COD cash to hand over");

  expect(errors).toEqual([]);
});

test("every operations page renders live data for each staff role", async ({ browser }) => {
  test.setTimeout(420_000);
  const pages = ["Overview", "Shipments", "Dispatch", "Exceptions", "Customer parcels", "E-commerce operations", "Document operations", "Riders", "Hubs", "Merchants", "COD & finance", "Analytics", "Settings"];
  for (const account of [OPS, HUB_GULSHAN, "finance@deliveryfast.example", "support@deliveryfast.example"]) {
    const errors: string[] = [];
    const page = await signedIn(browser, account, /\/courier-operation/, errors);
    for (const name of pages) {
      await nav(page, name);
      await expect(page.locator("#mainContent")).not.toContainText(/sample (records|shipments|data|register)|Demo data/i);
    }
    // Finance can't see riders (403 for the boot-time rider list is expected).
    expect(errors.filter(e => !/status of 403/.test(e))).toEqual([]);
    await page.context().close();
  }
});
