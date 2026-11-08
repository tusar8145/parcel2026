# Changelog

What's new in Delivery Fast, newest first. The top version is shown at the bottom of the super admin
sidebar, and "What's new" there lists these notes.

Every fix or feature adds a new version at the top: `## x.y.z — YYYY-MM-DD`, then one short line per
change (`- …`), written for the people who use the panels. Fixes raise the last number (1.0.0 → 1.0.1),
new features the middle one (1.0.1 → 1.1.0), big changes the first one (1.1.0 → 2.0.0).

## 1.23.3 — 2026-11-09
- The first page of each new panel opens faster: its figures start loading as soon as you are signed in, the page shows without waiting for extra code, and the count-up takes 0.6 seconds instead of 0.9.

## 1.23.2 — 2026-11-09
- First-page figures show 0 while they load instead of "—", so counting starts the moment the page opens.

## 1.23.1 — 2026-11-09
- Signing out of the new panels (super admin, Operations console, merchant panel) goes straight to the website's sign-in page; the panel's own sign-in form no longer shows on the way.

## 1.23.0 — 2026-11-09
- The figures on the first page of the super admin panel (Platform overview), the Operations console (Today) and the merchant panel (Overview) now count up from 0 to their value when the page opens, and roll to the new value when it changes.

## 1.22.1 — 2026-11-09
- The menu links between the panels are now "Open admin console ↗" (in the Operations console) and "Open operations console ↗" (in the super admin panel).

## 1.22.0 — 2026-11-09
- Super admins now use the new super admin panel: signing in, notifications and every link to the old panel open the same page there. The classic panel is no longer in its menu.
- New super admin panel: the large icons in the notes at the top of Registrations, Admin users & roles and Import Template settings are the normal size again; "Open courier operations console ↗" in the menu is smaller.

## 1.21.0 — 2026-11-08
- New super admin panel (preview) at /admin: every page of the classic panel rebuilt on the same data and rules — Platform overview, Registrations and approvals (review, approve, reject, ask for information, KYC, invitations), E-commerce and Banking & Financial merchants, Franchises, Service plans & pricing (packages, price preview, merchants, simulator, messages, Hub Pickup), Rider earning plans, Platform activity, Audit & security log, Admin users & roles (approvals, permissions, custom roles, support access, two-step verification), every notification setting, Push notifications, Website & branding, Return reasons, Receiver relations, Products, Invoice settings, Import Template settings, Address, Hubs & zones, Integration settings and the System guide. The classic panel stays where it is; "Open the new super admin panel" in its menu opens the new one.

## 1.20.0 — 2026-11-08
- E-commerce merchants now use the new merchant panel too, with every page of their classic panel: New / All orders (COD amount, product and payment filters, POS invoices), Create order (cash on delivery, weight, open box, paste a message), Excel import, Customers, Products, Balance (COD ready to pay, with riders, settlements and paid history), the payout account in Settings, and the rest. Signing in and every link to the old panel open the new one; the classic panel stays one click away ("Classic panel" in the menu).

## 1.19.1 — 2026-11-08
- New merchant panel: "Import batch" is now "Import Excel", with "Import history" beside it, on Overview, New requests and All requests.

## 1.19.0 — 2026-11-08
- Banking & Financial merchants now open the new merchant panel: signing in, notifications and every link to the old panel go to the same page there. The classic panel stays one click away ("Classic panel" in the menu) and keeps opening on reload; "Open the new merchant panel" in its menu goes back.

## 1.18.0 — 2026-11-08
- New Banking & Financial merchant panel (preview) at /merchant: every page of the classic panel rebuilt on the same data and rules — Overview, New / All requests (filters, Excel export, printing), the request details panel, New delivery request (paste a message, services, pickup time, live price), Excel import, Returns, Pickup requests and recurring pickups, Recipients & branches, Product catalogue, Balance (bills, payments, "I've paid", statement), Reports, API & Webhooks, Services & pricing, Settings (corporate account and address, team, verification, notifications), Support and Notifications, and the account verification screen. The classic panel stays available from the menu.

## 1.17.1 — 2026-11-08
- New Operations console: Parcel queue (its tasks, groups, lists, Excel and menu count) follows the period chosen in the top bar too; scanning a parcel still works whatever its age.
- New Operations console: the period choice is now first in the top bar, before Share files.

## 1.17.0 — 2026-11-08
- New Operations console: a period in the top bar (Last 30 days, 60 days, 90 days, 6 months, 1 year, All time) sets which parcels every list and menu count shows, by booking date. It opens on Last 30 days and remembers your choice; searching by ID still finds older parcels.
- New Operations console: "Open super admin console ↗" and "Get the apps" now sit at the end of the menu and scroll with it; clicking your name asks "Sign out?" first, as in the super admin panel.

