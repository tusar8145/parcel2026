import { type Page } from "@playwright/test";
import { Fixtures, apiUrl, expect, opsNav, sql, test } from "./support";

/**
 * Hub desk → Out for delivery and Delivered entry, by one hub operator, by scanning: a parcel at the hub goes out
 * with the chosen rider; the rider's signed slip is entered as delivered with a photo (from the camera input,
 * shrunk in the browser); scanning again updates the details. Temporary accounts and parcels are deleted afterwards.
 */
const fx = new Fixtures();
test.afterAll(() => fx.cleanup());

const HUB = "Gulshan Sorting Hub";
// A 1600×1200 JPEG-ish PNG generated in the page: big enough that the browser has to shrink it.
async function slipPhoto(page: Page) {
  return page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 1600;
    c.height = 1200;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#123";
    g.font = "64px sans-serif";
    g.fillText("Received in good condition — signed", 80, 600);
    return c.toDataURL("image/png");
  });
}
const status = async (trackingId: string) =>
  (await sql<Record<string, unknown>>(`SELECT p.status, d."receivedBy", d."fileId" IS NOT NULL AS photo, d.note FROM parcels p LEFT JOIN delivery_proofs d ON d."parcelId" = p.id WHERE p."trackingId" = $1`, [trackingId]))[0];

test("hub desk: a rider's day at the desk — pickup entry, out for delivery, failed, received back, delivered with the slip photo", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  const shop = await fx.merchant();
  const rider = await fx.rider(HUB);
  const ops = await fx.staff("OPS_MANAGER");
  const desk = await fx.staff("HUB_OPERATOR", HUB);

  // Booked and given to the pickup rider, through the API as operations.
  const api = await (await browser.newContext()).newPage();
  const token = (await (await api.request.post(apiUrl("/api/v1/auth/login"), { data: { identifier: ops.login, password: ops.password } })).json()).accessToken as string;
  const call = (path: string, data: object) => api.request.post(apiUrl(`/api/v1${path}`), { headers: { authorization: `Bearer ${token}` }, data });
  const booked = await call("/ops/parcels", { merchantId: shop.id, recipient: { name: `Desk E2E ${fx.stamp}`, phone: "01812000000" }, delivery: { category: "Home", street: "Road 7, Flat 3B", zone: "Dhanmondi", district: "Dhaka Central" }, serviceLevel: "Regular", weightKg: 1, codAmount: 650 });
  expect(booked.status(), await booked.text()).toBe(201);
  const id = (await booked.json()).trackingId as string;
  fx.adoptParcel(id);
  expect((await call(`/parcels/${id}/assign-pickup`, { riderId: rider.riderId })).status()).toBe(200);

  await page.goto("/login");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.fill("#loginIdentity", desk.login);
  await page.fill("#loginPassword", desk.password);
  await page.click('form[data-form="login"] button[type="submit"]');
  await page.waitForURL(/courier-operation/);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  const scanIt = async (expected: string | RegExp) => {
    await page.fill("#hdScan", id);
    await page.press("#hdScan", "Enter");
    await expect(page.locator("#hdLog li").first()).toContainText(expected);
  };

  // Pickup entry: picked up for the rider and received at this hub.
  await opsNav(page, "hubPickupEntry");
  await expect(page.locator("#hdDesk .panel-title")).toHaveText(`Pickup entry · ${HUB}`);
  await scanIt(`${id} picked up by`);
  await expect(page.locator("#hdCount")).toHaveText("1 received");
  expect((await status(id)).status).toBe("AT_HUB");

  // Out for delivery: the rider is chosen for a parcel still at the hub.
  await opsNav(page, "hubOutForDelivery");
  await scanIt("choose the rider above");
  await page.selectOption("#hdRider", rider.riderId);
  await scanIt(`${id} is out for delivery with`);
  expect((await status(id)).status).toBe("OUT_FOR_DELIVERY");

  // The rider couldn't deliver: reason set once, try again later; then the rider brings it back.
  await opsNav(page, "hubFailedDelivery");
  await page.selectOption("#hdReason", "Recipient unavailable");
  await page.check('input[name="hdNext"][value="RETRY"]');
  await scanIt("recipient unavailable · stays with");
  expect((await status(id)).status).toBe("RETRY_SCHEDULED");
  // The rider brings it back: received on the Receive tab like any arrival.
  await opsNav(page, "hubReceive");
  await page.fill("#rdCode", id);
  await page.press("#rdCode", "Enter");
  await expect(page.locator("#rdFeedback")).toContainText(`${id} received back at ${HUB}`);
  expect((await status(id)).status).toBe("AT_HUB");

  // Out again (the rider stays chosen), then the signed slip with a photo (shrunk in the browser) and the receiver.
  await opsNav(page, "hubOutForDelivery");
  await expect(page.locator("#hdRider")).toHaveValue(rider.riderId);
  await scanIt(`${id} is out for delivery with`);
  await opsNav(page, "hubDeliveredEntry");
  const png = await slipPhoto(page);
  await page.setInputFiles("#hdPhotoInput", { name: "slip.png", mimeType: "image/png", buffer: Buffer.from(png.split(",")[1], "base64") });
  await expect(page.locator("#hdPhotoPreview")).toBeVisible();
  const kb = Number((await page.locator("#hdPhotoSize").textContent())!.match(/(\d+) KB/)![1]);
  expect(kb).toBeLessThan(400);
  await page.fill("#hdReceivedBy", "Rupa Akter");
  await scanIt(`${id} delivered by`);
  await expect(page.locator("#hdLog li").first()).toContainText("৳650 cash with the rider · slip photo saved");
  await expect(page.locator("#hdPhotoPreview")).toHaveCount(0);
  await expect(page.locator("#hdReceivedBy")).toHaveValue("");
  expect(await status(id)).toEqual({ status: "DELIVERED", receivedBy: "Rupa Akter", photo: true, note: "Signed delivery slip handed in at the hub" });

  // Scanned again with a note: the details are updated, not delivered twice.
  await page.fill("#hdNote", "Slip signed at the shop counter");
  await scanIt("delivery details updated");
  expect((await status(id)).note).toBe("Slip signed at the shop counter");
  expect((await sql(`SELECT 1 FROM cod_collections c JOIN parcels p ON p.id = c."parcelId" WHERE p."trackingId" = $1`, [id])).length).toBe(1);

  expect(errors).toEqual([]);
});

