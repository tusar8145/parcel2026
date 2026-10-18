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
- One scan result for every scan box: `DF.scanner.feedback(inputOrId, ok, message?)` (high short beep / low
  long beep, vibration, the box flashing green / red, `data-scan-result="ok|error"`, optional live message).
  Used by the receive desk, linehaul bag scans / bag receive / truck loading, the CN check and the Hub
  Pickup counter's scan box.

## In-page dialogs (web: shared/api.js, courier-operation/bridge-network.js)
No panel uses `window.prompt` / `confirm` / `alert`.
- Every panel: `await DF.confirm({ title, message, confirm, cancel, danger })` → boolean,
  `DF.prompt({ title, message, label, value, required, multiline, maxLength, validate })` → string | null,
  `DF.choose({ title, label, options, value })` → value | null, `DF.alert(...)`. One small self-styled
  dialog above any page modal (Esc / Cancel / backdrop = no). Browser tests: `confirmDialog(page, { title,
  value })` in tests/e2e/support.ts (`.df-dialog`, `#dfDialogInput`, `[data-df-dialog-ok]`).
- Courier Operations forms: `Ops.form({ title, fields, validate, review, confirm, onSubmit })` on the
  console modal (`Ops.dialog`): labelled fields (text, number, date, select, searchable select, textarea,
  phone with +880, static), inline validation, an optional review table before money actions
  (`#opsFormReview`, test helper `confirmReview`), API errors inside the dialog (`#opsFormError`), success
  as a toast. Field ids are `of_<id>` unless `domId` is given. `Ops.confirm` / `Ops.prompt` = DF.confirm /
  DF.prompt. Returns' dialogs, the parcel editor and the hub picker use it; the tracking-history dialog
  was replaced by the parcel drawer ("Track" opens the drawer).

