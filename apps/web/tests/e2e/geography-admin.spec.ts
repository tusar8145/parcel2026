import { randomUUID } from "node:crypto";
import { type Browser, type Page } from "@playwright/test";
import { authenticator } from "otplib";
import { Fixtures, apiUrl, confirmDialog, expect, sql, test, type TempUser } from "./support";

// Geography admin (super admin → Shared catalogs & locations) and the hub register (super
// admin → Hubs & zones). Everything is created with unique names by temporary accounts and
// removed again: the district, zone and areas through the UI, the hub through the UI, leftovers in
// afterAll. The audit log is append-only and kept.
const fx = new Fixtures();
const stamp = fx.stamp;
const DISTRICT = `E2E Geo ${stamp}`;
const ZONE = `E2E Zone ${stamp}`;
const HUB = `E2E Hub ${stamp}`;
const WEB = { "x-df-client": "web" };
const EXPECTED = /status of (401|404|409)|Failed to load resource|tile\.openstreetmap/;
let admin: TempUser;
let netAdmin: TempUser;
let customer: TempUser;

test.beforeAll(async () => {
  admin = await fx.user(`E2E Geo Admin ${stamp}`, [{ role: "SUPER_ADMIN" }]);
  netAdmin = await fx.user(`E2E Net Admin ${stamp}`, [{ role: "SUPER_ADMIN" }]);
  customer = await fx.user(`E2E Geo Customer ${stamp}`, [{ role: "CUSTOMER" }]);
});

test.afterAll(async () => {
  // Leftovers of a failed run: the temporary district (and its zone) and hub, and their tombstones.
  await sql(`DELETE FROM addresses WHERE "userId" = $1`, [customer?.id]);
  const [catalog] = await sql<{ value: { districts: string[]; zonesByDistrict: Record<string, string[]>; areasByZone: Record<string, string[]> } }>(`SELECT value FROM settings WHERE key = 'catalog'`);
  if (catalog?.value.districts.includes(DISTRICT)) {
    const c = catalog.value;
    for (const z of c.zonesByDistrict[DISTRICT] ?? []) delete c.areasByZone[z];
    delete c.zonesByDistrict[DISTRICT];
    c.districts = c.districts.filter(d => d !== DISTRICT);
    await sql(`UPDATE settings SET value = $1 WHERE key = 'catalog'`, [JSON.stringify(c)]);
  }
  const [meta] = await sql<{ value: Record<string, Record<string, unknown>> }>(`SELECT value FROM settings WHERE key = 'catalog-meta'`);
  if (meta) {
    const strip = (v: unknown): unknown =>
      Array.isArray(v) ? v.filter(x => !String(x).includes(stamp)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !k.includes(stamp)).map(([k, x]) => [k, strip(x)])) : v;
    await sql(`UPDATE settings SET value = $1 WHERE key = 'catalog-meta'`, [JSON.stringify(strip(meta.value))]);
  }
  await sql(`DELETE FROM delivery_zones WHERE name LIKE $1`, [`%${stamp}%`]);
  await sql(`UPDATE riders SET "hubId" = NULL WHERE "hubId" IN (SELECT id FROM hubs WHERE name = $1)`, [HUB]);
  await fx.cleanup();
  await sql(`DELETE FROM hubs WHERE name = $1`, [HUB]);
});

async function openPanel(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !EXPECTED.test(message.text())) errors.push(message.text());
  });
  return { page, errors };
}

/** Signs the temporary super admin in (enrolling two-step verification through the API) and opens the panel. */
async function signInAdmin(page: Page, who: TempUser = admin) {
  const login = await (await page.request.post(apiUrl("/api/v1/auth/login"), { headers: WEB, data: { identifier: who.phone, password: who.password } })).json();
  expect(login.mfaSetupRequired, JSON.stringify(login)).toBe(true);
  const setup = await (await page.request.post(apiUrl("/api/v1/auth/mfa/setup"), { headers: WEB, data: { mfaToken: login.mfaToken } })).json();
  const enabled = await page.request.post(apiUrl("/api/v1/auth/mfa/enable"), { headers: WEB, data: { mfaToken: login.mfaToken, code: authenticator.generate(setup.secret) } });
  expect(enabled.ok(), await enabled.text()).toBe(true);
  await page.goto("/super-admin");
  await expect(page).toHaveURL(/\/super-admin/);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
}

const row = (page: Page, level: "district" | "zone" | "area", name: string) => page.locator(`#geoAdmin [data-geo-row="${level}"][data-name="${name}"]`);
const toast = (page: Page) => page.locator("#toast");

