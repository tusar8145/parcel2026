import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { expect, Fixtures, opsNav, sql, test, type TempMerchant, type TempRider, type TempUser } from "./support";
// The API's own spreadsheet reader and writer: read the download, fill it in like Excel would.
import { readXlsx } from "../../../api/src/modules/imports/xlsx/xlsx-reader";
import { writeXlsx } from "../../../api/src/modules/imports/xlsx/xlsx-writer";

// Hub transfers (Courier Operations → Transfers, bridge-linehaul.js): the Gulshan hub operator downloads
// "Bulk transfer by Excel" (parcels at the hub for other hubs, destination prefilled from the recipient
// zone's serving hub), groups two parcels under a bag label, uploads, checks the preview, applies with
// "seal + new trip"; the truck departs; the Dhanmondi hub operator sees the inbound trip and receives one
// bag by scanning its label and the other bag's parcel by scanning its tracking ID.
// Every account, parcel, bag and trip is temporary and deleted afterwards (the audit log is kept).
const fx = new Fixtures();
let shop: TempMerchant;
let ops: TempUser;
let gulOp: TempUser;
let dhnOp: TempUser;
let rider: TempRider;
let gulshanId: string;

test.beforeAll(async () => {
  shop = await fx.merchant({ label: "Transfer Shop" });
  ops = await fx.staff("OPS_MANAGER");
  gulOp = await fx.staff("HUB_OPERATOR", "Gulshan Sorting Hub");
  dhnOp = await fx.staff("HUB_OPERATOR", "Dhanmondi Hub");
  rider = await fx.rider("Gulshan Sorting Hub");
  [{ id: gulshanId }] = await sql<{ id: string }>(`SELECT id FROM hubs WHERE name = 'Gulshan Sorting Hub'`);
});
test.afterAll(async () => {
  // The bags and trips the temporary operators made (fx.cleanup removes the parcels, bag items and scans).
  const users = [ops.id, gulOp.id, dhnOp.id];
  const bags = `SELECT id FROM linehaul_bags WHERE "createdById" = ANY($1::uuid[])`;
  const trips = `SELECT id FROM linehaul_trips WHERE "createdById" = ANY($1::uuid[])`;
  await sql(`DELETE FROM linehaul_discrepancies WHERE "bagId" IN (${bags}) OR "tripId" IN (${trips})`, [users]);
  await sql(`DELETE FROM linehaul_bag_items WHERE "bagId" IN (${bags})`, [users]);
  await sql(`DELETE FROM linehaul_bags WHERE "createdById" = ANY($1::uuid[])`, [users]);
  await sql(`DELETE FROM linehaul_trips WHERE "createdById" = ANY($1::uuid[])`, [users]);
  await fx.cleanup();
});

