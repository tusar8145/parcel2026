import { type Browser, type Page } from "@playwright/test";
import { DEMO_PASSWORD as PASSWORD, Fixtures, expect, test } from "./support";

/**
 * Support tickets across the website, Courier Operations and the rider app, partner applications,
 * and the customer's orders/addresses pages, through the real UI against the running stack.
 * Operations uses the seeded staff account; the rider is temporary, and the customers, the
 * merchant application and the tickets created here are deleted afterwards (support.ts).
 */
const OPS = "ops@deliveryfast.example";

const fx = new Fixtures();
test.afterAll(() => fx.cleanup());
// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const freshPhone = () => `019${String(Date.now()).slice(-8)}`;

type Df = { DF: { api: (path: string, options?: Record<string, unknown>) => Promise<any>; parcels: { reload: () => Promise<boolean> } } };

/** Opens a page and records script errors (the API's 401 for a missing session is expected, not an error). */
async function open(browser: Browser, path: string) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(`console: ${message.text()}`);
  });
  page.on("dialog", dialog => dialog.accept());
  await page.goto(path);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return Object.assign(page, { errors });
}

async function signIn(page: Page, identifier: string, password = PASSWORD) {
  await page.goto("/login");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.fill("#loginIdentity", identifier);
  await page.fill("#loginPassword", password);
  await page.click('form[data-form="login"] button[type="submit"]');
}

/** Fills the sign-up form on the current page and verifies the SMS code. */
async function completeSignup(page: Page, name: string, phone = freshPhone()) {
  await page.fill("#signupName", name);
  await page.fill("#signupPhone", phone);
  await page.fill("#signupEmail", `e2e-${unique()}@example.com`);
  await page.fill("#signupPassword", "E2ePassword2026");
  await page.click('form[data-form="signup"] button[type="submit"]');
  const hint = page.locator("#signupOtp + small");
  await expect(hint).toContainText("Development code:");
  await page.fill("#signupOtp", (await hint.textContent())!.match(/\d{6}/)![0]);
  await page.click('form[data-form="signup"] button[type="submit"]');
  return phone;
}

async function opsPanel(browser: Browser) {
  const ops = await open(browser, "/login");
  await signIn(ops, OPS);
  await expect(ops).toHaveURL(/\/courier-operation/);
  await ops.waitForSelector("html.legacy-ready", { state: "attached" });
  return ops;
}

const toast = (page: Page) => page.locator("#toast");
const api = (page: Page, path: string) => page.evaluate(p => (window as unknown as Df).DF.api(p), path);

