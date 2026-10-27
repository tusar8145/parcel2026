# Legacy page scripts

The public homepage (`/`) is now rendered and interactive with Next.js and React; it does not
load these scripts. The remaining website routes still use the legacy router and bridge while
they are migrated incrementally.

`<page>/NN.js` are the original inline `<script>` blocks from `design-reference/*.html`. The
changes from the originals:
- Links like `rider.html` now point at routes like `/rider`.
- `shared/support.js` detects the page from `<body data-app>`.
- `rider/01.js` takes the rider's identity from the signed-in user.
- One demo hint text in `website/01.js` was updated, and its account overview and orders list
  show only the signed-in customer's parcels (no demo shipments).
- `shared/support.js` keeps the original markup but runs on the support API (see its header).

`src/shared/LegacyScripts.tsx` loads each page's scripts as classic scripts, in the order listed
in `src/features/<page>/scripts.ts`. They share one global scope, as the inline blocks did. Scripts listed
before `shared/api.js` run before it boots (the rider app's `rider/offline.js`, which lets it open
without a connection; the rider app is also an installable PWA: `/rider.webmanifest`, `/rider-sw.js`).

1. `shared/api.js` — the API client (`window.DF`). It restores the session from the refresh
   cookie and sends people without the right role to `/#/login`. It also preloads the data the
   page reads. API-backed storage keys (`pairaexpress-customer-parcels`, `-customer-session`,
   `-customer-address-book`) are served from memory, so the page scripts keep their synchronous
   reads and nothing personal stays in the browser.
2. The page's original scripts.
3. `<page>/bridge.js` (every page; merchant panels share `shared/merchant-bridge.js`) — capture-phase listeners on `window`
   that run before the original handlers. They perform the action through the API, then refresh
   the data, and the page re-renders through its own `storage` event listener.

