import { type Page } from "@playwright/test";
import { API_ORIGIN, Fixtures, expect, opsNav, rowAction, sql, test, type TempMerchant, type TempUser } from "./support";

// Hub drop-off: a merchant brings parcels and a spreadsheet to the Gulshan hub. The hub operator
// imports it as a drop-off, prints the labels and receives the parcel by typing its ID.
// The merchant, its owner and the hub operator are temporary (support.ts Fixtures) and deleted
// afterwards with their parcels, imports and messages.
const fx = new Fixtures();
const stamp = fx.stamp;
let MERCHANT: TempMerchant;
let hubOp: TempUser;

test.beforeAll(async () => {
  MERCHANT = await fx.merchant({ label: "Drop-off Shop" });
  hubOp = await fx.staff("HUB_OPERATOR", "Gulshan Sorting Hub");
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
    if (attempt >= 2 || !/too many/i.test(await page.content())) throw new Error(`Couldn't sign in as ${user.login}`);
    await page.waitForTimeout(61_000);
  }
  if (!/courier-operation/.test(page.url())) await page.goto("/courier-operation");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
}

test("drop-off import → labels with barcodes → hub receive by typed ID → At hub", async ({ page, context }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/status of 401|Failed to load resource|tile\.openstreetmap/.test(message.text())) errors.push(message.text());
  });
  // E2E_API_ORIGIN: the page's API calls are forwarded by `test` from support.ts.
  await signIn(page, hubOp);

  // ── Import with "Drop-off at hub" (a hub operator's own hub is preselected; shared/importer.js) ──
  await opsNav(page, "ecommerce");
  await page.click("#courierImport");
  await expect(page.locator("#dfImportTitle")).toHaveText("Import orders from Excel");
  await page.selectOption("#dfiIntake", "DROP_OFF");
  await expect(page.locator("#dfiHub")).toBeEnabled();
  await expect(page.locator("#dfiHub option:checked")).toHaveText("Gulshan Sorting Hub");
  const recipient = `Drop E2E ${stamp}`;
  // The old CSV headers are still recognised.
  const csv = [
    "merchant,recipient_name,phone,district,zone,area,address,service_level,weight_kg,cod_amount,contents,order_ref",
    `${MERCHANT.code},${recipient},01812000000,Dhaka Central,Dhanmondi,,"Road 7, Flat 3B",Same day,1.5,1250,Fashion & Apparel,DROP-${stamp}`,
    `${MERCHANT.code},Bad Phone,12345,Dhaka Central,Dhanmondi,,"Road 9",Regular,1,0,Books,DROP-${stamp}-2`,
  ].join("\r\n");
  await page.setInputFiles("#dfiFile", { name: `dropoff-${stamp}.csv`, mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.click('[data-dfi="check"]');
  await expect(page.locator("#dfImportSubtitle")).toContainText("drop-off at Gulshan Sorting Hub", { timeout: 30_000 });
  await expect(page.locator('#dfiRows tr[data-row="3"]')).toContainText("Row 3 · Customer phone");
  await page.click('[data-dfi="commit"]');

  // ── Result: 1 booked, 1 not booked with its reason, labels for the booked parcel ──
  await expect(page.locator("#dfiResultText")).toContainText("1 order created", { timeout: 30_000 });
  await expect(page.locator("#dfiResultText")).toContainText("1 row not created");
  await expect(page.locator('#dfiRows tr[data-row="3"]')).toContainText("Customer phone");
  const [parcel] = await sql<{ trackingId: string; status: string; intake: string; bookingBatchId: string }>(
    `SELECT "trackingId", status, intake, "bookingBatchId" FROM parcels WHERE "merchantId" = $1`,
    [MERCHANT.id],
  );
  expect(parcel).toMatchObject({ status: "PENDING_CONFIRMATION", intake: "DROP_OFF" });
  const trackingId = parcel.trackingId;

  await page.click('[data-dfi="labels"]');
  await page.selectOption("#labelFormat", "thermal");
  const popupPromise = context.waitForEvent("page");
  await page.click("#modalSubmit");
  const popup = await popupPromise;
  await popup.waitForSelector("#labels .lbl");
  await expect(popup.locator("#labels")).toHaveAttribute("data-format", "thermal");
  await expect(popup.locator(".lbl")).toHaveCount(1);
  await expect(popup.locator(".lbl .tid")).toHaveText(trackingId);
  await expect(popup.locator(`svg.code128[data-code="${trackingId}"] path`)).toHaveCount(1);
  await expect(popup.locator(".lbl .cod")).toContainText("1,250");
  await expect(popup.locator(".lbl")).toContainText("Gulshan Sorting Hub");
  await expect(popup.locator(".lbl")).toContainText(`DROP-${stamp}`);
  await popup.close();

  // The register shows it waiting for the merchant, without a pickup rider.
  await page.fill("#shipmentSearch", trackingId);
  const row = page.locator(`#shipmentBody tr[data-shipment-id="${trackingId}"]`);
  await expect(row).toContainText("Awaiting drop-off at Gulshan Sorting Hub", { timeout: 20_000 });
  await expect(row.locator("[data-customer-confirm]")).toHaveCount(0);

  // ── Hub desk → Drop-off receive: type the ID (lower case) and press Enter ──
  await page.fill("#shipmentSearch", "");
  await opsNav(page, "dropOffReceive");
  await expect(page.locator("#receiveDesk")).toBeVisible();
  await expect(page.locator("#rdHub option:checked")).toHaveText("Gulshan Sorting Hub");
  await page.selectOption("#rdBatch", parcel.bookingBatchId);
  await expect(page.locator("#rdBatchSummary")).toContainText("Expected 1");
  await page.fill("#rdCode", trackingId.toLowerCase());
  await page.press("#rdCode", "Enter");
  await expect(page.locator("#rdLog tbody tr").first()).toContainText("Received", { timeout: 20_000 });
  await expect(page.locator("#rdFeedback")).toContainText(`${trackingId} received at Gulshan Sorting Hub (drop-off)`);
  await expect(page.locator("#rdCount")).toHaveText("1 received");
  await expect(page.locator("#rdBatchSummary")).toContainText("Received 1");
  await expect(page.locator("#rdBatchSummary")).toContainText("Missing 0");
  await expect(page.locator("#rdCode")).toBeFocused();

  // A second scan of the same label is harmless.
  await page.fill("#rdCode", trackingId);
  await page.press("#rdCode", "Enter");
  await expect(page.locator("#rdLog tbody tr").first()).toContainText("Already received", { timeout: 20_000 });

  const [after] = await sql<{ status: string; droppedOffAt: Date | null }>(`SELECT status, "droppedOffAt" FROM parcels WHERE "trackingId" = $1`, [trackingId]);
  expect(after.status).toBe("AT_HUB");
  expect(after.droppedOffAt).not.toBeNull();
  const events = await sql<{ title: string }>(`SELECT title FROM tracking_events e JOIN parcels p ON p.id = e."parcelId" WHERE p."trackingId" = $1 ORDER BY e."createdAt"`, [trackingId]);
  expect(events.map(e => e.title)).toContain("Received at Gulshan Sorting Hub (drop-off)");

  // The shipment register follows live: At hub.
  await page.locator("#rdCode").blur();
  await opsNav(page, "ecommerce");
  await page.fill("#shipmentSearch", trackingId);
  await expect(page.locator(`#shipmentBody tr[data-shipment-id="${trackingId}"]`)).toContainText("At hub", { timeout: 20_000 });
  expect(errors).toEqual([]);
});

