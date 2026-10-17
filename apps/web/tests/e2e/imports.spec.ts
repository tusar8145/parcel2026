import { randomBytes, randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import fs from "node:fs";
import { type BrowserContext, type Page } from "@playwright/test";
import { API_BASE, Fixtures, expect, test, type TempUser } from "./support";
import { hash as argonHash } from "@node-rs/argon2";
import { authenticator } from "otplib";
import pg from "pg";

// The spreadsheet import engine through the real UI: a merchant (template → upload with valid,
// incomplete and invalid rows → paginated preview with highlighted errors → create → result →
// download of the rows not created → complete a "Needs info" order), operations (drop-off
// import with a merchant per row → labels) and super admin (a required column changes the
// template and the validation). A temporary merchant, owner and super admin are created in the
// database and deleted afterwards with everything they booked; the import settings are restored.
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgresql://deliveryfast:deliveryfast@localhost:5432/deliveryfast";
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
/** E2E_API_ORIGIN: an API on another port than the web app's proxy target (support.ts forwards the page's calls). */
const API = API_BASE;
/** The operations test signs in as a temporary hub operator of the Gulshan hub (deleted afterwards). */
const fx = new Fixtures();
let hubOp: TempUser;
const WEB = { "x-df-client": "web" };

const stamp = Date.now().toString(36).toUpperCase();
const MERCHANT = { id: randomUUID(), code: `E2E-IMP-${stamp}`, name: `E2E Import Shop ${stamp}` };
const OWNER = { id: "", phone: `+88019${String(Date.now()).slice(-8)}`, password: `Imp-${randomBytes(9).toString("base64url")}` };
const ADMIN = { id: "", phone: `+88018${String(Date.now() + 5).slice(-8)}`, password: `Sa-${randomBytes(9).toString("base64url")}` };
let previousImportConfig: unknown = undefined;

async function sql<T = Record<string, unknown>>(text: string, values: unknown[] = []) {
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    return (await db.query(text, values)).rows as T[];
  } finally {
    await db.end();
  }
}
const hash = (password: string) => argonHash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

