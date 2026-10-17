// Load order: the API client (restores the session and checks the role), the original page
// scripts, then the merchant bridge, which swaps their sample data for the API's and connects
// their actions. See public/legacy/README.md.
export const scripts = [
  "/legacy/shared/api.js",
  // PDF printing (DFPrint): every print button opens an API-generated PDF in a new tab.
  "/legacy/shared/print.js",
  "/legacy/ecommerce-merchant/01.js",
  "/legacy/ecommerce-merchant/02.js",
  "/legacy/ecommerce-merchant/03.js",
  "/legacy/ecommerce-merchant/04.js",
  "/legacy/shared/support.js",
  "/legacy/shared/importer.js",
  "/legacy/shared/order-services.js",
  "/legacy/shared/merchant-bridge.js",
  "/legacy/ecommerce-merchant/bridge.js",
  "/legacy/shared/merchant-features.js"
];
