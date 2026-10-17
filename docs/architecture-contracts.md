# Cross-module contracts

Interfaces other modules rely on. Keep these signatures stable; extend, don't break.

## Notifications — `NotifyService` (modules/notifications)
```ts
notify(db, { event, to: { userId?, phone?, email?, name? }, vars?, channels? }): Promise<string[]> // outbox ids
notifyNow(input): Promise<void>                                                                  // outside a transaction
```
- `event` is a key from `modules/notifications/events.ts` (append new keys there) with an entry in
  `catalog.ts`: name, group (`EVENT_GROUPS`: Parcel, Merchant, Finance, Support, Account & security,
  Operations, Rider, Partner), audience, variables with sample values and a default template per
  channel it sends on. Pass event keys as literals (or from a map / literal-union parameter in the
  same file): `notifications/catalog.test.ts` scans the source and fails for an event without a
  catalog entry, a missing channel template, a variable the catalog doesn't list, or a catalog
  event nothing sends.
- Every event has editable SMS/email templates and an on/off toggle (super admin → Global
  notifications: grouped list with search and channel / customised / switched-off / security
  filters). User preferences: `GET/PUT /me/notification-preferences`.
- Never call an SMS/email provider directly. In development and tests messages are only logged;
  production sends through the configured gateways (SMS: mram, email: Mailjet), with per-recipient
  rate limiting in Redis. Super admins can send a real test message from the gateway settings.
- After commit, flush the returned ids: `OutboxService.flush(ids)` or push them to a parcel
  `AfterCommit.outbox`.
- OTP: `POST /auth/otp` answers `{ message, expiresInSeconds, resendAfterSeconds, devCode? }`;
  too early → `429` with `error.details.retryAfterSeconds` (and a `Retry-After` header). Use it
  for the "resend in N s" countdown. Limits are set in super admin → Global notifications.

## Ledger — `LedgerService.record(db, event)` (modules/finance/ledger.service.ts, global)
Call inside the transaction that moves money. Event types: COD_COLLECTED, COD_HANDED_OVER,
DELIVERY_CHARGE_EARNED, MERCHANT_SETTLEMENT_PAID, INVOICE_ISSUED, INVOICE_PAID, RIDER_PAYOUT_PAID,
REFUND_PAID, CLAIM_PAID, ADJUSTMENT — with amount, reference and merchantId/riderId/hubId.

## Live updates — `RealtimeService.publish(event)` (common/realtime.service.ts)
`{ type, id, merchantId?, customerId?, riderIds?, hubIds?, userIds?, staffPermission?, data? }`.
Clients: `GET /events` (SSE); browser helpers `DF.live(types, reload)`, `DF.events.on(type, fn)`.
Event types in use: `parcel.created`, `parcel.updated`, `rider.location`, `ticket.updated`, …

## Sign-in with MFA (modules/auth)
- `POST /auth/login` and `/auth/login/otp` return either the normal session or
  `200 { mfaRequired: true, mfaToken, methods: ["totp", "recovery"] }` (no session yet), or for a
  role that must use MFA but hasn't enrolled `200 { mfaSetupRequired: true, mfaToken }`.
- `POST /auth/login/mfa { mfaToken, code }` → normal session response.
- Enrolment: `POST /auth/mfa/setup` (signed in, or with `mfaToken`) → `{ otpauthUrl, qrDataUrl }`;
  `POST /auth/mfa/enable { code, mfaToken? }` → `{ recoveryCodes }` (and a session when started
  from `mfaToken`); `POST /auth/mfa/disable { code }`.
- MFA is mandatory for SUPER_ADMIN.

## Places — `GeoService` (modules/geo, global)
- `GET /geo/search?q=&limit=` and `GET /geo/reverse?lat=&lng=` (public, throttled, cached), backed
  by OpenStreetMap Nominatim (configurable base URL).
- `GeoService.geocode(text)` / `reverse(lat, lng)` for server-side use.

## Pickup windows (modules/parcels + website)
- Parcels have `pickupWindowStart` / `pickupWindowEnd`. `GET /pickup-slots?date=&district=&zone=`
  lists bookable windows. Merchant recurring pickup schedules build on the same fields.

## Tracking IDs (common/counters.ts)
- `nextTrackingId(db)` is the only generator (also used for pre-allocated CN stock). IDs are not
  sequential/guessable; older IDs stay valid.

## Barcode scanning (web: public/legacy/shared/scanner.js)
- `DF.scanner.start(videoElement, onCode)` / `DF.scanner.stop()` (camera; BarcodeDetector with a
  ZXing fallback from `/vendor/zxing`). Always keep a typed-input fallback.

