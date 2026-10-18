import { type APIRequestContext, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { Fixtures, apiUrl, expect, sql, test, type TempMerchant, type TempRider, type TempUser } from "./support";

/*
 * Rider app scan sections (public/legacy/rider/bridge-scan.js) and the delivery rider's live location on
 * the recipient's tracking page and the merchant's parcel details (bridge-pwa.js, TrackingView.tsx,
 * shared/merchant-bridge.js), against the real API. Every account and parcel is temporary (support.ts
 * Fixtures) and deleted afterwards.
 */
const fx = new Fixtures();
let shop: TempMerchant;
let other: TempMerchant;
let owner: TempUser;
let rider: TempRider;
let OPS: TempUser;
let hubId: string;
const DHAKA = { latitude: 23.7808, longitude: 90.4142, accuracy: 15 };

test.beforeAll(async () => {
  shop = await fx.merchant({ label: "Scan Shop" });
  other = await fx.merchant({ label: "Other Shop" });
  owner = await fx.member(shop, "MERCHANT_OWNER");
  rider = await fx.rider("Gulshan Sorting Hub");
  OPS = await fx.staff("OPS_MANAGER");
  [{ id: hubId }] = await sql<{ id: string }>(`SELECT id FROM hubs WHERE name = 'Gulshan Sorting Hub'`);
});
test.afterAll(() => fx.cleanup());

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
async function token(api: APIRequestContext, user: { login: string; password: string }) {
  const res = await api.post("/api/v1/auth/login", { data: { identifier: user.login, password: user.password } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).accessToken as string;
}
async function step(api: APIRequestContext, path: string, t: string, data: unknown, status?: string) {
  const res = await api.post(`/api/v1${path}`, { headers: auth(t), data });
  expect(res.ok(), `${path}: ${await res.text()}`).toBeTruthy();
  if (status) expect((await res.json()).status).toBe(status);
}
/** A parcel of `merchant` booked by operations and assigned to the rider for pickup. */
async function pickupFor(api: APIRequestContext, merchant: TempMerchant, recipient: string) {
  const ops = await token(api, OPS);
  const booked = await api.post("/api/v1/ops/parcels", {
    headers: auth(ops),
    data: { merchantId: merchant.id, recipient: { name: recipient, phone: "01812000000" }, delivery: { category: "Home", street: "Road 7, Flat 3B", zone: "Dhanmondi", district: "Dhaka Central" }, serviceLevel: "Regular", weightKg: 1, codAmount: 0 },
  });
  expect(booked.status(), await booked.text()).toBe(201);
  const id = (await booked.json()).trackingId as string;
  await step(api, `/parcels/${id}/assign-pickup`, ops, { riderId: rider.riderId }, "PICKUP_ASSIGNED");
  return id;
}
/** …then collected to the hub and assigned to the rider for delivery (ASSIGNED). */
async function deliveryFor(api: APIRequestContext, recipient: string) {
  const id = await pickupFor(api, shop, recipient);
  const ops = await token(api, OPS);
  await step(api, `/rider/parcels/${id}/pickup`, await token(api, rider), { outcome: "COLLECTED_TO_HUB", hubId }, "AT_HUB");
  await step(api, `/parcels/${id}/assign-delivery`, ops, { riderId: rider.riderId }, "ASSIGNED");
  return id;
}
const statusOf = async (id: string) => (await sql<{ status: string }>(`SELECT status FROM parcels WHERE "trackingId" = $1`, [id]))[0]?.status;

async function signedInRider(browser: Browser, options: BrowserContextOptions = {}) {
  const context = await browser.newContext({ serviceWorkers: "block", ...options });
  const page = await context.newPage();
  let login = await page.request.post(apiUrl("/api/v1/auth/login"), { data: { identifier: rider.login, password: rider.password }, headers: { "x-df-client": "web" } });
  for (let i = 0; i < 10 && login.status() >= 500; i++) {
    await page.waitForTimeout(3000);
    login = await page.request.post(apiUrl("/api/v1/auth/login"), { data: { identifier: rider.login, password: rider.password }, headers: { "x-df-client": "web" } });
  }
  expect(login.status(), await login.text()).toBe(200);
  await page.goto("/rider");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return { context, page };
}
async function scan(page: Page, code: string) {
  await page.fill("#dfScanInput", code);
  await page.press("#dfScanInput", "Enter");
}
async function openSection(page: Page, key: string) {
  await page.click('#navigation [data-page="Scan parcel"]');
  await page.click(`[data-df-scan-section="${key}"]`);
  await expect(page.locator("#dfScanSession")).toHaveAttribute("data-section", key);
}

test("pickup from merchant: scan 2 of 3, see the missing one, a parcel of another merchant is refused; hand over at hub with undo", async ({ browser, api }) => {
  const ids = [await pickupFor(api, shop, `Scan A ${fx.stamp}`), await pickupFor(api, shop, `Scan B ${fx.stamp}`), await pickupFor(api, shop, `Scan C ${fx.stamp}`)];
  const foreign = await pickupFor(api, other, `Scan X ${fx.stamp}`);
  const { context, page } = await signedInRider(browser);

  await openSection(page, "pickup");
  await page.selectOption("#dfScanStop", `M:${shop.id}`);
  await expect(page.locator("#dfScanStats")).toContainText("Scanned 0 of 3 expected");

  await scan(page, ids[0]);
  await expect(page.locator('[data-scan-log="' + ids[0] + '"]')).toContainText("Picked up");
  await expect(page.locator("#dfScanInput")).toHaveAttribute("data-scan-result", "ok");
  await scan(page, ids[1].toLowerCase()); // typed in lower case: normalised
  await expect(page.locator("#dfScanStats")).toContainText("Scanned 2 of 3 expected");
  await expect(page.locator("#dfScanStats")).toContainText("1 missing");
  await expect(page.locator(`#dfScanProgress [data-missing="${ids[2]}"]`)).toBeVisible();

  await scan(page, foreign);
  await expect(page.locator("#dfScanInput")).toHaveAttribute("data-scan-result", "error");
  await expect(page.locator(`[data-scan-log="${foreign}"]`)).toContainText(`belongs to ${other.name}`);
  await scan(page, "PP-000000-NOPE1");
  await expect(page.locator('[data-scan-log="PP-000000-NOPE1"]')).toContainText("isn't assigned to you");

  await expect.poll(() => statusOf(ids[0])).toBe("PICKED_UP");
  expect(await statusOf(ids[1])).toBe("PICKED_UP");
  expect(await statusOf(ids[2])).toBe("PICKUP_ASSIGNED");
  expect(await statusOf(foreign)).toBe("PICKUP_ASSIGNED");

  // Hand over at the hub: on the hub's list (still Picked up until the hub scans it in); undo.
  await page.click("[data-df-scan-back]");
  await page.click('[data-df-scan-section="handover"]');
  await page.selectOption("#dfScanHub", hubId);
  await scan(page, ids[0]);
  await expect(page.locator("#dfScanStats")).toContainText("1 on the handover list");
  expect(await statusOf(ids[0])).toBe("PICKED_UP");
  await scan(page, ids[2]);
  await expect(page.locator(`[data-scan-log="${ids[2]}"]`)).toContainText("hasn't been picked up yet");
  await page.locator(`#dfScanProgress [data-df-scan-undo="${ids[0]}"]`).click();
  await expect(page.locator("#dfScanStats")).toContainText("0 on the handover list");
  await context.close();
});

test("start delivery by scan; the delivery screen still requires proof", async ({ browser, api }) => {
  const id = await deliveryFor(api, `Scan D ${fx.stamp}`);
  const { context, page } = await signedInRider(browser, { permissions: ["geolocation"], geolocation: DHAKA });

  // Assigned: no delivery code yet. Starting the delivery sends it (one SMS).
  const codeSms = async () => Number((await sql<{ n: string }>(`SELECT count(*) AS n FROM outbox_messages WHERE template = 'parcel.delivery_code' AND "trackingId" = $1`, [id]))[0]?.n ?? 0);
  expect(await codeSms()).toBe(0);
  await openSection(page, "start");
  await expect(page.locator(`#dfScanProgress [data-missing="${id}"]`)).toBeVisible();
  await scan(page, id);
  await expect(page.locator(`[data-scan-log="${id}"]`)).toContainText("Out for delivery · delivery code sent to the recipient");
  await expect.poll(() => statusOf(id)).toBe("OUT_FOR_DELIVERY");
  expect(await codeSms()).toBe(1);
  await scan(page, id);
  await expect(page.locator(`[data-scan-log="${id}"]`).first()).toContainText("Already out for delivery");

  await page.click("[data-df-scan-back]");
  await page.click('[data-df-scan-section="deliver"]');
  await scan(page, id);
  await expect(page.locator("#actionModal")).toHaveClass(/open/);
  await expect(page.locator("#actionModal")).toHaveClass(/df-scan-quick/);
  // No proof given: refused in the dialog, nothing delivered.
  await page.click("#submitAction");
  // Either the bridge's message ("Capture the recipient's signature…") or the browser's required-field check on the code.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const feedback = document.getElementById("proofFeedback")?.textContent || "";
        const otp = document.getElementById("deliveryOtp") as HTMLInputElement | null;
        return /signature|code|photo/i.test(feedback) || (!!otp && !otp.closest("[hidden]") && !otp.checkValidity());
      }),
    )
    .toBe(true);
  await expect(page.locator("#actionModal")).toHaveClass(/open/);
  await page.waitForTimeout(1000);
  expect(await statusOf(id)).toBe("OUT_FOR_DELIVERY");
  await context.close();
});

