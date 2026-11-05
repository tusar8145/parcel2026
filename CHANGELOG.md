# Changelog

What's new in Paira Express, newest first. The top version is shown at the bottom of the super admin
sidebar, and "What's new" there lists these notes.

Every fix or feature adds a new version at the top: `## x.y.z — YYYY-MM-DD`, then one short line per
change (`- …`), written for the people who use the panels. Fixes raise the last number (1.0.0 → 1.0.1),
new features the middle one (1.0.1 → 1.1.0), big changes the first one (1.1.0 → 2.0.0).

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
