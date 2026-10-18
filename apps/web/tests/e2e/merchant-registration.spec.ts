import { type Browser, type Page } from "@playwright/test";
import { Fixtures, expect, sql, test, type TempUser } from "./support";

/**
 * Merchant registration with structured addresses (2026-10-18): the website application
 * (district → thana → area, a separate pickup with an "Other" area, Drop at hub showing the serving
 * hub) and the merchant panel's Settings editor (an older free-text address completed, the hub
 * re-derived). Needs the API, the web app and the BD catalog (Dhaka North › Gulshan / Uttara, their
 * hubs). The applicant, the merchants and their members are temporary (support.ts cleanup).
 */
const fx = new Fixtures();
test.afterAll(() => fx.cleanup());
const toast = (page: Page) => page.locator("#toast");

async function signIn(browser: Browser, user: TempUser, to: RegExp | string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/status of (401|404)|Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  for (let attempt = 0; ; attempt++) {
    await page.goto("/login");
    await page.waitForSelector("html.legacy-ready", { state: "attached" });
    await page.fill("#loginIdentity", user.login);
    await page.fill("#loginPassword", user.password);
    await page.click('form[data-form="login"] button[type="submit"]');
    const ok = await page.waitForURL(url => !/\/login$/.test(url.pathname), { timeout: 15_000 }).then(() => true, () => false);
    if (ok) break;
    if (attempt >= 2 || !/too many/i.test(await page.content())) throw new Error("Sign-in failed");
    await page.waitForTimeout(61_000);
  }
  if (typeof to === "string") await page.goto(to);
  else await page.waitForURL(to);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return { page, errors };
}

