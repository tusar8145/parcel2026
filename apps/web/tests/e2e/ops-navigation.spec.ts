import { type Browser, type Page } from "@playwright/test";
import { Fixtures, expect, opsNav, sql, test, type TempMerchant, type TempRider, type TempUser } from "./support";

// Courier Operations navigation around the parcel journey (public/legacy/courier-operation/
// bridge-nav.js, bridge-parcel.js): the menu each role sees, live stage counts, stage filters, the
// "next action" button, the parcel drawer from the global search and old page names.
// Every account and parcel is temporary (support.ts Fixtures) and deleted afterwards.
const fx = new Fixtures();
let shop: TempMerchant;
let rider: TempRider;
let OPS: TempUser;
let HUB: TempUser;
let FINANCE: TempUser;
let SUPPORT: TempUser;
test.beforeAll(async () => {
  shop = await fx.merchant({ label: "Nav Shop" });
  rider = await fx.rider("Gulshan Sorting Hub");
  OPS = await fx.staff("OPS_MANAGER");
  HUB = await fx.staff("HUB_OPERATOR", "Gulshan Sorting Hub");
  FINANCE = await fx.staff("FINANCE");
  SUPPORT = await fx.staff("SUPPORT_AGENT");
});
test.afterAll(() => fx.cleanup());

type Win = { DF: { bridgeReady: Promise<unknown>; api: (path: string, init?: unknown) => Promise<any> } };

/** Signs in on a fresh context, opens Courier Operations and waits for its data. Collects page errors. */
async function signedIn(browser: Browser, user: TempUser, errors: string[]) {
  const context = await browser.newContext();
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
  await ready(page);
  return page;
}
async function ready(page: Page) {
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.evaluate(() => (window as unknown as Win).DF.bridgeReady);
}
const visibleMenu = (page: Page) => page.locator("#navigation [data-nav]:visible").evaluateAll(items => items.map(i => (i as HTMLElement).dataset.nav));

test("each role sees its own menu", async ({ browser }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const all = ["Today", "New orders", "Pickup", "Hub desk", "Transfers", "Delivery", "Problems", "Returns", "COD & settlement", "All parcels", "Reports", "Riders", "Merchants", "Hubs & zones", "CN stock", "Settings"];

  const ops = await signedIn(browser, OPS, errors);
  await expect.poll(() => visibleMenu(ops)).toEqual(all);
  await ops.context().close();

  // Hub managers: the journey, All parcels, Riders (they read riders) and the COD page where they receive riders' cash.
  const hub = await signedIn(browser, HUB, errors);
  await expect.poll(() => visibleMenu(hub)).toEqual(["Today", "New orders", "Pickup", "Hub desk", "Transfers", "Delivery", "Problems", "Returns", "COD & settlement", "All parcels", "Riders"]);
  await hub.context().close();

  // Finance: COD & settlement first, and it opens there.
  const finance = await signedIn(browser, FINANCE, errors);
  await expect.poll(() => visibleMenu(finance)).toEqual(["COD & settlement", "All parcels", "Reports", "Merchants"]);
  await expect(finance.locator("#breadcrumbLabel")).toHaveText("COD & settlement");
  await expect(finance.locator('#navigation [data-nav="COD & settlement"]')).toHaveClass(/active/);
  await finance.context().close();

  // Support: All parcels, Today and the support inbox.
  const support = await signedIn(browser, SUPPORT, errors);
  await expect.poll(() => visibleMenu(support)).toEqual(["Today", "All parcels"]);
  await expect(support.locator('#navigation [data-page="Support"]')).toBeVisible();
  await support.context().close();
  expect(errors).toEqual([]);
});

