import { type Browser, type Page } from "@playwright/test";
import { authenticator } from "otplib";
import { Fixtures, apiUrl, expect, sql, test, type TempMerchant, type TempRider, type TempUser } from "./support";

// A unique address for every page and tab (DF.nav in public/legacy/shared/api.js; courier-operation/bridge-nav.js,
// shared/panel-nav.js) and in-app notifications (shared/notifications.js, GET /me/notifications): deep links,
// old names, Back / Forward, titles, a signed-out deep link coming back after sign-in, the live bell count in
// Courier Operations and a merchant panel, clicking through to the item, and the Notifications page.
// Every account and parcel is temporary (support.ts Fixtures) and deleted afterwards, notifications included.
const fx = new Fixtures();
let shop: TempMerchant;
let bank: TempMerchant;
let OPS: TempUser;
let OWNER: TempUser;
let BANKER: TempUser;
let CUSTOMER: TempUser;
let ADMIN: TempUser;
let RIDER: TempRider;
const WEB = { "x-df-client": "web" };
const tickets: string[] = [];

type Win = { DF: { bridgeReady: Promise<unknown>; api: (path: string, init?: unknown) => Promise<any> } };
const IGNORED = /status of (401|403|404)|Failed to load resource|tile\.openstreetmap/;
function watch(page: Page, errors: string[], who: string) {
  page.on("dialog", dialog => dialog.dismiss());
  page.on("pageerror", error => errors.push(`${who}: ${error.message}`));
  page.on("console", message => message.type() === "error" && !IGNORED.test(message.text()) && errors.push(`${who}: ${message.text()}`));
}
async function ready(page: Page) {
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.evaluate(() => (window as unknown as Win).DF.bridgeReady);
}
async function login(page: Page, user: TempUser) {
  for (let attempt = 0; ; attempt++) {
    await page.waitForSelector("html.legacy-ready", { state: "attached" });
    await page.fill("#loginIdentity", user.login);
    await page.fill("#loginPassword", user.password);
    await page.click('form[data-form="login"] button[type="submit"]');
    const ok = await page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 10_000 }).then(() => true, () => false);
    if (ok) return;
    if (attempt >= 2 || !/too many/i.test(await page.content())) throw new Error(`${user.name} could not sign in`);
    await page.waitForTimeout(61_000);
    await page.goto("/login");
  }
}
async function signIn(browser: Browser, user: TempUser, path: string, errors: string[]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  watch(page, errors, user.name);
  await page.goto("/login");
  await login(page, user);
  await page.goto(path);
  await ready(page);
  return page;
}
async function signInAdmin(browser: Browser, path: string, errors: string[]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  watch(page, errors, ADMIN.name);
  const auth = await (await page.request.post(apiUrl("/api/v1/auth/login"), { headers: WEB, data: { identifier: ADMIN.phone, password: ADMIN.password } })).json();
  const setup = await (await page.request.post(apiUrl("/api/v1/auth/mfa/setup"), { headers: WEB, data: { mfaToken: auth.mfaToken } })).json();
  const enabled = await page.request.post(apiUrl("/api/v1/auth/mfa/enable"), { headers: WEB, data: { mfaToken: auth.mfaToken, code: authenticator.generate(setup.secret) } });
  expect(enabled.ok(), await enabled.text()).toBe(true);
  await page.goto(path);
  await ready(page);
  return page;
}
const query = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams);
const api = (page: Page, path: string, init?: unknown) => page.evaluate(([p, i]) => (window as unknown as Win).DF.api(p as string, i), [path, init] as const);
const bellCount = (page: Page, bell: string) => page.locator(`${bell} .notification-dot`).getAttribute("data-count");

