import { type Browser } from "@playwright/test";
import { authenticator } from "otplib";
import { Fixtures, adminNav, apiUrl, expect, sql, test } from "./support";

// Super admin: the new menu, Website settings (published at once to the cached website), the products
// message field and table pages. The account is temporary; what is saved is put back afterwards.
const fx = new Fixtures();
const WEB = { "x-df-client": "web" };
const KEY = "website-settings";
let saved: unknown[] = [];
let adminNo = 0;

test.beforeAll(async () => {
  saved = await sql<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [KEY]);
});
test.afterAll(async () => {
  if (saved.length) await sql(`UPDATE settings SET value = $1 WHERE key = $2`, [JSON.stringify((saved[0] as { value: unknown }).value), KEY]);
  else await sql(`DELETE FROM settings WHERE key = $1`, [KEY]);
  await fx.cleanup();
});

async function panel(browser: Browser) {
  // A new admin each time: a second sign-in of one who enrolled asks for the authenticator code.
  const admin = await fx.user(`E2E-Site-Admin-${Date.now().toString(36)}-${++adminNo} Test`, [{ role: "SUPER_ADMIN" }]);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const login = await (await page.request.post(apiUrl("/api/v1/auth/login"), { headers: WEB, data: { identifier: admin.login, password: admin.password } })).json();
  if (login.mfaSetupRequired) {
    const setup = await (await page.request.post(apiUrl("/api/v1/auth/mfa/setup"), { headers: WEB, data: { mfaToken: login.mfaToken } })).json();
    await page.request.post(apiUrl("/api/v1/auth/mfa/enable"), { headers: WEB, data: { mfaToken: login.mfaToken, code: authenticator.generate(setup.secret) } });
  }
  await page.goto("/super-admin");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return { page, errors };
}

test("the menu: groups open and close, every moved page opens, and old links still work", async ({ browser }) => {
  const { page, errors } = await panel(browser);
  await expect(page.locator(".nav-label")).toContainText(["Monitoring", "Platform control"]);
  for (const gone of ["Integrations", "Pricing & catalogs"]) await expect(page.locator(`#navigation [data-page="${gone}"]`)).toHaveCount(0);

  const notifications = page.locator('[data-nav-sub="notifications"]');
  await expect(notifications.locator(".nav-sub-items")).toBeHidden();
  await notifications.locator(".nav-sub-toggle").click();
  await expect(notifications.locator(".nav-item[data-page]")).toHaveText(["Parcel notifications", "Global notifications", "Channel & limits", "Push notifications", "Recent messages"]);
  await notifications.locator(".nav-sub-toggle").click();
  await expect(notifications.locator(".nav-sub-items")).toBeHidden();

  const open: [string, RegExp][] = [
    ["Channels & limits", /Channel & limits/],
    ["Push notifications", /Push notifications/],
    ["Recent messages", /Recent messages/],
    ["Integration settings", /Integration settings/],
    ["Return reasons", /Return reasons/],
    ["Receiver relations", /Receiver relations/],
    ["Invoice settings", /Invoice settings/],
    ["Import settings", /Import Template settings/],
    ["Address", /Address/],
    ["Hubs & zones", /Hubs & zones/],
    ["Platform activity", /Platform activity/],
    ["Audit log", /Audit/],
  ];
  for (const [name, heading] of open) {
    await adminNav(page, name);
    await expect(page.locator("#mainContent h1").first(), name).toHaveText(heading, { timeout: 20_000 });
    await expect(page.locator(`#navigation [data-page="${name}"]`), name).toHaveClass(/active/);
  }

  // The gateways are in Integration settings, with their cards.
  await adminNav(page, "Integration settings");
  await expect(page.locator("#gatewayCards")).toContainText("Sender ID", { timeout: 20_000 });

  // One list per page, and nothing lost: the geography editor is on Address.
  await adminNav(page, "Return reasons");
  await expect(page.locator('[data-catalog-form="returnReasons"]')).toBeVisible();
  await expect(page.locator('[data-catalog-form="receiverRelations"]')).toBeHidden();
  await adminNav(page, "Receiver relations");
  await expect(page.locator('[data-catalog-form="receiverRelations"]')).toBeVisible();
  await expect(page.locator('[data-catalog-form="returnReasons"]')).toBeHidden();
  await adminNav(page, "Address");
  await expect(page.locator("#geoAdmin #geoTotals")).toContainText("districts", { timeout: 20_000 });
  // The whole width of the page.
  const widths = await page.evaluate(() => [document.querySelector("#geoAdmin")!.closest("section")!.getBoundingClientRect().width, (el => { const style = getComputedStyle(el); return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight); })(document.querySelector("#mainContent")!)]);
  expect(widths[0]).toBeGreaterThan(widths[1] * 0.9);
  await expect(page.locator('[data-catalog-form="returnReasons"]')).toBeHidden();

  // Firebase is on Integration settings, sending on Push notifications.
  await adminNav(page, "Integration settings");
  await expect(page.locator("#pushSettings")).toContainText("Firebase", { timeout: 20_000 });
  await adminNav(page, "Push notifications");
  await expect(page.locator("#pushCompose")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#pushHistory")).toBeVisible();
  await expect(page.locator("#pushSettings")).toHaveCount(0);

  // The audit log: 20 rows a page over the whole log.
  await adminNav(page, "Audit log");
  await expect(page.locator("#auditPager")).toContainText("of", { timeout: 20_000 });
  expect(await page.locator("#genericBody tr").count()).toBeLessThanOrEqual(20);

  // A saved link to a moved page opens its new home.
  await page.goto("/super-admin?page=branding-and-company");
  await expect(page.locator("#brName")).toBeVisible({ timeout: 20_000 });
  await page.goto("/super-admin?page=catalogs-and-locations");
  await expect(page.locator("#breadcrumbPage")).toHaveText("Address", { timeout: 20_000 });
  await expect(page.locator('[data-nav-sub="location"] .nav-sub-items')).toBeVisible();
  expect(errors).toEqual([]);
});

