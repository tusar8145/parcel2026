import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Page } from "@playwright/test";
import { expect, Fixtures, headingAction, opsNav, sql, test, type TempMerchant, type TempRider, type TempUser } from "./support";
// The API's own spreadsheet reader and writer (no dependency): read the download, fill it in like Excel would.
import { readXlsx } from "../../../api/src/modules/imports/xlsx/xlsx-reader";
import { writeXlsx } from "../../../api/src/modules/imports/xlsx/xlsx-writer";

// Bulk operations by Excel in Courier Operations, one file per action: on a page choose an action
// ("Accept & assign pickup rider"), download its file (only the parcels that can take it, only the
// columns it needs, no Action column), fill it in, upload, check the preview, apply.
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

/** The data sheet of an action file: header, rows, a column by header (with or without the required "*"). */
function sheetOf(buffer: Buffer) {
  const sheet = readXlsx(buffer, { maxRows: 20_000 });
  const header = sheet.rows[0];
  const rows = sheet.rows.slice(1).map(r => header.map((_, i) => r[i] ?? ""));
  const col = (name: string) => header.findIndex(h => h === name || h === `${name} *`);
  return { name: sheet.sheetName, header, rows, col };
}

/** Fills in a downloaded action file: values per tracking ID; keeps only those rows. */
function fill(buffer: Buffer, values: Record<string, Record<string, string>>, name: string) {
  const { name: sheetName, header, rows, col } = sheetOf(buffer);
  const kept = rows.filter(r => values[r[col("Tracking ID")]]);
  for (const r of kept) for (const [k, v] of Object.entries(values[r[col("Tracking ID")]])) r[col(k)] = v;
  expect(kept).toHaveLength(Object.keys(values).length);
  const file = path.join(os.tmpdir(), `${name}-${fx.stamp}.xlsx`);
  fs.writeFileSync(file, writeXlsx({ sheets: [{ name: sheetName, rows: [header, ...kept] }] }));
  return { file, header };
}

const consoleErrors = (page: Page, allow = /status of 401|Failed to load resource|tile\.openstreetmap/) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !allow.test(message.text())) errors.push(message.text());
  });
  return errors;
};

