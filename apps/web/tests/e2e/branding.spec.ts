import { authenticator } from "otplib";
import { Fixtures, apiUrl, expect, sql, test, type TempUser } from "./support";

/**
 * Super admin › Branding & company (white label): a new company name, contact email, tab icon and About text,
 * then the website shows them (header wordmark, footer, tab icon, /about). The previous branding is put back.
 */
const fx = new Fixtures();
const WEB = { "x-df-client": "web" };
// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
let ADMIN: TempUser;
let before: { value: unknown }[] = [];

test.beforeAll(async () => {
  ADMIN = await fx.user(`E2E Brand ${fx.stamp}`, [{ role: "SUPER_ADMIN" }]);
  before = await sql<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'branding'`);
});
test.afterAll(async () => {
  if (before.length) await sql(`UPDATE settings SET value = $1 WHERE key = 'branding'`, [JSON.stringify(before[0].value)]);
  else await sql(`DELETE FROM settings WHERE key = 'branding'`);
  await fx.cleanup();
});

test("super admin changes the company; the website shows its name, contact, tab icon and About text", async ({ browser }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  page.on("pageerror", e => errors.push(e.message));
  const login = await (await page.request.post(apiUrl("/api/v1/auth/login"), { headers: WEB, data: { identifier: ADMIN.phone, password: ADMIN.password } })).json();
  const setup = await (await page.request.post(apiUrl("/api/v1/auth/mfa/setup"), { headers: WEB, data: { mfaToken: login.mfaToken } })).json();
  await page.request.post(apiUrl("/api/v1/auth/mfa/enable"), { headers: WEB, data: { mfaToken: login.mfaToken, code: authenticator.generate(setup.secret) } });
  await page.goto("/super-admin");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.click('#navigation [data-page="Branding & company"]');
  await expect(page.locator("#brName")).toBeVisible({ timeout: 20_000 });

  // The About text is there to edit, and the current logo (the pigeon mark) is shown.
  await expect(page.locator("#brAboutBody")).toHaveValue(/## Our Story/);
  await expect(page.locator("#brLogoBox svg")).toBeVisible();
  await expect(page.locator("#brandForm")).toBeVisible();
  await expect(page.locator('#navigation .nav-item[data-page]').last()).toHaveAttribute("data-page", "Branding & company");
  await page.fill("#brName", "Swift Parcel");
  await page.fill("#brEmail", "hello@swift.example");
  await page.fill("#brAboutBody", "We deliver across the city.\n\n## Why us\n- Same day");
  const chooser = page.waitForEvent("filechooser");
  await page.click('[data-pick="icon"]');
  await (await chooser).setFiles({ name: "icon.png", mimeType: "image/png", buffer: PNG });
  await expect(page.locator("#brIconBox")).toContainText("not saved yet");
  await page.screenshot({ path: "test-results/branding-admin.png", fullPage: true });
  await page.click('#brandForm button[type="submit"]');
  await expect(page.locator("#brIconBox")).toContainText("Your icon.", { timeout: 15_000 });
  // The editor itself keeps its own text (data-brand-keep), the sidebar shows the new name.
  await expect(page.locator("#brName")).toHaveValue("Swift Parcel");
  await expect(page.locator("#brLegal")).toHaveValue("");
  // The sidebar's workspace badge follows the name ("DF" → "SP") after a reload.
  await page.reload();
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(page.locator(".workspace-icon")).toHaveText("SP", { timeout: 15_000 });

  const site = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  site.on("pageerror", e => errors.push(e.message));
  await site.goto("/");
  await expect(site.locator(".brand-word").first()).toHaveText(/Swift\s*Parcel/, { timeout: 15_000 });
  await expect(site.locator('link[rel~="icon"]').first()).toHaveAttribute("href", /branding\/icon\?v=(?!default)/);
  // The name painted on the hero's van, in lower case and fitting the van.
  await expect(site.locator(".van-logo")).toHaveText("swift parcel");
  expect(await site.locator(".van-logo").evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(92);
  await expect(site.locator('a[href="mailto:hello@swift.example"]').first()).toBeAttached();
  await expect(site.locator("body")).not.toContainText("Paira Express");
  await site.goto("/about");
  await expect(site.locator(".about-view h1")).toHaveText("About Swift Parcel", { timeout: 15_000 });
  await expect(site.locator(".about-view h1")).toBeVisible();
  await expect(site.locator(".about-view h2")).toHaveText("Why us");
  await expect(site.locator(".about-view li")).toHaveText("Same day");
  await site.waitForTimeout(1000); // the page fades in
  await site.screenshot({ path: "test-results/branding-about.png" });
  // A second visit starts from the kept branding (localStorage) without disturbing React's hydration.
  await site.goto("/");
  await expect(site.locator(".brand-word").first()).toHaveText(/Swift\s*Parcel/, { timeout: 15_000 });
  await site.waitForTimeout(1000);
  expect(errors).toEqual([]);
  // Back to Paira Express through the API too (it clears the API's branding cache; afterAll then removes the row).
  const reset = await page.evaluate(() =>
    (window as unknown as { DF: { api(path: string, opts: object): Promise<{ companyName: string }> } }).DF.api("/branding", {
      method: "PUT",
      body: { companyName: "Paira Express", legalName: "", contact: { email: "info@pairaexpress.com.bd" }, about: { title: "", body: "" }, icon: null, logo: null },
    }),
  );
  expect(reset.companyName).toBe("Paira Express");
});
