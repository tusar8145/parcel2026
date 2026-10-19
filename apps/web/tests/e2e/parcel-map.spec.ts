import { type APIRequestContext, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { authenticator } from "otplib";
import { apiUrl, confirmDialog, expect, Fixtures, opsNav, sql, test, type TempMerchant, type TempRider, type TempUser } from "./support";

// "Where is it now?" (shared/parcel-map.js, GET /parcels/:id/position) and "I'm travelling in this vehicle"
// (shared/vehicle-share.js, rider/bridge-vehicle.js): a rider sends their location from the rider app → the
// Courier Operations drawer shows "With rider R-…" on a map; a parcel at a hub shows the hub; a rider starts
// sharing a departed trip's vehicle location from the rider app → a parcel on that trip shows "In vehicle …" in
// the operations drawer, on Transfers › Vehicles on the road and in the merchant's drawer; the recipient's
// tracking page never shows the vehicle. Every account, parcel, bag and trip is temporary (the audit log is kept).
const fx = new Fixtures();
let shop: TempMerchant;
let owner: TempUser;
let ops: TempUser;
let gulOp: TempUser;
let rider: TempRider;
let gulshanId: string;
let dhanmondiId: string;
const RIDER_AT = { latitude: 23.7901, longitude: 90.4123, accuracy: 12 };
const VEHICLE_AT = { latitude: 23.7702, longitude: 90.4011, accuracy: 15 };

test.beforeAll(async () => {
  shop = await fx.merchant({ label: "Map Shop" });
  owner = await fx.member(shop, "MERCHANT_OWNER");
  ops = await fx.staff("OPS_MANAGER");
  gulOp = await fx.staff("HUB_OPERATOR", "Gulshan Sorting Hub");
  rider = await fx.rider("Gulshan Sorting Hub");
  [{ id: gulshanId }] = await sql<{ id: string }>(`SELECT id FROM hubs WHERE name = 'Gulshan Sorting Hub'`);
  [{ id: dhanmondiId }] = await sql<{ id: string }>(`SELECT id FROM hubs WHERE name = 'Dhanmondi Hub'`);
});
test.afterAll(async () => {
  const users = [ops.id, gulOp.id];
  const bags = `SELECT id FROM linehaul_bags WHERE "createdById" = ANY($1::uuid[])`;
  const trips = `SELECT id FROM linehaul_trips WHERE "createdById" = ANY($1::uuid[])`;
  await sql(`DELETE FROM linehaul_discrepancies WHERE "bagId" IN (${bags}) OR "tripId" IN (${trips})`, [users]);
  await sql(`DELETE FROM linehaul_bag_items WHERE "bagId" IN (${bags})`, [users]);
  await sql(`DELETE FROM linehaul_bags WHERE "createdById" = ANY($1::uuid[])`, [users]);
  // Vehicle shares and positions go with their trips (cascade).
  await sql(`DELETE FROM linehaul_trips WHERE "createdById" = ANY($1::uuid[])`, [users]);
  await fx.cleanup();
});

async function token(api: APIRequestContext, user: TempUser) {
  const res = await api.post("/api/v1/auth/login", { data: { identifier: user.login, password: user.password } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).accessToken as string;
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** Booked for the merchant (delivery in Dhanmondi) with the rider assigned for pickup. */
async function booked(api: APIRequestContext, recipient: string) {
  const opsToken = await token(api, ops);
  const res = await api.post("/api/v1/ops/parcels", {
    headers: auth(opsToken),
    data: { merchantId: shop.id, recipient: { name: recipient, phone: "01812000000" }, delivery: { category: "Home", street: "Road 7, Flat 3B", zone: "Dhanmondi", district: "Dhaka Central" }, serviceLevel: "Regular", weightKg: 1, codAmount: 500 },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).trackingId as string;
  expect((await api.post(`/api/v1/parcels/${id}/assign-pickup`, { headers: auth(opsToken), data: { riderId: rider.riderId } })).ok()).toBeTruthy();
  return id;
}
async function pickup(api: APIRequestContext, id: string, toHub: boolean) {
  const res = await api.post(`/api/v1/rider/parcels/${id}/pickup`, { headers: auth(await token(api, rider)), data: toHub ? { outcome: "COLLECTED_TO_HUB", hubId: gulshanId } : { outcome: "COLLECTED" } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

/** The Gulshan operator bags the parcel, loads it on a trip to Dhanmondi Hub and dispatches the truck. */
async function departed(api: APIRequestContext, id: string, regNo: string) {
  const h = auth(await token(api, gulOp));
  const bag = await (await api.post("/api/v1/linehaul/bags", { headers: h, data: { originHubId: gulshanId, destHubId: dhanmondiId } })).json();
  expect((await api.post(`/api/v1/linehaul/bags/${bag.number}/items`, { headers: h, data: { code: id, source: "MANUAL" } })).ok()).toBeTruthy();
  expect((await api.post(`/api/v1/linehaul/bags/${bag.number}/seal`, { headers: h, data: { sealNo: `S-${fx.stamp}` } })).ok()).toBeTruthy();
  const tripRes = await api.post("/api/v1/linehaul/trips", { headers: h, data: { originHubId: gulshanId, destHubId: dhanmondiId, vehicleRegNo: regNo, driverName: "Karim Mia", driverPhone: "01711222333" } });
  expect(tripRes.status(), await tripRes.text()).toBe(201);
  const trip = await tripRes.json();
  expect((await api.post(`/api/v1/linehaul/trips/${trip.number}/bags`, { headers: h, data: { bag: bag.number } })).ok()).toBeTruthy();
  const dep = await api.post(`/api/v1/linehaul/trips/${trip.id}/depart`, { headers: h });
  expect(dep.ok(), await dep.text()).toBeTruthy();
  return trip as { id: string; number: string; vehicleRegNo: string };
}

function watchErrors(page: Page, who: string, errors: string[]) {
  page.on("pageerror", error => errors.push(`${who}: ${error.message}`));
  page.on("console", message => {
    if (message.type() === "error" && !/status of (401|403|404)|Failed to load resource|tile\.openstreetmap/.test(message.text())) errors.push(`${who}: ${message.text()}`);
  });
}

async function signIn(browser: Browser, user: TempUser, panel: RegExp, errors: string[], options: BrowserContextOptions = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  const page = await context.newPage();
  watchErrors(page, user.name, errors);
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
  await page.evaluate(() => (window as unknown as { DF: { bridgeReady: Promise<unknown> } }).DF.bridgeReady);
  return page;
}

async function search(page: Page, id: string) {
  await page.fill("#globalSearch", id);
  await page.press("#globalSearch", "Enter");
}

test("parcel position: with rider, at a hub, in a shared vehicle (ops and merchant drawers), never on the recipient's page", async ({ browser, api }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  const withRider = await booked(api, `Map Rider ${fx.stamp}`);
  await pickup(api, withRider, false);
  const atHub = await booked(api, `Map Hub ${fx.stamp}`);
  await pickup(api, atHub, true);

  // ── The rider (on shift) sends their location from the rider app ──
  const riderToken = await token(api, rider);
  expect((await api.patch("/api/v1/rider/me/status", { headers: auth(riderToken), data: { status: "ONLINE" } })).ok()).toBeTruthy();
  const riderCtx = await browser.newContext({ viewport: { width: 420, height: 900 }, serviceWorkers: "block", permissions: ["geolocation"], geolocation: RIDER_AT });
  const riderPage = await riderCtx.newPage();
  watchErrors(riderPage, "rider", errors);
  const login = await riderPage.request.post(apiUrl("/api/v1/auth/login"), { data: { identifier: rider.login, password: rider.password }, headers: { "x-df-client": "web" } });
  expect(login.status(), await login.text()).toBe(200);
  // On shift with location allowed: the app sends a position by itself when it opens…
  const sent = riderPage.waitForResponse(r => r.url().endsWith("/api/v1/rider/location") && r.request().method() === "POST" && r.status() === 202);
  await riderPage.goto("/rider");
  await riderPage.waitForSelector("html.legacy-ready", { state: "attached" });
  await sent;
  // …and "Update my location now" sends one at once.
  await riderPage.locator("[data-df-locate]").first().click();
  await expect(riderPage.locator("#toast")).toContainText("Location sent");

  // ── Operations: global search → drawer → "With rider R-…" on the map ──
  const opsPage = await signIn(browser, ops, /\/courier-operation/, errors);
  await search(opsPage, withRider);
  const position = opsPage.locator("#parcelDrawer [data-df-position]");
  await expect(position).toHaveAttribute("data-df-position-kind", "rider");
  await expect(position.locator("[data-df-position-label]")).toContainText(`With rider ${rider.code}`);
  await expect(position.locator("[data-df-position-label]")).toContainText(/just now|min ago/);
  await expect(position.locator("[data-df-position-map].leaflet-container")).toBeVisible();
  await expect(position.locator(".leaflet-marker-icon")).toHaveCount(1);

  // ── A parcel at a hub: the hub ──
  await search(opsPage, atHub);
  await expect(opsPage.locator("#parcelDrawerTitle")).toHaveText(atHub);
  await expect(position).toHaveAttribute("data-df-position-kind", "hub");
  await expect(position.locator("[data-df-position-label]")).toHaveText("At Gulshan Sorting Hub");

  // ── The truck leaves; the rider on board starts "Travelling with a vehicle" in the rider app ──
  const regNo = `E2E MAP ${fx.stamp}`;
  const trip = await departed(api, atHub, regNo);
  await riderCtx.setGeolocation(VEHICLE_AT);
  await riderPage.goto("/rider?page=Overview");
  await riderPage.waitForSelector("html.legacy-ready", { state: "attached" });
  const panel = riderPage.locator("#dfVehiclePanel");
  await expect(panel).toHaveAttribute("data-vehicle-state", "off");
  await expect(riderPage.locator(`#dfVehicleTrip option[value="${trip.id}"]`)).toHaveCount(1);
  await riderPage.selectOption("#dfVehicleTrip", trip.id);
  const vehicleSent = riderPage.waitForResponse(r => /\/api\/v1\/vehicle-shares\/[^/]+\/location$/.test(r.url()) && r.status() === 202);
  await riderPage.click("[data-df-vehicle-start]");
  await vehicleSent;
  await expect(panel).toHaveAttribute("data-vehicle-state", "sharing");
  await expect(riderPage.locator("#dfVehicleStatus")).toContainText(trip.number);

  // ── Operations: the parcel on that trip is "In vehicle …"; Transfers lists the moving vehicle ──
  await search(opsPage, atHub);
  await expect(position).toHaveAttribute("data-df-position-kind", "vehicle");
  await expect(position.locator("[data-df-position-label]")).toContainText(`In vehicle ${trip.vehicleRegNo} (Gulshan Sorting Hub → Dhanmondi Hub)`);
  await expect(position.locator("[data-df-position-map].leaflet-container")).toBeVisible();
  await opsPage.keyboard.press("Escape");
  await opsNav(opsPage, "transfersOnTheRoad");
  await expect(opsPage.locator(`#vhPanel [data-vehicle-trip="${trip.number}"]`)).toContainText(trip.vehicleRegNo);
  await expect(opsPage.locator("#vhPanel .leaflet-container")).toBeVisible();

  // ── The merchant's drawer: the vehicle too (their own parcel) ──
  const shopPage = await signIn(browser, owner, /\/ecommerce-merchant/, errors);
  await search(shopPage, atHub);
  const shopPosition = shopPage.locator("#merchantParcelPosition [data-df-position]");
  await expect(shopPosition).toHaveAttribute("data-df-position-kind", "vehicle");
  await expect(shopPosition.locator("[data-df-position-label]")).toContainText(`In vehicle ${trip.vehicleRegNo}`);
  // …and their picked-up parcel never shows the rider (no live-location rule outside out for delivery).
  await search(shopPage, withRider);
  await expect(shopPage.locator("#merchantParcelTitle")).toHaveText(withRider);
  await expect(shopPosition).toHaveAttribute("data-df-position-kind", "none");
  await expect(shopPosition).not.toContainText(rider.code);

  // ── The recipient's tracking page: no vehicle, no coordinates ──
  const publicTrack = await api.get(`/api/v1/track/${atHub}`);
  expect(publicTrack.ok()).toBeTruthy();
  const body = await publicTrack.text();
  expect(body).not.toContain(String(VEHICLE_AT.latitude));
  expect(body).not.toContain(trip.vehicleRegNo);
  const guest = await browser.newContext();
  const trackPage = await guest.newPage();
  await trackPage.goto(`/track/${atHub}`);
  await expect(trackPage.getByText(atHub).first()).toBeVisible();
  await expect(trackPage.locator("body")).not.toContainText("In vehicle");
  await expect(trackPage.locator("body")).not.toContainText(trip.vehicleRegNo);
  expect(await trackPage.locator("[data-df-position]").count()).toBe(0);

  // Stop sharing from the rider app (in-page confirm).
  await riderPage.click("[data-df-vehicle-stop]");
  await confirmDialog(riderPage, { title: "Stop sharing the vehicle's location?" });
  await expect(panel).toHaveAttribute("data-vehicle-state", "off");

  await Promise.all([riderCtx.close(), opsPage.context().close(), shopPage.context().close(), guest.close()]);
  expect(errors).toEqual([]);
});

test("super admin: Rider plans shows the rider location interval from the server (read only here)", async ({ browser, api }) => {
  const errors: string[] = [];
  const admin = await fx.user(`E2E-Admin-${fx.stamp} Test`, [{ role: "SUPER_ADMIN" }]);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  watchErrors(page, "admin", errors);
  const WEB = { "x-df-client": "web" };
  const login = await (await page.request.post(apiUrl("/api/v1/auth/login"), { headers: WEB, data: { identifier: admin.login, password: admin.password } })).json();
  expect(login.mfaSetupRequired, JSON.stringify(login)).toBe(true);
  const setup = await (await page.request.post(apiUrl("/api/v1/auth/mfa/setup"), { headers: WEB, data: { mfaToken: login.mfaToken } })).json();
  const enabled = await page.request.post(apiUrl("/api/v1/auth/mfa/enable"), { headers: WEB, data: { mfaToken: login.mfaToken, code: authenticator.generate(setup.secret) } });
  expect(enabled.ok(), await enabled.text()).toBe(true);
  const current = await (await api.get("/api/v1/settings/location", { headers: { authorization: `Bearer ${(await enabled.json()).accessToken}` } })).json();
  await page.goto("/super-admin");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.click('#navigation [data-page="Rider plans"]');
  const panel = page.locator("#dfLocationSettings");
  await expect(panel.locator("#dfLocationInterval")).toHaveValue(String(current.intervalMinutes));
  await expect(panel.locator("#dfLocationMeters")).toHaveValue(String(current.movementMeters));
  await expect(panel.locator("#dfLocationInterval option")).toHaveText([/Every 2 minutes/, /Every 5 minutes \(default\)/, /Every 10 minutes/]);
  // Inline check (nothing is saved: the shared settings stay as they are).
  await page.fill("#dfLocationMeters", "5");
  await panel.locator('button[type="submit"]').click();
  await expect(panel.locator(".df-field-error")).toContainText("25 to 1000");
  await context.close();
  expect(errors).toEqual([]);
});