test("New orders → choose Accept & assign → download → 2 riders + 1 invalid in Excel → upload → preview → apply → Pickup assigned → rows not applied", async ({ page, api }) => {
  test.setTimeout(240_000);
  const errors = consoleErrors(page);

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
  await opsNav(page, "newOrders");
  await expect(page.locator("#stageBulkUpdate")).toHaveText("Bulk update New orders by Excel");
  await page.click("#stageBulkUpdate");
  await expect(page.locator("#dfImportTitle")).toHaveText("Bulk update New orders by Excel");

  // ── 1. Choose an action: the page's actions, each with a line and the parcels that can take it ──
  const actions = page.locator('#dfiActions [data-dfi="pick-action"]');
  await expect(actions).toHaveCount(6);
  await expect(actions.locator("strong")).toHaveText(["Accept & assign pickup rider", "Cancel", "Change to drop-off", "Change to rider pickup", "Complete details", "Add note"]);
  await expect(page.locator('#dfiActions [data-count="accept_pickup"]')).toHaveText(/^[\d,]+ parcels?$/);
  await page.click('[data-dfi="pick-action"][data-action="accept_pickup"]');
  await expect(page.locator("#dfiActionInfo")).toContainText("Accept & assign pickup rider · New orders");
  await expect(page.locator("#dfiActionInfo")).toContainText("leave Rider empty to accept the suggested rider; delete rows you don't want to change");
  await expect(page.locator("#dfiActionInfo")).toContainText("Columns to fill in: Rider, Hub, Priority, Note");

  // ── 2. Download the "Accept & assign" file for this merchant ──
  await page.selectOption("#dfiBMerchant", shop.id);
  const file = await downloaded(page, () => page.click("#dfiBDownload"));
  expect(file.name).toMatch(/^delivery-fast-new-orders-accept-pickup-\d{12}\.xlsx$/);
  await expect(page.locator("#dfiExportInfo")).toHaveText("Downloaded 3 parcels. Delete the rows you don't want to change, save, and upload it below.");
  const sheet = sheetOf(file.buffer);
  expect(sheet.name).toBe("Accept & assign pickup");
  expect(sheet.header).not.toContain("Action");
  expect(sheet.header.slice(0, 7)).toEqual(["Tracking ID", "Current status", "Suggested rider", "Rider", "Hub", "Priority", "Note"]);
  expect(sheet.rows.map(r => r[sheet.col("Tracking ID")])).toEqual(ids);
  expect(sheet.rows.every(r => r[sheet.col("template")] === "new_orders:accept_pickup")).toBe(true);
  expect(readXlsx(file.buffer, { maxRows: 100, prefer: ["Instructions"] }).rows[0][0]).toBe("Delivery Fast · Accept & assign pickup rider · New orders");

  // ── 3. Fill it in: two rows with the rider, one with a rider that doesn't exist ──
  const label = `${rider.code} · ${rider.name} · Gulshan Sorting Hub`;
  const filled = fill(file.buffer, { [ids[0]]: { Rider: label }, [ids[1]]: { Rider: label, Priority: "High" }, [ids[2]]: { Rider: "R-0000 · Nobody" } }, "bulk-accept");

  // ── 4. Upload → server-side check → preview: 2 will apply, 1 error highlighted ──
  await page.setInputFiles("#dfiFile", filled.file);
  await page.click('[data-dfi="check"]');
  await expect(page.locator("#dfImportTitle")).toHaveText(`Preview · bulk-accept-${fx.stamp}.xlsx`);
  await expect(page.locator("#dfImportSubtitle")).toContainText("Accept & assign pickup rider · New orders");
  await expect(page.locator('#dfiSummary [data-count="apply"]')).toHaveText("2 will apply");
  await expect(page.locator('#dfiSummary [data-count="errors"]')).toHaveText("1 with errors");
  const bad = page.locator(`#dfiRows tr[data-tracking="${ids[2]}"]`);
  await expect(bad.locator('td[data-col="rider"][data-invalid="true"]')).toHaveText("R-0000 · Nobody");
  await expect(bad).toContainText('Row 4 · Rider: Unknown rider "R-0000 · Nobody" (choose one from the list)');
  await expect(page.locator("#dfiRows thead")).not.toContainText("ACTION");
  await page.click('[data-dfi="filter"][data-filter="error"]');
  await expect(page.locator("#dfiRows tbody tr")).toHaveCount(1);
  await page.click('[data-dfi="filter"][data-filter="apply"]');
  await expect(page.locator("#dfiRows tbody tr")).toHaveCount(2);
  expect((await sql<{ status: string }>(`SELECT status FROM parcels WHERE "trackingId" = ANY($1)`, [ids])).every(p => p.status === "PENDING_CONFIRMATION")).toBe(true);

  // ── 5. Apply → result ──
  await page.click('[data-dfi="commit"]');
  await expect(page.locator("#dfImportTitle")).toHaveText(/^Bulk update BLK-\d{6}-\d{3} finished$/);
  await expect(page.locator("#dfiResultText")).toHaveText("2 rows applied, 0 already done (skipped), 1 not applied.");
  const number = (await page.locator("#dfImportTitle").textContent())!.split(" ")[2];
  const stored = await sql<{ trackingId: string; status: string; pickupRiderId: string | null }>(`SELECT "trackingId", status, "pickupRiderId" FROM parcels WHERE "trackingId" = ANY($1)`, [ids]);
  const byId = new Map(stored.map(p => [p.trackingId, p]));
  expect(byId.get(ids[0])).toMatchObject({ status: "PICKUP_ASSIGNED", pickupRiderId: rider.riderId });
  expect(byId.get(ids[1])).toMatchObject({ status: "PICKUP_ASSIGNED", pickupRiderId: rider.riderId });
  expect(byId.get(ids[2])).toMatchObject({ status: "PENDING_CONFIRMATION", pickupRiderId: null });
  const audits = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'parcel.status_change' AND data->'bulkUpdate'->>'number' = $1`, [number]);
  expect(audits[0].n).toBe(2);
  const [job] = await sql<{ kind: string; action: string }>(`SELECT kind, action FROM bulk_update_jobs WHERE number = $1`, [number]);
  expect(job).toEqual({ kind: "new_orders", action: "accept_pickup" });

  // ── 6. The row not applied, in the same action's format with an Error column ──
  const failed = await downloaded(page, () => page.click('[data-dfi="failed"]'));
  expect(failed.name).toBe(`${number}-not-applied.xlsx`);
  const back = sheetOf(failed.buffer);
  expect(back.name).toBe("Accept & assign pickup");
  expect(back.header).toEqual([...sheet.header, "Error"]);
  expect(back.rows[0][0]).toBe(ids[2]);
  expect(back.rows[0].at(-1)).toBe('Row 4: Rider: Unknown rider "R-0000 · Nobody" (choose one from the list)');

  // History: the action and the page.
  await page.click('[data-dfi="history"]');
  await expect(page.locator(`#dfiHistory tr[data-bulk="${number}"] td[data-col="kind"]`)).toHaveText("Accept & assign pickup rider · New orders");
  await page.selectOption("#dfiHAction", "cancel");
  await expect(page.locator(`#dfiHistory tr[data-bulk="${number}"]`)).toHaveCount(0);
  await page.selectOption("#dfiHAction", "accept_pickup");
  await expect(page.locator(`#dfiHistory tr[data-bulk="${number}"]`)).toContainText("Completed");
  await page.click('[data-dfi="close"]');
  fs.rmSync(filled.file, { force: true });
  expect(errors).toEqual([]);
});

