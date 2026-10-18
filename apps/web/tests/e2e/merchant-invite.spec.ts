import { type Browser, type Page } from "@playwright/test";
import { authenticator } from "otplib";
import { Fixtures, apiUrl, expect, sql, test, type TempUser } from "./support";

/**
 * Merchant invitations end to end (owner report 2026-10-18: "the invited merchant signed up and
 * submitted, but the request isn't found"). Super admin invites → the merchant opens the SMS link
 * signed out → fills the application (structured address) → creates the account (SMS code) or signs
 * in right in the form → the application is sent with the invitation → Super admin → Registrations
 * shows it (pending review), the invitation is used, the super admin gets "New merchant registration".
 * Also: every validation problem is shown (inline + summary), the form and the invitation survive the
 * login page round trip, and a used link says so. Every account, merchant and invitation is temporary.
 */
const fx = new Fixtures();
const WEB = { "x-df-client": "web" };
const NAMES: string[] = [];
let admin: TempUser;
test.beforeAll(async () => {
  admin = await fx.user(`E2E Invite Admin ${fx.stamp}`, [{ role: "SUPER_ADMIN" }]);
});
test.afterAll(async () => {
  for (const name of NAMES) {
    await sql(`DELETE FROM merchant_invites WHERE "businessName" = $1`, [name]);
    // "New merchant registration: …" reaches every super admin (the owner's accounts too).
    await sql(`DELETE FROM user_notifications WHERE title LIKE $1`, [`%${name}%`]);
  }
  await fx.cleanup();
});

type Errors = string[];
async function open(browser: Browser, errors: Errors, viewport?: { width: number; height: number }) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/status of (401|404|409|422)|Failed to load resource|tile\.openstreetmap/.test(message.text())) errors.push(message.text());
  });
  return page;
}

let recovery: string[] = [];
/** The temporary super admin (two-step verification enrolled through the API the first time, then a recovery code). */
async function signInAdmin(page: Page) {
  const login = await (await page.request.post(apiUrl("/api/v1/auth/login"), { headers: WEB, data: { identifier: admin.phone, password: admin.password } })).json();
  if (login.mfaSetupRequired) {
    const setup = await (await page.request.post(apiUrl("/api/v1/auth/mfa/setup"), { headers: WEB, data: { mfaToken: login.mfaToken } })).json();
    const enabled = await page.request.post(apiUrl("/api/v1/auth/mfa/enable"), { headers: WEB, data: { mfaToken: login.mfaToken, code: authenticator.generate(setup.secret) } });
    expect(enabled.ok(), await enabled.text()).toBe(true);
    recovery = (await enabled.json()).recoveryCodes;
  } else {
    expect(login.mfaRequired, JSON.stringify(login)).toBe(true);
    const verified = await page.request.post(apiUrl("/api/v1/auth/login/mfa"), { headers: WEB, data: { mfaToken: login.mfaToken, code: recovery.shift() } });
    expect(verified.ok(), await verified.text()).toBe(true);
  }
  await page.goto("/super-admin");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
}

