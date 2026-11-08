# Merchant panel (React) — porting status

Rebuild of the classic Banking & Financial merchant panel (`/banking-merchant`, legacy scripts in
`apps/web/public/legacy/banking-merchant/*` and `apps/web/public/legacy/shared/merchant-*.js`) in React at `/merchant/`.
Same API, same rules and wording; nothing removed. The e-commerce merchant panel can move here later
(`PANEL` in `src/lib/merchant.tsx`). Shared UI and helpers: `packages/panel-ui` (also used by `apps/ops`).

Every page is rebuilt (2026-11-08). The classic panel stays at /banking-merchant (linked from the menu as "Classic panel").

| Area | Classic source | Status |
| --- | --- | --- |
| Sign-in, roles, workspace (MERCHANT_REQUIRED, switch), other type → its panel | merchant-bridge.js resolveMerchant / boot | done |
| Menu (names, groups, counts), top bar, sign-out confirm, Get the apps, classic link | Sidebar.tsx, Topbar.tsx, merchant-bridge.js updateNavCounts, support.js | done |
| Top search (ID / CN / ref / phone / name), page shortcut | merchant-parcel.js search | done |
| Notifications bell | notifications.js | done |
| New requests / All requests: paging, filters, export, print, tick rows | merchant-orders.js | done |
| Row actions: Complete (Needs info), Cancel, Confirm return received | merchant-bridge.js, importer.js complete, merchant-features.js | done |
| Parcel drawer (details, tracking, map, proof, return request, label) | merchant-parcel.js, merchant-bridge.js showParcel, parcel-map.js | done |
| New delivery request (form, paste message, services, quote, pickup slot) | merchant-bridge.js booking, order-services.js, paste-message.js | done |
| Import batch, import history | importer.js | done |
| Returns (RTO) | merchant-features.js | done |
| Account verification (KYC, review messages) | merchant-verification.js | done |
| Overview | 01.js, merchant-bridge.js patchDashboard, period.js | done |
| Pickup requests (recurring, one-off) | merchant-features.js | done |
| Recipients & branches | merchant-bridge.js | done |
| Product catalogue | merchant-features.js | done |
| Balance (bills, I've paid, payments, statement) | merchant-balance.js | done |
| Reports | merchant-features.js | done |
| API & Webhooks | merchant-bridge.js | done |
| Services & pricing | merchant-plan.js | done |
| Settings (profile, address, team, notifications, KYC) | merchant-bridge.js, merchant-address.js, merchant-features.js | done |
| Support tickets, Notifications page | support.js, notifications.js | done |

Dev: API on the local demo DB, then `npm run dev -w @delivery-fast/merchant` (port 5175). Demo owner:
merchant.doc.owner@pairaexpress.example (password in demo-accounts/deliveryfast_demo-credentials.txt).

Shared with apps/ops through packages/panel-ui: UI kit, dialogs, dropdowns, toasts, icons, Login, API client, sign-in,
live events, formatting, period picker, PDF printing (lib/print), the Excel importer (ui/Importer), the position map
(ui/PositionMap) and the support tickets page (pages/Support, `inbox={false}` here).

Checked in the browser on the local demo DB (Banking & Financial owner): every page, the parcel drawer, booking a
request end to end, import, returns, pickups, recurring pickups, I've paid, products, reports (view), API & Webhooks,
every Settings dialog, support (prefilled from a parcel), notifications, and the verification screen (status set to
INFO_REQUESTED on the local DB for the test, then restored).
