// Load order: the API client (restores the session and checks the role), the original page
// scripts, then the bridge that runs them on API data. See public/legacy/README.md.
export const scripts = [
  "/legacy/shared/api.js",
  "/legacy/super-admin/01.js",
  "/legacy/super-admin/02.js",
  "/legacy/super-admin/03.js",
  "/legacy/super-admin/bridge.js",
  "/legacy/super-admin/bridge-merchants.js",
  "/legacy/super-admin/bridge-notifications.js",
  "/legacy/super-admin/bridge-imports.js",
  "/legacy/shared/mfa.js",
  "/legacy/super-admin/bridge-security.js"
];
