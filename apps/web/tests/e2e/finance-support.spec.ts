import { type Browser } from "@playwright/test";
import { Fixtures, expect, opsNav, test, type TempUser } from "./support";

/**
 * Finance tools on the "COD & finance" page and the support desk extras, through the real UI.
 * Read-only against the shared stack apart from the temporary staff accounts (deleted afterwards):
 * bank statements and ledger entries are immutable, so the API e2e tests cover the money flows.
 */
const fx = new Fixtures();
test.afterAll(() => fx.cleanup());

async function signedIn(browser: Browser, account: TempUser, errors: string[]) {
  const identifier = account.name;
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(`${identifier}: ${error.message}`));
  page.on("console", message => {
    if (message.type() === "error" && !/status of 40[13]/.test(message.text())) errors.push(`${identifier}: ${message.text()}`);
  });
  for (let attempt = 0; ; attempt++) {
    await page.goto("/login");
    await page.waitForSelector("html.legacy-ready", { state: "attached" });
    await page.fill("#loginIdentity", account.login);
    await page.fill("#loginPassword", account.password);
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
  const page = await signedIn(browser, await fx.staff("FINANCE"), errors);
  const main = page.locator("#mainContent");
  // A tab per task: settlements and schedules; invoices, disputes, reconciliation and the ledger.
  await opsNav(page, "codSettlements");
  for (const id of ["#finSettlements", "#finSchedules"]) await expect(main.locator(id)).toBeVisible();
  await opsNav(page, "codAccounts");
  for (const id of ["#finInvoices", "#finDisputes", "#finRecon", "#finLedger"]) await expect(main.locator(id)).toBeVisible();
  await expect(main.locator("#finLedger")).toContainText(/Balanced · debits|No postings this month/);
  await expect(main.locator("#finRecon form#finReconForm")).toBeVisible();
  await expect(main.locator("#finLedger [data-fin-config]")).toBeVisible();

  // The ledger API backs the page.
  const tb = await page.evaluate(() => (window as unknown as { DF: { api: (p: string) => Promise<{ balanced: boolean }> } }).DF.api("/finance/ledger/trial-balance"));
  expect(tb.balanced).toBe(true);
  expect(errors).toEqual([]);
  await page.context().close();
});

test("operations managers work COD & settlement and generate bills (not finance settings); support agents get SLA and canned responses", async ({ browser }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const ops = await signedIn(browser, await fx.staff("OPS_MANAGER"), errors);
  await opsNav(ops, "cod");
  await expect(ops.locator("#mainContent")).toBeVisible();
  for (const tab of ["Cash from riders", "Franchise", "Settlements & payouts", "Invoices & accounts"])
    await expect(ops.locator(`#mainContent [data-nav-tab="${tab}"]`)).toBeVisible();
  await opsNav(ops, "codSettlements");
  await expect(ops.locator("#riderPayoutsPanel")).toBeVisible();
  await expect(ops.locator("#finSettlements")).toBeVisible();
  await opsNav(ops, "codAccounts");
  await expect(ops.locator("#finInvoices")).toBeVisible();
  // VAT & BIN settings stay with finance and super admins.
  await expect(ops.locator("#finLedger [data-fin-config]")).toHaveCount(0);
  // Generate bill: merchant, delivery dates, then the deliveries to tick.
  await ops.click("#finInvoices [data-fin-invoice-new]");
  await expect(ops.locator("#finBillPick")).toContainText("Choose the merchant first.");
  await expect(ops.locator("#of_from")).toBeVisible();
  await expect(ops.locator("#of_to")).toBeVisible();
  await ops.context().close();

  const agent = await signedIn(browser, await fx.staff("SUPPORT_AGENT"), errors);
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