## Rider location and proof of delivery (modules/rider)
- `POST /rider/location { lat, lng, accuracy, heading?, speed?, at }` while on shift; publishes
  `rider.location` (staff with rider:read, the rider's hub). Latest positions for operations
  maps: `GET /ops/rider-locations`. `GET /rider/location` → `{ status, sharing, latest }` (the app's
  status line). Each live fix also publishes `parcel.rider_location` (id = tracking ID, merchantId,
  customerId; no coordinates) for the parcels the rider has OUT_FOR_DELIVERY with "Live rider location".
- Rider app (bridge-pwa.js): sends automatically while ONLINE with the app open and permission granted
  (moved the movement threshold, default 50 m, else a heartbeat every 2 / 5 / 10 minutes — the super admin's
  "Rider location interval", default 5 minutes, `GET /rider/location` → `settings`, see "Parcel position and
  vehicle location" — that takes a fresh fix even when standing still); offline
  fixes go to `/rider/location/batch`. Status line `#dfLocationLine` on Overview / My route / Scan /
  Settings ("Location sharing: On · last sent 1 min ago" / "Off · start your shift…" / "Blocked · allow
  location…" with "How to allow location"), button "Update my location now" (`[data-df-locate]`).
- Recipient / merchant view (`liveDelivery` on `GET /parcels/:id`, `GET /track/:id[?t=]`,
  `GET /track/:id/full`): only the parcel's own delivery rider, only while OUT_FOR_DELIVERY, only when
  the parcel's services include `tracking.live_location`, only the latest fix (never history); hidden
  when older than 15 min (`STALE`) or the rider is off shift (`OFF_SHIFT`). `locationStatus`: LIVE ·
  STALE · WAITING · OFF_SHIFT · LINK_REQUIRED · null; `location.ageSeconds`. A lookup by tracking ID alone
  gets `LINK_REQUIRED`: the position needs a link token — the recipient's out-for-delivery SMS link
  (`?t=l.…`, `signLiveLocationAccess`, 3 days; separate key, never opens `/full`) or
  `POST /track/:id/live-access { phoneLast4 }` (last 4 digits of the recipient's phone → `{ token }`,
  8 tries per parcel an hour + IP throttle), or an owner / feedback link, or a signed-in viewer of the
  parcel (merchant, customer, staff). Note: the out-for-delivery SMS is off by default in notification
  settings. Web: TrackingView (`[data-live-rider]`, `[data-live-status]`, `[data-live-updated]`, unlock
  form `[data-live-unlock]`, 1-minute refresh), merchant parcel details (`[data-df-live]`, refreshed on
  `parcel.rider_location` and every minute).
- Delivery code (OTP proof; owner change 2026-10-18): the recipient's code is issued and sent by SMS
  (`parcel.delivery_code`, `ParcelWorkflowService.issueDeliveryCode`) only when the parcel goes OUT_FOR_DELIVERY,
  never at assignment:
  - Assigning / re-assigning the delivery rider (`POST /parcels/:id/assign-delivery`, bulk "Assign delivery
    rider", the Excel bulk, dispatch suggestions) sends no code and clears any earlier one
    (`deliveryOtpEncrypted = null`). Moving the parcel back to a hub (AT_HUB by ops) clears it too.
  - "Start delivery" (`POST /rider/parcels/:id/start-delivery`: the Deliveries list button, the scan page,
    the scan section "Start deliveries", the offline replay) ALWAYS issues a fresh code, including a new
    start from RETRY_SCHEDULED / EXCEPTION: the recipient's latest SMS is always the valid one and any older
    code stops working. Picked up and delivered directly (`COLLECTED_DELIVER_DIRECT`) and operations setting
    OUT_FOR_DELIVERY (status change, bulk Resolve) issue a fresh code the same way. An Idempotency-Key replay
    of the same start returns the stored answer and sends nothing again.
  - Delivering with OTP proof while the parcel has no code (e.g. still ASSIGNED) → 409 `DELIVERY_NOT_STARTED`
    "Start the delivery first; the code is sent to the recipient then". Signature / photo proof needs no code.
  - `POST /rider/parcels/:id/resend-code`: OUT_FOR_DELIVERY, or RETRY_SCHEDULED while a code exists; a new
    code replaces the old one. ASSIGNED → 409 `DELIVERY_NOT_STARTED`.
  - A changed recipient phone re-sends a fresh code only when a code exists (i.e. after start).
  - The assigned rider's task / detail carries `deliveryCodeSent` (a valid code exists). Rider app: ASSIGNED /
    RETRY_SCHEDULED tasks show "Start delivery" and "Code will be sent when you start the delivery"; the
    delivery screen hides the OTP proof until the code is sent (offers "Start delivery" instead); start
    confirms "Delivery code sent to the recipient".
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

## Parcel position and vehicle location (modules/tracking; web: shared/parcel-map.js, shared/vehicle-share.js)
Owner request (2026-10-18): riders' positions on a 2 / 5 / 10-minute interval, "where is my parcel" on a map, and
"I'm travelling in this vehicle" for linehaul trips. Migration `vehicle_location` (tables `vehicle_shares`,
`trip_locations`, `trip_location_points`; additive).
- Interval: Setting `location-settings` `{ intervalMinutes: 2 | 5 | 10, movementMeters: 25–1000 }`, default
  **5 minutes / 50 m** (the owner asked for "every 5 / 10 minutes"; it was a fixed 2 minutes before).
  `GET /settings/location` (any signed-in user; also `staleAfterMinutes` = max(15, 3 × interval) and `defaults`),
  `PUT /settings/location` (config:manage, audited `location_settings.update`). Super admin › Rider plans ›
  "Rider location" (`super-admin/bridge-location.js`). The rider app reads it from `GET /rider/location`
  (`settings`) and sends on that interval while on shift, and at once after moving the threshold. A repeat of a
  fix already stored (same time) is accepted quietly (202, `accepted: 0`) instead of 422.
- Browser limit: web pages only get the location while the app is open and in the foreground; a locked phone, a
  closed app or another app in front pauses sending until it is opened again (positions then show as "last
  known"). True background tracking needs a native (Android) app; "Keep screen on" helps on a phone mount.
  Vehicle positions taken without a connection are not queued (rider positions are, as before).
- Vehicle sharing ("Travelling with a vehicle"): who — riders whose hub is the trip's origin or destination (a
  linehaul driver gets a rider account at their hub and uses the rider app; no new role), and staff with
  `parcel:dispatch` in hub scope of either end (hub operators of those hubs, operations managers). Trips:
  PLANNED (around today) or DEPARTED. `GET /vehicle-shares/trips` (what I may share), `GET /vehicle-shares/mine`
  (my open share + settings; ends it if the trip has arrived), `POST /vehicle-shares { trip: id | MF-… }` (start;
  audited `vehicle_share.start`; my other open share ends as REPLACED, someone else's on the same trip as
  TAKEN_OVER, audited `vehicle_share.stop`), `POST /vehicle-shares/:id/location { lat, lng, accuracy, heading?,
  speed?, at }` (202 `{ live, stopped, accepted }`; only the sharer; time within 12 h back / 2 min ahead; moves
  `trip_locations` forward in time only; history `trip_location_points` capped at 500 per trip and purged after
  RIDER_LOCATION_RETENTION_DAYS; publishes `vehicle.location` to both hubs and hub:manage; when the trip has
  arrived / closed / been cancelled → `{ stopped: true, reason }` and the share ends),
  `POST /vehicle-shares/:id/stop` (the sharer, or dispatch staff of the trip's hubs; audited). Automatic stop:
  arrive / close / cancel and the last bag received end every open share inside that transaction
  (`endTripShares`, audited `vehicle_share.auto_stop`, reason TRIP_ARRIVED / TRIP_CLOSED / TRIP_CANCELLED).
  Operations: `GET /vehicle-locations[?hubId]` (hub:read; hub scope; planned / departed trips with a position:
  vehicle, route, manifest, `at`, `sharing`, `sharedBy`, `stale` = not shared any more or older than
  staleAfterMinutes), `GET /vehicle-locations/:trip/history` (hub:read, oldest first, ≤ 500).
- Parcel position: `GET /parcels/:trackingId/position` (same scope as `GET /parcels/:id`; 404 outside it; not
  public) → `{ trackingId, status, kind: rider | hub | vehicle | last | none, lat, lng, label, detail, updatedAt,
  ageSeconds, stale, approximate, hub, trip, rider }` (lat / lng null = nothing to map). Pickup assigned → "Pickup
  rider R-… · on the way to pick up"; picked up / out for delivery → "With rider R-…" (the rider's latest fix,
  `stale` when older than staleAfterMinutes or off shift); at a hub, assigned, ready for collection, retry /
  return scheduled, exception → "At <hub>" (hub coordinates; "Loaded on MF-… · waiting to depart" when in a bag on
  a planned trip); IN_TRANSIT in a bag on a departed trip → the trip's vehicle position "In vehicle <reg> (A → B)"
  when shared (stale after sharing stops), else "On the way from A to B" at the origin hub; delivered → the proof
  of delivery's point ("Delivered here"), else the address pin; returned → the sender's pin or hub; pending /
  cancelled → none. One parcel per call (a few indexed lookups; never used for lists).
- Privacy: merchants and customers see the rider only while OUT_FOR_DELIVERY with `tracking.live_location`, a fix
  ≤ 15 min old and the rider on shift (the "Live rider location" rules), labelled "With the delivery rider"
  without rider code, name or detail; otherwise the hub ("Out for delivery from <hub>", city level). The vehicle's
  position is shown for their own parcels (a truck between hubs, no personal data). The recipient's public
  tracking (`/track/:id`) is unchanged and never gets a vehicle position.
- Web: `DFParcelMap` (`shared/parcel-map.js`): "Where is it now" in the Courier Operations drawer
  (`#drawerPosition`, follows `rider.location` / `vehicle.location` for its rider / trip) and the merchant drawer
  (`#merchantParcelPosition`, re-read with the parcel and every 2 minutes while in transit): label with the age,
  detail, "last known" tag, a small Leaflet map (loaded on first use, kept across repaints; `[data-df-position-kind]`,
  `[data-df-position-label]`). Rider app: "Travelling with a vehicle" panel on Overview and Settings
  (`#dfVehiclePanel`: today's trips or the manifest's MF-… barcode → "Start sharing vehicle location"; "Send
  location now", "Stop sharing"). Courier Operations › Transfers: "Vehicles on the road" (`#vhPanel`: map with hubs
  and vehicles, list, and the same start / stop for staff on board); the Today map shows vehicles too ("V" pins).
  API test: `test/vehicle-location.e2e.test.ts`; browser: `tests/e2e/parcel-map.spec.ts`.

## Rider scan workflows (web: rider/bridge-scan.js; API: parcels/rider-tasks.service.ts)
Scan parcel page → "Scan actions": set the context once, then scan (camera `DF.scanner.attach`, keyboard
scanner, typing; `DF.scanner.feedback` per scan; scans are processed in order). Actions go through
`DFOffline.send` (Idempotency-Key, offline queue). Deep link `/rider?page=Scan%20parcel&scan=<key>`.
- `GET /rider/tasks` → also `pickups[].pickupStop { key, name, address }` (key `M:<merchantId>` or
  `S:<senderPhone>`) and `carrying[]` (PICKED_UP by this rider, with `handover { hubId, hubName, at } | null`).
- Pickup from merchant: `POST /rider/parcels/:id/pickup { outcome: "COLLECTED", expectedStop? }` →
  PICKED_UP (pickup earning once; repeat = no-op; another stop's parcel 409 `OTHER_PICKUP_STOP`; not
  waiting for pickup 409 `NOT_AWAITING_PICKUP`). Expected vs scanned, missing list, "Mark all remaining"
  (confirm; allowed because riders may confirm pickups without scanning). No undo (lifecycle).
- Hand over at hub: `POST /rider/parcels/:id/handover { hubId, source? }` puts a PICKED_UP parcel on the
  hub's handover list — internal tracking event (metadata kind `RIDER_HANDOVER`), audit
  `parcel.rider_handover`, scan `RIDER_HANDOVER`, realtime `rider.handover` to the hub. **No status
  change**: the hub confirms by scanning it in (`POST /ops/hub-receive` → AT_HUB). Undo until then:
  `POST /rider/parcels/:id/handover/withdraw` (`HANDOVER_CLOSED` after the hub scan). Hub side:
  `GET /ops/rider-handovers?hubId=` (parcel:read:any, hub scope) → `{ hub, total, items: [{ rider, parcels }] }`.
- Start deliveries: `POST /rider/parcels/:id/start-delivery` (a fresh delivery code by SMS; see "Delivery code"). Deliver: opens the
  normal delivery dialog (`#actionModal.df-scan-quick`: big buttons, OTP focused); proof and COD rules
  unchanged. Failed delivery / return to hub: `POST /rider/parcels/:id/delivery { outcome: FAILED }` with the
  section's reason / next action / hub.
- Return to merchant: `GET /rider/return-runs` (runs OUT_FOR_RETURN dispatched to the rider, with parcels):
  a read-only check; RETURN_SCHEDULED → RETURNED stays an operations action (run completion).

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
- Three bulk-create templates (2026-10-18), API kinds `customer` (Customer parcel: walk-in / website
  customers booked by operations, no merchant), `ecommerce` and `document` (Banking & Financial; the
  kind name is kept, `banking` is accepted as an alias). `ImportJob.kind` is `CUSTOMER | ECOMMERCE |
  DOCUMENT` (migration `import_kind_customer`). Each template has exactly its category's columns
  (`imports/columns.ts`):
  - E-commerce (`Orders`): Customer name, Customer phone *, Delivery address, District, Zone, Area,
    Product, COD amount (only if the package has COD), Product value, Weight (kg) 0.01–50, Service,
    Open box (only if the package has it), Order ID, Delivery instructions.
  - Banking & Financial (`Consignments`): Recipient name, Recipient phone *, Delivery address, District,
    Zone, Area, Product (Banking list), Service, Reference no., Delivery instructions. No COD, weight,
    product value or open box.
  - Customer parcel (`Parcels`): Sender name *, Sender phone *, Pickup address *, Pickup district *,
    Pickup zone *, Pickup area, then the e-commerce-like recipient and parcel columns (Delivery
    district / zone / area, Product from the shared Customer + E-commerce list, COD amount, Product
    value, Weight, Service from the Customer default package; no open box), Reference no., instructions.
  There is no Merchant column: operations choose the category and then the merchant (searchable) or
  "Customer parcel" in the upload dialog; merchants (and API keys) always import their own category
  (`WRONG_TEMPLATE` for the other one, on download and on upload; customer parcels are operations only).
  Removed columns of the old templates: Merchant, Parcel type, Packaging, Receiver relationship,
  Origin branch code, Address type, Cash on delivery (Yes/No), Item / Document description, Document
  type. Files that still have them upload with those columns listed as ignored; imports never write
  `packaging`, `receiverRelation` or `originBranchCode` (the parcel columns stay for existing data).
- Templates: `GET /imports/templates/customer|ecommerce|document?merchantId=` → .xlsx generated from
  live data: districts → zones → areas (active only; dependent dropdowns with
  `IF($D2="",L_zones,INDIRECT("ZN_"&MATCH($D2,L_districts,0)))`, never IFERROR; the pickup zone follows
  the pickup district), the category's active products shown with their type ("Fashion & Apparel
  (Regular)"; order: Regular → Document → Books, the seeded order inside a type, then new ones by name;
  the plain name is accepted too), and the Service list of the file's package only (the chosen
  merchant's; customer parcels: the Customer default; operations without a merchant yet and super
  admin downloads: the category's default). Sheets: the data sheet (required headers red with `*`,
  frozen header row, Excel data validation, numbers/phone checked), `Instructions` written per
  category (who the file is for, "the recipient phone is required", the Needs-info rule, pricing by
  district, Express = same day inside the same district only for Customer / E-commerce, no weight /
  COD text for Banking, first / last mile, drop hub and messages are chosen on the upload screen;
  every column with required, allowed values, default and an example from live data: the first active
  product, a real district / zone / area) and the hidden `Lists` sheet the dropdowns read. Written by
  `imports/xlsx` (ZIP + XML, CRC32, no dependency); the reader handles shared/inline strings, numbers,
  booleans and dates; CSV in UTF-8 (BOM), UTF-16, comma/semicolon/tab, quoted cells. Old headers
  (`customer_name`, `phone`, …) still match.
- Dry run: `POST /imports/validate` (multipart `file` + `kind`, `merchantId` (operations: required for
  ecommerce / document, `MERCHANT_REQUIRED` otherwise; refused for customer), `intake` / `dropOffHubId`
  or `firstMile` / `dropHubId`, `lastMile`, `notifications`; or JSON `{ kind, rows: [{ column: value }] }`)
  → an `ImportJob` (status VALIDATED) with one `ImportRow` per non-empty row: `VALID`, `INCOMPLETE` (will
  be created as "Needs info") or `ERROR` with `[{ column, message }]` (`text`: "Row 14 · Customer phone: …").
  Nothing is booked. The modal's first / last mile, drop hub and messages are checked against the same
  package before the file is read (`SERVICE_NOT_IN_PACKAGE`), for operations too.
  `GET /imports/:id/rows?filter=all|valid|incomplete|error|created|failed|not_created&page&pageSize`
  pages the preview (page numbers, not cursors: the rows are a fixed, ordered set).
- Rules (ImportEngineService, the same for preview and booking): a row is created when every
  super-admin-required column is filled and every non-empty cell is valid (phone via the BD phone
  rules, district/zone from the catalog — a zone alone finds its district —, option lists, numbers and
  ranges, a service the package offers ("Express is not in Shop 1's service package (choose …)"; "Same
  day" is refused with a message pointing to Express, never mapped silently), no COD on Banking &
  Financial ("Banking & Financial parcels can't be cash on delivery"), order ref not booked before).
  Duplicates in a file: the first row is kept and each later one is an error naming it ("ORD-7
  duplicates row 11", "the same order as row 2"); rows without an order ref are idempotent by a hash of
  their content (`Parcel.importKey`; for customer parcels checked among parcels without a merchant).
  Empty cells take the super admin's defaults (built in: service Regular, weight 0.5 kg). Always
  required: the recipient phone, and for customer parcels the sender name / phone and the pickup
  address / district / zone. Customer parcels book with channel OPERATIONS, no merchant, the row's
  sender and pickup, priced by the Customer default package; incomplete rows are priced to the default
  destination (MERCHANT_CITY = inside the merchant's / sender's own pickup district).
- Submit: `POST /imports/:id/commit` → up to 100 rows are booked during the request, larger files by
  the pg-boss queue `imports` in chunks of 100 rows, each chunk one transaction (rows re-checked first;
  if a chunk fails its rows are booked one by one). Resumable: a retried or restarted job continues with
  the rows not yet CREATED. Progress: realtime `import.progress` / `import.completed`
  `{ id, data: { number, status, processed, total, created, failed } }` to the merchant's members, the
  uploader and super admins. Booking SMS per parcel are not sent for imports; the uploader gets one
  `import.completed` notification. Parcels: `importJobId`, `bookingBatchId` (= the import's batch),
  channel MERCHANT_PORTAL / MERCHANT_API / OPERATIONS, drop-off intake as chosen.
- After: `GET /imports/:id` (counts, progress, `kindLabel`, result `{ created, createdIncomplete, failed, notCreated }`),
  `GET /imports/:id/failed-rows?format=xlsx|csv` (rows not created in the template format plus an `Error`
  column; it can be uploaded again as is), `GET /imports/:id/tracking-ids` (labels), `GET /imports`
  (history: merchants their own imports, operations the operations imports, `mine=true`, `kind=`),
  `DELETE /imports/:id` (drop a validated file). Validated files nobody submits are discarded after a
  day; rows of finished imports are kept 90 days.
- Settings (super admin → Import settings, page "Spreadsheet imports", `super-admin/bridge-imports.js`:
  a tab and a download button per template): `GET /imports/config` (`templates.{ecommerce,document,customer}`
  with `required`, `default`, `configurable`, `defaultable`, `packageOnly`; `titles`), `PUT /imports/config`
  (config:manage, audited `import_config.update`) — per template `{ column: { required, default } }`,
  `defaultDestination` (`MERCHANT_CITY` = the merchant's / sender's pickup zone, or a `FIXED`
  district/zone) and `limits`. Unknown (removed) columns are refused on PUT; settings of removed
  columns already stored are dropped once at start-up (`ImportConfigService.migrateStored`, audited
  `import_config.migrate` with the removed keys) and on every save. `GET /imports/limits` gives the
  caller's limits for the upload screen.
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
Courier Operations changes many parcels from one spreadsheet, **one file per action** (2026-10-18): on a page
choose an action ("Accept & assign pickup rider"), download its file (only the parcels that can take that
action, only the columns it needs, no Action column), fill it in, upload, check the preview, apply. Built on
the import engine (xlsx writer/reader, parse slots, `ImportConfigService` limits); `ParcelsService`,
`IntakeChangeService`, `CompleteDetailsService` and `RoutingService` do the work. All endpoints need
`parcel:dispatch` + `parcel:read:any` (no API keys); every row is then checked by the service the single
action uses.
- Pages (`bulk-kinds.ts`, `kind` = `new_orders | pickup | hub_desk | delivery | problems | returns | transfers | all`) and
  action templates (`bulk-actions.ts`, `action` = `accept_pickup | reassign_pickup | mark_picked_up |
  receive_at_hub | mark_exception | assign_delivery | resolve_status | change_status | cancel | to_drop_off |
  to_pickup | schedule_return | complete_details | add_note | transfer`). Every template runs an existing single action
  (`bulk-columns.ts BULK_ACTIONS`), some with a fixed or narrowed status ("Mark picked up" = Change status →
  Picked up). A template defines: label, sheet tab name, the parcels that can take it (`where()`: the
  lifecycle via `reachable(targets, only?)` = `canTransition` per intake and last mile; intake changes:
  `INTAKE_CHANGEABLE_STATUSES` by intake; Complete details: `incomplete` and not delivered / out for delivery;
  Add note: any parcel), lead / info read-only columns, input columns (own header and help, `required` → "*"),
  `skipBlank` and the how-to / does texts.

  | Page | Page's parcels | Actions |
  |---|---|---|
  | New orders | Pending operations confirmation | Accept & assign pickup rider, Cancel, Change to drop-off, Change to rider pickup, Complete details, Add note |
  | Pickup | Pickup assigned / confirmed, picked up | Assign / reassign pickup rider, Mark picked up, Cancel, Add note |
  | Hub desk | Picked up, in transit, drop-offs on their way, at hub, ready for collection | Receive at hub, Mark exception, Add note |
  | Delivery | At hub without delivery rider (doorstep), assigned | Assign delivery rider, Complete details, Add note |
  | Problems | Exception, retry scheduled, needs info, SLA at risk / breached | Resolve: change status, Assign delivery rider, Schedule return, Complete details, Add note |
  | Returns | Retry scheduled, exception, return scheduled, at hub after a delivery attempt | Schedule return, Add note |
  | Transfers | At my hub for another hub, not bagged | Add to transfer bag |
  | All parcels | any filter | every action (also the general Change status) |

  | Action | Parcels in the file | Columns to fill in (besides read-only info) | Blank rows |
  |---|---|---|---|
  | Accept & assign pickup rider | pending rider pickups | Rider (empty = Suggested rider, prefilled read-only), Hub (narrows Rider), Priority, Note | applied |
  | Assign / reassign pickup rider | pickup assigned / confirmed | New rider *, Hub, Priority, Note | skipped |
  | Mark picked up | pickup assigned / confirmed | Note | applied |
  | Receive at hub | can go to At hub (picked up, in transit, drop-offs, returning) | Receiving hub (empty = drop-off hub / own hub), Note | applied |
  | Mark exception | can go to Exception | Reason * | skipped |
  | Assign delivery rider | can go to Assigned (at hub doorstep, assigned, failed / exception) | Rider (empty = suggestion), Hub, Priority, Note, Set … (district → zone → area) | applied |
  | Resolve: change status | exception, retry scheduled | New status * (At hub, Out for delivery, Retry scheduled, Exception), Hub, Note | skipped |
  | Change status (All parcels) | open parcels | New status * (operations-settable, never Delivered), Hub, Note | skipped |
  | Cancel | can still be cancelled | Reason * | skipped |
  | Change to drop-off | rider pickups before pickup | New drop-off hub, Note | applied |
  | Change to rider pickup | drop-offs before receipt | Note | applied |
  | Schedule return | can go to Return scheduled | Reason * | skipped |
  | Complete details | "Needs info", still changeable | Set recipient name / phone / address / district / zone / area / weight / service, Note | skipped |
  | Add note | any | Note * | skipped |
  | Add to transfer bag | at my hub for another hub, not bagged | Destination hub (prefilled), Bag, Note | applied |

  "Applied": every row in the file is applied (delete the rows not to change); "skipped": a row whose input
  columns (Priority excluded) are all empty is skipped and counted as `ignored`. Completely empty rows are
  always skipped.
- `GET /bulk-updates/kinds`: the pages the caller can use (a page whose actions the caller can't perform is
  left out; today every action needs `parcel:dispatch`) with `actions [{ action, label, summary }]`, statuses
  and presets. `GET /bulk-updates/actions?kind=&<export filters>`: the page's actions with `label`, `title`
  ("Accept & assign pickup rider · New orders"), `summary`, `howTo`, `does`, `parcels`, `skipBlank`, `fill`
  (headers to fill in), `columns`, `statuses` (New status choices) and `count` (parcels that can take it now:
  page ∩ eligibility ∩ filters ∩ hub scope).
- Export: `GET /bulk-updates/export?kind=&action=` (action required; an action not on the page →
  `BULK_ACTION_NOT_ON_PAGE` 422) `&preset=pending_review|at_hub_unassigned|needs_info&status=&merchantId=
  &hubId=&dropOffHubId=&intake=&incomplete=&sla=AWAITING_REVIEW|ON_TRACK|AT_RISK|BREACHED&line=ecommerce|
  document|customer&from=&to=&q=` → .xlsx named `delivery-fast-<page>-<action>-<stamp>.xlsx` (headers
  `X-Row-Count`, `X-Matched`, `X-Row-Limit`; at most the operations import row limit, oldest first; the
  Instructions sheet says when the file was cut; 60 downloads a minute). Hub operators get their hubs' work
  only: parcels at / bound for / to be dropped off at their hubs, with their hubs' riders, and pickup requests
  in zones their hubs serve. Audited `bulk_update.export` `{ kind, action, rows, matched, filter }`.
- The data sheet is named after the action (e.g. "Accept & assign pickup"): Tracking ID, Current status, lead
  info (Suggested rider from `RoutingService.suggestFor` / Pickup rider / Missing fields), the action's input
  columns (blue; required ones red with "*"), read-only info (grey, locked), then hidden `version`
  (`Parcel.version`) and `template` = `<kind>:<action>`. Dropdowns from live data (riders `code · name · hub`
  in the caller's scope with per-hub lists `RD_<n>` following the Hub column; Set zone / area follow Set
  district / zone; all `IF($X2="",all,INDIRECT(…))`, never IFERROR); only the lists the action uses are in
  the hidden Lists sheet. Protected without a password (filter allowed; Review → Unprotect Sheet). The
  Instructions sheet: title "Delivery Fast · <action> · <page>", the how-to line ("Accept & assign pickup
  rider: fill Rider for each row …; delete rows you don't want to change"), what it does, which parcels,
  where to upload, the columns and the action's rules.
- Dry run: `POST /bulk-updates/validate?kind=&action=` (multipart `file`, .xlsx or .csv; `kind` / `action` may
  also be multipart fields: the page and the chosen action). The file's `template` must match: another
  page's file → `BULK_KIND_MISMATCH` (422, `{ fileKind, pageKind, fileAction }`, "This is the "Cancel" file
  of New orders. Upload it on the New orders page (or All parcels), …"; All parcels takes any page's file);
  another action's file → `BULK_ACTION_MISMATCH` (422, `{ fileAction, pageAction }`); rows of several files →
  `BULK_KIND_MIXED`. Without `action` the file's own action is used (if the page offers it). A file without
  a template column (hand-made CSV with Tracking ID + the action's columns) takes the chosen action.
  **Backward compatibility (decision):** files from before action templates (an Action column, or a
  page-only template such as `new_orders`) are refused politely with `BULK_TEMPLATE_OUTDATED` ("download a
  fresh file for the action"); they would be stale anyway (versions) and their jobs are kept for history.
  Only the template's columns are read (others are listed in `ignoredColumns`). → `BulkUpdateJob` (number
  `BLK-YYMMDD-NNN`, status VALIDATED, `kind` and `action`) with a `BulkUpdateRow` per checked row: READY,
  WARNING (applies: rider off shift / on a break / over capacity, rider of another hub, no version), ERROR
  (`[{ column, message }]`, text "Row N · Column: message"; lifecycle refusals are on the Current status
  column: "A parcel that is "At hub" can't get a pickup rider"; hub scope, rider active and in scope, details
  needed before delivery, unknown or duplicate tracking ID, "changed since you downloaded it" when the
  version differs) or ALREADY_DONE. No rows → `NO_ACTIONS` ("None of the N rows has Reason filled in").
  `GET /bulk-updates/:id/rows?filter=all|apply|warning|error|applied|already_done|failed|not_applied&page&pageSize`.
- Apply: `POST /bulk-updates/:id/apply?kind=&action=` (only the uploader; one running bulk update per
  person; another page / action → `BULK_KIND_MISMATCH` / `BULK_ACTION_MISMATCH`) → up to 100 rows during the
  request, more through the pg-boss queue `bulk-updates` (progress `bulk_update.progress` /
  `bulk_update.completed` `{ id, data: { number, status, processed, total, applied, alreadyDone, failed } }`
  to the uploader). High-priority rows first. Each row: skipped as ALREADY_DONE when the parcel already is in
  the target state or the same change (parcel, version, request: row `dedupeKey`) was applied by an earlier
  upload; else the service runs with the row's version (its own transaction; a refusal marks only that row
  FAILED). Resumable. Every audit record the services write carries `data.bulkUpdate = { id, number, row }`
  (`withAuditContext`); the job writes `bulk_update.validate` (with `kind`, `action`) / `apply` / `complete` /
  `discard`. Notifications, webhooks and realtime are those of the single actions. `assignPickup`,
  `assignDelivery` and `cancel` take `opts.expectedVersion`.
- Re-pricing preview: rows that change what the price depends on (Complete details / Assign delivery rider
  with Set district, zone, area, weight or service; Change to drop-off / rider pickup) get `plan.price =
  { before, after, difference }` at validate time from `CompleteDetailsService.previewCharge` /
  `IntakeChangeService.previewCharge` (the same engine and frozen package as applying). A change the package
  refuses (`SERVICE_NOT_IN_PACKAGE`) makes the row an ERROR. The job view has `pricing: { rows, before, after,
  difference }`; the preview shows a PRICE column and a "Re-priced" total. No bulk last-mile change or
  re-weigh action (no single action to reuse yet).
- After: `GET /bulk-updates/:id` (`kind`, `kindTitle`, `page`, `action`, `actionLabel`, `title` "Accept &
  assign pickup rider · New orders", counts, progress, result `{ applied, alreadyDone, failed, notApplied }`,
  the action's `columns`, `pricing`), `GET /bulk-updates/:id/failed-rows?format=xlsx|csv` (the same action's
  sheet plus an Error column; upload it again after fixing; legacy jobs without an action →
  `BULK_TEMPLATE_OUTDATED`), `GET /bulk-updates?mine=&kind=&action=` (history: your own; operations managers
  everyone's; filter by page and action), `DELETE /bulk-updates/:id`, `GET /bulk-updates/limits`. Checked
  files nobody applies are discarded after a day; rows of finished bulk updates are kept 90 days.
- Schema: `BulkUpdateJob.kind` (migration `bulk_update_kind`) and `BulkUpdateJob.action` (nullable, index
  `(action, createdAt)`, migration `bulk_update_action`, 2026-10-18; null = a file from before action
  templates, shown as "Several actions").
- Transfers (2026-10-18): page `transfers`, action `transfer` ("Add to transfer bag", BulkAction `ADD_TO_BAG`,
  also on All parcels). **Decision:** a bulk action template, not a linehaul-specific import, so it gets the
  engine for free (version check, dedupe / idempotency, preview, failed-rows file, history, background apply);
  the linehaul work is done by `TransferService` (modules/linehaul/transfer.service.ts). Parcels in the file
  (`ActionTemplate.scoped = "transfer"` → `TransferService.eligibleWhere`): AT_HUB at the caller's hubs
  (network for managers), not in an active bag (LOADED in an OPEN / SEALED / IN_TRANSIT bag), whose destination
  isn't the hub holding them. Destination = the collection hub (hub collect) else the recipient zone's serving
  hub (`DeliveryZone.hubId`); parcels in unserved zones are listed too. Columns: Suggested destination
  (read-only), Destination hub (prefilled with the suggestion; dropdown of every active hub, `L_dest_hubs`),
  Bag (optional: an open bag `BG-…` from the dropdown `L_bags` of open bags at my hubs, or a label of my own
  to group parcels; empty = one bag per destination for the upload, labelled with the upload's number), Note;
  info: current hub, recipient, district, zone, weight, COD, merchant, service. Checks (bulk-planner.ts
  `planTransfer`): at a hub of mine, destination another operating hub (warning when it differs from the
  suggestion), named bag open / from the parcel's hub / to that destination, label `[A-Za-z0-9 _-/.#]{1,40}`;
  a parcel already bagged to that destination is ALREADY_DONE (another destination: ERROR). Apply: each row →
  `TransferService.addToBag` (the open bag with that number, or the open bag with origin + destination +
  label, created on first use under an advisory lock; `LinehaulService.putInBag`: same rules as scanning;
  audit `linehaul.bag_create` / `linehaul.bag_add` with `data.bulkUpdate`). Apply options (body of
  `POST /bulk-updates/:id/apply`, `{ transfer: { seal?, tripId? | newTrip?: { vehicleId | vehicleRegNo,
  driverName, driverPhone, plannedDepartureAt? } } }`, stored in `BulkUpdateJob.options`; a chosen trip is
  checked before anything changes): after the rows, the upload's open bags are sealed (seal number = the bag
  number on its tag) when asked or when they go on a trip, then loaded on the planned trip (bags on its route;
  others reported) or on new trips, one per route. The outcome is `job.transfer = { options, result: { bags,
  trips, problems } }`. Parcels stay AT_HUB; they become IN_TRANSIT only on trip departure. Schema:
  `LinehaulBag.label` + index `(originHubId, destHubId, label)`, `BulkUpdateJob.options` (migration
  `linehaul_bag_label_bulk_options`). Web: Transfers → "Bulk transfer by Excel" / "Transfer history"
  (bridge-linehaul.js) → `DFImport.bulk({ bulkKind: "transfers", bulkAction: "transfer", applyExtra, applyMount,
  applyBody, resultExtra })` (importer.js hooks: options under the preview, the request body, the bags /
  trips with "Print tag" / manifest on the result). Adding to a return run has no bulk action.
- Web: All parcels (Shipments and the E-commerce / Banking & Financial / Customer tabs) has "Bulk update All
  parcels by Excel" and "Bulk update history" (courier-operation/bridge-bulk.js); the journey pages have
  "Bulk update <page> by Excel" (`#stageBulkUpdate`, bridge-nav.js with `DFOps.bulkKindOf(view)`,
  `DFOps.bulkLabel(kind)`, `DFOps.bulkConfig(kind)`) → `DFImport.bulk(cfg)` with `cfg.bulkKind` (and optional
  `cfg.bulkAction` to skip step 1) / `DFImport.bulkHistory(cfg)`. Step 1 "Choose an action" (`#dfiActions`
  `[data-dfi="pick-action"][data-action]`, each with its one line and `[data-count]` parcels, from
  `/bulk-updates/actions` with the page's filters); step 2 downloads that action's file (`#dfiActionInfo`
  shows the how-to and the columns to fill in; the page's filters plus hub, intake, SLA state and quick
  presets; "‹ Change action"); step 3 upload → preview (All / Will apply / Warnings / Errors, the cell in
  error highlighted, the action's input columns) → apply → progress → result. History shows "ACTION · PAGE"
  and filters by page (`#dfiHKind`, starting with the page's own) and action (`#dfiHAction`).

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
- `PUT /catalog` (packaging list; its `products` field is legacy and read by nothing) keeps deactivated places the client can't see and refuses
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

## Shared catalogs & locations (super admin, `super-admin/02.js` `pricingConfigPage()`)
Cleaned up 2026-10-17: the page keeps only lists that real forms read.
- **Products:** not on this page. The only product lists are the parcel products (`/parcel-products`,
  Service plans → Products; the page has a pointer button, `DFPackages.openProducts`). Every product
  dropdown reads them: merchant forms (`/packages/me`; "No product (Regular)" when the package has none),
  Courier Operations booking (`/packages/effective`), the website (`GET /catalog` `products` = Customer &
  E-commerce parcel products, no fallback), imports (engine `lists.products`). Platform-config no longer
  returns `ecommerceProducts`, and `RETIRED_KEYS` (`admin/derived-keys.ts`: `ecommerceProducts`,
  `documentProducts`, `documentProductTypes`, `merchantProducts`, `parcelProducts`, `documentTypes`,
  `serviceCatalog`; the last ones were written by the retired plan editor in `03.js`) are dropped on save and left out
  of every read. The Setting `catalog` `products` field stays in the schema only for compatibility.
- **Removed:** delivery service levels (fixed Regular / Same day / Express labels, superseded by the
  package's speed options) and document types (superseded by the package's handling options B2B / Trade /
  Corporate Urgent). Merchant forms hide both once the package loads; their static fallbacks no longer
  read the config.
- **Kept (stored server-side):** return reasons (platform-config `returnReasons`; `GET /returns/reasons`
  returns them, else the standard `RETURN_REASONS`; free text still accepted), plus the delivery address
  hierarchy (`bridge-geo.js`).
- **Removed (owner decision 2026-10-18):** receiver relationships and the e-commerce / document packaging
  lists. No booking form reads them any more (the Setting `catalog` `packaging` field and the platform-config
  keys stay for compatibility; nothing shows or edits them).
- The old "Service catalog" page (demo service table) is now **Import settings** ("Spreadsheet imports",
  `bridge-imports.js`) with a pointer to Service plans; its demo rows are no longer saved.

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

## Merchant addresses (modules/merchants/merchant-address.ts; web: website/react/PartnerView.tsx + MerchantPlaceFields.tsx, shared/merchant-address.js) — 2026-10-18
- Data (additive migration `20261018065016_merchant_structured_address`): the merchant row keeps the **business
  address** (`businessDistrict/Zone/Area/AreaOther/Street/Lat/Lng`, plus `businessCategory`, `websiteUrl`) and ONE
  **primary pickup location**: the original `pickupAddress` (street) / `pickupArea` / `pickupDistrict` columns that
  booking defaults, pricing, imports and documents read, plus `pickupZone`, `pickupAreaOther`, `pickupLat/Lng`,
  `pickupSameAsBusiness`, `pickupContactName/Phone`, `pickupTime` (MORNING | MIDDAY | AFTERNOON), `handover`
  (RIDER_PICKUP | HUB_DROP) and the derived `pickupHubId` (FK hubs, SetNull). `pickupArea` holds the catalog area,
  the "Other" text, or the zone name when no area was chosen. **Multiple pickup locations later:** a
  `MerchantPickupLocation` table (same fields + `isPrimary`) whose primary row is mirrored into these columns, so
  nothing that reads the merchant changes.
- Validation (`resolveMerchantPlace`): district / zone / area against the ACTIVE catalog (case-insensitive, catalog
  spelling stored); a zone that lists areas needs an area or `otherArea` (free text); pins must be in Bangladesh;
  phones via `phoneSchema`. Errors are 422 `VALIDATION_FAILED` with `details[].path` like `business.zone`, `pickup.area`.
- `POST /merchants/applications { type, name, contactName, contactPhone, contactEmail?, businessCategory?, websiteUrl?,
  business, pickupSameAsBusiness = true, pickup? (required when false), pickupContactName? / pickupContactPhone?
  (default: the contact), pickupTime, handover = RIDER_PICKUP, inviteToken? }`. The old flat pickup fields are no
  longer accepted. The invitation still fixes the type (`INVITE_TYPE_MISMATCH`).
- Invitations (super admin → Invite a merchant, `POST /merchants/invites`): SMS / email event `merchant.invite`
  ("You're invited to join Delivery Fast as {{role}}. Create your account and apply here: {{link}}"); the contact
  name may not be a phone number. `POST /merchants/invites/lookup` (public) adds `hasAccount` (the invited phone /
  email already has an account). The website form (`/merchant?invite=…`): the invitation banner, type fixed; a
  signed-out merchant creates the account (SMS code to the contact phone, `SIGNUP`) or signs in (password or SMS
  code) in step 5 of the form and the application is sent in the same submit; two-step accounts and "forgot
  password" go through the login page and come back. The draft (no passwords / codes) and the invitation token are
  kept in sessionStorage until the application is sent. Validation problems show under the field and in a summary
  at the top (`#merchantFormErrors`), API errors too; a used / expired link shows its message in the banner.
- `PATCH /merchants/me` (owners) and `PATCH /merchants/:id` (merchant:manage) take the same address fields, all
  optional (`pickupSameAsBusiness: true` copies the business address; changing the business moves a "same" pickup).
  Whenever the pickup moves, the serving hub is **re-derived** (`servingHub`: the delivery zone of the pickup zone →
  its active hub) and the audit row carries `pickupHubId` / `previousPickupHubId`.
- Views (`merchantView`): `business`, `pickup`, `pickupSameAsBusiness`, contact, time, handover, `pickupHub
  { id, code, name, district, address }`, `routeDistrict` (the hub's district for HUB_DROP, else the pickup
  district), `addressComplete` (false = an older free-text address). `GET /merchants/me` adds `pickupSuggestion`
  (best-effort catalog match, `matchLegacyPickup`: only an unambiguous district + zone, never "the first zone").
- `GET /merchants/pickup-hub?district=&zone=` (public, throttled): `{ district, zone, hub | null, routeDistrict }`
  for the application form's "Drop at hub".
- Older merchants: their text stays as it is. `node apps/api/scripts/match-merchant-addresses.mjs [--apply]` fills
  `pickupZone` + hub for unambiguous matches only (dry run by default; idempotent; audit `merchant.address_matched`).
  Settings shows "Complete your address" with the suggestion preselected.
- Readers: ops booking (`ops.service.book`) uses `pickupZone`, the pickup contact phone and the pin; imports and
  pickup requests use `pickupZone` / the pickup contact; `/ops/merchants` returns the structured pickup and hub.
  Geography renames update `merchants.pickupZone` and the business columns; usage counts include them.
- UI: website `/merchant` (React; district / thana / area use the searchable select, "Other" area, optional map pin,
  "Pickup from the business address", Drop at hub shows the serving hub); merchant panels → Settings → Store profile
  / Corporate account (`DFMerchantAddress.formHtml/wire`); super admin review and account dialogs
  (`DFMerchantAddress.summaryHtml`, `#dfmAddress`); Courier Operations → Merchants ("PICKUP & HUB" column) and the
  booking form's merchant hint (`#bkMerchantPickup`).

## Hub groups (modules/packages)
No longer used for pricing (spec v2 prices by district). The `HubGroup` model and its endpoints
(`GET/POST/PATCH/DELETE /hub-groups`, `PUT /hub-groups/:id/hubs`, `GET/PUT /hubs/:id/hub-group`) are kept
because they are harmless and may be used for reporting; nothing reads them for prices.

## Service packages & pricing (modules/packages, packages/shared/src/packages.ts) — spec v2
The owner's spec "Service packages & pricing v2" (2026-10-17).

### Categories, products, routes
- **Categories** = the Prisma `Segment`: `CUSTOMER` (website senders, walk-ins), `ECOMMERCE`, `BANKING_FINANCIAL`.
  A merchant's category comes from its `MerchantType` (`segmentOfMerchantType`).
- **Products** (`ParcelProduct { segment, name, type, active, sendMessages }`): two lists — `ECOMMERCE`
  (shared by Customer and E-commerce) and `BANKING_FINANCIAL`; each product has one of the three fixed types
  `REGULAR | DOCUMENT | BOOKS` (`PRODUCT_TYPES`). Super admin: `GET/POST/PATCH/DELETE /parcel-products`
  (delete only if unused, else deactivate). `sendMessages` (default `true`) is the one "Send SMS & email for this
  product" switch: off = its parcels get no parcel messages at all. Which messages go is chosen per parcel at
  booking (below). The old per-message `mutedNotifications` column is deprecated and unused (migration
  `20261017112404_product_send_messages` added `sendMessages` = true for every existing product, including ones
  that had some messages muted; the column stays only because the schema lock refuses data-dropping changes).
  The product is optional in every booking surface; none = type Regular. Seed: `SEED_PRODUCTS` (owner's lists),
  idempotent.
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
  `productName`, `productType`, `services[]`, `notifications[]` (the messages that may be sent: see "Parcel
  messages" below),
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

### Single-order forms (2026-10-18)
- One field order everywhere: recipient → delivery address (category, district → zone → area, street) → parcel
  (product, weight, contents / value, reference) → service (ONE first-mile select: Rider pickup / Drop at hub +
  its hub / On-demand pickup; ONE last-mile select: Home delivery / Hub Pickup + optional hub; Service) → COD
  tick + its own amount, open box → messages → live price.
- The live price uses the same body as the booking, **product included** (`product` in `POST /packages/quote`,
  `POST /merchants/me/quote`, `POST /pricing/quote`), so the form price is the booked price.
- Places come from `GET /catalog` (active only) with "Choose district / zone / area" placeholders and nothing
  preselected; long lists are searchable (`DFOrderServices.fill` / `searchable` → `DF.searchSelect`, shared/select-search.js). Products come from the
  package view (active, the category's list, shown "Name · Type", Regular → Document → Books).
- Weight is a number (0.01–50 kg, 0.5 default) for Customer / E-commerce; Banking & Financial has no weight
  (0.5 kg is sent, it doesn't price) and no COD. E-commerce: "COD amount" (shown when COD is ticked) is separate
  from the optional "Product value" (`declaredValue`).
- Removed from every form: Receiver relationship, Packaging, Origin branch code, Shipment / Service type,
  Service level, the hidden Document type, the merchant Pickup zone select and the separate operations
  "Intake" select. The API still accepts those fields (old integrations) but no form writes them.
- Panels: `DF.phoneInput` (+880 fixed) and inline `DF.validate` errors; the booking dialogs fit a 390 px phone.
- Courier Operations "New shipment" books for an E-commerce or Banking & Financial merchant, or a **walk-in
  sender** (customer parcel: sender name / phone and pickup address, the Customer default package,
  `POST /ops/parcels` without `merchantId`; Customer parcels → "New walk-in shipment"). Drop at hub is sent as
  `intake: DROP_OFF` + `dropOffHubId`. After booking the parcel's drawer opens ("Print label (PDF)"); the
  merchant panels open the new order's details with the same button.

### Parcel messages (stored per parcel)
- Every booking surface (merchant single forms and Courier Operations booking via `shared/order-services.js`, the
  website booking, the Excel import modal, the API `POST /parcels` `notifications`) shows the package's parcel
  messages all pre-ticked; the user unticks what shouldn't go. Field omitted (API) = every message in the package.
- `Parcel.notifications` is the source of truth, written at booking by `PackagesService.parcelFields`: the ticked
  messages, or `[]` when the parcel's product has `sendMessages = false` (forms then show the checklist disabled
  with "This product doesn't send messages"; `GET /packages/me|effective` `products[].sendMessages`, website
  catalog `productsWithoutMessages`). Imports: each row stores the modal's selection, or `[]` when that row's
  product has messages off; the preview rows carry `messagesOff` / `messagesNote` ("This product doesn't send
  messages").
- `NotifyService.notify({ parcel })` sends a parcel message only when the global toggle is on ∧ its code is in
  `Parcel.notifications` ∧ the recipient hasn't opted out. Package and product were applied when the list was
  stored. This covers the events that happen after booking too (pickup / out for delivery / delivered / failed
  attempt, cancel, return scheduled / returned, feedback, changed to drop-off / pickup, Hub Pickup "ready for
  collection" and its reminder). Parcels booked before packages (`packageVersionId` null) aren't gated.
- "Ready for collection / collection reminder" (`notify.collection`) is an ordinary checklist entry, offered when
  the package has it and pre-ticked like the rest; it only ever fires for Hub Pickup parcels. "Changed to hub
  drop-off / rider pickup" work the same way.
- No "Delivery code" in the list: no code SMS, and OTP isn't one of the parcel's proof methods.

### Behaviour
Notifications (above; package-level messages such as support use `NotifyService.notify({ pkg })`), proof methods (`proofMethodsFor`; no OTP without the delivery code;
`PROOF_METHOD_NOT_ALLOWED`), Hub Pickup (`READY_FOR_COLLECTION` at the collection hub, code SMS, `GET
/ops/collections`, `POST /parcels/:id/collect`, `POST /parcels/:id/collection-code`, hold period and reminder in
`GET/PUT /packages/settings`, job `collect-from-hub`; Courier Operations → Hubs → Hub Pickup counter), on-demand
priority (dispatch and rider lists sort it first; no instant-dispatch engine yet — a later phase), open box flag
(rider app), live rider location / phone on tracking (`liveDelivery`), support / API / webhook gating
(`SERVICE_NOT_IN_PACKAGE`), re-attempt fee (`reattemptCharge`), return charge (`returnPercent` of the delivery fee).

### Administration
Super admin → Service plans & pricing (`super-admin/bridge-packages.js`): packages per category, checkboxes, price
fields in the owner's groups, version with effective date, default, archive, assignment to merchants, simulator,
products (list column "Messages: On / Off" with a "Send SMS & email" checkbox that saves at once; the add form has
the same checkbox, on by default), Hub Pickup hold period. Create / version / default / archive / assign are maker-checker
(`package.*`). Everything is audited. The merchant lists (super admin, Courier Operations → Merchants:
`GET /ops/merchants` `package`) show each merchant's package; the super-admin account dialog shows it read-only
(`GET /merchants/:id/package`) with "Change", which opens the merchant's row in the assignments table
(`window.DFPackages.openAssignment(segment, code)`). There is no plan select any more.

### Retired pricing (one-time set-up, marker Setting `service-packages-v2`)
Old rate cards and service plans are deactivated (rows kept); `POST /rate-cards` and `PUT /merchants/:id/tariff`
answer 410 `PRICING_RETIRED`; merchant tariffs and platform-config plan entitlements are no longer read. v1
packages are archived and their merchants moved back to their default. v1 products are deleted if unused, else
deactivated. Ledger entries, audit logs and parcel history are never touched.


## Courier Operations navigation (web: courier-operation/bridge-nav.js, bridge-parcel.js)
UI only (2026-10-17): the menu follows the parcel journey; every page keeps its renderer, API calls,
permissions and actions. A menu item opens a view; a view's tabs are original pages shown with a filter, a
mode or a subset of their sections. The page scripts keep the old internal names (`render("Hubs")`,
`DFOps.page()`, hidden `#breadcrumbPage` / `#legacyNav`), and every old name still opens the right place:
`render(oldName)`, alert links (`data-page-link`) and `/courier-operation?page=<old or new name>[&tab=<tab>]`.

| Old page | New place |
|---|---|
| Live overview | Today (stage cards with live counts, one metrics row, map, newest parcels, alerts; the service-line cards and "Network health" were dropped) |
| Shipments | All parcels › All |
| E-commerce operations | All parcels › E-commerce |
| Banking & Financial operations | All parcels › Banking & Financial |
| Customer parcels | All parcels › Customer |
| Dispatch & routes | Pickup › Assign pickup rider (tables: waiting for a pickup rider, being picked up) and Delivery (tables: waiting for a delivery rider, out with riders; map, route planner); the assignment queue was dropped; `?page=Dispatch` → Delivery |
| Scheduled pickups | Pickup › Scheduled pickups |
| Hubs & zones (hub operations) | Hub desk › Receive (the receive desk: every arrival, plus Find) · At my hub (parcels at the hub now, paged, with their next action) · Hub Pickup counter · End of day (reconciliation); Hubs & zones (hub register with capacity columns, zones, routes); `?page=Hubs` → Hub desk; old tab "Drop-off receive" → Receive. Removed: the scan & quick status form, the manual receive form, the hub-to-hub transfer form (Transfers is the way), the transfer report, the shipment register with status dropdowns, network setup and the separate capacity panel |
| Linehaul | Transfers |
| Exceptions | Problems › Exceptions (also Failed delivery, Needs info, SLA late-risk) |
| Returns (RTO) | Returns |
| COD & finance | COD & settlement |
| Analytics & SLA | Reports › Analytics & SLA |
| Reports | Reports › Reports |
| Riders & fleet, Merchant accounts, CN stock, Admin settings | Riders, Merchants, CN stock, Settings |
| (new) New orders | Shipments page limited to Pending operations confirmation (all lines), with bulk Accept & assign for ticked rows |

- Parcel tables (courier-operation/bridge-lists.js): New orders, All parcels (every tab), every stage
  table, the Today feed and Hub desk › At my hub are server-paged lists: `GET /parcels` 100 rows a page,
  "Load more" (cursor); search, status, dates, merchant, service line and stage are server filters. The
  browser keeps only the parcels on screen (no working set); `parcel.*` events re-fetch the changed parcel
  and patch its rows (or drop them when they leave the list, or reload the first page for newcomers);
  a reconnect reloads the lists and counts; a 3-minute safety poll reloads the counts only. The action
  column is pinned on the right of every parcel table; rows have no status dropdowns (next action, drawer).
- Read-only filters for the lists (`GET /parcels`, apps/api/src/modules/parcels/parcel-stages.ts):
  `stage` = new | pickup_waiting | pickup | hub | transfers | delivery_waiting | delivery | exceptions |
  failed | needs_info | sla_risk | problems | returns (failed = RETRY_SCHEDULED + back at a hub after a failed
  attempt, see "Failed deliveries"); `failedAttempts=true` (= stage failed), `failedBefore=true|false` (any
  failed attempt or none); `line` = CUSTOMER | ECOMMERCE | BANKING_FINANCIAL;
  `forHubIds` (comma list) = parcels that belong to those hubs now: current hub, drop-offs booked to them,
  picked up by their riders, pickups from the zones they serve (delivery zones and the hub's own zone).
- "My hub": hub operators' lists and counts default to `forHubIds` = their hubs, with a "My hub / All hubs"
  switch on each table (remembered per browser, `deliveryfast-ops-scope`). UI default only; the API's
  permissions are unchanged.
- Stage counts (menu badges, Today cards, stage metrics): `GET /ops/stage-counts[?forHubIds=]` (same
  filters as the lists, reloaded after `parcel.*` events): New orders = PENDING_CONFIRMATION; Pickup =
  accepted without a rider + being picked up; Hub desk = AT_HUB + READY_FOR_COLLECTION; Transfers =
  IN_TRANSIT; Delivery = ASSIGNED + OUT_FOR_DELIVERY; Problems = EXCEPTION + failed deliveries (RETRY_SCHEDULED
  + back at a hub after a failed attempt) + open "Needs info" (also Problems' "Awaiting action"); Returns = return requests + RETURN_SCHEDULED (what the
  Returns page lists). `detail` carries each part (pickupWaiting, deliveryWaiting, failed, backAfterFailure, slaRisk, …).
- One way to assign a rider: the row's next action or the drawer; "Suggest riders" (the former Create
  dispatch) and Excel for many; New orders also accepts ticked rows together (one rider, one
  `POST /parcels/:id/assign-pickup` per order, progress and result in the dialog).
- A tab draws only its own sections (`DFOps.hubPart`, `DFOps.tabMode`); sections that load data (receive
  desk batches, counter) load once per opening of the tab (`DFOps.navEpoch`), then on events.
- Menu per role (permissions unchanged; hidden pages stay reachable by link): super admin / operations
  manager everything; hub operator Today, the seven stages, COD & settlement (rider cash handovers),
  All parcels, Riders (with `rider:read`); finance COD & settlement (first, landing page), All parcels,
  Reports, Merchants; support Today, All parcels and Support.
- Next action (`DFOps.nextAction(parcel)`): Pending → Accept & assign rider (assign dialog); awaiting
  drop-off → Receive (Hub desk › Receive); At hub → Assign rider, or Add to transfer when a hub
  of the delivery zone other than the current one is known (Transfers); Exception → Resolve; Needs info →
  Edit details; Ready for collection → Hand over (Hub Pickup counter); Return scheduled without a run →
  Add to return run (Returns › Return a parcel); failed delivery (back at a hub after a failed attempt, or
  retry scheduled) → "Re-attempt (Assign rider)" plus a second primary "Return to sender" (bridge-failed.js).
  Rows show it, then Details (drawer) and More.
- Parcel drawer `DFOps.drawer.open(trackingId)` (summary, actions, price lines, proof via
  `GET /parcels/:id/proof`, staff notes with "Add a staff note" (`POST /parcels/:id/notes`), "Messages
  sent" (`GET /parcels/:id/messages`), tracking history); the top-bar search (tracking ID / CN /
  phone, Enter) opens it using the parcels on screen, `GET /parcels/:id` and `GET /parcels?q=`. Row
  "Track" opens the drawer too.
- Parcel message log `GET /parcels/:trackingId/messages` (parcel:read:any; hub operators only their hubs'
  parcels, like printed documents; merchants and riders 403): the parcel's outbox SMS / email, newest first,
  max 100: channel, event + label, masked recipient (`+880 17•• •••678`, `ra•••@example.com`), state,
  attempts, provider, last error, queued / sent time; text with security codes masked (events with a code
  variable: every 4–8 digit number → `••••`; link query strings cut). Outbox rows carry `trackingId`
  (NotifyService sets it from `vars.trackingId`, migration `outbox_tracking_id`); older rows match by text.
- Hub desk › End of day (courier-operation/bridge-desk.js): `GET /ops/hub-reconciliation?hubId&date`
  (hub:read + parcel:read:any; hub operators their own hubs; modules/hub-reconciliation): per hub and Dhaka
  day: arrivals received (AT_HUB events at the hub) + still expected (loaded in inbound bags, drop-offs booked
  to the hub, picked up by its riders) = expected; dispatched out = out for delivery with its riders +
  parcels in its bags on trips that departed that day; delivered by its riders; held now (AT_HUB) and ready
  for collection now; cash (with cod:receive or finance:read): COD collected by its riders and at its
  counter that day, cash handovers received, collected that day and not handed over, still with riders (any
  day), per rider. PDF: `GET /documents/hub-reconciliation` (same figures).
- Desk tools (bridge-desk.js): the top-bar search also answers "which hub serves this zone / area"
  (catalog zones and areas → `GET /zones` → the zone's hub, else the hub located in the zone; choosing one
  opens Hubs & zones filtered to it); the live chip shows the event stream's state (`DF.events.state`,
  "connection" events); the bell lists breached SLA alerts and open problem counts; keyboard: "/" search,
  F2 the scan box on screen, Esc closes the dialog then the drawer, and a Hub desk tab focuses its scan box
  when it opens.
- Shipment headings: one Export (CSV), the "Print…" select (invoices, labels, list; choosing prints the
  ticked rows, else the rows on screen) and one "Print labels" shortcut; "CN stock" opens CN stock.
- Stage pages have "Bulk update <page> by Excel" with the page's own template (`DFOps.bulkKindOf(view)` /
  `DFOps.bulkConfig(kind)` from bridge-bulk.js; tab presets such as Problems › Exceptions only narrow it);
  Transfers has none (see "Bulk operations by Excel").
- Browser tests: `opsNav(page, area)` and `OPS_NAV` in `apps/web/tests/e2e/support.ts`; `rowAction` /
  `headingAction` open "More" menus. With `E2E_API_ORIGIN`, file uploads are continued to that API
  (Chromium doesn't expose multipart file parts to route.fetch).

## Failed deliveries (parcels/parcel.views.ts, parcel-stages.ts; web: courier-operation/bridge-failed.js)
Read-only views on the existing lifecycle (2026-10-18). A rider's failed attempt writes a DeliveryAttempt
(FAILED, reason, nextAction) and moves the parcel to RETRY_SCHEDULED or back to a hub (AT_HUB).
- Parcel views (`GET /parcels`, `GET /parcels/:id`, every `parcelView`): `attemptCount`, `failedAttempts`,
  `lastFailedAttempt { reason, at, nextAction, riderName }`, `returnedAfterFailure` (AT_HUB /
  READY_FOR_COLLECTION and the latest attempt failed) and, for staff, `attempts[]` (date, outcome, reason,
  next step, note, rider). Attempts load with `parcelInclude` (one batched query per page, no N+1).
  Merchants and riders get the same fields without `riderName` and `attempts`.
- Lists: `stage=failed` / `failedAttempts=true` = RETRY_SCHEDULED + `BACK_AFTER_FAILURE` (AT_HUB /
  READY_FOR_COLLECTION with a failed attempt); `problems` includes them; `failedBefore=true|false`.
  Stage counts: `detail.failed`, `detail.backAfterFailure`; `stages.problems` includes them.
- Courier Operations: "Failed ×N · <last reason>" red pill (`[data-failed-badge]`) in every parcel table's
  status cell and the drawer header; the drawer's "Delivery attempts" section (`#drawerAttempts`);
  Problems › Failed delivery adds ATTEMPTS and LAST FAILURE columns; Delivery › Waiting for a delivery rider
  has a "Failed before" filter (`[data-list-failed]`). Next actions: "Re-attempt (Assign rider)" (the
  assign dialog → assign-delivery) and "Return to sender" (`[data-return-sender]`): an `Ops.form` with
  the reason (prefilled from the last failure, `#rtsReason`), a note (`#rtsNote`, saved as a staff note)
  and "Add to a return run now" (`#rtsRun`: no → `POST /parcels/:id/status` RETURN_SCHEDULED; new →
  `POST /returns/runs`; an open run → `POST /returns/runs/:id/parcels`), then a result dialog with "Open
  Returns". Merchant panels: "Delivery failed ×N, back at <hub> · Last reason" in the parcel detail
  (`[data-df-failure]`). Rider run sheets flag re-attempts ("Re-attempt · failed ×N before").
- Returns: `POST /returns/runs/:id/parcels { trackingIds, reason? }` (parcel:dispatch; planned runs of the
  parcels' merchant; the same checks and RETURN_SCHEDULED step as a new run; audit `return_run.add_parcels`).
  A new run or an added parcel may also be RETURN_SCHEDULED without a run (exception "return" resolution,
  "Return to sender" without a run): it joins the run without a status change (internal tracking event
  "Added to return run RR-…"). `GET /returns?stage=requested` includes those parcels, so they wait on the
  Returns page until a run is planned.

## Linehaul receiving by scan (modules/linehaul, web: courier-operation/bridge-linehaul.js, bridge-intake.js)
- `POST /linehaul/receive-scan { hubId, code, source, tripId?, bagId?, sealNo? }` (parcel:dispatch, the
  receiving hub in scope; never throws for what was scanned) → `{ outcome, ok, message, code, hub, parcel,
  bag (bag view with items and totals), trip (inbound view) }`. Outcomes: a bag label `BG-…` → `BAG_RECEIVED`
  (the whole bag, `receive()` without trackingIds: parcels not yet scanned out of it become AT_HUB here;
  seal mismatch recorded), `ALREADY_RECEIVED`, `WRONG_HUB`, `NOT_IN_TRANSIT`; a manifest `MF-…` → `TRIP` (the
  trip to check); a tracking ID LOADED in an IN_TRANSIT bag to this hub → `RECEIVED` (item RECEIVED, parcel
  IN_TRANSIT → AT_HUB through `transition`, BAG_RECEIVE scan, audit `linehaul.item_receive`; the bag becomes
  RECEIVED with its last parcel, the trip ARRIVED with its last bag); in a bag for another hub → `WRONG_HUB`;
  on no inbound manifest → `EXTRA` (one open EXTRA discrepancy per parcel / hub / trip / bag being checked,
  audit `linehaul.extra_scan`; the parcel is not moved); unknown → `NOT_FOUND`. Finishing a bag (the rest
  missing): `POST /linehaul/bags/:bag/receive { hubId, trackingIds: [] }`.
- `GET /linehaul/inbound?hubId=&status=` (hub:read; hub operators their hubs) → trips to my hubs (planned,
  departed, arrived; closed in the last two days) with bags and `expected / received / missing / pending`
  per bag and trip, plus totals.
- Hub desk → Receive (`POST /ops/hub-receive`) hands bag / manifest codes and parcels LOADED in an inbound bag to
  `receiveScan` (outcomes above; `transfer: { bag, trip }` in the answer), so a bagged parcel received at the
  desk is also checked off its bag.
- Web: Transfers → "Receive transfers" (scan box `#lhRecvScan` with the shared scan feedback, receiving hub,
  arrival seal, the trip / bag being checked with expected vs received, "Finish … → missing", last scans) and
  "Inbound transfers" (`#lhInbound`, "Check" selects the trip). Bag tags and manifests carry Code 128 of the
  bag / manifest number (the manifest also every bag's barcode), which this scan accepts.

## Printed documents / PDFs (modules/documents, web: public/legacy/shared/print.js)
Every print button opens a PDF generated by the API in a new tab; there is no `window.print` HTML printing left.
- Writer: pdfkit (fontkit shaping) with bundled Noto Sans + Noto Sans Bengali (`apps/api/assets/fonts`, OFL; the
  Dockerfile copies them; `DOCUMENT_FONTS_DIR` overrides). Text is split into Bangla / other runs per font, so Bangla
  names and addresses render with conjuncts. Code 128 (`pdf/code128.ts`) for tracking IDs, CNs, bags and manifests;
  QR codes link to `APP_URL/track/:id`. Header: brand (`notification-settings.brand`: appName, support), finance
  seller (name, address, BIN), website; date in Asia/Dhaka; "Page x of y". Exception (2026-10-18): the "4 invoices
  · A4" / "8 invoices · A4" layouts (`a4-4`, `a4-8`) have no page header or footer (the sheets are cut after
  printing): an even grid of invoice cells with the same margin all round, each cell with the company name.
- Endpoints (all `application/pdf` inline with a filename; audited `document.generate`):
  `GET|POST /documents/labels {ids|batchId, format: a4|thermal}` (max 2,000; streamed),
  `GET|POST /documents/invoices {ids|batchId, layout: a4|a4-4|a4-8|pos, line: all|ecommerce|document|customer}` (max 1,000),
  `GET|POST /documents/parcel-list {ids|batchId, title?}` (max 5,000) — staff with parcel:read:any (hub operators: their
  hubs' parcels), merchants / API keys (`parcels:read`) their own, customers theirs; unknown or out-of-scope IDs are
  left out (`X-Missing-Count`, `X-Missing`), none found → 404, too many → 422 `TOO_MANY_PARCELS`.
  `GET /documents/manifest/:trip`, `/bag-label/:bag` (hub:read, trip/bag hub scope), `/run-sheet/:rider?date=`
  (parcel:read:any + rider:read; the rider's assignments that day, route-plan order; nothing → 422 `NOTHING_TO_PRINT`),
  `GET|POST /documents/cn-sheet/:batchId {cns?}` (parcel:dispatch; counts the print like `/cn/batches/:id/print`),
  `/return-run/:id` (parcel:dispatch), `/finance-invoice/:id`, `/settlement/:id` (finance:read; merchants their own),
  `/statement?from&to&line` (merchant owners: delivered prepaid parcels not yet invoiced), `/report/:runId`,
  `/sla-report?from&to&hubId` (parcel:read:any), `/hub-reconciliation?hubId&date` (hub:read + parcel:read:any;
  hub operators their own hubs; audited with the hub as entity).
- Web: `DFPrint.open(path, opts)`, `DFPrint.parcels(kind, ids, params)`, `DFPrint.format(selectValue, ids)` (the panels'
  "All invoices · A4", "E-commerce invoices · A4", "4 invoices · A4", "Invoice · POS 80mm", "Shipment labels", "Order list"
  options). The tab opens inside the click (pop-up blockers), shows "Preparing…", then the PDF in the browser viewer with a
  Download link keeping the file name; errors show in the tab and as a toast. Courier Operations prints the ticked rows,
  else the rows the table shows (`DFOps.printIds()`).
- Browser tests: `openPdf(page, action)` in `tests/e2e/support.ts`; API tests read PDFs with `test/pdf-text.ts`.

## Dashboard periods (common/period.ts; web: public/legacy/shared/period.js)
One period filter on every overview (2026-10-18): Today · Yesterday · This week · Last 7 days · This month ·
Last month · Custom range. Asia/Dhaka calendar days (UTC+6); weeks start on Saturday.
- API: `?from=YYYY-MM-DD&to=YYYY-MM-DD` (inclusive Dhaka days; both or neither; from ≤ to; at most 366 days;
  422 otherwise) on `GET /ops/overview` (`period`, `metrics`; default today), `GET /ops/stage-counts`
  (`metrics` only when sent, same `forHubIds` scope as the counts), `GET /ops/analytics` (`period` value per
  row, `samples.period`; default today), `GET /merchants/me/stats` (`range`: booked, delivered, returned,
  cancelled, picked up, COD value, charges, success rate, `money` for owners = COD collected / payable / paid
  out, and `series` by hour (1 day) / day (≤ 92 days) / month; default this month), `GET /finance/summary`
  (`period`: COD collected, cash received at hubs, settled, invoiced, delivery charges; default this month),
  `GET /analytics/traffic` (from / to instead of `days`: daily rows, `period` / `previousPeriod` totals,
  hourly = that day's hours for one day, else the last 24 h) and `GET /admin/overview` (`period`: bookings,
  COD, charges, GMV, delivered, new / approved / active merchants, audit events, per-merchant and per-rider
  counts, bookings `series`; default this month). Every period block carries `previous` (the same number of
  days just before). Helpers: `periodQuerySchema` / `periodQueryShape` + `periodChecks`, `resolvePeriod(query,
  defaultPreset)`, `periodBuckets` + `fillSeries`; ops figures in `modules/ops/period-metrics.ts`. Range
  queries use the indexes from migration `dashboard_period_indexes` (parcels createdAt / deliveredAt /
  pickedUpAt / merchantId+deliveredAt, cod_collections collectedAt, merchant_settlements status+paidAt).
- Web: `DF.period.control(page, { defaultKey, onChange })` → `activate()` (URL when this page owns it, else
  localStorage `deliveryfast-period:<page>`, else the default), `mount(container)` (a `select-small` plus
  date pickers and Apply for a custom range, `.df-period`), `query()`, `get()` ({ key, from, to, text:
  "This week · 17–18 Oct", words, versus }). URL: `?period=<key>` or `?period=custom&from=…&to=…`; the
  page that last showed its period owns the URL's period (moving between pages never carries it across).
- Pages: Courier Operations Today (metrics row; stage cards and the "Live now" line stay live), COD &
  settlement, Reports › Analytics & SLA (`courier-operation/bridge-period.js`); both merchant overviews
  (`shared/merchant-bridge.js`, the chart follows the period, "In transit" and the delivery overview are
  "now"); super admin Overview and Platform activity (`super-admin/bridge-period.js`). Browser tests:
  `tests/e2e/dashboard-periods.spec.ts`; API: `test/dashboard-periods.e2e.test.ts`.

## Merchant top search and parcel drawer (web: public/legacy/shared/merchant-parcel.js; API: parcels/parcel.views.ts)
Both merchant panels (2026-10-18), on the merchant view of `GET /parcels/:id` / `GET /parcels?q=` (merchant-scoped).
- Top search `#globalSearch` (Enter; "/" focuses it): tracking ID / CN, merchant order ref, recipient phone (any +880
  form → the last 10 digits) or name. One exact match opens the drawer, several show a pick list
  (`#merchantParcelMatches`, at most 20); nothing found → the original page-name shortcut or "No parcel found". Server:
  `q` matches phones only for phone-like text (digits, spaces, + - ( ), at least 4 digits), so "ORD-7" no longer matches
  every phone with a 7. Another merchant's parcel is never found (scope; a member of several workspaces sees the chosen one).
- Drawer `#merchantParcelDrawer` (`DFMerchantParcel.open(id)`, `.close()`, `.search(text)`, `.id`; window event
  `dfm:parcel { trackingId | null }`, which `shared/panel-nav.js` keeps as `?parcel=`). Opened from the search, the
  Orders / Shipments rows ("Details" `[data-dfm-open]` or a click on the row) and `?parcel=`. Sections: actions, Needs
  info, failed-delivery note (`[data-dfm-failure]`, no rider names / attempt list), live rider location
  (`[data-dfm-live]`, the existing `liveDelivery` rules; rider phone only via "Share rider phone" on the delivery day),
  recipient, shipment (product, weight, service, first / last mile, COD, product value), price lines, Hub Pickup,
  return, proof of delivery (no rider name or note), messages set to send (`service.messages`, names only), support
  ("Open a ticket about this parcel" → `DFSupport.compose`), status timeline (public events, no actor). Esc closes;
  it follows `parcel.updated` / `parcel.rider_location` and the panel's action toasts.
- Actions are the panel's existing ones: cancel while pending, request return, confirm return received, complete details,
  print label (PDF), download the shipment invoice (PDF, `DFPrint.invoices`).
- Merchant view (every non-staff `parcelView`): `service.messages` (stored per-parcel messages by name);
  `returnInfo.requestedBy` and `returnInfo.runId` are staff only (merchants get `returnInfo.onReturnRun`). Already staff
  only: internal events and event actors, `attempts`, `lastFailedAttempt.riderName`, `deliveryRider.phone`, `bookingBatch`.
  API test: `test/merchant-parcel-view.e2e.test.ts`; browser: `tests/e2e/merchant-drawer.spec.ts`.

## Page addresses (web: `DF.nav` in public/legacy/shared/api.js; courier-operation/bridge-nav.js, shared/panel-nav.js)
Every page and tab of every panel has its own URL (2026-10-18). One scheme: `/<panel>?page=<slug>[&tab=<slug>]`,
kebab-case slugs of the menu names (`&` → `and`). Opening the link opens that page / tab; navigating pushes a
history entry (Back / Forward work), redraws replace it; the title is "Page › Tab · Delivery Fast · Panel".
- Courier Operations: the views and tabs of "Courier Operations navigation", e.g. `?page=today`,
  `?page=hub-desk&tab=receive`, `?page=problems&tab=sla-late-risk`, `?page=all-parcels&tab=banking-and-financial`,
  `?page=cod-and-settlement`, `?page=support`, `?page=notifications`. Old names (`?page=Hubs`, `?page=Scheduled pickups`,
  `?page=Exceptions`…) still open their place and the address is rewritten to the slugs.
- Super admin: the menu's pages (`?page=registrations`, `?page=approval-center` (Approvals), `?page=global-notifications`
  (Platform settings), `?page=catalogs-and-locations` (Pricing & catalogs), `?page=e-commerce-merchants`…); tabs:
  `?page=import-settings&tab=customer|e-commerce|banking-and-financial`, `?page=service-plans&tab=customer|e-commerce|banking-and-financial`.
- Merchant panels: `?page=overview|orders|shipments|pickup-requests|customers|products|payments|billing|reports|api-and-webhooks|settings|support|notifications`.
- Rider app: `?page=overview|my-route|deliveries|pickup-queue|scan-parcel|earnings|performance|help-and-safety|settings|support|notifications`;
  Scan parcel's sections are tabs: `?page=scan-parcel&tab=pickup|handover|start|deliver|failed|return` (its `?scan=` link still works).
- Deep links: `?parcel=<tracking ID>` opens the parcel drawer (Courier Operations; merchant panels through
  `DFMerchantParcel`), kept in the address while the drawer is open; `?ticket=<number>` opens the support ticket
  (`DFSupport.open`, shared/support.js; website customers `/support/<number>`). Other parameters (`period`, `from`,
  `to`, filters) are kept. Signed-out visitors go to sign-in and come back to the same URL (path, query and hash).
- A panel connects with `DF.nav.start({ panel, home, pages, open, openParcel?, openTicket? })` and calls
  `DF.nav.entered(page, tab)` after drawing; `DF.nav.go(link)` opens a link of this panel in place (others load).
  Browser tests: `tests/e2e/panel-urls.spec.ts`.

## In-app notifications (modules/notifications: InboxService, in-app.ts; web: public/legacy/shared/notifications.js)
Per-user notifications behind the bell of every panel (2026-10-18; migration `user_notifications`, table
`user_notifications`: userId, type, title, body, link, readAt, createdAt; indexes (userId, id desc) and (userId, readAt)).
- API (signed-in user, own rows only): `GET /me/notifications?cursor=&limit=&unread=true` → `{ items, nextCursor, unread }`
  (newest first), `GET /me/notifications/count` → `{ unread }`, `POST /me/notifications/:id/read` (others' → 404),
  `POST /me/notifications/read-all`; both reads are audited. Live: `notification.created` / `notification.read` on
  `GET /events`, sent to the recipients only (`userIds`, with a staff permission nobody holds), once the rows are
  committed (InboxService checks for them shortly after the write, so a rolled-back change never rings).
- Writers: `InboxService.add(db, userIds, { type, title, body?, link? | target + panel? })`, `toStaff(db, { roles,
  hubIds?, except? }, item)`, `toMerchant(db, merchantId, item)`; links are built with `panelUrl(panel, { page, tab,
  parcel, ticket })` (the "Page addresses" scheme), per recipient's panel unless given.
- What writes them (the rule for the toggles):
  - NotifyService: an event sent with an explicit `to.userId` gets an in-app copy for that user when the event has an
    entry in `in-app.ts` and is switched on for at least one channel in super admin → Global notifications (the same
    per-event switch; package message choices apply too). A person's SMS / email opt-outs don't remove it. Events with
    codes (sign-in / sign-up / reset codes, delivery code, guest and email verification) never get one; copies never
    contain codes. Customers: their parcel updates, tickets, account security; riders: KYC, payouts, tickets;
    merchants: approval, KYC, payout account, settlements, invoices, claims, imports, tickets; staff: SLA breaches
    (operations managers and the hub's operators), support SLA escalations.
  - Merchant teams (owners and staff): their parcels' final outcomes — delivered, cancelled, return scheduled, returned
    (ParcelWorkflowService, the events' switches apply), linking to the merchant panel's parcel drawer.
  - Staff alerts (no SMS, always on): a new ticket or a requester's reply → the assignee, else support agents and
    operations managers; merchant registration, merchant KYC submitted and changes waiting for a second approver →
    super admins (not the maker); rider documents submitted → operations managers; a settlement drafted → finance
    (not the maker); a rider's cash handover request → that hub's operators.
- Web: the panel's own bell (`#notifications` / `#notificationButton`) shows the unread count in its
  `.notification-dot` (99+), a dropdown with the latest 8, "Mark all read" and "See all notifications"; clicking an item
  marks it read and opens its link through `DF.nav.go`. Notifications page `?page=notifications` (All / Unread, Mark all
  as read, Load more). Courier Operations adds its live "Operations alerts" (breached SLA, problem counts) as a section
  of the dropdown (`DFNotify.addSection`, courier-operation/bridge-desk.js). The website has no bell (customers' copies
  are stored for a future account inbox). API tests: `test/user-notifications.e2e.test.ts`.

## Merchant "Services & pricing" (merchants/merchant-plan.ts, merchant-plan.service.ts; web: public/legacy/shared/merchant-plan.js)

- `GET /merchants/me/plan` (owners and staff, `?merchantId=` for several workspaces): the merchant's package in plain
  words. `services` (the category's booking and
  entitlement services in merchant-facing sections, each `included` / `always` with a description and its price from the
  package), `messages` (parcel messages by stage with recipient, trigger and the SMS / email state from Global
  notifications, and `samples` — each event's SMS and email exactly as the current templates render them, with a
  sample tracking ID, the real `/track/…` link, the merchant's contact name in messages to the merchant and a customer
  name in messages to the recipient; support messages; account messages outside packages, `always` for security ones; products whose
  "Send SMS & email" is off), `prices` (route tiers, extra charges for included services, COD, failed deliveries and
  returns), `examples` (priced with `priceParcel`, the booking formula), `calculator` (choices the package offers and
  the districts), the package, its scheduled change and counts. The texts live in merchant-plan.ts (pure).
- Web: both merchant panels get a "Services & pricing" menu item before Settings (`?page=services-and-pricing`) with
  three tabs: Services (filter All / In your plan / Not in your plan; "Request this service" opens a prefilled support
  ticket), SMS & email ("See sample message" per message and "Show all samples": the SMS as a phone bubble, the
  email with its subject; on phones each message stacks), Pricing (calculator on `POST /merchants/me/quote`). Reloads on every visit and on
  `merchant.updated`. Tests: `test/merchant-plan.e2e.test.ts`, `tests/e2e/merchant-plan.spec.ts`.

## Website customer area is for customers only (web: shared/api.js `DF.auth.isWebsiteCustomer`, website/bridge.js)

- A website customer is an account with the CUSTOMER role whose home panel is `/account`. Accounts with a panel
  (merchant — including a merchant application under review — staff, rider) never use the customer area, even when
  they hold CUSTOMER from signing up: the customer session, parcels and addresses aren't loaded for them, and the
  customer pages (`account`, `orders`, `addresses`, `profile`, `request`) send them to their panel. Login and Sign up
  while signed in send anyone to their own panel (LoginView `useAlreadySignedIn`); another account needs a sign-out.
- After a merchant application the website re-reads the session (`DF.auth.refresh`, which now carries
  MERCHANT_OWNER) and opens the merchant panel, where the review banner shows the application's status
  (`DFWebsite.merchantApplied`; the "application received" view remains only as a fallback).

## Merchant account not active (API: MerchantsService.resolveOwn; web: shared/merchant-verification.js)

- A merchant that isn't ACTIVE (PENDING_REVIEW, INFO_REQUESTED, REJECTED, SUSPENDED) gets nothing but its own
  account. API: `resolveOwn` refuses every merchant self-service call with 403 `MERCHANT_NOT_ACTIVE`
  (`details.status`; message "isn't verified yet" / "suspended") unless the call opts in with `allowInactive`:
  `GET /merchants/me`, business verification (`GET /merchants/me/kyc`, upload, submit, view own file) and the review
  thread (`GET /merchants/me/review`, respond). Profile and payout changes, team, products, pickups, stats, quotes,
  API keys, `GET /merchants/me/plan` and `GET /packages/me` are refused; booking and imports were already refused.
  Helper: `merchantNotActive(status)` (merchants/merchant-status.ts).
- Web: both merchant panels become one screen, "Account verification" (`?page=verification`): no sidebar, search or
  bell; every page asked for (menu, address, `renderPage`) draws it. It states the status plainly ("Your account isn't
  verified yet" / "Action needed" / "Your application wasn't approved" / "suspended"), the steps to activation, the
  business verification documents (Upload / Replace / View per document, "Submit for review"; owners only; not
  offered when rejected or suspended), messages from Delivery Fast with the reply form when information was
  requested, and the business profile read-only (no inputs; corrections are made by Delivery Fast during review).
  Sign out on the screen. On `merchant.updated` it reloads; once ACTIVE the panel reloads into the full panel.
- Tests: `test/merchant-inactive.e2e.test.ts`, `test/merchant-plan.e2e.test.ts`, `tests/e2e/merchant-pending.spec.ts`.
