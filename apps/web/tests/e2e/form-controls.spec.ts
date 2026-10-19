import { type Browser, type Page } from "@playwright/test";
import { authenticator } from "otplib";
import { Fixtures, apiUrl, expect, opsNav, sql, test, type TempMerchant, type TempUser } from "./support";

/**
 * Shared form controls in every panel (owner request 2026-10-18 #5) and merchant invitations (#4):
 *   - searchable selects (shared/select-search.js, DF.searchSelect): Courier Operations booking
 *     (district → zone), super admin (price simulator district) and the e-commerce merchant order
 *     form: typing filters, Enter picks, the native select's value and change event follow;
 *   - "Choose file" controls (shared/file-input.js, DF.fileInput): the import dialog and the
 *     merchant KYC upload: choose by click, name and size shown, clear (×), drag and drop;
 *   - "Invite a merchant": exactly two types (E-commerce, Banking & Financial); the API refuses others.
 * Every account is temporary (support.ts) and deleted afterwards; so is the test invitation.
 */

const fx = new Fixtures();
const WEB = { "x-df-client": "web" };
const INVITE_NAME = `E2E Invite ${fx.stamp}`;
let shop: TempMerchant;
let owner: TempUser;
let ops: TempUser;
let admin: TempUser;
test.beforeAll(async () => {
  shop = await fx.merchant({ type: "ECOMMERCE", label: "Controls Shop" });
  // Not yet verified, so the KYC dialog offers uploads.
  await sql(`UPDATE merchants SET "kycStatus" = 'NOT_SUBMITTED' WHERE id = $1`, [shop.id]);
  owner = await fx.member(shop, "MERCHANT_OWNER");
  ops = await fx.staff("OPS_MANAGER");
  admin = await fx.user(`E2E Controls Admin ${fx.stamp}`, [{ role: "SUPER_ADMIN" }]);
});
test.afterAll(async () => {
  await sql(`DELETE FROM merchant_invites WHERE name = $1`, [INVITE_NAME]);
  await fx.cleanup();
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function open(browser: Browser, errors: string[], viewport?: { width: number; height: number }) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/status of (401|404|409|422)|Failed to load resource|tile\.openstreetmap/.test(message.text())) errors.push(message.text());
  });
  return page;
}

/** Signs in through the API (sets the refresh cookie) and opens the panel. */
async function signIn(page: Page, user: TempUser, path: string) {
  const login = await page.request.post(apiUrl("/api/v1/auth/login"), { headers: WEB, data: { identifier: user.login, password: user.password } });
  expect(login.ok(), await login.text()).toBeTruthy();
  await page.goto(path);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
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

/** Records the change events that reach window (what page scripts and bridges listen to). */
async function watchChanges(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __changes: string[]; __watching?: boolean };
    w.__changes = [];
    if (w.__watching) return;
    w.__watching = true;
    window.addEventListener("change", event => w.__changes.push((event.target as HTMLElement).id), true);
  });
}
const changes = (page: Page) => page.evaluate(() => (window as unknown as { __changes: string[] }).__changes);

/** Opens a searchable select by clicking it, types, checks the list narrowed, presses Enter. */
async function searchPick(page: Page, selector: string, query: string, expected: string) {
  await watchChanges(page);
  const select = page.locator(selector);
  const total = await select.locator("option").count();
  await select.click();
  const pop = page.locator(".df-ss-pop");
  await expect(pop).toBeVisible();
  await expect(select).toHaveAttribute("data-df-ss", "");
  await expect(select).toHaveAttribute("aria-haspopup", "listbox");
  const box = pop.locator('[role="combobox"]');
  await expect(box).toBeFocused();
  await expect(select).toHaveAttribute("aria-expanded", "true");
  await expect(pop.locator('[role="listbox"]')).toBeVisible();
  await page.keyboard.type(query);
  const shown = pop.locator('[role="option"]');
  await expect(shown.first()).toContainText(expected);
  expect(await shown.count()).toBeLessThan(total);
  await expect(box).toHaveAttribute("aria-activedescendant", /df-ss-/);
  await page.keyboard.press("Enter");
  await expect(pop).toHaveCount(0);
  await expect(select.locator("option:checked")).toContainText(expected);
  await expect(select).toHaveAttribute("aria-expanded", "false");
  const id = await select.getAttribute("id");
  if (id) expect(await changes(page)).toContain(id);
}