test("hub desk: transfer out by scanning sends a received parcel to the hub serving its area", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  const shop = await fx.merchant();
  const rider = await fx.rider(HUB);
  const ops = await fx.staff("OPS_MANAGER");
  const desk = await fx.staff("HUB_OPERATOR", HUB);
  const [dest] = await sql<{ name: string }>(`SELECT h.name FROM delivery_zones z JOIN hubs h ON h.id = z."hubId" WHERE z.district = 'Dhaka Central' AND z.name = 'Dhanmondi'`);
  const api = await (await browser.newContext()).newPage();
  const token = (await (await api.request.post(apiUrl("/api/v1/auth/login"), { data: { identifier: ops.login, password: ops.password } })).json()).accessToken as string;
  const call = (path: string, data: object) => api.request.post(apiUrl(`/api/v1${path}`), { headers: { authorization: `Bearer ${token}` }, data });
  const booked = await call("/ops/parcels", { merchantId: shop.id, recipient: { name: `Transfer E2E ${fx.stamp}`, phone: "01812000000" }, delivery: { category: "Home", street: "Road 7, Flat 3B", zone: "Dhanmondi", district: "Dhaka Central" }, serviceLevel: "Regular", weightKg: 1, codAmount: 0 });
  const id = (await booked.json()).trackingId as string;
  fx.adoptParcel(id);
  await call(`/parcels/${id}/assign-pickup`, { riderId: rider.riderId });

  await page.goto("/login");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.fill("#loginIdentity", desk.login);
  await page.fill("#loginPassword", desk.password);
  await page.click('form[data-form="login"] button[type="submit"]');
  await page.waitForURL(/courier-operation/);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  const scanIt = async (expected: string) => {
    await page.fill("#hdScan", id);
    await page.press("#hdScan", "Enter");
    await expect(page.locator("#hdLog li").first()).toContainText(expected);
  };
  await opsNav(page, "hubPickupEntry");
  await scanIt("picked up by");
  await opsNav(page, "hubTransferOut");
  await expect(page.locator("#hdToHub")).toHaveValue("");
  await scanIt(`${id} sent to ${dest.name} (in transit)`);
  await expect(page.locator("#hdCount")).toHaveText("1 sent");
  const [p] = await sql<{ status: string; hub: string }>(`SELECT p.status, h.name AS hub FROM parcels p JOIN hubs h ON h.id = p."currentHubId" WHERE p."trackingId" = $1`, [id]);
  expect(p).toEqual({ status: "IN_TRANSIT", hub: dest.name });
  await scanIt("already on its way");
  expect(errors).toEqual([]);
});

