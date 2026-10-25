import { randomBytes } from "node:crypto";
import { type Browser, type Page } from "@playwright/test";
import { API_ORIGIN, confirmDialog, expect, test } from "./support";
import { hash as argonHash } from "@node-rs/argon2";
import { authenticator } from "otplib";
import pg from "pg";

// Super admin → Global notifications (templates, switches, limits) and Integrations (gateways).
// Runs against the dev database: every change is put back, and no real message is sent.
// The seeded super admin must enrol two-step verification, so the tests use their own
// temporary super admin (created in the database, enrolled with a test TOTP secret, deleted after).
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgresql://deliveryfast:deliveryfast@localhost:5432/deliveryfast";
const PASSWORD = `Nt-${randomBytes(9).toString("base64url")}`;
const PHONE = `+88019${String(Date.now()).slice(-8)}`;
const EXPECTED_ERRORS = [/status of 401/, /status of 404/, /status of 422/];

async function createAdmin() {
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    const { rows } = await db.query(
      `INSERT INTO users (id, name, phone, "passwordHash", "phoneVerifiedAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3, now(), now()) RETURNING id`,
      ["Notifications E2E Admin", PHONE, await argonHash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 })],
    );
    await db.query(`INSERT INTO user_roles (id, "userId", role) VALUES (gen_random_uuid(), $1, 'SUPER_ADMIN')`, [rows[0].id]);
    return rows[0].id as string;
  } finally {
    await db.end();
  }
}
async function deleteAdmin(id: string) {
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  await db.query(`DELETE FROM outbox_messages WHERE "to" = $1 OR "userId" = $2`, [PHONE, id]).catch(() => undefined);
  await db.query("DELETE FROM users WHERE id = $1", [id]).finally(() => db.end());
}

/** Signs the temporary admin in (enrolling two-step verification) and opens the panel. */
async function open(browser: Browser, errors: string[]) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("dialog", dialog => dialog.accept());
  page.on("console", message => {
    if (message.type() === "error" && !EXPECTED_ERRORS.some(re => re.test(message.text()))) errors.push(`${page.url()}: ${message.text()}`);
  });
  page.on("pageerror", error => errors.push(`${page.url()}: ${error.message}`));
  // E2E_API_ORIGIN: the page's calls are forwarded by `test` from support.ts; these go there directly.
  const apiOrigin = API_ORIGIN;
  const headers = { "x-df-client": "web" };
  const login = await (await page.request.post(`${apiOrigin}/api/v1/auth/login`, { headers, data: { identifier: PHONE, password: PASSWORD } })).json();
  expect(login.mfaSetupRequired, JSON.stringify(login)).toBe(true);
  const setup = await (await page.request.post(`${apiOrigin}/api/v1/auth/mfa/setup`, { headers, data: { mfaToken: login.mfaToken } })).json();
  const enabled = await page.request.post(`${apiOrigin}/api/v1/auth/mfa/enable`, { headers, data: { mfaToken: login.mfaToken, code: authenticator.generate(setup.secret) } });
  expect(enabled.ok(), await enabled.text()).toBe(true);
  await page.goto("/super-admin");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(page.locator('#navigation [data-page="Integrations"]')).toBeVisible();
  return page;
}

