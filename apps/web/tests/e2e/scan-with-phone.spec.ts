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
  // With the local vision AI on (SCAN_AI_URL), reading one photo takes a few minutes on a CPU.
  test.setTimeout(15 * 60_000);
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
  await expect(row.locator("[data-scan-status]")).toHaveText("Read", { timeout: 10 * 60_000 });
  await expect(row.locator('[data-cell="recipient_phone"]')).toHaveValue("01712345678");
  await expect(row.locator('[data-cell="recipient_name"]')).toHaveValue("Rahim Uddin");
  await expect(row.locator('[data-cell="cod_amount"]')).toHaveValue("1250");
  await expect(row.locator('[data-scan="photo"] img')).toBeVisible();
  await expect(mobile.locator(".list .state.sent")).toContainText("Read", { timeout: 30_000 });

  // ── District / zone / area are dropdowns of the catalog, linked: the zones of the district, the areas
  //    of the zone; a new district clears a zone outside it; with no district, any zone (it brings its district) ──
  const district = row.locator('select[data-cell="district"]');
  const zone = row.locator('select[data-cell="zone"]');
  const area = row.locator('select[data-cell="area"]');
  const opts = { timeout: 15_000 };
  await expect(district).toHaveValue("Dhaka Central");
  await expect(zone).toHaveValue("Dhanmondi");
  await expect(zone.locator("option", { hasText: /^Banani$/ })).toHaveCount(0); // a Dhaka North zone
  await district.selectOption("Dhaka North", opts);
  await expect(zone).toHaveValue("");
  await zone.selectOption("Banani", opts);
  await expect(area.locator("option", { hasText: "Banani Block C" })).toHaveCount(1);
  await area.selectOption("Banani Block C", opts);
  await expect(area).toHaveValue("Banani Block C");
  await district.selectOption("", opts);
  await expect(zone).toHaveValue("");
  await expect(area).toHaveValue("");
  await zone.selectOption("Mirpur", opts);
  await expect(district).toHaveValue("Dhaka Central");
  await area.selectOption("Mirpur 10", opts);
  await expect
    .poll(async () => (await sql<{ d: string; z: string; a: string }>(`SELECT cells->>'district' d, cells->>'zone' z, cells->>'area' a FROM parcel_scans s JOIN parcel_scan_sessions x ON x.id = s."sessionId" WHERE x."createdById" = $1`, [OPS.id]))[0])
    .toEqual({ d: "Dhaka Central", z: "Mirpur", a: "Mirpur 10" });
  if (process.env.SCAN_SHOT) await page.screenshot({ path: process.env.SCAN_SHOT.replace(".png", "-places.png") });

  // ── The photo beside the rows: a click shows it in the left panel (no new tab); pointing at it zooms in;
  //    "Keep text shown" shows the text read from it ──
  await row.locator('[data-scan="photo"]').click();
  await expect(page.locator("#dfScanPhotoView")).toBeVisible();
  await expect(page.locator("#dfScanQrView")).toBeHidden();
  const pic = page.locator("#dfScanPicImg");
  await expect(pic).toBeVisible();
  await expect(row).toHaveClass(/df-scan-viewing/);
  expect(page.context().pages()).toHaveLength(1);
  const ocr = page.locator("#dfScanOcr");
  const box = (await page.locator("#dfScanPic").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await expect(pic).toHaveAttribute("style", /scale\(2\.5\)/);
  await expect(ocr).toBeHidden();
  if (process.env.SCAN_SHOT) await page.screenshot({ path: process.env.SCAN_SHOT.replace(".png", "-zoom.png") });
  await page.mouse.move(0, 0);
  await expect(pic).not.toHaveAttribute("style", /scale/);
  await page.click('[data-scan="pin-text"]');
  await expect(ocr).toBeVisible();
  await expect(ocr).toContainText("Rahim Uddin");
  await expect(ocr).toContainText("01712-345678");
  if (process.env.SCAN_SHOT) await page.screenshot({ path: process.env.SCAN_SHOT });
  await page.click('[data-scan="pin-text"]');
  await expect(ocr).toBeHidden();
  // Turn: the image itself is turned (a new picture), so zooming still follows the mouse.
  const before = await pic.getAttribute("src");
  await page.click('[data-scan="turn"]');
  await expect(page.locator("#dfScanPicImg")).not.toHaveAttribute("src", before!);
  await page.click('[data-scan="qr"]');
  await expect(page.locator("#dfScanQrView")).toBeVisible();

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
