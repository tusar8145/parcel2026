import { type Browser, type Page } from "@playwright/test";
import { Fixtures, expect, opsNav, openPdf, sql, test, type TempMerchant, type TempUser } from "./support";

// Courier Operations desk tools (public/legacy/courier-operation/bridge-desk.js, bridge-parcel.js, bridge-finance.js):
// in-page dialogs instead of prompt() / confirm() (a finance flow with a review step), the parcel drawer's
// "Add a staff note" and message log (GET /parcels/:id/messages, codes masked), the zone → serving hub lookup
// in the top-bar search, the shared scan feedback, the Hub desk keyboard shortcuts and Hub desk › End of day.
// Every account and parcel is temporary (support.ts Fixtures) and deleted afterwards.
const fx = new Fixtures();
let shop: TempMerchant;
let OPS: TempUser;
let HUB: TempUser;
let FIN: TempUser;
test.beforeAll(async () => {
  shop = await fx.merchant({ label: "Desk Shop" });
  OPS = await fx.staff("OPS_MANAGER");
  HUB = await fx.staff("HUB_OPERATOR", "Gulshan Sorting Hub");
  FIN = await fx.staff("FINANCE");
});
test.afterAll(() => fx.cleanup());

type Win = { DF: { bridgeReady: Promise<unknown>; api: (path: string, init?: unknown) => Promise<any> } };

/** Signs in; native dialogs are recorded (there must be none: every confirm / prompt is in the page). */
async function signedIn(browser: Browser, user: TempUser, errors: string[], native: string[]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("dialog", dialog => {
    native.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });
  page.on("pageerror", error => errors.push(`${user.name}: ${error.message}`));
  page.on("console", message => {
    if (message.type() === "error" && !/status of (401|403)|Failed to load resource|tile\.openstreetmap/.test(message.text())) errors.push(`${user.name}: ${message.text()}`);
  });
  for (let attempt = 0; ; attempt++) {
    await page.goto("/login");
    await page.waitForSelector("html.legacy-ready", { state: "attached" });
    await page.fill("#loginIdentity", user.login);
    await page.fill("#loginPassword", user.password);
    await page.click('form[data-form="login"] button[type="submit"]');
    const ok = await page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 10_000 }).then(() => true, () => false);
    if (ok) break;
    if (attempt >= 2 || !/too many/i.test(await page.content())) throw new Error(`${user.name} could not sign in`);
    await page.waitForTimeout(61_000);
  }
  if (!/courier-operation/.test(page.url())) await page.goto("/courier-operation");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.evaluate(() => (window as unknown as Win).DF.bridgeReady);
  return page;
}
const apiOf = (page: Page) => <T = any>(path: string, init?: unknown) => page.evaluate(([p, i]) => (window as unknown as Win).DF.api(p as string, i), [path, init] as const) as Promise<T>;

async function book(page: Page, name: string) {
  const parcel = await apiOf(page)<{ trackingId: string }>("/ops/parcels", {
    method: "POST",
    body: { merchantId: shop.id, recipient: { name, phone: "01812000000" }, delivery: { category: "Office", street: "Road 7, Flat 3B", zone: "Dhanmondi", district: "Dhaka Central" }, serviceLevel: "Regular", weightKg: 1, codAmount: 450 },
  });
  return parcel.trackingId;
}

