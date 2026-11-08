# Operations console in React (`apps/ops`, served at `/ops/`)

The Courier Operations panel (`apps/web/public/legacy/courier-operation/*` + `shared/*`) rebuilt in React on the
same API. Business rules, endpoints, permissions and wording stay the same; layout and usability may improve.
Every view and tab is rebuilt; the classic console (`/courier-operation`) stays available from the menu (Help ›
Classic console) and is the fallback for a view the router doesn't know.

## Run

- API on the local database: `DATABASE_URL=postgresql://pairaexpress:pairaexpress@localhost:5432/pairaexpress_demo node apps/api/dist/main.js`
- Panel: `npm run dev -w @delivery-fast/ops` → http://localhost:5174/ops/ (proxies `/api` to `API_ORIGIN`, default :4000)
- Build: `npm run build -w @delivery-fast/ops` → `apps/web/public/ops` (Next.js serves it; `/ops/*` falls back to its `index.html`)

## Structure

- `src/lib` – API client (`api.ts`, same token / refresh / retry rules as `shared/api.js`), sign-in (`auth.tsx`),
  live events (`events.ts`: `GET /events`, `useLive`), who-am-I and lookups (`ops.tsx`: `/ops/overview` `me`, hubs,
  riders, stage counts, My hub / All hubs), period filter (`period.tsx`), formatting.
- `src/ui` – design system: `kit.tsx` (Button with busy state, Pill, Metric, Panel, MoreMenu, Tabs), `dialogs.tsx`
  (`confirm`, `prompt`, `openForm` = `Ops.form`, `openCustom`), `SearchSelect.tsx`, `toast.tsx`, `Icon.tsx`.
- `src/app` – menu and routes (`nav.ts` = `bridge-nav.js` VIEWS / allowedViews / OLD names), shell, login, tabs.
- `src/features/parcels` – parcel model and next action (`model.ts`), actions (`actions.tsx`), server-paged list
  (`useParcelList.ts` + `ParcelTable.tsx` = `bridge-lists.js`), drawer (`ParcelDrawer.tsx` = `bridge-parcel.js`).
- `src/features/maps` – live network map and route planner (`bridge-maps.js`).
- `src/pages` – one file per view.

## Status (legacy source → React)

| View › tab | Legacy source | Status |
|---|---|---|
| Sign-in (password, SMS code, two-step, set-up) | website login, `shared/api.js` auth | done |
| Menu by role, counts (stages, Parcel queue, Accounts, Merchants address changes, open support tickets) | `bridge-nav.js`, `bridge-workqueue.js`, `bridge-accounts.js`, `bridge-merchant-hubs.js`, `shared/support.js` | done |
| Top bar: find parcel, zone → hub, live chip, bell + operations alerts, Share files, Phone scanner | `bridge-parcel.js`, `bridge-desk.js`, `shared/notifications.js`, `bridge-share.js`, `bridge-phone-scanner.js` | done |
| Sidebar: super admin panel link (super admins), classic console | `bridge-admin-link.js` | done |
| Keyboard: `/` search, F2 scan box, Esc closes drawer | `bridge-desk.js` | done |
| Parcel drawer: actions, attempts, partial, position map, details, price, proof, notes, messages, history | `bridge-parcel.js`, `bridge-failed.js`, `bridge-partial.js`, `shared/parcel-map.js` | done |
| Parcel actions: assign, bulk accept, resolve exception, edit, complete Needs info, cancel, pickup ↔ drop-off, return to sender, product type, return charge, labels / invoices / list PDFs | `bridge.js`, `bridge-lists.js`, `bridge-intake.js`, `bridge-failed.js`, `bridge-partial.js`, `shared/importer.js` complete, `shared/print.js` | done |
| Today | `bridge-pages.js`, `bridge-period.js`, `bridge-maps.js`, `bridge-nav.js` | done |
| New orders (list, bulk accept, New order, Import Excel, Scan with phone, Bulk update, print, export) | `bridge-nav.js`, `bridge-lists.js`, `bridge-pages.js` booking, `bridge-imports.js`, `bridge-scan.js`, `bridge-bulk.js` | done |
| All parcels (4 tabs, register, New order per line, Import, Bulk update, export) | same | done |
| Problems (4 tabs, SLA alerts, Bulk update) | `bridge-nav.js`, `bridge-failed.js`, `bridge-sla.js` | done |
| Pickup › Assign pickup rider (Suggest riders, Bulk update) | `bridge-pages.js` Dispatch, `bridge-network.js`, `bridge-nav.js` | done |
| Pickup › Scheduled pickups | `bridge-returns.js` (pickup-requests) | done |
| Delivery (metrics, map, route planner, tables, roster, Suggest riders) | `bridge-pages.js`, `bridge-maps.js`, `bridge-network.js` | done |
| Hub desk › At my hub, End of day | `bridge-nav.js`, `bridge-desk.js` | done |
| Scan desk (9 tabs) | `bridge-hub-desk.js`, `bridge-intake.js`, `bridge-collect.js`, `shared/scanner.js` | done |
| Parcel queue | `bridge-workqueue.js` | done |
| Transfers (Send / Receive / On the road / Issues / Vehicles) | `bridge-linehaul.js`, `bridge-vehicles.js`, `shared/vehicle-share.js` | done |
| Returns (runs, return-scheduled list) | `bridge-returns.js` | done |
| Accounts (8 tabs + badges) | `bridge-accounts.js`, `bridge-accounts-badges.js`, `bridge-rider-pay.js`, `bridge-franchise.js` | done |
| Reports (4 tabs) | `bridge-reports.js`, `bridge-period.js`, `bridge-sla.js`, `bridge-rider-report.js`, `bridge-hub-transfer-report.js` | done |
| Riders (Riders, Shifts & attendance, Verification; Add rider, run sheets, Log in as) | `bridge-pages.js`, `bridge-network.js`, `bridge-shifts.js`, `bridge-rider-kyc.js`, `bridge-login-as.js` | done |
| Merchants (type tabs, hub filter, address changes to approve, Change address, Log in as, export) | `bridge-pages.js`, `bridge-merchant-hubs.js`, `bridge-merchant-tabs.js`, `bridge-login-as.js` | done |
| CN stock | `bridge-cn.js` | done |
| Settings (where to change things, two-step verification, system guide) | `bridge-pages.js`, `shared/mfa.js`, `bridge-guide.js` + `shared/system-guide.js` (loaded as is) | done |
| New order / walk-in booking | `bridge-pages.js` openBooking, `shared/order-services.js`, `DF.autoPlace` | done (`features/booking/Booking.tsx`) |
| Excel import, bulk updates | `shared/importer.js`, `bridge-imports.js`, `bridge-bulk.js` | done |
| Support tickets, Notifications page | `shared/support.js`, `shared/notifications.js` | done |

Not part of this panel (other panels' code in the same files): merchant / customer / rider parts of `shared/support.js`,
`shared/paste-message.js` (merchant panels), `shared/merchant-address.js` (merchant and super admin forms), and the
hubs / zones / routes set-up in `bridge-hubs.js` / `bridge-network.js` (Super admin › Hubs & zones since the menu change).