const nav = (page: Page, name: string) => page.click(`#navigation [data-page="${name}"]`);
const toast = (page: Page) => page.locator("#toast");
/** Calls the API as the signed-in admin. */
const api = (page: Page, path: string, method = "GET", body?: unknown) =>
  page.evaluate(
    async ([path, method, body]) => {
      const { accessToken } = await (await fetch("/api/v1/auth/refresh", { method: "POST", headers: { "x-df-client": "web" } })).json();
      const res = await fetch(`/api/v1${path}`, {
        method: method as string,
        headers: { authorization: `Bearer ${accessToken}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    [path, method, body] as const,
  );

test.describe.serial("super admin notifications", () => {
  const errors: string[] = [];
  let adminId: string;
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    adminId = await createAdmin();
    page = await open(browser, errors);
  });
  test.afterAll(async () => {
    await page?.context().close();
    if (adminId) await deleteAdmin(adminId);
  });
  test.afterEach(() => expect(errors).toEqual([]));

  test("edits, previews and resets a template; switches an event off and on", async () => {
    const before = (await api(page, "/notifications/events")).body.events.find((e: any) => e.event === "parcel.booked");
    try {
      // Parcel messages have their own page (Merchant management › Parcel notifications).
      await nav(page, "Parcel notifications");
      const row = page.locator('#notificationEventsTable tr[data-nt-event="parcel.booked"]');
      await expect(row).toContainText("Pickup request received");
      // Only the Parcel group here; the channel switches are on Settings.
      await expect(page.locator('#notificationEventsTable tr[data-nt-event="auth.otp.login"]')).toHaveCount(0);
      await expect(page.locator("#notificationConfigForm")).toHaveCount(0);

      await row.locator('[data-nt-edit="parcel.booked|sms"]').click();
      const editor = page.locator("#notificationTemplateEditor");
      await expect(editor).toContainText("Pickup request received · SMS");
      await expect(editor.locator('[data-nt-var="trackingId"]')).toBeVisible();

      // Unknown placeholders are refused with a clear message.
      await editor.locator("#ntBody").fill("Booked {{trackingID}}");
      await editor.locator('button[type="submit"]').click();
      await expect(editor.locator("#ntPreview")).toContainText("unknown placeholder {{trackingID}}");

      // Insert a variable with its chip, preview, then save.
      await editor.locator("#ntBody").fill("Booked ");
      await editor.locator('[data-nt-var="trackingId"]').click();
      await editor.locator("#ntBody").press("End");
      await editor.locator("#ntBody").pressSequentially(". Charge Tk {{charge}}.");
      await editor.locator("[data-nt-preview]").click();
      await expect(editor.locator("#ntPreview")).toContainText("Booked PP-261016-4821. Charge Tk 185.");
      await expect(editor.locator("#ntPreview")).toContainText("1 SMS part");
      await editor.locator('button[type="submit"]').click();
      await expect(toast(page)).toContainText("Template saved");
      await expect(row.locator('[data-nt-edit="parcel.booked|sms"]')).toContainText("customised");
      expect((await api(page, "/notifications/events")).body.events.find((e: any) => e.event === "parcel.booked").channels.sms.body).toBe("Booked {{trackingId}}. Charge Tk {{charge}}.");

      await editor.locator("[data-nt-reset]").click();
      await confirmDialog(page, { title: "Restore the default text?" });
      await expect(toast(page)).toContainText("Default text restored");
      await expect(row.locator('[data-nt-edit="parcel.booked|sms"]')).not.toContainText("customised");

      // Email preview renders the layout in a sandboxed frame.
      await row.locator('[data-nt-edit="parcel.booked|email"]').click();
      await editor.locator("[data-nt-preview]").click();
      await expect(editor.locator("#ntPreview")).toContainText("Subject: Pickup request PP-261016-4821 received");
      await expect(editor.locator("#ntPreview [data-email-preview]")).toContainText("We received your pickup request PP-261016-4821");

      // Per event × channel switch (security messages are locked on).
      await expect(page.locator('[data-nt-toggle="parcel.delivery_code|sms"]')).toBeDisabled();
      const toggle = page.locator('[data-nt-toggle="parcel.booked|email"]');
      await toggle.uncheck();
      await expect(toast(page)).toContainText("switched off");
      expect((await api(page, "/notifications/events")).body.events.find((e: any) => e.event === "parcel.booked").channels.email.enabledByAdmin).toBe(false);
      await page.locator('[data-nt-toggle="parcel.booked|email"]').check();
      await expect(toast(page)).toContainText("switched on");
    } finally {
      await api(page, "/notifications/templates/parcel.booked/sms/reset", "POST");
      await api(page, "/notifications/templates/parcel.booked/email", "PUT", { enabled: before.channels.email.enabledByAdmin });
    }
  });

  test("lists the messages by group (Global notifications in tabs, Parcel notifications on their own) with search, channel and state filters", async () => {
    const catalog = (await api(page, "/notifications/events")).body;
    const events = catalog.events as any[];
    expect(events.length).toBeGreaterThanOrEqual(45);
    expect(catalog.groups).toEqual(["Parcel", "Merchant", "Finance", "Support", "Account & security", "Operations", "Rider", "Partner"]);
    // Customise one message so the badge and the "Customised" filter have something to show.
    const original = events.find(e => e.event === "parcel.changed_to_drop_off");
    expect(original).toBeTruthy();
    await api(page, "/notifications/templates/parcel.changed_to_drop_off/sms", "PUT", { body: "{{trackingId}}: bring it to {{hub}}. Tk {{charge}}." });
    try {
      // Global notifications: every group but Parcel, one tab each with its count.
      await nav(page, "Integrations");
      await nav(page, "Platform settings");
      const table = page.locator("#notificationEventsTable");
      const rows = table.locator("tr[data-nt-event]");
      const others = catalog.groups.filter((g: string) => g !== "Parcel");
      const count = (group: string) => events.filter(e => e.group === group).length;
      await expect(page.locator("[data-nt-tab]")).toHaveCount(others.length);
      await expect(page.locator('[data-nt-tab="Parcel"]')).toHaveCount(0);
      for (const group of others) await expect(page.locator(`[data-nt-tab="${group}"]`)).toContainText(String(count(group)));
      await expect(rows).toHaveCount(count(others[0]));
      await page.click('[data-nt-tab="Account & security"]');
      await expect(rows).toHaveCount(count("Account & security"));
      await expect(page.locator("#ntShowing")).toHaveText(`Showing all ${count("Account & security")} messages`);

      // Audience and channels at a glance; security messages are marked and locked on.
      const otp = table.locator('tr[data-nt-event="auth.otp.login"]');
      await expect(otp).toContainText("Any user");
      await expect(otp).toContainText("auth.otp.login · SMS");
      await expect(otp).toContainText("Security · always sent");
      await expect(otp.locator('[data-nt-toggle="auth.otp.login|sms"]')).toBeDisabled();

      // Security texts stay editable: preview the sign-in code with its required placeholder.
      await otp.locator('[data-nt-edit="auth.otp.login|sms"]').click();
      const editor = page.locator("#notificationTemplateEditor");
      await expect(editor).toContainText("Sign-in code · SMS");
      await expect(editor).toContainText("must include {{code}}");
      await editor.locator("[data-nt-preview]").click();
      await expect(editor.locator("#ntPreview")).toContainText("482913 is your Delivery Fast sign-in code");
      await editor.locator("[data-nt-close]").click();

      // Parcel notifications: the Parcel group only, with the same filters.
      await nav(page, "Parcel notifications");
      await expect(rows).toHaveCount(count("Parcel"));
      await expect(page.locator("[data-nt-tab]")).toHaveCount(0);
      await expect(page.locator("#ntShowing")).toHaveText(`Showing all ${count("Parcel")} messages`);
      const drop = table.locator('tr[data-nt-event="parcel.changed_to_drop_off"]');
      await expect(drop).toContainText("Changed to hub drop-off");
      await expect(drop).toContainText("SMS + Email");
      await expect(drop.locator('[data-nt-badge="customised"]')).toBeVisible();

      // Hovering a message name shows its current texts; leaving hides them.
      const card = page.locator("#ntTemplateCard");
      await drop.locator("[data-nt-hover]").hover();
      await expect(card).toBeVisible();
      await expect(card).toContainText("Changed to hub drop-off");
      await expect(card).toContainText("{{trackingId}}: bring it to {{hub}}. Tk {{charge}}.");
      await expect(card).toContainText("Customised");
      await expect(card).toContainText("Subject:");
      await page.locator("#ntShowing").hover();
      await expect(card).toBeHidden();

      // Search across name, key and audience.
      await page.fill("#ntSearch", "drop-off");
      await expect(drop).toBeVisible();
      await expect(table.locator('tr[data-nt-event="parcel.drop_off_booked"]')).toBeVisible();
      await expect(table.locator('tr[data-nt-event="parcel.booked"]')).toBeHidden();
      await expect(page.locator("#ntShowing")).toContainText(`of ${count("Parcel")} messages`);
      await page.fill("#ntSearch", "");

      // State filters.
      await page.selectOption("#ntStateFilter", "customised");
      await expect(drop).toBeVisible();
      await expect(table.locator('tr[data-nt-event="parcel.booked"]')).toBeHidden();
      await page.selectOption("#ntStateFilter", "security");
      await expect(table.locator('tr[data-nt-event="parcel.delivery_code"]')).toBeVisible();
      await expect(drop).toBeHidden();
      await page.selectOption("#ntStateFilter", "");
      await expect(page.locator("#ntShowing")).toHaveText(`Showing all ${count("Parcel")} messages`);

      // Channel filter on Global notifications: email-only list hides SMS-only codes.
      await nav(page, "Platform settings");
      await page.click('[data-nt-tab="Account & security"]');
      await page.selectOption("#ntChannelFilter", "email");
      await expect(otp).toBeHidden();
      await page.selectOption("#ntChannelFilter", "");
      await expect(otp).toBeVisible();
    } finally {
      await api(page, "/notifications/templates/parcel.changed_to_drop_off/sms/reset", "POST");
    }
  });

  test("validates and saves SMS limits (SMS & Email Integrations › Channels & limits)", async () => {
    await nav(page, "Integrations");
    await page.click('[data-int-tab="settings"]');
    const form = page.locator("#notificationLimitsForm");
    const perHour = await form.locator("#ntPerHour").inputValue();
    const perDay = form.locator("#ntPerDay");
    const original = await perDay.inputValue();
    await perDay.fill(String(Number(perHour) - 1));
    await perDay.blur();
    await expect(form).toContainText("Can't be lower than the hourly limit");
    await perDay.fill(original);
    const saved = page.waitForResponse(r => r.url().endsWith("/api/v1/notifications/settings") && r.request().method() === "PUT");
    await form.locator('button[type="submit"]').click();
    expect((await saved).ok()).toBe(true);
    await expect(toast(page)).toContainText("Notification limits saved");
  });

  test("shows real gateway status cards on Integrations", async () => {
    // Tabs: Channels & limits (first) · Recent messages · Gateway Settings.
    await nav(page, "Integrations");
    await expect(page.locator("[data-int-tab]")).toHaveText(["Channels & limits", "Recent messages", "Gateway Settings"]);
    await expect(page.locator("#sysChannelsForm")).toBeVisible();
    await page.click('[data-int-tab="messages"]');
    await expect(page.locator("#outboxTable")).toBeVisible();
    await page.click('[data-int-tab="gateways"]');
    const sms = page.locator('[data-gateway="SMS"]');
    const email = page.locator('[data-gateway="EMAIL"]');
    await expect(sms).toContainText("SMS gateway · mram");
    await expect(email).toContainText("Email gateway · Mailjet");
    await expect(page.locator('[data-gateway-metric="SMS"] .metric-value')).toHaveText(/Live|Log only|Disabled|Not configured/);
    // The decorative sample integrations are gone.
    await expect(page.locator("#mainContent")).not.toContainText("Shopify connector");
    // Keys are write-only: the field is always empty.
    await expect(sms.locator("#gwSmsKey")).toHaveValue("");
    await expect(email.locator("#gwMailSecret")).toHaveAttribute("type", "password");
    // Test SMS number: fixed +880 prefix and inline validation (nothing is sent).
    const phone = sms.locator("#gwTestPhone");
    await phone.fill("12345");
    await phone.blur();
    await expect(sms).toContainText("Enter the 10 digits after +880");
  });
});
