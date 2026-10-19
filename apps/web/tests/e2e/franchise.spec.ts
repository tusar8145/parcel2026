import { type Browser, type Page } from "@playwright/test";
import { hash as argonHash } from "@node-rs/argon2";
import { authenticator } from "otplib";
import { Fixtures, apiUrl, confirmDialog, expect, opsNav, sql, test, type TempUser } from "./support";

/**
 * Franchise hubs through the real UI (owner spec 2026-10-18): super admin creates a franchise (a hub tagged Franchise,
 * one account, commission rates); the franchise account signs in to its panel, adds its rider and sets rider pay;
 * a merchant pickup handed to the franchise is assigned, picked up, received and delivered by the franchise rider;
 * the franchise receives the rider's cash and deposits it at a company hub, which confirms it in Courier Operations;
 * a walk-in is booked at the counter; a commission invoice is created; suspension closes the panel.
 * Everything is temporary: the fixtures' accounts and merchant, and the franchise rows and hub (removed afterwards;
 * ledger entries stay, as always).
 */
const fx = new Fixtures();
const WEB = { "x-df-client": "web" };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const NAME = `E2E Mirpur Point ${fx.stamp}`;
const HUB = `E2E Mirpur Franchise ${fx.stamp}`;
let admin: TempUser;
let owner: TempUser;

test.afterAll(async () => {
  const [f] = await sql<{ id: string; hubId: string; ownerId: string }>(`SELECT id, "hubId", "ownerId" FROM franchises WHERE name = $1`, [NAME]);
  if (f) {
    const riders = await sql<{ id: string; userId: string; phone: string }>(`SELECT r.id, r."userId", u.phone FROM riders r JOIN users u ON u.id = r."userId" WHERE r."hubId" = $1`, [f.hubId]);
    for (const r of riders) await fx.adoptUser(r.phone.replace(/^\+880/, ""));
    const parcels = await sql<{ trackingId: string }>(`SELECT "trackingId" FROM parcels WHERE "currentHubId" = $1 OR "dropOffHubId" = $1 OR "pickupHubId" = $1`, [f.hubId]);
    for (const p of parcels) fx.adoptParcel(p.trackingId);
    await sql(`DELETE FROM franchise_commissions WHERE "franchiseId" = $1`, [f.id]);
    await sql(`DELETE FROM franchise_counter_charges WHERE "franchiseId" = $1`, [f.id]);
    await sql(`DELETE FROM franchise_invoices WHERE "franchiseId" = $1`, [f.id]);
    await sql(`DELETE FROM franchise_remittances WHERE "franchiseId" = $1`, [f.id]);
    await sql(`DELETE FROM rider_payouts WHERE "franchiseId" = $1`, [f.id]);
    await sql(`DELETE FROM user_roles WHERE "hubId" = $1 AND role = 'FRANCHISE'`, [f.hubId]);
    await sql(`DELETE FROM franchises WHERE id = $1`, [f.id]);
    // Rider cash received at the franchise hub (before the riders go).
    await sql(`UPDATE cod_collections SET "handoverId" = NULL WHERE "handoverId" IN (SELECT id FROM cash_handovers WHERE "hubId" = $1)`, [f.hubId]);
    await sql(`DELETE FROM cash_handover_requests WHERE "hubId" = $1`, [f.hubId]);
    await sql(`DELETE FROM cash_handovers WHERE "hubId" = $1`, [f.hubId]);
    await fx.cleanup();
    await sql(`DELETE FROM user_roles WHERE "hubId" = $1`, [f.hubId]);
    await sql(`DELETE FROM cash_handover_requests WHERE "hubId" = $1`, [f.hubId]);
    await sql(`DELETE FROM cash_handovers WHERE "hubId" = $1`, [f.hubId]);
    await sql(`DELETE FROM scan_events WHERE "hubId" = $1`, [f.hubId]);
    await sql(`DELETE FROM hubs WHERE id = $1`, [f.hubId]);
  } else await fx.cleanup();
});

