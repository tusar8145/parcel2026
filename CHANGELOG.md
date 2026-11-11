# Changelog

What's new in Delivery Fast, newest first. The top version is shown at the bottom of the super admin
sidebar, and "What's new" there lists these notes.

Every fix or feature adds a new version at the top: `## x.y.z — YYYY-MM-DD`, then one short line per
change (`- …`), written for the people who use the panels. Fixes raise the last number (1.0.0 → 1.0.1),
new features the middle one (1.0.1 → 1.1.0), big changes the first one (1.1.0 → 2.0.0).

## 1.42.0 — 2026-11-12
- Rider app 1.6.0 › Deliveries: "Best route" puts the open deliveries in the best order from where the rider is (stop numbers on each parcel), and "Google Maps" navigates through the next stops. The list follows today's plan, also when the plan was made in Courier Operations › Route planner.
- Super admin › Operational settings › AI address reading: when an address can't be found on the map as written, AI rewrites it (area, road, landmark) and searches again, so route plans place the parcel at its address instead of the zone centre. On / off, a monthly USD limit and a daily limit, this month's and today's use, the last 30 days and recent addresses. Off or at a limit, everything works as before.
- Rider app has its own icon (a motorbike), so it is easy to tell apart from the Operations and Merchant apps.

## 1.41.0 — 2026-11-12
- Forced app updates: super admin › Mobile apps sets the lowest version of the Operations, Rider and Merchant apps that may still be used. An older app stops working and shows an "Update the app" page with the download link.
- New apps: Operations 1.4.0 (Riders: add a rider with a password, copy the sign-in details, set a new password), Rider 1.5.1 and Merchant 1.4.2. From these versions on, an update can be forced; apps installed before keep working.

## 1.40.0 — 2026-11-12
- Hubs & zones and Admin users & roles: each group (Inside Dhaka…, or a role) has its own light-coloured heading row.
- Admin users & roles › Manage: "Edit details" (name, mobile, email) and "Set new password" for another administrator (they are signed out everywhere).
- Hub Managers see only their own hub: Courier Operations lists, counts and riders show that hub (no "All hubs"), and the hub's name is shown next to their role.
- Operations app: a Hub Manager's hub list holds only their own hub.
- Operations app › More › Riders (operations managers and Hub Managers; franchise hubs in their Riders tab): add a rider with a password (no invitation is sent), then copy the mobile, email, password and the rider app's download link; set a rider's new password.
- Franchise panel: adding a rider with a password no longer sends an invitation.

## 1.39.1 — 2026-11-12
- Fix: the app download page shows the versions you actually download (Rider 1.5.0, Operations 1.3.0), with matching file names.

## 1.39.0 — 2026-11-12
- Admin users & roles › Invite administrator: choose "Send an invitation" (the exact SMS is shown first) or "Set a password now" (the account is ready at once, no invitation is sent). A Hub Manager's hub is picked from a grouped list.
- Admin users & roles: the administrator directory is grouped by role, with a role filter.
- Hubs & zones: hubs are grouped as Inside Dhaka, Dhaka sub-urban, Outside Dhaka and Franchise hubs, with a new column showing each hub's Hub Manager (or the franchise and its account): name, mobile and email.
- Super admin menu: "Location settings" is now "Hub settings", and Franchises moved there, after Hubs & zones.
- Franchises › Account: change a franchise's sign-in name, mobile and email, and set a new password.
- Franchise panel › Add a rider: set the rider's password; the rider signs in to the rider app with the mobile number and that password.
- Super admin › Riders › Add rider: hubs are grouped (Inside Dhaka, Dhaka sub-urban, Outside Dhaka) with a search box; franchise hubs are not listed.
- Courier Operations: "Add rider" is removed; riders are added in super admin › Riders.

