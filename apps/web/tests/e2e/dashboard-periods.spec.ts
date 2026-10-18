import { type Browser, type Page } from "@playwright/test";
import { authenticator } from "otplib";
import { Fixtures, apiUrl, expect, opsNav, sql, test, type TempMerchant, type TempUser } from "./support";

// The dashboard period filter (public/legacy/shared/period.js, DF.period) on Courier Operations Today,
// a merchant overview and the super admin overview / platform activity: switching periods changes the
// numbers, the URL carries the period and a deep link opens with it. The figures come from the API's
// from / to params (apps/api/src/common/period.ts).
//
// Data: a temporary merchant's parcels are moved to two days in January 2020 (no real data there):
// 15 Jan 2020 = 3 booked (2 delivered that day), 16 Jan 2020 = 1 booked; one more stays booked today.
// Every account and parcel is temporary (support.ts Fixtures) and deleted afterwards.
const fx = new Fixtures();
let shop: TempMerchant;
let OPS: TempUser;
let OWNER: TempUser;
let ADMIN: TempUser;
let FINANCE: TempUser;
const DAY_A = "2020-01-15";
const DAY_B = "2020-01-16";
const WEB = { "x-df-client": "web" };

const IGNORED = /status of (401|403|404)|Failed to load resource|tile\.openstreetmap/;
function watch(page: Page, errors: string[], who: string) {
  page.on("dialog", dialog => dialog.dismiss());
  page.on("pageerror", error => errors.push(`${who}: ${error.message}`));
  page.on("console", message => message.type() === "error" && !IGNORED.test(message.text()) && errors.push(`${who}: ${message.text()}`));
}

async function signIn(browser: Browser, user: TempUser, path: string, errors: string[]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  watch(page, errors, user.name);
  for (let attempt = 0; ; attempt++) {
    await page.goto("/login");
    await page.waitForSelector("html.legacy-ready", { state: "attached" });
    await page.fill("#loginIdentity", user.login);
    await page.fill("#loginPassword", user.password);
    await page.click('form[data-form="login"] button[type="submit"]');
    const ok = await page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 10_000 }).then(() => true, () => false);
    if (ok) break;
    if (attempt >= 2 || !/too many/i.test(await page.content())) throw new Error(`${user.name} could not sign in`);
    await page.waitForTimeout(61_000);
  }
  await page.goto(path);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.evaluate(() => (window as unknown as { DF: { bridgeReady: Promise<unknown> } }).DF.bridgeReady);
  return page;
}

/** Super admins use two-step verification: enrol a test secret through the API, then open the panel. */
async function signInAdmin(browser: Browser, path: string, errors: string[]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  watch(page, errors, ADMIN.name);
  const login = await (await page.request.post(apiUrl("/api/v1/auth/login"), { headers: WEB, data: { identifier: ADMIN.phone, password: ADMIN.password } })).json();
  expect(login.mfaSetupRequired, JSON.stringify(login)).toBe(true);
  const setup = await (await page.request.post(apiUrl("/api/v1/auth/mfa/setup"), { headers: WEB, data: { mfaToken: login.mfaToken } })).json();
  const enabled = await page.request.post(apiUrl("/api/v1/auth/mfa/enable"), { headers: WEB, data: { mfaToken: login.mfaToken, code: authenticator.generate(setup.secret) } });
  expect(enabled.ok(), await enabled.text()).toBe(true);
  await page.goto(path);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.evaluate(() => (window as unknown as { DF: { bridgeReady: Promise<unknown> } }).DF.bridgeReady);
  return page;
}

/** Chooses a custom range in the period control. */
async function customRange(page: Page, from: string, to: string) {
  const box = page.locator(".df-period").first();
  await box.locator("[data-period-select]").selectOption("custom");
  await box.locator("[data-period-from]").fill(from);
  await box.locator("[data-period-to]").fill(to);
  await box.locator("[data-period-apply]").click();
}
const periodSelect = (page: Page) => page.locator(".df-period [data-period-select]").first();
const subtitle = (page: Page) => page.locator("#mainContent .page-heading .subtitle");