async function open(browser: Browser) {
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  return { page, errors };
}
async function signIn(page: Page, user: TempUser, to: RegExp) {
  await page.goto("/login");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.fill("#loginIdentity", user.login);
  await page.fill("#loginPassword", user.password);
  await page.click('form[data-form="login"] button[type="submit"]');
  await page.waitForURL(to);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
}
async function signInAdmin(page: Page) {
  const login = await (await page.request.post(apiUrl("/api/v1/auth/login"), { headers: WEB, data: { identifier: admin.phone, password: admin.password } })).json();
  const setup = await (await page.request.post(apiUrl("/api/v1/auth/mfa/setup"), { headers: WEB, data: { mfaToken: login.mfaToken } })).json();
  await page.request.post(apiUrl("/api/v1/auth/mfa/enable"), { headers: WEB, data: { mfaToken: login.mfaToken, code: authenticator.generate(setup.secret) } });
  await page.goto("/super-admin");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
}
async function token(page: Page, identifier: string, password: string) {
  const res = await page.request.post(apiUrl("/api/v1/auth/login"), { headers: WEB, data: { identifier, password } });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()).accessToken as string;
}
const auth = (t: string) => ({ authorization: `Bearer ${t}`, ...WEB });

test("franchise hub end to end through the UI", async ({ browser }) => {
  test.setTimeout(720_000);
  admin = await fx.user(`E2E Franchise Admin ${fx.stamp}`, [{ role: "SUPER_ADMIN" }]);
  owner = await fx.user(`E2E Franchise Owner ${fx.stamp}`, [{ role: "CUSTOMER" }]);
  const ops = await fx.staff("OPS_MANAGER");
  const hubOp = await fx.staff("HUB_OPERATOR", "Gulshan Sorting Hub");
  const shop = await fx.merchant({ label: "Franchise Shop" });
  const shopOwner = await fx.member(shop);

  // ── Super admin → Franchises → Add franchise ──
  const a = await open(browser);
  await signInAdmin(a.page);
  await a.page.click('#navigation [data-page="Franchises"]');
  await expect(a.page.locator("#mainContent h1")).toHaveText("Franchises");
  await a.page.click("#frNew");
  await a.page.fill("#frName", NAME);
  await a.page.fill("#frContact", owner.name);
  await a.page.fill("#frPhone", owner.login);
  await a.page.fill("#frHubName", HUB);
  await a.page.selectOption("#frDistrict", "Dhaka North");
  await a.page.selectOption("#frZone", "Gulshan");
  await a.page.fill("#frAddress", "Road 10, Mirpur");
  await a.page.fill("#fr-pickupPercent", "10");
  await a.page.fill("#fr-pickupMin", "15");
  await a.page.fill("#fr-deliveryPercent", "20");
  await a.page.fill("#fr-deliveryMin", "20");
  await a.page.click('#frForm button[type="submit"]');
  const row = a.page.locator(`#frTable tr`, { hasText: NAME });
  await expect(row).toContainText(HUB);
  await expect(row).toContainText("Active");
  const [fr] = await sql<{ id: string; hubId: string; code: string }>(`SELECT id, "hubId", code FROM franchises WHERE name = $1`, [NAME]);

  // ── The franchise account signs in on the website → its panel ──
  const f = await open(browser);
  await signIn(f.page, owner, /\/franchise/);
  await expect(f.page.locator("#frName")).toHaveText(NAME);
  await expect(f.page.locator("#frSidebar .fr-tag")).toHaveText("Franchise");
  await expect(f.page.locator("#frToday")).toBeVisible();

  // Riders: add one, set rider pay.
  await f.page.click('#frSidebar [data-page="riders"]');
  await expect(f.page).toHaveURL(/page=riders/);
  await f.page.fill("#frRatePickup", "20");
  await f.page.fill("#frRateDelivery", "30");
  await f.page.click('#frRatesForm button[type="submit"]');
  await expect(f.page.locator("#frToast")).toContainText("Rider pay saved");
  const riderLocal = `19${String(Date.now()).slice(-8)}`;
  await f.page.click("#frAddRider");
  await f.page.fill("#arName", `E2E Franchise Rider ${fx.stamp}`);
  await f.page.fill("#arPhone", `0${riderLocal}`);
  await f.page.click('#frAddRiderForm button[type="submit"]');
  await expect(f.page.locator("#frRiders")).toContainText(`E2E Franchise Rider ${fx.stamp}`);
  await fx.adoptUser(riderLocal);
  const riderPassword = "Rider-pass-2026";
  await sql(`UPDATE users SET "passwordHash" = $1 WHERE phone = $2`, [await argonHash(riderPassword, { memoryCost: 19456, timeCost: 2, parallelism: 1 }), `+880${riderLocal}`]);
  const [rider] = await sql<{ id: string }>(`SELECT r.id FROM riders r JOIN users u ON u.id = r."userId" WHERE u.phone = $1`, [`+880${riderLocal}`]);

  // A merchant pickup handed to the franchise hub (operations). Other people's API calls run in their own context:
  // their sign-ins must not replace the franchise's session cookie.
  const apiPage = await (await browser.newContext()).newPage();
  const shopToken = await token(apiPage, shopOwner.login, shopOwner.password);
  const booked = await apiPage.request.post(apiUrl("/api/v1/parcels"), {
    headers: auth(shopToken),
    data: {
      sender: { name: "Shop", phone: "01711000000" },
      pickup: { category: "Office", street: "House 12, Road 11", zone: "Gulshan", district: "Dhaka North" },
      recipient: { name: "Nabila Ahmed", phone: "01812000000" },
      delivery: { category: "Home", street: "Road 7, Flat 3B", zone: "Gulshan", district: "Dhaka North" },
      serviceLevel: "Regular",
      weightKg: 1,
      codAmount: 500,
    },
  });
  expect(booked.ok(), await booked.text()).toBe(true);
  const trackingId = (await booked.json()).trackingId as string;
  fx.adoptParcel(trackingId);
  const opsToken = await token(apiPage, ops.login, ops.password);
  expect((await apiPage.request.post(apiUrl(`/api/v1/parcels/${trackingId}/pickup-hub`), { headers: auth(opsToken), data: { hubId: fr.hubId } })).ok()).toBe(true);

  // Parcels → Pickups → Assign rider.
  await f.page.click('#frSidebar [data-page="parcels"]');
  await f.page.click('[data-tab="pickups"]');
  const pickupRow = f.page.locator(`#frParcels tr[data-parcel="${trackingId}"]`);
  await pickupRow.locator('[data-assign="PICKUP"]').click();
  await f.page.click("#frAssignSubmit");
  const state = async () => (await sql<{ status: string; pickupRiderId: string | null; deliveryRiderId: string | null }>(`SELECT status, "pickupRiderId", "deliveryRiderId" FROM parcels WHERE "trackingId" = $1`, [trackingId]))[0];
  await expect.poll(async () => (await state()).status).toBe("PICKUP_ASSIGNED");
  expect((await state()).pickupRiderId).toBe(rider.id);

  // The rider collects it and hands it in at the franchise hub (rider app on the API).
  const riderToken = await token(apiPage, `0${riderLocal}`, riderPassword);
  const pickup = await apiPage.request.post(apiUrl(`/api/v1/rider/parcels/${trackingId}/pickup`), { headers: auth(riderToken), data: { outcome: "COLLECTED_TO_HUB", hubId: fr.hubId } });
  expect(pickup.ok(), await pickup.text()).toBe(true);

  // At your hub → Assign rider for delivery; the rider delivers it (COD 500).
  await f.page.click('[data-tab="at-hub"]');
  await f.page.locator(`#frParcels tr[data-parcel="${trackingId}"] [data-assign="DELIVERY"]`).click();
  await expect(f.page.locator("#frAssignRider")).toHaveValue(rider.id);
  await f.page.click("#frAssignSubmit");
  await expect.poll(async () => (await state()).status).toBe("ASSIGNED");
  expect((await state()).deliveryRiderId).toBe(rider.id);
  const started = await apiPage.request.post(apiUrl(`/api/v1/rider/parcels/${trackingId}/start-delivery`), { headers: auth(riderToken) });
  expect(started.ok(), await started.text()).toBe(true);
  const delivered = await apiPage.request.post(apiUrl(`/api/v1/rider/parcels/${trackingId}/delivery`), {
    headers: auth(riderToken),
    data: { outcome: "DELIVERED", receivedBy: "Nabila", proof: { method: "SIGNATURE", image: PNG }, codCollected: 500 },
  });
  expect(delivered.ok(), await delivered.text()).toBe(true);
  const commissions = await sql<{ type: string }>(`SELECT type FROM franchise_commissions WHERE "franchiseId" = $1 ORDER BY "earnedAt"`, [fr.id]);
  expect(commissions.map(c => c.type)).toEqual(["PICKUP", "DELIVERY"]);

  // Money: receive the rider's cash, then deposit at a company hub.
  await f.page.click('#frSidebar [data-page="money"]');
  const cashRow = f.page.locator(`#frRiderCash tr[data-rider-cash="${rider.id}"]`);
  await cashRow.locator("button").click();
  await expect(f.page.locator("#frToast")).toContainText("received");
  await expect(f.page.locator("#frCash")).toContainText("৳500");
  await f.page.click("#frDeposit");
  await f.page.selectOption("#frDepositHub", { label: "Gulshan Sorting Hub (Dhaka North)" });
  const net = (await f.page.locator("#frDepositNet").textContent())!.trim();
  await f.page.click("#frDepositSubmit");
  await expect(f.page.locator("#frDeposits")).toContainText("Waiting for the hub");

  // The company hub receives it in Courier Operations → COD & settlement.
  const h = await open(browser);
  await signIn(h.page, hubOp, /\/courier-operation/);
  await opsNav(h.page, "codFranchise");
  const depositRow = h.page.locator("#frDepositsPanel tr", { hasText: NAME });
  await expect(depositRow).toContainText(net.replace("৳", "৳ "));
  await depositRow.locator("[data-fr-receive]").click();
  await confirmDialog(h.page, { title: "Receive the franchise deposit?" });
  await expect(h.page.locator("#frDepositsPanel")).toContainText("No franchise deposit waiting", { timeout: 20_000 });
  await f.page.reload();
  await f.page.waitForSelector("html.legacy-ready", { state: "attached" });
  await f.page.waitForSelector("#frDeposits", { state: "attached", timeout: 30_000 });
  await expect(f.page.locator("#frDeposits")).toContainText("Received");

  // Commission invoice (DEDUCT mode by default: already settled from the deposit).
  await f.page.click("#frCreateInvoice");
  await expect(f.page.locator("#frInvoices")).toContainText("Paid");

  // Walk-in at the counter.
  await f.page.click('#frSidebar [data-page="walk-in"]');
  await f.page.fill("#wiSenderName", "Karim Walk-in");
  await f.page.fill("#wiSenderPhone", "01711222333");
  await f.page.fill("#wiRecipientName", "Rupa Akter");
  await f.page.fill("#wiRecipientPhone", "01812333444");
  await f.page.selectOption("#wiDistrict", "Dhaka North");
  await f.page.selectOption("#wiZone", "Gulshan");
  await f.page.fill("#wiStreet", "House 3, Road 2");
  await expect(f.page.locator("#frQuoteTotal")).toBeVisible();
  const price = (await f.page.locator("#frQuoteTotal").textContent())!.trim();
  await f.page.click("#frBook");
  await expect(f.page.locator("#frBookedPaid")).toHaveText(price);
  fx.adoptParcel((await f.page.locator("#frBookedId").textContent())!.trim());

  // Super admin > Hubs & zones shows the hub with its Franchise tag.
  await a.page.click('#navigation [data-page="Hubs & zones"]');
  await expect(a.page.locator(`#hzHubs tr[data-hub-row="${fr.hubId}"] [data-hub-tag]`)).toHaveText("Franchise", { timeout: 20_000 });

  // Super admin suspends it: the panel closes.
  await a.page.reload();
  await a.page.waitForSelector("html.legacy-ready", { state: "attached" });
  await a.page.click('#navigation [data-page="Franchises"]');
  await a.page.locator(`#frTable tr[data-franchise="${fr.code}"] [data-fr-status]`).click();
  await confirmDialog(a.page, { title: new RegExp(`Suspend`) });
  await expect(a.page.locator(`#frTable tr[data-franchise="${fr.code}"]`)).toContainText("Suspended");
  await signIn(f.page, owner, /\/franchise/).catch(() => undefined);
  await f.page.goto("/franchise");
  await expect(f.page.locator("#frBlocked")).toContainText("This franchise is suspended", { timeout: 20_000 });

  for (const p of [a, f, h]) expect(p.errors).toEqual([]);
});
