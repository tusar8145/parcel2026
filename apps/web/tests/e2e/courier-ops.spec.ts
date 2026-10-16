import { expect, test } from "./support";

// Read-only smoke test of the courier-operations additions (linehaul, CN stock, reports, maps,
// SLA, shifts, Add rider / Create dispatch dialogs). Nothing is created in the database.
const PASSWORD = "DeliveryFast2026";
const OPS = "ops@deliveryfast.example";

test("operations pages added for linehaul, CN stock, reports, SLA, shifts and maps render", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/status of 401|tile\.openstreetmap|Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  page.on("dialog", dialog => dialog.dismiss());
  await page.goto("/login");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.fill("#loginIdentity", OPS);
  await page.fill("#loginPassword", PASSWORD);
  await page.click('form[data-form="login"] button[type="submit"]');
  // The website may land on the account page first; the operations panel is a direct link.
  await page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 30_000 });
  if (!/courier-operation/.test(page.url())) await page.goto("/courier-operation");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(page, (await page.locator("body").innerText()).slice(0, 300)).toHaveURL(/courier-operation/);
  const nav = (name: string) => page.click(`#navigation [data-page="${name}"]`);

  await nav("Linehaul");
  await expect(page.locator("#mainContent h1")).toHaveText("Linehaul");
  await expect(page.locator("#lhTrips .panel-title")).toHaveText("Trips & manifests");
  await expect(page.locator("#lhBags tbody")).not.toContainText("Loading bags", { timeout: 10_000 });
  await page.click('[data-lh="new-bag"]');
  await expect(page.locator("#modalTitle")).toHaveText("New linehaul bag");
  await page.click("#modalCancel");

  await nav("CN stock");
  await expect(page.locator("#mainContent h1")).toHaveText("CN stock");
  await expect(page.locator("#cnBatches .panel-title")).toHaveText("Batches");

  await nav("Reports");
  await expect(page.locator("#mainContent h1")).toHaveText("Reports");
  await expect(page.locator("#rpCompliance .panel-title")).toHaveText("Scan compliance");

  await nav("Riders");
  await page.click('#mainContent [data-action="rider"]');
  await expect(page.locator("#modalTitle")).toHaveText("Add rider");
  await page.click("#modalCancel");
  await expect(page.locator("#shiftPanels")).toContainText("Today's shift roster");

  await nav("Dispatch");
  await page.click('#mainContent [data-action="dispatch"]');
  await expect(page.locator("#modalTitle")).toHaveText("Create dispatch");
  await page.click("#modalCancel");
  await expect(page.locator("#routePlanner")).toBeVisible();
  await expect(page.locator("#mainContent .leaflet-container").first()).toBeVisible({ timeout: 15_000 });

  await nav("Analytics");
  await expect(page.locator("#slaPolicies .panel-title")).toHaveText("SLA policies", { timeout: 10_000 });

  await nav("Settings");
  await expect(page.locator('#mainContent [data-action="mfa"]')).toBeVisible();

  await nav("Hubs");
  await expect(page.locator("#networkConfig")).toContainText("Delivery zones");
  expect(errors).toEqual([]);
});
