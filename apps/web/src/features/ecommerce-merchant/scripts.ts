// Load order: the API client (restores the session and checks the role), the original page
// scripts, then the merchant bridge, which swaps their sample data for the API's and connects
// their actions. See public/legacy/README.md.
export const scripts = [
  "/legacy/shared/api.js",
  // Searchable long selects (DF.searchSelect) and "Choose file" controls (DF.fileInput), applied automatically.
  "/legacy/shared/select-search.js",
  "/legacy/shared/file-input.js",
  // Dashboard period filter (DF.period): Today / This week / This month / custom range, remembered per page.
  "/legacy/shared/period.js",
  // PDF printing (DFPrint): every print button opens an API-generated PDF in a new tab.
  "/legacy/shared/print.js",
  "/legacy/ecommerce-merchant/01.js",
  "/legacy/ecommerce-merchant/02.js",
  "/legacy/ecommerce-merchant/03.js",
  "/legacy/ecommerce-merchant/04.js",
  "/legacy/shared/support.js",
  // In-app notifications: the bell (unread count, latest) and the Notifications page (before the bridges: the bell is its own).
  "/legacy/shared/notifications.js",
  "/legacy/shared/importer.js",
  "/legacy/shared/order-services.js",
  "/legacy/shared/merchant-bridge.js",
  "/legacy/ecommerce-merchant/bridge.js",
  "/legacy/shared/merchant-features.js",
  // "Where is it now" map in the parcel drawer (DFParcelMap, GET /parcels/:id/position; Leaflet loads on first use).
  "/legacy/shared/parcel-map.js",
  // Top search and the parcel side drawer (DFMerchantParcel), on the merchant's own parcels.
  "/legacy/shared/merchant-parcel.js",
  // Last: every page (and tab) has its own address: ?page=<slug>[&tab=<slug>], Back / Forward, titles (DF.nav).
  "/legacy/shared/panel-nav.js"
];