test("Website settings: pages and FAQs publish at once, and switches take effect on the website", async ({ browser }) => {
  const { page, errors } = await panel(browser);
  const site = await (await browser.newContext()).newPage();
  await adminNav(page, "Website settings");
  await expect(page.locator("#mainContent h1")).toHaveText("Website & branding", { timeout: 20_000 });
  await expect(page.locator("#brName")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#navigation [data-page="Branding & company"]')).toHaveCount(0);
  await page.click('[data-site-tab="signups"]');
  await expect(page.locator("[data-site-switch]")).toHaveCount(5, { timeout: 20_000 });
  for (const key of ["merchant", "rider", "franchise", "customer", "sendParcel"]) await expect(page.locator(`[data-site-switch="${key}"]`)).toBeChecked();

  // ── Privacy Policy: its original text is there to edit, and the edit shows on the next visit ──
  const stamp = `Edited ${Date.now()}`;
  await page.click('[data-site-tab="privacy"]');
  await expect(page.locator("#siteBody")).toHaveValue(/## 1\. Who we are/);
  await page.fill("#siteBody", `## ${stamp}\n\nOur new policy.`);
  await page.click('#siteForm button[type="submit"]');
  await expect(page.locator("#toast")).toContainText("published", { timeout: 15_000 });
  await site.goto("/privacy");
  await expect(site.locator("h2", { hasText: stamp })).toBeVisible();
  await expect(site.locator(".legal-doc")).not.toContainText("Draft for legal review");

  // ── FAQs: a new question reaches the home page ──
  await page.click('[data-site-tab="faqs"]');
  await page.click("#faqAdd");
  await page.locator('[data-faq-field="question"]').last().fill(`Question ${stamp}?`);
  await page.locator('[data-faq-field="answer"]').last().fill("The answer.");
  await page.click('#siteForm button[type="submit"]');
  await expect(page.locator("#toast")).toContainText("FAQs published", { timeout: 15_000 });
  await site.goto("/");
  await expect(site.locator(".faq-item summary", { hasText: stamp })).toHaveCount(1);

  // ── Switches: the links leave the website and the page says it's closed ──
  await page.click('[data-site-tab="signups"]');
  await page.locator('[data-site-switch="sendParcel"]').uncheck();
  await expect(page.locator("#toast")).toContainText("Send a parcel is off", { timeout: 15_000 });
  await page.locator('[data-site-switch="merchant"]').uncheck();
  await expect(page.locator("#toast")).toContainText("Become a merchant is off", { timeout: 15_000 });
  await site.goto("/");
  await expect(site.locator('main a[href="/request"]').first()).toBeHidden();
  await expect(site.locator(".partner-card", { hasText: "Become a merchant" })).toBeHidden();
  await expect(site.locator(".partner-card", { hasText: "franchise" })).toBeVisible();
  await site.goto("/request");
  await expect(site.locator("h1")).toHaveText("Sending a parcel is unavailable");
  await site.goto("/merchant");
  await expect(site.locator("h1")).toHaveText("Merchant applications are closed");

  await page.locator('[data-site-switch="sendParcel"]').check();
  await expect(page.locator("#toast")).toContainText("Send a parcel is on", { timeout: 15_000 });
  await page.locator('[data-site-switch="merchant"]').check();
  await expect(page.locator("#toast")).toContainText("Become a merchant is on", { timeout: 15_000 });
  await site.goto("/request");
  await expect(site.locator("h1")).not.toHaveText("Sending a parcel is unavailable");
  expect(errors).toEqual([]);
});

test("the login page shows its form without waiting for the large start-up lists", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.route(/\/api\/v1\/(catalog|settings\/platform-config)/, async route => {
    await new Promise(resolve => setTimeout(resolve, 4000));
    await route.continue();
  });
  const start = Date.now();
  await page.goto("/login");
  await expect(page.locator("#loginIdentity")).toBeVisible({ timeout: 3500 });
  expect(Date.now() - start).toBeLessThan(3500);
});

test("long tables have numbered pages that follow their search; short tables have none", async ({ browser }) => {
  const { page, errors } = await panel(browser);
  // The real list: more than a page of products has numbered pages.
  await adminNav(page, "Products");
  await expect(page.locator("#pkgProducts")).toBeVisible({ timeout: 20_000 });
  if ((await page.locator("#pkgProducts tbody tr").count()) > 25) {
    await expect(page.locator("#pkgProducts tbody tr:visible")).toHaveCount(25);
    await expect(page.locator("#pkgProductsPanel .df-table-pager")).toContainText("Showing 1–25 of");
  }

  // A table of 60 rows, as a page draws it (System guide: nothing redraws it afterwards).
  await adminNav(page, "System guide");
  await expect(page.locator("#mainContent h1").first()).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => {
    const rows = Array.from({ length: 60 }, (_, i) => `<tr><td>Row ${i + 1}</td></tr>`).join("");
    document.getElementById("mainContent")!.insertAdjacentHTML("beforeend", `<section class="panel" id="pagerTest"><div class="table-scroll"><table><tbody>${rows}</tbody></table></div></section><section class="panel" id="shortTest"><div class="table-scroll"><table><tbody><tr><td>One</td></tr></tbody></table></div></section>`);
  });
  const box = page.locator("#pagerTest");
  const visible = box.locator("tbody tr:visible");
  await expect(visible).toHaveCount(25);
  await expect(box.locator(".df-table-pager")).toContainText("Showing 1–25 of 60");
  await box.locator('[aria-label="Page 3"]').click();
  await expect(visible).toHaveCount(10);
  await expect(visible.first()).toHaveText("Row 51");
  await box.locator("select").selectOption("50");
  await expect(visible).toHaveCount(50);
  await expect(box.locator(".df-table-pager")).toContainText("Showing 1–50 of 60");
  // A filter hides rows: the pages cover what is left.
  await page.evaluate(() => document.querySelectorAll<HTMLElement>("#pagerTest tbody tr").forEach((row, i) => (row.hidden = i >= 10)));
  await expect(visible).toHaveCount(10);
  await expect(box.locator(".df-table-pager")).toHaveCount(0);
  await expect(page.locator("#shortTest .df-table-pager")).toHaveCount(0);
  expect(errors).toEqual([]);
});