test.beforeAll(async ({ browser }) => {
  shop = await fx.merchant({ label: "Period Shop" });
  OPS = await fx.staff("OPS_MANAGER");
  OWNER = await fx.member(shop);
  FINANCE = await fx.staff("FINANCE");
  ADMIN = await fx.user(`E2E-Period-Admin-${fx.stamp} Test`, [{ role: "SUPER_ADMIN" }]);
  // Five orders through the operations booking API, then four moved into January 2020.
  const errors: string[] = [];
  const page = await signIn(browser, OPS, "/courier-operation", errors);
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const parcel = await page.evaluate(
      body => (window as unknown as { DF: { api: (p: string, i: unknown) => Promise<{ trackingId: string }> } }).DF.api("/ops/parcels", { method: "POST", body }),
      { merchantId: shop.id, recipient: { name: `Period ${fx.stamp} ${i}`, phone: "01812000000" }, delivery: { category: "Office", street: "Road 7, Flat 3B", zone: "Dhanmondi", district: "Dhaka Central" }, serviceLevel: "Regular", weightKg: 1, codAmount: 300 },
    );
    ids.push(parcel.trackingId);
  }
  await page.context().close();
  // 15 Jan 2020 (Dhaka): three booked, two of them delivered that afternoon.
  for (const [i, id] of ids.slice(0, 3).entries())
    await sql(
      `UPDATE parcels SET "createdAt" = $2::timestamptz, status = $3::"ParcelStatus", "deliveredAt" = $4::timestamptz, "pickedUpAt" = $5::timestamptz WHERE "trackingId" = $1`,
      [id, `${DAY_A}T10:0${i}:00+06:00`, i < 2 ? "DELIVERED" : "PENDING_CONFIRMATION", i < 2 ? `${DAY_A}T16:00:00+06:00` : null, i < 2 ? `${DAY_A}T12:00:00+06:00` : null],
    );
  // 16 Jan 2020 at 00:30 Dhaka (still 15 Jan in UTC): counts for the 16th.
  await sql(`UPDATE parcels SET "createdAt" = $2::timestamptz WHERE "trackingId" = $1`, [ids[3], `${DAY_B}T00:30:00+06:00`]);
});
test.afterAll(() => fx.cleanup());

test("Courier Operations Today: the metrics row follows the period, the URL keeps it, live counts stay now", async ({ browser }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const page = await signIn(browser, OPS, "/courier-operation", errors);
  // Default: Today, in the subtitle and the URL.
  await expect(periodSelect(page)).toHaveValue("today");
  await expect(subtitle(page)).toContainText("Today ·");
  await expect(page).toHaveURL(/period=today/);
  await expect(page.locator("#stageCards [data-stage-open]")).toHaveCount(7);
  await expect(page.locator("#todayLiveNow")).toContainText("Live now");
  await expect(page.locator("#stageCardsNote")).toContainText("not affected by the period");
  const booked = page.locator('[data-period-metric="booked"] .metric-value');
  const delivered = page.locator('[data-period-metric="delivered"] .metric-value');
  await expect(booked).not.toHaveText("—", { timeout: 20_000 });

  // A custom day: the numbers for that day.
  await customRange(page, DAY_A, DAY_A);
  await expect(booked).toHaveText("3", { timeout: 20_000 });
  await expect(delivered).toHaveText("2");
  await expect(page.locator('[data-period-metric="pickedUp"] .metric-value')).toHaveText("2");
  await expect(subtitle(page)).toContainText("Custom range · 15 Jan 2020");
  await expect(page).toHaveURL(new RegExp(`period=custom&from=${DAY_A}&to=${DAY_A}`));
  // Midnight in Dhaka: the parcel booked at 00:30 on the 16th belongs to the 16th.
  await customRange(page, DAY_B, DAY_B);
  await expect(booked).toHaveText("1", { timeout: 20_000 });
  await expect(delivered).toHaveText("0");
  // A preset.
  await periodSelect(page).selectOption("this_week");
  await expect(subtitle(page)).toContainText("This week ·");
  await expect(page).toHaveURL(/period=this_week/);
  await expect(page.locator("#stageCards [data-stage-open]")).toHaveCount(7);

  // A shared link opens with the same period.
  const linked = await page.context().newPage();
  watch(linked, errors, "deep link");
  await linked.goto(`/courier-operation?page=Today&period=custom&from=${DAY_A}&to=${DAY_A}`);
  await linked.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(periodSelect(linked)).toHaveValue("custom");
  await expect(linked.locator('[data-period-metric="booked"] .metric-value')).toHaveText("3", { timeout: 20_000 });
  await expect(subtitle(linked)).toContainText("Custom range · 15 Jan 2020");
  // Without a period in the link, the page's last choice (this browser) is used.
  await linked.goto("/courier-operation?page=Today");
  await linked.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(periodSelect(linked)).toHaveValue("custom");
  await expect(linked).toHaveURL(new RegExp(`from=${DAY_A}`));

  // Invalid custom range: an inline message, nothing changes.
  await linked.locator(".df-period [data-period-select]").selectOption("custom");
  await linked.fill(".df-period [data-period-from]", DAY_B);
  await linked.fill(".df-period [data-period-to]", DAY_A);
  await linked.click(".df-period [data-period-apply]");
  await expect(linked.locator(".df-period-error")).toContainText("on or before");
  await expect(linked).toHaveURL(new RegExp(`from=${DAY_A}&to=${DAY_A}`));
  await page.context().close();
  expect(errors).toEqual([]);
});

