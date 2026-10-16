import { randomBytes } from "node:crypto";
import { request as playwrightRequest, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { hash as argonHash } from "@node-rs/argon2";
import { authenticator } from "otplib";
import pg from "pg";
import { API_BASE, Fixtures, apiUrl, expect, test } from "./support";

// Super admins must use two-step verification, and price changes need a second super admin
// (maker-checker). The seeded super admins belong to the owner, so the tests use two temporary
// super admins of their own (created in the dev database, enrolled with test TOTP secrets,
// deleted afterwards): "Maker" works in the browser, "Checker" approves through the API.
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgresql://deliveryfast:deliveryfast@localhost:5432/deliveryfast";
const WEB = { "x-df-client": "web" };
const tempAdmin = (name: string, n: number) => ({ name, phone: `+88019${String(Date.now() + n).slice(-8)}`, password: `Sa-${randomBytes(9).toString("base64url")}`, id: "" });
const MAKER = tempAdmin("E2E Maker Admin", 0);
const CHECKER = tempAdmin("E2E Checker Admin", 7);
const ENROLLER = tempAdmin("E2E Enrolling Admin", 13);
/** Recovery codes of the maker: each later sign-in uses one (a TOTP code can't be reused within its 30 s step). */
let makerRecovery: string[] = [];
let checker: APIRequestContext;
let checkerToken = "";
type Pricing = { sameZone: number; crossZone: number; extraWeight: number; codFeePercent: number; fees: { Regular: number; "Same day": number; Express: number } };
/** Expected while signed out on the website / before the platform settings were ever saved. */
const EXPECTED_ERRORS = [/status of 401/, /status of 404/];
/** The merchant application (applicant and workspace) is deleted afterwards. */
const fx = new Fixtures();

type Errors = string[];

async function open(browser: Browser, path: string, errors: Errors) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("dialog", dialog => dialog.accept());
  page.on("console", message => {
    if (message.type() === "error" && !EXPECTED_ERRORS.some(re => re.test(message.text()))) errors.push(`${page.url()}: ${message.text()}`);
  });
  page.on("pageerror", error => errors.push(`${page.url()}: ${error.message}`));
  await page.goto(path);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return page;
}

async function createAdmin(admin: typeof MAKER) {
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    const { rows } = await db.query(
      `INSERT INTO users (id, name, phone, "passwordHash", "phoneVerifiedAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3, now(), now()) RETURNING id`,
      [admin.name, admin.phone, await argonHash(admin.password, { memoryCost: 19456, timeCost: 2, parallelism: 1 })],
    );
    await db.query(`INSERT INTO user_roles (id, "userId", role) VALUES (gen_random_uuid(), $1, 'SUPER_ADMIN')`, [rows[0].id]);
    admin.id = rows[0].id;
  } finally {
    await db.end();
  }
}
async function deleteAdmins(ids: string[]) {
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  await db.query(`DELETE FROM outbox_messages WHERE "to" = ANY($1::text[]) OR "userId" = ANY($2::uuid[])`, [[MAKER, CHECKER, ENROLLER].map(a => a.phone), ids.filter(Boolean)]).catch(() => undefined);
  await db.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [ids.filter(Boolean)]).finally(() => db.end());
}

/** Signs the maker in (enrolling two-step verification the first time) and opens the super admin panel. */
async function signInAsAdmin(page: Page) {
  const login = await (await page.request.post(apiUrl("/api/v1/auth/login"), { headers: WEB, data: { identifier: MAKER.phone, password: MAKER.password } })).json();
  if (login.mfaSetupRequired) {
    const setup = await (await page.request.post(apiUrl("/api/v1/auth/mfa/setup"), { headers: WEB, data: { mfaToken: login.mfaToken } })).json();
    const enabled = await page.request.post(apiUrl("/api/v1/auth/mfa/enable"), { headers: WEB, data: { mfaToken: login.mfaToken, code: authenticator.generate(setup.secret) } });
    expect(enabled.ok(), await enabled.text()).toBe(true);
    makerRecovery = (await enabled.json()).recoveryCodes;
  } else {
    expect(login.mfaRequired, JSON.stringify(login)).toBe(true);
    const verified = await page.request.post(apiUrl("/api/v1/auth/login/mfa"), { headers: WEB, data: { mfaToken: login.mfaToken, code: makerRecovery.shift() } });
    expect(verified.ok(), await verified.text()).toBe(true);
  }
  await page.goto("/super-admin");
  await expect(page).toHaveURL(/\/super-admin/);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
}