## 1.16.3 — 2026-11-08
- Super admins: two-step verification can be paused for now (server setting SUPER_ADMIN_MFA=off). Super admins then sign in without a code; when it is turned back on, the same authenticator app works again.

## 1.16.2 — 2026-11-08
- New Operations console: signing out opens the website's sign-in page, as the classic console did.

## 1.16.1 — 2026-11-08
- New Operations console: "Get the apps" (Merchant, Rider and Operations apps) is back at the bottom of the menu, and super admins have "Super admin panel" there too, always in sight.

## 1.16.0 — 2026-11-08
- Operations staff now open the new Operations console: signing in, notifications and every link to the Operations console go to the same page there.
- The classic console stays one click away ("Classic console" in the menu) and keeps opening on reload; "Open the new Operations console" in its menu goes back.

## 1.15.1 — 2026-11-08
- New Operations console: buttons no longer keep spinning while the window they opened is up.
- New Operations console: the menu keeps its place when you open a page, Support tickets and Notifications included.
- New Operations console: long dropdowns (hubs, riders, merchants, zones…) have a search box, also inside pop-up windows, where they now open properly.
- New Operations console: printing opens the same "Preparing…" page and PDF viewer with a Download button as the classic console, and every dropdown has the new look.
- New Operations console: bigger close (×) buttons on every pop-up window, a styled "Choose file" button, and form fields that keep their normal height.

## 1.15.0 — 2026-11-08
- New Operations console at /ops: every page is rebuilt, including Scan desk, Parcel queue, Transfers, Returns, Scheduled pickups, Hub desk › End of day, Accounts, Reports, Riders, Merchants, CN stock, Settings, Support tickets and Notifications.
- New Operations console: New order and walk-in booking, Excel import and bulk updates, Scan with phone, Suggest riders, Share files, Phone scanner, Log in as, two-step verification and the system guide work there too. The classic console stays available from the menu.

## 1.14.0 — 2026-11-08
- New Operations console (preview) at /ops: Today, New orders, All parcels, Problems, Pickup, Delivery (map and route planner), Hub desk › At my hub, Transfers › On the road and the parcel details panel, on the same data and rules. Tabs not rebuilt yet open in the classic console.

## 1.13.1 — 2026-11-07
- Merchant, Rider and Operations apps: new versions (1.4.1, 1.3.1, 1.1.1) that connect to deliveryfast.com.bd. Install the new APK over the old app, then sign in with your Delivery Fast account.

## 1.13.0 — 2026-11-07
- Super admin › Hubs: each hub can have an in-charge name and phone, both optional, shown in the hub list.

## 1.12.0 — 2026-11-07
- Delivery Fast: a new name and logo everywhere, on the website, panels, documents, emails and the browser tab icon.

## 1.11.4 — 2026-11-07
- Installation: the API can be set to accept connections only from the same server.

## 1.11.3 — 2026-11-06
- Website: Terms, Privacy and About open at once, and the other pages open sooner.
- Website: visitors no longer download the panels on every page. Only the sign-in page does that, after it has opened, so panels still open quickly after signing in.

## 1.11.2 — 2026-11-06
- E-commerce and Banking & Financial merchant panels: text typed into an order, such as a customer name, is always shown as plain text and can never run as code.

## 1.11.1 — 2026-11-06
- All panels: more empty space around the page content, on the left and right most of all.
- All panels: the buttons beside a page title, such as on New orders and All parcels, sit at the top right again.
- Merchant panels on smaller screens: long tables scroll sideways instead of being cut off.
- Support on smaller screens: the ticket list sits above the conversation, so the page no longer runs off the side.

## 1.11.0 — 2026-11-06
- The new look is now everywhere: Courier Operations, Super admin, Rider, Franchise, application pages and the phone scanner pages, with the same fonts, colours, icons, menu, cards, tables and forms as the merchant panels. Everything works as before.
- Courier Operations on smaller screens: Share files and Phone scanner in the top bar show as icons, so the bar fits the screen.

## 1.10.0 — 2026-11-06
- E-commerce and Banking & Financial merchant panels: a new look, with new fonts, colours, icons, menu, cards, tables and forms. Everything works as before.

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
- New name: Delivery Fast everywhere (screens, PDFs, documents, apps). Merchant webhooks now send X-DeliveryFast-* headers.
- Invoice settings moved to the Super admin panel, with a choice to show or hide the delivery charge on invoices.
- Notifications: push can be turned on or off for each parcel and account notification. Codes (sign-up, login) are never sent by push.
- Share files: a QR code and link let another device drop files into Courier Operations. They're deleted when the dialog closes.
- One page to download all three Android apps (/apps), linked from Courier Operations.
- "Install app" only in Courier Operations, on computers.
- Work queue refreshes on its own when parcels change on other pages.
- Apps: tapping a notification opens the parcel. Riders can deliver directly only parcels their own hub delivers. The Ops app's delivery entry form works again.
- System guide: removed the PP tracking ID entry.
