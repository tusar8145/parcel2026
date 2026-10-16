// Load order: the rider app's offline store (runs before the API client so the app can open
// without a connection), the API client (restores the session and data), the original page
// scripts, then the bridges, which connect their actions to the API. See public/legacy/README.md.
// Keep public/rider-sw.js (PRECACHE) in step with this list.
export const scripts = [
  "/legacy/rider/offline.js",
  "/legacy/shared/api.js",
  "/legacy/rider/01.js",
  "/legacy/rider/02.js",
  "/legacy/shared/support.js",
  "/legacy/shared/scanner.js",
  "/legacy/rider/bridge.js",
  "/legacy/rider/bridge-proof.js",
  "/legacy/rider/bridge-pwa.js",
  "/legacy/rider/bridge-account.js"
];
