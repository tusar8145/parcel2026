// Load order: the API client (restores the session and data), the original page scripts,
// then bridge.js (shipments and parcel actions) and bridge-pages.js (the other pages), which connect them to the API. See public/legacy/README.md.
export const scripts = [
  "/legacy/shared/api.js",
  // Searchable long selects (DF.searchSelect) and "Choose file" controls (DF.fileInput), applied automatically.
  "/legacy/shared/select-search.js",
  "/legacy/shared/file-input.js",
  // Dashboard period filter (DF.period): Today / This week / This month / custom range, remembered per page.
  "/legacy/shared/period.js",
  // PDF printing (DFPrint): every print button opens an API-generated PDF in a new tab.
  "/legacy/shared/print.js",
  "/legacy/courier-operation/01.js",
  "/legacy/courier-operation/02.js",
  "/legacy/courier-operation/03.js",
  "/legacy/courier-operation/04.js",
  "/legacy/shared/support.js",
  // In-app notifications: the bell (unread count, latest) and the Notifications page (before the bridges: the bell is its own).
  "/legacy/shared/notifications.js",
  "/legacy/shared/scanner.js",
  "/legacy/shared/mfa.js",
  "/legacy/shared/order-services.js",
  // Structured merchant addresses (DFMerchantAddress): Settings editor and the staff summary.
  "/legacy/shared/merchant-address.js",
  "/legacy/courier-operation/bridge.js",
  "/legacy/courier-operation/bridge-pages.js",
  // Merchants: hub column and filter, address changes to approve, change address (the hub follows).
  "/legacy/courier-operation/bridge-merchant-hubs.js",
  "/legacy/courier-operation/bridge-network.js",
  "/legacy/courier-operation/bridge-hubs.js",
  "/legacy/courier-operation/bridge-maps.js",
  "/legacy/courier-operation/bridge-sla.js",
  "/legacy/courier-operation/bridge-linehaul.js",
  // Transfers: "Vehicles on the road" (map + list) and "I'm travelling in this vehicle" from this device.
  "/legacy/shared/vehicle-share.js",
  "/legacy/courier-operation/bridge-vehicles.js",
  "/legacy/courier-operation/bridge-cn.js",
  "/legacy/courier-operation/bridge-shifts.js",
  "/legacy/courier-operation/bridge-reports.js",
  // Reports › Rider report: per rider for a day, with the parcels and CSV.
  "/legacy/courier-operation/bridge-rider-report.js",
  // Reports › Hub transfer report: parcels sent / received hub to hub, with the parcels and CSV (uses the Rider report's styles).
  "/legacy/courier-operation/bridge-hub-transfer-report.js",
  "/legacy/courier-operation/bridge-rider-kyc.js",
  "/legacy/courier-operation/bridge-rider-pay.js",
  "/legacy/courier-operation/bridge-returns.js",
  // Franchise hubs: hub tag, hand a pickup to a franchise hub, franchise deposits and commission invoices.
  "/legacy/courier-operation/bridge-franchise.js",
  // Accounts (money): E-commerce / Financial / Customer accounts, rider cash slips, hub transfers, rider pay, franchise.
  "/legacy/courier-operation/bridge-accounts.js",
  // Accounts tab badges: what waits in each tab (count and amount).
  "/legacy/courier-operation/bridge-accounts-badges.js",
  "/legacy/courier-operation/bridge-intake.js",
  "/legacy/courier-operation/bridge-collect.js",
  "/legacy/shared/importer.js",
  "/legacy/courier-operation/bridge-imports.js",
  "/legacy/courier-operation/bridge-bulk.js",
  // New orders › Scan with phone: QR link, phone photos read into rows, Excel out / in, submit through the importer.
  "/legacy/courier-operation/bridge-scan.js",
  // Top bar › Phone scanner: a phone (QR link) becomes this tab's barcode scanner; codes go into the open scan box.
  "/legacy/courier-operation/bridge-phone-scanner.js",
  // Top bar › Share files: a QR link another device drops files into; they show here until the dialog closes.
  "/legacy/courier-operation/bridge-share.js",
  // Partial delivery: the drawer section, More › Change product type / Return charge.
  "/legacy/courier-operation/bridge-partial.js",
  // Server-paged parcel tables, the "my hub" scope, stage counts and bulk Accept & assign.
  "/legacy/courier-operation/bridge-lists.js",
  // Desk tools: live chip, alerts bell, zone → hub lookup, keyboard shortcuts, Hub desk › End of day.
  "/legacy/courier-operation/bridge-desk.js",
  // Hub desk: Delivered entry (signed slips, slip photo) and Out for delivery, by scanning.
  "/legacy/courier-operation/bridge-hub-desk.js",
  // "Where is it now" map in the parcel drawer (DFParcelMap, GET /parcels/:id/position; Leaflet loads on first use).
  "/legacy/shared/parcel-map.js",
  // Last: the parcel drawer / next action / global search, then the journey navigation (menu,
  // tabs, counts, role menu, old page names), which wrap everything above.
  "/legacy/courier-operation/bridge-parcel.js",
  // Failed deliveries: badge, attempts, "Re-attempt (Assign rider)" / "Return to sender" (uses the drawer and next action above).
  "/legacy/courier-operation/bridge-failed.js",
  // "Log in as" on the Merchants and Riders lists (support access in a new tab; shared/api.js DF.startSupportAccess).
  "/legacy/courier-operation/bridge-login-as.js",
  // Merchants: the register in tabs by merchant type (E-commerce · Banking & Financial · All).
  "/legacy/courier-operation/bridge-merchant-tabs.js",
  // Settings › System guide (a dialog): numbers, parcel statuses, money flow, roles (GET /guide).
  "/legacy/shared/system-guide.js",
  "/legacy/courier-operation/bridge-guide.js",
  // Work queue: each parcel's next step, grouped, with Excel and scan-to-do (its own menu).
  "/legacy/courier-operation/bridge-workqueue.js",
  // Long pages in tabs by task: Transfers, Riders (sections tagged by title).
  "/legacy/courier-operation/bridge-section-tabs.js",
  "/legacy/courier-operation/bridge-nav.js",
  // Super admins: a link back to the super admin panel at the bottom of the sidebar.
  "/legacy/courier-operation/bridge-admin-link.js",
  // Period filter on Today and Analytics & SLA (after the navigation has laid the page out).
  "/legacy/courier-operation/bridge-period.js"
];
