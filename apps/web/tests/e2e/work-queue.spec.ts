import { type Page } from "@playwright/test";
import { Fixtures, apiUrl, expect, sql, test } from "./support";

/**
 * Courier Operations → Work queue, through the UI: a parcel booked in Dhaka for Barishal is worked
 * step by step by scanning (pickup rider, receive at Badda, dispatch Dhaka → Barishal, receive at
 * Barishal, delivery rider, out for delivery), with the route groups, the Excel file and the
 * missing-details count. Temporary accounts and parcels are deleted afterwards (support.ts).
 */
const fx = new Fixtures();
test.afterAll(() => fx.cleanup());

const ORIGIN = "Badda Delivery Hub";
const DEST = "Barishal Hub";

async function status(trackingId: string) {
  const [p] = await sql<{ status: string; hub: string | null }>(`SELECT p.status, h.name AS hub FROM parcels p LEFT JOIN hubs h ON h.id = p."currentHubId" WHERE p."trackingId" = $1`, [trackingId]);
  return p;
}
/** Opens a step on the left and one of its groups ("" = All). */
async function openStep(page: Page, task: string, groupLabel?: string) {
  const step = page.locator(`.wq-step[data-wq-task="${task}"]`);
  if ((await step.getAttribute("aria-expanded")) !== "true") await step.click();
  const groups = page.locator(`[data-wq-groups="${task}"]`);
  const group = groupLabel ? groups.locator(".wq-group", { hasText: groupLabel }) : groups.locator('.wq-group[data-wq-group=""]');
  await group.click();
  await expect(page.locator("#wqList")).toHaveAttribute("data-wq-task", task);
}
async function scan(page: Page, trackingId: string, expected: RegExp) {
  await page.fill("#wqScan", trackingId);
  await page.press("#wqScan", "Enter");
  await expect(page.locator("#wqLog li").first()).toContainText(expected, { timeout: 20_000 });
}

