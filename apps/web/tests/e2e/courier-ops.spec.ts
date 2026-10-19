import { Fixtures, expect, opsNav, test, type TempUser } from "./support";

// Read-only smoke test of the courier-operations additions (linehaul, CN stock, reports, maps,
// SLA, shifts, Add rider / Create dispatch dialogs). Signs in as a temporary operations manager
// (deleted afterwards); nothing else is created in the database.
const fx = new Fixtures();
let ops: TempUser;
test.beforeAll(async () => {
  ops = await fx.staff("OPS_MANAGER");
});
test.afterAll(() => fx.cleanup());

test("operations pages added for linehaul, CN stock, reports, SLA, shifts and maps render", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/status of 401|tile\.openstreetmap|Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  page.on("dialog", dialog => dialog.dismiss());
  await page.goto("/login");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.fill("#loginIdentity", ops.login);
  await page.fill("#loginPassword", ops.password);
  await page.click('form[data-form="login"] button[type="submit"]');
  // The website may land on the account page first; the operations panel is a direct link.
  await page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 30_000 });
  if (!/courier-operation/.test(page.url())) await page.goto("/courier-operation");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(page, (await page.locator("body").innerText()).slice(0, 300)).toHaveURL(/courier-operation/);

  await opsNav(page, "transfers");
  await expect(page.locator("#mainContent h1")).toHaveText("Transfers");
  await expect(page.locator("#lhTrips .panel-title")).toHaveText("Trips & manifests");
  await expect(page.locator("#lhBags tbody")).not.toContainText("Loading bags", { timeout: 10_000 });
  await page.click('[data-lh="new-bag"]');
  await expect(page.locator("#modalTitle")).toHaveText("New linehaul bag");
  await page.click("#modalCancel");

  await opsNav(page, "cnStock");
  await expect(page.locator("#mainContent h1")).toHaveText("CN stock");
  await expect(page.locator("#cnBatches .panel-title")).toHaveText("Batches");

  await opsNav(page, "reports");
  await expect(page.locator("#mainContent h1")).toHaveText("Reports");
  await expect(page.locator("#rpCompliance .panel-title")).toHaveText("Scan compliance");

  await opsNav(page, "riders");
  await page.click('#mainContent [data-action="rider"]');
  await expect(page.locator("#modalTitle")).toHaveText("Add rider");
  await page.click("#modalCancel");
  await expect(page.locator("#shiftPanels")).toContainText("Today's shift roster");

  await opsNav(page, "delivery");
  await page.click('#mainContent [data-action="dispatch"]');
  await expect(page.locator("#modalTitle")).toHaveText("Suggest riders");
  await page.click("#modalCancel");
  await expect(page.locator("#routePlanner")).toBeVisible();
  await expect(page.locator("#mainContent .leaflet-container").first()).toBeVisible({ timeout: 15_000 });

  await opsNav(page, "analytics");
  await expect(page.locator("#slaPolicies .panel-title")).toHaveText("SLA policies", { timeout: 10_000 });

  await opsNav(page, "settings");
  await expect(page.locator('#mainContent [data-action="mfa"]')).toBeVisible();

  // Hubs & zones moved to Super admin: Settings links there.
  await expect(page.locator('#navigation [data-nav="Hubs & zones"]')).toHaveCount(0);
  await expect(page.locator('#settingsCards [data-settings-card="Hubs & zones"]')).toBeVisible();
  expect(errors).toEqual([]);
});
