import { Fixtures, expect, test, type TempUser } from "./support";

// "Paste a message" fills empty fields from an SMS / chat text (POST /parse-message): the website's Request a
// pickup and the merchant panel's Create order.
const fx = new Fixtures();
let OWNER: TempUser;
test.beforeAll(async () => {
  const m = await fx.merchant();
  OWNER = await fx.user(`E2E Paste ${fx.stamp}`, [{ role: "MERCHANT_OWNER", merchantId: m.id }]);
});
test.afterAll(() => fx.cleanup());

const MESSAGE = "Order confirmed!\nName: Ayesha Rahman\nPhone: 01712-345678\nAddress: House 12, Road 5, Dhanmondi, Dhaka\nCOD: 1,250 Tk";

test("website Request a pickup: a pasted message fills the receiver, address and cash to collect", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto("/request");
  await page.waitForSelector("#requestPickup");
  await page.getByRole("button", { name: /Paste it/ }).click();
  await page.getByLabel("Paste the message").fill(MESSAGE);
  await page.getByRole("button", { name: "Fill the form" }).click();
  await expect(page.locator(".df-paste [role=status]")).toContainText("Filled: receiver's name, receiver's phone, delivery address");
  await expect(page.locator("#requestReceiver")).toHaveValue("Ayesha Rahman");
  await expect(page.locator("#requestReceiverPhone")).toHaveValue("1712345678");
  await expect(page.locator("#requestDelivery")).toHaveValue("House 12, Road 5, Dhanmondi, Dhaka");
  await expect(page.locator("#requestZone")).toHaveValue("Dhanmondi");
  await expect(page.locator("#requestCodAmount")).toHaveValue("1250");
  // The pickup side is still the user's to fill.
  await expect(page.locator("#requestPickup")).toHaveValue("");
  expect(errors).toEqual([]);
});

test("merchant Create order: a pasted Bangla message fills name, phone, address (its zone follows) and COD", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto("/login");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.fill("#loginIdentity", OWNER.login);
  await page.fill("#loginPassword", OWNER.password);
  await page.click('form[data-form="login"] button[type="submit"]');
  await page.waitForURL(/\/ecommerce-merchant/);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.evaluate(() => (window as unknown as { DF: { bridgeReady: Promise<unknown> } }).DF.bridgeReady);
  await page.evaluate(() => (window as unknown as { openOrderModal(): void }).openOrderModal());
  await page.click("#dfPasteMessage [data-paste-toggle]");
  await page.fill("#dfPasteMessage [data-paste-text]", "প্রাপক: রহিম উদ্দিন\nমোবাইল: ০১৮১২৩৪৫৬৭৮\nঠিকানা: বাসা ৭, রোড ১১, বনানী, ঢাকা\nটাকা: ৯৫০");
  await page.click("#dfPasteMessage [data-paste-read]");
  await expect(page.locator("#dfPasteMessage [data-paste-note]")).toContainText("Filled: name, phone, full address, COD ৳950");
  await expect(page.locator("#customerName")).toHaveValue("রহিম উদ্দিন");
  await expect(page.locator("#customerPhone")).toHaveValue(/1812345678/);
  await expect(page.locator("#deliveryAddress")).toHaveValue(/বনানী/);
  await expect(page.locator("#merchantZone")).toHaveValue("Banani", { timeout: 10_000 });
  await expect(page.locator("#merchantSvcCod")).toBeChecked();
  await expect(page.locator("#merchantSvcCodAmount")).toHaveValue("950");
  // The box is the first thing in the form.
  await expect(page.locator("#orderForm .form-grid > :first-child")).toHaveId("dfPasteMessage");
  expect(errors).toEqual([]);
});