test("finance: an account opens in place; an adjustment is a validated form; a refusal stays inside the dialog (no prompt)", async ({ browser }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  const native: string[] = [];
  await sql(`INSERT INTO accounts (id, kind, "merchantId", name) VALUES (gen_random_uuid(), 'ECOMMERCE', $1, $2) ON CONFLICT DO NOTHING`, [shop.id, shop.name]);
  const page = await signedIn(browser, FIN, errors, native);
  await opsNav(page, "accountsEcommerce");
  await page.fill("#accListQ", shop.code);
  await page.locator("tr[data-acc='open']", { hasText: shop.code }).click();
  await expect(page.locator("#mainContent .acc-head h2")).toHaveText(shop.name);

  // Adjustment: nothing filled in → the fields say so; then a deduction with a reason.
  await page.click('[data-acc="adjust"]');
  await page.click("#modalSubmit");
  await expect(page.locator("#of_amount")).toHaveAttribute("aria-invalid", "true");
  await page.fill("#of_amount", "50");
  await page.fill("#of_reason", "Damaged packaging claim");
  await page.click("#modalSubmit");
  await expect(page.locator("#toast")).toContainText("Adjustment of ৳50 added.");
  await page.click('[data-acc="sub"][data-sub="statement"]');
  await expect(page.locator("#mainContent .acc-table")).toContainText("Damaged packaging claim");

  // Settle with nothing but a deduction: the API refuses and the message stays in the dialog.
  await page.click('[data-acc="settle"]');
  await expect(page.locator("#accSettlePick")).toContainText("No delivered parcel is ready");
  await page.click("#modalSubmit");
  await expect(page.locator("#opsFormError")).toBeVisible();
  await expect(page.locator("#modalBackdrop")).toHaveClass(/open/);
  await page.click("#modalCancel");

  expect(native).toEqual([]);
  expect(errors).toEqual([]);
  await page.context().close();
});

test("parcel drawer: add a staff note, the message log with codes masked, and the zone → hub lookup", async ({ browser }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  const native: string[] = [];
  const page = await signedIn(browser, OPS, errors, native);
  const trackingId = await book(page, `Desk Drawer ${fx.stamp}`);
  // A delivery-code SMS about the parcel (the code must never show in the log).
  await sql(`INSERT INTO outbox_messages (id, channel, "to", template, body, state, "sentAt", provider, "trackingId") VALUES (gen_random_uuid(), 'SMS', '+8801812000000', 'parcel.delivery_code', $1, 'SENT', now(), 'log', $2)`, [
    `Your Delivery Fast parcel ${trackingId} is on its way. Give code 6831 to the rider only after you receive the parcel.`,
    trackingId,
  ]);

  await page.fill("#globalSearch", trackingId);
  await page.press("#globalSearch", "Enter");
  const drawer = page.locator("#parcelDrawer");
  await expect(page.locator("#parcelDrawerTitle")).toHaveText(trackingId);
  await expect(drawer.locator("[data-drawer-history]")).toHaveCount(0); // its own history section is below

  // Messages: the SMS with the code masked and the recipient masked.
  const messages = drawer.locator("#drawerMessages");
  await expect(messages.locator("[data-message]").first()).toBeVisible({ timeout: 15_000 });
  await expect(messages).toContainText("SMS · Delivery code");
  await expect(messages).toContainText("Give code •••• to the rider");
  await expect(messages).toContainText("+880 18•• •••000");
  await expect(messages).not.toContainText("6831");

  // Add a staff note: empty is refused inline, then it is saved and listed.
  await drawer.locator("#drawerNoteSave").click();
  await expect(drawer.locator("#drawerNoteStatus")).toContainText("Write the note first");
  await drawer.locator("#drawerNote").fill(`Call before 5 pm ${fx.stamp}`);
  await drawer.locator("#drawerNoteSave").click();
  await expect(page.locator("#toast")).toContainText(`${trackingId}: note added.`);
  await expect(drawer.locator("[data-drawer-notes]")).toContainText(`Call before 5 pm ${fx.stamp}`);
  const notes = await sql<{ description: string; visibility: string }>(`SELECT e.description, e.visibility FROM tracking_events e JOIN parcels p ON p.id = e."parcelId" WHERE p."trackingId" = $1 AND e.title = 'Note'`, [trackingId]);
  expect(notes).toEqual([{ description: `Call before 5 pm ${fx.stamp}`, visibility: "INTERNAL" }]);

  // Esc closes the drawer.
  await page.locator("#mainContent .page-heading h1").click();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  // Typing a zone or an area shows the hub that serves it.
  await page.fill("#globalSearch", "Gulsh");
  const lookup = page.locator("#zoneLookup");
  await expect(lookup).toBeVisible();
  await expect(lookup.locator('[data-zone-lookup="Gulshan"]').first()).toContainText("Gulshan Sorting Hub");
  await page.fill("#globalSearch", "Dhanmondi");
  await expect(lookup.locator('[data-zone-lookup="Dhanmondi"]').first()).toContainText("Dhanmondi Hub");
  // A tracking ID is a parcel search, not a place.
  await page.fill("#globalSearch", trackingId);
  await expect(lookup).toHaveCount(0);
  // Choosing a place closes the list (zones are changed in Super admin > Hubs & zones).
  await page.fill("#globalSearch", "Gulshan");
  await page.locator('#zoneLookup [data-zone-lookup="Gulshan"]').first().click();
  await expect(lookup).toHaveCount(0);

  expect(native).toEqual([]);
  expect(errors).toEqual([]);
  await page.context().close();
});

