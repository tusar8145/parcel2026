import { type Browser, type Page } from "@playwright/test";
import { Fixtures, OPS_NAV, confirmDialog, expect, opsNav, test, type OpsArea, type TempMerchant, type TempRider, type TempUser } from "./support";

// Every account is temporary (support.ts): the operations manager, the Gulshan hub operator,
// finance and support staff, the merchant and the rider are created in the database before the
// tests and deleted afterwards with the parcel, its COD and the rider's handover slip.

const fx = new Fixtures();
let shop: TempMerchant;
let rider: TempRider;
let OPS: TempUser;
let HUB_GULSHAN: TempUser;
let FINANCE: TempUser;
let SUPPORT: TempUser;
test.beforeAll(async () => {
  shop = await fx.merchant({ type: "ECOMMERCE", label: "Ops Shop" });
  rider = await fx.rider("Gulshan Sorting Hub");
  OPS = await fx.staff("OPS_MANAGER");
  HUB_GULSHAN = await fx.staff("HUB_OPERATOR", "Gulshan Sorting Hub");
  FINANCE = await fx.staff("FINANCE");
  SUPPORT = await fx.staff("SUPPORT_AGENT");
});
test.afterAll(() => fx.cleanup());

/** Signs in on a fresh browser context and waits for the panel. Collects page errors. */
async function signedIn(browser: Browser, account: { login: string; password: string }, panel: RegExp, errors: string[]) {
  const { login: identifier, password } = account;
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

test("merchant parcel through hubs, rider delivery with COD and the handover slip", async ({ browser }) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  const recipient = `Ops E2E ${Date.now().toString(36)}`;

  const riderLabel = `${rider.code} · ${rider.name}`;
  // ── Operations books an e-commerce order for the (temporary) merchant ──
  const ops = await signedIn(browser, OPS, /\/courier-operation/, errors);
  await opsNav(ops, "ecommerce");
  await ops.click('[data-action="newEcommerce"]');
  await chooseOption(ops, "#bkMerchant", shop.name);
  await ops.fill("#bkRecipient", recipient);
  await ops.fill("#bkPhone", "01812000000");
  await ops.selectOption("#bkDistrict", "Dhaka Central");
  await ops.selectOption("#bkZone", "Dhanmondi");
  await ops.fill("#bkStreet", "Road 7, Flat 3B");
  await ops.fill("#bkWeight", "1");
  await ops.check("#bkSvcCod");
  await ops.fill("#bkSvcCodAmount", "750");
  await ops.click("#modalSubmit");
  await expect(toast(ops)).toContainText(`booked for ${shop.name}`);
  const trackingId = (await toast(ops).textContent())!.match(/(?:EP|FD|CP|PP)-\d{6}-[0-9A-Z]{4,5}/)![0];
  // The new parcel's drawer opens (details, price, "Print label (PDF)"); closed to work the tables.
  await expect(ops.locator("#parcelDrawerTitle")).toHaveText(trackingId);
  await ops.click("#parcelDrawerClose");
  // It's a merchant parcel: listed under E-commerce operations, not Customer parcels.
  await expect(ops.locator(`#shipmentBody tr[data-shipment-id="${trackingId}"]`)).toContainText(shop.name);
  await opsNav(ops, "customerParcels");
  await expect(ops.locator(`#shipmentBody tr[data-shipment-id="${trackingId}"]`)).toHaveCount(0);

  // ── New orders: accept and assign the pickup rider (the row's next action) ──
  await opsNav(ops, "newOrders");
  await ops.fill("#shipmentSearch", trackingId);
  await ops.locator(`#shipmentBody tr[data-shipment-id="${trackingId}"] .button-primary`, { hasText: "Accept & assign rider" }).click();
  await expect(ops.locator("#assignShipment")).toHaveValue(trackingId);
  await chooseOption(ops, "#assignRider", rider.code);
  await ops.click("#modalSubmit");
  await expect(toast(ops)).toContainText(`${trackingId} assigned to ${riderLabel} for pickup`);

  // ── The rider collects it and hands it to Gulshan Sorting Hub ──
  const riderPage = await signedIn(browser, rider, /\/rider/, errors);
  await nav(riderPage, "Pickup queue");
  await riderPage.click(`[data-pickup="${trackingId}"]`);
  await riderPage.selectOption("#pickupOutcome", { label: "Pickup collected — submit to hub" });
  await riderPage.selectOption("#pickupHub", { label: "Gulshan Sorting Hub" });
  await riderPage.click("#submitAction");
  await expect(toast(riderPage)).toContainText("handed to Gulshan Sorting Hub");

  // ── Gulshan's hub operator finds it at their hub, and it moves on to Dhanmondi (Transfers' bags and
  //    manifests do this in the panel; here the status change is made through the API) ──
  const hub = await signedIn(browser, HUB_GULSHAN, /\/courier-operation/, errors);
  await opsNav(hub, "hubAtHub");
  await hub.fill("#listSearch-hub-now", trackingId);
  await expect(hub.locator(`[data-list="hub-now"] tr[data-shipment-id="${trackingId}"]`)).toBeVisible({ timeout: 20_000 });
  // Hub operators receive only at their own hub.
  await opsNav(hub, "hubReceive");
  await expect(hub.locator("#rdHub option")).toHaveText(["Gulshan Sorting Hub"]);
  const dhanmondi = await hub.evaluate(async () => {
    const DF = (window as unknown as { DF: { state: { hubs: { id: string; name: string }[] } } }).DF;
    return DF.state.hubs.find(h => h.name === "Dhanmondi Hub")!.id;
  });
  await hub.evaluate(
    ([id, to]) => (window as unknown as { DF: { api: (p: string, i: unknown) => Promise<unknown> } }).DF.api(`/parcels/${id}/status`, { method: "POST", body: { status: "IN_TRANSIT", hubId: to } }),
    [trackingId, dhanmondi] as const,
  );

  // ── Dhanmondi receives it at the receive desk (operations manager) ──
  await reload(ops);
  await opsNav(ops, "hubReceive");
  await ops.selectOption("#rdHub", { label: "Dhanmondi Hub" });
  await ops.fill("#rdCode", trackingId);
  await ops.press("#rdCode", "Enter");
  await expect(ops.locator("#rdFeedback")).toContainText(`${trackingId} received at Dhanmondi Hub`, { timeout: 20_000 });
  // Scanning it again at the same hub is recognised.
  await ops.fill("#rdCode", trackingId);
  await ops.press("#rdCode", "Enter");
  await expect(ops.locator("#rdFeedback")).toContainText(`${trackingId} was already received at Dhanmondi Hub`, { timeout: 20_000 });

  // ── Delivery: dispatch assigns the delivery to the rider ──
  await opsNav(ops, "delivery");
  await ops.fill("#listSearch-delivery-waiting", trackingId);
  const waiting = ops.locator(`[data-list="delivery-waiting"] tr[data-shipment-id="${trackingId}"]`);
  await expect(waiting).toBeVisible({ timeout: 20_000 });
  // Dhanmondi delivers to Dhanmondi: the next action is "Assign rider".
  await waiting.locator(".button-primary", { hasText: "Assign rider" }).click();
  await expect(ops.locator("#assignShipment")).toHaveValue(trackingId);
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
  await confirmDialog(riderPage, { title: "Cash collected?" });
  await expect(toast(riderPage)).toContainText(`${trackingId} delivered`);

  // ── The rider's My cash shows the collection; one tap makes the handover slip ──
  await nav(riderPage, "Earnings");
  const cash = riderPage.locator("#dfMyCash");
  await expect(cash).toContainText(trackingId);
  await expect(cash.locator(".mc-total")).toContainText("৳ 750");
  await cash.locator('[data-df-slip="make"]').click();
  await expect(toast(riderPage)).toContainText("Slip HS-");
  const slipNo = (await riderPage.locator("#dfMyCash .mc-slip .no").textContent())!.trim();

  // ── Gulshan scans the slip and receives the cash ──
  await reload(hub);
  await opsNav(hub, "riderCash");
  await hub.fill("#accSlipScan", slipNo);
  await hub.press("#accSlipScan", "Enter");
  await expect(hub.locator(".acc-slip")).toContainText(rider.code);
  await expect(hub.locator("#accReceived")).toHaveValue("750");
  await hub.click('[data-acc="slip-receive"]');
  await expect(toast(hub)).toContainText(`${slipNo} received`);

  await reload(riderPage);
  await nav(riderPage, "Earnings");
  await expect(riderPage.locator("#dfMyCash")).toContainText("No cash to hand over");

  expect(errors).toEqual([]);
});

test("every operations page renders live data for each staff role", async ({ browser }) => {
  test.setTimeout(420_000);
  // Every area in each role's menu (ops-navigation.spec.ts checks which areas each role sees).
  const areas = Object.keys(OPS_NAV) as OpsArea[];
  for (const account of [OPS, HUB_GULSHAN, FINANCE, SUPPORT]) {
    const errors: string[] = [];
    const page = await signedIn(browser, account, /\/courier-operation/, errors);
    await page.evaluate(() => (window as unknown as { DF: { bridgeReady: Promise<unknown> } }).DF.bridgeReady);
    for (const area of areas) {
      if (!(await page.locator(`#navigation [data-nav="${OPS_NAV[area][0]}"]`).isVisible())) continue;
      await opsNav(page, area);
      await expect(page.locator("#mainContent")).not.toContainText(/sample (records|shipments|data|register)|Demo data/i);
    }
    // Finance can't see riders (403 for the boot-time rider list is expected).
    expect(errors.filter(e => !/status of 403/.test(e))).toEqual([]);
    await page.context().close();
  }
});