async function token(api: APIRequestContext, user: TempUser) {
  const res = await api.post("/api/v1/auth/login", { data: { identifier: user.login, password: user.password } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).accessToken as string;
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** Booked for Dhanmondi (served by Dhanmondi Hub) and collected to the Gulshan hub by the rider. */
async function atGulshan(api: APIRequestContext, recipient: string) {
  const [opsToken, riderToken] = [await token(api, ops), await token(api, rider)];
  const booked = await api.post("/api/v1/ops/parcels", {
    headers: auth(opsToken),
    data: { merchantId: shop.id, recipient: { name: recipient, phone: "01812000000" }, delivery: { category: "Home", street: "Road 7, Flat 3B", zone: "Dhanmondi", district: "Dhaka Central" }, serviceLevel: "Regular", weightKg: 1, codAmount: 500 },
  });
  expect(booked.status(), await booked.text()).toBe(201);
  const id = (await booked.json()).trackingId as string;
  expect((await api.post(`/api/v1/parcels/${id}/assign-pickup`, { headers: auth(opsToken), data: { riderId: rider.riderId } })).ok()).toBeTruthy();
  const res = await api.post(`/api/v1/rider/parcels/${id}/pickup`, { headers: auth(riderToken), data: { outcome: "COLLECTED_TO_HUB", hubId: gulshanId } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return id;
}

async function signIn(browser: Browser, user: TempUser, errors: string[]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
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
    const ok = await page.waitForURL(/\/courier-operation/, { timeout: 15_000 }).then(() => true, () => false);
    if (ok) break;
    if (attempt >= 2 || !/too many/i.test(await page.content())) await expect(page).toHaveURL(/\/courier-operation/);
    await page.waitForTimeout(61_000);
  }
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return page;
}

async function downloaded(page: Page, click: () => Promise<unknown>) {
  const [download] = await Promise.all([page.waitForEvent("download"), click()]);
  return fs.readFileSync((await download.path())!);
}

test("Transfers: bulk transfer by Excel → bags sealed on a new trip → depart → the destination hub receives a bag and a parcel by scan", async ({ browser, api }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  const ids = [await atGulshan(api, `Transfer A ${fx.stamp}`), await atGulshan(api, `Transfer B ${fx.stamp}`), await atGulshan(api, `Transfer C ${fx.stamp}`)];

  // ── Gulshan: Transfers → Bulk transfer by Excel (the action is preselected) ──
  const page = await signIn(browser, gulOp, errors);
  await opsNav(page, "transfers");
  await page.click("#lhBulkTransfer");
  await expect(page.locator("#dfImportTitle")).toHaveText("Bulk update Transfers by Excel");
  await expect(page.locator("#dfiActionInfo")).toContainText("Add to transfer bag");
  await page.selectOption("#dfiBMerchant", shop.id);
  const buffer = await downloaded(page, () => page.click("#dfiBDownload"));
  const sheet = readXlsx(buffer, { maxRows: 20_000 });
  expect(sheet.sheetName).toBe("Transfer to hub");
  const header = sheet.rows[0];
  const col = (name: string) => header.indexOf(name);
  const rows = sheet.rows.slice(1).map(r => header.map((_, i) => r[i] ?? ""));
  expect(rows.map(r => r[col("Tracking ID")]).sort()).toEqual([...ids].sort());
  for (const r of rows) expect(r[col("Destination hub")]).toBe("Dhanmondi Hub");
  const label = `E2E-${fx.stamp}`.slice(0, 30);
  for (const r of rows) if (r[col("Tracking ID")] !== ids[2]) r[col("Bag")] = label;
  const file = path.join(os.tmpdir(), `transfer-${fx.stamp}.xlsx`);
  fs.writeFileSync(file, writeXlsx({ sheets: [{ name: sheet.sheetName, rows: [header, ...rows] }] }));
  await page.setInputFiles("#dfiFile", file);
  await page.click('[data-dfi="check"]');
  await expect(page.locator("#dfImportSubtitle")).toContainText("Add to transfer bag · Transfers", { timeout: 30_000 });
  await expect(page.locator("#dfiRows tbody tr[data-status='READY']")).toHaveCount(3);

  // Apply options: seal + a new trip with a typed vehicle and the driver.
  await expect(page.locator("#dfiTransferOptions")).toBeVisible();
  await page.selectOption("#dfiTTrip", "new");
  await page.selectOption("#dfiTVehicle", "");
  await page.fill("#dfiTRegNo", `E2E ${fx.stamp}`);
  await page.fill("#dfiTDriver", "Karim Mia");
  await page.click('[data-dfi="commit"]');
  await expect(page.locator("#dfiTError")).toContainText("Driver phone");
  await page.fill("#dfiTPhone", "1711222333");
  await page.click('[data-dfi="commit"]');
  await expect(page.locator("#dfiResultText")).toContainText("3 rows applied", { timeout: 60_000 });
  const result = page.locator("#dfiTransferResult");
  await expect(result.locator("tbody tr[data-bag]")).toHaveCount(2);
  await expect(result).toContainText(label.toUpperCase());
  await expect(result).toContainText("Sealed");
  await expect(result.locator('[data-lh="print-manifest-n"]')).toHaveCount(1);
  await page.click('[data-dfi="close"]');

  const bags = await sql<{ number: string; label: string; status: string; tripId: string; parcels: string }>(
    `SELECT b.number, b.label, b.status, b."tripId", count(i.id)::text AS parcels FROM linehaul_bags b JOIN linehaul_bag_items i ON i."bagId" = b.id WHERE b."createdById" = $1 GROUP BY b.id ORDER BY b.number`,
    [gulOp.id],
  );
  expect(bags).toHaveLength(2);
  expect(bags.every(b => b.status === "SEALED" && b.tripId === bags[0].tripId)).toBe(true);
  const grouped = bags.find(b => b.label === label.toUpperCase())!;
  const single = bags.find(b => b !== grouped)!;
  expect(grouped.parcels).toBe("2");
  // Lifecycle unchanged until the truck leaves.
  expect((await sql<{ status: string }>(`SELECT DISTINCT status FROM parcels WHERE "trackingId" = ANY($1::text[])`, [ids])).map(r => r.status)).toEqual(["AT_HUB"]);
  const depart = await api.post(`/api/v1/linehaul/trips/${bags[0].tripId}/depart`, { headers: auth(await token(api, gulOp)) });
  expect(depart.ok(), await depart.text()).toBeTruthy();
  const trip = (await depart.json()).number as string;
  await page.context().close();

  // ── Dhanmondi: Inbound transfers, then receive by scan ──
  const desk = await signIn(browser, dhnOp, errors);
  await opsNav(desk, "transfersReceive");
  const inbound = desk.locator(`#lhInbound tr[data-trip="${trip}"]`);
  await expect(inbound).toContainText("3 expected · 0 received");
  await inbound.locator('[data-lh="recv-check"]').click();
  await expect(desk.locator("#lhRecvContext")).toHaveAttribute("data-trip", trip);

  // The grouped bag by its label: received whole.
  await desk.fill("#lhRecvScan", grouped.number);
  await desk.press("#lhRecvScan", "Enter");
  await expect(desk.locator("#lhRecvFeedback")).toHaveAttribute("data-outcome", "BAG_RECEIVED");
  await expect(desk.locator("#lhRecvScan")).toHaveAttribute("data-scan-result", "ok");
  // The other bag's parcel, one by one: it completes that bag.
  const [{ trackingId: last }] = await sql<{ trackingId: string }>(
    `SELECT p."trackingId" FROM linehaul_bag_items i JOIN linehaul_bags b ON b.id = i."bagId" JOIN parcels p ON p.id = i."parcelId" WHERE b.number = $1`,
    [single.number],
  );
  await desk.fill("#lhRecvScan", last);
  await desk.press("#lhRecvScan", "Enter");
  await expect(desk.locator("#lhRecvFeedback")).toHaveAttribute("data-outcome", "RECEIVED");
  await expect(desk.locator("#lhRecvFeedback")).toContainText(`${single.number} is complete`);
  await expect(desk.locator("#lhRecvCounts")).toContainText("Expected 3 · received 3 · missing 0 · still expected 0");
  // A code that isn't anything: the error beep / red flash.
  await desk.fill("#lhRecvScan", "PP-000000-ZZZZZ");
  await desk.press("#lhRecvScan", "Enter");
  await expect(desk.locator("#lhRecvFeedback")).toHaveAttribute("data-outcome", "NOT_FOUND");
  await expect(desk.locator("#lhRecvScan")).toHaveAttribute("data-scan-result", "error");
  await expect(desk.locator(`#lhInbound tr[data-trip="${trip}"] [data-col="counts"]`)).toContainText("3 expected · 3 received");

  const parcels = await sql<{ status: string; hub: string }>(`SELECT p.status, h.name AS hub FROM parcels p JOIN hubs h ON h.id = p."currentHubId" WHERE p."trackingId" = ANY($1::text[])`, [ids]);
  expect(parcels).toEqual(ids.map(() => ({ status: "AT_HUB", hub: "Dhanmondi Hub" })));
  fs.rmSync(file, { force: true });
  expect(errors).toEqual([]);
});
