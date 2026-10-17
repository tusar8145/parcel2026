# Legacy page scripts

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
   page reads. API-backed storage keys (`deliveryfast-customer-parcels`, `-customer-session`,
   `-customer-address-book`) are served from memory, so the page scripts keep their synchronous
   reads and nothing personal stays in the browser.
2. The page's original scripts.
3. `<page>/bridge.js` (every page; merchant panels share `shared/merchant-bridge.js`) — capture-phase listeners on `window`
   that run before the original handlers. They perform the action through the API, then refresh
   the data, and the page re-renders through its own `storage` event listener.

Shared UI modules loaded before the bridges that use them: `shared/print.js` (`window.DFPrint`: every print button opens an API-generated PDF in a new tab, see docs/architecture-contracts.md "Printed documents"), `shared/importer.js` (`window.DFImport`:
the Excel/CSV import dialog, history and "Needs info" completion form for the merchant panels and
Courier Operations, drawn with each panel's own modal/table/status classes. Three bulk-create templates:
Customer parcel (operations only), E-commerce and Banking & Financial (API kind `document`). Operations
choose the category and then the merchant (searchable select, `#dfiMerchantSearch` / `#dfiMerchant`) or
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
"Name · Type", place selects with "Choose …" placeholders and a search box for long lists, inline checks
and the price breakdown; used by Courier Operations New shipment in `courier-operation/bridge-pages.js`,
merchant or walk-in sender, and by both merchant order forms in `shared/merchant-bridge.js`; see
docs/architecture-contracts.md "Single-order forms") and
`shared/scanner.js` (barcode scanning).

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
