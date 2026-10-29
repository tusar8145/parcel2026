// Load order: the API client (restores the session and checks the role), the original page
// scripts, then the bridge that runs them on API data. See public/legacy/README.md.
export const scripts = [
  "/legacy/shared/api.js",
  // Searchable long selects (DF.searchSelect) and "Choose file" controls (DF.fileInput), applied automatically.
  "/legacy/shared/select-search.js",
  "/legacy/shared/file-input.js",
  // Dashboard period filter (DF.period): Today / This week / This month / custom range, remembered per page.
  "/legacy/shared/period.js",
  "/legacy/super-admin/01.js",
  "/legacy/super-admin/02.js",
  "/legacy/super-admin/03.js",
  // In-app notifications: the bell (unread count, latest) and the Notifications page (before the bridges: the bell is its own).
  "/legacy/shared/notifications.js",
  // Structured merchant addresses (DFMerchantAddress): Settings editor and the staff summary.
  "/legacy/shared/merchant-address.js",
  "/legacy/super-admin/bridge.js",
  "/legacy/super-admin/bridge-merchants.js",
  "/legacy/super-admin/bridge-notifications.js",
  // SMS, Email & Push › Push notifications: Firebase settings, messages to all / chosen users, history.
  "/legacy/super-admin/bridge-push.js",
  "/legacy/super-admin/bridge-imports.js",
  "/legacy/super-admin/bridge-geo.js",
  "/legacy/super-admin/bridge-packages.js",
  // Franchises: partner-run hubs, their commission and the settlement settings (super-admin/bridge-franchise.js).
  "/legacy/super-admin/bridge-franchise.js",
  // Hubs & zones: hub register, serving hub of each delivery zone, routes (moved from Courier Operations).
  "/legacy/super-admin/bridge-hubs-admin.js",
  // Rider plans › "Rider location": the location interval (2 / 5 / 10 min) and movement threshold.
  "/legacy/super-admin/bridge-location.js",
  "/legacy/shared/mfa.js",
  "/legacy/super-admin/bridge-security.js",
  // Admin users & roles: its sections in tabs (shows / hides what bridge-security.js draws).
  "/legacy/super-admin/bridge-admin-tabs.js",
  // Platform activity in tabs: Live now, Website traffic, Parcel tracking (website lookups), Merchants & riders, User activity.
  "/legacy/super-admin/bridge-activity.js",
  // Registrations: the review queue in tabs (To review · Rejected · Approved · All).
  "/legacy/super-admin/bridge-registration-tabs.js",
  // E-commerce / Banking & Financial merchants, Franchises: the lists in tabs by account status, with counts.
  "/legacy/super-admin/bridge-status-tabs.js",
  // System guide: numbers, parcel statuses, money flow, roles (GET /guide).
  "/legacy/shared/system-guide.js",
  "/legacy/super-admin/bridge-guide.js",
  // Branding & company: name, logo, tab icon, contact details, About page (GET/PUT /branding).
  "/legacy/super-admin/bridge-branding.js",
  // Super admin › Invoice settings: delivery charge on invoices, VAT, the company on bills (GET / PUT /finance/config).
  "/legacy/super-admin/bridge-invoice.js",
  // Period filter on Overview and Platform activity.
  "/legacy/super-admin/bridge-period.js",
  // Last: every page (and tab) has its own address: ?page=<slug>[&tab=<slug>], Back / Forward, titles (DF.nav).
  "/legacy/shared/panel-nav.js"
];
