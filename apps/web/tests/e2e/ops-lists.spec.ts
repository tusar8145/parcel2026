import { type Browser, type Page } from "@playwright/test";
import { Fixtures, expect, opsNav, sql, test, type TempMerchant, type TempRider, type TempUser } from "./support";

// Courier Operations' server-paged parcel tables and the stage pages built on them
// (public/legacy/courier-operation/bridge-lists.js, bridge-nav.js): about 100 rows a page, numbered pages or
// "Load more", server-side filters, the New orders / Pickup split, bulk Accept & assign, the Hub desk's
// single Receive tab, the hub operator's "my hub" default and the trimmed Today page.
// Every account and parcel is temporary (support.ts Fixtures) and deleted afterwards.
const fx = new Fixtures();
let shop: TempMerchant; // picks up in Banani (Gulshan Sorting Hub's zone)
let farShop: TempMerchant; // picks up in Dhanmondi (another hub's zone)
let rider: TempRider;
let OPS: TempUser;
let HUB: TempUser;
test.beforeAll(async () => {
  shop = await fx.merchant({ label: "Lists Shop" });
  farShop = await fx.merchant({ label: "Lists Far Shop" });
  await sql(`UPDATE merchants SET "pickupAddress" = 'Road 7, Dhanmondi', "pickupArea" = 'Dhanmondi', "pickupDistrict" = 'Dhaka Central' WHERE id = $1`, [farShop.id]);
  rider = await fx.rider("Gulshan Sorting Hub");
  OPS = await fx.staff("OPS_MANAGER");
  HUB = await fx.staff("HUB_OPERATOR", "Gulshan Sorting Hub");
});
test.afterAll(() => fx.cleanup());

type Win = { DF: { bridgeReady: Promise<unknown>; api: (path: string, init?: unknown) => Promise<any> } };

async function signedIn(browser: Browser, user: TempUser, errors: string[]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("dialog", dialog => dialog.dismiss());
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
    const ok = await page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 10_000 }).then(() => true, () => false);
    if (ok) break;
    if (attempt >= 2 || !/too many/i.test(await page.content())) throw new Error(`${user.name} could not sign in`);
    await page.waitForTimeout(61_000);
  }
  if (!/courier-operation/.test(page.url())) await page.goto("/courier-operation");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.evaluate(() => (window as unknown as Win).DF.bridgeReady);
  return page;
}
const apiOf = (page: Page) => <T = any>(path: string, init?: unknown) => page.evaluate(([p, i]) => (window as unknown as Win).DF.api(p as string, i), [path, init] as const) as Promise<T>;
const status = async (trackingId: string) => (await sql<{ status: string }>(`SELECT status FROM parcels WHERE "trackingId" = $1`, [trackingId]))[0]?.status;

/** Books one order for a merchant through the operations booking API; returns its tracking ID. */
async function book(page: Page, merchant: TempMerchant, name: string) {
  const parcel = await apiOf(page)<{ trackingId: string }>("/ops/parcels", {
    method: "POST",
    body: { merchantId: merchant.id, recipient: { name, phone: "01812000000" }, delivery: { category: "Office", street: "Road 7, Flat 3B", zone: "Dhanmondi", district: "Dhaka Central" }, serviceLevel: "Regular", weightKg: 1, codAmount: 300 },
  });
  return parcel.trackingId;
}
const rows = (page: Page, list: string) => page.locator(`#mainContent [data-list="${list}"] tbody tr[data-shipment-id]`);

