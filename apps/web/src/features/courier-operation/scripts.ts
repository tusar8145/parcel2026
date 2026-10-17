// Load order: the API client (restores the session and data), the original page scripts,
// then bridge.js (shipments and parcel actions) and bridge-pages.js (the other pages), which connect them to the API. See public/legacy/README.md.
export const scripts = [
  "/legacy/shared/api.js",
  // PDF printing (DFPrint): every print button opens an API-generated PDF in a new tab.
  "/legacy/shared/print.js",
  "/legacy/courier-operation/01.js",
  "/legacy/courier-operation/02.js",
  "/legacy/courier-operation/03.js",
  "/legacy/courier-operation/04.js",
  "/legacy/shared/support.js",
  "/legacy/shared/scanner.js",
  "/legacy/shared/mfa.js",
  "/legacy/shared/order-services.js",
  "/legacy/courier-operation/bridge.js",
  "/legacy/courier-operation/bridge-pages.js",
  "/legacy/courier-operation/bridge-network.js",
  "/legacy/courier-operation/bridge-hubs.js",
  "/legacy/courier-operation/bridge-maps.js",
  "/legacy/courier-operation/bridge-sla.js",
  "/legacy/courier-operation/bridge-linehaul.js",
  "/legacy/courier-operation/bridge-cn.js",
  "/legacy/courier-operation/bridge-shifts.js",
  "/legacy/courier-operation/bridge-reports.js",
  "/legacy/courier-operation/bridge-rider-kyc.js",
  "/legacy/courier-operation/bridge-rider-pay.js"
,
  "/legacy/courier-operation/bridge-returns.js",
  "/legacy/courier-operation/bridge-finance.js",
  "/legacy/courier-operation/bridge-intake.js",
  "/legacy/courier-operation/bridge-collect.js",
  "/legacy/shared/importer.js",
  "/legacy/courier-operation/bridge-imports.js",
  "/legacy/courier-operation/bridge-bulk.js",
  // Server-paged parcel tables, the "my hub" scope, stage counts and bulk Accept & assign.
  "/legacy/courier-operation/bridge-lists.js",
  // Desk tools: live chip, alerts bell, zone → hub lookup, keyboard shortcuts, Hub desk › End of day.
  "/legacy/courier-operation/bridge-desk.js",
  // Last: the parcel drawer / next action / global search, then the journey navigation (menu,
  // tabs, counts, role menu, old page names), which wrap everything above.
  "/legacy/courier-operation/bridge-parcel.js",
  "/legacy/courier-operation/bridge-nav.js"
];
