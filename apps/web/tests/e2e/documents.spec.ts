import { type Page } from "@playwright/test";
import { expect, Fixtures, opsNav, openPdf, test, type TempMerchant, type TempUser } from "./support";

// Printing: every print option generates a PDF on the API (modules/documents) and opens it in a
// new tab. Courier Operations → All parcels: "E-commerce invoices · A4", "4 invoices · A4"
// and "Order / shipment list" for the filtered parcels. Every account and parcel is temporary.
const fx = new Fixtures();
let shop: TempMerchant;
let ops: TempUser;

test.beforeAll(async () => {
  shop = await fx.merchant({ label: "Print Shop" });
  ops = await fx.user(`E2E-Print-${fx.stamp} Test`, [{ role: "OPS_MANAGER" }]);
});
test.afterAll(() => fx.cleanup());

async function signIn(page: Page, user: TempUser) {
  for (let attempt = 0; ; attempt++) {
    await page.goto("/login");
    await page.waitForSelector("html.legacy-ready", { state: "attached" });
    await page.fill("#loginIdentity", user.login);
    await page.fill("#loginPassword", user.password);
    await page.click('form[data-form="login"] button[type="submit"]');
    const ok = await page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 15_000 }).then(() => true, () => false);
    if (ok) break;
    // Sign-in is rate limited per IP (shared with other suites on this machine).
    if (attempt >= 2 || !/too many/i.test(await page.content())) throw new Error(`Couldn't sign in as ${user.name}`);
    await page.waitForTimeout(61_000);
  }
  if (!/courier-operation/.test(page.url())) await page.goto("/courier-operation");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
}

/** Picks a format in the heading's "Print…" select: choosing it prints (then the select reads "Print…" again). */
async function printAs(page: Page, format: string) {
  await expect(page.locator("#courierPrintFormat")).toHaveValue("");
  await page.locator("#courierPrintFormat").selectOption(format);
}

test("print options open generated PDFs in a new tab", async ({ page, api }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/status of 401|Failed to load resource|tile\.openstreetmap/.test(message.text())) errors.push(message.text());
  });

  const login = await api.post("/api/v1/auth/login", { data: { identifier: ops.login, password: ops.password } });
  expect(login.status()).toBe(200);
  const token = (await login.json()).accessToken as string;
  const recipient = `Print E2E ${fx.stamp}`;
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const res = await api.post("/api/v1/ops/parcels", {
      headers: { authorization: `Bearer ${token}` },
      data: {
        merchantId: shop.id,
        recipient: { name: `${recipient} ${i}`, phone: "01812000000" },
        delivery: { category: "Home", street: "Road 7, Flat 3B", zone: "Dhanmondi", district: "Dhaka Central" },
        serviceLevel: "Regular",
        weightKg: 1,
        codAmount: 750,
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    ids.push((await res.json()).trackingId);
  }

  await signIn(page, ops);
  await opsNav(page, "allParcels");
  await page.fill("#shipmentSearch", recipient);
  // Tick the two parcels: the print options print the ticked rows (else every row the table shows).
  const boxes = ids.map(id => page.locator(`#shipmentBody [data-shipment-select="${id}"]`));
  // The list may redraw while the search result arrives: tick until both stay ticked.
  await expect(async () => {
    for (const box of boxes) if (!(await box.isChecked())) await box.check();
    for (const box of boxes) await expect(box).toBeChecked({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });

  // "E-commerce invoices · A4": one delivery invoice per page, with VAT, COD and both parcels.
  const invoices = await openPdf(page, () => printAs(page, "invoice-ecommerce"));
  expect(invoices.response.url()).toContain("line=ecommerce");
  expect(invoices.info.pages, invoices.response.url()).toBe(2);
  expect(invoices.has("E-commerce parcel invoice")).toBe(true);
  expect(invoices.has("Page 1 of 2")).toBe(true);
  for (const id of ids) expect(invoices.has(id)).toBe(true);
  expect(await invoices.popup.title()).not.toBe("Couldn't create the PDF");
  await invoices.popup.close();
  // The select is ready again once the PDF is open.
  await expect(page.locator("#courierPrintFormat")).toHaveValue("");

  // "4 invoices · A4": both on one page.
  const four = await openPdf(page, () => printAs(page, "invoice-4"));
  expect(four.info.pages).toBe(1);
  await four.popup.close();

  // "Order / shipment list": a table of the filtered parcels with totals.
  const list = await openPdf(page, () => printAs(page, "orders"));
  expect(list.has("2 shipment(s)")).toBe(true);
  for (const id of ids) expect(list.has(id)).toBe(true);
  await list.popup.close();

  // A line with nothing to print shows the reason in the tab and as a toast.
  const [tab] = await Promise.all([page.context().waitForEvent("page"), printAs(page, "invoice-document")]);
  await expect(tab.locator("h1")).toHaveText("Couldn't create the PDF");
  await expect(tab.locator("p")).toContainText("None of the selected parcels are document shipments");
  await tab.close();

  expect(errors).toEqual([]);
});
