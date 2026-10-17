import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Page } from "@playwright/test";
import { expect, Fixtures, headingAction, opsNav, sql, test, type TempMerchant, type TempRider, type TempUser } from "./support";
// The API's own spreadsheet reader and writer (no dependency): read the download, fill it in like Excel would.
import { readXlsx } from "../../../api/src/modules/imports/xlsx/xlsx-reader";
import { writeXlsx } from "../../../api/src/modules/imports/xlsx/xlsx-writer";

// Bulk operations by Excel in Courier Operations: filter the pending pickup requests, download them,
// accept two with a pickup rider (plus a row with an unknown rider), upload, check the preview,
// apply, see the parcels become "Pickup assigned" and download the row that wasn't applied.
// Every account and parcel is temporary (Fixtures) and deleted afterwards.
const fx = new Fixtures();
let shop: TempMerchant;
let ops: TempUser;
let rider: TempRider;

test.beforeAll(async () => {
  shop = await fx.merchant({ label: "Bulk Shop" });
  ops = await fx.user(`E2E-Ops-${fx.stamp} Test`, [{ role: "OPS_MANAGER" }]);
  rider = await fx.rider("Gulshan Sorting Hub");
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

async function downloaded(page: Page, click: () => Promise<unknown>) {
  const [download] = await Promise.all([page.waitForEvent("download"), click()]);
  return { name: download.suggestedFilename(), buffer: fs.readFileSync((await download.path())!) };
}

test("filter Pending → download → accept & assign riders in Excel → upload → preview → apply → Pickup assigned → rows not applied", async ({ page, api }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/status of 401|Failed to load resource|tile\.openstreetmap/.test(message.text())) errors.push(message.text());
  });

  // Three pickup requests from the temporary merchant, waiting for operations.
  const login = await api.post("/api/v1/auth/login", { data: { identifier: ops.login, password: ops.password } });
  expect(login.status()).toBe(200);
  const token = (await login.json()).accessToken as string;
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await api.post("/api/v1/ops/parcels", {
      headers: { authorization: `Bearer ${token}` },
      data: {
        merchantId: shop.id,
        recipient: { name: `Bulk E2E ${fx.stamp} ${i}`, phone: "01812000000" },
        delivery: { category: "Home", street: "Road 7, Flat 3B", zone: "Dhanmondi", district: "Dhaka Central" },
        serviceLevel: "Regular",
        weightKg: 1,
        codAmount: 500,
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    ids.push((await res.json()).trackingId);
  }

  await signIn(page, ops);
  await opsNav(page, "ecommerce");
  // All parcels: the full file with every action.
  await expect(page.locator("#courierBulkUpdate")).toHaveText("Bulk update All parcels by Excel");
  await page.click("#courierBulkUpdate");
  await expect(page.locator("#dfImportTitle")).toHaveText("Bulk update All parcels by Excel");
  await expect(page.locator("#dfiKindInfo li")).toHaveCount(10);
  await expect(page.locator("#dfiExport")).toContainText("Max 10,000 parcels per file");

  // ── 1. The "Pending operations confirmation" preset, narrowed to this merchant ──
  await page.click('[data-dfi="preset"][data-preset="pending_review"]');
  await expect(page.locator('[data-dfi="preset"][data-preset="pending_review"]')).toHaveAttribute("aria-pressed", "true");
  await page.selectOption("#dfiBMerchant", shop.id);
  const file = await downloaded(page, () => page.click("#dfiBDownload"));
  expect(file.name).toMatch(/^delivery-fast-bulk-update-\d{12}\.xlsx$/);
  await expect(page.locator("#dfiExportInfo")).toHaveText("Downloaded 3 parcels. Fill in an Action per parcel, save, and upload it below.");

  // ── 2. Fill it in: accept two with the rider, and one row with a rider that doesn't exist ──
  const sheet = readXlsx(file.buffer, { maxRows: 20_000, prefer: ["Parcels"] });
  const header = sheet.rows[0];
  const col = (name: string) => header.indexOf(name);
  const rows = sheet.rows.slice(1).map(r => header.map((_, i) => r[i] ?? ""));
  expect(rows.map(r => r[col("Tracking ID")])).toEqual(ids);
  expect(rows.every(r => r[col("Current status")] === "Pending operations confirmation" && r[col("SLA state")] === "Awaiting review")).toBe(true);
  const label = `${rider.code} · ${rider.name} · Gulshan Sorting Hub`;
  for (const [i, value] of [label, label, "R-0000 · Nobody"].entries()) {
    rows[i][col("Action")] = "Accept & assign pickup rider";
    rows[i][col("Rider")] = value;
  }
  const filled = path.join(os.tmpdir(), `bulk-${fx.stamp}.xlsx`);
  fs.writeFileSync(filled, writeXlsx({ sheets: [{ name: "Parcels", rows: [header, ...rows] }] }));

  // ── 3. Upload → server-side check → preview: 2 will apply, 1 error highlighted ──
  await page.setInputFiles("#dfiFile", filled);
  await page.click('[data-dfi="check"]');
  await expect(page.locator("#dfImportTitle")).toHaveText(`Preview · bulk-${fx.stamp}.xlsx`);
  await expect(page.locator('#dfiSummary [data-count="apply"]')).toHaveText("2 will apply");
  await expect(page.locator('#dfiSummary [data-count="errors"]')).toHaveText("1 with errors");
  const bad = page.locator(`#dfiRows tr[data-tracking="${ids[2]}"]`);
  await expect(bad.locator('td[data-col="rider"][data-invalid="true"]')).toHaveText("R-0000 · Nobody");
  await expect(bad).toContainText('Row 4 · Rider: Unknown rider "R-0000 · Nobody" (choose one from the list)');
  await page.click('[data-dfi="filter"][data-filter="error"]');
  await expect(page.locator("#dfiRows tbody tr")).toHaveCount(1);
  await page.click('[data-dfi="filter"][data-filter="apply"]');
  await expect(page.locator("#dfiRows tbody tr")).toHaveCount(2);
  // Nothing changed yet.
  expect((await sql<{ status: string }>(`SELECT status FROM parcels WHERE "trackingId" = ANY($1)`, [ids])).every(p => p.status === "PENDING_CONFIRMATION")).toBe(true);

  // ── 4. Apply → result ──
  await page.click('[data-dfi="commit"]');
  await expect(page.locator("#dfImportTitle")).toHaveText(/^Bulk update BLK-\d{6}-\d{3} finished$/);
  await expect(page.locator("#dfiResultText")).toHaveText("2 rows applied, 0 already done (skipped), 1 not applied.");
  const number = (await page.locator("#dfImportTitle").textContent())!.split(" ")[2];
  const stored = await sql<{ trackingId: string; status: string; pickupRiderId: string | null }>(`SELECT "trackingId", status, "pickupRiderId" FROM parcels WHERE "trackingId" = ANY($1) ORDER BY "trackingId"`, [ids]);
  const byId = new Map(stored.map(p => [p.trackingId, p]));
  expect(byId.get(ids[0])).toMatchObject({ status: "PICKUP_ASSIGNED", pickupRiderId: rider.riderId });
  expect(byId.get(ids[1])).toMatchObject({ status: "PICKUP_ASSIGNED", pickupRiderId: rider.riderId });
  expect(byId.get(ids[2])).toMatchObject({ status: "PENDING_CONFIRMATION", pickupRiderId: null });
  // Every change carries the bulk update's number in the audit log.
  const audits = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'parcel.status_change' AND data->'bulkUpdate'->>'number' = $1`, [number]);
  expect(audits[0].n).toBe(2);

  // ── 5. The row not applied, in the same format with an Error column ──
  const failed = await downloaded(page, () => page.click('[data-dfi="failed"]'));
  expect(failed.name).toBe(`${number}-not-applied.xlsx`);
  const back = readXlsx(failed.buffer, { maxRows: 100, prefer: ["Parcels"] });
  expect(back.rows[0].at(-1)).toBe("Error");
  expect(back.rows[1][0]).toBe(ids[2]);
  expect(back.rows[1].at(-1)).toBe('Row 4: Rider: Unknown rider "R-0000 · Nobody" (choose one from the list)');

  // ── 6. The shipment list shows them as "Pickup assigned" ──
  await page.click('[data-dfi="close"]');
  await expect(page.locator(`#shipmentBody tr[data-shipment-id="${ids[0]}"]`)).toContainText("Pickup assigned");
  await expect(page.locator(`#shipmentBody tr[data-shipment-id="${ids[1]}"]`)).toContainText("Pickup assigned");

  // History lists it with its download.
  await headingAction(page, "#courierBulkHistory");
  await expect(page.locator(`#dfiHistory tr[data-bulk="${number}"]`)).toContainText("Completed");
  await expect(page.locator(`#dfiHistory tr[data-bulk="${number}"] td[data-col="kind"]`)).toHaveText("All parcels bulk update");
  await page.click('[data-dfi="close"]');
  fs.rmSync(filled, { force: true });
  expect(errors).toEqual([]);
});

test("the preview re-prices rows that change the price: before → after per row and the total, charged as previewed", async ({ page, api }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/status of 401|Failed to load resource|tile\.openstreetmap/.test(message.text())) errors.push(message.text());
  });
  const login = await api.post("/api/v1/auth/login", { data: { identifier: ops.login, password: ops.password } });
  const headers = { authorization: `Bearer ${(await login.json()).accessToken}` };
  // A pickup request (→ drop-off) and a "Needs info" import row (→ completed with a heavier weight).
  const booked = await api.post("/api/v1/ops/parcels", {
    headers,
    data: { merchantId: shop.id, recipient: { name: `Reprice E2E ${fx.stamp}`, phone: "01812000000" }, delivery: { category: "Home", street: "Road 7, Flat 3B", zone: "Dhanmondi", district: "Dhaka Central" }, serviceLevel: "Regular", weightKg: 1, codAmount: 500 },
  });
  expect(booked.status(), await booked.text()).toBe(201);
  const pickup = (await booked.json()).trackingId as string;
  const ref = `RP-${fx.stamp}`;
  const checkedImport = await api.post("/api/v1/imports/validate", { headers, data: { kind: "ecommerce", merchantId: shop.id, rows: [{ order_ref: ref, phone: "01812000000" }] } });
  expect(checkedImport.status(), await checkedImport.text()).toBe(201);
  expect((await api.post(`/api/v1/imports/${(await checkedImport.json()).id}/commit`, { headers })).ok()).toBe(true);
  const [needs] = await sql<{ trackingId: string }>(`SELECT "trackingId" FROM parcels WHERE "merchantOrderRef" = $1`, [ref]);
  const charge = async (id: string) => Number((await sql<{ totalCharge: string }>(`SELECT "totalCharge" FROM parcels WHERE "trackingId" = $1`, [id]))[0].totalCharge);
  const before = { pickup: await charge(pickup), needs: await charge(needs.trackingId) };

  await signIn(page, ops);
  await opsNav(page, "ecommerce");
  await page.click("#courierBulkUpdate");
  await page.selectOption("#dfiBMerchant", shop.id);
  const file = await downloaded(page, () => page.click("#dfiBDownload"));
  const sheet = readXlsx(file.buffer, { maxRows: 20_000, prefer: ["Parcels"] });
  const header = sheet.rows[0];
  const rows = sheet.rows.slice(1).map(r => header.map((_, i) => r[i] ?? ""));
  const set = (id: string, values: Record<string, string>) => {
    const row = rows.find(r => r[header.indexOf("Tracking ID")] === id)!;
    for (const [k, v] of Object.entries(values)) row[header.indexOf(k)] = v;
  };
  set(pickup, { Action: "Change to drop-off", Hub: "Gulshan Sorting Hub" });
  set(needs.trackingId, { Action: "Complete details", "Set recipient name": "Nabila Ahmed", "Set address": "Road 7", "Set district": "Dhaka Central", "Set zone": "Dhanmondi", "Set weight (kg)": "4.2" });
  const filled = path.join(os.tmpdir(), `reprice-${fx.stamp}.xlsx`);
  fs.writeFileSync(filled, writeXlsx({ sheets: [{ name: "Parcels", rows: [header, ...rows.filter(r => [pickup, needs.trackingId].includes(r[header.indexOf("Tracking ID")]))] }] }));
  await page.setInputFiles("#dfiFile", filled);
  await page.click('[data-dfi="check"]');
  await expect(page.locator('#dfiSummary [data-count="apply"]')).toHaveText("2 will apply");

  // Per row: the charge now → after the change (same engine as the single actions).
  const priceCell = (id: string) => page.locator(`#dfiRows tr[data-tracking="${id}"] td[data-col="price"]`);
  await expect(priceCell(pickup)).toHaveAttribute("data-price-before", String(before.pickup));
  await expect(priceCell(needs.trackingId)).toHaveAttribute("data-price-before", String(before.needs));
  const after = { pickup: Number(await priceCell(pickup).getAttribute("data-price-after")), needs: Number(await priceCell(needs.trackingId).getAttribute("data-price-after")) };
  expect(after.needs).toBeGreaterThan(before.needs); // 4.2 kg instead of the default weight
  await expect(priceCell(needs.trackingId)).toContainText(`৳${before.needs.toLocaleString("en-BD")} → ৳${after.needs.toLocaleString("en-BD")} (+৳${(after.needs - before.needs).toLocaleString("en-BD")})`);
  // The total difference before Apply.
  const diff = after.pickup + after.needs - before.pickup - before.needs;
  await expect(page.locator('#dfiSummary [data-count="price"]')).toHaveText(
    `Re-priced: ৳${(before.pickup + before.needs).toLocaleString("en-BD")} → ৳${(after.pickup + after.needs).toLocaleString("en-BD")} (${diff > 0 ? "+" : diff < 0 ? "−" : "±"}৳${Math.abs(diff).toLocaleString("en-BD")}) on 2 rows`,
  );
  expect(await charge(needs.trackingId)).toBe(before.needs); // nothing changed yet

  await page.click('[data-dfi="commit"]');
  await expect(page.locator("#dfiResultText")).toHaveText("2 rows applied, 0 already done (skipped), 0 not applied.");
  expect(await charge(pickup)).toBe(after.pickup);
  expect(await charge(needs.trackingId)).toBe(after.needs);
  await page.click('[data-dfi="close"]');
  fs.rmSync(filled, { force: true });
  expect(errors).toEqual([]);
});