test("merchant overview: booked / delivered and the chart follow the period; deep link restores it", async ({ browser }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const page = await signIn(browser, OWNER, "/ecommerce-merchant", errors);
  const created = page.locator('[data-period-metric="created"] .metric-value');
  const delivered = page.locator('[data-period-metric="delivered"] .metric-value');
  // Default: this month (one order booked today).
  await expect(periodSelect(page)).toHaveValue("this_month");
  await expect(subtitle(page)).toContainText("This month ·");
  await expect(created).toHaveText("1", { timeout: 20_000 });
  await expect(page.locator(".date-button")).toBeHidden();
  await expect(page.locator('[data-period-metric="inTransit"]')).toContainText("now");

  await customRange(page, DAY_A, DAY_A);
  await expect(created).toHaveText("3", { timeout: 20_000 });
  await expect(delivered).toHaveText("2");
  await expect(page.locator('[data-period-metric="success"] .metric-value')).toHaveText("100.0%");
  // One day: the chart is by hour.
  await expect(page.locator("svg.chart .chart-labels")).toContainText("12 AM");
  await expect(page).toHaveURL(new RegExp(`period=custom&from=${DAY_A}&to=${DAY_A}`));

  await customRange(page, DAY_A, DAY_B);
  await expect(created).toHaveText("4", { timeout: 20_000 });
  await expect(page.locator("svg.chart .chart-labels")).toContainText("Jan 16");

  const linked = await page.context().newPage();
  watch(linked, errors, "merchant deep link");
  await linked.goto(`/ecommerce-merchant?period=custom&from=${DAY_B}&to=${DAY_B}`);
  await linked.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(periodSelect(linked)).toHaveValue("custom");
  await expect(linked.locator('[data-period-metric="created"] .metric-value')).toHaveText("1", { timeout: 20_000 });
  await expect(subtitle(linked)).toContainText("16 Jan 2020");
  await page.context().close();
  expect(errors).toEqual([]);
});

