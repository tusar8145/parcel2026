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

Shared UI modules loaded before the bridges that use them: `shared/importer.js` (`window.DFImport`:
the Excel/CSV import dialog, history and "Needs info" completion form for the merchant panels and
Courier Operations, drawn with each panel's own modal/table/status classes) and
`shared/scanner.js` (barcode scanning).

As a feature is rebuilt in React, delete its code here and from `scripts.ts`.