/** A +8801… number nobody has; returns the 10 digits after +880. */
async function freshLocal() {
  for (;;) {
    const local = `1${3 + Math.floor(Math.random() * 7)}${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    if (!(await sql(`SELECT 1 FROM users WHERE phone = $1`, [`+880${local}`])).length) return local;
  }
}

/** Business address (Dhaka North › Gulshan › Gulshan 2) and the pickup time. */
async function fillAddress(page: Page) {
  await page.selectOption("#bizDistrict", "Dhaka North");
  await page.selectOption("#bizZone", "Gulshan");
  await page.selectOption("#bizArea", "Gulshan 2");
  await page.fill("#bizStreet", "House 9, Road 3, Flat 2A");
  await page.check('input[name="pickupTime"][value="MORNING"]');
}

async function expectRegistered(page: Page, business: string, phone: string) {
  // Straight into the merchant panel (never the website's customer area): the verification screen.
  await expect(page).toHaveURL(/\/ecommerce-merchant/, { timeout: 20_000 });
  const card = page.locator("#dfvPage");
  await expect(page.locator("#dfvStatus")).toContainText("isn't verified yet", { timeout: 20_000 });
  await fx.adoptMerchant(business);
  const [m] = await sql<{ id: string; code: string; status: string; type: string; businessZone: string; businessArea: string; owner: string }>(
    `SELECT m.id, m.code, m.status, m.type, m."businessZone", m."businessArea", u.phone AS owner FROM merchants m JOIN user_roles r ON r."merchantId" = m.id AND r.role = 'MERCHANT_OWNER' JOIN users u ON u.id = r."userId" WHERE m.name = $1`,
    [business],
  );
  expect(m).toMatchObject({ status: "PENDING_REVIEW", type: "ECOMMERCE", businessZone: "Gulshan", businessArea: "Gulshan 2", owner: phone });
  await expect(card).toContainText(m.code);
  // The invitation is used by this application.
  const [invite] = await sql<{ acceptedAt: Date | null; merchantId: string | null }>(`SELECT "acceptedAt", "merchantId" FROM merchant_invites WHERE "businessName" = $1`, [business]);
  expect(invite.acceptedAt).not.toBeNull();
  expect(invite.merchantId).toBe(m.id);
  // The super admin's bell: "New merchant registration".
  const [note] = await sql<{ title: string }>(`SELECT title FROM user_notifications WHERE "userId" = $1 AND title LIKE $2`, [admin.id, `%${business}%`]);
  expect(note?.title).toBe(`New merchant registration: ${business}`);
  return m;
}

test("invited new merchant signs up and applies end to end", async ({ browser }) => {
  const errors: Errors = [];
  const business = `E2E Invited Shop ${fx.stamp}`;
  NAMES.push(business);
  const local = await freshLocal();

  // Super admin → E-commerce merchants → Invite a merchant.
  const adminPage = await open(browser, errors);
  await signInAdmin(adminPage);
  await adminPage.click('#navigation [data-page="E-commerce merchants"]');
  await adminPage.click('[data-action="inviteMerchant"]');
  await adminPage.fill("#inviteBusiness", business);
  await adminPage.fill("#inviteOwner", `E2E Invited Owner ${fx.stamp}`);
  await adminPage.fill("#inviteEmail", `invited-${fx.stamp.toLowerCase()}@example.com`);
  await adminPage.fill("#dfmInvitePhone", local);
  await adminPage.click("#modalSubmit");
  await expect(adminPage.locator("#dfmInviteLink")).toContainText("/merchant?invite=");
  const link = new URL((await adminPage.locator("#dfmInviteLink").textContent())!.trim());
  await adminPage.click("#dfmDialog [data-dfm-close]");
  await expect(adminPage.locator("#dfmDialog")).toHaveCount(0);

  // The SMS: a clear invitation (no "Delivery Fast added you to Delivery Fast"), linking to the application.
  const [sms] = await sql<{ body: string; template: string }>(`SELECT body, template FROM outbox_messages WHERE "to" = $1 AND channel = 'SMS' ORDER BY "createdAt" DESC LIMIT 1`, [`+880${local}`]);
  expect(sms.template).toBe("merchant.invite");
  expect(sms.body).toBe(`You're invited to join Delivery Fast as an E-commerce merchant (${business}). Create your account and apply here: ${link.href}`);

  // The merchant opens the link, signed out.
  const page = await open(browser, errors);
  await page.goto(link.pathname + link.search);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(page.locator("#inviteNotice")).toContainText(`You're invited to join Delivery Fast as an E-commerce merchant (${business})`);
  await expect(page.locator("#merchantAccountType")).toHaveValue("E-commerce merchant");
  await expect(page.locator("#merchantAccountType")).toBeDisabled();
  await expect(page.locator("#partnerName")).toHaveValue(business);
  await expect(page.locator("#partnerContact")).toHaveValue(`E2E Invited Owner ${fx.stamp}`);
  await expect(page.locator("#partnerPhone")).toHaveValue(local);
  await expect(page.locator("#accountMode-new")).toBeChecked();

  // Sending too early never fails silently: inline messages plus a summary at the top.
  await page.click('form[data-form="merchant"] button[type="submit"]');
  const summary = page.locator("#merchantFormErrors");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("Business district: Choose the district");
  await expect(summary).toContainText("Preferred pickup time: Choose the preferred pickup time");
  await expect(summary).toContainText("Create a password: Create a password");
  await expect(page.locator("#bizDistrict-error")).toHaveText("Choose the district");
  await expect(page.locator("#pickupTime-error")).toBeVisible();
  await expect(page).toHaveURL(/\/merchant\?invite=/); // still on the form

  // The summary follows the fixes and goes away once everything is fine.
  await fillAddress(page);
  await expect(summary).not.toContainText("Business district");
  await expect(summary).toContainText("Create a password");
  await page.fill("#accountPassword", "Invited-pass-2026");
  await expect(summary).toHaveCount(0);
  await page.click('form[data-form="merchant"] button[type="submit"]');

  // The SMS code step, in the form; the typed values stay.
  const codeField = page.locator(".field", { has: page.locator("#accountOtp") });
  await expect(codeField).toContainText("Development code:");
  await expect(summary).toHaveCount(0);
  const code = /(\d{6})/.exec((await codeField.textContent()) ?? "")![1];
  await expect(page.locator('form[data-form="merchant"] button[type="submit"]')).toHaveText("Verify code and send application");
  await page.fill("#accountOtp", "000000".replace(/./g, (_, i) => String((Number(code[i]) + 1) % 10))); // a wrong code first
  await page.click('form[data-form="merchant"] button[type="submit"]');
  await expect(page.locator("#accountOtp-error")).toBeVisible();
  await expect(summary).toContainText("SMS code");
  await page.fill("#accountOtp", code);
  await page.click('form[data-form="merchant"] button[type="submit"]');
  await fx.adoptUser(local);
  await expectRegistered(page, business, `+880${local}`);

  // Super admin → Registrations: pending review.
  await adminPage.click('#navigation [data-page="Registrations"]');
  await expect(adminPage.locator("#registrationBody tr", { hasText: business })).toContainText("Pending review");

  // The link works once: opening it again says so.
  const again = await open(browser, errors);
  await again.goto(link.pathname + link.search);
  await again.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(again.locator("#inviteNotice")).toContainText("This invitation was already used");
  await expect(again.locator("#merchantAccountType")).toBeEnabled();

  expect(errors).toEqual([]);
  for (const p of [adminPage, page, again]) await p.context().close();
});