test("hub desk: scan feedback at the counter, keyboard shortcuts, a small sign-out dialog, and the end-of-day reconciliation", async ({ browser }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const native: string[] = [];
  const page = await signedIn(browser, HUB, errors, native);

  // The counter: the scan box gets the focus when the tab opens; an unknown code is an error beep and a red box.
  await opsNav(page, "hubPickupCounter");
  const scan = page.locator("#collectScan");
  await expect(scan).toBeFocused({ timeout: 10_000 });
  await expect(page.locator("#deskShortcuts")).toContainText("F2");
  await scan.fill("PP-000000-NOPE");
  await scan.press("Enter");
  await expect(page.locator("#collectScan")).toHaveAttribute("data-scan-result", "error");
  await expect(page.locator("#collectMessage")).toContainText("PP-000000-NOPE isn't waiting for collection at this hub.");

  // "/" focuses the search; F2 the scan box on screen.
  await page.locator("#mainContent .page-heading h1").click();
  await page.keyboard.press("/");
  await expect(page.locator("#globalSearch")).toBeFocused();
  await page.locator("#mainContent .page-heading h1").click();
  await page.keyboard.press("F2");
  await expect(page.locator("#collectScan")).toBeFocused();

  // Signing out asks in a small in-page dialog; Esc keeps you signed in.
  await page.locator(".user-profile").first().click();
  await expect(page.locator(".df-dialog #dfDialogTitle")).toHaveText("Sign out?");
  await page.keyboard.press("Escape");
  await expect(page.locator(".df-dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/courier-operation/);

  // End of day: today's figures for the operator's hub; a parcel received now counts.
  await opsNav(page, "hubEndOfDay");
  const panel = page.locator("#eodPanel");
  await expect(panel.locator(".panel-heading .panel-title")).toHaveText("End of day · Gulshan Sorting Hub");
  const received = panel.locator('[data-eod="received"]');
  await expect(received).toBeVisible({ timeout: 20_000 });
  const before = Number((await received.textContent())!.replace(/\D/g, ""));
  const trackingId = await book(page, `Desk EOD ${fx.stamp}`);
  const [hub] = await sql<{ id: string }>(`SELECT id FROM hubs WHERE name = 'Gulshan Sorting Hub'`);
  const rider = await fx.rider("Gulshan Sorting Hub");
  await apiOf(page)(`/parcels/${trackingId}/assign-pickup`, { method: "POST", body: { riderId: rider.riderId } });
  await apiOf(page)(`/parcels/${trackingId}/status`, { method: "POST", body: { status: "AT_HUB", hubId: hub.id } });
  await panel.locator('[data-eod-action="refresh"]').click();
  await expect.poll(async () => Number(((await received.textContent()) || "0").replace(/\D/g, "")), { timeout: 20_000 }).toBeGreaterThanOrEqual(before + 1);
  await expect(panel.locator('[data-eod="heldNow"]')).not.toHaveText("0");
  await expect(page.locator("#eodCash")).toContainText("Cash handovers received");
  // Another day.
  await page.fill("#eodDate", "2026-01-01");
  await page.locator("#eodDate").dispatchEvent("change");
  await expect(received).toHaveText("0", { timeout: 20_000 });
  // The printable PDF.
  const pdf = await openPdf(page, () => panel.locator('[data-eod-action="print"]').click());
  expect(pdf.response.url()).toContain(`hubId=${hub.id}`);
  expect(pdf.has("End-of-day hub reconciliation")).toBe(true);
  expect(pdf.has("Gulshan Sorting Hub")).toBe(true);
  await pdf.popup.close();

  expect(native).toEqual([]);
  expect(errors).toEqual([]);
  await page.context().close();
});