/** The checker approves the maker's pending changes (maker-checker). */
async function approveMakerChanges() {
  const auth = { authorization: `Bearer ${checkerToken}` };
  const pending = await (await checker.get("/api/v1/admin/changes?status=PENDING", { headers: auth })).json();
  const mine = pending.items.filter((c: { requestedBy: { id: string } }) => c.requestedBy.id === MAKER.id);
  expect(mine.length, "a pending change from the maker").toBeGreaterThan(0);
  for (const change of mine) {
    const res = await checker.post(`/api/v1/admin/changes/${change.id}/approve`, { headers: auth, data: { note: "E2E check" } });
    expect(res.ok(), await res.text()).toBe(true);
  }
}

const toast = (page: Page) => page.locator("#toast");
const nav = (page: Page, name: string) => page.click(`#navigation [data-page="${name}"]`);
const settingsSaved = (page: Page) =>
  page.waitForResponse(r => r.url().endsWith("/api/v1/settings/platform-config") && r.request().method() === "PUT" && r.ok());

/** Fills the public customer parcel form in Service plans & pricing and saves it. */
async function saveCustomerPricing(page: Page, values: Pricing) {
  await nav(page, "Service plans");
  const form = page.locator("#publicCustomerParcelForm");
  await form.locator('[name="sameZone"]').fill(String(values.sameZone));
  await form.locator('[name="crossZone"]').fill(String(values.crossZone));
  await form.locator('[name="extraWeight"]').fill(String(values.extraWeight));
  await form.locator('[name="codFeePercent"]').fill(String(values.codFeePercent));
  for (const [service, fee] of Object.entries(values.fees)) await form.locator(`[name="serviceFee:${service}"]`).fill(String(fee));
  await form.locator('button[type="submit"]').click();
  // The change waits for the second super admin, then applies.
  await expect(toast(page)).toContainText("sent for approval");
  await approveMakerChanges();
}

const quote = async (request: APIRequestContext) =>
  (
    await request.post("/api/v1/pricing/quote", {
      data: {
        pickupDistrict: "Dhaka North",
        pickupZone: "Gulshan",
        deliveryDistrict: "Dhaka North",
        deliveryZone: "Gulshan",
        weightKg: 1,
        serviceLevel: "REGULAR",
        codAmount: 0,
      },
    })
  ).json();

/** The website's price calculator for a same-zone 1 kg parcel. */
async function websitePreview(browser: Browser, errors: Errors) {
  const site = await open(browser, "/", errors);
  await site.selectOption("#priceZone", "city"); // fires "change", which recalculates
  await site.selectOption("#priceWeight", "1");
  const total = (await site.locator("#priceTotal").textContent())!.trim();
  await site.context().close();
  return total;
}