test("switches a booked pickup to hub drop-off and back from the shipment register and the parcel history", async ({ page, context }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/status of 401|Failed to load resource|tile\.openstreetmap/.test(message.text())) errors.push(message.text());
  });
  await signIn(page, hubOp);

  // A rider-pickup booking for the temporary merchant (booked through the API as the hub operator).
  const booked = await page.evaluate(
    merchantId =>
      (window as unknown as { DF: { api: (path: string, init: unknown) => Promise<{ trackingId: string; charges: { total: number } }> } }).DF.api("/ops/parcels", {
        method: "POST",
        body: {
          merchantId,
          recipient: { name: "Intake Switch E2E", phone: "01812000000" },
          delivery: { category: "Office", street: "Road 7, Flat 3B", zone: "Dhanmondi", district: "Dhaka Central" },
          serviceLevel: "Same day",
          weightKg: 1,
          packaging: "Small carton",
          contents: "Clothing",
          codAmount: 500,
        },
      }),
    MERCHANT.id,
  );
  const trackingId = booked.trackingId;
  await opsNav(page, "ecommerce");
  await page.fill("#shipmentSearch", trackingId);
  const row = page.locator(`#shipmentBody tr[data-shipment-id="${trackingId}"]`);
  await expect(row.locator("[data-intake-change]")).toHaveText("Change to drop-off", { timeout: 20_000 });

  // Row action (under "More") → drop-off at the operator's own hub.
  await rowAction(row, "[data-intake-change]");
  await expect(page.locator("#modalTitle")).toHaveText(`Change to drop-off · ${trackingId}`);
  await expect(page.locator("#icIntake")).toHaveValue("DROP_OFF");
  await expect(page.locator("#icHub option:checked")).toHaveText("Gulshan Sorting Hub");
  await page.fill("#icNote", "Merchant will bring it");
  await page.click("#modalSubmit");
  await expect(page.locator("#toast")).toContainText(`${trackingId} is now a drop-off at Gulshan Sorting Hub`);
  await expect(row).toContainText("Awaiting drop-off at Gulshan Sorting Hub", { timeout: 20_000 });
  const [dropped] = await sql<{ intake: string; dropOffHubId: string | null }>(`SELECT intake, "dropOffHubId" FROM parcels WHERE "trackingId" = $1`, [trackingId]);
  expect(dropped.intake).toBe("DROP_OFF");
  const notices = await sql<{ body: string }>(`SELECT body FROM outbox_messages WHERE template = 'parcel.changed_to_drop_off' AND body LIKE $1`, [`%${trackingId}%`]);
  expect(notices[0]?.body).toContain("Gulshan Sorting Hub");

  // Parcel detail (tracking history) → back to rider pickup.
  await rowAction(row, "[data-track]");
  const detail = page.locator("#courierHistoryBackdrop [data-intake-detail]");
  await expect(detail).toContainText("Drop-off at Gulshan Sorting Hub");
  await expect(page.locator("#courierHistoryBackdrop")).toContainText("Changed to drop-off at Gulshan Sorting Hub");
  await detail.locator("[data-intake-change]").click();
  await expect(page.locator("#icIntake")).toHaveValue("PICKUP");
  await expect(page.locator("#icHub")).toBeDisabled();
  await page.click("#modalSubmit");
  await expect(page.locator("#toast")).toContainText(`${trackingId} is now a rider pickup`);
  await expect(row.locator("[data-intake-change]")).toHaveText("Change to drop-off", { timeout: 20_000 });
  const [back] = await sql<{ intake: string; dropOffHubId: string | null }>(`SELECT intake, "dropOffHubId" FROM parcels WHERE "trackingId" = $1`, [trackingId]);
  expect(back).toEqual({ intake: "PICKUP", dropOffHubId: null });
  expect(errors).toEqual([]);
});

