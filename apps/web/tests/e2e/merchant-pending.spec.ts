import { type Browser } from "@playwright/test";
import { Fixtures, expect, sql, test, type TempUser } from "./support";

/**
 * A merchant account that isn't active (2026-10-18): the whole panel is the "Account verification" screen — the
 * status stated plainly ("isn't verified yet"), steps, business verification uploads, messages from Paira Express
 * and the business profile read-only. No menu, search or bell; any other page opens the screen. Once active, the
 * full panel. Merchants and members are temporary (support.ts cleanup).
 */
const fx = new Fixtures();
test.afterAll(() => fx.cleanup());

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

async function signIn(browser: Browser, user: TempUser, to: RegExp) {
  const page = await (await browser.newContext()).newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/login");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.fill("#loginIdentity", user.login);
  await page.fill("#loginPassword", user.password);
  await page.click('form[data-form="login"] button[type="submit"]');
  await page.waitForURL(to);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return { page, errors };
}

test("a merchant under review: only the verification screen, uploads documents, profile read-only; then the full panel", async ({ browser }) => {
  test.setTimeout(150_000);
  const shop = await fx.merchant({ label: "Pending Shop" });
  await sql(`UPDATE merchants SET status = 'PENDING_REVIEW', "kycStatus" = 'NOT_SUBMITTED' WHERE id = $1`, [shop.id]);
  const owner = await fx.member(shop);
  const { page, errors } = await signIn(browser, owner, /\/ecommerce-merchant/);

  // The screen, clearly not verified; no menu, search or bell.
  await expect(page.locator("#breadcrumbPage")).toHaveText("Account verification");
  await expect(page).toHaveURL(/[?&]page=verification/);
  await expect(page.locator("#dfvBadge")).toContainText("Not verified yet");
  await expect(page.locator("#dfvStatus")).toContainText("Your account isn't verified yet");
  await expect(page.locator("#sidebar")).toBeHidden();
  await expect(page.locator("#globalSearch")).toBeHidden();
  await expect(page.locator("#notificationButton")).toBeHidden();

  // Profile: read-only, no inputs or edit buttons.
  const profile = page.locator("#dfvProfile");
  await expect(profile).toContainText("Read-only");
  await expect(profile).toContainText(shop.name);
  await expect(profile).toContainText(shop.code);
  await expect(profile.locator("input, select, textarea, button")).toHaveCount(0);

  // Business verification: upload the required documents, then submit.
  const docs = page.locator("#dfvDocuments");
  await expect(page.locator("#dfvKycStatus")).toHaveText("Not submitted");
  const required = await docs.locator(".dfv-doc", { has: page.locator(".dfv-badge.amber") }).evaluateAll(rows => rows.map(r => (r as HTMLElement).dataset.dfvDoc!));
  expect(required.length).toBeGreaterThan(0);
  for (const type of required) {
    await docs.locator(`[data-dfv-upload="${type}"]`).setInputFiles({ name: `${type.toLowerCase()}.png`, mimeType: "image/png", buffer: PNG });
    await expect(docs.locator(`[data-dfv-doc="${type}"]`)).toContainText("Uploaded");
  }
  await docs.locator("[data-dfv-submit]").click();
  await expect(page.locator("#dfvKycStatus")).toHaveText("Under review");
  await expect(page.locator("#dfvStatus")).toContainText("review in progress");
  const [kyc] = await sql<{ kycStatus: string }>(`SELECT "kycStatus" FROM merchants WHERE id = $1`, [shop.id]);
  expect(kyc.kycStatus).toBe("PENDING");

  // Any other page (address or renderer) → the verification screen.
  for (const slug of ["orders", "settings", "services-and-pricing", "notifications", "support"]) {
    await page.goto(`/ecommerce-merchant?page=${slug}`);
    await page.waitForSelector("html.legacy-ready", { state: "attached" });
    await expect(page.locator("#breadcrumbPage"), slug).toHaveText("Account verification");
    await expect(page, slug).toHaveURL(/[?&]page=verification/);
  }
  await page.evaluate(() => (window as unknown as { renderPage(p: string): void }).renderPage("Settings"));
  await expect(page.locator("#breadcrumbPage")).toHaveText("Account verification");
  // The API agrees: profile changes are refused.
  const patch = await page.evaluate(() =>
    (window as unknown as { DF: { api(p: string, o: unknown): Promise<unknown> } }).DF.api("/merchants/me", { method: "PATCH", body: { contactName: "Changed" } }).then(
      () => "ok",
      (e: { code: string }) => e.code,
    ),
  );
  expect(patch).toBe("MERCHANT_NOT_ACTIVE");

  // Active → the full panel.
  await sql(`UPDATE merchants SET status = 'ACTIVE', "kycStatus" = 'APPROVED' WHERE id = $1`, [shop.id]);
  await page.goto("/ecommerce-merchant");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(page.locator("#breadcrumbPage")).toHaveText("Overview");
  await expect(page.locator("#sidebar")).toBeAttached();
  await expect(page.locator('#navigation [data-page="Orders"]')).toBeVisible();
  await expect(page.locator("#dfvPage")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("information requested: the message and a reply; suspended: its own message, no uploads; on a phone", async ({ browser }) => {
  const bank = await fx.merchant({ type: "BANKING_FINANCIAL", label: "Pending Bank" });
  await sql(`UPDATE merchants SET status = 'INFO_REQUESTED' WHERE id = $1`, [bank.id]);
  await sql(`INSERT INTO merchant_notes (id, "merchantId", kind, body, internal, "authorName", "createdAt") VALUES (gen_random_uuid(), $1, 'INFO_REQUEST', 'Please upload a clearer trade licence.', false, 'Paira Express', now())`, [bank.id]);
  const owner = await fx.member(bank);
  const { page, errors } = await signIn(browser, owner, /\/banking-merchant/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#dfvStatus")).toContainText("Action needed");
  await expect(page.locator("#dfvMessages")).toContainText("Please upload a clearer trade licence.");
  await page.fill("#dfvReply", "Uploaded a new scan of the licence.");
  await page.click('#dfvReplyForm button[type="submit"]');
  await expect(page.locator("#dfvMessages")).toContainText("Uploaded a new scan of the licence.");
  const [m] = await sql<{ status: string }>(`SELECT status FROM merchants WHERE id = $1`, [bank.id]);
  expect(m.status).toBe("PENDING_REVIEW");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);

  await sql(`UPDATE merchants SET status = 'SUSPENDED' WHERE id = $1`, [bank.id]);
  await page.reload();
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(page.locator("#dfvBadge")).toContainText("Suspended");
  await expect(page.locator("#dfvStatus")).toContainText("suspended");
  await expect(page.locator("#dfvDocuments")).toHaveCount(0);
  await expect(page.locator("#dfvProfile")).toContainText("Read-only");
  expect(errors).toEqual([]);
});