test("All parcels: the preview re-prices Change to drop-off and Complete details rows (before → after and the total), charged as previewed", async ({ page, api }) => {
  test.setTimeout(240_000);
  const errors = consoleErrors(page);
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
  const files: string[] = [];

  await signIn(page, ops);
  await opsNav(page, "ecommerce");
  await expect(page.locator("#courierBulkUpdate")).toHaveText("Bulk update All parcels by Excel");
  await page.click("#courierBulkUpdate");
  // All parcels offers every action.
  await expect(page.locator('#dfiActions [data-dfi="pick-action"]')).toHaveCount(14);

  // ── Change to drop-off: a cheaper or dearer first mile, per row and in total ──
  await page.click('[data-dfi="pick-action"][data-action="to_drop_off"]');
  await page.selectOption("#dfiBMerchant", shop.id);
  const dropFile = await downloaded(page, () => page.click("#dfiBDownload"));
  expect(sheetOf(dropFile.buffer).header.slice(0, 4)).toEqual(["Tracking ID", "Current status", "New drop-off hub", "Note"]);
  const d = fill(dropFile.buffer, { [pickup]: { "New drop-off hub": "Gulshan Sorting Hub" } }, "reprice-drop");
  files.push(d.file);
  await page.setInputFiles("#dfiFile", d.file);
  await page.click('[data-dfi="check"]');
  await expect(page.locator('#dfiSummary [data-count="apply"]')).toHaveText("1 will apply");
  const priceCell = (id: string) => page.locator(`#dfiRows tr[data-tracking="${id}"] td[data-col="price"]`);
  await expect(priceCell(pickup)).toHaveAttribute("data-price-before", String(before.pickup));
  const afterPickup = Number(await priceCell(pickup).getAttribute("data-price-after"));
  const diffPickup = afterPickup - before.pickup;
  await expect(page.locator('#dfiSummary [data-count="price"]')).toHaveText(
    `Re-priced: ৳${before.pickup.toLocaleString("en-BD")} → ৳${afterPickup.toLocaleString("en-BD")} (${diffPickup > 0 ? "+" : diffPickup < 0 ? "−" : "±"}৳${Math.abs(diffPickup).toLocaleString("en-BD")}) on 1 row`,
  );
  await page.click('[data-dfi="commit"]');
  await expect(page.locator("#dfiResultText")).toHaveText("1 row applied, 0 already done (skipped), 0 not applied.");
  expect(await charge(pickup)).toBe(afterPickup);

  // ── Complete details: a heavier weight costs more ──
  await page.click('[data-dfi="close"]');
  await page.click("#courierBulkUpdate");
  await page.click('[data-dfi="pick-action"][data-action="complete_details"]');
  await expect(page.locator("#dfiActionInfo")).toContainText("Set zone follows Set district");
  await page.selectOption("#dfiBMerchant", shop.id);
  const completeFile = await downloaded(page, () => page.click("#dfiBDownload"));
  const c = fill(completeFile.buffer, { [needs.trackingId]: { "Set recipient name": "Nabila Ahmed", "Set address": "Road 7", "Set district": "Dhaka Central", "Set zone": "Dhanmondi", "Set weight (kg)": "4.2" } }, "reprice-complete");
  files.push(c.file);
  await page.setInputFiles("#dfiFile", c.file);
  await page.click('[data-dfi="check"]');
  await expect(page.locator('#dfiSummary [data-count="apply"]')).toHaveText("1 will apply");
  await expect(priceCell(needs.trackingId)).toHaveAttribute("data-price-before", String(before.needs));
  const afterNeeds = Number(await priceCell(needs.trackingId).getAttribute("data-price-after"));
  expect(afterNeeds).toBeGreaterThan(before.needs); // 4.2 kg instead of the default weight
  await expect(priceCell(needs.trackingId)).toContainText(`৳${before.needs.toLocaleString("en-BD")} → ৳${afterNeeds.toLocaleString("en-BD")} (+৳${(afterNeeds - before.needs).toLocaleString("en-BD")})`);
  expect(await charge(needs.trackingId)).toBe(before.needs); // nothing changed yet
  await page.click('[data-dfi="commit"]');
  await expect(page.locator("#dfiResultText")).toHaveText("1 row applied, 0 already done (skipped), 0 not applied.");
  expect(await charge(needs.trackingId)).toBe(afterNeeds);
  await page.click('[data-dfi="close"]');
  for (const f of files) fs.rmSync(f, { force: true });
  expect(errors).toEqual([]);
});

