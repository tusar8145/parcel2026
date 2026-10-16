import { type Browser } from "@playwright/test";
import { expect, test } from "./support";

/**
 * Finance tools on the "COD & finance" page and the support desk extras, through the real UI.
 * Read-only against the shared stack: nothing is created (bank statements and ledger entries are
 * immutable), so the API e2e tests cover the money flows themselves.
 */
const PASSWORD = "DeliveryFast2026"; // seeded demo accounts (apps/api/src/seed/demo.ts)

async function signedIn(browser: Browser, identifier: string, errors: string[]) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(`${identifier}: ${error.message}`));
  page.on("console", message => {
    if (message.type() === "error" && !/status of 40[13]/.test(message.text())) errors.push(`${identifier}: ${message.text()}`);
  });
  for (let attempt = 0; ; attempt++) {
    await page.goto("/login");
    await page.waitForSelector("html.legacy-ready", { state: "attached" });
    await page.fill("#loginIdentity", identifier);
    await page.fill("#loginPassword", PASSWORD);
    await page.click('form[data-form="login"] button[type="submit"]');
    const ok = await page.waitForURL(/\/courier-operation/, { timeout: 10_000 }).then(() => true, () => false);
    if (ok) break;
    if (attempt >= 2 || !/too many/i.test(await page.content())) await expect(page).toHaveURL(/\/courier-operation/);
    await page.waitForTimeout(61_000);
  }
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return page;
}

test("finance staff see approvals, invoices, disputes, reconciliation, ledger and schedules", async ({ browser }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const page = await signedIn(browser, "finance@deliveryfast.example", errors);
  await page.click('#navigation [data-page="COD & finance"]');
  const main = page.locator("#mainContent");
  for (const id of ["#finSettlements", "#finInvoices", "#finDisputes", "#finRecon", "#finLedger", "#finSchedules"]) await expect(main.locator(id)).toBeVisible();
  await expect(main.locator("#finLedger")).toContainText(/Balanced · debits|No postings this month/);
  await expect(main.locator("#finRecon form#finReconForm")).toBeVisible();
  await expect(main.locator("#finLedger [data-fin-config]")).toBeVisible();

  // The ledger API backs the page.
  const tb = await page.evaluate(() => (window as unknown as { DF: { api: (p: string) => Promise<{ balanced: boolean }> } }).DF.api("/finance/ledger/trial-balance"));
  expect(tb.balanced).toBe(true);
  expect(errors).toEqual([]);
  await page.context().close();
});

test("operations without finance rights don't get the finance tools; support agents get SLA and canned responses", async ({ browser }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const ops = await signedIn(browser, "ops@deliveryfast.example", errors);
  await ops.click('#navigation [data-page="COD & finance"]');
  await expect(ops.locator("#mainContent")).toBeVisible();
  await expect(ops.locator("#finSettlements")).toHaveCount(0);
  await ops.context().close();

  const agent = await signedIn(browser, "support@deliveryfast.example", errors);
  await agent.click('#navigation [data-page="Support"]');
  await expect(agent.locator("#mainContent")).toContainText("Support inbox");
  const first = agent.locator("[data-support-open]").first();
  if (await first.count()) {
    await first.click();
    await expect(agent.locator(".st-sla").first()).toBeVisible();
    if (await agent.locator("[data-support-reply]").count()) await expect(agent.locator("[data-support-canned]")).toBeVisible();
  }
  expect(errors).toEqual([]);
  await agent.context().close();
});