test.beforeAll(async () => {
  shop = await fx.merchant({ label: "Url Shop" });
  bank = await fx.merchant({ type: "BANKING_FINANCIAL", label: "Url Bank" });
  OPS = await fx.staff("OPS_MANAGER");
  OWNER = await fx.member(shop);
  BANKER = await fx.member(bank);
  CUSTOMER = await fx.user(`E2E-Url-Customer-${fx.stamp} Test`, [{ role: "CUSTOMER" }]);
  ADMIN = await fx.user(`E2E-Url-Admin-${fx.stamp} Test`, [{ role: "SUPER_ADMIN" }]);
  RIDER = await fx.rider("Gulshan Sorting Hub");
});
test.afterAll(async () => {
  // Opening a ticket also told the real support desk: those notifications go with the test ticket.
  if (tickets.length) await sql(`DELETE FROM user_notifications WHERE title LIKE ANY($1::text[])`, [tickets.map(t => `%${t}%`)]);
  for (const t of tickets) {
    const [row] = await sql<{ id: string }>(`SELECT id FROM support_tickets WHERE number = $1`, [t]);
    if (row) {
      await sql(`DELETE FROM ticket_messages WHERE "ticketId" = $1`, [row.id]).catch(() => undefined);
      await sql(`DELETE FROM support_tickets WHERE id = $1`, [row.id]).catch(() => undefined);
    }
  }
  await fx.cleanup();
});

test("Courier Operations: page and tab links, old names, Back / Forward, titles and the parcel drawer", async ({ browser }) => {
  const errors: string[] = [];
  const page = await signIn(browser, OPS, "/courier-operation?page=hub-desk&tab=end-of-day&period=today", errors);
  await expect(page.locator("#breadcrumbLabel")).toHaveText("Hub desk");
  await expect(page.locator('#mainContent [data-nav-tab="End of day"]')).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveTitle("Hub desk › End of day · Delivery Fast · Courier Operations");
  expect(query(page)).toMatchObject({ page: "hub-desk", tab: "end-of-day", period: "today" });

  // Menu and tabs push history entries.
  await page.click('#navigation [data-nav="Problems"]');
  await expect.poll(() => query(page)).toMatchObject({ page: "problems", tab: "exceptions" });
  await page.click('#mainContent [data-nav-tab="Failed delivery"]');
  await expect.poll(() => query(page).tab).toBe("failed-delivery");
  await expect(page).toHaveTitle("Problems › Failed delivery · Delivery Fast · Courier Operations");
  await page.goBack();
  await expect(page.locator('#mainContent [data-nav-tab="Exceptions"]')).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(page.locator("#breadcrumbLabel")).toHaveText("Hub desk");
  await expect(page.locator('#mainContent [data-nav-tab="End of day"]')).toHaveAttribute("aria-selected", "true");
  await page.goForward();
  await expect(page.locator("#breadcrumbLabel")).toHaveText("Problems");

  // Old page names still open the right place and the address becomes the slug.
  await page.goto("/courier-operation?page=Scheduled%20pickups");
  await ready(page);
  await expect(page.locator('#mainContent [data-nav-tab="Scheduled pickups"]')).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => query(page)).toMatchObject({ page: "pickup", tab: "scheduled-pickups" });

  // ?parcel= opens the drawer (loaded from the API); closing it drops the parameter.
  const parcel = await api(page, "/ops/parcels", {
    method: "POST",
    body: { merchantId: shop.id, recipient: { name: `Url ${fx.stamp}`, phone: "01812000000" }, delivery: { category: "Office", street: "Road 7, Flat 3B", zone: "Dhanmondi", district: "Dhaka Central" }, serviceLevel: "Regular", weightKg: 1, codAmount: 0 },
  });
  await page.goto(`/courier-operation?page=all-parcels&parcel=${parcel.trackingId}`);
  await ready(page);
  await expect(page.locator("#parcelDrawerTitle")).toHaveText(parcel.trackingId);
  await page.click("#parcelDrawerClose");
  await expect.poll(() => query(page).parcel).toBeUndefined();
  expect(query(page).page).toBe("all-parcels");
  expect(errors).toEqual([]);
  await page.context().close();
});

