# Changelog

What's new in Paira Express, newest first. The top version is shown at the bottom of the super admin
sidebar, and "What's new" there lists these notes.

Every fix or feature adds a new version at the top: `## x.y.z — YYYY-MM-DD`, then one short line per
change (`- …`), written for the people who use the panels. Fixes raise the last number (1.0.0 → 1.0.1),
new features the middle one (1.0.1 → 1.1.0), big changes the first one (1.1.0 → 2.0.0).

## 1.9.0 — 2026-11-06
- All panels: menu items are now links, so right click › Open in new tab, Ctrl+click and middle click open them in a new tab.

## 1.8.1 — 2026-11-06
- Super admin menu: Integration settings now comes just before System guide.

## 1.8.0 — 2026-11-06
- Operational settings › Products: click the Product column to sort by name, A to Z or Z to A. Export follows the same order.

## 1.7.1 — 2026-11-06
- Operational settings › Products: the Cancel button in the add and edit product dialog works, and Escape closes it.

## 1.7.0 — 2026-11-06
- Super admin: Website settings and Branding & company are now one page, Website & branding, in tabs: Company & branding, Signups & booking, About Us, Privacy Policy, Terms of Service and FAQs.
- Super admin: the Firebase push connection moved to Integration settings. Push notifications keeps sending messages and their history.
- Super admin › Audit & security log: numbered pages of 20 rows, over the whole log rather than the latest 100, and the search covers every entry.

## 1.6.0 — 2026-11-06
- Operational settings › Products: search, status filter, numbered pages, Excel export and editing a product's name and type. Messages are no longer set here; Service plans does that, package by package.
- Super admin › Rider earning plans: a new layout. Choose a delivery type, see each plan on a card, and work in tabs: Earning plans, Rider assignments (with search) and Rider location.
- Super admin › Address, Return reasons and Receiver relations now use the full width of the page.
- Super admin menu: Monitoring now comes above Platform control.

## 1.5.0 — 2026-11-06
- Super admin › Service plans & pricing: a new layout. Choose Customer, E-commerce or Banking & Financial, see the plan at a glance, and work in tabs: Packages, Merchants, Price simulator, Messages and Hub Pickup.
- Editing a package now has its own page, with Details, Services and Prices, a live price preview beside the form, and Save always in reach. Merchants can be searched.

## 1.4.1 — 2026-11-06
- Super admin: products moved to Operational settings › Products, by merchant type, where you add, deactivate and delete them. Service plans keeps only "Products with messages".

## 1.4.0 — 2026-11-05
- Super admin: new Website settings. Turn each sign-up (merchant, rider, franchise, customer) and "Send a parcel" on or off, and edit About Us, Privacy Policy, Terms of Service and FAQs.
- Website: the home page and content pages open from a cache, and what you save in Super admin shows at once. The login page and every panel load faster.
- New SMS: the recipient gets a message with the tracking link when the parcel reaches its first hub, with its own on/off switch and template in Parcel notifications.
- Super admin menu: new Notification settings, Integration settings, Operational settings, Location settings and Monitoring. "SMS, Email & Push" and "Shared catalogs & locations" are now split across these; nothing was removed. Excel Import settings is now Import Template settings.
- Service plans › Products: choose all the products that send messages in one field, with search and select all.
- Long tables in the Merchant, Courier Operations and Super admin panels now have numbered pages.

## 1.3.1 — 2026-11-05
- Courier Operations: every button that takes time now shows a loading spinner until the work is done, and can't be clicked twice meanwhile.
- Collect from hub: a live parcel update no longer clears the collection code or the ID photo while you are handing a parcel over.

## 1.3.0 — 2026-11-05
- Merchant panels: new menus "New orders" and "All orders" (Banking & Financial: "New requests" and "All requests") replace Orders and Shipments / Delivery requests and Delivery tracking.
- Merchant lists: numbered pages and filters for your merchant type (status, dates, product, payment, document, branch, district) that cover all your orders.
- Merchant lists: Export gives an Excel file of what you filtered, with the columns for your merchant type and status and no internal data. Print covers what you filtered, and shows only the formats for your merchant type.
- Merchant panels › Reports: a new page with a period, headline numbers and the reports for your merchant type, on screen or in Excel. New reports: Failed deliveries, Payouts and Branch summary.
- Reports no longer show internal details, and charges and money reports are for merchant owners only.
- Buttons for bulk work (import, bulk update, assign, export, print) show a loading spinner while they work.
- Version and "What's new" now show only in the Super admin panel.
- Merchant panel › API & Webhooks: the OpenAPI reference link is removed.

## 1.2.0 — 2026-11-05
- Courier Operations › New orders › Bulk update: new "Receive at hub" action for drop-offs brought to a hub.
- All parcels: the list now has numbered pages with rows per page, and shows the last month unless you choose other dates.
- All parcels: new "Date field" filter, to filter by Pickup / created date or Status update date. The status filter now lists every status.
- All parcels: Export now gives an Excel file with every parcel you filtered, not only one page. It always has the first status date, reference no and recipient phone.
- All parcels › Export: filtering by Delivered adds delivery date, received by and relation; filtering by Returned adds return date and reason; choosing an E-commerce merchant or the E-commerce tab adds COD.

## 1.1.1 — 2026-10-30
- Courier Operations › Today: the stage cards show only their names (New orders, Pickup…), without the 1, 2, 3… numbers.

## 1.1.0 — 2026-10-30
- System guide: "Parcel lifecycle" replaces "Parcel statuses". It shows the First, Middle and Last mile in Bangla, who does each step (Rider App or Operations) and where.
- System guide: new "Notifications" tab in Bangla. It shows which SMS, email and push each panel and app gets at each step of the parcel.

## 1.0.0 — 2026-10-30
- Version number and "What's new" at the bottom of every panel.
- New name: Paira Express everywhere (screens, PDFs, documents, apps). Merchant webhooks now send X-PairaExpress-* headers.
- Invoice settings moved to the Super admin panel, with a choice to show or hide the delivery charge on invoices.
- Notifications: push can be turned on or off for each parcel and account notification. Codes (sign-up, login) are never sent by push.
- Share files: a QR code and link let another device drop files into Courier Operations. They're deleted when the dialog closes.
- One page to download all three Android apps (/apps), linked from Courier Operations.
- "Install app" only in Courier Operations, on computers.
- Work queue refreshes on its own when parcels change on other pages.
- Apps: tapping a notification opens the parcel. Riders can deliver directly only parcels their own hub delivers. The Ops app's delivery entry form works again.
- System guide: removed the PP tracking ID entry.
