import { type Browser, type Page } from "@playwright/test";
import { Fixtures, confirmDialog, expect, sql, test, type TempUser } from "./support";

/**
 * Rider and franchise applications from the website, like merchants: a signed-out visitor sets a password
 * in the form (SMS code to confirm the number) and the application goes in one step. Until approved, the
 * account sees only /application (status, messages, details read-only, withdraw); never the customer area.
 * Approval opens the real panel. Accounts and applications made here are deleted afterwards (support.ts).
 */
const fx = new Fixtures();
let opsUser: TempUser | undefined;
test.afterAll(() => fx.cleanup());

const PASSWORD = "E2ePassword2026";
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const freshPhone = () => `019${String(Date.now()).slice(-8)}`;
type Df = { DF: { api: (path: string, options?: Record<string, unknown>) => Promise<any> } };

async function open(browser: Browser, path: string) {
  const page = await (await browser.newContext()).newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(`console: ${message.text()}`);
  });
  await page.goto(path);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return Object.assign(page, { errors });
}

async function signIn(page: Page, identifier: string, password: string) {
  await page.goto("/login");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.fill("#loginIdentity", identifier);
  await page.fill("#loginPassword", password);
  await page.click('form[data-form="login"] button[type="submit"]');
}

/** Sends the form's account step: password, then the SMS code from the development hint. */
async function createAccountAndSend(page: Page, form: string) {
  await page.fill("#accountPassword", PASSWORD);
  await page.click(`form[data-form="${form}"] button[type="submit"]`);
  const code = page.locator(".field", { has: page.locator("#accountOtp") });
  await expect(code).toContainText("Development code:");
  await page.fill("#accountOtp", (await code.textContent())!.match(/Development code: (\d{6})/)![1]);
  await page.click(`form[data-form="${form}"] button[type="submit"]`);
}

async function opsPage(browser: Browser) {
  const ops = await open(browser, "/login");
  opsUser ??= await fx.staff("OPS_MANAGER");
  await signIn(ops, opsUser.login, opsUser.password);
  await expect(ops).toHaveURL(/\/courier-operation/);
  await ops.waitForSelector("html.legacy-ready", { state: "attached" });
  return ops;
}
const api = (page: Page, path: string, options?: Record<string, unknown>) => page.evaluate(([p, o]) => (window as unknown as Df).DF.api(p as string, o as Record<string, unknown>), [path, options] as const);

test("rider applicant sets a password in the form, waits on the application page, and opens the rider app once approved", async ({ browser }) => {
  test.setTimeout(180_000);
  const id = unique();
  const name = `E2E Rider Applicant ${id}`;
  const phone = freshPhone();

  const visitor = await open(browser, "/become-a-rider");
  await visitor.fill("#partnerName", name);
  await visitor.fill("#partnerPhone", phone);
  await visitor.selectOption("#partnerArea", "Dhaka North");
  await visitor.selectOption("#riderVehicle", "Bicycle");
  await expect(visitor.locator("#accountPassword")).toBeVisible();
  await createAccountAndSend(visitor, "rider");

  // Straight to the application page: status, steps, details read-only.
  await expect(visitor).toHaveURL(/\/application$/, { timeout: 20_000 });
  await fx.adoptUser(phone);
  await expect(visitor.locator("#apStatus")).toContainText("Your rider application is being reviewed");
  await expect(visitor.locator("#apBadge")).toHaveText("Not approved yet");
  await expect(visitor.locator("#apDetails")).toContainText(name);
  await expect(visitor.locator("#apDetails")).toContainText("Bicycle");
  await expect(visitor.locator("#apDetails")).toContainText("Read-only");

  // The customer area and the panels send the applicant back to the application page.
  for (const path of ["/account", "/rider"]) {
    await visitor.goto(path);
    await expect(visitor).toHaveURL(/\/application$/, { timeout: 15_000 });
    await visitor.waitForSelector("#apStatus");
  }

  // Signing in again lands on the application page.
  await visitor.click("#apSignOut");
  await confirmDialog(visitor, { title: "Sign out?" });
  await expect(visitor).toHaveURL(/\/login/);
  await signIn(visitor, phone, PASSWORD);
  await expect(visitor).toHaveURL(/\/application$/, { timeout: 20_000 });

  // A message to Paira Express goes on the application's conversation.
  await visitor.fill("#apReply", `I can start next week ${id}`);
  await visitor.click("#apSendReply");
  await expect(visitor.locator("#apMessages")).toContainText(`I can start next week ${id}`);

  // Operations approve it: the page opens the rider app by itself.
  const ops = await opsPage(browser);
  const number = (await visitor.locator(".ap-eyebrow").textContent())!.match(/DF-SUP-\d{6}-\d{4}/)![0];
  const [hub] = await sql<{ id: string }>(`SELECT id FROM hubs WHERE type = 'COMPANY' AND active ORDER BY "createdAt" LIMIT 1`);
  await api(ops, `/applications/${number}/status`, { method: "POST", body: { status: "APPROVED", hubId: hub.id } });
  await expect(visitor).toHaveURL(/\/rider/, { timeout: 30_000 });
  expect((await sql(`SELECT 1 FROM user_roles r JOIN users u ON u.id = r."userId" WHERE u.phone = $1 AND r.role = 'APPLICANT'`, [`+880${phone.slice(1)}`])).length).toBe(0);

  expect(visitor.errors).toEqual([]);
  expect(ops.errors).toEqual([]);
});

test("franchise applicant sees only the application page; a rejection can be closed", async ({ browser }) => {
  test.setTimeout(180_000);
  const id = unique();
  const name = `E2E Franchise Applicant ${id}`;
  const phone = freshPhone();

  const visitor = await open(browser, "/become-a-franchise");
  await visitor.fill("#partnerName", name);
  await visitor.fill("#partnerPhone", phone);
  await visitor.fill("#partnerArea", "Mirpur 10, Dhaka");
  await visitor.selectOption("#partnerInvestment", "CITY_ZONE");
  await createAccountAndSend(visitor, "franchise");
  await expect(visitor).toHaveURL(/\/application$/, { timeout: 20_000 });
  await fx.adoptUser(phone);
  await expect(visitor.locator("#apStatus")).toContainText("Your franchise application is being reviewed");
  await expect(visitor.locator("#apDetails")).toContainText("Mirpur 10, Dhaka");
  await visitor.reload();
  await expect(visitor.locator("#apStatus")).toContainText("being reviewed");

  // Rejected: the page shows the decision live, with "Apply again" and "Close and continue".
  const ops = await opsPage(browser);
  const number = (await visitor.locator(".ap-eyebrow").textContent())!.match(/DF-SUP-\d{6}-\d{4}/)![0];
  await api(ops, `/applications/${number}/status`, { method: "POST", body: { status: "REJECTED", message: "No territory free in Mirpur yet" } });
  await expect(visitor.locator("#apStatus")).toContainText("No territory free in Mirpur yet", { timeout: 30_000 });
  await expect(visitor.locator("#apApplyAgain")).toHaveAttribute("href", "/become-a-franchise");
  await visitor.click("#apLeave");
  await expect(visitor).not.toHaveURL(/\/application/, { timeout: 20_000 });

  expect(visitor.errors).toEqual([]);
  expect(ops.errors).toEqual([]);
});