test("before Start delivery the delivery screen offers no code proof; starting from it sends the code", async ({ browser, api }) => {
  const id = await deliveryFor(api, `Scan S ${fx.stamp}`);
  const { context, page } = await signedInRider(browser);
  await page.click('#navigation [data-page="Deliveries"]');
  await page.click(`[data-delivery="${id}"]`);
  await expect(page.locator("#actionModal")).toHaveClass(/open/);
  await expect(page.locator("#proofMethod option", { hasText: "OTP" })).toHaveCount(0);
  const hint = page.locator("#actionModal [data-df-start-hint]");
  await expect(hint).toContainText("Start the delivery first; the code is sent to the recipient then.");
  await hint.locator(`[data-df-start="${id}"]`).click();
  await expect(page.locator("#toast")).toContainText(`${id} is out for delivery. Delivery code sent to the recipient.`);
  await expect.poll(() => statusOf(id)).toBe("OUT_FOR_DELIVERY");
  // The delivery screen opens again, now with the code proof.
  await expect(page.locator("#actionModal")).toHaveClass(/open/);
  await expect(page.locator("#proofMethod option", { hasText: "OTP" })).toHaveCount(1);
  await expect(page.locator("#actionModal [data-df-start-hint]")).toHaveCount(0);
  await context.close();
});

