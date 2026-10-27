# Development guide

There are two ways to run Paira Express: everything in Docker (quickest), or the apps on your
machine for development.

## Option A: Docker (whole stack)
```bash
cp .env.docker.example .env.docker      # set POSTGRES_PASSWORD, JWT_ACCESS_SECRET, ENCRYPTION_KEY
docker compose --env-file .env.docker up -d --build
docker compose --env-file .env.docker run --rm seed    # optional: demo accounts and data
```
Open http://localhost:8080. The stack runs PostgreSQL 16, Redis 7, migrations, the API, a
background worker and the web app. It runs in production mode, so SMS codes aren't shown on
screen; read them with `docker compose logs -f api worker`. Data lives in Docker volumes
(`docker compose down -v` deletes it).

## Option B: development on your machine
Requirements:
- Node.js 20.19+ (22 LTS recommended).
- PostgreSQL 14+ with a UTF-8 database. The default `.env.example` expects database
  `pairaexpress`, user `pairaexpress`, password `pairaexpress` on `localhost:5432`, plus a
  `deliveryfast_test` database for the tests.
  - Without a PostgreSQL install, `npm run db:up` runs a private one on port 5433 instead;
    change the port in `apps/api/.env` and `.env.test`.
- Redis 3+ on `localhost:6379`. `docker run -d -p 6379:6379 redis:7-alpine` works.

```bash
npm install
cp apps/api/.env.example apps/api/.env   # then set JWT_ACCESS_SECRET and ENCRYPTION_KEY (commands are in the file)
npm run db:deploy -w @delivery-fast/api   # create the tables
npm run db:seed:geo -w @delivery-fast/api # Bangladesh districts/zones/areas, 30 hubs, delivery zones (config)
npm run db:seed:setup -w @delivery-fast/api # service plans, price cards, central hub (settings only; safe on a real install)
npm run db:seed -w @delivery-fast/api     # demo hubs, riders, merchants and one account per role
npm run dev:api                           # terminal 1: API on http://localhost:4000 (docs: /api/docs)
npm run dev                               # terminal 2: website and panels on http://localhost:3000
```

