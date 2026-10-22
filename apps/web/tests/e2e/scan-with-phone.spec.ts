import fs from "node:fs";
import path from "node:path";
import { devices, type Page } from "@playwright/test";
import { expect, Fixtures, opsNav, sql, test, type TempMerchant, type TempUser } from "./support";

// Courier Operations › New orders › "Scan with phone" (public/legacy/courier-operation/bridge-scan.js,
// the phone page app/(scan)/scan/[token], API /parcel-scans): the QR link on a phone, a label photo
// read into a row, edited, submitted through the import dialog, booked with its photo; the link
// stops working when the window closes. Accounts are temporary (support.ts Fixtures).
const LABEL = fs.readFileSync(path.join(__dirname, "..", "..", "..", "api", "test", "fixtures", "scan-label.png"));
const fx = new Fixtures();
let shop: TempMerchant;
let OPS: TempUser;
test.beforeAll(async () => {
  shop = await fx.merchant({ label: "Scan Shop" });
  OPS = await fx.staff("OPS_MANAGER");
});
test.afterAll(async () => {
  // Sessions point at their creator without a foreign key: remove this spec's sessions, rows and photos first.
  const files = await sql<{ fileId: string }>(`SELECT s."fileId" FROM parcel_scans s JOIN parcel_scan_sessions x ON x.id = s."sessionId" WHERE x."createdById" = $1 AND s."fileId" IS NOT NULL`, [OPS.id]);
  await sql(`DELETE FROM parcel_scan_sessions WHERE "createdById" = $1`, [OPS.id]);
  if (files.length) await sql(`DELETE FROM stored_files WHERE id = ANY($1::uuid[])`, [files.map(f => f.fileId)]);
  await fx.cleanup();
});

async function signIn(page: Page, user: TempUser) {
  for (let attempt = 0; ; attempt++) {
    await page.goto("/login");
    await page.waitForSelector("html.legacy-ready", { state: "attached" });
    await page.fill("#loginIdentity", user.login);
    await page.fill("#loginPassword", user.password);
    await page.click('form[data-form="login"] button[type="submit"]');
    const ok = await page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 15_000 }).then(() => true, () => false);
    if (ok) break;
    if (attempt >= 2 || !/too many/i.test(await page.content())) throw new Error(`Couldn't sign in as ${user.name}`);
    await page.waitForTimeout(61_000);
  }
  if (!/courier-operation/.test(page.url())) await page.goto("/courier-operation");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
}

test("a label photographed on the phone becomes an order row, is submitted through the importer and keeps its photo", async ({ page, browser }) => {
  await signIn(page, OPS);
  await opsNav(page, "newOrders");
  // The toolbar: Scan with phone next to Import Excel.
  const toolbar = page.locator("#mainContent .page-heading .heading-actions > :visible");
  await expect(toolbar.nth(1)).toHaveId("courierImport");
  await expect(toolbar.nth(2)).toHaveId("scanWithPhone");

  // ── Type and merchant, then the QR code and link ──
  await page.click("#scanWithPhone");
  await expect(page.locator("#dfScanTitle")).toHaveText("Scan with phone");
  await page.selectOption("#dfScanKind", "ecommerce");
  await page.click('[data-scan="start"]');
  await expect(page.locator("#dfScanError")).toHaveText("Choose the merchant.");
  await page.selectOption("#dfScanMerchant", shop.id);
  await page.click('[data-scan="start"]');
  await expect(page.locator("#dfScanQr svg")).toBeVisible();
  const link = await page.locator("#dfScanLink").inputValue();
  expect(link).toMatch(/\/scan\/[\w-]{30,}$/);
  await expect(page.locator("#dfScanEmpty")).toBeVisible();

  // ── The phone: the link (on this test machine through the same web address), a photo ──
  const phone = await browser.newContext({ ...devices["Pixel 7"] });
  const mobile = await phone.newPage();
  await mobile.goto(new URL(link).pathname);
  await expect(mobile.locator(".meta")).toContainText(`E-commerce · ${shop.name} · 0 sent`);
  await mobile.locator('input[type="file"][multiple]').setInputFiles({ name: "label.png", mimeType: "image/png", buffer: LABEL });
  await expect(mobile.locator(".list li").first()).toContainText("Parcel #1");
  await expect(mobile.locator(".list .state.sent")).toContainText("Sent", { timeout: 20_000 });

  // ── The computer: the row appears live and is read from the label ──
  const row = page.locator("#dfScanRows tr").first();
  await expect(row.locator("[data-scan-status]")).toHaveText("Read", { timeout: 60_000 });
  await expect(row.locator('[data-cell="recipient_phone"]')).toHaveValue("01712345678");
  await expect(row.locator('[data-cell="recipient_name"]')).toHaveValue("Rahim Uddin");
  await expect(row.locator('[data-cell="cod_amount"]')).toHaveValue("1250");
  await expect(row.locator('[data-scan="photo"] img')).toBeVisible();
  await expect(mobile.locator(".list .state.sent")).toContainText("Read", { timeout: 15_000 });

  // ── Edited in the table (saved as you type) ──
  await row.locator('[data-cell="recipient_name"]').fill("Rahim Uddin Khan");
  await expect
    .poll(async () => (await sql<{ name: string }>(`SELECT cells->>'recipient_name' AS name FROM parcel_scans s JOIN parcel_scan_sessions x ON x.id = s."sessionId" WHERE x."createdById" = $1`, [OPS.id]))[0]?.name)
    .toBe("Rahim Uddin Khan");

  // ── Submit: the import dialog with this merchant, then check and create ──
  await expect(page.locator("#dfScanSubmit")).toHaveText("Submit 1 order");
  await page.click("#dfScanSubmit");
  await expect(page.locator("#dfScanBackdrop")).toHaveCount(0);
  await expect(page.locator("#dfImportTitle")).toHaveText(/Import .* from Excel/);
  await expect(page.locator("#dfiMerchant")).toHaveValue(shop.id);
  await page.click('[data-dfi="check"]');
  await page.click('[data-dfi="commit"]', { timeout: 30_000 });
  await expect(page.locator("#dfiResultText")).toContainText("1 order created", { timeout: 60_000 });
  const [booked] = await sql<{ recipientName: string; fileId: string | null }>(
    `SELECT p."recipientName", s."fileId" FROM parcel_scans s JOIN parcels p ON p.id = s."parcelId" JOIN parcel_scan_sessions x ON x.id = s."sessionId" WHERE x."createdById" = $1`,
    [OPS.id],
  );
  expect(booked).toMatchObject({ recipientName: "Rahim Uddin Khan" });
  expect(booked.fileId).toBeTruthy();

  // ── The window closed with Submit: the phone link no longer works ──
  await mobile.reload();
  await expect(mobile.locator(".expired h1")).toHaveText("This link has expired");
  await phone.close();
});