## Rider location and proof of delivery (modules/rider)
- `POST /rider/location { lat, lng, accuracy, heading?, speed?, at }` while on shift; publishes
  `rider.location` (staff with rider:read, the rider's hub). Latest positions for operations
  maps: `GET /ops/rider-locations`.
- Proof of delivery records `capturedAt`, `lat`, `lng`, `accuracy`;
  `GET /parcels/:trackingId/proof` (same visibility as the parcel) returns it with the image
  (`/api/v1/files/:id`).
  Response: `{ trackingId, status, deliveredAt, method, receivedBy, otpVerified, note, capturedAt,
  recordedAt, location: { lat, lng, accuracy } | null, rider: { code, name } | null,
  image: { fileId, url, mimeType, sizeBytes } | null }`. Photo and signature images carry a
  visible stamp (tracking ID, rider, Dhaka time, coordinates) drawn by the rider app.
- Offline replay: `POST /rider/parcels/:trackingId/{pickup,start-delivery,delivery}`,
  `POST /rider/handover-requests` accept `Idempotency-Key`; `POST /rider/location/batch
  { points: [...] }` takes fixes recorded offline (duplicates ignored). History is kept
  `RIDER_LOCATION_RETENTION_DAYS` (default 30) days.

## Rider onboarding / KYC (modules/rider → `RiderKycService`, exported by `RiderModule`)
- For the applications module, when an approved application becomes a rider (inside your
  transaction; flush the returned outbox ids after commit):
  ```ts
  startOnboarding(db, { riderId, applicationId?, note?, notifyRider? }): Promise<{ onboarding, outboxIds }>
  attachDocument(db, { riderId, type, fileId, documentNumber?, expiresAt? }) // a StoredFile from the application
  ```
  `type`: `NID_FRONT | NID_BACK | DRIVING_LICENSE | PHOTO | VEHICLE_PAPERS` (licence and vehicle
  papers are required for motorbikes and vans). Or over HTTP: `POST /riders/:id/onboarding
  { applicationId?, note? }` (rider:manage).
- Status `NOT_STARTED → DOCUMENTS_PENDING → UNDER_REVIEW → APPROVED | REJECTED`; the rider is
  notified (`rider.kyc_status`) and live event `rider.kyc` is published. Rider: `GET /rider/kyc`,
  `POST /rider/kyc/documents`, `POST /rider/kyc/submit`. Review (rider:manage): `GET /rider-kyc`,
  `GET /rider-kyc/:riderId`, `POST /rider-kyc/documents/:id/review`, `POST /rider-kyc/:riderId/decision`.

## Rider pay and cash handover requests (modules/rider)
- Earnings are written in the transaction that completes a task (`recordTaskEarning`, one line
  per parcel and task type). Plans: stored `RiderPayPlan`, else derived from the super admin's
  `riderPlans` / `riderPlanAssignments` in platform-config (`POST /rider-pay/plans/sync-from-config`
  stores them). Payouts: `POST /rider-payouts/runs` → `/:id/approve` (another person) →
  `/:id/pay` (finance:manage; LedgerService `RIDER_PAYOUT_PAID`, NotifyService `rider.payout_paid`).
  Rider: `GET /rider/earnings`, `GET /rider/payouts/:id`. Live events `rider.earnings`, `rider.payout`.
- Cash handover requests: rider `POST /rider/handover-requests { hubId, note? }` (all COD in hand);
  hub staff `GET /cod/handover-requests`, receive with `POST /cod/handovers` (finance module) and
  link it: `POST /cod/handover-requests/:id/complete { handoverId }` (stored as
  `CashHandoverRequest.handoverId`). Requests whose collections were all received are completed
  automatically. Live event `cod.handover_request`.

## API key scopes (merchants + common/auth)
- `ApiKey.scopes` (e.g. `parcels:read`, `parcels:write`, `parcels:cancel`, `webhooks:manage`);
  the auth guard maps them to permissions. Keys without scopes keep today's access.
- `parcels:write` books parcels: `POST /parcels` (single, Idempotency-Key) and imports (`POST
  /imports/validate` with a file or JSON `rows`, then `POST /imports/:id/commit`; reading an import's
  status, history and rows takes `parcels:write` or `parcels:read`). The old `POST /parcels/bulk` is removed.

## Page views (modules/analytics)
- `POST /analytics/pageview { path, referrer? }` (public, throttled) from the website; super admin
  traffic charts read the aggregates.

## Rider shifts and attendance (modules/shifts)
- `GET /rider/shift` (rider) → `{ rider, today, schedule: { startTime, endTime, startsAt, endsAt } | null, checkedIn, current, recent[], upcoming[] }`.
- `POST /rider/shift/check-in { lat?, lng?, note? }` → attendance record; sets the rider ONLINE.
  `409 ALREADY_CHECKED_IN` when a check-in is open.
- `POST /rider/shift/check-out { lat?, lng?, note? }` → the closed record; sets the rider OFFLINE.
  `409 NOT_CHECKED_IN` when none is open. Breaks stay on `PATCH /rider/me/status`.
- Operations: `GET/POST/PATCH/DELETE /shifts/schedules`, `GET /shifts/today`, `GET /shifts/attendance`,
  `PATCH /shifts/attendance/:id` (correction with a reason), `GET /shifts/report?from&to&hubId`.
  A check-in more than 15 minutes after the scheduled start counts as late. Changes publish `rider.shift`.

## Scans (modules/scans)
- `POST /scans { code, kind, hubId?, source: CAMERA|KEYBOARD|MANUAL, ok?, message? }` from the hub
  console (staff) or the rider app (riders: kinds RIDER_PICKUP, RIDER_OUT_FOR_DELIVERY, RIDER_DELIVERY).
  Fire-and-forget; feeds `GET /scans/compliance` (expected vs actual scans per hub and rider).

## Pre-printed consignment numbers (modules/cn-stock)
- Bookings (`POST /parcels`, `/ops/parcels`) accept `cn`: an AVAILABLE CN from CN stock becomes the
  tracking ID (once; batches issued to a merchant only for that merchant; not for website bookings).

## Hub drop-off intake (modules/ops + parcels)
- `Parcel.intake` is `PICKUP` (default: a pickup rider collects it) or `DROP_OFF` (the sender brings
  it to `Parcel.dropOffHubId`). Drop-offs are booked by operations only: `POST /ops/parcels`, imports
  (`POST /imports/validate`) take `intake` and `dropOffHubId` (hub operators default to their own hub;
  operations managers must choose). Drop-offs are priced from the drop-off hub's location, not the
  pickup address: `PricingService.hubOrigin(hubId)` gives the hub's district and zone (a zone it serves
  named in its name/address, else a catalog zone named there, else its first served zone; empty =
  cross-zone), stored as `pricingSnapshot.origin` (dispute re-pricing and the drop-off SLA use it).
  Quotes take `dropOffHubId` (`POST /pricing/quote`, `POST /merchants/me/quote`; the answer has
  `origin`). Drop-offs have no pickup SLA and never count
  as waiting for a pickup rider (overview, dispatch, routing suggestions and map layers use
  `NEEDS_PICKUP_RIDER` from `ops/ops-common.ts`).
