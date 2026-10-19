import { type Browser, type Page } from "@playwright/test";
import { authenticator } from "otplib";
import { Fixtures, apiUrl, expect, sql, test, type TempUser } from "./support";

// The nationwide geography (npm run db:seed:geo) in the panels: the super admin's geography admin
// lists the districts and shows one district's zones / one zone's areas (or a search) at a time, and hubs carry the catalog zone drop-offs
// are priced from. Accounts and the hub are temporary.
const fx = new Fixtures();
const WEB = { "x-df-client": "web" };
const stamp = Date.now().toString(36);
let hubId: string | undefined;
test.afterAll(async () => {
  if (hubId) await sql("DELETE FROM hubs WHERE id = $1", [hubId]);
  await fx.cleanup();
});

async function panel(browser: Browser, user: TempUser, url: string, mfa = false) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("dialog", dialog => dialog.accept());
  const login = await (await page.request.post(apiUrl("/api/v1/auth/login"), { headers: WEB, data: { identifier: user.login, password: user.password } })).json();
  if (mfa) {
    expect(login.mfaSetupRequired, JSON.stringify(login)).toBe(true);
    const setup = await (await page.request.post(apiUrl("/api/v1/auth/mfa/setup"), { headers: WEB, data: { mfaToken: login.mfaToken } })).json();
    const enabled = await page.request.post(apiUrl("/api/v1/auth/mfa/enable"), { headers: WEB, data: { mfaToken: login.mfaToken, code: authenticator.generate(setup.secret) } });
    expect(enabled.ok(), await enabled.text()).toBe(true);
  } else expect(login.accessToken, JSON.stringify(login)).toBeTruthy();
  await page.goto(url);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return page;
}
const nav = (page: Page, name: string) => page.click(`#navigation [data-page="${name}"]`);

test("super admin browses the country's districts, zones and areas without rendering them all", async ({ browser }) => {
  const admin = await fx.user(`E2E-Geo-Admin-${stamp} Test`, [{ role: "SUPER_ADMIN" }]);
  const page = await panel(browser, admin, "/super-admin", true);
  await nav(page, "Pricing & catalogs");
  // The geography admin (super-admin/bridge-geo.js): every district is listed, one district's
  // zones and one zone's areas at a time. 64 districts with Dhaka city split into North / Central /
  // South plus the outer "Dhaka (Sub-urban)" district = 67.
  const geo = page.locator("#geoAdmin");
  const districts = geo.locator('[data-geo-row="district"]');
  await expect(districts.first()).toBeVisible();
  expect(await districts.count()).toBeGreaterThanOrEqual(67);
  await expect(geo.locator("#geoTotals")).toContainText(/^(6[7-9]|[7-9]\d) districts/);
  for (const name of ["Dhaka North", "Dhaka Central", "Dhaka South", "Dhaka (Sub-urban)", "Gazipur", "Narayanganj"]) await expect(geo.locator(`[data-geo-row="district"][data-name="${name}"]`)).toHaveCount(1);
  await expect(geo.locator('[data-geo-row="district"][data-name="Dhaka"]')).toHaveCount(0); // renamed to "Dhaka (Sub-urban)"

  await geo.locator(`[data-geo-pick="district"][data-name="Cox's Bazar"]`).click();
  await expect(geo.locator('[data-geo-row="zone"][data-name="Teknaf"]')).toBeVisible();
  await expect(geo.locator('[data-geo-row="zone"][data-name="Gulshan"]')).toHaveCount(0);

  // Areas: one zone at a time, and a search across all of them.
  await geo.locator('[data-geo-pick="district"][data-name="Dhaka North"]').click();
  await geo.locator('[data-geo-pick="zone"][data-name="Gulshan"]').click();
  await expect(geo.locator('[data-geo-row="area"][data-name="Gulshan 2"]')).toBeVisible();
  await page.fill("#geoSearch", "Mirpur 1");
  await expect(geo.locator("#geoResults tr", { hasText: "Mirpur 10" })).toContainText("Area · Mirpur,");
  expect(await geo.locator("[data-geo-row]").count()).toBeLessThan(400);
});

test("super admin adds a hub with its zone from the district's zones and changes it later", async ({ browser }) => {
  const admin = await fx.user(`E2E-Geo-Net-${stamp} Test`, [{ role: "SUPER_ADMIN" }]);
  const page = await panel(browser, admin, "/super-admin", true);
  await nav(page, "Hubs & zones");
  const name = `E2E Geo Hub ${stamp}`;
  // Hubs & zones → Add hub (the register is the one place hubs are added).
  await page.click("#hzNewHub");
  await expect(page.locator("#hzDialogTitle")).toHaveText("Add hub");
  await page.fill("#hzName", name);
  await page.selectOption("#hzDistrict", "Cox's Bazar");
  await expect(page.locator("#hzZone option", { hasText: "Teknaf" })).toHaveCount(1);
  await expect(page.locator("#hzZone option", { hasText: "Gulshan" })).toHaveCount(0);
  await page.fill("#hzAddress", "Teknaf Sadar Road");
  await page.fill("#hzCode", `CXB-${stamp}`.slice(0, 20));
  await page.click('#hzForm [type="submit"]');
  await expect(page.locator("#hzDialog")).toBeVisible(); // no zone chosen yet
  await page.selectOption("#hzZone", "Teknaf");
  await page.click('#hzForm [type="submit"]');
  await expect(page.locator("#toast")).toContainText(`${name}`);
  const [hub] = await sql<{ id: string; district: string; zone: string }>("SELECT id, district, zone FROM hubs WHERE name = $1", [name]);
  hubId = hub.id;
  expect(hub).toMatchObject({ district: "Cox's Bazar", zone: "Teknaf" });

  // Edit: the zone choices are the hub's district's zones.
  await page.click(`[data-hz-edit="${hub.id}"]`);
  await expect(page.locator("#hzZone")).toHaveValue("Teknaf");
  await page.selectOption("#hzZone", "Ukhiya");
  await page.click('#hzForm [type="submit"]');
  await expect(page.locator("#toast")).toContainText("saved");
  expect((await sql<{ zone: string }>("SELECT zone FROM hubs WHERE id = $1", [hub.id]))[0].zone).toBe("Ukhiya");

  // The zones table filters by district instead of listing the whole country.
  await page.click('[data-hz-tab="zones"]');
  await page.selectOption("#hzZoneDistrict", "Cox's Bazar");
  await expect(page.locator("#hzZones .primary-cell", { hasText: "Teknaf" })).toBeVisible();
  await expect(page.locator("#hzZones .primary-cell", { hasText: "Gulshan" })).toHaveCount(0);
});
