# Paira Express

npm workspaces monorepo:
- `apps/api` – NestJS 11 (Fastify) API, Prisma 7 + PostgreSQL, pg-boss jobs (on Postgres), Redis
  (rate limits, OTP throttling, session revocation). Swagger UI at `/api/docs`.
- `apps/web` – Next.js 16 frontend ported 1:1 from `design-reference/*.html`; the original page
  scripts run on API data through bridges (below).
- `packages/shared` – domain rules used by both: roles/permissions, parcel statuses and allowed
  transitions, pricing formula, zod schemas, BD phone handling. Build it before the apps
  (`npm run build:shared`; the root scripts do this).
- `design-reference/` – the original HTML, the visual source of truth. Don't edit it.

Setup and run instructions: `docs/development.md`.

## API conventions (apps/api/src)
- One folder per module in `modules/` (schemas → service → controller → module). `modules/network`
  is the simplest complete example; copy its style.
- Routes are private by default (global `AuthGuard`). Use `@Public()`, `@RequirePermissions(...)`
  (permissions come from `packages/shared/src/roles.ts`), `@AllowApiKey()` for merchant API keys.
- Validate with zod: `@ZBody(schema)` / `@ZQuery(schema)` plus `@ApiZodBody` / `@ApiZodQuery` for
  OpenAPI. Type params as `z.infer<typeof schema>`.
- Errors: throw `AppError(code, message, status)` (`common/errors.ts`). Every response error is
  `{ error: { code, message, details, requestId } }`.
- Every mutation writes `AuditService.record(...)`, inside the transaction when there is one.
- Parcel status changes go only through `ParcelWorkflowService.transition` (lifecycle rules,
  optimistic locking, tracking events, SMS, webhooks).
- SMS and webhooks: write with `OutboxService.queueSms` / `WebhooksService.emit` inside the
  transaction, then `flush` the ids after commit.
- Lists use UUIDv7 cursor pagination (`common/pagination.ts`). Money is `Decimal(12,2)` BDT.
- Merchants' and customers' money is Accounts (`modules/money`, schema `accounts.prisma`): a parcel
  posts its account lines when it becomes DELIVERED / RETURNED (`money/entries.ts`, called by
  `ParcelWorkflowService`); lines are never edited (adjustments, void). Rider COD → handover slip
  (HS-) → hub → hub transfer (HT-) → central hub (`accounts.config`, super admin) → settlement (ST-)
  for E-commerce merchants and customers; Financial merchants get bills (INV-) and payments (PAY-,
  partial, oldest bill first, credit). Rider pay and franchise money keep the ledger (`LedgerService`).
- Schema lives in `prisma/schema/*.prisma` (one file per area; `core.prisma` holds the original
  models). To change it: `node scripts/schema-lock.mjs acquire <you>` → edit →
  `node scripts/schema-lock.mjs migrate <name>` (writes and applies a migration, regenerates
  the client, refuses data-dropping changes) → `node scripts/schema-lock.mjs release`. Never
  run `prisma db push`, `migrate reset` or `migrate dev` against the shared dev database.
- Live updates: after a change commits, `RealtimeService.publish({ type, id, merchantId,
  customerId, riderIds, hubIds, userIds, staffPermission })` (`common/realtime.service.ts`).
  Parcel changes are published automatically by `ParcelWorkflowService`. Clients receive them
  on `GET /events` (SSE), filtered by `RealtimeService.canSee`.
- Geography (districts → zones → areas) is the service catalog, referenced by name everywhere:
  read it with `PricingService.catalog()` (active places only; `{ includeInactive: true }` for
  existing records), change it only through `modules/geography` (renames update every reference).
- Phone numbers: country code fixed (+880); accept 1XXXXXXXXX / 01XXXXXXXXX / +8801… via
  `phoneSchema` (packages/shared); store E.164.