test("merchant dashboards show drop-offs as awaiting drop-off, not awaiting pickup", async ({ page, context }) => {
  test.setTimeout(180_000);
  const owner = await fx.member(MERCHANT, "MERCHANT_OWNER");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const apiOrigin = API_ORIGIN;
  // A drop-off booked by the Gulshan hub for this merchant.
  const hubLogin = await (await page.request.post(`${apiOrigin}/api/v1/auth/login`, { data: { identifier: hubOp.phone, password: hubOp.password } })).json();
  const drop = await page.request.post(`${apiOrigin}/api/v1/ops/parcels`, {
    headers: { authorization: `Bearer ${hubLogin.accessToken}` },
    data: {
      merchantId: MERCHANT.id,
      intake: "DROP_OFF",
      recipient: { name: "Dashboard Drop E2E", phone: "01812000000" },
      delivery: { category: "Office", street: "Road 7, Flat 3B", zone: "Dhanmondi", district: "Dhaka Central" },
      serviceLevel: "Same day",
      weightKg: 1,
      packaging: "Small carton",
      contents: "Clothing",
      codAmount: 300,
    },
  });
  expect(drop.ok(), await drop.text()).toBe(true);
  const ownerLogin = await (await page.request.post(`${apiOrigin}/api/v1/auth/login`, { data: { identifier: owner.phone, password: owner.password } })).json();
  const stats = await (await page.request.get(`${apiOrigin}/api/v1/merchants/me/stats`, { headers: { authorization: `Bearer ${ownerLogin.accessToken}` } })).json();
  expect(stats.parcels.awaitingDropOff).toBeGreaterThanOrEqual(1);

  await page.goto("/login");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.fill("#loginIdentity", owner.login);
  await page.fill("#loginPassword", owner.password);
  await page.click('form[data-form="login"] button[type="submit"]');
  await expect(page).toHaveURL(/\/ecommerce-merchant/);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  // Overview pipeline: "Awaiting drop-off" next to "Pickup scheduled" (which counts rider pickups only).
  const dropRow = page.locator(".dispatch-list [data-df-dropoff]");
  await expect(dropRow).toContainText("Awaiting drop-off");
  await expect(dropRow.locator("strong")).toHaveText(String(stats.parcels.awaitingDropOff), { timeout: 20_000 });
  await expect(page.locator(".dispatch-list .dispatch-row:not([data-df-dropoff]) strong").nth(2)).toHaveText(String(stats.parcels.awaitingPickup));
  // Pickup requests: its own counter, and the nav badge counts pickups only.
  await page.click('#navigation [data-page="Pickup requests"]');
  await expect(page.locator(".metrics")).toContainText("Awaiting drop-off");
  const badge = page.locator('#navigation [data-page="Pickup requests"] .nav-count');
  if (stats.parcels.awaitingPickup) await expect(badge).toHaveText(String(stats.parcels.awaitingPickup));
  else await expect(badge).toBeHidden();
  await expect(page.locator("#tableBody")).toContainText("Awaiting drop-off at Gulshan Sorting Hub");
  expect(errors).toEqual([]);
});
