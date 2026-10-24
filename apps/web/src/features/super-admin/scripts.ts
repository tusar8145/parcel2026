// Load order: the API client (restores the session and checks the role), the original page
// scripts, then the bridge that runs them on API data. See public/legacy/README.md.
export const scripts = [
  "/legacy/shared/api.js",
  // Searchable long selects (DF.searchSelect) and "Choose file" controls (DF.fileInput), applied automatically.
  "/legacy/shared/select-search.js",
  "/legacy/shared/file-input.js",
  // Dashboard period filter (DF.period): Today / This week / This month / custom range, remembered per page.
  "/legacy/shared/period.js",
  "/legacy/super-admin/01.js",
  "/legacy/super-admin/02.js",
  "/legacy/super-admin/03.js",
  // In-app notifications: the bell (unread count, latest) and the Notifications page (before the bridges: the bell is its own).
  "/legacy/shared/notifications.js",
  // Structured merchant addresses (DFMerchantAddress): Settings editor and the staff summary.
  "/legacy/shared/merchant-address.js",
  "/legacy/super-admin/bridge.js",
  "/legacy/super-admin/bridge-merchants.js",
  "/legacy/super-admin/bridge-notifications.js",
  "/legacy/super-admin/bridge-imports.js",
  "/legacy/super-admin/bridge-geo.js",
  "/legacy/super-admin/bridge-packages.js",
  // Franchises: partner-run hubs, their commission and the settlement settings (super-admin/bridge-franchise.js).
  "/legacy/super-admin/bridge-franchise.js",
  // Hubs & zones: hub register, serving hub of each delivery zone, routes (moved from Courier Operations).
  "/legacy/super-admin/bridge-hubs-admin.js",
  // Rider plans › "Rider location": the location interval (2 / 5 / 10 min) and movement threshold.
  "/legacy/super-admin/bridge-location.js",
  // Platform settings › Finance approvals: single or double approval of merchant settlements.
  "/legacy/super-admin/bridge-finance-approval.js",
  "/legacy/shared/mfa.js",
  "/legacy/super-admin/bridge-security.js",
  // Period filter on Overview and Platform activity.
  "/legacy/super-admin/bridge-period.js",
  // Last: every page (and tab) has its own address: ?page=<slug>[&tab=<slug>], Back / Forward, titles (DF.nav).
  "/legacy/shared/panel-nav.js"
];