test("each page offers its own actions: Delivery refuses the New orders file and assigns, Problems schedules a return; history by page and action", async ({ page, api }) => {
  test.setTimeout(300_000);
  const errors = consoleErrors(page, /status of 401|status of 422|Failed to load resource|tile\.openstreetmap/);
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
  expect((await api.post(`/api/v1/parcels/${stuck}/status`, { headers, data: { status: "EXCEPTION", note: "Recipient refused" } })).status()).toBe(200);
  const statusOf = async (id: string) => (await sql<{ status: string; deliveryRiderId: string | null; returnReason: string | null }>(`SELECT status, "deliveryRiderId", "returnReason" FROM parcels WHERE "trackingId" = $1`, [id]))[0];
  const riderLabel = `${rider.code} · ${rider.name} · Gulshan Sorting Hub`;
  const files: string[] = [];

  await signIn(page, ops);

  // ── New orders: a Cancel file for later (the Reason column only) ──
  await opsNav(page, "newOrders");
  await page.click("#stageBulkUpdate");
  await page.click('[data-dfi="pick-action"][data-action="cancel"]');
  await page.selectOption("#dfiBMerchant", shop.id);
  const cancelFile = await downloaded(page, () => page.click("#dfiBDownload"));
  expect(cancelFile.name).toMatch(/^delivery-fast-new-orders-cancel-\d{12}\.xlsx$/);
  const n = fill(cancelFile.buffer, { [pending]: { Reason: "Merchant cancelled" } }, "kinds-cancel");
  files.push(n.file);
  expect(n.header.slice(0, 3)).toEqual(["Tracking ID", "Current status", "Reason *"]);
  // Uploaded as another action of the same page: refused.
  await page.click('[data-dfi="actions"]');
  await page.click('[data-dfi="pick-action"][data-action="add_note"]');
  await page.setInputFiles("#dfiFile", n.file);
  await page.click('[data-dfi="check"]');
  await expect(page.locator("#dfiMessage")).toHaveText('This is the "Cancel" file. Choose "Cancel" to upload it, or download the "Add note" file and fill that in.');
  await page.click('[data-dfi="close"]');

  // ── Delivery: only its actions; the New orders file is refused; its own file assigns the delivery rider ──
  await opsNav(page, "delivery");
  await expect(page.locator("#stageBulkUpdate")).toHaveText("Bulk update Delivery by Excel");
  await page.click("#stageBulkUpdate");
  await expect(page.locator('#dfiActions [data-dfi="pick-action"] strong')).toHaveText(["Assign delivery rider", "Complete details", "Add note"]);
  await page.click('[data-dfi="pick-action"][data-action="assign_delivery"]');
  await page.setInputFiles("#dfiFile", n.file);
  await page.click('[data-dfi="check"]');
  await expect(page.locator("#dfiMessage")).toHaveText('This is the "Cancel" file of New orders. Upload it on the New orders page (or All parcels), or download a Delivery file here and fill that in.');
  await page.selectOption("#dfiBMerchant", shop.id);
  const deliveryFile = await downloaded(page, () => page.click("#dfiBDownload"));
  expect(deliveryFile.name).toMatch(/^delivery-fast-delivery-assign-delivery-\d{12}\.xlsx$/);
  const d = fill(deliveryFile.buffer, { [hubbed]: { Rider: riderLabel } }, "kinds-delivery");
  files.push(d.file);
  await page.setInputFiles("#dfiFile", d.file);
  await page.click('[data-dfi="check"]');
  await expect(page.locator('#dfiSummary [data-count="apply"]')).toHaveText("1 will apply");
  await page.click('[data-dfi="commit"]');
  await expect(page.locator("#dfiResultText")).toHaveText("1 row applied, 0 already done (skipped), 0 not applied.");
  expect(await statusOf(hubbed)).toMatchObject({ status: "ASSIGNED", deliveryRiderId: rider.riderId });
  await page.click('[data-dfi="close"]');

  // ── Problems › Exceptions: Schedule return (Reason required) ──
  await opsNav(page, "exceptions");
  await expect(page.locator("#stageBulkUpdate")).toHaveText("Bulk update Problems by Excel");
  await page.click("#stageBulkUpdate");
  await expect(page.locator('#dfiActions [data-dfi="pick-action"] strong')).toHaveText(["Resolve: change status", "Assign delivery rider", "Schedule return", "Complete details", "Add note"]);
  await page.click('[data-dfi="pick-action"][data-action="schedule_return"]');
  await expect(page.locator("#dfiActionInfo")).toContainText("Schedule return: write the Reason for each row to return; rows with an empty Reason are skipped.");
  await page.selectOption("#dfiBMerchant", shop.id);
  const returnFile = await downloaded(page, () => page.click("#dfiBDownload"));
  expect(returnFile.name).toMatch(/^delivery-fast-problems-schedule-return-\d{12}\.xlsx$/);
  const returnSheet = sheetOf(returnFile.buffer);
  expect(returnSheet.header.slice(0, 3)).toEqual(["Tracking ID", "Current status", "Reason *"]);
  expect(returnSheet.rows.map(r => r[0])).toContain(stuck);
  expect(returnSheet.rows.map(r => r[0])).not.toContain(hubbed); // assigned: not on Problems
  const p = fill(returnFile.buffer, { [stuck]: { Reason: "Recipient refused twice" } }, "kinds-return");
  files.push(p.file);
  await page.setInputFiles("#dfiFile", p.file);
  await page.click('[data-dfi="check"]');
  await expect(page.locator('#dfiSummary [data-count="apply"]')).toHaveText("1 will apply");
  await expect(page.locator("#dfImportSubtitle")).toContainText("Schedule return · Problems");
  await page.click('[data-dfi="commit"]');
  await expect(page.locator("#dfiResultText")).toHaveText("1 row applied, 0 already done (skipped), 0 not applied.");
  expect(await statusOf(stuck)).toMatchObject({ status: "RETURN_SCHEDULED", returnReason: "Recipient refused twice" });
  const number = (await page.locator("#dfImportTitle").textContent())!.split(" ")[2];

  // History starts with this page's bulk updates and filters by action.
  await page.click('[data-dfi="history"]');
  await expect(page.locator("#dfiHKind")).toHaveValue("problems");
  await expect(page.locator(`#dfiHistory tr[data-bulk="${number}"] td[data-col="kind"]`)).toHaveText("Schedule return · Problems");
  await expect(page.locator('#dfiHistory tbody tr[data-kind]:not([data-kind="problems"])')).toHaveCount(0);
  await page.selectOption("#dfiHAction", "resolve_status");
  await expect(page.locator(`#dfiHistory tr[data-bulk="${number}"]`)).toHaveCount(0);
  await page.selectOption("#dfiHAction", "schedule_return");
  await expect(page.locator(`#dfiHistory tr[data-bulk="${number}"]`)).toHaveCount(1);
  await page.click('[data-dfi="close"]');

  // Transfers has no bulk file (transfers go through linehaul bags).
  await opsNav(page, "transfers");
  await expect(page.locator("#stageBulkUpdate")).toHaveCount(0);
  for (const f of files) fs.rmSync(f, { force: true });
  expect(errors).toEqual([]);
});