Form controls in every panel (loaded right after `shared/api.js`; the rider app's service worker precaches them):
`shared/select-search.js` (`DF.searchSelect(select, { label, placeholder, threshold })`) makes every single-choice
select with more than 12 options searchable: the native select stays visible and remains the source of truth (value,
change events, `disabled`, Playwright `selectOption`); opening it (click, tap, Enter / Space / Alt+↓ / F4 or typing)
shows a search box over the options (optgroups kept, ↑ / ↓ / Enter / Esc, ARIA combobox + listbox), rebuilt from the
current options, so selects added or refilled later work too. `data-search` opts a short list in, `data-search="off"`
opts out. `shared/file-input.js` (`DF.fileInput(input, { drop, hint, maxMb, file, button })`) turns every visible
`<input type="file">` into a "Choose file" control (name and size, accept hint, clear ×, drag and drop; `data-file-drop`
for a dashed drop zone, `data-file-hint`, `data-max-mb`, `data-file-button`); the native input stays inside it, so
upload code is unchanged. File inputs hidden on purpose (opened by their own button, e.g. the rider's KYC uploads) are left alone.

Shared UI modules loaded before the bridges that use them: `shared/print.js` (`window.DFPrint`: every print button opens an API-generated PDF in a new tab, see docs/architecture-contracts.md "Printed documents"), `shared/importer.js` (`window.DFImport`:
the Excel/CSV import dialog, history and "Needs info" completion form for the merchant panels and
Courier Operations, drawn with each panel's own modal/table/status classes. Three bulk-create templates:
Customer parcel (operations only), E-commerce and Banking & Financial (API kind `document`). Operations
choose the category and then the merchant (searchable select `#dfiMerchant`, DF.searchSelect) or
"Customer parcel"; merchants get their own category. The first / last mile, drop-off hub and message
choices and the template download follow that merchant's (or the Customer) package; there is no per-row
merchant. Super admin's required columns / defaults per template: `super-admin/bridge-imports.js`; in bulk mode, `DFImport.bulk`, the same
steps run Courier Operations' "Bulk update <page> by Excel" on /bulk-updates, one file per action: step 1
"Choose an action" (`#dfiActions`, the page's actions with counts from `GET /bulk-updates/actions?kind=`;
All parcels offers every action), then that action's download (only its eligible parcels and columns, no
Action column), upload → preview → apply; history by page and action; see courier-operation/bridge-bulk.js
and docs/architecture-contracts.md "Bulk operations by Excel"),
`shared/order-services.js` (`window.DFOrderServices`: the single-order forms' package choices — one
first-mile and one last-mile select, Service, COD tick + amount, open box, messages — the product list
"Name · Type", place selects with "Choose …" placeholders, searchable when long (DF.searchSelect), inline checks
and the price breakdown; used by Courier Operations New shipment in `courier-operation/bridge-pages.js`,
merchant or walk-in sender, and by both merchant order forms in `shared/merchant-bridge.js`; see
docs/architecture-contracts.md "Single-order forms") and
`shared/scanner.js` (barcode scanning).

`shared/merchant-parcel.js` (`window.DFMerchantParcel`, both merchant panels, after `shared/merchant-features.js`): the
top search (tracking ID / CN, order ref, phone, name) and the parcel side drawer on the merchant's own parcels; see
docs/architecture-contracts.md ("Merchant top search and parcel drawer").

`shared/parcel-map.js` (`window.DFParcelMap`, Courier Operations and both merchant panels, before the drawers): the
"Where is it now" map in the parcel drawers (GET /parcels/:id/position; Leaflet loads on first use).
`shared/vehicle-share.js` (`window.DFVehicleShare`, rider app and Courier Operations): "I'm travelling in this
vehicle", this device sends its position as a linehaul trip's vehicle position; UI in `rider/bridge-vehicle.js`
and `courier-operation/bridge-vehicles.js` (Transfers > Vehicles on the road). `super-admin/bridge-location.js`:
Rider plans > "Rider location" interval. See docs/architecture-contracts.md ("Parcel position and vehicle location").

`shared/period.js` (`DF.period`, loaded right after `shared/api.js` in Courier Operations, both merchant panels and
super admin): the dashboard period filter (Today … Last month, Custom range) with the period in the URL and per-page
memory. Used by `courier-operation/bridge-period.js` (Today, COD & settlement, Analytics & SLA; loaded last),
`shared/merchant-bridge.js` (merchant overviews) and `super-admin/bridge-period.js` (Overview, Platform activity);
see docs/architecture-contracts.md ("Dashboard periods").

`shared/notifications.js` (`window.DFNotify`, loaded right after the page scripts and `shared/support.js`, before the
bridges, in every panel): the bell's unread count, the notifications dropdown and the Notifications page
(`GET /me/notifications`). `shared/panel-nav.js` (loaded last in super admin, both merchant panels and the rider app)
connects the panel's renderer to `DF.nav` (shared/api.js): every page and tab has its own address
(`?page=<slug>[&tab=<slug>]`), Back / Forward and titles; Courier Operations does the same in `bridge-nav.js`. See
docs/architecture-contracts.md ("Page addresses", "In-app notifications").

Dialogs: no panel uses `window.confirm` / `prompt` / `alert`. `shared/api.js` has `DF.confirm`, `DF.prompt`,
`DF.choose` and `DF.alert` (one small in-page dialog for every panel); Courier Operations forms use
`Ops.form` (bridge-network.js: labelled fields, inline validation, a review step for money). See
docs/architecture-contracts.md "In-page dialogs".

`courier-operation/bridge-desk.js` (loaded before the drawer and navigation pair): the live chip, the alerts
bell, the zone → serving hub lookup in the top-bar search, keyboard shortcuts and Hub desk › End of day.

`courier-operation/bridge-lists.js` makes every Courier Operations parcel table a server-paged list
(`DFOps.lists`: 100 rows a page, "Load more", server-side search and filters, live row patches), holds the
hub operators' "My hub / All hubs" scope (`DFOps.scope`) and the stage counts (`GET /ops/stage-counts`,
`[data-count-key]`), and adds bulk Accept & assign to New orders.

Courier Operations navigation (around the parcel journey) is the last pair of scripts:
`courier-operation/bridge-parcel.js` (parcel drawer `DFOps.drawer.open(id)`, the "next action" per parcel
`DFOps.nextAction(parcel)` / `DFOps.runNext(kind, id)` with the row's other buttons under "More", and the
top-bar search: tracking ID, CN or phone → drawer) and `courier-operation/bridge-nav.js` (the menu in
`Sidebar.tsx`, `data-nav` views with `data-nav-tab` tabs, live stage counts, the role's menu, stage bulk
updates, `DFOps.navigate(view, tab)`). The original pages keep their internal names: `render("Hubs")`,
`DFOps.page()`, the hidden `#breadcrumbPage` (the visible label is `#breadcrumbLabel`) and the hidden
`#legacyNav` buttons that the page scripts mark active. Old names (in `render()` calls and
`/courier-operation?page=<old or new name>&tab=<tab>`) open the view that now holds the page; the map is in
docs/architecture-contracts.md ("Courier Operations navigation"). Browser tests navigate with `opsNav(page,
area)` from `tests/e2e/support.ts` (`OPS_NAV`).

`courier-operation/bridge-failed.js` (between the drawer and navigation pair): failed deliveries — the
"Failed ×N" badge on parcel rows and in the drawer (with the attempts), "Re-attempt (Assign rider)" and the
"Return to sender" dialog; see docs/architecture-contracts.md ("Failed deliveries").

As a feature is rebuilt in React, delete its code here and from `scripts.ts`.