- Lifecycle: `canTransition(from, to, actor, { intake })` (packages/shared) lets ops move a drop-off
  PENDING_CONFIRMATION → AT_HUB (and not to PICKUP_ASSIGNED). `ParcelWorkflowService.transition`
  refuses any other hub than the declared one (`DROP_OFF_WRONG_HUB`); `receiveDropOff()` writes the
  "Received at <hub> (drop-off)" event, a HUB_RECEIVE scan, `droppedOffAt` and the delivery SLA from now.
- `parcelStatusLabel(status, { intake, dropOffHubName })` gives "Awaiting drop-off at <hub>"; parcel
  views (`statusLabel`, `intake`, `dropOffHub`, `droppedOffAt`) and public tracking use it.
- Imports are booking batches (`BookingBatch`, number `IMP-YYMMDD-NNN`, the same number as the
  `ImportJob`, see "Spreadsheet imports"): every submitted import creates one, merchant imports too.
  `GET /ops/booking-batches`, `GET /ops/booking-batches/:id` give expected / received /
  missing per batch.
- Receive desk: `POST /ops/hub-receive { code, hubId, source, batchId? }` answers
  `{ outcome: RECEIVED | ALREADY_RECEIVED | WRONG_HUB | NOT_FOUND | NOT_DROP_OFF | REFUSED, ok, message,
  parcel, batch }` (403 only for a hub outside the caller's scope). Other parcels take the normal
  AT_HUB scan-in.
- Labels: `POST /ops/labels { trackingIds }` → label data (recipient, COD, weight, service, origin and
  destination hubs, order ref, CN); printing is audited (`parcel.labels_print`). The courier console
  prints them as Code 128 (bridge-intake.js: A4 4-up or 4×6 in thermal).
- The sender gets `parcel.drop_off_booked` (hub name and address) instead of `parcel.booked`.
- Switching intake: `POST /parcels/:trackingId/intake { intake, dropOffHubId?, note?, expectedVersion? }`
  (parcel:dispatch; modules/parcels/intake-change.*) turns a pickup into a drop-off, a drop-off into a
  pickup, or moves a drop-off to another hub — only in `INTAKE_CHANGEABLE_STATUSES` (PENDING_CONFIRMATION,
  PICKUP_ASSIGNED, PICKUP_CONFIRMED; else 409 `INTAKE_LOCKED`; same intake/hub 409 `INTAKE_UNCHANGED`).
  An assigned pickup goes back to PENDING_CONFIRMATION through `transition()` with
  `context: { intakeChange: true }` and the rider is released. Re-priced with the rate card frozen at
  booking; tracking event, audit `parcel.intake_change`, sender notice `parcel.changed_to_drop_off` /
  `parcel.changed_to_pickup`, webhook `shipment.intake_changed`, realtime to old and new rider/hubs.
  Hub operators: only their hubs (current drop-off hub, the assigned rider's hub, the new hub).
  Courier console: row action and tracking-history button (bridge-intake.js).
- Merchant stats (`GET /merchants/me/stats`): `parcels.awaitingPickup` counts rider pickups only;
  `parcels.awaitingDropOff` counts drop-offs not yet handed over (both merchant dashboards show it).

## Spreadsheet imports (modules/imports, web: public/legacy/shared/importer.js)
One engine for both merchant panels, merchant API keys (`parcels:write`) and Courier Operations.
- Templates: `GET /imports/templates/ecommerce|document` → .xlsx generated from live data (catalog
  districts/zones/areas/products/packaging, service levels, document types and receiver relations from
  platform-config and the document rate card, active merchants for operations). Sheets: the data sheet
  (`Orders` / `Consignments`; required headers red with `*`, frozen header row, dropdowns as Excel data
  validation, zone dependent on district via `INDIRECT`, numbers/phone checked), `Instructions` (every
  column: required, allowed values, default, example) and the hidden `Lists` sheet the dropdowns read.
  Operations templates add a `Merchant` column. Written by `imports/xlsx` (ZIP + XML, CRC32, no
  dependency); the reader handles shared/inline strings, numbers, booleans and dates; CSV in UTF-8
  (BOM), UTF-16, comma/semicolon/tab, quoted cells. Old headers (`customer_name`, `phone`, …) still match.
- Dry run: `POST /imports/validate` (multipart `file` + `kind`, `merchantId?`, operations: `intake`,
  `dropOffHubId`; or JSON `{ kind, rows: [{ column: value }] }`) → an `ImportJob` (status VALIDATED)
  with one `ImportRow` per non-empty row: `VALID`, `INCOMPLETE` (will be created as "Needs info") or
  `ERROR` with `[{ column, message }]` (`text`: "Row 14 · Customer phone: …"). Nothing is booked.
  `GET /imports/:id/rows?filter=all|valid|incomplete|error|created|failed|not_created&page&pageSize`
  pages the preview (page numbers, not cursors: the rows are a fixed, ordered set).
- Rules (ImportEngineService, the same for preview and booking): a row is created when every
  super-admin-required column is filled and every non-empty cell is valid (phone via the BD phone
  rules, district/zone from the catalog — a zone alone finds its district —, option lists, numbers and
  ranges, COD Yes/No vs amount, no COD on documents, order ref unique in the file and not booked before;
  rows without an order ref are idempotent by a hash of their content, `Parcel.importKey`). Empty
  cells take the super admin's defaults (built in: service Regular, weight 1 kg e-commerce / 0.5 kg
  documents, address type Home/Office, parcel type E-commerce parcel). Built-in required columns:
  customer/recipient phone, and document type for documents.
- Submit: `POST /imports/:id/commit` → up to 100 rows are booked during the request, larger files by
  the pg-boss queue `imports` in chunks of 100 rows, each chunk one transaction (rows re-checked first;
  if a chunk fails its rows are booked one by one). Resumable: a retried or restarted job continues with
  the rows not yet CREATED. Progress: realtime `import.progress` / `import.completed`
  `{ id, data: { number, status, processed, total, created, failed } }` to the merchant's members, the
  uploader and super admins. Booking SMS per parcel are not sent for imports; the uploader gets one
  `import.completed` notification. Parcels: `importJobId`, `bookingBatchId` (= the import's batch),
  channel MERCHANT_PORTAL / MERCHANT_API / OPERATIONS, drop-off intake as chosen.
- After: `GET /imports/:id` (counts, progress, result `{ created, createdIncomplete, failed, notCreated }`),
  `GET /imports/:id/failed-rows?format=xlsx|csv` (rows not created in the template format plus an `Error`
  column; it can be uploaded again as is), `GET /imports/:id/tracking-ids` (labels), `GET /imports`
  (history: merchants their own imports, operations the operations imports, `mine=true`),
  `DELETE /imports/:id` (drop a validated file). Validated files nobody submits are discarded after a
  day; rows of finished imports are kept 90 days.
- Settings (super admin → Service catalog → Spreadsheet imports): `GET /imports/config`,
  `PUT /imports/config` (config:manage, audited `import_config.update`) — per template `{ column:
  { required, default } }`, `defaultDestination` (`MERCHANT_CITY` = the merchant's pickup zone, or a
  `FIXED` district/zone) and `limits`. `GET /imports/limits` gives the caller's limits for the upload screen.
- Limits (defaults / hard ceilings): merchants 5,000 rows and operations 10,000 rows per file (ceiling
  20,000), 10 MB per file (ceiling 20 MB), 1 running import per merchant (operations: per person;
  ceiling 3), 4 imports booking at once platform-wide (ceiling 8; each further one waits in the queue,
  at most 5 × that many queued), 2 files parsed at once per API instance, validate/commit throttled
  to 20 per minute per user. Benchmark on the development machine (`IMPORT_BENCH=1 npx vitest run test/imports.bench.test.ts`):
  5,000 rows validated in 2.2 s and booked in 64 s; 10,000 rows in 3.9 s and 120 s (~80 rows/s,
  peak ~0.8 GB RSS in the test process).
- Removed: the old JSON bulk booking APIs `POST /parcels/bulk`, `GET /parcels/bulk[/:id]`
  (BulkBookingService, pg-boss queue `bulk-bookings`) and `POST /ops/parcels/bulk`; they answer 404.
  Integrations send JSON rows to `POST /imports/validate` + `POST /imports/:id/commit` instead.
  Legacy data, kept for a later cleanup decision: the `bulk_bookings` table (`BulkBooking` model,
  marked legacy in `prisma/schema/merchants.prisma`; nothing reads or writes it any more) and any
  `bulk-bookings` pg-boss queue rows left in the `pgboss` schema. Dropping them needs an explicit
  owner decision and a migration; no data was removed.

## Bulk operations by Excel (modules/bulk-updates, web: shared/importer.js bulk mode)
Courier Operations changes many parcels from one spreadsheet: download the filtered parcels, choose
an action per row in Excel, upload, check the preview, apply. Built on the import engine (xlsx
writer/reader, parse slots, `ImportConfigService` limits); `ParcelsService`, `IntakeChangeService`,
`CompleteDetailsService` and `RoutingService` do the work. All endpoints need `parcel:dispatch` +
`parcel:read:any` (no API keys); every action is then checked by the service the single action uses.
- Export: `GET /bulk-updates/export?preset=pending_review|at_hub_unassigned|needs_info&status=&merchantId=
  &hubId=&dropOffHubId=&intake=&incomplete=&sla=AWAITING_REVIEW|ON_TRACK|AT_RISK|BREACHED&line=ecommerce|
  document|customer&from=&to=&q=` → .xlsx (headers `X-Row-Count`, `X-Matched`, `X-Row-Limit`; at most the
  operations import row limit, oldest first; the Instructions sheet says when the file was cut). Hub
  operators get their hubs' work only: parcels at / bound for / to be dropped off at their hubs, with
  their hubs' riders, and pickup requests in zones their hubs serve. Audited `bulk_update.export`.
- Sheet `Parcels` (`bulk-columns.ts`): Tracking ID, Current status, Suggested rider (`RoutingService.
  suggestFor`, the GET /routing/suggestions rules) and the parcel's data are read-only (grey, locked);
  Action, Rider, New status, Hub, Reason / note, Priority and the "Set …" completion columns are editable
  with dropdowns from live data (riders `code · name · hub` in the caller's scope, per-hub lists `RD_<n>`
  following the Hub column; Set zone/area follow Set district/zone; all as `IF($X2="",all,INDIRECT(…))`,
  never IFERROR). A hidden `version` column carries `Parcel.version`. The sheet is protected without a
  password (filter allowed; Review → Unprotect Sheet for anything else). Sheets `Instructions` and hidden
  `Lists`. Writer additions: `STYLE.readonly/headerReadonly/editable/editableText`, `Sheet.protect`,
  `Sheet.hiddenColumns`; `writeListsSheet()` / `dependentListFormula()` are shared with import templates.
- Actions: Accept & assign pickup rider (`assignPickup`; empty Rider = the suggestion), Assign delivery
  rider (`assignDelivery`; Set … columns in the same row complete a "Needs info" order first), Change
  status (`setStatus`; PICKUP_CONFIRMED, PICKED_UP, AT_HUB, IN_TRANSIT, OUT_FOR_DELIVERY, RETRY_SCHEDULED,
  RETURNED, EXCEPTION — never DELIVERED), Receive at hub (`setStatus` AT_HUB; drop-offs at their hub),
  Cancel (`cancel`, reason required), Change to drop-off / rider pickup (`IntakeChangeService`), Schedule
  return (`setStatus` RETURN_SCHEDULED, reason required), Complete details (`CompleteDetailsService`), Add
  note (`addNote`). `assignPickup`, `assignDelivery` and `cancel` take `opts.expectedVersion`.
- Dry run: `POST /bulk-updates/validate` (multipart `file`, .xlsx or .csv) → `BulkUpdateJob` (number
  `BLK-YYMMDD-NNN`, status VALIDATED) with a `BulkUpdateRow` per row that has an Action (rows without one
  are only counted as `ignored`): READY, WARNING (applies: rider off shift / on a break / over capacity,
  rider of another hub, ignored cells, no version), ERROR (`[{ column, message }]`, text "Row N · Column:
  message": lifecycle via `canTransition` with intake, hub scope, rider active and in scope, details needed
  before delivery, unknown or duplicate tracking ID, "changed since you downloaded it" when the version
  differs) or ALREADY_DONE (the parcel is already in the requested state). `GET /bulk-updates/:id/rows?
  filter=all|apply|warning|error|applied|already_done|failed|not_applied&page&pageSize`.
- Apply: `POST /bulk-updates/:id/apply` (only the uploader; one running bulk update per person) → up to
  100 rows during the request, more through the pg-boss queue `bulk-updates` (progress `bulk_update.
  progress` / `bulk_update.completed` `{ id, data: { number, status, processed, total, applied,
  alreadyDone, failed } }` to the uploader). High-priority rows first. Each row: skipped as ALREADY_DONE
  when the parcel already is in the target state or the same change (parcel, version, request: row
  `dedupeKey`) was applied by an earlier upload; else the service runs with the row's version (its own
  transaction; a refusal marks only that row FAILED). Resumable (rows not yet handled). Every audit record
  the services write carries `data.bulkUpdate = { id, number, row }` (`withAuditContext`, common/audit.service.ts);
  the job writes `bulk_update.validate / apply / complete / discard`. Notifications, webhooks and realtime
  are those of the single actions.
- Re-pricing preview: rows that change what the price depends on (Complete details / Assign delivery rider with
  Set district, zone, area, weight or service; Change to drop-off / rider pickup) get `plan.price = { before,
  after, difference }` at validate time from `CompleteDetailsService.previewCharge` / `IntakeChangeService.
  previewCharge`: the same engine and package frozen at booking that applying uses, so the charge applied equals
  the preview. A change the package refuses (`SERVICE_NOT_IN_PACKAGE`, e.g. no drop at hub) makes the row an
  ERROR. The job view has `pricing: { rows, before, after, difference }` over the rows that will apply (or were
  applied); the preview shows a PRICE column (old → new, difference) and a "Re-priced" total before Apply. There
  is no bulk last-mile change or re-weigh action (no single action to reuse yet).
- After: `GET /bulk-updates/:id` (counts, progress, result `{ applied, alreadyDone, failed, notApplied }`),
  `GET /bulk-updates/:id/failed-rows?format=xlsx|csv` (the same sheet plus an Error column; upload it again
  after fixing), `GET /bulk-updates?mine=` (history: your own; operations managers everyone's),
  `DELETE /bulk-updates/:id` (drop a checked file), `GET /bulk-updates/limits`. Checked files nobody applies
  are discarded after a day; rows of finished bulk updates are kept 90 days.
- Web: Shipments and the E-commerce / Document / Customer operations pages have "Bulk update by Excel"
  and "Bulk update history" (courier-operation/bridge-bulk.js) → `DFImport.bulk(cfg)` /
  `DFImport.bulkHistory(cfg)`: step 1 downloads with the page's filters plus hub, intake, SLA state and
  quick presets; then the import dialog's upload → preview (All / Will apply / Warnings / Errors, the cell
  in error highlighted) → apply → progress → result steps.

## Incomplete orders ("Needs info", parcels/incomplete.ts)
- Data model: imports may book a parcel with `recipientName`, `recipientPhone`, `deliveryStreet`,
  `deliveryDistrict`, `deliveryZone` null (nullable since the import migration); `incomplete = true`
  and `missingFields` ⊆ `recipientName | recipientPhone | address | district | zone`. It is priced (and
  its SLA set) to `pricingSnapshot.destination` — the default destination — with default weight and
  service until completed; `pricedDestination(parcel)` gives the place it was priced to. Views add
  `incomplete`, `missingFields`, `missingLabels`; null fields stay null in the API (public tracking
  hides them anyway). `GET /parcels?incomplete=true` lists them ("Needs info" filter in both panels).
- What it can do: be picked up (the pickup address is the merchant's), received at a hub (drop-offs
  too), get a label ("DETAILS PENDING", recipient "pending"). What waits: `ParcelWorkflowService.transition`
  refuses `ASSIGNED` / `OUT_FOR_DELIVERY` without recipient name, recipient phone, address, district
  and zone (`NEEDED_FOR_DELIVERY`), and `IN_TRANSIT` (hub transfer) without district and zone —
  `409 PARCEL_INCOMPLETE` with `details.missingFields` and `details.to`. The recipient name is only
  needed before delivery: an import row without it is still created ("Needs info", `missingFields:
  ["recipientName"]`) unless the super admin makes the name column required in the import settings.
  Routing suggestions list them as unmatched with what is missing; geocoding and SLA policies use what
  is known. The panels show the missing fields ("Needs info" badge and list in both merchant panels and
  Courier Operations; the completion form marks each missing field "needed before delivery").
- Completing: `POST /parcels/:trackingId/complete { recipient?, delivery? { street, area, district,
  zone, category }, weightKg?, serviceLevel?, note?, expectedVersion? }` — the merchant (and its API
  keys) while it waits for pickup, operations until it goes out for delivery. Validated like an import
  cell; re-priced with the tariff frozen at booking; a public "Order details updated/completed" event and
  an internal "Details changed" event; audited `parcel.complete_details`; published as `parcel.updated`.
  The operations price-neutral correction (`PATCH /parcels/:id`) also clears what it fills in.

## Geography admin (modules/geography; web: super-admin/bridge-geo.js, courier-operation/bridge-hubs.js)
Districts → zones → areas live in the service catalog (Setting `catalog`, read by every booking path
through `PricingService.catalog()`); the geography state next to it is Setting `catalog-meta`
(`geography/geo-catalog.ts`): deactivated places, optional map points and tombstones.
- Identity: places are referenced BY NAME on every record (parcels pickup/delivery, addresses,
  merchant pickup addresses and schedules, pickup requests, hubs, riders' zone, delivery zones and
  their areas, SLA policies, the import settings' fixed default destination, pricing snapshots).
  Stable ids would mean migrating all of them, so a **rename updates every reference in the same
  transaction** as the catalog (case-insensitive match; audited with the row counts per column,
  `references`). Zone names are unique in the whole country (the catalog keys areas by zone;
  "Kaliganj (Gazipur)" style for repeats), area names within their zone, district names overall.
- `PricingService.catalog(db?, { includeInactive? })`: without the flag (bookings, `/catalog`,
  dropdowns, templates, imports, bulk updates) deactivated places are left out — a district hides its
  zones and areas, a zone its areas. Code that checks or prices an EXISTING record passes
  `includeInactive: true` (hub drop-off origin, delivery-zone config, hub editor for the hub's current
  zone). New bookings (`ParcelsService.book`, all channels; imports per row) refuse a deactivated place
  with 422 `PLACE_INACTIVE` `{ field, name, address }`.
- Read (`hub:read`): `GET /geography` (tree with `active`, `lat/lng`, the zone's serving hubs
  `servedBy` and hubs standing in it), `GET /geography/counts?district=&zone=` (usage totals of the
  districts / a district's zones / a zone's areas), `GET /geography/usage?district=&zone=&area=`
  (`{ total, items: [{ key, label, count }] }`).
- Change (`config:manage`; audited `geo.<district|zone|area>.<create|update|delete>`,
  `geo.area.bulk_create`): `POST/PATCH /geography/districts`, `POST/PATCH /geography/zones`
  (`hubId` on create also creates its delivery zone), `POST /geography/areas { district, zone,
  names[] }` (pasted lines → `{ added, skipped: [{ line, name, reason }] }`), `PATCH /geography/areas`;
  PATCH takes `{ name?, active?, lat?, lng? }`. `DELETE /geography/{districts|zones|areas}?district=
  &zone=&area=` only when unused, else 409 `IN_USE` with `details.usage` and a message offering
  deactivation. Places are named in body/query (names may contain "/"), matched case-insensitively.
- `PUT /catalog` (packaging/products lists) keeps deactivated places the client can't see and refuses
  removing a used place (409 `IN_USE`); both writers serialise on `lockGeography(tx)`.
- Every change publishes `catalog.updated` (staffPermission `support:create`, i.e. every signed-in
  panel): `shared/api.js` reloads the catalog and the platform-config overlay, merchant panels, the
  courier console, the importer and super admin refresh their lists. There is no server-side catalog
  cache; the next request reads the new catalog.
- Hubs (`hub:manage`): `POST/PATCH /hubs` validate the district (catalog; deactivated refused unless
  already the hub's) and zone (of that district), unique names (409 `HUB_NAME_TAKEN`); a PATCH without
  `active` no longer reactivates a hub. Deactivate with `PATCH { active: false }` (audited
  `hub.deactivate`; hidden from `GET /hubs`). `GET /hubs/:id/usage` and `DELETE /hubs/:id` (only when
  unused: every foreign key to `hubs` plus uuid columns named `*hubId` / `*HubId` / `*hubIds` are
  counted, so new tables are covered; 409 `IN_USE` otherwise). Hub changes publish `network.updated`.
- The BD seed (`npm run db:seed:geo`) skips tombstoned places and hub codes (deleted or renamed away),
  so it never brings them back.

## Banking & Financial merchants (renamed from "Document / corporate", 2026-10-17)
- Enum values: `MerchantType.BANKING_FINANCIAL` and `Segment.BANKING_FINANCIAL` (was `CORPORATE_DOCUMENT`),
  renamed in place by migration `20261017073103_banking_financial_rename` (`ALTER TYPE … RENAME VALUE`;
  no rows rewritten). Use `BANKING_FINANCIAL` in code, zod schemas and the API; `CORPORATE_DOCUMENT` is
  no longer accepted. JSON written before the rename (e.g. old approval payloads, audit data) keeps the
  old string.
- Panel: `/banking-merchant` (route group `app/(banking-merchant)`, `src/features/banking-merchant`,
  `public/legacy/banking-merchant`, `<body data-app="banking-merchant">`, `api.js` guard). `/document-merchant`
  and `/document-merchant.html` redirect permanently (`next.config.ts`). Sign-in sends a Banking &
  Financial merchant's members to `/banking-merchant` (`auth.service.ts`).
- Labels: "Banking & Financial merchant(s)" in the panels, super admin ("Banking & Financial merchants"
  page), Courier Operations ("Banking & Financial operations" page), the website and import templates
  ("Banking & Financial consignment import"). The import template key stays `document` (`/imports/templates/document`).

## Hub groups (modules/packages)
No longer used for pricing (spec v2 prices by district). The `HubGroup` model and its endpoints
(`GET/POST/PATCH/DELETE /hub-groups`, `PUT /hub-groups/:id/hubs`, `GET/PUT /hubs/:id/hub-group`) are kept
because they are harmless and may be used for reporting; nothing reads them for prices.

## Service packages & pricing (modules/packages, packages/shared/src/packages.ts) — spec v2
The owner's spec "Service packages & pricing v2" (2026-10-17).

### Categories, products, routes
- **Categories** = the Prisma `Segment`: `CUSTOMER` (website senders, walk-ins), `ECOMMERCE`, `BANKING_FINANCIAL`.
  A merchant's category comes from its `MerchantType` (`segmentOfMerchantType`).
- **Products** (`ParcelProduct { segment, name, type, active, mutedNotifications[] }`): two lists — `ECOMMERCE`
  (shared by Customer and E-commerce) and `BANKING_FINANCIAL`; each product has one of the three fixed types
  `REGULAR | DOCUMENT | BOOKS` (`PRODUCT_TYPES`). Super admin: `GET/POST/PATCH/DELETE /parcel-products`
  (delete only if unused, else deactivate). `mutedNotifications` lists the parcel messages that are never sent
  for it (the editor shows one "may be sent" checkbox per message). The product is optional in every booking
  surface; none = type Regular. Seed: `SEED_PRODUCTS` (owner's lists), idempotent.
- **Routes** (district only, never zone): `normalizeDistrict()` maps Dhaka North / Central / South to "Dhaka";
  `DHAKA_SUBURBAN_DISTRICTS` = Gazipur, Narayanganj, Dhaka (Sub-urban) (a constant). `routeTier(pickup, delivery)`:
  `DHAKA_SUBURBAN` (Dhaka ↔ a sub-urban district, either way) → `SAME_DISTRICT` → `DIFFERENT_DISTRICT`.
  Pickup district: the pickup address's (rider / on-demand pickup) or the drop hub's (drop at hub). Delivery
  district: the recipient's (home delivery) or the collection hub's (Hub Pickup).

### Data model
- Service catalog in code (`SERVICES`): first mile (`first.rider_pickup|hub_drop|on_demand_pickup`), last mile
  (`last.doorstep` = Home delivery, `last.hub_collect` = Hub Pickup), service (`speed.regular` core,
  `speed.express`; Banking also `speed.on_demand`, `handling.b2b|trade|urgent`), `payment.cod` (Customer /
  E-com), `option.open_box` (E-com), 16 parcel notifications (`notify.*`; guest verification Customer only, never
  in the merchant modal), 4 support notifications, proof (`proof.photo|otp|signature`), tracking & support
  (`tracking.website` core, `tracking.live_location`, `tracking.rider_phone`, `support.tickets`), integrations
  (`integration.api|webhooks`, merchants only).
- `ServicePackage { segment, name, defaultFor, status ACTIVE|ARCHIVED, source }`, `ServicePackageVersion
  { services[], prices (packagePricesSchema), effectiveFrom }`, `PackageAssignment { merchantId, packageId|null,
  effectiveFrom }`. Three defaults (one per category); no assignment = the category default.
- Parcel columns: `packageVersionId`, `firstMile`, `lastMile`, `speedOption`, `openBox`, `onDemand`, `productId`,
  `productName`, `productType`, `services[]`, `notifications[]` (package ∩ booking choice − product mutes),
  `collectHubId`, `collectionCodeEncrypted`, `readyForCollectionAt`, `collectionDueAt`, `collectionReminderAt`,
  `reattemptCharge`. `pricingSnapshot` (engine `package-v2`): package/version, prices, services, tier, pickup and
  delivery districts, drop / collection hub, selection, `lines`, delivery charge, COD fee, total (older `package`
  and rate-card snapshots stay as booked).

### Price fields and the engine
`packagePricesSchema` (initial values: same district 70, Dhaka ↔ Sub-urban 100, different district 130, extra kg
15, Express 40, COD 1% min 10, return 50%, free re-attempts 2, others 0). Customer & E-com: route · product type
(Regular / Document / Books) · weight (0.5 kg included, each started kg above) · service (Regular / Express) ·
last mile (Home delivery / Hub Pickup, may be negative) · first mile (−drop at hub / +on-demand pickup) · open box
(E-com) · COD fee. Banking: route · service (Regular / Express / On-demand / B2B / Trade / Corporate Urgent; B2B
and Trade add to Regular, Corporate Urgent without a speed fee) · last mile · first mile — no weight, no COD, no
product-type charge. `priceParcel()` is the one pure function (packages/shared); `PackagesService.quote()` wraps
it (package in force, defaults, enforcement, hubs, route tier). Delivery charge never below 0 (a `floor` line),
whole taka, VAT-inclusive. Customer & E-com **Express = same day, SAME_DISTRICT only** (else 422
`EXPRESS_SAME_DISTRICT_ONLY`; an import row is an error).

### Booking rules and surfaces
`resolveSelection()` applies the defaults (rider pickup else drop at hub; home delivery else Hub Pickup; Regular;
every package notification) and refuses what the package lacks: 422 `SERVICE_NOT_IN_PACKAGE: <name>` (Banking COD
is refused too). Old fields still work: `serviceLevel` (SAME_DAY → Express), `documentType` ("B2B Document" →
B2B…), operations `intake`/`dropOffHubId`. Views: `GET /packages/me`, `GET /packages/effective?merchantId=|
segment=`. Quotes: `POST /pricing/quote` (customer), `POST /merchants/me/quote`, `POST /packages/quote`,
`POST /packages/simulate` (all return `lines`, `tier`, the old flat fields). Imports: the modal sends `firstMile`,
`dropHubId` (or `intake`/`dropOffHubId`), `lastMile`, `notifications`; template columns follow the package
(Product optional, Service when the package has more than Regular, COD only with COD, Open box only with open
box, Weight only for Customer / E-com); the preview shows each row's `lines` and `totals`. Forms: both merchant
panels and Courier Operations booking (`shared/order-services.js`), the website booking (React).

### Behaviour
Notifications (`NotifyService.notify({ parcel | pkg })`: global toggle ∧ package ∧ not unticked ∧ product allows ∧
recipient preference), proof methods (`proofMethodsFor`; no OTP without the delivery code;
`PROOF_METHOD_NOT_ALLOWED`), Hub Pickup (`READY_FOR_COLLECTION` at the collection hub, code SMS, `GET
/ops/collections`, `POST /parcels/:id/collect`, `POST /parcels/:id/collection-code`, hold period and reminder in
`GET/PUT /packages/settings`, job `collect-from-hub`; Courier Operations → Hubs → Hub Pickup counter), on-demand
priority (dispatch and rider lists sort it first; no instant-dispatch engine yet — a later phase), open box flag
(rider app), live rider location / phone on tracking (`liveDelivery`), support / API / webhook gating
(`SERVICE_NOT_IN_PACKAGE`), re-attempt fee (`reattemptCharge`), return charge (`returnPercent` of the delivery fee).

### Administration
Super admin → Service plans & pricing (`super-admin/bridge-packages.js`): packages per category, checkboxes, price
fields in the owner's groups, version with effective date, default, archive, assignment to merchants, simulator,
products, Hub Pickup hold period. Create / version / default / archive / assign are maker-checker
(`package.*`). Everything is audited. The merchant lists (super admin, Courier Operations → Merchants:
`GET /ops/merchants` `package`) show each merchant's package; the super-admin account dialog shows it read-only
(`GET /merchants/:id/package`) with "Change", which opens the merchant's row in the assignments table
(`window.DFPackages.openAssignment(segment, code)`). There is no plan select any more.

### Retired pricing (one-time set-up, marker Setting `service-packages-v2`)
Old rate cards and service plans are deactivated (rows kept); `POST /rate-cards` and `PUT /merchants/:id/tariff`
answer 410 `PRICING_RETIRED`; merchant tariffs and platform-config plan entitlements are no longer read. v1
packages are archived and their merchants moved back to their default. v1 products are deleted if unused, else
deactivated. Ledger entries, audit logs and parcel history are never touched.

