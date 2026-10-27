import { type Browser, type BrowserContextOptions, type Page, type Route } from "@playwright/test";
import { Fixtures, apiUrl, confirmDialog, expect, test, type TempRider } from "./support";

/*
 * Rider app as an offline-capable PWA. Signs in as a temporary rider (support.ts) and never changes
 * real data: task lists, task updates, shift changes and location posts are intercepted, so the
 * browser side (queue, Idempotency-Key replay, conflicts, proof capture, GPS throttling) is
 * tested here and the API side in apps/api/test/rider-app.e2e.test.ts.
 */
const fx = new Fixtures();
let rider: TempRider;
test.beforeAll(async () => {
  rider = await fx.rider("Gulshan Sorting Hub");
});
test.afterAll(() => fx.cleanup());
const DHAKA = { latitude: 23.7808, longitude: 90.4142, accuracy: 15 };

async function signedInRider(browser: Browser, options: BrowserContextOptions = {}, setup?: (page: Page) => Promise<void>) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.on("dialog", dialog => dialog.accept());
  if (setup) await setup(page);
  // Sign in through the API (sets the refresh cookie the app restores the session from).
  // (Retried while the API restarts in watch mode.)
  let login = await page.request.post(apiUrl("/api/v1/auth/login"), { data: { identifier: rider.login, password: rider.password }, headers: { "x-df-client": "web" } });
  for (let i = 0; i < 10 && login.status() >= 500; i++) {
    await page.waitForTimeout(3000);
    login = await page.request.post(apiUrl("/api/v1/auth/login"), { data: { identifier: rider.login, password: rider.password }, headers: { "x-df-client": "web" } });
  }
  expect(login.status(), await login.text()).toBe(200);
  await page.goto("/rider");
  await expect(page).toHaveURL(/\/rider/);
  await page.waitForSelector("html.legacy-ready", { state: "attached" });
  return { context, page };
}

/** A delivery task in the shape GET /rider/tasks returns. */
function task(trackingId: string, recipient: string) {
  const now = new Date().toISOString();
  const address = { category: "OFFICE", street: "Road 7, Flat 3B", area: "Dhanmondi Road 7", zone: "Dhanmondi", district: "Dhaka Central", label: "Office, Road 7, Flat 3B, Dhanmondi", lat: null, lng: null };
  return {
    id: `00000000-0000-7000-8000-${trackingId.replace(/\D/g, "").padStart(12, "0").slice(-12)}`,
    trackingId,
    channel: "WEBSITE",
    status: "OUT_FOR_DELIVERY",
    statusLabel: "Out for delivery",
    merchant: null,
    sender: { name: "Rahim Uddin", phone: "+8801711000000" },
    pickup: { ...address, category: "HOME", label: "Home, House 5, Gulshan" },
    recipient: { name: recipient, phone: "+8801812000000" },
    delivery: address,
    serviceLevel: "SAME_DAY",
    serviceLevelLabel: "Same day",
    weightKg: 1,
    packaging: "Envelope",
    contents: "Documents",
    charges: { base: 120, weight: 0, service: 30, codFee: 0, discount: 0, total: 150 },
    codAmount: 0,
    pickupRider: null,
    deliveryRider: { id: rider.riderId, code: rider.code, name: rider.name, label: `${rider.code} · ${rider.name}` },
    currentHub: null,
    proof: null,
    canCancel: false,
    estimatedDeliveryAt: null,
    pickedUpAt: now,
    deliveredAt: null,
    createdAt: now,
    updatedAt: now,
    events: [],
    devDeliveryCode: null,
  };
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function signature(page: Page) {
  const box = (await page.locator("#signatureCanvas").boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 60, { steps: 6 });
  await page.mouse.move(box.x + 200, box.y + 25, { steps: 6 });
  await page.mouse.up();
}

test("installable: manifest, service worker and the app opening offline", async ({ browser }) => {
  const { context, page } = await signedInRider(browser);
  const manifest = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifest).toBe("/rider.webmanifest");
  const parsed = await (await page.request.get(manifest!)).json();
  expect(parsed).toMatchObject({ scope: "/rider", display: "standalone" });
  expect(parsed.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));

  // The worker takes control on the first visit and caches the shell.
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 30_000 });
  await page.waitForFunction(async () => !!(await caches.match("/rider")) && !!(await caches.match("/legacy/rider/bridge.js")), null, { timeout: 30_000 });
  await page.waitForTimeout(1500); // let the page's own resources reach the runtime cache

  // `next dev` can't hydrate any page without its dev server (React's dev debug channel runs over
  // the HMR socket), so opening offline is only checked against a production build
  // (`next build && next start`, or the Docker stack).
  const devServer = await page.evaluate(() => [...document.scripts].some(s => /hmr-client|_development_/.test(s.src)));
  test.skip(devServer, "Opening offline needs a production build of the web app");

  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector("html.legacy-ready", { state: "attached", timeout: 30_000 });
  await expect(page.locator("#dfOfflineStrip")).toContainText("You're offline");
  await expect(page.locator("#dfSyncChip")).toContainText("Offline");
  await expect(page.locator(".rider-info small")).toContainText(rider.code);
  // Pages still open from the saved data.
  await page.click('#navigation [data-page="Settings"]');
  await expect(page.locator("#dfDevicePanel")).toContainText("Location & offline");
  await context.setOffline(false);
  await expect(page.locator("#dfSyncChip")).toBeHidden({ timeout: 15_000 });
  await context.close();
});