test("customer ticket with attachment, answered from the operations inbox; orders and addresses on real data", async ({ browser }) => {
  const id = unique();
  const customer = await open(browser, "/signup");
  const customerPhone = await completeSignup(customer, `Support Customer ${id}`);
  await expect(customer).toHaveURL(/\/account$/);
  await fx.adoptUser(customerPhone);

  // ── A booking shows up on the orders, overview and addresses pages ──
  const street = `House ${id}, Road 2`;
  const parcel = await customer.evaluate(async street => {
    const { DF } = window as unknown as Df;
    return DF.api("/parcels", {
      method: "POST",
      body: {
        sender: { name: "Support Customer", phone: "01912000000" },
        pickup: { category: "Home", street, zone: "Gulshan", district: "Dhaka North" },
        recipient: { name: "Nabila Ahmed", phone: "01812000000" },
        delivery: { category: "Office", street: "Road 7, Flat 3B", zone: "Dhanmondi", district: "Dhaka Central" },
        serviceLevel: "Regular",
        weightKg: 1,
      },
    });
  }, street);
  const trackingId: string = parcel.trackingId;
  await customer.goto("/account/orders");
  const view = customer.locator("#pageView");
  await expect(view.locator("tr", { hasText: trackingId })).toContainText("Pending operations confirmation");
  await expect(view).not.toContainText("PP-260914-1042"); // no demo shipments
  await customer.goto("/account");
  await expect(view).toContainText("1 parcels · 1 active");
  await expect(view.locator("tr", { hasText: trackingId })).toBeVisible();
  await customer.goto("/account/addresses");
  await expect(view).toContainText(street);
  await expect(view).toContainText("Road 7, Flat 3B");

  // ── The customer opens a ticket about the parcel, with an attachment ──
  await customer.goto(`/support/${trackingId}`);
  const composer = customer.locator(".st-composer");
  await expect(composer.locator('input[name="relatedRef"]')).toHaveValue(trackingId);
  const subject = `Parcel question ${id}`;
  await composer.locator('input[name="subject"]').fill(subject);
  await composer.locator('textarea[name="message"]').fill(`Where is my parcel? ${id}`);
  await composer.locator('input[name="attachments"]').setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: PNG });
  await composer.locator('button[type="submit"]').click();
  await expect(toast(customer)).toContainText(/DF-SUP-\d{6}-\d{4} created/);
  const number = (await toast(customer).textContent())!.match(/DF-SUP-\d{6}-\d{4}/)![0];
  await expect(customer).toHaveURL(new RegExp(`/support/${number}$`));
  const thread = customer.locator(".st-thread");
  await expect(thread).toContainText(`Where is my parcel? ${id}`);
  await expect(thread.locator(".st-attachment")).toHaveText("receipt.png");

  // ── Operations answers from the inbox ──
  const ops = await opsPanel(browser);
  await ops.click('#navigation [data-page="Support"]');
  await ops.click(`[data-support-open="${number}"]`);
  const opsThread = ops.locator(".st-thread");
  await expect(opsThread).toContainText(subject);
  await expect(opsThread).toContainText(`Where is my parcel? ${id}`);
  const [download] = await Promise.all([ops.waitForEvent("download"), opsThread.locator(".st-attachment", { hasText: "receipt.png" }).click()]);
  expect(download.suggestedFilename()).toBe("receipt.png");

  await ops.fill("#supportReply", `Internal: check the Gulshan hub ${id}`);
  await ops.check('.st-reply input[name="internal"]');
  await ops.click('.st-reply button[type="submit"]');
  await expect(toast(ops)).toContainText("Internal note added.");
  await expect(opsThread.locator(".st-message.internal")).toContainText(`check the Gulshan hub ${id}`);

  await ops.fill("#supportReply", `Your parcel is with our rider ${id}`);
  await ops.click('.st-reply button[type="submit"]');
  await expect(toast(ops)).toContainText("Reply added to the support conversation.");
  await expect(opsThread.locator(".st-thread-head .st-badge")).toHaveText("Waiting for requester");

  const assignee = ops.locator(`[data-support-assignee="${number}"]`);
  await assignee.selectOption({ label: await assignee.locator("option", { hasText: "(me)" }).first().innerText() });
  await expect(toast(ops)).toContainText(`${number} assigned to`);
  await ops.selectOption(`[data-support-priority="${number}"]`, "HIGH");
  await expect(toast(ops)).toContainText(`${number} priority set to High`);

  // ── The customer sees the reply without reloading (polling), but not the internal note ──
  await expect(thread).toContainText(`Your parcel is with our rider ${id}`, { timeout: 40_000 });
  await expect(thread.locator(".st-thread-head .st-badge")).toHaveText("Waiting for requester");
  await expect(thread).not.toContainText("check the Gulshan hub");
  // …and replies again, which reopens the ticket.
  await customer.fill("#supportReply", `Thanks! ${id}`);
  await customer.click('.st-reply button[type="submit"]');
  await expect(toast(customer)).toContainText("Reply added");
  await expect(thread.locator(".st-thread-head .st-badge")).toHaveText("Open");

  expect(customer.errors).toEqual([]);
  expect(ops.errors).toEqual([]);
});

test("a rider's dispatch callback request becomes a support ticket", async ({ browser }) => {
  const id = unique();
  const account = await fx.rider("Gulshan Sorting Hub");
  const rider = await open(browser, "/login");
  await signIn(rider, account.login, account.password);
  await expect(rider).toHaveURL(/\/rider/);
  await rider.waitForSelector("html.legacy-ready", { state: "attached" });
  await rider.click('#navigation [data-page="Help & safety"]');
  await rider.click('button[data-support-mode="call"]');
  await expect(rider.locator("#modalFields")).toContainText("This creates a support ticket.");
  await rider.selectOption("#supportTopic", "Rider safety");
  await rider.fill("#supportMessage", `Flat tyre near Gulshan 2 ${id}`);
  await rider.click("#submitAction");
  await expect(toast(rider)).toContainText(/DF-SUP-\d{6}-\d{4} created · Callback requested/);
  const number = (await toast(rider).textContent())!.match(/DF-SUP-\d{6}-\d{4}/)![0];
  // Listed under "My support requests" on Help & safety.
  const requests = rider.locator(".panel", { hasText: "My support requests" });
  await expect(requests).toContainText(number);
  await expect(requests).toContainText("Rider or safety");
  await expect(requests).toContainText("Phone callback");

  const ops = await opsPanel(browser);
  await ops.click('#navigation [data-page="Support"]');
  const card = ops.locator(`[data-support-open="${number}"]`);
  await expect(card).toContainText("Dispatch callback request · Rider safety");
  await card.click();
  await expect(ops.locator(".st-thread")).toContainText(`Flat tyre near Gulshan 2 ${id}`);
  const ticket = await api(ops, `/support/tickets/${number}`);
  expect(ticket).toMatchObject({ category: "Rider or safety", priority: "HIGH", requester: { name: account.name } });

  expect(rider.errors).toEqual([]);
  expect(ops.errors).toEqual([]);
});

