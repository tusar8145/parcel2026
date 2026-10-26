import { type Browser, type Page } from "@playwright/test";
import { authenticator } from "otplib";
import { Fixtures, apiUrl, expect, sql, test, type TempRider, type TempUser } from "./support";

/**
 * Super admin › SMS, Email & Push › Push notifications: the Firebase status card, a message to a chosen
 * rider (found by rider code), and the message in the history and in the rider's notifications.
 */
const fx = new Fixtures();
let ADMIN: TempUser;
let RIDER: TempRider;
const WEB = { "x-df-client": "web" };
const IGNORED = /status of (401|403|404|422)|Failed to load resource|tile\.openstreetmap/;

async function signInAdmin(browser: Browser, errors: string[]): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("dialog", dialog => dialog.accept());
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", m => m.type() === "error" && !IGNORED.test(m.text()) && errors.push(m.text()));
  const login = await (await page.request.post(apiUrl("/api/v1/auth/login"), { headers: WEB, data: { identifier: ADMIN.phone, password: ADMIN.password } })).json();
  const setup = await (await page.request.post(apiUrl("/api/v1/auth/mfa/setup"), { headers: WEB, data: { mfaToken: login.mfaToken } })).json();
  const enabled = await page.request.post(apiUrl("/api/v1/auth/mfa/enable"), { headers: WEB, data: { mfaToken: login.mfaToken, code: authenticator.generate(setup.secret) } });
  expect(enabled.ok(), await enabled.text()).toBe(true);
  await page.goto("/super-admin");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.evaluate(() => (window as unknown as { DF: { bridgeReady: Promise<unknown> } }).DF.bridgeReady);
  return page;
}

test.beforeAll(async () => {
  ADMIN = await fx.user(`E2E-Push-Admin-${fx.stamp} Test`, [{ role: "SUPER_ADMIN" }]);
  RIDER = await fx.rider("Dhanmondi Hub");
});
test.afterAll(async () => {
  if (ADMIN) await sql(`DELETE FROM push_broadcasts WHERE "createdById" = $1`, [ADMIN.id]);
  await fx.cleanup();
});

test("super admin sees Firebase push, messages a chosen rider and finds it in the history", async ({ browser }) => {
  const errors: string[] = [];
  const page = await signInAdmin(browser, errors);
  await page.locator('#navigation [data-page="Integrations"]').click();
  await page.locator('[data-int-tab="push"]').click();
  const settings = page.locator("#pushSettings");
  await expect(settings).toContainText("Firebase push");
  await expect(settings).toContainText(/On|Off|Not set up/);

  const compose = page.locator("#pushCompose");
  await compose.locator("#pushTitle").fill(`E2E notice ${fx.stamp}`);
  await compose.locator("#pushBody").fill("Hub opens at 9 am tomorrow.");
  await compose.locator('input[name="pushAudience"][value="USERS"]').check();
  await compose.locator("#pushUserSearch").fill(RIDER.code);
  await compose.locator(`[data-push-pick="send"]`, { hasText: RIDER.code }).click();
  await expect(compose.locator("#pushChosen")).toContainText(RIDER.code);
  await page.screenshot({ path: "test-results/push-admin.png", fullPage: true });
  await compose.locator("[data-push-send]").click();

  await expect(page.locator("#pushHistory")).toContainText(`E2E notice ${fx.stamp}`);
  await expect(page.locator("#pushHistory tbody tr").first()).toContainText("Chosen people (1)");
  const [note] = await sql<{ title: string }>(`SELECT title FROM user_notifications WHERE "userId" = $1 AND type = 'broadcast'`, [RIDER.id]);
  expect(note?.title).toBe(`E2E notice ${fx.stamp}`);
  expect(errors).toEqual([]);
});