test("opens with the saved rider and task list when Paira Express can't be reached", async ({ browser }) => {
  const { context, page } = await signedInRider(browser, { serviceWorkers: "block" });
  await page.waitForTimeout(1000); // the session and task list are saved in IndexedDB
  // Every API call now fails as it would without a connection (the page itself still loads).
  await page.route("**/api/v1/**", route => route.abort("internetdisconnected"));
  await page.reload();
  await page.waitForSelector("html.legacy-ready", { state: "attached", timeout: 30_000 });
  await expect(page.locator("#dfOfflineStrip")).toContainText("Showing your tasks as saved at");
  expect(await page.evaluate(() => (window as any).DF.state.offlineSession)).toBe(true);
  await expect(page.locator(".rider-info small")).toContainText(rider.code);
  await page.unroute("**/api/v1/**");
  await context.close();
});

test("offline deliveries are queued with proof, replayed with an Idempotency-Key, and refusals are shown", async ({ browser }) => {
  const posted: { trackingId: string; key: string | null; body: any }[] = [];
  const tasks = { pickups: [], deliveries: [task("PP-990101-0001", "Offline Recipient"), task("PP-990101-0002", "Changed Recipient")] };
  const { context, page } = await signedInRider(
    browser,
    { serviceWorkers: "block", permissions: ["geolocation"], geolocation: DHAKA },
    async page => {
      await page.route("**/api/v1/rider/tasks", route => json(route, { pickups: tasks.pickups, deliveries: tasks.deliveries }));
      await page.route("**/api/v1/rider/parcels/*/delivery", route => {
        const trackingId = decodeURIComponent(route.request().url().split("/rider/parcels/")[1].split("/")[0]);
        posted.push({ trackingId, key: route.request().headers()["idempotency-key"] ?? null, body: route.request().postDataJSON() });
        if (trackingId.endsWith("0002")) return json(route, { error: { code: "PARCEL_CHANGED", message: "This parcel was changed by someone else. Reload and try again.", requestId: "t" } }, 409);
        tasks.deliveries = tasks.deliveries.filter(d => d.trackingId !== trackingId);
        return json(route, { ...task(trackingId, "x"), status: "DELIVERED", statusLabel: "Delivered" });
      });
    },
  );

  await page.click('#navigation [data-page="Deliveries"]');
  await expect(page.locator('[data-delivery="PP-990101-0001"]')).toBeVisible();

  // Offline: record both deliveries with signature proof.
  await context.setOffline(true);
  for (const id of ["PP-990101-0001", "PP-990101-0002"]) {
    await page.click(`[data-delivery="${id}"]`);
    await expect(page.locator("#dfProofStamp")).toContainText("Proof will be stamped", { timeout: 15_000 });
    await signature(page);
    await page.click("#submitAction");
    await expect(page.locator("#toast")).toContainText(`${id}: saved on this phone`);
  }
  await expect(page.locator("#dfSyncChip")).toContainText("Offline · 2 pending");
  await expect(page.locator('[data-delivery="PP-990101-0001"]')).toHaveCount(0);
  expect(posted).toHaveLength(0);

  // Back online: replayed in order with their keys; the refused one needs attention.
  await context.setOffline(false);
  await expect(page.locator("#dfSyncChip")).toContainText("1 needs attention", { timeout: 20_000 });
  expect(posted.map(p => p.trackingId)).toEqual(["PP-990101-0001", "PP-990101-0002"]);
  expect(posted[0].key).toMatch(/^[\w-]{8,100}$/);
  expect(posted[0].key).not.toBe(posted[1].key);
  const body = posted[0].body;
  expect(body).toMatchObject({ outcome: "DELIVERED", receivedBy: "Offline Recipient", proof: { method: "SIGNATURE" }, capture: { lat: DHAKA.latitude, lng: DHAKA.longitude, accuracy: 15 } });
  expect(body.proof.image).toMatch(/^data:image\/png;base64,/);
  expect(Date.now() - new Date(body.capture.capturedAt).getTime()).toBeLessThan(120_000);

  await page.click("#dfSyncChip");
  await expect(page.locator("#modalFields")).toContainText("This parcel was changed by someone else");
  await page.click("[data-df-queue-discard]");
  await confirmDialog(page, { title: "Discard this update?" });
  await expect(page.locator("#modalFields")).toContainText("No updates waiting", { timeout: 10_000 });
  await context.close();
});

