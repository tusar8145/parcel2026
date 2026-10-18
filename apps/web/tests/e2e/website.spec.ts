import { type Browser, type Page } from "@playwright/test";
import { Fixtures, confirmDialog, expect, test } from "./support";

/**
 * Public website: real URLs and SEO, legal pages and cookie consent, React forms with
 * inline validation, guest booking with a private tracking link, and email verification.
 * Needs the API (EXPOSE_DEV_OTP=true), web and a seeded database. The customer who signs up and
 * the guest booking are deleted afterwards (support.ts).
 */
const fx = new Fixtures();
test.afterAll(() => fx.cleanup());

async function open(browser: Browser, path: string, { consent = true } = {}) {
  // The config pre-sets the cookie choice; start empty to see the banner.
  const context = await browser.newContext(consent ? {} : { storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  page.on("dialog", dialog => dialog.accept());
  await page.goto(path);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return page;
}

const toast = (page: Page) => page.locator("#toast");
const uniquePhone = () => `018${String(Date.now()).slice(-8)}`;

test("real URLs: per-route metadata, old hash links redirect, back/forward works", async ({ browser, request }) => {
  const html = await (await request.get("/pricing", { headers: { "user-agent": "Googlebot/2.1" } })).text();
  expect(html).toContain("<title>Delivery Fast — A clear estimate, before you book</title>");
  expect(html).toMatch(/<link rel="canonical" href="[^"]*\/pricing"/);
  const tracking = await (await request.get("/track/PP-261015-ABCDE", { headers: { "user-agent": "Googlebot/2.1" } })).text();
  expect(tracking).toContain('<meta name="robots" content="noindex');
  expect(await (await request.get("/sitemap.xml")).text()).toContain("/pricing</loc>");
  expect(await (await request.get("/robots.txt")).text()).toContain("Disallow: /account");
  expect((await request.get("/no-such-page")).status()).toBe(404);

  const page = await open(browser, "/#/pricing");
  await expect(page).toHaveURL(/\/pricing$/);
  await expect(page.locator("#pageView .route-intro h1")).toContainText("A clear estimate");
  await page.click('.nav-links a[data-route="signup"]');
  await expect(page).toHaveURL(/\/signup$/);
  await expect(page.locator('form[data-form="signup"]')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/pricing$/);
  await expect(page.locator("#pageView .route-intro h1")).toContainText("A clear estimate");
});

test("legal pages and cookie consent", async ({ browser }) => {
  const page = await open(browser, "/privacy", { consent: false });
  await expect(page.locator("main[data-static-page] h1")).toHaveText("Privacy Policy");
  await expect(page.locator("main")).toContainText("Draft for legal review");
  await expect(page.locator(".df-cookie-consent")).toBeVisible();
  const beacon = page.waitForRequest(r => r.url().endsWith("/api/v1/analytics/pageview") && r.method() === "POST");
  await page.click('[data-cookie-choice="all"]');
  expect((await beacon).postDataJSON()).toMatchObject({ path: "/privacy" });
  await expect(page.locator(".df-cookie-consent")).toHaveCount(0);
  await page.click('footer a[href="/terms"]');
  await expect(page.locator("main[data-static-page] h1")).toHaveText("Terms of Service");
  await expect(page.locator(".df-cookie-consent")).toHaveCount(0); // the choice is remembered
});

test("sign-in and sign-up validate inline with the API's rules", async ({ browser }) => {
  const page = await open(browser, "/login");
  const form = page.locator('form[data-form="login"]');
  await form.locator('button[type="submit"]').click();
  await expect(form.locator("#loginIdentity-error")).toHaveText("Enter your email or mobile number");
  await page.fill("#loginIdentity", "1612");
  await page.locator("#loginIdentity").blur();
  await expect(form.locator("#loginIdentity-error")).toContainText("10 digits after +880");
  await page.fill("#loginIdentity", (await fx.staff("OPS_MANAGER")).login);
  await page.fill("#loginPassword", "WrongPassword1");
  await form.locator('button[type="submit"]').click();
  await expect(form.locator("#loginPassword-error")).not.toBeEmpty();

  await page.click('a[data-auth-flow="otp"]');
  await page.fill("#flowPhone", "01712");
  await page.locator("#flowPhone").blur();
  await expect(page.locator("#flowPhone-error")).toContainText("10 digits after +880");

  await page.goto("/signup");
  await page.waitForSelector('form[data-form="signup"]');
  await page.fill("#signupName", "E");
  await page.fill("#signupPhone", "017");
  await page.fill("#signupEmail", "not-an-email");
  await page.fill("#signupPassword", "short");
  await page.locator('form[data-form="signup"] button[type="submit"]').click();
  await expect(page.locator("#signupName-error")).toHaveText("Enter your full name");
  await expect(page.locator("#signupPhone-error")).toContainText("+880");
  await expect(page.locator("#signupEmail-error")).toHaveText("Enter a valid email address");
  await expect(page.locator("#signupPassword-error")).toHaveText("Use at least 10 characters");
  // People may type the leading 0: the field keeps the 10 digits after +880.
  await page.fill("#signupPhone", "01712345678");
  await expect(page.locator("#signupPhone")).toHaveValue("1712345678");
  await expect(page.locator("#signupPhone-error")).toHaveCount(0);
});

test("guest books with SMS verification, then tracks and cancels with the private link", async ({ browser }) => {
  const page = await open(browser, "/request");
  const form = page.locator('form[data-form="request"]');
  const phone = uniquePhone();
  await form.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#requestName-error")).toBeVisible();
  await page.fill("#requestName", "Guest Sender");
  await page.fill("#requestPhone", phone);
  await page.selectOption("#requestPickupDistrict", "Dhaka North");
  await page.selectOption("#requestPickupZone", "Gulshan");
  await page.fill("#requestPickup", "House 5, Road 2");
  await expect(page.locator('[data-pickup-slots] input[name="requestSlot"]:checked')).toHaveCount(1);
  await form.getByRole("button", { name: "Continue" }).click();
  await page.fill("#requestReceiver", "Nabila Ahmed");
  await page.fill("#requestReceiverPhone", "01812000000");
  await page.selectOption("#requestDistrict", "Dhaka Central");
  await page.selectOption("#requestZone", "Dhanmondi");
  await page.fill("#requestDelivery", "Road 7, Flat 3B");
  await form.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#requestPricePreview")).toContainText("Sender pays for delivery");
  await page.click("#requestSubmit"); // sends the code
  const hint = page.locator("[data-guest-verification] .field-hint").first();
  await expect(hint).toContainText("Development code:");
  await page.fill("#guestCode", (await hint.textContent())!.match(/\d{6}/)![0]);
  await page.click("#requestSubmit");

  await expect(page).toHaveURL(/\/track\/PP-\d{6}-[0-9A-Z]{5}\?t=o\./);
  await expect(page.locator("#trackingResult")).toContainText("Pending operations confirmation");
  await expect(page.locator("#trackingResult")).toContainText("+880 1812000000"); // full details with the link
  await expect(page.locator("[data-pickup-window]")).toBeVisible();

  // Without the link, the same parcel is masked.
  const trackingId = new URL(page.url()).pathname.split("/track/")[1];
  fx.adoptParcel(trackingId, phone);
  const stranger = await open(browser, `/track/${trackingId}`);
  await expect(stranger.locator("#trackingResult")).toContainText("Hidden for privacy");
  await expect(stranger.locator("[data-cancel-request]")).toHaveCount(0);

  await page.click("[data-cancel-request]");
  await confirmDialog(page, { title: `Cancel pickup request ${trackingId}?` });
  await expect(toast(page)).toContainText("cancelled");
  await expect(page.locator("#trackingResult")).toContainText(/cancelled/i);
});

test("tracking search validates the ID format", async ({ browser }) => {
  const page = await open(browser, "/track");
  await page.fill("#trackingInput", "hello");
  await page.click('#trackForm button[type="submit"]');
  await expect(page.locator("#trackingInput-error")).toContainText("PP-261015-7K3QF");
  await page.fill("#trackingInput", "PP-261015-ZZZZZ");
  await page.click('#trackForm button[type="submit"]');
  await expect(page).toHaveURL(/\/track\/PP-261015-ZZZZZ$/);
  await expect(page.locator("#trackingResult")).toContainText("We couldn't find that tracking number");
});

test("customer signs up, verifies email from the profile, and manages saved addresses", async ({ browser }) => {
  const page = await open(browser, "/signup");
  const phone = uniquePhone();
  await page.fill("#signupName", "Web Customer");
  await page.fill("#signupPhone", phone);
  await page.fill("#signupEmail", `web-${Date.now()}@example.com`);
  await page.fill("#signupPassword", "WebCustomer2026");
  await page.click('form[data-form="signup"] button[type="submit"]');
  const hint = page.locator("#signupOtp + small");
  await expect(hint).toContainText("Development code:");
  await expect(page.locator('form[data-form="signup"] .route-note')).toContainText(/new code in \d+ s/);
  await page.fill("#signupOtp", (await hint.textContent())!.match(/\d{6}/)![0]);
  await page.click('form[data-form="signup"] button[type="submit"]');
  await expect(page).toHaveURL(/\/account$/);
  await fx.adoptUser(phone);

  await page.goto("/account/profile");
  await page.waitForSelector('form[data-form="email-verification"]');
  await expect(page.locator("[data-email-status]")).toHaveAttribute("data-email-status", "unverified");
  await page.fill("#emailCode", "000000");
  await page.click('form[data-form="email-verification"] button[type="submit"]');
  await expect(page.locator("#emailCode-error")).toContainText("incorrect");

  await page.goto("/account/addresses");
  await page.click('[data-addresses] button:has-text("Add an address")');
  await page.click('form[data-form="address"] button[type="submit"]');
  await expect(page.locator("#addressName-error")).toBeVisible();
  await page.fill("#addressName", "Home Pickup");
  await page.fill("#addressPhone", phone);
  await page.selectOption("#addressDistrict", "Dhaka North");
  await page.selectOption("#addressZone", "Banani");
  await page.fill("#addressStreet", "Road 11, House 42");
  await page.click('form[data-form="address"] button[type="submit"]');
  const item = page.locator(".customer-address-item", { hasText: "Home Pickup" });
  await expect(item).toContainText("Road 11, House 42");
  await item.getByRole("button", { name: "Edit" }).click();
  await page.fill("#addressStreet", "Road 12, House 7");
  await page.click('form[data-form="address"] button[type="submit"]');
  await expect(page.locator(".customer-address-item", { hasText: "Home Pickup" })).toContainText("Road 12, House 7");
  await page.locator(".customer-address-item", { hasText: "Home Pickup" }).getByRole("button", { name: "Delete" }).click();
  await confirmDialog(page, { title: "Delete this saved address?" });
  await expect(page.locator(".customer-address-item", { hasText: "Home Pickup" })).toHaveCount(0);
});

test("staff signing in on the website form open their panel (role → panel)", async ({ browser }) => {
  // Merchant owners: merchant-panels.spec.ts; super admins with first-time MFA enrolment: super-admin.spec.ts.
  const ops = await fx.staff("OPS_MANAGER");
  const page = await open(browser, "/login");
  await page.fill("#loginIdentity", ops.login);
  await page.fill("#loginPassword", ops.password);
  await page.click('form[data-form="login"] button[type="submit"]');
  await expect(page).toHaveURL(/\/courier-operation/);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await expect(page).toHaveURL(/\/courier-operation/); // the panel accepts the session (no bounce to /login)
});

test("someone already signed in who opens Login or Sign up goes to their own panel", async ({ browser }) => {
  // Staff: back to the website's Login / Sign up → straight back to Courier Operations, no second sign-in.
  const ops = await fx.staff("OPS_MANAGER");
  const page = await open(browser, "/login");
  await page.fill("#loginIdentity", ops.login);
  await page.fill("#loginPassword", ops.password);
  await page.click('form[data-form="login"] button[type="submit"]');
  await expect(page).toHaveURL(/\/courier-operation/);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  for (const path of ["/login", "/signup"]) {
    await page.goto(path);
    await expect(page.locator('form[data-form="login"], form[data-form="signup"]')).toHaveCount(0);
    await expect(page).toHaveURL(/\/courier-operation/, { timeout: 15_000 });
  }

  // Customers land on their account; "sign out first" brings the login form back.
  const customer = await fx.user(`E2E Signed-in Customer ${fx.stamp}`, [{ role: "CUSTOMER" }]);
  const cpage = await open(browser, "/login");
  await cpage.fill("#loginIdentity", customer.login);
  await cpage.fill("#loginPassword", customer.password);
  await cpage.click('form[data-form="login"] button[type="submit"]');
  await expect(cpage).toHaveURL(/\/account/);
  await cpage.goto("/login");
  await expect(cpage).toHaveURL(/\/account/, { timeout: 15_000 });
  await cpage.goto("/signup");
  await expect(cpage).toHaveURL(/\/account/, { timeout: 15_000 });
});