test("website: a merchant applies with a structured business address, a separate pickup and Drop at hub", async ({ browser }) => {
  const applicant = await fx.user(`E2E Applicant ${fx.stamp}`, [{ role: "CUSTOMER" }]);
  const business = `E2E Address Shop ${fx.stamp}`;
  const { page, errors } = await signIn(browser, applicant, "/merchant");

  await page.fill("#partnerName", business);
  await expect(page.locator("#partnerContact")).toHaveValue(applicant.name);
  await page.selectOption("#businessCategory", "Books");
  await page.fill("#websiteUrl", "facebook.com/e2eaddressshop");

  // Business address: the district through the searchable list, then thana and area.
  await page.locator("#bizDistrict").click();
  await page.locator(".df-ss-pop [role=combobox]").fill("dhaka nor");
  await expect(page.locator(".df-ss-pop [role=option]", { hasText: "Dhaka North" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("#bizDistrict")).toHaveValue("Dhaka North");
  await page.selectOption("#bizZone", "Gulshan");
  await page.selectOption("#bizArea", "Gulshan 2");
  await page.fill("#bizStreet", "House 7, Road 4, Flat B2");

  // A separate pickup address with an area that isn't listed.
  await page.uncheck("#pickupSame");
  await expect(page.locator("#puDistrict")).toBeVisible();
  await page.selectOption("#puDistrict", "Dhaka North");
  await page.selectOption("#puZone", "Uttara");
  await page.selectOption("#puArea", "__other__");
  await page.fill("#puOtherArea", "E2E Lane 9");
  await page.fill("#puStreet", "Warehouse 4, Sector 7");

  // Pickup contact (follows the contact person until changed) with inline phone validation.
  await page.fill("#pickupContactName", "E2E Store Keeper");
  await page.fill("#pickupContactPhone", "12345");
  await page.locator("#pickupContactPhone").blur();
  await expect(page.locator("#pickupContactPhone-error")).toBeVisible();
  await page.fill("#pickupContactPhone", "1922333444");
  await expect(page.locator("#pickupContactPhone-error")).toHaveCount(0);
  await page.check('input[name="pickupTime"][value="MIDDAY"]');

  // Drop at hub: the hub serving the pickup zone appears (read-only).
  await page.check("#handover-HUB_DROP");
  await expect(page.locator("#servingHub")).toContainText("Uttara Delivery Hub (DHK-UTT)");
  // Pickup from the business address again → the business zone's hub; then back to the separate pickup.
  await page.check("#pickupSame");
  await expect(page.locator("#servingHub")).toContainText("Gulshan Sorting Hub");
  await page.uncheck("#pickupSame");
  await expect(page.locator("#puOtherArea")).toHaveValue("E2E Lane 9");
  await expect(page.locator("#servingHub")).toContainText("Uttara Delivery Hub");

  await page.click('form[data-form="merchant"] button[type="submit"]');
  await expect(page).toHaveURL(/\/ecommerce-merchant/, { timeout: 20_000 });
  await fx.adoptMerchant(business);
  const [row] = await sql<Record<string, unknown>>(
    `SELECT m."businessDistrict", m."businessZone", m."businessArea", m."businessStreet", m."businessCategory", m."websiteUrl", m."pickupSameAsBusiness", m."pickupDistrict", m."pickupZone", m."pickupArea", m."pickupAreaOther", m."pickupAddress", m."pickupContactName", m."pickupContactPhone", m."pickupTime", m.handover, h.code AS hub
       FROM merchants m LEFT JOIN hubs h ON h.id = m."pickupHubId" WHERE m.name = $1`,
    [business],
  );
  expect(row).toMatchObject({
    businessDistrict: "Dhaka North",
    businessZone: "Gulshan",
    businessArea: "Gulshan 2",
    businessStreet: "House 7, Road 4, Flat B2",
    businessCategory: "Books",
    websiteUrl: "https://facebook.com/e2eaddressshop",
    pickupSameAsBusiness: false,
    pickupDistrict: "Dhaka North",
    pickupZone: "Uttara",
    pickupArea: "E2E Lane 9",
    pickupAreaOther: true,
    pickupAddress: "Warehouse 4, Sector 7",
    pickupContactName: "E2E Store Keeper",
    pickupContactPhone: "+8801922333444",
    pickupTime: "MIDDAY",
    handover: "HUB_DROP",
    hub: "DHK-UTT",
  });
  expect(errors).toEqual([]);
});

test("merchant panel: Settings asks to complete an older free-text address, and saving re-derives the hub", async ({ browser }) => {
  const shop = await fx.merchant({ type: "ECOMMERCE" }); // free text: "House 12, Road 11, Banani Block C" · "Banani", Dhaka North
  const owner = await fx.member(shop, "MERCHANT_OWNER");
  const { page, errors } = await signIn(browser, owner, /\/ecommerce-merchant/);
  await page.click('#navigation [data-page="Settings"]');
  const profileRow = page.locator("#tableBody tr", { hasText: "Store profile" });
  await expect(profileRow).toContainText("complete your address");
  await profileRow.locator("button").click();

  const dialog = page.locator("#merchantHistoryBackdrop");
  await expect(dialog.locator("#dfmaPrompt")).toContainText("Complete your address");
  // The best-effort match is preselected (Banani is a zone of Dhaka North); the street is kept.
  await expect(page.locator("#dfmaBizDistrict")).toHaveValue("Dhaka North");
  await expect(page.locator("#dfmaBizZone")).toHaveValue("Banani");
  await expect(page.locator("#dfmaBizStreet")).toHaveValue(shop.pickupAddress);
  // Banani lists areas: one must be chosen (inline error), then a pickup time.
  await page.click('#dfProfileForm button[type="submit"]');
  await expect(dialog).toContainText('Choose the area, or "Other" and type it');
  await page.selectOption("#dfmaBizArea", "Banani Block C");

  // A separate pickup address in Uttara with Drop at hub: the serving hub shows before saving.
  await page.uncheck("#dfmaPickupSame");
  await page.selectOption("#dfmaPuDistrict", "Dhaka North");
  await page.selectOption("#dfmaPuZone", "Uttara");
  await page.selectOption("#dfmaPuArea", "Uttara Sector 7");
  await page.fill("#dfmaPuStreet", "House 3, Road 12, Sector 7");
  await page.selectOption("#dfmaPickupTime", "MORNING");
  await page.selectOption("#dfmaHandover", "HUB_DROP");
  await expect(page.locator("#dfmaHub")).toContainText("Uttara Delivery Hub");
  await page.click('#dfProfileForm button[type="submit"]');
  await expect(toast(page)).toContainText("Profile saved. Your pickups are now served by Uttara Delivery Hub.");
  await expect(profileRow).toContainText("Uttara, Dhaka North · hub Uttara Delivery Hub");

  const [row] = await sql<Record<string, unknown>>(`SELECT m."businessZone", m."businessArea", m."pickupZone", m."pickupArea", m."pickupAddress", m."pickupTime", m.handover, h.code AS hub FROM merchants m LEFT JOIN hubs h ON h.id = m."pickupHubId" WHERE m.id = $1`, [shop.id]);
  expect(row).toMatchObject({ businessZone: "Banani", businessArea: "Banani Block C", pickupZone: "Uttara", pickupArea: "Uttara Sector 7", pickupAddress: "House 3, Road 12, Sector 7", pickupTime: "MORNING", handover: "HUB_DROP", hub: "DHK-UTT" });
  const [audit] = await sql<{ data: Record<string, unknown> }>(`SELECT data FROM audit_logs WHERE action = 'merchant.self_update' AND "entityId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [shop.id]);
  expect(audit.data).toMatchObject({ pickupHubId: expect.any(String), previousPickupHubId: null });

  // Back to "pickup from the business address": the pickup follows the business address (Banani → Gulshan Sorting Hub).
  await profileRow.locator("button").click();
  await expect(page.locator("#dfmaPrompt")).toHaveCount(0);
  await expect(page.locator("#dfmaPuZone")).toHaveValue("Uttara");
  await page.check("#dfmaPickupSame");
  await page.click('#dfProfileForm button[type="submit"]');
  await expect(toast(page)).toContainText("Gulshan Sorting Hub");
  expect(errors).toEqual([]);
});
