import { type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { Fixtures, expect, opsNav, sql, test, type TempMerchant, type TempRider, type TempUser } from "./support";

// Failed deliveries in Courier Operations and the merchant panel (public/legacy/courier-operation/
// bridge-failed.js, shared/merchant-bridge.js): a parcel the rider brings back after a failed attempt shows
// "Failed ×N · <reason>" in Delivery, At my hub and the drawer (with the attempts), is listed under
// Problems › Failed delivery, and "Return to sender" with "add to a run" puts it on a return run.
// Every account and parcel is temporary (support.ts Fixtures) and deleted afterwards.
const fx = new Fixtures();
let shop: TempMerchant;
let owner: TempUser;
let rider: TempRider;
let OPS: TempUser;
let hubId: string;
test.beforeAll(async () => {
  shop = await fx.merchant({ label: "Failed Shop" });
  owner = await fx.member(shop, "MERCHANT_OWNER");
  rider = await fx.rider("Gulshan Sorting Hub");
  OPS = await fx.staff("OPS_MANAGER");
  [{ id: hubId }] = await sql<{ id: string }>(`SELECT id FROM hubs WHERE name = 'Gulshan Sorting Hub'`);
});
test.afterAll(() => fx.cleanup());

const REASON = "Recipient refused";

async function token(api: APIRequestContext, user: { login: string; password: string }) {
  const res = await api.post("/api/v1/auth/login", { data: { identifier: user.login, password: user.password } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).accessToken as string;
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** Booked, picked up to Gulshan, assigned to the rider and brought back after a failed attempt (rider API). */
async function failedParcel(api: APIRequestContext, recipient: string) {
  const ops = await token(api, OPS);
  const riderToken = await token(api, rider);
  const booked = await api.post("/api/v1/ops/parcels", {
    headers: auth(ops),
    data: { merchantId: shop.id, recipient: { name: recipient, phone: "01812000000" }, delivery: { category: "Home", street: "Road 7, Flat 3B", zone: "Dhanmondi", district: "Dhaka Central" }, serviceLevel: "Regular", weightKg: 1, codAmount: 500 },
  });
  expect(booked.status(), await booked.text()).toBe(201);
  const id = (await booked.json()).trackingId as string;
  const step = async (path: string, t: string, data: unknown, status: string) => {
    const res = await api.post(`/api/v1${path}`, { headers: auth(t), data });
    expect(res.ok(), await res.text()).toBeTruthy();
    expect((await res.json()).status).toBe(status);
  };
  await step(`/parcels/${id}/assign-pickup`, ops, { riderId: rider.riderId }, "PICKUP_ASSIGNED");
  await step(`/rider/parcels/${id}/pickup`, riderToken, { outcome: "COLLECTED_TO_HUB", hubId }, "AT_HUB");
  await step(`/parcels/${id}/assign-delivery`, ops, { riderId: rider.riderId }, "ASSIGNED");
  await step(`/rider/parcels/${id}/delivery`, riderToken, { outcome: "FAILED", reason: REASON, nextAction: "RETURN_TO_HUB", hubId }, "AT_HUB");
  return id;
}

async function signIn(browser: Browser, user: TempUser, panel: RegExp, errors: string[]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(`${user.name}: ${error.message}`));
  page.on("console", message => {
    if (message.type() === "error" && !/status of (401|403)|Failed to load resource|tile\.openstreetmap/.test(message.text())) errors.push(`${user.name}: ${message.text()}`);
  });
  for (let attempt = 0; ; attempt++) {
    await page.goto("/login");
    await page.waitForSelector("html.legacy-ready", { state: "attached" });
    await page.fill("#loginIdentity", user.login);
    await page.fill("#loginPassword", user.password);
    await page.click('form[data-form="login"] button[type="submit"]');
    const ok = await page.waitForURL(panel, { timeout: 15_000 }).then(() => true, () => false);
    if (ok) break;
    if (attempt >= 2 || !/too many/i.test(await page.content())) await expect(page).toHaveURL(panel);
    await page.waitForTimeout(61_000);
  }
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return page;
}
const row = (page: Page, list: string, id: string) => page.locator(`#mainContent [data-list="${list}"] tbody tr[data-shipment-id="${id}"]`);

test("a parcel back after a failed delivery is marked everywhere and can be returned to the sender on a run", async ({ browser, api }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  const id = await failedParcel(api, `Failed E2E ${fx.stamp}`);

  // ── The merchant sees the failure on its own parcel ──
  const merchant = await signIn(browser, owner, /\/ecommerce-merchant/, errors);
  await merchant.click('#navigation [data-page="Orders"]');
  await merchant.fill("#tableSearch", id);
  await merchant.locator(`#tableBody tr[data-merchant-record-id="${id}"] [data-merchant-history]`).click();
  const note = merchant.locator("#merchantHistoryBackdrop [data-df-failure]");
  await expect(note).toContainText("Delivery failed ×1, back at Gulshan Sorting Hub");
  await expect(note).toContainText(REASON);
  await merchant.context().close();

  const page = await signIn(browser, OPS, /\/courier-operation/, errors);
  await page.evaluate(() => (window as unknown as { DF: { bridgeReady: Promise<unknown> } }).DF.bridgeReady);

  // ── Delivery › Waiting for a delivery rider: the badge, "Failed before", Re-attempt + Return to sender ──
  await opsNav(page, "delivery");
  const waiting = row(page, "delivery-waiting", id);
  await expect(waiting.locator("[data-failed-badge]")).toHaveText(`Failed ×1 · ${REASON}`);
  await expect(waiting.locator('[data-next="assign"]')).toHaveText("Re-attempt (Assign rider)");
  await expect(waiting.locator("[data-return-sender]")).toBeVisible();
  await page.selectOption('#mainContent [data-list="delivery-waiting"] [data-list-failed]', "false");
  await expect(waiting).toHaveCount(0);
  await page.selectOption('#mainContent [data-list="delivery-waiting"] [data-list-failed]', "true");
  await expect(waiting.locator("[data-failed-badge]")).toBeVisible();

  // ── Hub desk › At my hub ──
  await opsNav(page, "hubAtHub");
  await expect(row(page, "hub-now", id).locator("[data-failed-badge]")).toHaveText(`Failed ×1 · ${REASON}`);

  // ── The drawer: the badge, the attempts (date, rider, reason) and both actions ──
  await row(page, "hub-now", id).locator(`[data-drawer="${id}"]`).click();
  const drawer = page.locator("#parcelDrawer");
  await expect(drawer.locator("#parcelDrawerSub [data-failed-badge]")).toContainText("Failed ×1");
  const attempts = drawer.locator("#drawerAttempts");
  await expect(attempts).toContainText("Delivery attempts (1 failed)");
  await expect(attempts.locator("[data-failed-note]")).toContainText("Back at Gulshan Sorting Hub after a failed delivery");
  await expect(attempts.locator("tbody tr[data-attempt]")).toHaveCount(1);
  await expect(attempts.locator("tbody tr[data-attempt]")).toContainText(rider.code);
  await expect(attempts.locator("tbody tr[data-attempt]")).toContainText(REASON);
  await expect(drawer.locator('[data-next="assign"]')).toHaveText("Re-attempt (Assign rider)");
  await expect(drawer.locator("[data-return-sender]")).toBeVisible();
  await page.click("#parcelDrawerClose");

  // ── Problems › Failed delivery lists it with the attempts and the reason ──
  await opsNav(page, "failedDelivery");
  const failed = row(page, "problems-failed", id);
  await expect(failed.locator('[data-fail-col="attempts"]')).toContainText("×1");
  await expect(failed.locator('[data-fail-col="reason"]')).toContainText(REASON);
  await expect(page.locator('#mainContent [data-list="problems-failed"] thead')).toContainText("LAST FAILURE");

  // ── Return to sender, added to a new return run ──
  await failed.locator("[data-return-sender]").click();
  await expect(page.locator("#modalTitle")).toHaveText(`Return to sender · ${id}`);
  await expect(page.locator("#rtsReason")).toHaveValue(REASON);
  await page.selectOption("#rtsRun", "new");
  await page.fill("#rtsNote", "Merchant agreed to take it back");
  await page.click("#modalSubmit");
  await expect(page.locator("#modalTitle")).toHaveText("Return to sender scheduled");
  await expect(page.locator("#rtsResult")).toContainText(/scheduled for return on RR-/);
  const [parcel] = await sql<{ status: string; returnRunId: string | null; returnReason: string }>(`SELECT status, "returnRunId", "returnReason" FROM parcels WHERE "trackingId" = $1`, [id]);
  expect(parcel).toMatchObject({ status: "RETURN_SCHEDULED", returnReason: REASON });
  expect(parcel.returnRunId).toBeTruthy();
  const [run] = await sql<{ number: string; status: string }>(`SELECT number, status FROM return_runs WHERE id = $1`, [parcel.returnRunId]);
  expect(run.status).toBe("PLANNED");
  // It left the failed list; the link opens Returns with the run.
  await expect(failed).toHaveCount(0);
  await page.click("[data-open-returns]");
  await expect(page.locator("#breadcrumbLabel")).toHaveText("Returns");
  await expect(page.locator("#mainContent")).toContainText(run.number);
  expect(errors).toEqual([]);
});