## 1.38.0 — 2026-11-12
- Invite a merchant › "Onboard directly": the merchant and the owner's sign-in account are made at once, active, with no invitation link or application (business address, an optional password to share yourself, and the "approved, sign in" SMS off by default with its text shown first). KYC still unlocks COD payouts and API keys.
- Fix: signing in with an account that has no panel (e.g. made by a merchant invitation with a password) no longer reloads /account again and again: it opens the home page with a note. Such invited accounts are now customer accounts, like a website sign-up.

## 1.37.0 — 2026-11-12
- Super admin › Rider setup › Riders: the company's riders (franchise riders are under Franchises › Riders). Add a rider, and edit name, mobile, email, hubs, vehicle, zone, stops a day, active, and set a new password.
- A rider can work for several hubs: parcels of any of them can be assigned to them, and the rider app works at the hub nearest to the phone (when it opens, and from its location while on shift). Cash is handed over at that hub.
- Adding a rider, a franchise or inviting a merchant: the sign-in SMS is off by default and the form shows its exact text; tick "Send the sign-in message now" to send it. A password can be typed or generated to share yourself (a merchant invitation with a password makes their sign-in account now; they sign in and complete the application).
- Franchises: a "Riders" button lists each franchise's riders.
- Hubs & zones: "Find hub locations" gives hubs without a map location one from their address (else their zone), with the result to check.
- Courier Operations app 1.3.0: with several hubs, the hub nearest to the phone is chosen when the app opens. Rider app 1.5.0: works at the nearest of the rider's hubs.