test("super admin: districts → zones → areas: add, bulk add, rename, deactivate, in-use refusal, delete", async ({ browser }) => {
  test.setTimeout(240_000);
  const { page, errors } = await openPanel(browser);
  page.on("dialog", dialog => dialog.accept());
  await signInAdmin(page);
  await page.click('#navigation [data-page="Pricing & catalogs"]');
  await expect(page.locator("#geoAdmin #geoTotals")).toContainText("districts", { timeout: 20_000 });

  // Add a district (with an invalid half coordinate first).
  await page.click('#geoAdmin [data-geo-add="district"]');
  await expect(page.locator("#modalTitle")).toHaveText("Add district");
  await page.fill("#geoName", DISTRICT);
  await page.fill("#geoLat", "22.5");
  await page.click("#modalSubmit");
  await expect(page.locator('[data-error-for="geoLng"]')).toHaveText("Give both latitude and longitude, or neither");
  await page.fill("#geoLng", "92.1");
  await page.click("#modalSubmit");
  await expect(toast(page)).toContainText(`District ${DISTRICT} added.`);
  await expect(row(page, "district", DISTRICT)).toContainText("Active");
  await expect(page.locator("#geoAdmin")).toContainText(`Zones of ${DISTRICT}`);

  // A duplicate zone name anywhere in the country is refused on the field.
  await page.click('#geoAdmin [data-geo-add="zone"]');
  await page.fill("#geoName", "Gulshan");
  await page.click("#modalSubmit");
  await expect(page.locator('[data-error-for="geoName"]')).toContainText("already a zone of Dhaka North");
  await page.fill("#geoName", ZONE);
  await page.click("#modalSubmit");
  await expect(toast(page)).toContainText(`Zone ${ZONE} added to ${DISTRICT}`);
  await expect(page.locator("#geoAdmin")).toContainText(`Areas of ${ZONE}`);

  // Bulk add areas by pasting lines; the duplicate is skipped and listed.
  await page.click('#geoAdmin [data-geo-add="area"]');
  await page.fill("#geoAreas", `North Para ${stamp}\nSouth Para ${stamp}\n\nnorth para ${stamp}\nBazar ${stamp}`);
  await page.click("#modalSubmit");
  await expect(toast(page)).toContainText(`3 areas added to ${ZONE}; 1 skipped.`);
  await expect(page.locator("#geoNotice")).toContainText(`Line 4 · north para ${stamp}: listed twice`);
  await expect(page.locator('#geoAdmin [data-geo-row="area"]')).toHaveCount(3);

  // Rename an area, deactivate another.
  await row(page, "area", `Bazar ${stamp}`).locator("[data-geo-edit]").click();
  await page.fill("#geoName", `Bazar Road ${stamp}`);
  await page.click("#modalSubmit");
  await expect(toast(page)).toContainText(`Bazar ${stamp} renamed to Bazar Road ${stamp}`);
  await expect(row(page, "area", `Bazar Road ${stamp}`)).toBeVisible();
  await row(page, "area", `South Para ${stamp}`).locator("[data-geo-toggle]").click();
  await confirmDialog(page, { title: `Deactivate South Para ${stamp}?` });
  await expect(toast(page)).toContainText(`South Para ${stamp} deactivated.`);
  await expect(row(page, "area", `South Para ${stamp}`)).toContainText("Inactive");
  // The public catalog (booking forms) no longer offers it.
  const catalog = await (await page.request.get(apiUrl("/api/v1/catalog"))).json();
  expect(catalog.areasByZone[ZONE]).toEqual([`North Para ${stamp}`, `Bazar Road ${stamp}`]);

  // A zone in use can't be deleted: the dialog lists what uses it and offers deactivation.
  await sql(`INSERT INTO addresses (id, "userId", role, category, "contactName", phone, street, zone, district, "updatedAt") VALUES ($1, $2, 'RECEIVER', 'HOME', 'E2E', $3, 'Road 1', $4, $5, now())`, [
    randomUUID(),
    customer.id,
    customer.phone,
    ZONE,
    DISTRICT,
  ]);
  await row(page, "zone", ZONE).locator("[data-geo-delete]").click();
  await expect(page.locator("#modalTitle")).toHaveText(`${ZONE} is in use`);
  await expect(page.locator("#geoUsage")).toContainText("Saved addresses (address books): 1");
  await page.click("#modalSubmit"); // Deactivate instead
  await expect(toast(page)).toContainText(`${ZONE} deactivated.`);
  await expect(row(page, "zone", ZONE)).toContainText("Inactive");
  await expect(row(page, "zone", ZONE)).toContainText("used by 1 record");

  // Search across the country finds the deactivated zone's areas.
  await page.fill("#geoSearch", `North Para ${stamp}`);
  await expect(page.locator("#geoResults")).toContainText(`Area · ${ZONE}, ${DISTRICT}`);
  await page.fill("#geoSearch", "");
  await expect(page.locator("#geoResults")).toHaveCount(0);

  // Unused again → the zone (with its areas) and then the district are deleted.
  await sql(`DELETE FROM addresses WHERE "userId" = $1`, [customer.id]);
  await row(page, "zone", ZONE).locator("[data-geo-delete]").click();
  await confirmDialog(page, { title: new RegExp(`^Delete ${ZONE}`) });
  await expect(toast(page)).toContainText(`${ZONE} deleted.`);
  await expect(row(page, "zone", ZONE)).toHaveCount(0);
  await row(page, "district", DISTRICT).locator("[data-geo-delete]").click();
  await confirmDialog(page, { title: new RegExp(`^Delete ${DISTRICT}`) });
  await expect(toast(page)).toContainText(`${DISTRICT} deleted.`);
  await expect(row(page, "district", DISTRICT)).toHaveCount(0);
  const actions = await sql<{ action: string }>(`SELECT action FROM audit_logs WHERE "actorId" = $1 ORDER BY "createdAt"`, [admin.id]);
  expect(actions.map(a => a.action)).toEqual(expect.arrayContaining(["geo.district.create", "geo.zone.create", "geo.area.bulk_create", "geo.area.update", "geo.zone.update", "geo.zone.delete", "geo.district.delete"]));
  expect(errors).toEqual([]);
});