test("live GPS while on shift, throttled, with the browser limits explained", async ({ browser }) => {
  const fixes: any[] = [];
  const { context, page } = await signedInRider(browser, { serviceWorkers: "block", permissions: ["geolocation"], geolocation: DHAKA }, async page => {
    await page.route("**/api/v1/rider/me/status", route => json(route, { status: JSON.parse(route.request().postData() || "{}").status }));
    await page.route("**/api/v1/rider/location", route => {
      // GET /rider/location is the status line's "last sent" (passed through); POSTs are the fixes.
      if (route.request().method() !== "POST") return route.fallback();
      fixes.push(route.request().postDataJSON());
      return json(route, { accepted: 1, ignored: 0, live: true }, 202);
    });
  });
  await page.evaluate(() => (window as any).DF.riderState.status !== "ONLINE" && document.getElementById("shiftToggle")?.click());
  await expect.poll(() => fixes.length, { timeout: 20_000 }).toBeGreaterThan(0);
  expect(fixes[0]).toMatchObject({ lat: DHAKA.latitude, lng: DHAKA.longitude, accuracy: 15 });

  // A move of a few metres within seconds isn't sent; ~300 m is (after the minimum interval).
  await context.setGeolocation({ latitude: DHAKA.latitude + 0.0001, longitude: DHAKA.longitude });
  await page.waitForTimeout(2000);
  expect(fixes).toHaveLength(1);

  await page.click('#navigation [data-page="Settings"]');
  await expect(page.locator("#dfDevicePanel")).toContainText("Sharing your location with dispatch");
  await expect(page.locator("#dfDevicePanel")).toContainText("Browsers share location only while the rider app is open");
  await expect(page.locator("#dfKycPanel")).toContainText("Verification documents");
  await expect(page.locator("#dfPrefsPanel")).toContainText("Notification settings");
  await context.close();
});
