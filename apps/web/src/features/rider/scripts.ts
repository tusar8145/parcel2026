// Load order: the rider app's offline store (runs before the API client so the app can open
// without a connection), the API client (restores the session and data), the original page
// scripts, then the bridges, which connect their actions to the API. See public/legacy/README.md.
// Keep public/rider-sw.js (PRECACHE) in step with this list.
export const scripts = [
  "/legacy/rider/offline.js",
  "/legacy/shared/api.js",
  // Searchable long selects (DF.searchSelect) and "Choose file" controls (DF.fileInput), applied automatically.
  "/legacy/shared/select-search.js",
  "/legacy/shared/file-input.js",
  "/legacy/rider/01.js",
  "/legacy/rider/02.js",
  "/legacy/shared/support.js",
  // In-app notifications: the bell (unread count, latest) and the Notifications page (before the bridges: the bell is its own).
  "/legacy/shared/notifications.js",
  "/legacy/shared/scanner.js",
  "/legacy/rider/bridge.js",
  "/legacy/rider/bridge-proof.js",
  "/legacy/rider/bridge-pwa.js",
  // "Travelling with a vehicle": this phone shares a linehaul trip's vehicle position (DFVehicleShare).
  "/legacy/shared/vehicle-share.js",
  "/legacy/rider/bridge-vehicle.js",
  "/legacy/rider/bridge-account.js",
  "/legacy/rider/bridge-scan.js",
  // Last: every page (and scan section) has its own address: ?page=<slug>[&tab=<slug>], Back / Forward, titles (DF.nav).
  "/legacy/shared/panel-nav.js"
];