test("stage counts, the New orders filter, the next action, the drawer from the global search and old page names", async ({ browser }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  const page = await signedIn(browser, OPS, errors);
  const api = <T = any>(path: string, init?: unknown) => page.evaluate(([p, i]) => (window as unknown as Win).DF.api(p as string, i), [path, init] as const) as Promise<T>;
  const pending = async () => (await api<{ shipments: { byStatus: Record<string, number> } }>("/ops/overview")).shipments.byStatus.PENDING_CONFIRMATION;
  const navCount = async () => Number((await page.locator('#navigation [data-stage-count="New orders"]').textContent())!.replace(/,/g, ""));

  // ── Counts: the menu badge and the Today card show the database's count, and follow a new booking live ──
  await expect(page.locator("#stageCards [data-stage-open]")).toHaveCount(7);
  await expect.poll(async () => (await navCount()) === (await pending())).toBe(true);
  await expect(page.locator('#stageCards [data-stage-count="New orders"]')).toHaveText((await page.locator('#navigation [data-stage-count="New orders"]').textContent())!);
  const before = await navCount();
  const booked = await api<{ trackingId: string }>("/ops/parcels", {
    method: "POST",
    body: {
      merchantId: shop.id,
      recipient: { name: `Nav E2E ${fx.stamp}`, phone: "01812000000" },
      delivery: { category: "Office", street: "Road 7, Flat 3B", zone: "Dhanmondi", district: "Dhaka Central" },
      serviceLevel: "Regular",
      weightKg: 1,
      packaging: "Small carton",
      contents: "Clothing",
      codAmount: 300,
    },
  });
  const trackingId = booked.trackingId;
  await expect.poll(navCount, { timeout: 20_000 }).toBeGreaterThan(before);
  await expect.poll(async () => (await navCount()) === (await pending())).toBe(true);

  // ── A stage card opens the stage; New orders lists only orders waiting for operations ──
  await page.click('#stageCards [data-stage-open="New orders"]');
  await expect(page.locator("#breadcrumbLabel")).toHaveText("New orders");
  await expect(page.locator("#mainContent h1")).toHaveText("New orders");
  await expect(page.locator('#navigation [data-nav="New orders"]')).toHaveClass(/active/);
  const rows = page.locator("#shipmentBody tr[data-shipment-id]:visible");
  await expect(rows.first()).toBeVisible();
  const statuses = await rows.locator("td:nth-child(6) .status").evaluateAll(cells => cells.slice(0, 50).map(c => c.textContent));
  expect(statuses.every(s => /^(Pending operations confirmation|Awaiting drop-off)/.test(s || ""))).toBe(true);
  // Search reaches the new order; the stage's bulk update and the import are on the page.
  await page.fill("#shipmentSearch", trackingId);
  const row = page.locator(`#shipmentBody tr[data-shipment-id="${trackingId}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#stageBulkUpdate")).toBeVisible();
  await expect(page.locator("#courierImport")).toBeVisible();
  await page.click("#stageBulkUpdate");
  await expect(page.locator("#dfImportTitle")).toHaveText("Bulk update by Excel");
  await expect(page.locator('[data-dfi="preset"][data-preset="pending_review"]')).toHaveAttribute("aria-pressed", "true");
  await page.click('[data-dfi="close"]');

  // ── Next action: "Accept & assign rider" on the pending order opens the existing assign dialog ──
  const next = row.locator(".button-primary", { hasText: "Accept & assign rider" });
  await expect(next).toBeVisible();
  await next.click();
  await expect(page.locator("#modalTitle")).toHaveText("Assign rider");
  await expect(page.locator("#assignShipment")).toHaveValue(trackingId);
  const riderValue = await page.locator("#assignRider option", { hasText: rider.code }).first().getAttribute("value");
  await page.selectOption("#assignRider", riderValue!);
  await page.click("#modalSubmit");
  await expect(page.locator("#toast")).toContainText(`${trackingId} assigned to ${rider.code}`);
  await expect.poll(async () => (await sql<{ status: string }>(`SELECT status FROM parcels WHERE "trackingId" = $1`, [trackingId]))[0].status).toBe("PICKUP_ASSIGNED");
  await page.fill("#shipmentSearch", "");

  // ── Global search (tracking ID, typed in lower case as a scanner might) → the parcel drawer, from another page ──
  await opsNav(page, "reports");
  await page.fill("#globalSearch", trackingId.toLowerCase());
  await page.press("#globalSearch", "Enter");
  const drawer = page.locator("#parcelDrawer");
  await expect(drawer).toBeVisible();
  await expect(page.locator("#parcelDrawerTitle")).toHaveText(trackingId);
  await expect(drawer).toContainText("Pickup assigned", { timeout: 20_000 });
  await expect(drawer).toContainText("Tracking history");
  await expect(drawer).toContainText("Delivery charge");
  await expect(drawer).toContainText(shop.name);
  await expect(page.locator("#breadcrumbLabel")).toHaveText("Reports"); // the page stays
  await page.click("#parcelDrawerClose");
  await expect(drawer).toBeHidden();

  // ── Old page names still open the right place: render(name) and ?page= ──
  const renderOld = (name: string) => page.evaluate(n => (window as unknown as { render: (p: string) => void }).render(n), name);
  await renderOld("Analytics");
  await expect(page.locator("#breadcrumbLabel")).toHaveText("Reports");
  await expect(page.locator('[data-nav-tab="Analytics & SLA"]')).toHaveAttribute("aria-selected", "true");
  await renderOld("COD & finance");
  await expect(page.locator("#breadcrumbLabel")).toHaveText("COD & settlement");
  await renderOld("Dispatch");
  await expect(page.locator("#breadcrumbLabel")).toHaveText("Delivery");
  await renderOld("Scheduled pickups");
  await expect(page.locator("#breadcrumbLabel")).toHaveText("Pickup");
  await expect(page.locator('[data-nav-tab="Scheduled pickups"]')).toHaveAttribute("aria-selected", "true");
  for (const [old, label, tab] of [
    ["Linehaul", "Transfers", null],
    ["Hubs", "Hub desk", "Receive"],
    ["E-commerce operations", "All parcels", "E-commerce"],
    ["Exceptions", "Problems", "Exceptions"],
    ["hub desk", "Hub desk", "Receive"],
  ] as const) {
    await page.goto(`/courier-operation?page=${encodeURIComponent(old)}`);
    await ready(page);
    await expect(page.locator("#breadcrumbLabel")).toHaveText(label);
    if (tab) await expect(page.locator(`[data-nav-tab="${tab}"]`)).toHaveAttribute("aria-selected", "true");
  }
  await page.goto(`/courier-operation?page=${encodeURIComponent("Hub desk")}&tab=${encodeURIComponent("Drop-off receive")}`);
  await ready(page);
  await expect(page.locator("#receiveDesk")).toBeVisible();
  await expect(page.locator("#hubScanForm")).toBeHidden();
  expect(errors).toEqual([]);
});