test.beforeAll(async () => {
  await sql(
    `INSERT INTO merchants (id, code, type, name, status, "kycStatus", "contactName", "contactPhone", "pickupAddress", "pickupArea", "pickupDistrict", "updatedAt")
     VALUES ($1, $2, 'ECOMMERCE', $3, 'ACTIVE', 'APPROVED', 'E2E Owner', '+8801911000000', 'House 5 Road 2', 'Gulshan 1', 'Dhaka North', now())`,
    [MERCHANT.id, MERCHANT.code, MERCHANT.name],
  );
  for (const [user, name, role] of [
    [OWNER, "E2E Import Owner", "MERCHANT_OWNER"],
    [ADMIN, "E2E Import Admin", "SUPER_ADMIN"],
  ] as const) {
    const [row] = await sql<{ id: string }>(`INSERT INTO users (id, name, phone, "passwordHash", "phoneVerifiedAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3, now(), now()) RETURNING id`, [
      name,
      user.phone,
      await hash(user.password),
    ]);
    user.id = row.id;
    await sql(`INSERT INTO user_roles (id, "userId", role, "merchantId") VALUES (gen_random_uuid(), $1, $2, $3)`, [row.id, role, role === "MERCHANT_OWNER" ? MERCHANT.id : null]);
  }
  previousImportConfig = (await sql<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'import-config'`))[0]?.value;
  hubOp = await fx.staff("HUB_OPERATOR", "Gulshan Sorting Hub");
});

test.afterAll(async () => {
  const parcels = await sql<{ id: string; trackingId: string; bookingBatchId: string | null }>(`SELECT id, "trackingId", "bookingBatchId" FROM parcels WHERE "merchantId" = $1`, [MERCHANT.id]);
  const batches = [...new Set(parcels.map(p => p.bookingBatchId).filter(Boolean))];
  const ids = parcels.map(p => p.id);
  for (const p of parcels) await sql(`DELETE FROM outbox_messages WHERE body LIKE $1`, [`%${p.trackingId}%`]);
  if (ids.length) {
    for (const table of ["scan_events", "sla_alerts", "tracking_events", "webhook_deliveries"]) await sql(`DELETE FROM ${table} WHERE "parcelId" = ANY($1::uuid[])`, [ids]).catch(() => undefined);
    await sql(`DELETE FROM parcels WHERE id = ANY($1::uuid[])`, [ids]);
  }
  const jobs = await sql<{ id: string; number: string; bookingBatchId: string | null }>(
    `SELECT id, number, "bookingBatchId" FROM import_jobs WHERE "merchantId" = $1 OR "createdById" = ANY($2::uuid[]) OR "bookingBatchId" = ANY($3::uuid[]) OR ("fileName" LIKE $4 AND "createdAt" > now() - interval '1 day')`,
    [MERCHANT.id, [OWNER.id, ADMIN.id], batches, `dropoff-${stamp.slice(-5)}O.csv`],
  );
  await sql(`DELETE FROM import_jobs WHERE id = ANY($1::uuid[])`, [jobs.map(j => j.id)]);
  await sql(`DELETE FROM booking_batches WHERE id = ANY($1::uuid[]) OR "merchantId" = $2`, [[...batches, ...jobs.map(j => j.bookingBatchId).filter(Boolean)], MERCHANT.id]);
  for (const j of jobs) await sql(`DELETE FROM outbox_messages WHERE template = 'import.completed' AND body LIKE $1`, [`%${j.number}%`]);
  if (previousImportConfig === undefined) await sql(`DELETE FROM settings WHERE key = 'import-config'`);
  else await sql(`UPDATE settings SET value = $1 WHERE key = 'import-config'`, [JSON.stringify(previousImportConfig)]);
  await sql(`DELETE FROM outbox_messages WHERE "to" = ANY($1::text[]) OR "userId" = ANY($2::uuid[])`, [[OWNER.phone, ADMIN.phone], [OWNER.id, ADMIN.id].filter(Boolean)]);
  await sql(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[OWNER.id, ADMIN.id].filter(Boolean)]);
  await sql(`DELETE FROM merchants WHERE id = $1`, [MERCHANT.id]);
  await fx.cleanup();
});

/** Collects page errors (E2E_API_ORIGIN routing: support.ts). */
async function prepare(_context: BrowserContext, page: Page) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/status of (401|404|409|422)|Failed to load resource|tile\.openstreetmap/.test(message.text())) errors.push(message.text());
  });
  page.on("dialog", dialog => dialog.accept());
  return errors;
}

async function signIn(page: Page, identifier: string, password: string, panel: RegExp) {
  for (let attempt = 0; ; attempt++) {
    await page.goto("/login");
    await page.waitForSelector("html.legacy-ready", { state: "attached" });
    await page.fill("#loginIdentity", identifier);
    await page.fill("#loginPassword", password);
    await page.click('form[data-form="login"] button[type="submit"]');
    const ok = await page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 15_000 }).then(() => true, () => false);
    if (ok) break;
    // Sign-in is rate limited per IP (shared with other suites on this machine).
    if (attempt >= 2 || !/too many/i.test(await page.content())) throw new Error(`Couldn't sign in as ${identifier}`);
    await page.waitForTimeout(61_000);
  }
  await expect(page).toHaveURL(panel);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
}

/** The parts of a ZIP (.xlsx) as text. */
function unzip(buf: Buffer) {
  const files = new Map<string, string>();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLength);
    p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = buf.subarray(start, start + size);
    files.set(name, (method === 8 ? inflateRawSync(data) : data).toString("utf8"));
  }
  return files;
}
async function downloaded(page: Page, click: () => Promise<unknown>) {
  const [download] = await Promise.all([page.waitForEvent("download"), click()]);
  return { name: download.suggestedFilename(), buffer: fs.readFileSync((await download.path())!) };
}

const HEADER = "Order ID,Customer name,Customer phone,Delivery address,District,Zone,Service,Weight (kg),COD amount (৳),Product type";
const csv = (rows: string[]) => Buffer.from(`﻿${[HEADER, ...rows].join("\r\n")}`, "utf8");