## 1.36.0 — 2026-11-12
- Scan with phone: with AI import on, a photo whose label doesn't name the product gets one from what the photo shows; the import then matches it to a listed product or creates it.
- Courier Operations › Import history: "Pin" on an import shows only that import's parcels in New orders, whatever their status, also after moving to other pages. An "Unpin" button with the import and batch number sits next to Import history. The pin is kept on this device only and ends by itself after 6 hours.
- Service plans & pricing: each package has a "Charges" switch. On: the price form shows as before. Off: its parcels get no delivery charge, COD fee, re-attempt or return charge, and no charge is shown in booking forms, the import preview, parcel details, invoices and labels, or the merchant's plan page.
- Parcel details (operations and merchants): delivery type, priority and product (the merchant's own name; operations also see the system product in small text), the product's SMS / email / push, each message ticked at booking with whether its SMS / email went, how many are done and which SMS and emails were sent. Merchants never see the system product name.
- Excel exports (All parcels, New orders, merchants' orders): Delivery type, Priority and Product columns (operations also System product).

## 1.35.0 — 2026-11-12
- Excel import preview: the delivery address is a two-line box, so the whole address shows (and can be corrected).
- Excel import preview: each row's product, delivery type and priority can be changed from a dropdown; the row is checked and priced again. A row's own delivery type or priority stays when the messages change, until a delivery type or priority is applied to every row. Changing the product keeps the file's name on the parcel and its prints.
- Excel import preview: what AI import decided (product, district, zone) has a small "AI" tag.

## 1.34.0 — 2026-11-12
- Product categories are gone from everywhere (menu, products, booking forms, Excel templates, the import window and the AI). Each product now has its own SMS, email and push switches (Operational settings › Products: in Add / Edit, or click SMS / Email / Push in the list); every product took its old category's settings.
- Excel import, the product: the system matches the file's product name to its own (the same product under another spelling, size or colour, else the most similar one). Nothing close: the parcel is booked with the file's name. The parcel keeps both: the system's product and the name the file wrote; prints and screens show the file's name.
- AI import on: a name the system can't match goes to the AI, which picks the existing product or creates a new one; a new product's SMS / email / push come from the super admin's rule (AI import › Channel rule for new products).
- Import window: Delivery type, Priority and the messages to send are chosen on the second screen, with the file's rows (the first one preselected). Changing them checks and prices every row again ("Apply to every row"). The first screen's choices (merchant, first mile, last mile, product type) are shown there read-only.
- Prints (A4, 4 and 8 per page, labels, receipts): the delivery type and the priority are printed; long values (product, merchant, labels) go on to the next line instead of being cut.

## 1.33.0 — 2026-11-11
- Excel import: Delivery type and Priority are chosen in the import window for the whole file (the first one is selected when it opens; there is no "From the file" any more). The Excel templates no longer have Delivery type and Priority columns.
- AI import on: the import window has no Category choice and the template has no Category column. In the preview each row's Category shows before its Product: the product's category, or the one the AI chose (new products and categories are added to the system).
- No duplicate products: the same thing under another name (T-Shirt, T Shirts, tshirt XL black, Cheque Book / Cheque Books) is matched to the existing product, without the AI and without creating a new one.
- Fix: saving one AI import setting (for example the monthly limit) no longer switches the AI off or clears the channel rule.

## 1.32.0 — 2026-11-11
- Operational settings › AI import (new): Excel imports (merchant panel and Operations console) send the product names and addresses the lists don't match to AI (Claude Haiku). A name that is the same as a listed product (spelling, size, colour variants) gets that product; a new one becomes a new product in the right category, or a new category when none fits. An address in a thana that isn't listed becomes a new zone of its district, served at once by the nearest zone's hub. Everything it creates is tagged "AI created" (Products, Product categories).
- The super admin writes the channel rule for new categories (which get SMS, email, push); the AI sets each new category's switches from it.
- Each decision is remembered, so the same product name or misspelt zone never goes to the AI again; one file's names go together in a few parallel calls (about 3 seconds).
- On / off switch, a monthly limit in USD (the AI stops at the limit until the next month; imports never stop) and the log: each file's names sent, matched, created, tokens and estimated cost, by month.
- While AI import is on, the Excel template has no Category column (the product decides it); a file's own Category column is still used.

## 1.31.0 — 2026-11-11
- Super admin › Messaging (new menu): Push messages, SMS messages and Email messages. Send to every merchant and rider, all merchants, Banking & Financial or E-commerce merchants, riders, staff, website customers or chosen people; the page shows how many people it goes to (and, for SMS, how many SMS that is) and asks before sending. Each page keeps its history with sent / failed / waiting counts.
- Integration settings: SMS (mram), Email (Mailjet) and Firebase push each have an On / Off switch in their header. Off means nothing is sent on that channel, codes included. The "Send through … in production" and "Send push notifications" boxes are gone.
- The SMS limits and message settings moved to Integration settings, under the gateways. Notification settings › Channel & limits is gone (the gateway switches replace the channel switches).
- Global notifications now has every message in tabs, Parcel first (the separate Parcel notifications page is merged into it; old links open it).
- Recent messages: filter by channel (SMS / Email) and status, last 100 messages.
- Notifications: no push for people without the app (website receivers, applicants); receivers' emails (out for delivery, feedback, ready for collection, collection reminder) are off by default.
- Service plans & pricing: the services are one list, one under another. In Prices, Last mile (+ charge) and First mile start closed; for E-commerce Open box too.
- Operational settings › Fail delivery reasons (new), Return reasons and Receiver relations: add, edit, remove, and move up / down. The rider app, the Operations app and the Scan desk show them in that order (Self stays first, Other last).
- Franchises: any existing hub can be tagged as a franchise hub (Add franchise › "Tag an existing hub"), with its owner account (an existing user or a new one) and commission. From then on it works as a franchise: its riders are franchise riders (tagged so in Riders and the rider app), only for its parcels; other hubs, operations managers included, can't assign them. New hubs can still be opened as before.
- Franchise hubs in the Operations app: the franchise's account signs in and gets a smaller app: receive, receive & assign its own riders, deliver or record a failed delivery itself without a rider (proof by photo or signature; the COD is its cash), a rider's returns and cash taken together, its riders (add), its cash and deposits to a Delivery Fast hub. Delivered parcels' cash shows at once as cash to deposit.
- Scan desk › Receive & assign rider (new; also in the Operations app): choose the rider and scan. A parcel not received yet (in transit to the hub, a drop-off, back from a rider) is received and given to the rider in one scan; scanning it for another rider moves it to them.
- Failed deliveries: the rider chooses "Try again" or "Return to sender"; the parcel stays with the rider until the hub scans it in (Receive entry, or Receive from rider in the app; the rider doesn't scan). The hub follows the rider's choice or changes it (deliver again / return); "Return to sender" puts it on the returns list.
- Parcel queue: filter by merchant type (Banking & Financial, E-commerce, customers) and merchant.
- Fix: parcels booked with the old "Same day" service (API integrations, older forms) are timed same day again by the SLA (since 1.30.0 they got the Express time); the price is unchanged.
- Rider app 1.4.0: fail reasons from Operational settings, Try again / Return to sender, an optional "Receive from hub" scan, franchise rider tag. Operations app 1.2.0: Receive & assign rider, Receive from rider (with the next step), the reasons from Operational settings, and the franchise mode. Download them from the website.

## 1.30.0 — 2026-11-11
- Product categories (Super admin › Operational settings › Product categories): products are listed under categories, one list for Banking & Financial and one for Customer & E-commerce. A new catalog replaces the old product list: Banking & Financial 7 categories, 42 products (cards & PIN, cheque books, financial instruments, statements, account & loan documents, corporate & trade documents, banking devices); Customer & E-commerce 9 categories, 85 products for Bangladesh online shops.
- Each category's SMS, email and push switches decide where its parcels' messages go: a channel that is off sends nothing for those parcels, whatever the booking ticked. (The product's own "Send SMS & email" switch and Service plans › Messages are gone.)
- Priorities (Operational settings › Priorities): a tag on each parcel, no charge. Banking & Financial: General (default), Security; Customer & E-commerce: Online Product (default), Fragile. Chosen in New order, the merchant booking form, the Excel template's Priority column and the import window; All parcels and the other lists filter by priority.
- Delivery types (Operational settings › Delivery types): Regular, Express, 4 Hour Delivery and Same Day Delivery for every category; the super admin adds, renames, orders, deactivates or deletes them and chooses which categories get each. Each type's + charge is set per package in Service plans & pricing (Express keeps its ৳40). Any delivery type on any route (Express is no longer limited to the same district).
- The Banking & Financial services On-demand, B2B Document, Trade Service Document and Corporate Urgent Document are removed.
- Excel import: the template has Category and Priority columns and "Service" is now "Delivery type"; the import window can set the delivery type, category and priority for every row. Scan with phone (Claude) reads them from the label too.
- Products: Add / Edit picks the category; the list shows and filters by it; Export Excel has a Category column.

## 1.29.1 — 2026-11-10
- Banking & Financial comes first in the category dropdowns, and is chosen when they open: New order "Booking for", Excel import "Category", Scan with phone, Invite a merchant and Rider earning plans. The parcel type filter and the Print menu list it first too (the filter still starts at "All parcel types").

## 1.29.0 — 2026-11-10
- Super admin › Operational settings › Scan with phone usage: how many label photos were scanned (by day and in any period), how many Claude read and how many the local reader did, the fields found, the time each took and Claude's estimated cost (in total, per photo and per model), with the full scan log and Export.
- Scan balance (same page): turn on "Limit scans" and add scans or set the balance (e.g. 50). Each photo a phone sends takes 1; at 0 the phone can't send more until scans are added. The phone and the Operations console show the scans left. Off (the default) means no limit. Every change is in the audit log.

## 1.28.0 — 2026-11-10
- Scan with phone: take a photo and it is sent at once, with no crop / turn step and no waiting; several photos upload together, and the next one can be taken straight away. The computer reads several photos at the same time and the Operations console fills each row as it is read.
- Scan with phone can be read by Claude (server setting SCAN_READER=claude with an Anthropic API key): Claude (Haiku 5.5 by default, the lowest cost; SCAN_CLAUDE_MODEL can choose a stronger model) reads every field of the label from the photo (recipient, phone, address, district and thana, product, COD, weight, service, order ID, note; sender and pickup for customer parcels), each checked for its form and matched to the place list. Without it (or if a call fails) the current reader is used.

## 1.27.0 — 2026-11-10
- Excel import (merchant panel and Operations console): choose a Service and, for E-commerce and customer parcels, a Product type (Regular, Document, Books) in the import window. The choice replaces the file's values on every row and the price follows; "From the file" keeps each row's own. The preview and Import history show the choice.
- Excel import, "Messages to send": Select all and Unselect all buttons.

## 1.26.2 — 2026-11-10
- 4 invoices per A4 page has its own, fuller layout (8 per page stays the compact slip): barcode with the cash-to-collect (or service) box, sender and recipient with phones and hubs, the shipment details, the price lines and totals, "Received by" lines with a signature line, and the tracking QR.
- Invoices no longer print the parcel status (it changes after printing); the A4 invoice heading shows the service and delivery type instead.

## 1.26.1 — 2026-11-10
- Invoices: "Received at hub" shows when the parcel was created while it has not reached a hub yet (instead of "—").
- 8 invoices per A4 page: the "Received by (Name) / Relation / Date / Identification" lines are always printed; before, they were left out when the parcel details ran long.

## 1.26.0 — 2026-11-10
- Printed invoices (A4, 4 / 8 per page, POS) and shipment labels now follow the parcel line. E-commerce and customer parcels show COD, weight, product and product type (Regular / Document / Books); Banking & Financial documents show the service box, document type and reference instead, with no COD or weight.
- Every invoice and label shows "Received at hub" (when the parcel first reached a hub) and a "Received by" block to fill in on delivery: Name, Relation, Date, Identification (and Signature on A4 invoices).

## 1.25.2 — 2026-11-10
- Operations console: after an import, and on each import in Import history, "Print…" offers every print format of the parcel lists (all / e-commerce / document / customer invoices on A4, 4 or 8 invoices per A4 page, POS 80 mm invoice, shipment labels, the order / shipment list) for the parcels that import created, instead of labels only.

## 1.25.1 — 2026-11-10
- Operations console: Import history on New orders and All parcels now lists every import (Customer parcel, E-commerce and Banking & Financial), each marked with its kind. Before, it showed only E-commerce imports, so a Customer or Banking & Financial import seemed to disappear when the history was opened again.

## 1.25.0 — 2026-11-10
- Super admin › merchants › Manage › "Addresses, pickup and serving hub" › Change: edit a merchant's business and pickup addresses, pickup contact, pickup time and handover, and choose its hub. A chosen hub stays when the address or the network changes ("chosen by a super admin"); Automatic follows the pickup zone as before.
- Excel import: choosing the merchant (Operations console) preselects the merchant's hub as the drop-off hub; the merchant panel already uses it.

## 1.24.0 — 2026-11-09
- Excel imports: the customer / recipient phone is no longer always required. A row without it is created as "Needs info" (completed before delivery, like a missing address). Super admins can make it required per template in Import Template settings; then a row without it is not created.

## 1.23.6 — 2026-11-09
- "Log in as" (Operations console) and "View as" (Admin users & roles › Support access) open the merchant's new panel as that merchant again, instead of "No merchant workspace". The new panels show the support bar ("Viewing as … · ends in … min · End"); End or the time running out closes the tab, and your own sign-in stays.

## 1.23.5 — 2026-11-09
- First-page figures show 0 (not "—") while they load.

## 1.23.4 — 2026-11-09
- The first-page figures show their value straight away again, without counting up; the pages still open as fast as in 1.23.3.

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
