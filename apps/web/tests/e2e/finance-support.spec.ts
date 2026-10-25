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

test("finance: Accounts overview, merchants' accounts, invoice settings; the old COD & settlement page is gone", async ({ browser }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const page = await signedIn(browser, await fx.staff("FINANCE"), errors);
  await expect(page.locator('#navigation [data-nav="COD & settlement"]')).toHaveCount(0);
  await opsNav(page, "accounts");
  const main = page.locator("#mainContent");
  await expect(main.locator("h1")).toHaveText("Accounts");
  for (const label of ["With riders", "At hubs", "In transit", "At central hub", "Settlements to pay"]) await expect(main.locator(".acc-card", { hasText: label })).toBeVisible();
  await expect(main.locator('[data-acc="settings"]')).toBeVisible();
  for (const tab of ["Overview", "E-commerce", "Financial", "Customer", "Rider cash", "Hub transfers", "Rider pay"]) await expect(main.locator(`[data-nav-tab="${tab}"]`)).toBeVisible();
  await opsNav(page, "accountsFinancial");
  await expect(main.locator(".acc-table thead")).toContainText("Not billed");
  // Invoice settings: VAT off by default.
  await opsNav(page, "accounts");
  await main.locator('[data-acc="settings"]').click();
  await expect(page.locator("#of_vatEnabled")).toHaveValue("off");
  expect(errors).toEqual([]);
  await page.context().close();
});

test("operations managers work Accounts (not invoice settings); hub staff get rider cash and transfers; support agents get SLA and canned responses", async ({ browser }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const ops = await signedIn(browser, await fx.staff("OPS_MANAGER"), errors);
  await opsNav(ops, "accounts");
  for (const tab of ["Overview", "E-commerce", "Financial", "Customer", "Rider cash", "Hub transfers", "Rider pay"]) await expect(ops.locator(`#mainContent [data-nav-tab="${tab}"]`)).toBeVisible();
  await expect(ops.locator('#mainContent [data-acc="settings"]')).toHaveCount(0);
  await opsNav(ops, "riderPay");
  await expect(ops.locator("#riderPayoutsPanel")).toBeVisible();
  await opsNav(ops, "riderCash");
  await expect(ops.locator("#accSlipScan")).toBeVisible();
  await ops.context().close();

  // A hub's staff (not the central hub): rider cash and hub transfers only.
  const hubStaff = await signedIn(browser, await fx.staff("HUB_OPERATOR", "Dhanmondi Hub"), errors);
  await hubStaff.click('#navigation [data-nav="Accounts"]');
  await expect(hubStaff.locator('#mainContent [data-nav-tab="Rider cash"]')).toBeVisible();
  await expect(hubStaff.locator('#mainContent [data-nav-tab="Hub transfers"]')).toBeVisible();
  for (const tab of ["Overview", "E-commerce", "Financial", "Customer"]) await expect(hubStaff.locator(`#mainContent [data-nav-tab="${tab}"]`)).toBeHidden();
  await expect(hubStaff.locator("#accSlipScan")).toBeVisible();
  await hubStaff.context().close();

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