test("the recipient and the merchant see the rider's live location only with Live rider location and while out for delivery", async ({ browser, api }) => {
  test.setTimeout(240_000);
  const live = await deliveryFor(api, `Live L ${fx.stamp}`);
  const waiting = await deliveryFor(api, `Live W ${fx.stamp}`);
  const riderToken = await token(api, rider);
  await step(api, `/rider/parcels/${live}/start-delivery`, riderToken, {}, "OUT_FOR_DELIVERY");
  // The parcels' package: "Live rider location" on (set on these temporary parcels only).
  await sql(`UPDATE parcels SET services = array_append(array_remove(services, 'tracking.live_location'), 'tracking.live_location') WHERE "trackingId" = ANY($1::text[])`, [[live, waiting]]);
  await sql(`UPDATE riders SET status = 'ONLINE' WHERE id = $1`, [rider.riderId]);

  // The rider's app (on shift, location allowed) sends the position by itself; "Update my location now" sends one at once.
  const { context, page } = await signedInRider(browser, { permissions: ["geolocation"], geolocation: DHAKA });
  await expect.poll(async () => (await sql(`SELECT 1 FROM rider_locations WHERE "riderId" = $1`, [rider.riderId])).length, { timeout: 30_000 }).toBe(1);
  await page.click('#navigation [data-page="Overview"]');
  await expect(page.locator("#dfLocationLine")).toHaveAttribute("data-location-state", "on");
  await page.click("[data-df-locate]");
  await expect(page.locator("#dfLocationText")).toContainText("Location sharing: On · last sent just now", { timeout: 20_000 });

  // Recipient (no account): the tracking ID alone asks for the phone digits, then shows the position.
  const visitor = await browser.newContext();
  const track = await visitor.newPage();
  await track.goto(`/track/${live}`);
  const box = track.locator("[data-live-rider]");
  await expect(box).toHaveAttribute("data-live-status", "LINK_REQUIRED");
  await track.fill("#livePhoneLast4", "1111");
  await track.click('[data-live-unlock] button[type="submit"]');
  await expect(track.locator("#livePhoneLast4-error")).toContainText("don't match");
  await track.fill("#livePhoneLast4", "0000");
  await track.click('[data-live-unlock] button[type="submit"]');
  await expect(track.locator("[data-live-location]")).toBeVisible();
  await expect(track.locator("[data-live-updated]")).toContainText(/updated (just now|1 min ago)/);
  expect(await track.locator("[data-live-location]").getAttribute("href")).toContain(`mlat=${DHAKA.latitude}`);

  // Not out for delivery yet: nothing on the tracking page.
  await track.goto(`/track/${waiting}`);
  await expect(track.locator(".track-status-card")).toBeVisible();
  await expect(track.locator("[data-live-rider]")).toHaveCount(0);

  // Merchant: the parcel's details show the live position.
  const merchant = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const mp = await merchant.newPage();
  const login = await mp.request.post(apiUrl("/api/v1/auth/login"), { data: { identifier: owner.login, password: owner.password }, headers: { "x-df-client": "web" } });
  expect(login.status(), await login.text()).toBe(200);
  await mp.goto("/ecommerce-merchant");
  await mp.waitForSelector("html.legacy-ready", { state: "attached" });
  const openDetails = async (id: string) => {
    await mp.click('#navigation [data-page="Orders"]');
    await mp.fill("#tableSearch", id);
    await mp.locator(`#tableBody tr[data-merchant-record-id="${id}"] [data-merchant-history]`).click();
  };
  await openDetails(live);
  await expect(mp.locator("#merchantHistoryBackdrop [data-df-live]")).toContainText(/updated (just now|1 min ago)/);
  await expect(mp.locator("#merchantHistoryBackdrop [data-df-live-map]")).toBeVisible();
  await mp.click("#closeMerchantHistory");
  await openDetails(waiting);
  await expect(mp.locator("#merchantHistoryBackdrop")).toBeVisible();
  await expect(mp.locator("#merchantHistoryBackdrop [data-df-live]")).toHaveCount(0);
  await mp.click("#closeMerchantHistory");

  // Without the package feature: no position for anyone.
  await sql(`UPDATE parcels SET services = array_remove(services, 'tracking.live_location') WHERE "trackingId" = $1`, [live]);
  await openDetails(live);
  await expect(mp.locator("#merchantHistoryBackdrop")).toBeVisible();
  await expect(mp.locator("#merchantHistoryBackdrop [data-df-live]")).toHaveCount(0);
  await track.goto(`/track/${live}`);
  await expect(track.locator(".track-status-card")).toBeVisible();
  await expect(track.locator("[data-live-location]")).toHaveCount(0);
  await expect(track.locator("[data-live-unlock]")).toHaveCount(0);

  await Promise.all([context.close(), visitor.close(), merchant.close()]);
});