- Addresses: the street field holds the **full address** as typed and is shown exactly so, everywhere
  (screens, PDFs, exports): `addressText(street, …places)` (`common/address.ts`; web: `DF.addressText`,
  `src/shared/addressText.ts`). District / zone / area are kept for operations and shown in their own
  columns, never appended. Address forms pick them from the typed address via `GET /catalog/place`
  (panels: `DF.autoPlace({ street, district, zone, area })` with the field ids; React:
  `usePlaceFromAddress`); the user can still change them.
- Numbered documents (`nextNumber` / `nextCounter`: PP, MR, HS, ST, INV…): list each prefix in
  `packages/shared/src/system-guide.ts` (super admin › System guide, `GET /guide`); `test/guide.e2e.test.ts`
  fails when the code makes a prefix the guide doesn't list.
- Tests are e2e against a real database (`apps/api/test`, helpers in `test/helpers.ts`).

## Web conventions (apps/web)
- `app/(<page>)/` – one route group per page, each with its own root layout so page CSS never
  leaks between pages. `/api/*` is proxied to the API (`next.config.ts`, `API_ORIGIN`).
- `src/features/<page>/` – `components/*.tsx` (markup), `styles.css` (verbatim, inlined into
  `<head>` because the CSS minifier changes declarations), `scripts.ts` (load order).
- `public/legacy/shared/api.js` – API client, session restore, panel role guards, and the
  in-memory storage shim the page scripts read. `public/legacy/<page>/bridge.js` – connects a
  page's actions to the API. See `public/legacy/README.md`.
- Live data in pages: `DF.live(["parcel.updated", "parcel.created"], reload)` (events + reconnect
  + slow safety poll) instead of fast polling. `DF.events.on(type, handler)` for custom use.
- Excel/CSV imports in every panel: `shared/importer.js` (`DFImport.open/history/template/complete`) on the
  one import engine (`modules/imports`, `/imports`); see docs/architecture-contracts.md. Downloads and
  uploads that aren't JSON: `DF.apiRaw(path, { method, body: FormData })`, `DF.download(path)`.
- Bulk operations by Excel in Courier Operations: `DFImport.bulk/bulkHistory` (the same dialog in bulk mode)
  on `modules/bulk-updates` (`/bulk-updates`: export with action columns → validate → apply through the
  parcel services); see docs/architecture-contracts.md.
- Forms in panels: `DF.phoneInput(input)` (fixed +880 prefix, 17…/017… accepted) and
  `DF.validate(form, { fieldId: value => message || "" })` for inline errors. Website forms
  are React components with the same rules.
- Markup is static and the legacy scripts change it by id/class. Keep ids, classes and element
  order they depend on, or move that behaviour into React first.
- Every JSX text node is a single string (`{" text "}` where whitespace matters).
- Every panel runs on the API: website (`website/bridge.js`), Courier Operations
  (`courier-operation/bridge.js`, `bridge-pages.js`), Rider (`rider/bridge.js`), both merchant
  panels (`shared/merchant-bridge.js` + per-panel `bridge.js`), super admin
  (`super-admin/bridge.js`) and support tickets on every page (`shared/support.js`). Super-admin
  platform settings are stored server-side (`GET/PUT /settings/platform-config`) and overlaid on
  the `pairaexpress-demo-config` key for every page. Widgets with no backing data (maps,
  traffic charts, some report rows) remain decorative.
- Money screens have their own design: Courier Operations › Accounts (`courier-operation/bridge-accounts.js`),
  merchant › Balance (`shared/merchant-balance.js`), rider › Earnings › My cash (`rider/bridge.js`),
  website customer › Payments (`website/customer-payments.js`).

## Commands (from repo root)
- Docker, whole stack: `docker compose --env-file .env.docker up -d --build` (web on :8080)
- Local dev: PostgreSQL on :5432 (see `docs/development.md`) · `npm run dev:api` · `npm run dev` (web)
- `npm test` – shared unit tests + API e2e tests
- `npx playwright test -c playwright.e2e.config.ts` (in apps/web) – full-stack browser tests;
  needs the API, web and a seeded database running
- `npm run build -w @paira-express/web && npm run test:visual` – pixel/DOM parity of the
  unchanged website views against `design-reference/`