test("super admin: hub register: add, edit, deactivate, delete only when unused", async ({ browser }) => {
  test.setTimeout(240_000);
  const { page, errors } = await openPanel(browser);
  await signInAdmin(page, netAdmin);
  await page.click('#navigation [data-page="Hubs & zones"]');
  const register = page.locator("#hzHubs");
  await expect(register).toContainText("Gulshan Sorting Hub", { timeout: 20_000 });

  // Add: the zone must be chosen (the district's zones).
  await page.click("#hzNewHub");
  await expect(page.locator("#hzDialogTitle")).toHaveText("Add hub");
  await page.fill("#hzCode", `E2E-${stamp}`.slice(0, 20));
  await page.fill("#hzName", HUB);
  await page.selectOption("#hzDistrict", "Dhaka North");
  await page.fill("#hzAddress", "Road 11, Banani");
  await page.click('#hzForm [type="submit"]');
  await expect(page.locator("#hzDialog")).toBeVisible(); // no zone chosen yet
  await page.selectOption("#hzZone", "Banani");
  await page.click('#hzForm [type="submit"]');
  await expect(page.locator("#toast")).toContainText(`${HUB} added.`);
  const hubRow = register.locator("tr", { hasText: HUB });
  await expect(hubRow).toContainText("Banani, Dhaka North");

  // Edit: capacity; then deactivate.
  await hubRow.locator("[data-hz-edit]").click();
  await expect(page.locator("#hzZone")).toHaveValue("Banani");
  await page.fill("#hzCapacity", "250");
  await page.click('#hzForm [type="submit"]');
  await expect(page.locator("#toast")).toContainText(`${HUB} saved.`);
  await expect(hubRow).toContainText("250");
  await hubRow.locator("[data-hz-toggle]").click();
  await confirmDialog(page, { title: `Deactivate ${HUB}?` });
  await expect(page.locator("#toast")).toContainText(`${HUB} is deactivated.`);
  await expect(hubRow).toContainText("Inactive");
  const [stored] = await sql<{ id: string; active: boolean; capacity: number }>(`SELECT id, active, capacity FROM hubs WHERE name = $1`, [HUB]);
  expect(stored).toMatchObject({ active: false, capacity: 250 });

  // In use (a rider) → the dialog lists it; unused → deleted.
  const rider = await fx.rider(HUB);
  await hubRow.locator("[data-hz-delete]").click();
  await expect(page.locator("#dfDialogTitle")).toHaveText(`${HUB} is in use`);
  await expect(page.locator("#dfDialogTitle").locator("..")).toContainText("Riders: 1");
  await page.click("[data-df-dialog-cancel]");
  await sql(`UPDATE riders SET "hubId" = NULL WHERE id = $1`, [rider.riderId]);
  await hubRow.locator("[data-hz-delete]").click();
  await confirmDialog(page, { title: new RegExp(`^Delete ${HUB}`) });
  await expect(page.locator("#toast")).toContainText(`${HUB} deleted.`);
  await expect(register.locator("tr", { hasText: HUB })).toHaveCount(0);
  expect(await sql(`SELECT 1 FROM hubs WHERE id = $1`, [stored.id])).toHaveLength(0);

  // Delivery zones: each zone with its serving hub, filtered by district.
  await page.click('[data-hz-tab="zones"]');
  await page.selectOption("#hzZoneDistrict", "Dhaka North");
  await expect(page.locator("#hzZones")).toContainText("Gulshan", { timeout: 20_000 });
  expect(errors).toEqual([]);
});
