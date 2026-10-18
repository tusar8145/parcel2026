import { type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { Fixtures, apiUrl, confirmDialog, expect, opsNav, sql, test, type TempMerchant, type TempRider, type TempUser } from "./support";

// Courier Operations → Merchants / Riders → "Log in as" (public/legacy/courier-operation/bridge-login-as.js):
// an operations manager opens a merchant owner's and a rider's account read-only in a NEW TAB (support access,
// shared/api.js DF.startSupportAccess). The tab shows the banner and the account's data; a change is refused
// server-side; End closes it, and the manager's own tab stays signed in. The rider app keeps nothing of the
// opened account on the device afterwards. Every account is temporary (support.ts Fixtures).
const fx = new Fixtures();
let shop: TempMerchant;
let owner: TempUser;
let rider: TempRider;
let OPS: TempUser;
let trackingId: string;
test.beforeAll(async ({ api }) => {
  shop = await fx.merchant({ label: "Login-as Shop" });
  owner = await fx.member(shop, "MERCHANT_OWNER");
  rider = await fx.rider("Gulshan Sorting Hub");
  OPS = await fx.staff("OPS_MANAGER");
  trackingId = await book(api, owner, shop);
});
test.afterAll(() => fx.cleanup());

async function token(api: APIRequestContext, user: { login: string; password: string }) {
  const res = await api.post("/api/v1/auth/login", { data: { identifier: user.login, password: user.password } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).accessToken as string;
}

async function book(api: APIRequestContext, user: TempUser, m: TempMerchant) {
  const res = await api.post("/api/v1/parcels", {
    headers: { authorization: `Bearer ${await token(api, user)}`, "Idempotency-Key": `e2e-login-as-${fx.stamp}` },
    data: {
      sender: { name: m.name, phone: m.contactPhone },
      pickup: { category: "Office", street: m.pickupAddress, area: "Banani", zone: "Banani", district: "Dhaka North" },
      recipient: { name: "Login As Recipient", phone: "01812000000" },
      delivery: { category: "Home", street: "House 7, Road 2", zone: "Dhanmondi", district: "Dhaka Central" },
      type: "ECOMMERCE",
      weightKg: 1,
      codAmount: 900,
      contents: "Cotton shirt",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).trackingId as string;
}

/** The operations manager in Courier Operations (signed in through the API: the refresh cookie). */
async function opsPage(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  let login = await page.request.post(apiUrl("/api/v1/auth/login"), { data: { identifier: OPS.login, password: OPS.password }, headers: { "x-df-client": "web" } });
  for (let i = 0; i < 10 && login.status() >= 500; i++) {
    await page.waitForTimeout(3000);
    login = await page.request.post(apiUrl("/api/v1/auth/login"), { data: { identifier: OPS.login, password: OPS.password }, headers: { "x-df-client": "web" } });
  }
  expect(login.status(), await login.text()).toBe(200);
  await page.goto("/courier-operation");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return { context, page };
}

/** Fills the "Log in as" dialog (read-only is the only choice for an ops manager) and returns the new tab. */
async function logInAs(page: Page, button: string, name: string | RegExp) {
  await expect(page.locator(button)).toBeVisible({ timeout: 30_000 });
  await page.click(button);
  await expect(page.locator("#modalTitle")).toHaveText(name);
  await expect(page.locator("#modalFields")).toContainText("Read-only: you can look, nothing can be changed.");
  await expect(page.locator("#modalFields")).not.toContainText("Full access");
  await expect(page.locator("#of_minutes")).toHaveValue("15");
  // The reason is required.
  await page.click("#modalSubmit");
  await expect(page.locator("#modalFields")).toContainText("This field is required");
  await page.fill("#of_reason", "Ticket TK-1042: checking what they see");
  const tab = page.context().waitForEvent("page");
  await page.click("#modalSubmit");
  const popup = await tab;
  await popup.waitForSelector("html.legacy-ready", { state: "attached", timeout: 60_000 });
  return popup;
}

test("an operations manager logs in as a merchant owner, read-only, in a new tab; End closes it", async ({ browser }) => {
  const { context, page } = await opsPage(browser);
  await opsNav(page, "merchants");
  const row = page.locator("#genericBody tr", { hasText: shop.name });
  await expect(row).toBeVisible({ timeout: 30_000 });
  const popup = await logInAs(page, `#genericBody [data-login-as-merchant="${shop.id}"]`, `Log in as ${shop.name}`);
  await expect(page.locator("#toast")).toContainText(`Opened ${owner.name}'s account in a new tab (read-only, 15 min).`);

  // The merchant panel, signed in as the owner, with the banner and their orders.
  await expect(popup).toHaveURL(/\/ecommerce-merchant/);
  const banner = popup.locator("#dfSupportBanner");
  await expect(banner).toContainText(`Viewing as ${owner.name} (read-only) · ends in 15 min`);
  await expect(banner).toContainText(`Opened by ${OPS.name}`);
  await popup.click(`#navigation [data-page="Orders"]`);
  const order = popup.locator(`#tableBody tr[data-merchant-record-id="${trackingId}"]`);
  await expect(order).toBeVisible({ timeout: 30_000 });

  // A change is refused by the server and nothing changes.
  await order.locator("[data-df-cancel]").click();
  await confirmDialog(popup, { value: "Testing read-only support access" });
  await expect(popup.locator("#toast")).toContainText("read-only");
  const [parcel] = await sql<{ status: string }>(`SELECT status FROM parcels WHERE "trackingId" = $1`, [trackingId]);
  expect(parcel.status).not.toBe("CANCELLED");

  // End: the session ends (recorded) and the tab closes; the manager's own tab is still signed in.
  const closed = popup.waitForEvent("close", { timeout: 15_000 });
  await popup.click("#dfSupportEnd");
  await closed;
  const [session] = await sql<{ endedReason: string; readOnly: boolean; adminUserId: string }>(
    `SELECT "endedReason", "readOnly", "adminUserId" FROM impersonation_sessions WHERE "targetUserId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    [owner.id],
  );
  expect(session).toMatchObject({ endedReason: "ended_from_session", readOnly: true, adminUserId: OPS.id });
  await opsNav(page, "riders");
  await expect(page.locator("#mainContent")).toContainText("Riders & fleet");
  await context.close();
});

test("an operations manager logs in as a rider: the rider app opens with the banner and keeps nothing on the device", async ({ browser }) => {
  const { context, page } = await opsPage(browser);
  await opsNav(page, "riders");
  const popup = await logInAs(page, `#mainContent [data-login-as-rider="${rider.code}"]`, `Log in as ${rider.code} · ${rider.name}`);
  await expect(popup).toHaveURL(/\/rider/);
  await expect(popup.locator("#dfSupportBanner")).toContainText(`Viewing as ${rider.name} (read-only) · ends in 15 min`);
  await expect(popup.locator(".rider-info small")).toContainText(rider.code);

  const closed = popup.waitForEvent("close", { timeout: 15_000 });
  await popup.click("#dfSupportEnd");
  await closed;
  // Nothing of the rider's session stays in the rider app's offline storage (IndexedDB "df-rider").
  const saved = await page.evaluate(
    id =>
      new Promise<string[]>(resolve => {
        const request = indexedDB.open("df-rider");
        request.onerror = () => resolve([]);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("kv")) return resolve([]);
          const all = db.transaction("kv").objectStore("kv").getAllKeys();
          all.onsuccess = () => {
            const keys = (all.result as string[]).filter(k => String(k).includes(id) || k === "session");
            db.close();
            resolve(keys);
          };
        };
      }),
    rider.id,
  );
  expect(saved).toEqual([]);
  await context.close();
});
