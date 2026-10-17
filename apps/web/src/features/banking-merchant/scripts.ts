// Load order: the API client (restores the session and checks the role), the original page
// scripts, then the merchant bridge, which swaps their sample data for the API's and connects
// their actions. See public/legacy/README.md.
export const scripts = [
  "/legacy/shared/api.js",
  "/legacy/banking-merchant/01.js",
  "/legacy/banking-merchant/02.js",
  "/legacy/banking-merchant/03.js",
  "/legacy/banking-merchant/04.js",
  "/legacy/banking-merchant/05.js",
  "/legacy/shared/support.js",
  "/legacy/shared/importer.js",
  "/legacy/shared/order-services.js",
  "/legacy/shared/merchant-bridge.js",
  "/legacy/banking-merchant/bridge.js",
  "/legacy/shared/merchant-features.js"
];