test.describe("super admin", () => {
  let errors: Errors;
  test.beforeAll(async () => {
    await createAdmin(MAKER);
    await createAdmin(CHECKER);
    checker = await playwrightRequest.newContext({ baseURL: API_BASE, extraHTTPHeaders: { "x-df-client": "app" } });
    const login = await (await checker.post("/api/v1/auth/login", { data: { identifier: CHECKER.phone, password: CHECKER.password } })).json();
    const setup = await (await checker.post("/api/v1/auth/mfa/setup", { data: { mfaToken: login.mfaToken } })).json();
    const enabled = await (await checker.post("/api/v1/auth/mfa/enable", { data: { mfaToken: login.mfaToken, code: authenticator.generate(setup.secret) } })).json();
    checkerToken = enabled.accessToken;
    expect(checkerToken, JSON.stringify(enabled)).toBeTruthy();
  });
  test.afterAll(async () => {
    await checker?.dispose();
    await deleteAdmins([MAKER.id, CHECKER.id, ENROLLER.id]);
    await fx.cleanup();
  });
  test.beforeEach(() => {
    errors = [];
  });
  test.afterEach(() => {
    expect(errors, "console errors").toEqual([]);
  });

  test("a super admin enrols two-step verification at first sign-in, in the browser", async ({ browser }) => {
    await createAdmin(ENROLLER);
    const page = await open(browser, "/login", errors);
    await page.fill("#loginIdentity", ENROLLER.phone.replace("+88", ""));
    await page.fill("#loginPassword", ENROLLER.password);
    await page.click('form[data-form="login"] button[type="submit"]');
    const setup = page.locator('form[data-form="mfa-setup"]');
    await expect(setup.locator('img[alt="QR code for your authenticator app"]')).toBeVisible();
    const secret = (await setup.locator("code").textContent())!.trim();
    await page.fill("#mfaSetupCode", authenticator.generate(secret));
    await setup.locator('button[type="submit"]').click();
    const codes = page.locator('[data-form="mfa-recovery"] code');
    await expect(codes).toHaveCount(10);
    await page.locator('[data-form="mfa-recovery"] button.button-primary').click();
    await expect(page).toHaveURL(/\/super-admin/);
    await page.waitForSelector("html.legacy-ready", { state: "attached" });
    // The panel shows the real two-step status on Admin users & roles.
    await nav(page, "Admin users");
    await expect(page.locator("#dfSecurity")).toContainText("Two-step verification is on");
    await expect(page.locator("#dfMatrix")).toBeVisible();
    await page.context().close();
  });

  test("security pages show real data: roles matrix, approvals queue, support access, traffic", async ({ browser }) => {
    const admin = await open(browser, "/", errors);
    await signInAsAdmin(admin);
    await nav(admin, "Admin users");
    await expect(admin.locator("#dfMatrix input[data-sec-col=\"FINANCE\"]").first()).toBeAttached();
    await expect(admin.locator("#dfChanges")).toContainText("Changes waiting for approval");
    await expect(admin.locator("#dfSupportForm")).toBeVisible();
    await expect(admin.locator("#mainContent .callout")).toContainText("Two-step verification is required for super admins");
    await nav(admin, "Platform activity");
    await expect(admin.locator("#mainContent .page-heading .eyebrow")).toHaveText("Platform insights · First-party analytics");
    await expect(admin.locator("#mainContent .traffic-bar")).toHaveCount(24);
    await nav(admin, "Audit log");
    await expect(admin.locator("#mainContent .metrics .metric").nth(1)).toContainText("super admins");
    await admin.context().close();
  });

  test("customer pricing drives the website price preview and booking quote", async ({ browser, api }) => {
    // The owner's current customer prices are put back afterwards.
    const card = (await quote(api)).rateCard;
    const original: Pricing = {
      sameZone: card.sameZone,
      crossZone: card.crossZone,
      extraWeight: card.extraWeight,
      codFeePercent: card.codFeePercent,
      fees: { Regular: card.serviceFees.REGULAR, "Same day": card.serviceFees.SAME_DAY, Express: card.serviceFees.EXPRESS },
    };
    const admin = await open(browser, "/", errors);
    await signInAsAdmin(admin);
    const changed = { ...original, sameZone: original.sameZone + 13 };
    try {
      await saveCustomerPricing(admin, changed);
      expect((await quote(api)).baseCharge).toBe(changed.sameZone);
      expect(await websitePreview(browser, errors)).toBe(`৳ ${changed.sameZone + changed.fees.Regular}`);
      // The editor reloads with the published values.
      await admin.reload();
      await admin.waitForSelector("html.legacy-ready", { state: "attached" });
      await nav(admin, "Service plans");
      await expect(admin.locator('#publicCustomerParcelForm [name="sameZone"]')).toHaveValue(String(changed.sameZone));
    } finally {
      await saveCustomerPricing(admin, original);
    }
    const restored = await quote(api);
    expect(restored).toMatchObject({ baseCharge: original.sameZone, rateCard: card });
    expect(await websitePreview(browser, errors)).toBe(`৳ ${original.sameZone + original.fees.Regular}`);
  });

  test("approves a merchant application", async ({ browser, api: request }) => {
    // A new account applies for a merchant workspace.
    const phone = `019${String(Date.now()).slice(-8)}`;
    const otp = await (await request.post("/api/v1/auth/otp", { data: { phone, purpose: "SIGNUP" } })).json();
    expect(otp.devCode, "needs EXPOSE_DEV_OTP=true").toBeTruthy();
    const signup = await request.post("/api/v1/auth/signup", { data: { name: "E2E Applicant", phone, password: "E2ePassword2026", otp: otp.devCode } });
    const { accessToken } = await signup.json();
    await fx.adoptUser(phone);
    const business = `E2E Approval Shop ${Date.now()}`;
    const application = await request.post("/api/v1/merchants/applications", {
      headers: { authorization: `Bearer ${accessToken}` },
      data: {
        type: "ECOMMERCE",
        name: business,
        contactName: "E2E Applicant",
        contactPhone: phone,
        pickupAddress: "House 5, Road 2, Gulshan",
        pickupArea: "Gulshan",
        pickupDistrict: "Dhaka North",
      },
    });
    expect(application.status()).toBe(201);
    const { id, code } = (await application.json()).merchant;
    await fx.adoptMerchant(business);

    const admin = await open(browser, "/", errors);
    await signInAsAdmin(admin);
    await nav(admin, "Registrations");
    const row = admin.locator("#registrationBody tr", { hasText: business });
    await expect(row).toContainText("Pending review");
    await row.locator("[data-review]").click();
    await expect(admin.locator("#modalTitle")).toHaveText(`Review ${business}`);
    await admin.selectOption("#approvalPlan", { label: "Growth · 8% off" });
    await admin.click("#modalSubmit");
    await expect(toast(admin)).toContainText(`${business}: approved`);
    await expect(row).toContainText("Approved");

    await nav(admin, "E-commerce merchants");
    const account = admin.locator("#segmentMerchantBody tr", { hasText: business });
    await expect(account).toContainText("Active");
    await expect(account).toContainText("Growth");
    await expect(account).toContainText(code);

    const token = await admin.evaluate(() =>
      fetch("/api/v1/auth/refresh", { method: "POST", headers: { "x-df-client": "web" } })
        .then(r => r.json())
        .then(r => r.accessToken as string),
    );
    const merchant = await (await request.get(`/api/v1/merchants/${id}`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(merchant).toMatchObject({ status: "ACTIVE", plan: { name: "Growth" } });
  });

  test("platform settings persist on the server", async ({ browser }) => {
    const admin = await open(browser, "/", errors);
    await signInAsAdmin(admin);
    const sms = admin.locator('#notificationConfigForm [name="sms"]');
    // The owner's current choice is put back afterwards.
    await nav(admin, "Platform settings");
    const smsWasOn = await sms.isChecked();
    const setSms = async (on: boolean) => {
      await nav(admin, "Platform settings");
      await sms.setChecked(on);
      const saved = settingsSaved(admin);
      await admin.click("[data-config-save]");
      await saved;
      await expect(toast(admin)).toContainText("channel preferences saved");
    };
    try {
      await setSms(!smsWasOn);
      expect((await (await admin.request.get(apiUrl("/api/v1/settings/platform-config"))).json()).channels.sms).toBe(!smsWasOn);
      // A fresh browser (nothing in local storage) sees the saved settings.
      const other = await open(browser, "/", errors);
      await signInAsAdmin(other);
      await nav(other, "Platform settings");
      await expect(other.locator('#notificationConfigForm [name="sms"]')).toBeChecked({ checked: !smsWasOn });
      await other.context().close();
    } finally {
      await setSms(smsWasOn);
    }
    await admin.reload();
    await admin.waitForSelector("html.legacy-ready", { state: "attached" });
    await nav(admin, "Platform settings");
    await expect(sms).toBeChecked({ checked: smsWasOn });
  });
});