### Geography, hubs and data resets
- `npm run db:seed:geo` merges the whole country into the service catalog (Setting `catalog`):
  67 districts (the 64 districts, with Dhaka's city thanas under the operating districts Dhaka
  North / Central / South), 601 zones (494 upazilas + 107 city thanas) and ~4,900 areas (unions
  and city neighbourhoods); creates the 30-hub network (`src/seed/geo-bd.ts`) and one delivery
  zone per catalog zone with its serving hub. Idempotent; it never removes or reorders catalog
  entries and only fills empty hub fields. Data: `prisma/data/bd-geo.json`, built by
  `npm run db:build:geo -- <dir>` from [nuhil/bangladesh-geocode](https://github.com/nuhil/bangladesh-geocode)
  (MIT) plus the curated city zones in `prisma/data/bd-geo-metro.json`. Zone names shared by
  several districts carry the district, e.g. `Kaliganj (Gazipur)`; imports accept `Kaliganj`
  with the district given.
- Super admin → Shared catalogs & locations edits the geography afterwards (add, rename, deactivate,
  delete when unused; hubs in Courier Operations → Hubs & zones). Places deleted or renamed there are
  remembered (Setting `catalog-meta`), so running `db:seed:geo` again doesn't bring them back.
- A new company or demo installation: `db:deploy` → `db:seed:geo` → `db:seed:setup` → `db:seed:users -- --out <file>`
  (no sample parcels; `db:seed` is the older demo with one shared, documented password). Then super admin sets
  Branding & company, SMS, Email & Push gateways and reviews Service plans & pricing.
- `npm run db:seed:users -- --out <file outside the repo>` creates one demo account per role on
  that network (generated passwords, or `DEMO_PASSWORD_<GROUP>`), and writes the credentials
  table to the file. The super admin sets up two-step verification at first sign-in.
- `scripts/reset-data-keep-config.sql` deletes every user, merchant, parcel and all other data
  and keeps configuration (back up first; see the comments in the file).

### Demo accounts
Every seeded account uses the password `DeliveryFast2026`. Sign in at
`http://localhost:3000/#/login` and you're sent to your role's panel.

| Role | Sign in with |
|---|---|
| Super admin | admin@pairaexpress.example |
| Operations manager | ops@pairaexpress.example |
| Hub operator (Gulshan) | hub.gulshan@pairaexpress.example |
| Finance | finance@pairaexpress.example |
| Support | support@pairaexpress.example |
| Merchant owner, Northstar Store (e-commerce) | owner@northstar.example |
| Merchant owner, Meridian Bank PLC (documents) | ops@meridianbank.example |
| Rider R-2048 Jordan Rivera (also R-2029, R-2030, R-2041, R-2016, R-2051) | 01710002048 |
| Customer | customer@pairaexpress.example |

SMS codes (sign-up, SMS sign-in, password reset, delivery codes) are printed in the API log.
With `EXPOSE_DEV_OTP=true` (development only, refused in production) they also appear in the UI
as "Development code: …".

## Tests
```bash
npm test                                       # shared unit tests + all API e2e tests
cd apps/web && npx playwright test -c playwright.e2e.config.ts   # browser tests (API + web + seeded DB running)
npm run build -w @delivery-fast/web && npm run test:visual       # parity with design-reference/
```
Browser tests need only the seeded staff accounts (`*@pairaexpress.example`): each spec creates its
own temporary merchants, owners, staff, riders and customers (`apps/web/tests/e2e/support.ts`) and
deletes them afterwards with everything they produced. `E2E_API_ORIGIN=http://localhost:<port>` points
them at an API on another port than the web app's proxy target; `E2E_DATABASE_URL` at another database.
API tests use the `deliveryfast_test` database and Redis DB 1 (`apps/api/.env.test`) and empty
them between tests. Set `TEST_DATABASE_URL` / `TEST_REDIS_URL` to run suites in parallel, and
`TEST_LOGS=1` to see server errors.

## How the pieces fit
- **Auth.** Password (Argon2id) or SMS-code sign-in. Access tokens are 15-minute JWTs kept in
  memory by the browser. Refresh tokens are opaque httpOnly cookies that rotate on every use;
  reusing a rotated token revokes the whole session family. Five wrong passwords lock the
  account for 15 minutes. Sign-out, password change/reset and suspension revoke sessions at
  once (Redis denylist).
- **Access.** Roles (customer, merchant owner/staff, rider, hub operator, ops manager, finance,
  support, super admin) map to permissions in `packages/shared/src/roles.ts`. Merchant and hub
  roles are scoped to one merchant or hub. Lists and details only return what the caller may
  see, and return 404 for anything else.
- **Parcels.** Prices are always computed on the server from the active rate card. Tracking IDs
  are `PP-YYMMDD-NNNN` (daily sequence, Dhaka time). The lifecycle is enforced in one place, and
  only riders can mark a parcel delivered, with proof (recipient's SMS code, signature or photo)
  and the exact COD amount. Public tracking hides phone numbers and street addresses.
- **Money.** COD moves rider → hub (handover) → merchant (settlement with maker-checker approval).
  Prepaid deliveries are billed on monthly invoices.
- **Merchants.** Self-service API keys (`df_live_…`, shown once, stored hashed), signed webhooks
  (`X-DeliveryFast-Signature: t=<unix>,v1=<HMAC-SHA256 of "t.body">`) with retries, team members,
  and Idempotency-Key support on `POST /parcels`.
- **Background jobs.** pg-boss on PostgreSQL delivers SMS and webhooks with retries. In
  development they run inside the API (`RUN_WORKERS=true`).
- **Audit.** Every change is recorded in `audit_logs` (`GET /api/v1/audit-logs`).

## Going to production
Step-by-step server setup with PM2 and Apache: `docs/deployment.md`.

- **Secrets.** Set `NODE_ENV=production`, a strong `JWT_ACCESS_SECRET`, an `ENCRYPTION_KEY`,
  and `EXPOSE_DEV_OTP=false`. The API refuses to start with invalid configuration.
- **Migrations.** Run `npm run db:deploy -w @delivery-fast/api` on each release. Never run
  `db:seed` in production; it refuses to.
- **Workers.** Run API instances with `RUN_WORKERS=false` plus one or more `npm run worker`
  processes.
- **Proxy.** Behind a load balancer, set `TRUST_PROXY=true`. Serve over HTTPS, since the refresh
  cookie is `Secure` in production. Point the web app's `API_ORIGIN` at the API.
- **SMS / email gateways.** Configure them in super admin → Integrations (SMS: mram, email:
  Mailjet). Keys are stored encrypted with `ENCRYPTION_KEY` (keep it stable) and never in code,
  env files or git. Only production (`NODE_ENV=production`) sends through an enabled gateway;
  development and tests write messages to the log, except the "Send test" action. Templates,
  per-event switches and SMS/OTP limits are under super admin → Global notifications.
- **File storage.** Files go to local disk (`FILE_STORAGE_DIR`). For several instances, back
  `StorageService` with S3/R2.
- **Health.** `GET /api/v1/health/live` (liveness) and `/api/v1/health/ready` (database + Redis).





sudo -u postgres psql

//windows
& "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe" `
  -h localhost `
  -p 5432 `
  -U pairaexpress `
  -d pairaexpress `
  -F c `
  -f "$HOME\Downloads\pairaexpress.backup"



//ubuntu te 


CREATE USER pairaexpress WITH PASSWORD 'pairaexpress';
CREATE DATABASE pairaexpress OWNER pairaexpress;
\q


PGPASSWORD='pairaexpress' pg_restore \
  -h localhost \
  -p 5432 \
  -U pairaexpress \
  -d pairaexpress \
  --no-owner \
  --no-acl \
  --exit-on-error \
  /root/pairaexpress.backup

email

  418d3cc65e6ddc18f0ee89e4f72c1e52
5b57ef01ab0857e93b6b2d66f3bf1131