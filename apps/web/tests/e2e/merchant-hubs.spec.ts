import { type Browser, type Page } from "@playwright/test";
import { authenticator } from "otplib";
import { Fixtures, apiUrl, confirmDialog, expect, opsNav, sql, test, type TempUser } from "./support";

/**
 * Every merchant belongs to the hub serving its pickup address (never set by hand):
 * - Courier Operations → Merchants and super admin's merchant lists: HUB column and hub filter (names shown as text), "Change address" (the hub follows), and the
 *   address changes merchants asked for, approved or rejected there.
 * - Walk-in shipment form: Service first; Drop at hub makes the sender's address optional; required fields marked *.
 * - Hub managers book only for their hub's merchants.
 */
const fx = new Fixtures();
test.afterAll(() => fx.cleanup());

const toast = (page: Page) => page.locator("#toast");

async function signIn(browser: Browser, user: TempUser, to: RegExp) {
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto("/login");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.fill("#loginIdentity", user.login);
  await page.fill("#loginPassword", user.password);
  await page.click('form[data-form="login"] button[type="submit"]');
  await page.waitForURL(to);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return { page, errors };
}
/** A merchant with a structured pickup address in Banani (Gulshan Sorting Hub). */
async function structuredMerchant() {
  const m = await fx.merchant({ type: "ECOMMERCE" });
  const [hub] = await sql<{ id: string }>(`SELECT "hubId" AS id FROM delivery_zones WHERE district = 'Dhaka North' AND name = 'Banani'`);
  await sql(`UPDATE merchants SET "pickupZone" = 'Banani', "pickupArea" = 'Banani Block C', "pickupHubId" = $2, "businessDistrict" = 'Dhaka North', "businessZone" = 'Banani', "businessArea" = 'Banani Block C', "businessStreet" = $3 WHERE id = $1`, [m.id, hub.id, m.pickupAddress]);
  return m;
}
const hubOf = async (merchantId: string) => (await sql<{ name: string | null }>(`SELECT h.name FROM merchants m LEFT JOIN hubs h ON h.id = m."pickupHubId" WHERE m.id = $1`, [merchantId]))[0].name;