test("scan desk: return rider assign, send out, return entry — the run completes with the last parcel", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  const shop = await fx.merchant();
  const rider = await fx.rider(HUB);
  const ops = await fx.staff("OPS_MANAGER");
  const desk = await fx.staff("HUB_OPERATOR", HUB);
  const [hub] = await sql<{ id: string }>(`SELECT id FROM hubs WHERE name = $1`, [HUB]);
  const api = await (await browser.newContext()).newPage();
  const token = (await (await api.request.post(apiUrl("/api/v1/auth/login"), { data: { identifier: ops.login, password: ops.password } })).json()).accessToken as string;
  const call = (path: string, data: object) => api.request.post(apiUrl(`/api/v1${path}`), { headers: { authorization: `Bearer ${token}` }, data });
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const booked = await call("/ops/parcels", { merchantId: shop.id, recipient: { name: `Return E2E ${fx.stamp} ${i}`, phone: "01812000000" }, delivery: { category: "Home", street: "Road 7, Flat 3B", zone: "Dhanmondi", district: "Dhaka Central" }, serviceLevel: "Regular", weightKg: 1, codAmount: 0 });
    const id = (await booked.json()).trackingId as string;
    fx.adoptParcel(id);
    await call(`/parcels/${id}/assign-pickup`, { riderId: rider.riderId });
    await call(`/parcels/${id}/status`, { status: "PICKED_UP" });
    await call(`/parcels/${id}/status`, { status: "AT_HUB", hubId: hub.id });
    ids.push(id);
  }

  await page.goto("/login");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.fill("#loginIdentity", desk.login);
  await page.fill("#loginPassword", desk.password);
  await page.click('form[data-form="login"] button[type="submit"]');
  await page.waitForURL(/courier-operation/);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  // Return rider assign: the rider and a reason, then scan both: one run for the merchant; send it out.
  await opsNav(page, "hubReturnAssign");
  await page.fill("#hdScan", ids[0]);
  await page.press("#hdScan", "Enter");
  await expect(page.locator("#hdLog li").first()).toContainText("Choose the rider first");
  await page.selectOption("#hdRider", rider.riderId);
  await page.fill("#hdReturnReason", "Recipient refused");
  for (const id of ids) {
    await page.fill("#hdScan", id);
    await page.press("#hdScan", "Enter");
    await expect(page.locator("#hdLog li").first()).toContainText(`${id} on return run`);
  }
  const runRow = page.locator("#hdRuns tr[data-run]");
  await expect(runRow).toHaveCount(1);
  await expect(runRow).toContainText(shop.name);
  await expect(runRow.locator("td").nth(3)).toHaveText("2");
  const runNumber = (await runRow.getAttribute("data-run"))!;
  await runRow.locator("[data-send-run]").click();
  await expect(page.locator("#hdLog li").first()).toContainText(`Return run ${runNumber} is out with its rider.`);
  await expect(page.locator("#hdRuns tr[data-run]")).toHaveCount(0);
  const [{ id: runId }] = await sql<{ id: string }>(`SELECT id FROM return_runs WHERE number = $1`, [runNumber]);

  // Return entry: the merchant took both back.
  await opsNav(page, "hubReturnEntry");
  await page.fill("#hdReturnBy", "Shop manager");
  for (const [i, id] of ids.entries()) {
    await page.fill("#hdScan", id);
    await page.press("#hdScan", "Enter");
    await expect(page.locator("#hdLog li").first()).toContainText(i === 0 ? `${id} returned to ${shop.name}.` : "completed");
  }
  // Received by stays set for the batch.
  await expect(page.locator("#hdReturnBy")).toHaveValue("Shop manager");
  await expect(page.locator("#hdCount")).toHaveText("2 returned");
  const statuses = await sql<{ status: string }>(`SELECT status FROM parcels WHERE "trackingId" = ANY($1)`, [ids]);
  expect(statuses.map(s => s.status)).toEqual(["RETURNED", "RETURNED"]);
  expect((await sql<{ status: string }>(`SELECT status FROM return_runs WHERE id = $1`, [runId]))[0].status).toBe("COMPLETED");
  expect(errors).toEqual([]);
});