test("invited merchant with an existing account signs in on a phone-width screen, through the login page and back", async ({ browser }) => {
  const errors: Errors = [];
  const business = `E2E Invited Existing ${fx.stamp}`;
  NAMES.push(business);
  const existing = await fx.user(`E2E Existing Owner ${fx.stamp}`, [{ role: "CUSTOMER" }]);
  const local = existing.phone.slice(4);

  // Invited through the API (the modal is covered above).
  const adminPage = await open(browser, errors);
  await signInAdmin(adminPage);
  const link = new URL(
    await adminPage.evaluate(
      async ({ business, phone }) => {
        const DF = (window as unknown as { DF: { api: (path: string, o: object) => Promise<{ link: string }> } }).DF;
        return (await DF.api("/merchants/invites", { method: "POST", body: { name: "Existing Owner", businessName: business, phone, type: "ECOMMERCE" } })).link;
      },
      { business, phone: existing.phone },
    ),
  );
  // The invitation lookup tells the form this number already has an account.
  const lookup = await adminPage.request.post(apiUrl("/api/v1/merchants/invites/lookup"), { data: { token: link.searchParams.get("invite") } });
  expect(await lookup.json()).toMatchObject({ businessName: business, type: "ECOMMERCE", hasAccount: true });

  const page = await open(browser, errors, { width: 390, height: 844 });
  await page.goto(link.pathname + link.search);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(page.locator("#inviteNotice")).toContainText("This number already has an account");
  await expect(page.locator("#accountMode-existing")).toBeChecked();
  await expect(page.locator("#accountLogin")).toHaveValue(`0${local}`);
  await fillAddress(page);
  await page.fill("#partnerContact", existing.name);

  // A wrong password: shown at the field and in the summary.
  await page.fill("#accountLoginPassword", "not-the-password-1");
  await page.click('form[data-form="merchant"] button[type="submit"]');
  await expect(page.locator("#accountLoginPassword-error")).toContainText(/incorrect/i);
  await expect(page.locator("#merchantFormErrors")).toContainText("Password");

  // The login page round trip keeps the form and the invitation (e.g. two-step accounts, forgotten passwords).
  await page.click("#accountLoginPage");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator("#loginReturnNote")).toContainText("Sign in to send your merchant application");
  await page.fill("#loginIdentity", existing.login);
  await page.fill("#loginPassword", existing.password);
  await page.click('form[data-form="login"] button[type="submit"]');
  await expect(page).toHaveURL(/\/merchant$/);
  await expect(page.locator("#partnerName")).toHaveValue(business);
  await expect(page.locator("#bizStreet")).toHaveValue("House 9, Road 3, Flat 2A");
  await expect(page.locator("#merchantAccountType")).toBeDisabled(); // still the invited type
  await expect(page.locator("#accountMode-new")).toHaveCount(0); // signed in: no account step
  // Nothing scrolls sideways at phone width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.click('form[data-form="merchant"] button[type="submit"]');
  await expectRegistered(page, business, existing.phone);

  expect(errors).toEqual([]);
  for (const p of [adminPage, page]) await p.context().close();
});