test("merchants: hub column, change address, and approving a merchant's own address change", async ({ browser }) => {
  test.setTimeout(240_000);
  const shop = await structuredMerchant();
  const other = await structuredMerchant();
  const owner = await fx.member(other, "MERCHANT_OWNER");
  const ops = await fx.staff("OPS_MANAGER");

  // The merchant moves its pickup to Uttara in Settings: it waits for approval.
  const m = await signIn(browser, owner, /\/ecommerce-merchant/);
  await m.page.click('#navigation [data-page="Settings"]');
  await m.page.locator("#tableBody tr", { hasText: "Store profile" }).locator("button").click();
  await expect(m.page.locator("#dfAddressRequest")).toContainText("checked by Delivery Fast before they apply");
  await m.page.uncheck("#dfmaPickupSame");
  await m.page.selectOption("#dfmaPuDistrict", "Dhaka North");
  await m.page.selectOption("#dfmaPuZone", "Uttara");
  await m.page.selectOption("#dfmaPuArea", "Uttara Sector 7");
  await m.page.fill("#dfmaPuStreet", "House 3, Road 12, Sector 7");
  await m.page.selectOption("#dfmaPickupTime", "MORNING");
  await m.page.click('#dfProfileForm button[type="submit"]');
  await expect(toast(m.page)).toContainText("sent to Delivery Fast for approval (pickups would move to Uttara Delivery Hub)");
  expect(await hubOf(other.id)).toBe("Gulshan Sorting Hub");

  // Operations: the HUB column and filter, the change to approve, and Change address.
  const o = await signIn(browser, ops, /\/courier-operation/);
  await opsNav(o.page, "merchants");
  const table = o.page.locator("#mainContent .table-panel").last();
  await expect(table.locator("thead")).toContainText("HUB");
  const shopRow = o.page.locator(`#mainContent tr[data-merchant-id="${shop.id}"]`);
  await expect(shopRow).toContainText("Gulshan Sorting Hub");
  const request = o.page.locator("#addressRequestsPanel tr", { hasText: other.name });
  await expect(request).toContainText("Uttara Delivery Hub");
  await request.locator("[data-address-approve]").click();
  await expect(toast(o.page)).toContainText("address change approved");
  await expect.poll(() => hubOf(other.id)).toBe("Uttara Delivery Hub");

  await expect(o.page.locator(`#mainContent tr[data-merchant-id="${other.id}"]`)).toContainText("Uttara Delivery Hub");
  // Filter by hub: Uttara shows the moved merchant, not the other one; "No hub" neither.
  const [uttara] = await sql<{ id: string }>(`SELECT id FROM hubs WHERE name = 'Uttara Delivery Hub'`);
  await o.page.selectOption("#merchantHubFilter", uttara.id);
  await expect(o.page.locator(`#mainContent tr[data-merchant-id="${other.id}"]`)).toBeVisible();
  await expect(o.page.locator(`#mainContent tr[data-merchant-id="${shop.id}"]`)).toHaveCount(0);
  await o.page.selectOption("#merchantHubFilter", "");
  await expect(o.page.locator(`#mainContent tr[data-merchant-id="${shop.id}"]`)).toBeVisible();

  // Operations change an address directly: the hub follows (Dhanmondi).
  await o.page.locator(`#mainContent tr[data-merchant-id="${shop.id}"] [data-merchant-address]`).click();
  await o.page.selectOption("#maDistrict", "Dhaka Central");
  await o.page.selectOption("#maZone", "Dhanmondi");
  await expect(o.page.locator("#maAreaLabel")).toHaveText("Area *");
  await o.page.click("#maSave");
  await expect(o.page.locator("#maError")).toHaveText("Choose the area.");
  await o.page.selectOption("#maArea", { index: 1 });
  await expect(o.page.locator("#maHub")).toContainText("Hub:");
  await o.page.fill("#maStreet", "House 9, Road 7, Dhanmondi");
  await o.page.click("#maSave");
  await expect(toast(o.page)).toContainText("address saved");
  await expect.poll(() => hubOf(shop.id)).not.toBe("Gulshan Sorting Hub");

  // A rejected change keeps the address and tells the merchant why.
  await m.page.locator("#tableBody tr", { hasText: "Store profile" }).locator("button").click();
  await m.page.check("#dfmaPickupSame");
  await m.page.click('#dfProfileForm button[type="submit"]');
  await expect(toast(m.page)).toContainText("sent to Delivery Fast for approval");
  await o.page.reload();
  await o.page.waitForSelector("html.legacy-ready", { state: "attached" });
  const again = o.page.locator("#addressRequestsPanel tr", { hasText: other.name });
  await again.locator("[data-address-reject]").click();
  await confirmDialog(o.page, { title: "Reject the address change?", value: "Send a photo of the new shop sign" });
  await expect(o.page.locator("#addressRequestsPanel")).toHaveCount(0);
  await m.page.locator("#tableBody tr", { hasText: "Store profile" }).locator("button").click();
  await expect(m.page.locator("#dfAddressRequestBox")).toContainText("Address change not approved");
  await expect(m.page.locator("#dfAddressRequestBox")).toContainText("Send a photo of the new shop sign");
  expect(await hubOf(other.id)).toBe("Uttara Delivery Hub");

  expect([...m.errors, ...o.errors]).toEqual([]);
});

test("walk-in form: service first, required marks, drop-off without a sender address; hub managers see their merchants", async ({ browser }) => {
  test.setTimeout(180_000);
  const ops = await fx.staff("OPS_MANAGER");
  const o = await signIn(browser, ops, /\/courier-operation/);
  await o.page.evaluate(() => (window as unknown as { DFOps: { modals: Record<string, () => void> } }).DFOps.modals.newWalkIn());
  await o.page.waitForSelector("#bkSvcFirstMile");
  // The service comes before the sender.
  const order = await o.page.evaluate(() => [...document.querySelectorAll("#modalFields .df-bk-section")].map(e => e.textContent));
  expect(order.slice(0, 3)).toEqual(["Booking", "Service", "Sender"]);
  const required = (id: string) => o.page.locator(`#modalFields .field:has(#${id})`);
  await expect(required("bkPickupStreet")).toHaveClass(/df-req/);
  await expect(required("bkRecipient")).toHaveClass(/df-req/);
  await expect(required("bkStreet")).toHaveClass(/df-req/);

  // Drop at hub: the sender's address is optional.
  await o.page.selectOption("#bkSvcFirstMile", "HUB_DROP");
  await expect(required("bkPickupStreet")).not.toHaveClass(/df-req/);
  await expect(o.page.locator("#bkDropNote")).toBeVisible();
  const [badda] = await sql<{ id: string }>(`SELECT id FROM hubs WHERE name = 'Badda Delivery Hub'`);
  await o.page.selectOption("#bkSvcDropHub", badda.id);
  // Hub Pickup: the recipient's street is optional too.
  await o.page.selectOption("#bkSvcLastMile", "HUB_COLLECT");
  await expect(required("bkStreet")).not.toHaveClass(/df-req/);
  await o.page.fill("#bkSenderName", `E2E Walk-in ${fx.stamp}`);
  await o.page.fill("#bkSenderPhone", "1711222333");
  await o.page.fill("#bkRecipient", "Rupa Akter");
  await o.page.fill("#bkPhone", "1812333444");
  await o.page.selectOption("#bkDistrict", "Dhaka South");
  await o.page.selectOption("#bkZone", "Motijheel");
  await expect(o.page.locator("#bkPrice")).toContainText("Delivery charge");
  await o.page.click("#modalSubmit");
  await expect(toast(o.page)).toContainText(/booked for E2E Walk-in .+ \(walk-in\)/);
  const trackingId = (await toast(o.page).textContent())!.match(/[A-Z]{2,4}-\d{6}-[0-9A-Z]+/)![0];
  fx.adoptParcel(trackingId, "01711222333");
  const [p] = await sql<Record<string, unknown>>(`SELECT intake, "pickupStreet", "deliveryStreet", "lastMile" FROM parcels WHERE "trackingId" = $1`, [trackingId]);
  expect(p).toMatchObject({ intake: "DROP_OFF", pickupStreet: expect.stringContaining("Drop-off at Badda Delivery Hub"), deliveryStreet: "Collects at the hub", lastMile: "HUB_COLLECT" });

  // A hub manager's merchant list: only the merchants of their hub (Banani → Gulshan Sorting Hub).
  const mine = await structuredMerchant();
  const elsewhere = await fx.merchant({ type: "ECOMMERCE", label: "Elsewhere Shop" });
  const hubOp = await fx.staff("HUB_OPERATOR", "Gulshan Sorting Hub");
  const h = await signIn(browser, hubOp, /\/courier-operation/);
  await h.page.evaluate(() => (window as unknown as { DFOps: { modals: Record<string, () => void> } }).DFOps.modals.newEcommerce());
  await h.page.waitForSelector("#bkMerchant option[value]:not([value=''])", { state: "attached" });
  const names = await h.page.$$eval("#bkMerchant option", opts => opts.map(x => x.textContent || ""));
  expect(names.some(n => n.includes(mine.name) && n.includes("Gulshan Sorting Hub"))).toBe(true);
  expect(names.some(n => n.includes(elsewhere.name))).toBe(false);

  expect([...o.errors, ...h.errors]).toEqual([]);
});

