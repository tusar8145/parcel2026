import { type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { Fixtures, confirmDialog, expect, openPdf, test, type TempMerchant, type TempUser } from "./support";

// Both merchant panels: the top search and the parcel side drawer (public/legacy/shared/merchant-parcel.js).
// Search by tracking ID / order ref / phone opens the drawer (several matches: a list to pick from); the drawer
// shows merchant-visible sections only — never a staff note written in Courier Operations; its actions use the
// panel's existing ones (cancel while pending, print label → PDF tab); another merchant's parcel isn't found.
// Every account and parcel is temporary (support.ts Fixtures) and deleted afterwards.
const fx = new Fixtures();
let shop: TempMerchant;
let shopOwner: TempUser;
let bank: TempMerchant;
let bankOwner: TempUser;
let other: TempMerchant;
let otherOwner: TempUser;
let OPS: TempUser;
test.beforeAll(async () => {
  shop = await fx.merchant({ label: "Drawer Shop" });
  shopOwner = await fx.member(shop, "MERCHANT_OWNER");
  bank = await fx.merchant({ type: "BANKING_FINANCIAL", label: "Drawer Bank" });
  bankOwner = await fx.member(bank, "MERCHANT_OWNER");
  other = await fx.merchant({ label: "Other Shop" });
  otherOwner = await fx.member(other, "MERCHANT_OWNER");
  OPS = await fx.staff("OPS_MANAGER");
});
test.afterAll(() => fx.cleanup());

async function token(api: APIRequestContext, user: { login: string; password: string }) {
  const res = await api.post("/api/v1/auth/login", { data: { identifier: user.login, password: user.password } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).accessToken as string;
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** Books a parcel as the merchant (POST /parcels). */
async function book(api: APIRequestContext, owner: TempUser, m: TempMerchant, data: { name: string; phone: string; ref: string }) {
  const t = await token(api, owner);
  const doc = m.type === "BANKING_FINANCIAL";
  const res = await api.post("/api/v1/parcels", {
    headers: { ...auth(t), "Idempotency-Key": `e2e-drawer-${data.ref}` },
    data: {
      sender: { name: m.name, phone: m.contactPhone },
      pickup: { category: "Office", street: m.pickupAddress, area: "Banani", zone: "Banani", district: "Dhaka North" },
      recipient: { name: data.name, phone: data.phone },
      delivery: { category: doc ? "Office" : "Home", street: "House 7, Road 2", zone: "Dhanmondi", district: "Dhaka Central" },
      type: doc ? "DOCUMENT" : "ECOMMERCE",
      weightKg: doc ? 0.5 : 1,
      codAmount: doc ? 0 : 900,
      contents: doc ? "Cheque book" : "Cotton shirt",
      merchantOrderRef: data.ref,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).trackingId as string;
}

/** A staff note in Courier Operations (internal: never shown to the merchant). */
async function staffNote(api: APIRequestContext, trackingId: string, note: string) {
  const res = await api.post(`/api/v1/parcels/${trackingId}/notes`, { headers: auth(await token(api, OPS)), data: { note } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function signIn(browser: Browser, user: TempUser, panel: RegExp, errors: string[], viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(`${user.name}: ${error.message}`));
  page.on("console", message => {
    if (message.type() === "error" && !/status of (401|403|404)|Failed to load resource/.test(message.text())) errors.push(`${user.name}: ${message.text()}`);
  });
  for (let attempt = 0; ; attempt++) {
    await page.goto("/login");
    await page.waitForSelector("html.legacy-ready", { state: "attached" });
    await page.fill("#loginIdentity", user.login);
    await page.fill("#loginPassword", user.password);
    await page.click('form[data-form="login"] button[type="submit"]');
    const ok = await page.waitForURL(panel, { timeout: 15_000 }).then(() => true, () => false);
    if (ok) break;
    if (attempt >= 2 || !/too many/i.test(await page.content())) await expect(page).toHaveURL(panel);
    await page.waitForTimeout(61_000);
  }
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.evaluate(() => (window as unknown as { DF: { bridgeReady: Promise<unknown> } }).DF.bridgeReady);
  return page;
}

async function find(page: Page, text: string) {
  await page.fill("#globalSearch", text);
  await page.press("#globalSearch", "Enter");
}
const drawerOf = (page: Page) => page.locator("#merchantParcelDrawer");

/** The merchant-visible sections, and none of the staff-only text. */
async function expectMerchantSections(page: Page, trackingId: string, forbidden: string[]) {
  const drawer = drawerOf(page);
  await expect(drawer).toBeVisible();
  await expect(page.locator("#merchantParcelTitle")).toHaveText(trackingId);
  for (const heading of ["Actions", "Recipient", "Shipment", "Price", "Messages set to send", "Support", "Status timeline"]) await expect(drawer.locator("section h3", { hasText: heading }).first()).toBeVisible();
  await expect(drawer.locator("#merchantParcelTimeline")).toContainText(/Pickup request submitted|Drop-off booking received|booked/i);
  await expect(drawer.locator("[data-dfm-price] [data-price-total]")).toContainText("৳");
  await expect(drawer.locator("[data-dfm-ticket]")).toHaveText("Open a ticket about this parcel");
  const text = await drawer.innerText();
  for (const f of forbidden) expect(text).not.toContain(f);
  expect(text).not.toMatch(/staff note|internal/i);
}

test("e-commerce merchant: top search, the parcel drawer, its actions and privacy", async ({ browser, api }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  const phone = `017${String(Date.now()).slice(-8)}`;
  const name = `Drawer Buyer ${fx.stamp}`;
  const first = await book(api, shopOwner, shop, { name, phone, ref: `DRW-${fx.stamp}-1` });
  const second = await book(api, shopOwner, shop, { name: `${name} Two`, phone, ref: `DRW-${fx.stamp}-2` });
  const foreign = await book(api, otherOwner, other, { name: `Foreign ${fx.stamp}`, phone: `016${String(Date.now()).slice(-8)}`, ref: `OTH-${fx.stamp}` });
  const NOTE = `Staff only ${fx.stamp}: recipient flagged`;
  await staffNote(api, first, NOTE);

  const page = await signIn(browser, shopOwner, /\/ecommerce-merchant/, errors);
  const drawer = drawerOf(page);

  // ── Tracking ID → the drawer, merchant sections only (the staff note is absent) ──
  await find(page, first.toLowerCase());
  await expectMerchantSections(page, first, [NOTE, OPS.name]);
  await expect(drawer).toContainText(name);
  await expect(drawer).toContainText(`DRW-${fx.stamp}-1`);
  await expect(drawer).toContainText("৳ 900");
  // Esc closes; "/" focuses the search again.
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await page.locator("#mainContent h1").click();
  await page.keyboard.press("/");
  await expect(page.locator("#globalSearch")).toBeFocused();

  // ── Order ref → that parcel directly ──
  await find(page, `DRW-${fx.stamp}-2`);
  await expect(page.locator("#merchantParcelTitle")).toHaveText(second);

  // ── Phone (+880 form) → both parcels to pick from ──
  await find(page, `+880 ${phone.slice(1, 5)}-${phone.slice(5)}`);
  const matches = drawer.locator("#merchantParcelMatches [data-dfm-open]");
  await expect(matches).toHaveCount(2);
  await matches.filter({ hasText: first }).click();
  await expect(page.locator("#merchantParcelTitle")).toHaveText(first);
  await expect(drawer.locator("#merchantParcelMatches")).toBeVisible();

  // ── Print label → a PDF in a new tab ──
  const pdf = await openPdf(page, () => drawer.locator(`[data-df-label="${first}"]`).click());
  expect(pdf.has(first)).toBeTruthy();
  await pdf.popup.close();

  // ── Cancel while pending (the panel's own dialog) → the drawer follows ──
  await drawer.locator(`[data-df-cancel="${first}"]`).click();
  await confirmDialog(page, { title: `Cancel ${first}?`, value: "Customer changed their mind" });
  await expect(page.locator("#merchantParcelSub")).toContainText("Pickup cancelled");
  await expect(drawer.locator("[data-df-cancel]")).toHaveCount(0);
  await expect(drawer.locator("#merchantParcelTimeline")).toContainText("Pickup request cancelled");
  await page.keyboard.press("Escape");

  // ── Another merchant's parcel is not found ──
  await find(page, foreign);
  await expect(page.locator("#toast")).toContainText(`No parcel found for “${foreign}”`);
  await expect(drawer).toBeHidden();
  await find(page, `OTH-${fx.stamp}`);
  await expect(page.locator("#toast")).toContainText("No parcel found");
  await expect(drawer).toBeHidden();

  // ── Orders list: "Details" and a click on the row ──
  await page.click('#navigation [data-page="Orders"]');
  await page.fill("#tableSearch", second);
  const row = page.locator(`#tableBody tr[data-merchant-record-id="${second}"]`);
  await row.locator(`[data-dfm-open="${second}"]`).click();
  await expect(page.locator("#merchantParcelTitle")).toHaveText(second);
  await page.keyboard.press("Escape");
  await row.locator("td").nth(2).click();
  await expect(page.locator("#merchantParcelTitle")).toHaveText(second);

  // ── Support: a ticket about this parcel (the Support page's form, prefilled) ──
  await drawer.locator(`[data-dfm-ticket="${second}"]`).click();
  await expect(drawer).toBeHidden();
  await expect(page.locator("#breadcrumbPage")).toHaveText("Support");
  await expect(page.locator(".st-composer input[name='relatedRef']")).toHaveValue(second);
  await expect(page.locator(".st-composer input[name='subject']")).toHaveValue(`Help with ${second}`);
  await page.context().close();

  // ── Phones (390 px): the drawer fits, no sideways scrolling ──
  const phonePage = await signIn(browser, shopOwner, /\/ecommerce-merchant/, errors, { width: 390, height: 844 });
  await phonePage.evaluate(id => (window as unknown as { DFMerchantParcel: { open(id: string): Promise<boolean> } }).DFMerchantParcel.open(id), second);
  await expect(phonePage.locator("#merchantParcelTitle")).toHaveText(second);
  const box = (await drawerOf(phonePage).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.width).toBeLessThanOrEqual(390);
  expect(await phonePage.evaluate(() => document.getElementById("merchantParcelBody")!.scrollWidth <= document.getElementById("merchantParcelBody")!.clientWidth)).toBeTruthy();
  await phonePage.context().close();

  expect(errors).toEqual([]);
});

test("banking merchant: search by tracking ID, order ref and phone opens the drawer without staff notes; labels print", async ({ browser, api }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const phone = `015${String(Date.now()).slice(-8)}`;
  const ref = `CARD-${fx.stamp}`;
  const id = await book(api, bankOwner, bank, { name: `Card Holder ${fx.stamp}`, phone, ref });
  const NOTE = `Bank staff note ${fx.stamp}`;
  await staffNote(api, id, NOTE);

  const page = await signIn(browser, bankOwner, /\/banking-merchant/, errors);
  for (const text of [id, ref, phone]) {
    await find(page, text);
    await expectMerchantSections(page, id, [NOTE, OPS.name]);
    await page.keyboard.press("Escape");
    await expect(drawerOf(page)).toBeHidden();
  }
  await find(page, ref);
  await expect(drawerOf(page)).toContainText("Cheque book");
  const pdf = await openPdf(page, () => drawerOf(page).locator(`[data-df-label="${id}"]`).click());
  expect(pdf.has(id)).toBeTruthy();
  await pdf.popup.close();
  await page.context().close();
  expect(errors).toEqual([]);
});
