import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests through the real UI against a running stack (API + web), e.g.
 *   npm run db:up && npm run dev:api   (apps/api, seeded with `npm run db:seed` for the staff accounts)
 *   npm run dev                        (apps/web)
 *   npx playwright test -c playwright.e2e.config.ts
 *
 * Environment:
 *   E2E_BASE_URL      the web app (default http://localhost:3000)
 *   E2E_API_ORIGIN    an API on another port than the web app's proxy target, e.g. http://localhost:4111;
 *                     every spec uses `test` from tests/e2e/support.ts, which forwards the pages' /api/v1
 *                     calls there, the live event stream included
 *   E2E_DATABASE_URL  the database the specs create their temporary accounts in and clean up
 *                     (default postgresql://deliveryfast:deliveryfast@localhost:5432/deliveryfast)
 * The specs need only the seeded staff accounts (*@deliveryfast.example, password DeliveryFast2026);
 * merchants, riders and customers are temporary and deleted afterwards.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
    // The cookie choice is already made, so the consent banner doesn't cover buttons (website.spec.ts tests the banner).
    storageState: { cookies: [], origins: [{ origin: baseURL, localStorage: [{ name: "deliveryfast-cookie-consent", value: JSON.stringify({ analytics: false, at: new Date().toISOString() }) }] }] },
  },
});