test("merchant lists: names show as text; super admin sees the hub and filters by it on every merchant page", async ({ browser }) => {
  test.setTimeout(180_000);
  const tricky = await structuredMerchant();
  await sql(`UPDATE merchants SET name = $2 WHERE id = $1`, [tricky.id, `E2E <b>Bold</b> Shop ${fx.stamp}`]);
  const plain = await fx.merchant({ type: "ECOMMERCE", label: "Hubless Shop" });

  // Courier Operations: the name is text, not markup.
  const ops = await fx.staff("OPS_MANAGER");
  const o = await signIn(browser, ops, /\/courier-operation/);
  await opsNav(o.page, "merchants");
  const row = o.page.locator(`#mainContent tr[data-merchant-id="${tricky.id}"]`);
  await expect(row).toContainText("E2E <b>Bold</b> Shop");
  await expect(row.locator("b")).toHaveCount(0);

  // Super admin → E-commerce merchants: HUB column and the hub filter.
  const admin = await fx.user(`E2E Hub Admin ${fx.stamp}`, [{ role: "SUPER_ADMIN" }]);
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  const WEB = { "x-df-client": "web" };
  const login = await (await page.request.post(apiUrl("/api/v1/auth/login"), { headers: WEB, data: { identifier: admin.phone, password: admin.password } })).json();
  const setup = await (await page.request.post(apiUrl("/api/v1/auth/mfa/setup"), { headers: WEB, data: { mfaToken: login.mfaToken } })).json();
  await page.request.post(apiUrl("/api/v1/auth/mfa/enable"), { headers: WEB, data: { mfaToken: login.mfaToken, code: authenticator.generate(setup.secret) } });
  await page.goto("/super-admin");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.click('#navigation [data-page="E-commerce merchants"]');
  const table = page.locator("#segmentMerchantBody").locator("xpath=ancestor::table");
  await expect(table.locator("thead")).toContainText("HUB");
  const trickyRow = page.locator("#segmentMerchantBody tr", { has: page.locator(`[data-merchant="${tricky.code}"]`) });
  const plainRow = page.locator("#segmentMerchantBody tr", { has: page.locator(`[data-merchant="${plain.code}"]`) });
  await expect(trickyRow).toContainText("Gulshan Sorting Hub");
  await expect(plainRow).toContainText("No hub");
  const [gulshan] = await sql<{ id: string }>(`SELECT id FROM hubs WHERE name = 'Gulshan Sorting Hub'`);
  await page.selectOption("#saMerchantHub", gulshan.id);
  await expect(trickyRow).toBeVisible();
  await expect(plainRow).toBeHidden();
  await page.selectOption("#saMerchantHub", "none");
  await expect(plainRow).toBeVisible();
  await expect(trickyRow).toBeHidden();
  expect(o.errors).toEqual([]);
});
