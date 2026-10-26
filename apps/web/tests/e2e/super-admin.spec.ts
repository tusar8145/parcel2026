import { randomBytes } from "node:crypto";
import { request as playwrightRequest, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { hash as argonHash } from "@node-rs/argon2";
import { authenticator } from "otplib";
import pg from "pg";
import { API_BASE, Fixtures, apiUrl, expect, secondApprovalOn, test } from "./support";

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
  await page.waitForFunction(
    () => document.documentElement.classList.contains("legacy-ready") || document.documentElement.dataset.websiteReady === "true",
  );
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

/**
 * Sets the Customer default package's "Inside same district" price in Service plans & pricing
 * (a new version, effective once the second super admin approves it).
 */
async function saveCustomerSameDistrict(page: Page, price: number) {
  await nav(page, "Service plans");
  await page.click('[data-pkg-segment="CUSTOMER"]');
  const row = page.locator("#pkgTable tr", { has: page.locator(".status-good", { hasText: "Default" }) });
  await row.locator("[data-pkg-edit]").click();
  await page.fill("#pkgPrice-sameDistrict", String(price));
  await page.fill("#pkgNote", "E2E price check");
  await page.click("#pkgSave");
  // The change waits for the second super admin, then applies.
  await expect(toast(page)).toContainText(/approval/i);
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
  let restoreApproval: (() => Promise<void>) | undefined;
  test.beforeAll(async () => {
    // These tests check maker-checker: second super admin approval on (off by default).
    restoreApproval = await secondApprovalOn();
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
    await restoreApproval?.();
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
    await page.click('[data-admin-tab="roles"]');
    await expect(page.locator("#dfMatrix")).toBeVisible();
    await page.context().close();
  });

  test("security pages show real data: roles matrix, approvals queue, support access, traffic", async ({ browser }) => {
    const admin = await open(browser, "/", errors);
    await signInAsAdmin(admin);
    await nav(admin, "Admin users");
    // The sections are in tabs: Administrators (default) · Approvals · Roles & permissions · Support access.
    await expect(admin.locator("#mainContent .callout")).toContainText("Two-step verification is required for super admins");
    await expect(admin.locator("#adminBody")).toBeVisible();
    await expect(admin.locator("#dfMatrix")).toBeHidden();
    await admin.click('[data-admin-tab="roles"]');
    await expect(admin.locator("#dfMatrix input[data-sec-col=\"FINANCE\"]").first()).toBeVisible();
    await expect(admin.locator("#adminBody")).toBeHidden();
    await admin.click('[data-admin-tab="approvals"]');
    await expect(admin.locator("#dfChanges")).toContainText("Changes waiting for approval");
    await expect(admin.locator("#dfChanges [data-sec-approval]")).toBeChecked();
    await expect(admin.locator("#dfChanges")).toBeVisible();
    await admin.click('[data-admin-tab="support"]');
    await expect(admin.locator("#dfSupportForm")).toBeVisible();
    await admin.click('[data-admin-tab="admins"]');
    await nav(admin, "Platform activity");
    await expect(admin.locator("#mainContent .page-heading .eyebrow")).toHaveText("Platform insights · First-party analytics");
    // Default period: the last 7 days, one bar a day (dashboard-periods.spec.ts covers the other periods).
    await expect(admin.locator("#mainContent .traffic-bar")).toHaveCount(7);
    await nav(admin, "Audit log");
    await expect(admin.locator("#mainContent .metrics .metric").nth(1)).toContainText("super admins");
    await admin.context().close();
  });

  test("shared catalogs keep only the lists forms read; products and services point to Service plans", async ({ browser }) => {
    const admin = await open(browser, "/", errors);
    await signInAsAdmin(admin);
    await nav(admin, "Pricing & catalogs");
    const main = admin.locator("#mainContent");
    await expect(main.locator("#catalogProductsPointer")).toContainText("Service plans → Products");
    // The old product, service level and document type lists are gone; the lists real forms read stay.
    for (const list of ["ecommerceProducts", "documentProducts", "deliveryServices", "documentTypes"]) await expect(main.locator(`[data-catalog-form="${list}"]`)).toHaveCount(0);
    for (const title of ["E-commerce products", "Document products", "Delivery service levels", "Document type catalog"]) await expect(main.getByText(title, { exact: true })).toHaveCount(0);
    await expect(main.locator('[data-catalog-form="returnReasons"]')).toHaveCount(1);
    // Packaging is no longer a booking field (owner decision 2026-10-18); receiver relations are chosen at delivery (2026-10-24).
    await expect(main.locator('[data-catalog-form="receiverRelations"]')).toHaveCount(1);
    for (const list of ["ecommercePackaging", "documentPackaging"]) await expect(main.locator(`[data-catalog-form="${list}"]`)).toHaveCount(0);
    for (const title of ["Receiver relationships", "E-commerce packaging", "Document packaging"]) await expect(main.getByText(title, { exact: true })).toHaveCount(0);
    await expect(main.locator("#geoAdmin")).toBeAttached();
    await main.locator("[data-open-products]").click();
    await expect(admin.locator("#pkgProductsPanel")).toBeVisible();
    await expect(admin.locator("#pkgProductsPanel .panel-title")).toHaveText("Customer & E-commerce products");
    // The demo service table is gone; the page holds the spreadsheet import settings.
    await nav(admin, "Import settings");
    await expect(main.locator("h1")).toHaveText("Spreadsheet imports");
    await expect(main.locator("#importSettingsPointer")).toContainText("Services and prices: Service plans");
    await expect(main.locator('[data-action="newService"]')).toHaveCount(0);
    await expect(main.locator("#importSettings")).toBeVisible();
    await admin.context().close();
  });

  test("the Customer default package drives the website price preview and booking quote", async ({ browser, api }) => {
    // The owner's current customer price is put back afterwards (as another version).
    const before = await quote(api);
    const original = (before.lines as { code: string; amount: number }[]).find(l => l.code === "route")!.amount;
    const previewBefore = Number((await websitePreview(browser, errors)).replace(/[^0-9.]/g, ""));
    const admin = await open(browser, "/", errors);
    await signInAsAdmin(admin);
    try {
      await saveCustomerSameDistrict(admin, original + 13);
      const changed = await quote(api);
      expect(changed.totalCharge).toBe(before.totalCharge + 13);
      expect(Number((await websitePreview(browser, errors)).replace(/[^0-9.]/g, ""))).toBe(previewBefore + 13);
      // The editor reloads with the published values.
      await admin.reload();
      await admin.waitForSelector("html.legacy-ready", { state: "attached" });
      await nav(admin, "Service plans");
      await admin.click('[data-pkg-segment="CUSTOMER"]');
      await expect(admin.locator("#pkgTable")).toContainText(`v${changed.package.version}`);
    } finally {
      await saveCustomerSameDistrict(admin, original);
    }
    const restored = await quote(api);
    expect(restored.totalCharge).toBe(before.totalCharge);
    expect(Number((await websitePreview(browser, errors)).replace(/[^0-9.]/g, ""))).toBe(previewBefore);
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
        businessCategory: "Regular",
        business: { district: "Dhaka North", zone: "Gulshan", area: "Gulshan 2", street: "House 5, Road 2", lat: 23.7925, lng: 90.4078 },
        pickupSameAsBusiness: false,
        pickup: { district: "Dhaka North", zone: "Uttara", otherArea: "E2E Lane 9", street: "Warehouse 4, Sector 7" },
        pickupContactName: "E2E Store Keeper",
        pickupContactPhone: phone,
        pickupTime: "AFTERNOON",
        handover: "HUB_DROP",
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
    // The structured addresses with the derived hub and route district (bridge-merchants.js, shared/merchant-address.js).
    const summary = admin.locator("#dfmAddress");
    // The address as typed, its area / zone / district on their own row (never appended to the address).
    await expect(summary).toContainText("House 5, Road 2");
    await expect(summary).toContainText("Gulshan 2 · Gulshan · Dhaka North");
    await expect(summary).toContainText("Warehouse 4, Sector 7");
    await expect(summary).toContainText("E2E Lane 9 · Uttara · Dhaka North");
    await expect(summary).not.toContainText("House 5, Road 2, Gulshan");
    await expect(summary).toContainText("area typed");
    await expect(summary).toContainText("E2E Store Keeper");
    await expect(summary).toContainText("Afternoon");
    await expect(summary).toContainText("Drop at hub");
    await expect(summary).toContainText("Uttara Delivery Hub (DHK-UTT)");
    await expect(summary.locator("text=Route district")).toBeVisible();
    await expect(summary.locator("[data-dfma-map]")).toHaveAttribute("href", /mlat=23.7925/);
    // The merchant books with its category's default package unless another one is chosen.
    await expect(admin.locator("#approvalPlan option").first()).toContainText("(default)");
    await admin.click("#modalSubmit");
    await expect(toast(admin)).toContainText(`${business}: approved`);
    await expect(row).toContainText("Approved");

    await nav(admin, "E-commerce merchants");
    const account = admin.locator("#segmentMerchantBody tr", { hasText: business });
    await expect(account).toContainText("Active");
    // Service packages replaced service plans: the account lists the package it books with (its category's default).
    await expect(account).toContainText("(default)");
    await expect(account).toContainText(code);
    await expect(admin.locator("#mainContent table th", { hasText: /^PACKAGE$/ })).toHaveCount(1);
    // The account dialog shows the package, not the retired plan select, and "Change" leads to its assignment row.
    await account.locator(`[data-merchant="${code}"]`).click();
    await expect(admin.locator("#merchantPlan")).toHaveCount(0);
    await expect(admin.locator("#merchantPackage")).toHaveValue(/\(default\) · v\d+$/);
    await admin.click("#merchantPackageChange");
    await expect(admin.locator("#modalBackdrop")).not.toHaveClass(/open/);
    await expect(admin.locator("#breadcrumbPage")).toHaveText("Service plans");
    const assignment = admin.locator(`#pkgAssignments tr[data-pkg-merchant="${code}"]`);
    await expect(assignment).toBeVisible();
    await expect(assignment.locator("select")).toBeFocused();

    const token = await admin.evaluate(() =>
      fetch("/api/v1/auth/refresh", { method: "POST", headers: { "x-df-client": "web" } })
        .then(r => r.json())
        .then(r => r.accessToken as string),
    );
    const merchant = await (await request.get(`/api/v1/merchants/${id}`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(merchant).toMatchObject({ status: "ACTIVE" });
    // It books with the E-commerce default package.
    const pkg = await (await request.get(`/api/v1/merchants/${id}/package`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(pkg).toMatchObject({ segment: "ECOMMERCE", current: { isDefault: true } });
  });

  test("platform settings persist on the server", async ({ browser }) => {
    const admin = await open(browser, "/", errors);
    await signInAsAdmin(admin);
    // The notification channels are on SMS, Email & Push › Channels & limits.
    const settingsTab = async (who: Page) => {
      await nav(who, "Integrations");
      await who.click('[data-int-tab="settings"]');
    };
    const sms = admin.locator('#sysChannelsForm [name="sms"]');
    // The owner's current choice is put back afterwards.
    await settingsTab(admin);
    const smsWasOn = await sms.isChecked();
    const setSms = async (on: boolean) => {
      await settingsTab(admin);
      await sms.setChecked(on);
      const saved = settingsSaved(admin);
      await admin.click('#sysChannelsForm button[type="submit"]');
      await saved;
      await expect(toast(admin)).toContainText("Notification channels saved");
    };
    try {
      await setSms(!smsWasOn);
      expect((await (await admin.request.get(apiUrl("/api/v1/settings/platform-config"))).json()).channels.sms).toBe(!smsWasOn);
      // A fresh browser (nothing in local storage) sees the saved settings.
      const other = await open(browser, "/", errors);
      await signInAsAdmin(other);
      await settingsTab(other);
      await expect(other.locator('#sysChannelsForm [name="sms"]')).toBeChecked({ checked: !smsWasOn });
      await other.context().close();
    } finally {
      await setSms(smsWasOn);
    }
    await admin.reload();
    await admin.waitForSelector("html.legacy-ready", { state: "attached" });
    await settingsTab(admin);
    await expect(sms).toBeChecked({ checked: smsWasOn });
  });
});