test("work queue: groups, Excel and scan-to-do from booking to out for delivery", async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  const ops = await fx.staff("OPS_MANAGER");
  const shop = await fx.merchant();
  const pickupRider = await fx.rider(ORIGIN);
  const deliveryRider = await fx.rider(DEST);
  const [origin] = await sql<{ id: string }>(`SELECT id FROM hubs WHERE name = $1`, [ORIGIN]);

  // A parcel for Barishal, booked by operations for the merchant.
  const login = await page.request.post(apiUrl("/api/v1/auth/login"), { data: { identifier: ops.login, password: ops.password } });
  const token = (await login.json()).accessToken as string;
  const booked = await page.request.post(apiUrl("/api/v1/ops/parcels"), {
    headers: { authorization: `Bearer ${token}` },
    data: { merchantId: shop.id, recipient: { name: `Queue E2E ${fx.stamp}`, phone: "01812000000" }, delivery: { category: "Home", street: "Sadar Road 4", zone: "Kotwali (Barishal)", district: "Barishal" }, serviceLevel: "Regular", weightKg: 1, codAmount: 500 },
  });
  expect(booked.status(), await booked.text()).toBe(201);
  const id = (await booked.json()).trackingId as string;
  fx.adoptParcel(id);
  // A second order that stays waiting for a pickup rider (the last step opens that list).
  const waiting = await page.request.post(apiUrl("/api/v1/ops/parcels"), {
    headers: { authorization: `Bearer ${token}` },
    data: { merchantId: shop.id, recipient: { name: `Queue E2E waiting ${fx.stamp}`, phone: "01812000001" }, delivery: { category: "Home", street: "Sadar Road 5", zone: "Kotwali (Barishal)", district: "Barishal" }, serviceLevel: "Regular", weightKg: 1, codAmount: 0 },
  });
  expect(waiting.status(), await waiting.text()).toBe(201);
  fx.adoptParcel((await waiting.json()).trackingId as string);
  await page.context().clearCookies();

  await page.goto("/login");
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.fill("#loginIdentity", ops.login);
  await page.fill("#loginPassword", ops.password);
  await page.click('form[data-form="login"] button[type="submit"]');
  await expect(page).toHaveURL(/\/courier-operation/);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await page.click('#navigation [data-nav="Work queue"]');
  await expect(page.locator("#mainContent h1")).toHaveText("Work queue");
  await expect(page).toHaveURL(/page=work-queue/);
  await expect(page.locator('.wq-step[data-wq-task="pickup-assign"] .wq-count')).not.toHaveText("0");
  await expect(page.locator("#wqMissing")).toContainText("Missing delivery details");

  // 1. Pickup to assign: choose the rider, scan.
  await openStep(page, "pickup-assign");
  await expect(page.locator(`#wqList tr[data-wq-parcel="${id}"]`)).toBeVisible();
  await scan(page, id, /Choose the rider first/);
  await page.selectOption("#wqRider", pickupRider.riderId);
  await scan(page, id, new RegExp(`${id} assigned to .+ for pickup`));
  expect((await status(id)).status).toBe("PICKUP_ASSIGNED");

  // 2. The rider collects it; received at Badda by scanning.
  const picked = await page.evaluate(t => (window as unknown as { DF: { api: (p: string, o: object) => Promise<unknown> } }).DF.api(`/parcels/${t}/status`, { method: "POST", body: { status: "PICKED_UP" } }), id);
  expect(picked).toBeTruthy();
  await openStep(page, "pickup-receive");
  await page.selectOption("#wqReceiveHub", origin.id);
  await scan(page, id, new RegExp(`${id}`));
  await expect.poll(async () => await status(id)).toEqual({ status: "AT_HUB", hub: ORIGIN });

  // 3. Dhaka → Barishal: the route group, its Excel file, dispatch by scanning.
  await openStep(page, "transfer-send", `${ORIGIN} → ${DEST}`);
  await expect(page.locator(`#wqList tr[data-wq-parcel="${id}"]`)).toContainText(`${ORIGIN} → ${DEST}`);
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#wqExport")]);
  expect(download.suggestedFilename()).toMatch(/^work-queue-transfer-send-.+\.xlsx$/);
  await scan(page, id, new RegExp(`${id} dispatched to ${DEST}`));
  await expect(page.locator(`#wqList tr[data-wq-parcel="${id}"]`)).toHaveCount(0);
  await expect.poll(async () => (await status(id)).status).toBe("IN_TRANSIT");

  // 4. Received at Barishal.
  await openStep(page, "transfer-receive", `${ORIGIN} → ${DEST}`);
  await expect(page.locator("#wqReceiveHub")).toHaveValue(""); // each list starts at the parcel's expected hub
  await page.selectOption("#wqReceiveHub", origin.id);
  await scan(page, id, new RegExp(`${id} is going to ${DEST}, not ${ORIGIN}`));
  await page.selectOption("#wqReceiveHub", "");
  await scan(page, id, new RegExp(`${id}.*${DEST}|${DEST}.*${id}|received`, "i"));
  await expect.poll(async () => await status(id)).toEqual({ status: "AT_HUB", hub: DEST });

  // 5. Delivery rider, then out for delivery.
  await openStep(page, "delivery-assign", DEST);
  await page.selectOption("#wqRider", deliveryRider.riderId);
  await scan(page, id, new RegExp(`${id} assigned to .+ for delivery`));
  await openStep(page, "delivery-dispatch");
  await scan(page, id, new RegExp(`${id} is out for delivery`));
  await expect.poll(async () => (await status(id)).status).toBe("OUT_FOR_DELIVERY");

  // A parcel that isn't waiting for the step is refused with the reason.
  await openStep(page, "pickup-assign");
  await page.selectOption("#wqRider", pickupRider.riderId);
  await scan(page, id, /isn't waiting for "Pickups to assign"/);

  // Missing delivery details: its own list on the right.
  await page.click("#wqMissing");
  await expect(page.locator("#wqList")).toHaveAttribute("data-wq-task", "missing-details");
  await expect(page.locator("#wqList .panel-title")).toHaveText("Missing delivery details");

  expect(errors).toEqual([]);
});