test("partner applications: a visitor signs up, returns to the form, and staff see the applications", async ({ browser }) => {
  const id = unique();
  const business = `E2E Shop ${id}`;
  const visitor = await open(browser, "/merchant");
  await visitor.selectOption("#merchantAccountType", "E-commerce merchant");
  await visitor.fill("#partnerName", business);
  await visitor.fill("#partnerContact", `Owner ${id}`);
  await visitor.fill("#partnerEmail", `shop-${id}@example.com`);
  const phone = freshPhone();
  await visitor.fill("#partnerPhone", phone);
  await visitor.selectOption("#partnerArea", "Dhaka");
  await visitor.fill("#partnerPickupAddress", "House 12, Road 7, Gulshan 1");
  await visitor.fill("#partnerPickupArea", "Gulshan");
  await visitor.click('form[data-form="merchant"] button[type="submit"]');

  // Signed out: asked to sign in first, then brought back to the form with what they typed.
  await expect(visitor).toHaveURL(/\/login$/);
  await expect(toast(visitor)).toContainText("sign in or create an account to send your application");
  await visitor.click('form[data-form="login"] a[data-route="signup"]');
  await completeSignup(visitor, `Owner ${id}`, phone);
  await expect(visitor).toHaveURL(/\/merchant$/);
  await fx.adoptUser(phone);
  await expect(visitor.locator("#partnerName")).toHaveValue(business);
  await expect(visitor.locator("#partnerEmail")).toHaveValue(`shop-${id}@example.com`);
  await expect(visitor.locator("#partnerPickupArea")).toHaveValue("Gulshan");
  await visitor.click('form[data-form="merchant"] button[type="submit"]');
  await expect(visitor).toHaveURL(/\/application-received$/);
  await fx.adoptMerchant(business);
  await expect(toast(visitor)).toContainText(/Your e-commerce merchant application MR-\d+ was received/);
  await expect(visitor.locator("#pageView .route-card")).toContainText(/Application received[\s\S]*merchant application MR-\d+ was received/);

  // A rider application from the same person, contact details prefilled.
  await visitor.goto("/become-a-rider");
  await expect(visitor.locator("#partnerName")).toHaveValue(`Owner ${id}`);
  await expect(visitor.locator("#partnerPhone")).toHaveValue(phone.replace(/^0/, "")); // the 10 digits after the fixed +880
  await visitor.selectOption("#partnerArea", "Dhaka North");
  await visitor.selectOption("#riderVehicle", "Bicycle");
  await visitor.click('form[data-form="rider"] button[type="submit"]');
  await expect(toast(visitor)).toContainText(/Your rider application DF-SUP-\d{6}-\d{4} was received/);
  const riderNumber = (await toast(visitor).textContent())!.match(/DF-SUP-\d{6}-\d{4}/)![0];

  // Staff see both.
  const ops = await opsPanel(browser);
  const merchants = await api(ops, `/merchants?status=PENDING_REVIEW&q=${encodeURIComponent(business)}`);
  // The search may also return similarly named merchants from earlier runs; this run's must be there once.
  const ours = merchants.items.filter((m: { name: string }) => m.name === business);
  expect(ours).toHaveLength(1);
  expect(ours[0]).toMatchObject({ name: business, type: "ECOMMERCE", status: "PENDING_REVIEW", pickupArea: "Gulshan", pickupDistrict: "Dhaka" });
  const applications = await api(ops, "/applications?kind=RIDER&limit=50");
  const application = applications.items.find((a: { number: string }) => a.number === riderNumber);
  expect(application).toMatchObject({ kind: "RIDER", status: "SUBMITTED", ticketStatus: "OPEN", details: { name: `Owner ${id}`, area: "Dhaka North", vehicle: "BICYCLE" } });
  await ops.click('#navigation [data-page="Support"]');
  await expect(ops.locator(`[data-support-open="${riderNumber}"]`)).toContainText("Rider application");

  // Staff review it on the ticket: the application panel moves it along and tells the applicant.
  await ops.click(`[data-support-open="${riderNumber}"]`);
  const panel = ops.locator(".st-application");
  await expect(panel).toContainText("Rider application · Submitted");
  ops.removeAllListeners("dialog"); // open() accepts every dialog empty; this prompt needs the message
  ops.once("dialog", dialog => dialog.accept("Please send a photo of your NID"));
  await panel.locator(`[data-application-status="INFO_REQUESTED"]`).click();
  await expect(panel).toContainText("Rider application · Information requested");
  await expect(ops.locator(".st-messages")).toContainText("Please send a photo of your NID");
  expect((await api(ops, `/applications/${riderNumber}`)).status).toBe("INFO_REQUESTED");

  expect(visitor.errors).toEqual([]);
  expect(ops.errors).toEqual([]);
});