test("searchable selects: Courier Operations booking (district → zone), keyboard and phone width", async ({ browser }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  const page = await open(browser, errors);
  await signIn(page, ops, "/courier-operation");
  await opsNav(page, "ecommerce");
  await page.click('[data-action="newEcommerce"]');
  await expect(page.locator("#modalTitle")).toHaveText("Create e-commerce order");

  await searchPick(page, "#bkDistrict", "dhaka cen", "Dhaka Central");
  await expect(page.locator("#bkDistrict")).toHaveValue("Dhaka Central");
  // The zones are refilled for the district: the popup lists the new options.
  await expect(page.locator("#bkZone option", { hasText: "Dhanmondi" })).toHaveCount(1);
  await searchPick(page, "#bkZone", "dhanm", "Dhanmondi");
  await expect(page.locator("#bkZone")).toHaveValue("Dhanmondi");

  // Keyboard: typing on the focused select opens the search with that letter; ↓ / Esc.
  await page.locator("#bkDistrict").focus();
  await page.keyboard.press("c");
  const pop = page.locator(".df-ss-pop");
  await expect(pop.locator('[role="combobox"]')).toHaveValue("c");
  await page.keyboard.type("hatt");
  await expect(pop.locator('[role="option"]').first()).toContainText("Chattogram");
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  await expect(page.locator("#bkDistrict")).toHaveValue("Dhaka Central"); // Esc changes nothing
  await expect(page.locator("#modalBackdrop")).toHaveClass(/open/); // and keeps the dialog open
  await expect(page.locator("#bkDistrict")).toBeFocused();
  // No match: a message, Enter does nothing.
  await page.keyboard.press("Enter");
  await page.keyboard.type("zzzz");
  await expect(pop.locator(".df-ss-empty")).toContainText("No matches");
  await page.keyboard.press("Enter");
  await expect(page.locator("#bkDistrict")).toHaveValue("Dhaka Central");
  await page.keyboard.press("Escape");
  // Playwright's selectOption (the native select) still works.
  await page.selectOption("#bkDistrict", "Dhaka North");
  await expect(page.locator("#bkDistrict")).toHaveValue("Dhaka North");
  expect(errors).toEqual([]);
  await page.context().close();
});

