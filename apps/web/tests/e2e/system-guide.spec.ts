import { authenticator } from "otplib";
import { Fixtures, apiUrl, expect, test, type TempUser } from "./support";
const fx = new Fixtures();
const WEB = { "x-df-client": "web" };
let admin: TempUser, OPS: TempUser;
test.beforeAll(async () => {
  admin = await fx.user(`E2E Guide ${fx.stamp}`, [{ role: "SUPER_ADMIN" }]);
  OPS = await fx.staff("OPS_MANAGER");
});
test.afterAll(() => fx.cleanup());
// Super admin › System guide (numbers, statuses, money flow, roles; GET /guide) and its dialog in Courier Operations › Settings.
test("system guide: super admin page with search and tabs; Courier Operations opens it from Settings", async ({ browser }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  page.on("pageerror", e => errors.push(e.message));
  const login = await (await page.request.post(apiUrl("/api/v1/auth/login"), { headers: WEB, data: { identifier: admin.phone, password: admin.password } })).json();
  const setup = await (await page.request.post(apiUrl("/api/v1/auth/mfa/setup"), { headers: WEB, data: { mfaToken: login.mfaToken } })).json();
  await page.request.post(apiUrl("/api/v1/auth/mfa/enable"), { headers: WEB, data: { mfaToken: login.mfaToken, code: authenticator.generate(setup.secret) } });
  await page.goto("/super-admin");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.click('#navigation [data-page="System guide"]');
  await expect(page.locator(".sg-prefix", { hasText: "HS" })).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/page=system-guide/);
  await page.fill("[data-sg-q]", "slip");
  await page.waitForTimeout(300);
  // Search: the cash handover slip (HS) and the hub transfer that sends whole slips (HT).
  await expect(page.locator(".sg tbody .sg-prefix")).toHaveText(["HS", "HT"]);
  for (const t of ["statuses", "money", "roles"]) {
    await page.click(`[data-sg-tab="${t}"]`);
    await expect(page.locator(`[data-sg-tab="${t}"]`)).toHaveAttribute("aria-selected", "true");
  }
  await expect(page.locator(".sg-role", { hasText: "Rider" }).first()).toContainText("/rider");
  const ops = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  ops.on("pageerror", e => errors.push(e.message));
  await ops.goto("/login");
  await ops.waitForSelector("html.legacy-ready", { state: "attached" });
  await ops.fill("#loginIdentity", OPS.login);
  await ops.fill("#loginPassword", OPS.password);
  await ops.click('form[data-form="login"] button[type="submit"]');
  await ops.waitForURL(url => url.pathname.startsWith("/courier-operation"));
  await ops.goto("/courier-operation?page=settings");
  await ops.waitForSelector("html.legacy-ready", { state: "attached" });
  await ops.click("[data-guide-open]");
  await expect(ops.locator("#sgDialog .sg-prefix", { hasText: "PP" })).toBeVisible({ timeout: 20_000 });
  await ops.click("[data-guide-close]");
  await expect(ops.locator("#sgDialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});