test("super admin: overview bookings and the platform activity traffic chart follow the period", async ({ browser }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const page = await signInAdmin(browser, "/super-admin", errors);
  const bookings = page.locator("#adminPeriodMetrics .metric").first().locator(".metric-value");
  await expect(periodSelect(page)).toHaveValue("this_month");
  await expect(subtitle(page)).toContainText("This month ·");
  await expect(bookings).not.toHaveText("—", { timeout: 20_000 });

  await customRange(page, DAY_A, DAY_A);
  await expect(bookings).toHaveText("3", { timeout: 20_000 });
  await expect(page.locator("#mainContent .panel-title", { hasText: "Bookings" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`period=custom&from=${DAY_A}&to=${DAY_A}`));
  await customRange(page, DAY_B, DAY_B);
  await expect(bookings).toHaveText("1", { timeout: 20_000 });

  // Platform activity has its own period (default: last 7 days → one bar a day); Today → the day's 24 hours.
  await page.click('#navigation [data-page="Platform activity"]');
  await expect(periodSelect(page)).toHaveValue("last_7_days");
  await expect(page.locator("#mainContent .traffic-bar")).toHaveCount(7, { timeout: 20_000 });
  await expect(page).toHaveURL(/period=last_7_days/);
  await periodSelect(page).selectOption("today");
  await expect(page.locator("#mainContent .traffic-bar")).toHaveCount(24, { timeout: 20_000 });
  await expect(subtitle(page)).toContainText("Today ·");
  // Back on the overview: its own choice, not platform activity's.
  await page.click('#navigation [data-page="Overview"]');
  await expect(periodSelect(page)).toHaveValue("custom");
  await expect(bookings).toHaveText("1", { timeout: 20_000 });

  // A shared link.
  const linked = await page.context().newPage();
  watch(linked, errors, "admin deep link");
  await linked.goto(`/super-admin?period=custom&from=${DAY_A}&to=${DAY_A}`);
  await linked.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(linked.locator("#adminPeriodMetrics .metric").first().locator(".metric-value")).toHaveText("3", { timeout: 20_000 });
  await page.context().close();
  expect(errors).toEqual([]);
});

test("COD & settlement and Analytics & SLA: period figures beside the live ones", async ({ browser }) => {
  test.setTimeout(240_000);
  // COD collected on 15 Jan 2020 for one of that day's deliveries.
  const [parcel] = await sql<{ id: string }>(`SELECT id FROM parcels WHERE "merchantId" = $1 AND status = 'DELIVERED' ORDER BY "createdAt" LIMIT 1`, [shop.id]);
  await sql(`INSERT INTO cod_collections (id, "parcelId", amount, state, "collectedAt") VALUES (gen_random_uuid(), $1, 300, 'AT_HUB', $2::timestamptz)`, [parcel.id, `${DAY_A}T16:00:00+06:00`]);
  const errors: string[] = [];
  const page = await signIn(browser, FINANCE, "/courier-operation", errors);
  await opsNav(page, "cod");
  await expect(periodSelect(page)).toHaveValue("this_month");
  await expect(subtitle(page)).toContainText("This month ·");
  const collected = page.locator("#mainContent .metrics .metric").first();
  await expect(collected).toContainText("COD collected");
  await customRange(page, DAY_A, DAY_A);
  await expect(collected.locator(".metric-value")).toHaveText("৳ 300", { timeout: 20_000 });
  await expect(page.locator("#mainContent .metrics .metric").nth(3)).toContainText("now");
  await customRange(page, DAY_B, DAY_B);
  await expect(collected.locator(".metric-value")).toHaveText("৳ 0", { timeout: 20_000 });
  await page.context().close();

  const ops = await signIn(browser, OPS, "/courier-operation", errors);
  await opsNav(ops, "analytics");
  await expect(periodSelect(ops)).toHaveValue("today");
  await expect(ops.locator("#mainContent .table-panel thead th").nth(2)).toHaveText("TODAY");
  await periodSelect(ops).selectOption("last_month");
  await expect(ops.locator("#mainContent .table-panel thead th").nth(2)).toHaveText("LAST MONTH");
  await expect(subtitle(ops)).toContainText("Last month ·");
  await expect(ops).toHaveURL(/period=last_month/);
  // Today keeps its own period (not the analytics one).
  await opsNav(ops, "today");
  await expect(periodSelect(ops)).not.toHaveValue("last_month");
  await ops.context().close();
  expect(errors).toEqual([]);
});