test.describe.serial("spreadsheet imports", () => {
  test("merchant: template → upload → paginated preview with errors → create → result → failed rows → complete a Needs info order", async ({ page, context }) => {
    test.setTimeout(240_000);
    const errors = await prepare(context, page);
    await signIn(page, OWNER.phone, OWNER.password, /\/ecommerce-merchant/);
    await page.click('#navigation [data-page="Orders"]');
    await expect(page.locator("#merchantBulkImport")).toBeVisible();
    await expect(page.locator("#merchantImportHistory")).toBeVisible();

    // ── The template is a real .xlsx with red required headers, dropdowns and instructions ──
    const template = await downloaded(page, () => page.click("#merchantBulkTemplate"));
    expect(template.name).toBe("delivery-fast-ecommerce-orders-template.xlsx");
    const parts = unzip(template.buffer);
    expect(parts.get("xl/workbook.xml")).toMatch(/<sheet name="Lists"[^>]*state="hidden"/);
    expect(parts.get("xl/worksheets/sheet1.xml")).toContain("Customer phone *");
    expect(parts.get("xl/worksheets/sheet1.xml")).toContain("<formula1>L_districts</formula1>");

    // ── Upload: 55 valid, 3 incomplete (no address or destination; the first also no name), 2 invalid ──
    const tag = stamp.slice(-5);
    const rows = [
      ...Array.from({ length: 55 }, (_, i) => `IMP-${tag}-${i},Valid ${i},0181${String(3000000 + i)},House ${i},Dhaka Central,Dhanmondi,Regular,1,500,Fashion & Apparel`),
      ...Array.from({ length: 3 }, (_, i) => `INC-${tag}-${i},${i ? `Needs Info ${i}` : ""},0171${String(4000000 + i)},,,,,,,`),
      `BAD-${tag}-1,Bad Phone,12345,House 1,Dhaka Central,Dhanmondi,Regular,1,0,Fashion & Apparel`,
      `BAD-${tag}-2,Bad District,01812000000,House 2,Atlantis,Dhanmondi,Regular,1,0,Fashion & Apparel`,
    ];
    await page.click("#merchantBulkImport");
    await expect(page.locator("#dfiLimits")).toContainText("Max 5,000 rows and 10 MB per file");
    await expect(page.locator("#dfiLimits")).toContainText("Customer phone");
    await page.setInputFiles("#dfiFile", { name: `orders-${tag}.csv`, mimeType: "text/csv", buffer: csv(rows) });
    await page.click('[data-dfi="check"]');

    // ── Preview: summary, 50 rows per page, page controls and jump-to-page ──
    await expect(page.locator("#dfiSummary")).toContainText("60 rows", { timeout: 30_000 });
    await expect(page.locator('#dfiSummary [data-count="valid"]')).toHaveText("55 valid");
    await expect(page.locator('#dfiSummary [data-count="incomplete"]')).toHaveText("3 needs info");
    await expect(page.locator('#dfiSummary [data-count="errors"]')).toHaveText("2 with errors");
    await expect(page.locator("#dfiRows tbody tr")).toHaveCount(50);
    await expect(page.locator("#dfiPageInfo")).toHaveText("Page 1 of 2 · 60 rows");
    await page.click('[data-dfi="page"]:has-text("Next")');
    await expect(page.locator("#dfiPageInfo")).toHaveText("Page 2 of 2 · 60 rows");
    await expect(page.locator("#dfiRows tbody tr")).toHaveCount(10);
    await page.fill("#dfiJump", "1");
    await page.press("#dfiJump", "Enter");
    await expect(page.locator("#dfiPageInfo")).toHaveText("Page 1 of 2 · 60 rows");
    // Errors filter: the invalid cells are highlighted with their message.
    await page.click('[data-dfi="filter"][data-filter="error"]');
    await expect(page.locator("#dfiRows tbody tr")).toHaveCount(2);
    const phoneCell = page.locator('#dfiRows tr[data-row="60"] td[data-col="recipient_phone"]');
    await expect(phoneCell).toHaveAttribute("data-invalid", "true");
    await expect(phoneCell).toHaveAttribute("title", /Customer phone: /);
    await expect(page.locator('#dfiRows tr[data-row="60"]')).toContainText("Row 60 · Customer phone:");
    await expect(page.locator('#dfiRows tr[data-row="61"]')).toContainText('Row 61 · District: unknown district "Atlantis"');
    await page.click('[data-dfi="filter"][data-filter="incomplete"]');
    await expect(page.locator("#dfiRows tbody tr")).toHaveCount(3);
    await expect(page.locator('#dfiRows td[data-missing="true"]').first()).toBeVisible();

    // ── Create: valid and incomplete rows; the result counts and the rows not created ──
    await page.click('[data-dfi="commit"]:has-text("Create 58 orders")');
    await expect(page.locator("#dfiResultText")).toContainText("58 orders created, 3 marked “Needs info”. 2 rows not created.", { timeout: 60_000 });
    const failed = await downloaded(page, () => page.click('[data-dfi="failed"]'));
    expect(failed.name).toMatch(/^IMP-\d{6}-\d{3}-not-created\.xlsx$/);
    const sheet = unzip(failed.buffer).get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain("<t>Error</t>");
    expect(sheet).toContain(`BAD-${tag}-1`);
    expect(sheet).toContain("Row 60: Customer phone:");
    expect((await sql(`SELECT 1 FROM parcels WHERE "merchantId" = $1`, [MERCHANT.id])).length).toBe(58);
    await page.click('[data-dfi="close"]:has-text("Done")');

    // ── Orders: "Needs info" filter and badge; complete one order ──
    await page.selectOption("#merchantStatusFilter", { value: "__needs_info" });
    await expect(page.locator("#tableBody tr:visible")).toHaveCount(3, { timeout: 20_000 });
    await expect(page.locator("#tableBody tr:visible [data-df-needs]").first()).toHaveText("Needs info");
    // The order without a recipient name lists it among what is missing, and the form marks it as needed before delivery.
    const [noName] = await sql<{ trackingId: string }>(`SELECT "trackingId" FROM parcels WHERE "merchantId" = $1 AND "merchantOrderRef" = $2`, [MERCHANT.id, `INC-${tag}-0`]);
    const noNameRow = page.locator(`#tableBody tr[data-merchant-record-id="${noName.trackingId}"]`);
    await expect(noNameRow.locator("[data-df-needs]")).toHaveAttribute("title", /^Missing: recipient name, delivery address, district, zone/);
    await noNameRow.locator("[data-df-complete]").click();
    await expect(page.locator("#dfiComplete")).toBeVisible();
    await expect(page.locator("#dfiComplete")).toContainText("Missing: recipient name, delivery address, district, zone");
    await expect(page.locator('#dfiComplete label[for="dfiName"]')).toContainText("needed before delivery");
    await expect(page.locator('#dfiComplete label[for="dfiPhone"]')).not.toContainText("needed before delivery");
    await page.fill("#dfiName", "Named Later");
    await page.fill("#dfiStreet", "House 9, Road 3");
    await page.selectOption("#dfiDistrict", "Dhaka Central");
    await page.selectOption("#dfiZone", "Mirpur");
    await page.click("#dfiCompleteSubmit");
    await expect(page.locator("#toast")).toContainText("is complete");
    const [left] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM parcels WHERE "merchantId" = $1 AND incomplete`, [MERCHANT.id]);
    expect(left.n).toBe(2);

    // ── History ──
    await page.click("#merchantImportHistory");
    await expect(page.locator("#dfiHistory tbody tr").first()).toContainText(`orders-${tag}.csv`);
    await expect(page.locator("#dfiHistory tbody tr").first()).toContainText("Completed");
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  });

  test("operations: drop-off import with a merchant per row, then labels", async ({ page, context }) => {
    test.setTimeout(240_000);
    const errors = await prepare(context, page);
    await signIn(page, hubOp.login, hubOp.password, /\/courier-operation/);
    await page.click('#navigation [data-page="E-commerce operations"]');
    await page.click("#courierImport");
    await expect(page.locator("#dfiLimits")).toContainText("Max 10,000 rows");
    await page.selectOption("#dfiIntake", "DROP_OFF");
    await expect(page.locator("#dfiHub")).toBeEnabled();
    await expect(page.locator("#dfiHub option:checked")).toHaveText("Gulshan Sorting Hub");
    const tag = `${stamp.slice(-5)}O`;
    const file = Buffer.from(
      `﻿Merchant,${HEADER}\r\n${MERCHANT.code},DROP-${tag}-1,Drop One,01812000011,Road 7,Dhaka Central,Dhanmondi,Same day,1.5,1250,Fashion & Apparel\r\n${MERCHANT.code},DROP-${tag}-2,,01812000012,,,,,,,\r\nNO-SUCH-MERCHANT,DROP-${tag}-3,Drop Three,01812000013,Road 9,Dhaka Central,Dhanmondi,Regular,1,0,Fashion & Apparel`,
      "utf8",
    );
    await page.setInputFiles("#dfiFile", { name: `dropoff-${tag}.csv`, mimeType: "text/csv", buffer: file });
    await page.click('[data-dfi="check"]');
    await expect(page.locator("#dfImportSubtitle")).toContainText("drop-off at Gulshan Sorting Hub", { timeout: 30_000 });
    await expect(page.locator('#dfiSummary [data-count="errors"]')).toHaveText("1 with errors");
    await expect(page.locator('#dfiRows tr[data-row="4"] td[data-col="merchant"]')).toHaveAttribute("data-invalid", "true");
    await page.click('[data-dfi="commit"]');
    await expect(page.locator("#dfiResultText")).toContainText("2 orders created, 1 marked “Needs info”. 1 row not created.", { timeout: 60_000 });
    const parcels = await sql<{ trackingId: string; intake: string; incomplete: boolean }>(
      `SELECT "trackingId", intake, incomplete FROM parcels WHERE "merchantId" = $1 AND "merchantOrderRef" LIKE $2 ORDER BY "merchantOrderRef"`,
      [MERCHANT.id, `DROP-${tag}-%`],
    );
    expect(parcels.map(p => [p.intake, p.incomplete])).toEqual([
      ["DROP_OFF", false],
      ["DROP_OFF", true],
    ]);

    // Labels for the new parcels (the existing Code 128 label sheet).
    await page.click('[data-dfi="labels"]');
    await expect(page.locator("#modalTitle")).toHaveText("Print labels");
    const popupPromise = context.waitForEvent("page");
    await page.click("#modalSubmit");
    const popup = await popupPromise;
    await popup.waitForSelector("#labels .lbl");
    await expect(popup.locator(".lbl")).toHaveCount(2);
    await expect(popup.locator(".lbl").nth(1)).toContainText("DETAILS PENDING");
    await popup.close();

    // The register marks the incomplete order "Needs info"; Edit details completes it.
    const row = page.locator(`#shipmentBody tr[data-shipment-id="${parcels[1].trackingId}"]`);
    await page.selectOption("#statusFilter", "Needs info");
    await expect(row.locator("[data-needs-info]")).toHaveText("Needs info", { timeout: 20_000 });
    await expect(row.locator("[data-needs-missing]")).toHaveText("Missing: recipient name, delivery address, district, zone");
    await expect(page.locator(`#shipmentBody tr[data-shipment-id="${parcels[0].trackingId}"]`)).toBeHidden();
    await row.locator("[data-generated-edit]").click();
    await expect(page.locator("#dfiComplete")).toBeVisible();
    await expect(page.locator('#dfiComplete label[for="dfiName"]')).toContainText("needed before delivery");
    // Without the name it stays "Needs info" (it is needed before a delivery rider is assigned).
    await page.fill("#dfiStreet", "Road 11");
    await page.selectOption("#dfiDistrict", "Dhaka Central");
    await page.selectOption("#dfiZone", "Dhanmondi");
    await page.click("#dfiCompleteSubmit");
    await expect(page.locator("#toast")).toContainText("Still needed: recipient name");
    await expect(row.locator("[data-needs-missing]")).toHaveText("Missing: recipient name", { timeout: 20_000 });
    await row.locator("[data-generated-edit]").click();
    await expect(page.locator("#dfiComplete")).toBeVisible();
    await page.fill("#dfiName", "Drop Two");
    await page.selectOption("#dfiDistrict", "Dhaka Central");
    await page.selectOption("#dfiZone", "Dhanmondi");
    await page.fill("#dfiNote", "Merchant confirmed");
    await page.click("#dfiCompleteSubmit");
    await expect(page.locator("#toast")).toContainText("is complete");
    expect((await sql<{ incomplete: boolean }>(`SELECT incomplete FROM parcels WHERE "trackingId" = $1`, [parcels[1].trackingId]))[0].incomplete).toBe(false);
    expect(errors).toEqual([]);
  });

  test("super admin: a required column changes the template and the validation", async ({ page, context }) => {
    test.setTimeout(240_000);
    const errors = await prepare(context, page);
    // Super admins use two-step verification: enrol the temporary admin through the API.
    const login = await (await page.request.post(`${API}/api/v1/auth/login`, { headers: WEB, data: { identifier: ADMIN.phone, password: ADMIN.password } })).json();
    expect(login.mfaSetupRequired, JSON.stringify(login)).toBe(true);
    const setup = await (await page.request.post(`${API}/api/v1/auth/mfa/setup`, { headers: WEB, data: { mfaToken: login.mfaToken } })).json();
    const enabled = await page.request.post(`${API}/api/v1/auth/mfa/enable`, { headers: WEB, data: { mfaToken: login.mfaToken, code: authenticator.generate(setup.secret) } });
    expect(enabled.ok(), await enabled.text()).toBe(true);
    await page.goto("/super-admin");
    await page.waitForSelector("html.legacy-ready", { state: "attached" });
    await page.click('#navigation [data-page="Service catalog"]');
    const panel = page.locator("#importSettings");
    await expect(panel).toBeVisible();
    const district = panel.locator('[data-import-required="district"]');
    await expect(district).not.toHaveClass(/\bon\b/);
    await district.click();
    await panel.locator('[data-import-default="service_level"]').fill("Express");
    await panel.locator("[data-import-save]").click();
    await expect(page.locator("#toast")).toContainText("Import settings saved");
    await expect(panel.locator('[data-import-required="district"]')).toHaveClass(/\bon\b/);

    // The template marks District as required…
    const file = await downloaded(page, () => panel.locator('[data-import-template="ecommerce"]').click());
    expect(unzip(file.buffer).get("xl/worksheets/sheet1.xml")).toContain("<t>District *</t>");
    // …and a merchant upload without a district is refused for that row.
    const owner = await (await page.request.post(`${API}/api/v1/auth/login`, { headers: WEB, data: { identifier: OWNER.phone, password: OWNER.password } })).json();
    const check = await page.request.post(`${API}/api/v1/imports/validate`, {
      headers: { ...WEB, authorization: `Bearer ${owner.accessToken}` },
      data: { kind: "ecommerce", rows: [{ "Order ID": `CFG-${stamp}`, "Customer phone": "01812000000", "Delivery address": "Road 1" }] },
    });
    expect(check.status(), await check.text()).toBe(201);
    const job = await check.json();
    expect(job.rows.items[0].errors[0].text).toBe("Row 2 · District: required");
    await page.request.delete(`${API}/api/v1/imports/${job.id}`, { headers: { ...WEB, authorization: `Bearer ${owner.accessToken}` } });

    // Back to the previous settings.
    await panel.locator('[data-import-required="district"]').click();
    await panel.locator('[data-import-default="service_level"]').fill("");
    await panel.locator("[data-import-save]").click();
    await expect(page.locator("#toast")).toContainText("Import settings saved");
    await expect(panel.locator('[data-import-required="district"]')).not.toHaveClass(/\bon\b/);
    expect(errors).toEqual([]);
  });
});
