# Changelog

What's new in Paira Express, newest first. The top version is shown at the bottom of every panel's
sidebar, and "What's new" there lists these notes.

Every fix or feature adds a new version at the top: `## x.y.z — YYYY-MM-DD`, then one short line per
change (`- …`), written for the people who use the panels. Fixes raise the last number (1.0.0 → 1.0.1),
new features the middle one (1.0.1 → 1.1.0), big changes the first one (1.1.0 → 2.0.0).

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