test("a signed-out deep link comes back after sign-in", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto("/courier-operation?page=reports&tab=analytics-and-sla");
  await page.waitForURL(/\/login/);
  await login(page, OPS);
  await page.waitForURL(/\/courier-operation\?/);
  await ready(page);
  expect(query(page)).toMatchObject({ page: "reports", tab: "analytics-and-sla" });
  await expect(page.locator('#mainContent [data-nav-tab="Analytics & SLA"]')).toHaveAttribute("aria-selected", "true");
  await context.close();
});

test("Courier Operations bell: counts live, opens the ticket and marks it read", async ({ browser }) => {
  const errors: string[] = [];
  const ops = await signIn(browser, OPS, "/courier-operation?page=today", errors);
  const before = Number(await bellCount(ops, "#notifications"));
  // A customer opens a ticket; operations assign it to OPS; the customer's reply rings OPS's bell (only theirs).
  const customer = await signIn(browser, CUSTOMER, "/account", errors);
  const ticket = await api(customer, "/support/tickets", { method: "POST", body: { category: "Delivery issue", subject: `Url ticket ${fx.stamp}`, message: "Where is my parcel?" } });
  tickets.push(ticket.number);
  await expect.poll(() => bellCount(ops, "#notifications")).toBe(String(before + 1)); // the desk hears about the new ticket
  await api(ops, `/support/tickets/${ticket.number}`, { method: "PATCH", body: { assigneeId: OPS.id } });
  await api(customer, `/support/tickets/${ticket.number}/messages`, { method: "POST", body: { body: "Still waiting, please help." } });
  await expect.poll(() => bellCount(ops, "#notifications")).toBe(String(before + 2));

  await ops.click("#notifications");
  const item = ops.locator("#notificationsPanel .dfn-item.unread", { hasText: `New reply on ${ticket.number}` });
  await expect(item).toBeVisible();
  await item.click();
  await expect.poll(() => query(ops)).toMatchObject({ page: "support", ticket: ticket.number });
  await expect(ops.locator("#breadcrumbPage")).toHaveText("Support");
  await expect(ops.locator(`.st-ticket.selected[data-support-open="${ticket.number}"]`)).toBeVisible();
  await expect.poll(() => bellCount(ops, "#notifications")).toBe(String(before + 1));
  expect(errors).toEqual([]);
  await ops.context().close();
  await customer.context().close();
});

test("merchant panel: page links, Back / Forward, the live bell and the Notifications page", async ({ browser }) => {
  const errors: string[] = [];
  // The old Payments link opens Balance.
  const page = await signIn(browser, OWNER, "/ecommerce-merchant?page=payments", errors);
  await expect(page.locator("#breadcrumbPage")).toHaveText("Balance");
  await expect(page).toHaveTitle("Balance · Delivery Fast · E-commerce merchant");
  await page.click('#navigation [data-page="Shipments"]');
  await expect.poll(() => query(page).page).toBe("shipments");
  await page.click('#navigation [data-page="Reports"]');
  await expect.poll(() => query(page).page).toBe("reports");
  await page.goBack();
  await expect(page.locator("#breadcrumbPage")).toHaveText("Shipments");
  await page.goBack();
  await expect(page.locator("#breadcrumbPage")).toHaveText("Balance");
  await page.goForward();
  await expect(page.locator("#breadcrumbPage")).toHaveText("Shipments");
  // Old names are rewritten.
  await page.goto("/ecommerce-merchant?page=API%20%26%20Webhooks");
  await ready(page);
  await expect.poll(() => query(page).page).toBe("api-and-webhooks");

  // The bell: a cancelled order reaches the team live; clicking opens the parcel and marks it read.
  expect(await bellCount(page, "#notificationButton")).toBe("0");
  const order = await api(page, "/parcels", {
    method: "POST",
    body: {
      sender: { name: "Url Shop", phone: "01711111111" },
      pickup: { category: "Office", street: shop.pickupAddress, area: "Banani Block C", zone: "Banani", district: "Dhaka North" },
      recipient: { name: `Url ${fx.stamp}`, phone: "01812000000" },
      delivery: { category: "Office", street: "Road 7, Flat 3B", area: "Dhanmondi Road 7", zone: "Dhanmondi", district: "Dhaka Central" },
      serviceLevel: "Regular",
      weightKg: 1,
      packaging: "Small carton",
      contents: "Clothing",
      codAmount: 0,
      type: "ECOMMERCE",
      saveAddresses: false,
    },
  });
  await api(page, `/parcels/${order.trackingId}/cancel`, { method: "POST", body: { reason: "Changed mind" } });
  await expect.poll(() => bellCount(page, "#notificationButton")).toBe("1");
  await page.click("#notificationButton");
  await page.locator("#notificationsPanel .dfn-item.unread", { hasText: `${order.trackingId} was cancelled` }).click();
  await expect.poll(() => query(page).parcel).toBe(order.trackingId);
  await expect.poll(() => bellCount(page, "#notificationButton")).toBe("0");

  // The Notifications page: its own address, All / Unread, read state.
  await page.goto("/ecommerce-merchant?page=notifications");
  await ready(page);
  await expect(page.locator("#breadcrumbPage")).toHaveText("Notifications");
  await expect(page).toHaveTitle("Notifications · Delivery Fast · E-commerce merchant");
  await expect(page.locator("#dfnList .dfn-item", { hasText: `${order.trackingId} was cancelled` })).toBeVisible();
  await page.click('[data-dfn-filter="unread"]');
  await expect(page.locator("#dfnList")).toContainText("No unread notifications.");
  await page.click('[data-dfn-filter="all"]');
  await expect(page.locator("#dfnList .dfn-item").first()).toBeVisible();
  expect(errors).toEqual([]);
  await page.context().close();
});