/** Fills in a downloaded bulk file: values per tracking ID; keeps only those rows. */
function fill(buffer: Buffer, values: Record<string, Record<string, string>>, name: string) {
  const sheet = readXlsx(buffer, { maxRows: 20_000, prefer: ["Parcels"] });
  const header = sheet.rows[0];
  const rows = sheet.rows.slice(1).map(r => header.map((_, i) => r[i] ?? ""));
  const kept = rows.filter(r => values[r[header.indexOf("Tracking ID")]]);
  for (const r of kept) for (const [k, v] of Object.entries(values[r[header.indexOf("Tracking ID")]])) r[header.indexOf(k)] = v;
  expect(kept).toHaveLength(Object.keys(values).length);
  const file = path.join(os.tmpdir(), `${name}-${fx.stamp}.xlsx`);
  fs.writeFileSync(file, writeXlsx({ sheets: [{ name: "Parcels", rows: [header, ...kept] }] }));
  return { file, header };
}

test("each page has its own bulk file: New orders accepts & assigns, Delivery refuses the New orders file and assigns, Problems resolves; history by page", async ({ page, api }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/status of 401|status of 422|Failed to load resource|tile\.openstreetmap/.test(message.text())) errors.push(message.text());
  });
  const login = await api.post("/api/v1/auth/login", { data: { identifier: ops.login, password: ops.password } });
  const headers = { authorization: `Bearer ${(await login.json()).accessToken}` };
  const book = async (i: string) => {
    const res = await api.post("/api/v1/ops/parcels", {
      headers,
      data: { merchantId: shop.id, recipient: { name: `Kinds E2E ${fx.stamp} ${i}`, phone: "01812000000" }, delivery: { category: "Home", street: "Road 7, Flat 3B", zone: "Dhanmondi", district: "Dhaka Central" }, serviceLevel: "Regular", weightKg: 1, codAmount: 500 },
    });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()).trackingId as string;
  };
  const [hub] = await sql<{ id: string }>(`SELECT id FROM hubs WHERE name = 'Gulshan Sorting Hub'`);
  const toHub = async (id: string) => {
    expect((await api.post(`/api/v1/parcels/${id}/assign-pickup`, { headers, data: { riderId: rider.riderId } })).status()).toBe(200);
    expect((await api.post(`/api/v1/parcels/${id}/status`, { headers, data: { status: "PICKED_UP" } })).status()).toBe(200);
    expect((await api.post(`/api/v1/parcels/${id}/status`, { headers, data: { status: "AT_HUB", hubId: hub.id } })).status()).toBe(200);
  };
  const pending = await book("new");
  const hubbed = await book("delivery");
  await toHub(hubbed);
  const stuck = await book("problem");
  await toHub(stuck);
  expect((await api.post(`/api/v1/parcels/${stuck}/status`, { headers, data: { status: "EXCEPTION", note: "Label torn" } })).status()).toBe(200);
  const statusOf = async (id: string) => (await sql<{ status: string; pickupRiderId: string | null; deliveryRiderId: string | null }>(`SELECT status, "pickupRiderId", "deliveryRiderId" FROM parcels WHERE "trackingId" = $1`, [id]))[0];
  const riderLabel = `${rider.code} · ${rider.name} · Gulshan Sorting Hub`;
  const files: string[] = [];

  await signIn(page, ops);

  // ── New orders: only its actions; accept & assign the pickup rider ──
  await opsNav(page, "newOrders");
  await expect(page.locator("#stageBulkUpdate")).toHaveText("Bulk update New orders by Excel");
  await page.click("#stageBulkUpdate");
  await expect(page.locator("#dfImportTitle")).toHaveText("Bulk update New orders by Excel");
  await expect(page.locator("#dfiKindInfo")).toContainText("New orders bulk update · what this file can do");
  await expect(page.locator("#dfiKindInfo li")).toHaveText([/^Accept & assign pickup rider:/, /^Cancel:/, /^Change to drop-off:/, /^Change to rider pickup:/, /^Complete details:/, /^Add note:/]);
  await page.selectOption("#dfiBMerchant", shop.id);
  const newFile = await downloaded(page, () => page.click("#dfiBDownload"));
  expect(newFile.name).toMatch(/^delivery-fast-new-orders-bulk-update-\d{12}\.xlsx$/);
  const lists = readXlsx(newFile.buffer, { maxRows: 20_000, prefer: ["Lists"] });
  expect(lists.rows.slice(1).map(r => r[lists.rows[0].indexOf("Actions")]).filter(Boolean)).toEqual(["Accept & assign pickup rider", "Cancel", "Change to drop-off", "Change to rider pickup", "Complete details", "Add note"]);
  const n = fill(newFile.buffer, { [pending]: { Action: "Accept & assign pickup rider", Rider: riderLabel } }, "kinds-new");
  files.push(n.file);
  expect(n.header).not.toContain("New status");
  await page.setInputFiles("#dfiFile", n.file);
  await page.click('[data-dfi="check"]');
  await expect(page.locator('#dfiSummary [data-count="apply"]')).toHaveText("1 will apply");
  await expect(page.locator("#dfImportSubtitle")).toContainText("New orders bulk update");
  await page.click('[data-dfi="commit"]');
  await expect(page.locator("#dfiResultText")).toHaveText("1 row applied, 0 already done (skipped), 0 not applied.");
  expect(await statusOf(pending)).toMatchObject({ status: "PICKUP_ASSIGNED", pickupRiderId: rider.riderId });
  await page.click('[data-dfi="close"]');

  // ── Delivery: the New orders file is refused; its own file assigns the delivery rider ──
  await opsNav(page, "delivery");
  await expect(page.locator("#stageBulkUpdate")).toHaveText("Bulk update Delivery by Excel");
  await page.click("#stageBulkUpdate");
  await expect(page.locator("#dfiKindInfo li")).toHaveText([/^Assign delivery rider:/, /^Complete details:/, /^Add note:/]);
  await page.setInputFiles("#dfiFile", n.file);
  await page.click('[data-dfi="check"]');
  await expect(page.locator("#dfiMessage")).toHaveText("This is the New orders file. Upload it on the New orders page (or All parcels), or download the Delivery file here and fill that in.");
  await page.selectOption("#dfiBMerchant", shop.id);
  const deliveryFile = await downloaded(page, () => page.click("#dfiBDownload"));
  expect(deliveryFile.name).toMatch(/^delivery-fast-delivery-bulk-update-\d{12}\.xlsx$/);
  const d = fill(deliveryFile.buffer, { [hubbed]: { Action: "Assign delivery rider", Rider: riderLabel } }, "kinds-delivery");
  files.push(d.file);
  await page.setInputFiles("#dfiFile", d.file);
  await page.click('[data-dfi="check"]');
  await expect(page.locator('#dfiSummary [data-count="apply"]')).toHaveText("1 will apply");
  await page.click('[data-dfi="commit"]');
  await expect(page.locator("#dfiResultText")).toHaveText("1 row applied, 0 already done (skipped), 0 not applied.");
  expect(await statusOf(hubbed)).toMatchObject({ status: "ASSIGNED", deliveryRiderId: rider.riderId });
  await page.click('[data-dfi="close"]');

  // ── Problems › Exceptions: resolve back to the hub ──
  await opsNav(page, "exceptions");
  await expect(page.locator("#stageBulkUpdate")).toHaveText("Bulk update Problems by Excel");
  await page.click("#stageBulkUpdate");
  await expect(page.locator("#dfiKindInfo li")).toHaveText([/^Resolve: change status:/, /^Assign delivery rider:/, /^Schedule return:/, /^Complete details:/, /^Add note:/]);
  await page.selectOption("#dfiBMerchant", shop.id);
  const problemsFile = await downloaded(page, () => page.click("#dfiBDownload"));
  const p = fill(problemsFile.buffer, { [stuck]: { Action: "Resolve: change status", "New status": "At hub" } }, "kinds-problems");
  files.push(p.file);
  await page.setInputFiles("#dfiFile", p.file);
  await page.click('[data-dfi="check"]');
  await expect(page.locator('#dfiSummary [data-count="apply"]')).toHaveText("1 will apply");
  await page.click('[data-dfi="commit"]');
  await expect(page.locator("#dfiResultText")).toHaveText("1 row applied, 0 already done (skipped), 0 not applied.");
  expect((await statusOf(stuck)).status).toBe("AT_HUB");
  const number = (await page.locator("#dfImportTitle").textContent())!.split(" ")[2];

  // History starts with this page's bulk updates and can show every page's.
  await page.click('[data-dfi="history"]');
  await expect(page.locator("#dfiHKind")).toHaveValue("problems");
  await expect(page.locator(`#dfiHistory tr[data-bulk="${number}"] td[data-col="kind"]`)).toHaveText("Problems bulk update");
  await expect(page.locator('#dfiHistory tbody tr[data-kind]:not([data-kind="problems"])')).toHaveCount(0);
  await page.selectOption("#dfiHKind", "new_orders");
  await expect(page.locator(`#dfiHistory tr[data-bulk="${number}"]`)).toHaveCount(0);
  await expect(page.locator('#dfiHistory tbody tr[data-kind="new_orders"]').first()).toBeVisible();
  await page.click('[data-dfi="close"]');

  // Transfers has no bulk file (transfers go through linehaul bags).
  await opsNav(page, "transfers");
  await expect(page.locator("#stageBulkUpdate")).toHaveCount(0);
  for (const f of files) fs.rmSync(f, { force: true });
  expect(errors).toEqual([]);
});
