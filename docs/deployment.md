# Production deployment (PM2 + Apache)

How to run Delivery Fast on one Linux server (Ubuntu/Debian commands) with PM2 keeping the
processes alive and Apache in front for the domain and HTTPS. For Docker, see `docker-compose.yml`
and `docs/development.md`.

```
browser ──HTTPS──▶ Apache :443 ──▶ df-web (Next.js) :3000 ──/api/*──▶ df-api (NestJS) :4000
                                                                  df-worker (jobs, SMS, email)
                                         PostgreSQL :5432 · Redis :6379 (local only)
```

## 1. Requirements

| Software | Version | Used for |
|---|---|---|
| Node.js | 20.19 or newer | API, worker and web |
| PostgreSQL | 16 (14+ works) | main database; background jobs (pg-boss) also run on it |
| Redis | 7 (6+ works) | rate limits, OTP throttling, session revocation; the API won't start without it |
| PM2 | latest | keeps the three processes running |
| Apache | 2.4 | domain, HTTPS, reverse proxy |
| TLS certificate | certbot (Let's Encrypt) | **HTTPS is required**: the refresh cookie is `Secure` in production, so sign-in fails over plain HTTP |

```bash
sudo apt install postgresql redis-server apache2 certbot python3-certbot-apache
sudo npm i -g pm2
```

## 2. Database

```bash
sudo -u postgres psql
CREATE USER deliveryfast WITH PASSWORD 'strong-password';
CREATE DATABASE deliveryfast OWNER deliveryfast ENCODING 'UTF8';
\q
```

## 3. Code and environment

```bash
cd /var/www && git clone <repo-url> deliveryfast && cd deliveryfast
```

Create `apps/api/.env` (the API and the worker read it from their working directory):

```env
NODE_ENV=production
PORT=4000
APP_URL=https://yourdomain.com
CORS_ORIGINS=https://yourdomain.com
DATABASE_URL=postgresql://deliveryfast:strong-password@localhost:5432/deliveryfast
REDIS_URL=redis://localhost:6379
JWT_ACCESS_SECRET=<output of: openssl rand -base64 48>
ENCRYPTION_KEY=<output of: openssl rand -base64 32>
EXPOSE_DEV_OTP=false
TRUST_PROXY=true
RUN_WORKERS=false
FILE_STORAGE_DIR=/var/www/deliveryfast-files
# Optional: the address phones open "Scan with phone" links on (default APP_URL).
# SCAN_LINK_ORIGIN=https://app.example.com
# Optional: local AI that reads scanned labels (section 9). Unset = rules only.
SCAN_AI_URL=http://127.0.0.1:11434
LOG_LEVEL=info
```

- The API refuses to start with an invalid configuration and lists every problem
  (`apps/api/src/config/env.ts`).
- **Never change `ENCRYPTION_KEY` once set.** The SMS/email gateway keys are stored encrypted
  with it; a new key means entering them again in Integrations. Back it up somewhere safe.
- Keep `.env` out of git. Gateway keys (mram, Mailjet) never go in `.env` or code: they are entered
  in super admin → Integrations.

## 4. Build and migrate

```bash
npm ci                                            # installs dev dependencies too (needed to build)
API_ORIGIN=http://127.0.0.1:4000 npm run build    # shared + API + web
cd apps/api
npx prisma migrate deploy                         # creates / updates the tables
npm run db:seed:geo                               # first install only: Bangladesh districts, zones, areas, hubs
cd ../..
```

- `API_ORIGIN` must be set **at build time**: Next.js bakes the `/api` proxy target into the build.
- In production use only `prisma migrate deploy`. Never `migrate dev`, `migrate reset` or `db push`.
- `npm run db:seed` (demo data) and `db:seed:users` refuse to run in production.

The web build is a standalone server; copy its static files next to it:

```bash
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/
cp -r apps/web/public apps/web/.next/standalone/apps/web/
```

Legacy panel scripts are content-versioned and cached immutably by the browser. The public
website quietly prefetches them when the browser is idle (except on data-saver or slow 2G
connections); after a deploy, only changed scripts need a new download.

The website and panels share the **Delivery Fast** installable app (`/deliveryfast.webmanifest`).
The root-scoped service worker caches only static assets; the Rider panel keeps its separate
offline task/action queue service worker.

## 5. PM2

`ecosystem.config.js` in the repo root:

```js
module.exports = {
  apps: [
    // HTTP API (port 4000). Reads apps/api/.env.
    { name: "df-api", cwd: "./apps/api", script: "dist/main.js", env: { RUN_WORKERS: "false" } },
    // Background jobs: SMS, email, webhooks, schedules. Without it no SMS is sent.
    { name: "df-worker", cwd: "./apps/api", script: "dist/worker.js", env: { RUN_WORKERS: "true" } },
    // Website and every panel (port 3000), proxies /api/* to df-api.
    { name: "df-web", cwd: "./apps/web/.next/standalone/apps/web", script: "server.js",
      env: { NODE_ENV: "production", PORT: 3000, HOSTNAME: "127.0.0.1" } },
  ],
};
```

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup                                          # start PM2 again after a reboot (run the command it prints)
pm2 logs df-api                                      # logs
curl http://127.0.0.1:4000/api/v1/health/ready       # database + Redis should be ok
```

## 6. Apache

```bash
sudo a2enmod proxy proxy_http headers rewrite ssl
```

`/etc/apache2/sites-available/deliveryfast.conf`:

```apache
<VirtualHost *:80>
    ServerName yourdomain.com
    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "https"

    # Live updates (server-sent events): no buffering, long timeout
    <Location /api/v1/events>
        ProxyPass http://127.0.0.1:3000/api/v1/events flushpackets=on timeout=3600
        ProxyPassReverse http://127.0.0.1:3000/api/v1/events
        SetEnv no-gzip 1
    </Location>

    ProxyPass        / http://127.0.0.1:3000/
    ProxyPassReverse / http://127.0.0.1:3000/

    # Uploads: support tickets carry up to 5 files of 5 MB (~33 MB as JSON); Excel imports, photos: 40 MB
    LimitRequestBody 41943040
</VirtualHost>
```

```bash
sudo a2ensite deliveryfast && sudo systemctl reload apache2
sudo certbot --apache -d yourdomain.com              # adds the HTTPS virtual host
```

Apache sends everything to the web server; the web server proxies `/api/*` to the API, so the
browser stays on one origin and the API needs no public domain. Open only ports 80, 443 and 22 in
the firewall; 3000, 4000, 5432 and 6379 stay local.

## 7. Releasing a new version

```bash
git pull
npm ci
API_ORIGIN=http://127.0.0.1:4000 npm run build
(cd apps/api && npx prisma migrate deploy)
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/
cp -r apps/web/public apps/web/.next/standalone/apps/web/
pm2 reload all
```

## 8. After going live

- **First super admin.** The demo seeds refuse to run in production, so the first super admin
  account has to be created separately (there is no script for it yet). The super admin sets up
  two-step verification at first sign-in.
- **SMS and email.** Super admin → Integrations: enter the mram API key and Sender ID and the
  Mailjet key, secret and sender email; use **Send test**, then tick
  "Send through … in production". Messages go out only when `NODE_ENV=production`, the gateway is
  configured and enabled, and `df-worker` is running.
- **mram IP whitelist.** Add the server's public IP in the mram panel, or sends fail with 1016.
- **Backups.** A daily `pg_dump` (cron) of the database, plus the files in `FILE_STORAGE_DIR`.
- **Health.** `GET /api/v1/health/live` (process) and `/api/v1/health/ready` (database + Redis)
  for uptime monitoring.

## 9. Push notifications (merchant and rider apps)

The Android apps (`mobile/`) get the users' notifications as pushes through Firebase Cloud Messaging.

1. **Firebase key.** Super admin › SMS, Email & Push › **Push notifications**: choose the service
   account file (Firebase › Project settings › Service accounts › Generate new private key), tick
   **Send push notifications**, **Save**. The private key is stored encrypted with `ENCRYPTION_KEY`.
   Keep the downloaded file somewhere safe (not on the server, not in git).
2. **Merchants.** A merchant gets pushes when their service plan has **Firebase push notifications**
   (Service plans & pricing › Integrations). Riders always get them.
3. **Check.** On the same tab, **Send a test** to someone signed in on the app; the status card shows the
   phones registered and the last success / error.
4. Outgoing HTTPS to `oauth2.googleapis.com` and `fcm.googleapis.com` must be allowed.

`FIREBASE_SERVICE_ACCOUNT_FILE` in `apps/api/.env` (a path to the same file) is for development only; the
super admin setting takes precedence when it is on.

## 9a. Installing for another company (white label)

Super admin › **Branding & company** sets the company the platform runs for. No code changes are needed:
- the company name (it replaces "Delivery Fast" in headers, page and tab titles, SMS, emails and PDFs);
- the legal name, tagline and website;
- the logo (it replaces the pigeon mark) and the **browser tab icon**;
- the phone, email, address and opening hours;
- social links;
- the website's **About** page. The editor opens with the current text. It has headings, cards, number tiles and lists (the format is shown under the box). **Restore original About text** brings Delivery Fast's text back, with the new name in it. `/about` is read on every visit.

Pages pick up a change within a minute.

Not covered there:
- The SMS / email texts that name the company explicitly: check Parcel notifications and Global notifications.
- The "Name in messages" field under Global notifications, if it was changed by hand.
- The Android apps' names and icons, which are set when the apps are built (`mobile/`). Rebuild and sign them
  for the new company, with its own Firebase project (`google-services.json`) if push notifications are used.

## 10. Reading parcel photos ("Scan with phone")

Without any AI, the server reads photos with tesseract OCR: it turns the photo the right way up,
straightens it, reads it, and when the phone, name or amount is missing (tables, scattered labels) reads
it again word by word and fills in what's missing. Settings in `apps/api/.env`:

- `SCAN_OCR_LANGS=eng` (default): English labels, fastest. `eng+ben` also reads Bangla labels (about 40% slower).
- **Small servers (4 GB RAM, 2 cores):** use OCR only: don't install Ollama, leave `SCAN_AI_URL` unset. A
  photo then takes about 2–10 s for a clear label and up to ~40 s for a hard one (sideways, a table).
  The vision AI below needs about 3.5 GB of RAM on its own: on a 4 GB server it makes everything slow.
  It can run on another, bigger machine instead: point `SCAN_AI_URL` at that machine's Ollama.

### Local vision AI (8 GB RAM or more)

A local vision model reads each parcel photo itself (rotated, tables, Bangla, poor light) on this
server, with no external service: the photos never leave it. Tesseract OCR still runs first (it turns
the photo the right way up, and its text feeds the checks). Without the AI, OCR + rules alone fill the
rows: fine for clean printed labels, weak on real-world photos.

```bash
curl -fsSL https://ollama.com/install.sh | sh     # installs Ollama as a service on 127.0.0.1:11434
ollama pull qwen2.5vl:3b                          # ~3.2 GB; uses ~3.5 GB RAM while loaded
```

Then `SCAN_AI_URL=http://127.0.0.1:11434` in `apps/api/.env` and `pm2 reload df-worker` (the worker
reads the photos). Optional: `SCAN_AI_MODEL` (default `qwen2.5vl:3b`; a text-only model such as
`qwen2.5:3b` reads the OCR text instead of the photo), `SCAN_AI_TIMEOUT_MS` (default 600000 = 10
minutes; on a timeout the OCR + rules reading is kept).

- **Speed without a GPU:** about 1.5–3 minutes per photo, one photo at a time (rows show "Reading…";
  20 parcels take roughly 40 minutes). An NVIDIA GPU makes it a few seconds.
- **Memory:** 8 GB RAM is enough for the model next to PostgreSQL, Redis and the app. The model is
  unloaded after 30 minutes without photos.
- **Checks:** every answer is checked before use: a valid BD mobile, a plain amount, a name without
  digits, places from the service catalog. When the OCR also read the label well, the rules' amount
  wins (they catch ৳ read as a 5 or 8, a slip the models make too).
- The OCR language data folder is created next to `FILE_STORAGE_DIR` (e.g. `/var/www/tesseract`):
  the PM2 user needs write access to its parent the first time.


////////////////////////////////
Run step 0 on your PC; everything after it runs on the server.

**Step 0 — on your PC: commit and push (not done yet).** The latest photo-reading work (rotation, ৳ amounts, Bangla places, local AI) is uncommitted, so a pull on the server won't get it:
```bash
git add -A
git commit -m "Scan with phone: rotation, image cleanup, taka/Bangla parsing, local AI"
git push
```
The password line from `README.md` is already in a commit on GitHub. Change that password and remove it from the file.

---

**On the server** (as the user that runs PM2):

**1. Go to the app folder and back up the database**
```bash
cd /var/www/deliveryfast
pg_dump -U deliveryfast -h localhost deliveryfast > ~/backup-$(date +%F-%H%M).sql
```

**2. Get the new code**
```bash
git pull
```

**3. Install packages** (includes the OCR and image-cleanup packages)
```bash
npm ci
```

**4. Build**
```bash
API_ORIGIN=http://127.0.0.1:4000 npm run build
```

**5. Update the database** (adds the scan tables if this server doesn't have them yet; otherwise it does nothing)
```bash
(cd apps/api && npx prisma migrate deploy)
```

**6. Copy the web's static files**
```bash
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/
cp -r apps/web/public apps/web/.next/standalone/apps/web/
```

**7. OCR language folder** (first time only; it goes next to `FILE_STORAGE_DIR`, e.g. `/var/www/tesseract`)
```bash
sudo mkdir -p /var/www/tesseract
sudo chown $(whoami) /var/www/tesseract
```

**8. Local AI: skip it on a 4 GB / 2-core server.** The vision model needs ~3.5 GB RAM by itself; OCR alone
reads the photos there (section 9). Make sure `apps/api/.env` has **no** `SCAN_AI_URL` line, and if Ollama was
installed earlier, stop it:
```bash
sudo systemctl disable --now ollama
```
(On a server with 8 GB+ RAM: `curl -fsSL https://ollama.com/install.sh | sh`, `ollama pull qwen2.5vl:3b`, then
`SCAN_AI_URL=http://127.0.0.1:11434` in `apps/api/.env`.)

**9. Restart the app**
```bash
pm2 reload all
```

**10. Check**
```bash
curl http://127.0.0.1:4000/api/v1/health/ready   # should say ok
pm2 logs df-worker --lines 30                     # no errors
```
Then on the live site:
1. Open Courier Operations → New orders.
2. Press Ctrl+Shift+R once.
3. Click **Scan with phone**, scan the QR code with a phone, and take a photo of a label. A row should fill in after about 5–40 seconds (OCR only, 2 cores).

**If something breaks:**
1. Run `git log --oneline -5` and `git checkout <previous commit>`.
2. Repeat steps 3, 4 and 6, then `pm2 reload all`.

The new tables can stay. Restore the step 1 backup only if data itself is damaged.