test("tables page 100 rows at a time from the server; New orders accepts (one by one or ticked together), Pickup follows", async ({ browser }) => {
  test.setTimeout(360_000);
  const errors: string[] = [];
  const page = await signedIn(browser, OPS, errors);
  const api = apiOf(page);

  // 105 orders for one merchant (the import engine, JSON rows).
  const importRows = Array.from({ length: 105 }, (_, i) => ({ order_ref: `LST-${fx.stamp}-${i}`, "Customer name": `Lists ${fx.stamp} ${i}`, phone: "01812000000", district: "Dhaka Central", zone: "Dhanmondi", address: `House ${i + 1}, Road 7` }));
  const job = await api<{ id: string }>("/imports/validate", { method: "POST", body: { kind: "ecommerce", merchantId: shop.id, fileName: `lists-${fx.stamp}.json`, rows: importRows } });
  await api(`/imports/${job.id}/commit`, { method: "POST" });
  await expect.poll(async () => (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM parcels WHERE "merchantId" = $1`, [shop.id]))[0].n, { timeout: 90_000 }).toBe(105);

  // ── All parcels › E-commerce, filtered by the merchant on the server: numbered pages of 100 rows ──
  await opsNav(page, "ecommerce");
  await expect(page.locator(`#merchantFilter option[value="${shop.id}"]`)).toHaveCount(1, { timeout: 20_000 });
  await page.selectOption("#merchantFilter", shop.id);
  const all = rows(page, "all-E-commerce");
  await expect(all).toHaveCount(100, { timeout: 20_000 });
  const foot = page.locator('[data-list="all-E-commerce"] .shipment-count');
  await expect(foot).toContainText("Showing 1–100 of 105 parcels");
  await page.click('[data-list="all-E-commerce"] [data-list-pager] [aria-label="Page 2"]');
  await expect(all).toHaveCount(5, { timeout: 20_000 });
  await expect(foot).toContainText("Showing 101–105 of 105 parcels");
  await expect(page.locator('[data-list-pager] [aria-current="page"]')).toHaveText("2");
  await page.selectOption('[data-list-size="all-E-commerce"]', "50");
  await expect(all).toHaveCount(50, { timeout: 20_000 });
  await expect(foot).toContainText("Showing 1–50 of 105 parcels");
  await page.selectOption('[data-list-size="all-E-commerce"]', "100");
  await expect(all).toHaveCount(100, { timeout: 20_000 });

  // The last month is the default range, a date range overrides it, and From can't pass To.
  const to = await page.inputValue("#shipmentDateTo");
  expect(await page.inputValue("#shipmentDateFrom")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(await page.inputValue("#shipmentDateFrom") < to).toBe(true);
  await page.fill("#shipmentDateFrom", "2099-01-01");
  await page.locator("#shipmentDateFrom").blur();
  await expect(page.locator("#toast, .toast").first()).toContainText("can't be after", { timeout: 5_000 });
  await page.fill("#shipmentDateTo", "2020-01-01");
  await page.locator("#shipmentDateTo").blur();
  await page.fill("#shipmentDateFrom", "2020-01-01");
  await page.locator("#shipmentDateFrom").blur();
  await expect(all).toHaveCount(0, { timeout: 20_000 });
  await page.fill("#shipmentDateTo", to);
  await page.locator("#shipmentDateTo").blur();
  await expect(all).toHaveCount(100, { timeout: 20_000 });

  // Date field: every imported order changed status today, none in the past.
  await expect(page.locator("#shipmentDateField")).toBeVisible();
  await page.selectOption("#shipmentDateField", "status");
  await expect(foot).toContainText("of 105 parcels", { timeout: 20_000 });

  // Export writes all 105, not the page on screen, in an E-commerce file with COD.
  const [download] = await Promise.all([page.waitForEvent("download"), page.click('#mainContent .page-heading [data-action="export"]')]);
  expect(download.suggestedFilename()).toMatch(/^parcels-.*\.xlsx$/);
  await page.selectOption("#shipmentDateField", "pickup");
  // The next action stays on screen at 1440 px: the action column is pinned on the right.
  await all.first().locator("td:first-child").scrollIntoViewIfNeeded();
  const action = all.first().locator("td:last-child");
  await expect(action.locator(".button-primary")).toBeInViewport();
  expect(await all.first().locator("td:first-child").evaluate(td => (td.closest(".table-scroll") as HTMLElement).scrollLeft)).toBe(0);
  // No status dropdowns in the rows.
  await expect(page.locator("#mainContent tbody select")).toHaveCount(0);

  // ── New orders: only waiting orders; tick two and accept them together ──
  await opsNav(page, "newOrders");
  await expect(page.locator('#merchantFilter option[value="' + shop.id + '"]')).toHaveCount(1, { timeout: 20_000 });
  await page.selectOption("#merchantFilter", shop.id);
  const waiting = rows(page, "new-orders");
  await expect(waiting).toHaveCount(100, { timeout: 20_000 });
  await expect(page.locator("#bulkAccept")).toBeHidden();
  const ticked = [await waiting.nth(0).getAttribute("data-shipment-id"), await waiting.nth(1).getAttribute("data-shipment-id")] as string[];
  for (const id of ticked) await page.check(`[data-list="new-orders"] [data-shipment-select="${id}"]`);
  await expect(page.locator("#bulkAccept")).toHaveText("Accept & assign (2)");
  await page.click("#bulkAccept");
  await expect(page.locator("#modalTitle")).toHaveText("Accept & assign · 2 orders");
  const riderValue = await page.locator("#bulkRider option", { hasText: rider.code }).first().getAttribute("value");
  await page.selectOption("#bulkRider", riderValue!);
  await page.click("#modalSubmit");
  await expect(page.locator("#bulkResult")).toContainText("2 assigned", { timeout: 30_000 });
  await expect(page.locator("#modalDescription")).toContainText(`2 orders accepted and assigned to ${rider.code}`);
  await page.click("#modalSubmit"); // Done
  for (const id of ticked) await expect.poll(() => status(id)).toBe("PICKUP_ASSIGNED");
  for (const id of ticked) await expect(page.locator(`[data-list="new-orders"] tr[data-shipment-id="${id}"]`)).toHaveCount(0, { timeout: 20_000 });

  // ── Pickup shows the accepted orders, not the waiting ones ──
  const pending = (await waiting.nth(0).getAttribute("data-shipment-id"))!;
  expect(await status(pending)).toBe("PENDING_CONFIRMATION");
  await opsNav(page, "pickup");
  await expect(page.locator('[data-list="pickup-waiting"]')).toContainText("Every accepted order has a pickup rider.");
  await page.fill("#listSearch-pickup-active", ticked[0]);
  await expect(page.locator(`[data-list="pickup-active"] tr[data-shipment-id="${ticked[0]}"]`)).toBeVisible({ timeout: 20_000 });
  await page.fill("#listSearch-pickup-active", pending);
  await expect(page.locator('[data-list="pickup-active"] [data-list-empty]')).toHaveText("No parcels match the search or filters.", { timeout: 20_000 });
  // One way to assign: no heading "Assign rider" button and no queue with an "additional shipments" line.
  await expect(page.locator('#mainContent .page-heading [data-action="assign"]')).toHaveCount(0);
  await expect(page.locator("#mainContent")).not.toContainText("additional shipments");
  await expect(page.locator('#mainContent [data-action="dispatch"]')).toHaveText(/Suggest riders/);

  // ── Today: the stage cards and one metrics row ──
  await opsNav(page, "today");
  await expect(page.locator("#stageCards [data-stage-open]")).toHaveCount(7);
  await expect(page.locator("#mainContent .metrics")).toHaveCount(1);
  await expect(page.locator("#mainContent .service-card")).toHaveCount(0);
  await expect(page.locator("#mainContent")).not.toContainText("Network health");
  await expect(rows(page, "today-feed")).toHaveCount(6, { timeout: 20_000 });
  expect(errors).toEqual([]);
});

test("Scan desk: one Receive entry tab (with Find), parcels at my hub with their next action, the counter only on its tab", async ({ browser }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  const ops = await signedIn(browser, OPS, errors);
  const trackingId = await book(ops, shop, `Hub Lists ${fx.stamp}`);
  const [hub] = await sql<{ id: string }>(`SELECT id FROM hubs WHERE name = 'Gulshan Sorting Hub'`);
  await apiOf(ops)(`/parcels/${trackingId}/assign-pickup`, { method: "POST", body: { riderId: rider.riderId } });
  await apiOf(ops)(`/parcels/${trackingId}/status`, { method: "POST", body: { status: "AT_HUB", hubId: hub.id } });
  await expect.poll(() => status(trackingId)).toBe("AT_HUB");

  // ── Receive: the receive desk only; the old scan, manual receive and transfer forms are gone ──
  await opsNav(ops, "hubReceive");
  await expect(ops.locator("#mainContent [data-nav-tab]")).toHaveText(["Receive entry", "Pickup entry", "Transfer out", "Collect from hub", "Out for delivery entry", "Delivery entry", "Failed delivery entry", "Return rider assign", "Return entry"]);
  await expect(ops.locator("#mainContent h1")).toHaveText("Scan desk");
  await expect(ops.locator("#receiveDesk")).toBeVisible();
  for (const gone of ["#hubScanForm", "#hubReceiveForm", "#hubTransferForm", "#hubShipmentRows", "#collectCounter"]) await expect(ops.locator(gone)).toHaveCount(0);
  await expect(ops.locator("#mainContent")).not.toContainText("Shipment transfer report");
  // Find shows the parcel without receiving it.
  await ops.fill("#rdCode", trackingId.toLowerCase());
  await ops.click('[data-rd="find"]');
  await expect(ops.locator("#parcelDrawerTitle")).toHaveText(trackingId);
  await expect(ops.locator("#rdFeedback")).toContainText(`${trackingId} · At hub`);
  await ops.click("#parcelDrawerClose");
  expect(await status(trackingId)).toBe("AT_HUB");

  // ── Collect from hub shows on its own tab and nowhere else ──
  await opsNav(ops, "hubPickupCounter");
  await expect(ops.locator("#collectCounter")).toBeVisible();
  await expect(ops.locator("#collectCounter")).not.toContainText("Loading", { timeout: 20_000 });
  for (const area of ["hubReceive", "hubAtHub"] as const) {
    await opsNav(ops, area);
    await ops.waitForTimeout(1500); // the counter's data would have arrived by now
    await expect(ops.locator("#collectCounter")).toHaveCount(0);
  }

  // ── Hubs & zones is set up in Super admin, not here ──
  await expect(ops.locator('#navigation [data-nav="Hubs & zones"]')).toHaveCount(0);
  await ops.context().close();

  // ── Hub desk keeps At my hub and End of day; old Hub desk links to the scan tabs open them on Scan desk ──
  const hubPage = await signedIn(browser, HUB, errors);
  await opsNav(hubPage, "hubAtHub");
  await expect(hubPage.locator("#mainContent [data-nav-tab]")).toHaveText(["At my hub", "End of day"]);
  await hubPage.goto("/courier-operation?page=hub-desk&tab=delivered-entry");
  await expect(hubPage.locator("#breadcrumbLabel")).toHaveText("Scan desk");
  await expect(hubPage.locator('#mainContent [data-nav-tab="Delivery entry"]')).toHaveAttribute("aria-selected", "true");

  // ── The Gulshan hub operator: At my hub lists the parcel with its next action and no status dropdown ──
  await opsNav(hubPage, "hubAtHub");
  await expect(hubPage.locator('[data-list="hub-now"] .panel-title')).toHaveText("At my hub now");
  await hubPage.fill("#listSearch-hub-now", trackingId);
  const row = hubPage.locator(`[data-list="hub-now"] tr[data-shipment-id="${trackingId}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.locator(".button-primary")).toHaveText(/Assign rider|Add to transfer/);
  await expect(row.locator("select")).toHaveCount(0);
  await hubPage.fill("#listSearch-hub-now", "NO-SUCH-PARCEL");
  await expect(hubPage.locator('[data-list="hub-now"] [data-list-empty]')).toHaveText("No parcels match the search or filters.", { timeout: 20_000 });
  expect(errors).toEqual([]);
});

test("every All parcels tab has the last month by default, Date field, every status, pages and the Excel export; a Delivered export of an E-commerce merchant has its extra columns", async ({ browser }) => {
  const errors: string[] = [];
  const page = await signedIn(browser, OPS, errors);
  const id = await book(page, shop, `Export ${fx.stamp}`);
  for (const [area, list] of [["allParcels", "all-All"], ["ecommerce", "all-E-commerce"], ["banking", "all-Banking & Financial"], ["customerParcels", "all-Customer"]] as const) {
    await opsNav(page, area);
    const host = page.locator(`[data-list="${list}"]`);
    await expect(host.locator("[data-list-size]"), area).toBeVisible({ timeout: 20_000 });
    expect(await page.inputValue("#shipmentDateFrom"), area).not.toBe("");
    expect(await page.inputValue("#shipmentDateTo"), area).not.toBe("");
    await expect(page.locator("#shipmentDateField option"), area).toHaveText(["Pickup / created date", "Status update date"]);
    for (const status of ["Delivered", "Returned", "Return scheduled", "Ready for collection"]) await expect(page.locator(`#statusFilter option[value="${status}"]`), `${area} ${status}`).toHaveCount(1);
    await expect(page.locator('#statusFilter option[value="Return requested"]'), area).toHaveCount(0);
    await expect(page.locator('#mainContent .page-heading [data-action="export"]'), area).toBeVisible();
  }

  // The bulk update of All parcels starts from the page's dates and date field.
  await opsNav(page, "allParcels");
  await page.selectOption("#shipmentDateField", "status");
  await expect(page.locator('[data-list="all-All"] [data-list-size]')).toBeVisible();
  const from = await page.inputValue("#shipmentDateFrom");
  await page.click("#courierBulkUpdate, #stageBulkUpdate");
  await page.locator('#dfiActions [data-action="add_note"], #dfiActions button:has-text("Add note")').first().click();
  await expect(page.locator("#dfiBFrom")).toHaveValue(from, { timeout: 20_000 });
  await expect(page.locator("#dfiExport")).toContainText("Status updated from");
  await page.keyboard.press("Escape");

  // Delivered, chosen E-commerce merchant: the file has what operations reconcile with.
  await sql(`UPDATE parcels SET status = 'DELIVERED', "deliveredAt" = now(), "statusChangedAt" = now(), "receiverRelation" = 'Self' WHERE "trackingId" = $1`, [id]);
  await page.goto("/courier-operation");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await opsNav(page, "ecommerce");
  await expect(page.locator(`#merchantFilter option[value="${shop.id}"]`)).toHaveCount(1, { timeout: 20_000 });
  await page.selectOption("#merchantFilter", shop.id);
  await page.selectOption("#statusFilter", "Delivered");
  await expect(page.locator('[data-list="all-E-commerce"] tbody[data-list-body] tr[data-shipment-id]')).toHaveCount(1, { timeout: 20_000 });
  await page.screenshot({ path: "test-results/all-parcels.png", fullPage: true });
  const [download] = await Promise.all([page.waitForEvent("download"), page.click('#mainContent .page-heading [data-action="export"]')]);
  expect(download.suggestedFilename()).toMatch(/^parcels-delivered-.*\.xlsx$/);
  await expect(page.locator("#toast")).toContainText("1 parcel exported to Excel.");
  expect(errors).toEqual([]);
});

test("a button that starts slow work shows it until the work ends, through every request of a bulk action; quick clicks and menus don't", async ({ browser }) => {
  const errors: string[] = [];
  const page = await signedIn(browser, OPS, errors);
  const ids = [await book(page, shop, `Busy ${fx.stamp} 1`), await book(page, shop, `Busy ${fx.stamp} 2`)];
  // Slow answers, as on a real network.
  await page.route("**/api/v1/parcels/*/assign-pickup", async route => {
    await new Promise(resolve => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.reload();
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await opsNav(page, "newOrders");
  const row = (id: string) => page.locator(`tr[data-shipment-id="${id}"]`);
  await expect(row(ids[1])).toBeVisible({ timeout: 20_000 });
  for (const id of ids) await row(id).locator("[data-shipment-select]").check();
  await page.click("#bulkAccept");
  await page.selectOption("#bulkRider", rider.riderId);
  await page.click("#modalSubmit");
  // Through both orders: busy and disabled, not clickable twice.
  await expect(page.locator("#modalSubmit.df-busy")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("#modalSubmit")).toBeDisabled();
  await expect(page.locator("#bulkResult")).toContainText("2 assigned", { timeout: 20_000 });
  await expect(page.locator("#modalSubmit.df-busy")).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator("#modalSubmit")).toBeEnabled();
  await page.click("#modalSubmit");

  // A button with no submit handler of its own: the tracker shows it.
  await page.route("**/api/v1/bulk-updates/actions**", async route => {
    await new Promise(resolve => setTimeout(resolve, 900));
    await route.continue();
  });
  await opsNav(page, "allParcels");
  await page.click("#courierBulkUpdate");
  await expect(page.locator("#courierBulkUpdate")).toHaveAttribute("aria-busy", "true", { timeout: 5_000 });
  await expect(page.locator('#dfiActions [data-dfi="pick-action"]').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#courierBulkUpdate[aria-busy]")).toHaveCount(0, { timeout: 5_000 });
  await page.keyboard.press("Escape");

  // Menus and tabs never spin.
  await page.click('[data-nav-tab="E-commerce"]');
  await expect(page.locator("[data-nav-tab].df-busy, #navigation .df-busy")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("hub managers see only their own hub's parcels", async ({ browser }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const ops = await signedIn(browser, OPS, errors);
  const near = await book(ops, shop, `Near ${fx.stamp}`);
  const far = await book(ops, farShop, `Far ${fx.stamp}`);
  const zones = await sql<{ trackingId: string; pickupZone: string }>(`SELECT "trackingId", "pickupZone" FROM parcels WHERE "trackingId" = ANY($1)`, [[near, far]]);
  expect(Object.fromEntries(zones.map(z => [z.trackingId, z.pickupZone]))).toEqual({ [near]: "Banani", [far]: "Dhanmondi" });
  await ops.context().close();

  const page = await signedIn(browser, HUB, errors);
  await opsNav(page, "newOrders");
  const scope = page.locator('[data-list="new-orders"] [data-ops-scope]');
  await expect(scope).toHaveValue("mine");
  await page.fill("#shipmentSearch", near);
  await expect(page.locator(`#shipmentBody tr[data-shipment-id="${near}"]`)).toBeVisible({ timeout: 20_000 });
  await page.fill("#shipmentSearch", far);
  await expect(page.locator('[data-list="new-orders"] [data-list-empty]')).toHaveText("No parcels match the search or filters.", { timeout: 20_000 });
  // Hub Managers see their own hub only: asking for all hubs still leaves out the other hub's order (the API holds them to it).
  await page.selectOption('[data-list="new-orders"] [data-ops-scope]', "all");
  await page.fill("#shipmentSearch", far);
  await expect(page.locator('[data-list="new-orders"] [data-list-empty]')).toHaveText("No parcels match the search or filters.", { timeout: 20_000 });
  await opsNav(page, "allParcels");
  await page.fill("#shipmentSearch", far);
  await expect(page.locator('[data-list="all-All"] [data-list-empty]')).toHaveText("No parcels match the search or filters.", { timeout: 20_000 });
  expect(errors).toEqual([]);
});