test("searchable selects fit a 390 px phone", async ({ browser }) => {
  const errors: string[] = [];
  const page = await open(browser, errors, { width: 390, height: 844 });
  await signIn(page, ops, "/courier-operation");
  await page.evaluate(() => (window as unknown as { DFOps: { modals: Record<string, () => void> } }).DFOps.modals.newEcommerce());
  await page.locator("#bkDistrict").click();
  const pop = page.locator(".df-ss-pop");
  await expect(pop).toBeVisible();
  const box = (await pop.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(391);
  await page.screenshot({ path: "test-results-ui/select-search-390.png" });
  await page.keyboard.type("dhaka n");
  await page.keyboard.press("Enter");
  await expect(page.locator("#bkDistrict")).toHaveValue("Dhaka North");
  expect(errors).toEqual([]);
  await page.context().close();
});

test("searchable selects: super admin price simulator and the merchant order form", async ({ browser }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  const page = await open(browser, errors);
  await signInAdmin(page);
  await page.click('#navigation [data-page="Service plans"]');
  await page.click('[data-pkg-segment="ECOMMERCE"]');
  await expect(page.locator("#simDeliveryDistrict")).toBeVisible({ timeout: 20_000 });
  await searchPick(page, "#simDeliveryDistrict", "dhaka cen", "Dhaka Central");
  await expect(page.locator("#simDeliveryDistrict")).toHaveValue("Dhaka Central");
  await page.screenshot({ path: "test-results-ui/super-admin-simulator.png" });
  await page.context().close();

  const merchant = await open(browser, errors);
  await signIn(merchant, owner, "/ecommerce-merchant");
  await merchant.click('#navigation [data-page="Orders"]');
  await merchant.click("#createOrder");
  await expect(merchant.locator("#orderModal")).toHaveClass(/open/);
  await searchPick(merchant, "#merchantDistrict", "dhaka cen", "Dhaka Central");
  await expect(merchant.locator("#merchantDistrict")).toHaveValue("Dhaka Central");
  await expect(merchant.locator("#merchantZone option", { hasText: "Dhanmondi" })).toHaveCount(1);
  await merchant.screenshot({ path: "test-results-ui/merchant-order-form.png" });
  expect(errors).toEqual([]);
  await merchant.context().close();
});

test("searchable selects in the website's React forms (the request wizard)", async ({ browser }) => {
  const errors: string[] = [];
  const page = await open(browser, errors);
  await page.goto("/request");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await searchPick(page, "#requestPickupDistrict", "dhaka nor", "Dhaka North");
  await expect(page.locator("#requestPickupDistrict")).toHaveValue("Dhaka North");
  // React saw the change: the zones of that district are offered.
  await expect(page.locator("#requestPickupZone option", { hasText: "Gulshan" })).toHaveCount(1);
  expect(errors).toEqual([]);
  await page.context().close();
});

test("file inputs: the import dialog (click, name, clear, drag and drop) and the KYC upload", async ({ browser }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  const page = await open(browser, errors);
  await signIn(page, owner, "/ecommerce-merchant");
  await page.click('#navigation [data-page="Orders"]');
  await page.click("#merchantBulkImport");
  const control = page.locator("#dfiDrop .df-file");
  await expect(control).toBeVisible();
  await expect(control).toHaveClass(/df-file--drop/);
  await expect(control.locator(".df-file-hint")).toContainText(/Excel \.xlsx or \.csv, up to \d+(\.\d+)? MB/);
  await expect(control.locator(".df-file-clear")).toBeHidden();

  // Choose by clicking the button (the native input stays inside the control).
  const chooser = page.waitForEvent("filechooser");
  await control.locator(".df-file-btn").click();
  await (await chooser).setFiles({ name: "orders-click.csv", mimeType: "text/csv", buffer: Buffer.from("customer_name,phone\r\nA,01812000001\r\n") });
  await expect(page.locator("#dfiDrop .df-file-name")).toContainText("orders-click.csv");
  await expect(page.locator("#dfiDrop .df-file-name")).toContainText("KB");
  await expect(page.locator('[data-dfi="check"]')).toBeEnabled();
  await page.screenshot({ path: "test-results-ui/import-file-chosen.png" });

  // Clear (×): back to no file, "Check file" disabled again.
  await page.locator("#dfiDrop .df-file-clear").click();
  await expect(page.locator("#dfiDrop .df-file-name")).toContainText("Drop a file here");
  await expect(page.locator('[data-dfi="check"]')).toBeDisabled();
  expect(await page.locator("#dfiFile").evaluate(i => (i as HTMLInputElement).files?.length ?? 0)).toBe(0);

  // Drag and drop a file onto the control.
  await page.locator("#dfiDrop .df-file").evaluate(el => {
    const dt = new DataTransfer();
    dt.items.add(new File(["customer_name,phone\r\nB,01812000002\r\n"], "orders-dropped.csv", { type: "text/csv" }));
    for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await expect(page.locator("#dfiDrop .df-file-name")).toContainText("orders-dropped.csv");
  await expect(page.locator('[data-dfi="check"]')).toBeEnabled();
  // A dropped file of the wrong type is refused with a message.
  await page.locator("#dfiDrop .df-file").evaluate(el => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "photo.png", { type: "image/png" }));
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await expect(page.locator("#dfiDrop .df-file-hint")).toContainText("photo.png isn't accepted here");
  await page.click('[data-dfi="close"]');

  // ── KYC: Settings → Business verification → upload form ──
  await page.click('#navigation [data-page="Settings"]');
  await page.locator("#tableBody tr", { hasText: "Business verification" }).locator("button").click();
  const form = page.locator("#dffKycForm");
  await expect(form).toBeVisible();
  const kyc = form.locator(".df-file");
  await expect(kyc.locator(".df-file-hint")).toContainText("PNG, JPEG, WebP or PDF, up to 3.5 MB");
  // "Upload" in a row picks that document type and opens the picker.
  const firstType = await page.locator("[data-dff-kyc-pick]").first().getAttribute("data-dff-kyc-pick");
  const kycChooser = page.waitForEvent("filechooser");
  await page.locator("[data-dff-kyc-pick]").first().click();
  await (await kycChooser).setFiles({ name: "trade-license.png", mimeType: "image/png", buffer: PNG });
  await expect(page.locator("#dffKycType")).toHaveValue(firstType!);
  await expect(kyc.locator(".df-file-name")).toContainText("trade-license.png");
  await kyc.locator(".df-file-clear").click();
  await expect(kyc.locator(".df-file-name")).toContainText("Drop a file here");
  await page.screenshot({ path: "test-results-ui/kyc-upload.png" });
  // Choose again and upload.
  await page.setInputFiles("#dffKycFile", { name: "trade-license.png", mimeType: "image/png", buffer: PNG });
  await expect(kyc.locator(".df-file-name")).toContainText("trade-license.png");
  await page.click("#dffKycUpload");
  await expect(page.locator("#toast")).toContainText("trade-license.png uploaded.");
  await expect(page.locator("#dfDialogBody")).toContainText("trade-license.png");
  expect(errors).toEqual([]);
  await page.context().close();
});

test("invite a merchant: exactly E-commerce and Banking & Financial; the API refuses other types", async ({ browser }) => {
  const errors: string[] = [];
  const page = await open(browser, errors);
  await signInAdmin(page);
  await page.click('#navigation [data-page="Banking & Financial merchants"]');
  await page.click('[data-action="inviteMerchant"]');
  await expect(page.locator("#modalTitle")).toHaveText("Invite a merchant");
  const type = page.locator("#inviteType");
  await expect(type.locator("option")).toHaveCount(2);
  expect(await type.locator("option").evaluateAll(o => o.map(x => [(x as HTMLOptionElement).value, x.textContent]))).toEqual([
    ["ECOMMERCE", "E-commerce"],
    ["BANKING_FINANCIAL", "Banking & Financial"],
  ]);
  await expect(type).toHaveValue("BANKING_FINANCIAL"); // opened from the Banking & Financial directory
  await expect(page.locator("#modalFields")).not.toContainText(/customer|domestic|parcel/i);
  await page.screenshot({ path: "test-results-ui/invite-modal.png" });

  // Sent as Banking & Financial: the invitation carries the type and the link opens the application.
  await page.fill("#inviteBusiness", `E2E Invite Bank ${fx.stamp}`);
  await page.fill("#inviteOwner", INVITE_NAME);
  await page.fill("#inviteEmail", `e2e-invite-${fx.stamp.toLowerCase()}@example.com`);
  await page.click("#modalSubmit");
  await expect(page.locator("#dfmInviteLink")).toContainText("/merchant?invite=");
  const [row] = await sql<{ type: string }>(`SELECT type FROM merchant_invites WHERE name = $1`, [INVITE_NAME]);
  expect(row.type).toBe("BANKING_FINANCIAL");
  const link = (await page.locator("#dfmInviteLink").textContent())!.trim();

  // The API refuses any other type (and a missing one).
  const refused = await page.evaluate(async () => {
    const DF = (window as unknown as { DF: { api: (path: string, o: object) => Promise<unknown> } }).DF;
    const out: string[] = [];
    for (const type of ["CUSTOMER", "PARCEL", undefined]) {
      try {
        await DF.api("/merchants/invites", { method: "POST", body: { name: "Refused Type", email: "refused-type@example.com", type } });
        out.push("accepted");
      } catch (error) {
        out.push((error as { code: string }).code);
      }
    }
    return out;
  });
  expect(refused).toEqual(["VALIDATION_FAILED", "VALIDATION_FAILED", "VALIDATION_FAILED"]);
  await page.context().close();

  // The website application opened from the link has the invited type, fixed.
  const visitor = await open(browser, errors);
  await visitor.goto(new URL(link).pathname + new URL(link).search);
  await visitor.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(visitor.locator("#merchantAccountType")).toHaveValue("Banking & Financial merchant", { timeout: 15_000 });
  await expect(visitor.locator("#merchantAccountType")).toBeDisabled();
  await expect(visitor.locator("#partnerName")).toHaveValue(`E2E Invite Bank ${fx.stamp}`);
  expect(errors).toEqual([]);
  await visitor.context().close();
});