test("banking merchant, super admin and rider: page and tab links", async ({ browser }) => {
  const errors: string[] = [];
  // The old Billing link opens Balance.
  const banking = await signIn(browser, BANKER, "/banking-merchant?page=billing", errors);
  await expect(banking.locator("#breadcrumbPage")).toHaveText("Balance");
  await expect(banking).toHaveTitle("Balance · Delivery Fast · Banking & Financial merchant");
  await banking.context().close();

  const admin = await signInAdmin(browser, "/super-admin?page=import-settings&tab=e-commerce", errors);
  await expect(admin.locator('#importSettings [data-import-tab="ecommerce"]')).toHaveAttribute("aria-selected", "true");
  await expect(admin).toHaveTitle("Import settings › E-commerce template · Delivery Fast · Super admin");
  await admin.click('#importSettings [data-import-tab="document"]');
  await expect.poll(() => query(admin).tab).toBe("banking-and-financial");
  await admin.goBack();
  await expect(admin.locator('#importSettings [data-import-tab="ecommerce"]')).toHaveAttribute("aria-selected", "true");
  await admin.goto("/super-admin?page=Approvals");
  await ready(admin);
  await expect.poll(() => query(admin).page).toBe("approval-center");
  await expect(admin).toHaveTitle("Approval center · Delivery Fast · Super admin");
  await admin.click("#notifications");
  await expect(admin.locator("#notificationsPanel")).toBeVisible();
  await admin.click("#notificationsPanel [data-dfn-all]");
  await expect(admin.locator("#breadcrumbPage")).toHaveText("Notifications");
  await expect.poll(() => query(admin).page).toBe("notifications");
  await admin.context().close();

  const rider = await signIn(browser, RIDER, "/rider?page=scan-parcel&tab=handover", errors);
  await expect(rider.locator("#dfScanSession")).toHaveAttribute("data-section", "handover");
  await expect(rider).toHaveTitle("Scan parcel › Hand over at hub · Delivery Fast · Rider");
  await rider.click("[data-df-scan-back]");
  await expect.poll(() => query(rider).tab).toBeUndefined();
  await rider.goto("/rider?page=Earnings");
  await ready(rider);
  await expect.poll(() => query(rider).page).toBe("earnings");
  await expect(rider.locator("#breadcrumbPage")).toHaveText("Earnings");
  await rider.context().close();
  expect(errors).toEqual([]);
});
