# Super admin panel (React) — porting status

Rebuild of the classic super admin panel (`/super-admin`, legacy scripts in `apps/web/public/legacy/super-admin/*`
and `apps/web/public/legacy/shared/*`) in React at `/admin/`. Same API, same rules and wording; nothing removed.
Shared UI and helpers: `packages/panel-ui` (also used by `apps/ops` and `apps/merchant`).

Every page is rebuilt (2026-11-08). The classic panel stays at `/super-admin` (linked from the menu as "Classic
panel"; it links back with "Open the new super admin panel"). `/super-admin` is not redirected here yet.

| Page | Classic source | Status |
| --- | --- | --- |
| Sign-in (super admins only), menu with groups and sub-menus, counts, top bar, merchant search, bell, sign-out confirm | 01.js, bridge-menu.js, Sidebar.tsx | done |
| Platform overview (period, GMV, bookings chart, approvals, merchants, privileged activity) | 01.js, bridge.js, bridge-period.js | done |
| Registrations / Approval center (tabs, review, approve with package, reject, request info, KYC, invitations, export) | 01.js, bridge.js, bridge-merchants.js, bridge-registration-tabs.js | done |
| E-commerce / Banking & Financial merchants (tabs, hub column and filter, manage, invite, export) | 02.js, bridge.js, bridge-merchants.js, bridge-status-tabs.js | done |
| Franchises (settlement, applications, add, rates, suspend) | bridge-franchise.js | done |
| Service plans & pricing (packages, editor with price preview, merchants, simulator, messages, Hub Pickup) | bridge-packages.js | done |
| Rider earning plans (plans, assignments, rider location) | 03.js, bridge-rider-plans.js, bridge-location.js | done |
| Platform activity (live now, traffic, parcel tracking, merchants & riders, user activity) | 01.js, bridge-activity.js, bridge-period.js, bridge-security.js | done |
| Audit & security log (server paging and search, metrics, export) | bridge-audit.js, bridge-security.js | done |
| Admin users & roles (administrators, approvals, roles & permissions, custom roles, support access, 2FA) | 01.js, bridge.js, bridge-security.js, bridge-admin-tabs.js, shared/mfa.js | done |
| Parcel notifications / Global notifications (switches, template editor, preview) | bridge-notifications.js | done |
| Channel & limits, Recent messages | bridge-notifications.js | done |
| Push notifications (send, history) and Integration settings (SMS, email, Firebase) | bridge-notifications.js, bridge-push.js | done |
| Website & branding (company, logo, signups, About / Privacy / Terms, FAQs) | bridge-website.js, bridge-branding.js | done |
| Return reasons, Receiver relations | 02.js, bridge-menu.js | done |
| Products | bridge-packages.js | done |
| Invoice settings | bridge-invoice.js | done |
| Import Template settings | bridge-imports.js | done |
| Address (districts, zones, areas) | bridge-geo.js | done |
| Hubs & zones (hubs, central hub, delivery zones, routes) | bridge-hubs-admin.js | done |
| System guide | bridge-guide.js, shared/system-guide.js | done |
| Notifications page | shared/notifications.js | done |

Old links (`/super-admin?page=…&tab=…`, notification links) translate to `/admin/<page>`.
Development: `npm run dev:admin` (port 5176; `/api` → API_ORIGIN, `/site-cache` → WEB_ORIGIN).
