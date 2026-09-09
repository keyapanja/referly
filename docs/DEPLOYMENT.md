# Deployment

Two processes and one database:

| Component | What it is | Needs |
|---|---|---|
| `api` | Hono API + job worker (emails, holding-period settlement). Applies migrations on boot. | Postgres, `BASE_URL`, `WEB_URL`, email settings |
| `web` | Next.js merchant app, affiliate portal, public join/invite pages | `NEXT_PUBLIC_API_URL` at build time |
| Postgres 14+ | Only datastore. PGlite (embedded) is for dev. | a volume or a hosted service |

Run exactly one `api` instance for now: the worker and the rate limiter are in-process.

## Option A: docker compose on one VM

```bash
cp .env.example .env         # set POSTGRES_PASSWORD, BASE_URL, WEB_URL, email
docker compose up -d --build
```

Web on port 3000, API on 4000, Postgres on an internal volume. Put a reverse proxy with TLS in front (Caddy example):

```
app.yourdomain.com {
  reverse_proxy localhost:3000
}
api.yourdomain.com {
  reverse_proxy localhost:4000
}
```

`BASE_URL` must be the public API origin: tracking links (`/r/<token>`) are served from it, and `cookieSecure` switches on automatically when it starts with `https`.

## Option B: managed hosting

- **Database:** Neon, Supabase, RDS or similar. Set `DATABASE_URL` on the API.
- **API:** any container host (Render, Railway, Fly.io, ECS). Image: `ghcr.io/<owner>/referly-api` from the Publish images workflow, or build `apps/api/Dockerfile`. Health check `GET /health` returns 503 when the database is unreachable.
- **Web:** Vercel works with the repo as-is (root directory `apps/web`, env `NEXT_PUBLIC_API_URL`). Or run the `referly-web` image anywhere; the API origin is baked in at build time, so rebuild when it changes.

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | api | Postgres connection string. Omit to use PGlite at `PGLITE_DIR` (dev only). |
| `BASE_URL` | api | Public API origin. Used for tracking links and secure-cookie detection. |
| `WEB_URL` | api | Public web origin. Used for CORS and for join, invite, verify and reset links in emails. |
| `PORT` | api, web | Listen port (4000 / 3000). |
| `EMAIL_PROVIDER` | api | `resend` or `smtp`. Required in production; `console` (the development default) prints one-time links to stdout. |
| `EMAIL_FROM` | api | Sender for resend/smtp. |
| `RESEND_API_KEY` | api | With `resend`. |
| `SMTP_URL` | api | With `smtp`, e.g. `smtp://user:pass@host:587`. |
| `NEXT_PUBLIC_API_URL` | web (build) | API origin the browser calls. Equal to `BASE_URL`. |
| `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD`, `PLATFORM_ADMIN_NAME` | api | Creates the platform admin account on boot if it does not exist (idempotent). Sign in at `WEB_URL/login`; admins land on `/admin`. |
| `PLATFORM_SUPPORT_EMAIL` | api | Shown to merchants on the Plan and usage card for plan changes. |
| `INTEGRATION_SECRET` | api | Key (16+ chars) for encrypting merchants' payout-provider and Twilio credentials and webhook signing secrets at rest (AES-256-GCM). The API refuses to start in production without it; rotate by re-connecting providers. |
| `BACKUP_KEY` | api | Encrypts backup archives (AES-256-GCM, key = SHA-256 of this value). Falls back to `INTEGRATION_SECRET`. Keep it with your other secrets; without it an archive cannot be restored. |
| `BACKUP_EVERY_HOURS`, `BACKUP_KEEP_DAYS`, `BACKUP_KEEP_WEEKS`, `BACKUP_INCLUDE_FILES` | api | Backup schedule (default every 24 h; `0` disables the schedule) and rotation (every backup for 14 days, then one per week for 8 weeks). `BACKUP_INCLUDE_FILES` bundles uploaded files into the archive: default `true` with local storage, `false` with S3 (use bucket versioning there). |
| `RETENTION_JOBS_DAYS`, `TENANT_PURGE_DAYS`, `RETENTION_MAINTENANCE_DAYS` | api | Platform retention: finished jobs to keep (30), days a closed workspace waits before it is purged (30), maintenance history to keep (365). Per-workspace retention is set in the app. |
| `LOG_LEVEL`, `LOG_FORMAT` | api | `debug`/`info`/`warn`/`error` (default `info`); `json` (default in production) or `pretty`. |
| `METRICS_TOKEN` | api | Bearer token for `GET /metrics`. Required in production; without it the endpoint returns 404. |
| `ERROR_REPORT_URL`, `ERROR_REPORT_TOKEN` | api | Optional sink for unhandled errors: one JSON POST per error (throttled to 30/min) with the request or job id, works with Slack incoming webhooks and most alerting services. |
| `TRUSTED_PROXY_HOPS` | api | Number of reverse proxies in front of the API (Caddy/nginx/a load balancer). Rate limits and click IP hashes use the socket address by default; set `1` (or more) so the right-most `X-Forwarded-For` entries from your proxies are used instead. Never trust a header a client can set. |
| `TEXT_FALLBACK` | api | What to do for workspaces with no Twilio account of their own: `console` (default outside production; prints texts to stdout), `none` (default in production; texts are skipped and logged as such) or `twilio` (a platform-wide account via `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_SMS`, `TWILIO_FROM_WHATSAPP`). |
| `STORAGE_PROVIDER` | api | `local` (default; files under `FILES_DIR`, served at `BASE_URL/files/...`) or `s3`. |
| `FILES_DIR` | api | Local storage directory. The Docker image uses `/app/data/files`; mount `/app/data`. |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_URL`, `S3_FORCE_PATH_STYLE` | api | With `s3`. Works with AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces. Objects are written public-read; `S3_PUBLIC_URL` is the origin (or CDN) they are served from. |

## Security model

- **Browser sessions** are httpOnly, SameSite=Lax cookies set by the API; the web app never keeps a token in script-readable storage, so the app and API must be same-site (`app.example.com` and `api.example.com`). Bearer tokens remain for API clients and the test suite.
- **API keys** carry explicit scopes chosen at creation (`conversions.write`, `read`, `payouts.write`, …). Workspace, billing, team, key and provider management are never available to a key. Keys of a suspended workspace stop working immediately.
- **Public join links** never log an existing account in: an application with a known email must present that account's password, and a re-application never demotes an active membership.
- **Outbound webhooks** may only target public hosts. Loopback, private, link-local (cloud metadata), unique-local and multicast addresses are refused at save time and again at send time after DNS resolution; redirects are not followed and response bodies are capped.
- **Uploaded files** are checked against their declared type by magic bytes, SVGs with script or event handlers are refused, and everything under `/files/*` is served with `X-Content-Type-Options: nosniff` and a sandboxed CSP; SVG and PDF are download-only because they share the API origin with the session cookie.
- **Request bodies** are capped (256 KB for JSON, the upload limit plus slack for `/v1/assets/upload`). Login and password reset are rate limited per address and per account. `X-Frame-Options`, `Referrer-Policy: no-referrer`, HSTS (when served over https) and no `X-Powered-By` are set on both apps.
- **Passwords** use scrypt with N=2^17; older hashes are upgraded on the next login. Users change their password from Settings (merchants) or Profile (affiliates); other sessions are signed out. One-time links (verify, reset, invite) are never stored in the message log. CSV exports neutralise spreadsheet formulas.
- Run `npm audit` before releases. The single known advisory is in `drizzle-kit`'s bundled esbuild, a development-only tool.

## Database security

Migration `0004_rls.sql` enables Postgres row-level security on every tenant table (with `FORCE`, so the application's own role is subject to it). The API opens one transaction per request and sets `app.tenant_id` once the caller's tenant is known; the worker scopes each job the same way. With no scope set, tenant tables read as empty and writes are rejected, so a missing filter in application code fails closed instead of leaking.

Superusers and `BYPASSRLS` roles ignore RLS, and the `postgres` Docker image makes `POSTGRES_USER` a superuser. The API handles this itself: migrations run as the connecting user, then if that user would bypass RLS the API creates a plain `referly_app` role, grants it the tables, and every pooled connection runs `SET ROLE referly_app`. If the connecting user is already a plain role (Neon, RDS, Supabase) it is used as is; `FORCE` makes the policies apply to table owners too. On boot the API checks the effective role and refuses to start if it would still bypass RLS.

## Testing against real Postgres

The default test run uses embedded PGlite. To run the same suites against a real server, where every test file gets its own database created and migrated from zero and dropped afterwards:

```bash
npm run test:postgres                                 # starts an embedded Postgres for the run
TEST_DATABASE_URL=postgres://user:pass@host/postgres npm run test:postgres   # or use your own server
```

The embedded server comes from the `embedded-postgres` dev dependency (real Postgres binaries). On Windows those binaries need the Microsoft Visual C++ 2015-2022 runtime installed. CI runs the suites and an API boot smoke against a `postgres:16` service on every push.

## Outbound webhooks (Zapier, Make, custom)

Merchants add endpoints under Webhooks. Every stored event of a subscribed type becomes a signed POST from the worker:

```
POST <endpoint>
content-type: application/json
x-referly-event: conversion.created
x-referly-delivery: whd_...        (unique; deduplicate on it)
x-referly-timestamp: 1725000000     (unix seconds)
x-referly-signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + raw body)>
```

Node verification:

```js
const crypto = require("crypto");
const expected = crypto.createHmac("sha256", SECRET).update(`${ts}.${rawBody}`).digest("hex");
const ok = crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig.slice(3), "hex"));
```

Respond 2xx within 10 s. Failures retry 8 times with exponential backoff (30 s doubling, capped at 1 h); after 5 exhausted deliveries in a row the endpoint is auto-paused and a task is created. Deliveries and responses are visible in the endpoint's log, with one-click redelivery. Zapier: "Webhooks by Zapier → Catch Hook". Make: "Custom webhook". Neither verifies signatures by default; the headers are there when you want to.

## SMS and WhatsApp (Twilio)

Email is always sent. Affiliates who opt in from their portal (channel, phone in E.164, explicit consent with a timestamp) also get a short text for approvals, sales, commissions, payouts, campaign invites, terms changes and dispute updates, rendered from the *SMS / WhatsApp* templates on the Messages page. Account emails (verify, password reset) never go by text.

Merchants connect their own Twilio account in Settings. Credentials are verified against the Twilio account endpoint and stored encrypted. An SMS sender (E.164 number or Messaging Service SID) and/or a WhatsApp-enabled sender decide which channels are available; an affiliate on a channel the account cannot serve is logged as skipped with the reason.

In the Twilio console, point the sender's messaging webhook at `BASE_URL/hooks/twilio/<tenantId>/inbound` and the status callback at `BASE_URL/hooks/twilio/<tenantId>/status` (both are shown in Settings once connected). Requests are accepted only with a valid `X-Twilio-Signature` for that workspace's auth token (or `TWILIO_AUTH_TOKEN` with the platform fallback). Inbound STOP/UNSUBSCRIBE opt the number out and START/UNSTOP opt it back in; status callbacks mark logs delivered, undelivered or failed.

WhatsApp: Meta requires business-initiated messages outside a 24-hour conversation to use an approved template. Register templates with Twilio whose text matches your *SMS / WhatsApp* templates; Twilio rejects unapproved free-form sends (error 63016), which shows on the message log. Automation rules can also send a custom text with the *Send an SMS/WhatsApp* action.

## Observability

- **Request ids.** Every response carries `x-request-id` (an incoming one from your proxy is kept). Every error body includes `requestId`, and every log line for that request carries it, so a user-reported id finds the whole story.
- **Logs** are one JSON object per line on stdout in production: `http_request` (method, route, status, ms, tenant, principal kind, ip), `job_done` / `job_failed` (job id, type, tenant, attempt, ms), `unhandled_error`, `worker_started`, `api_listening`. Credentials, tokens and signatures are redacted by field name. Ship stdout with your platform's log agent; no file rotation is needed.
- **Metrics** at `GET /metrics` in Prometheus text format, protected by `METRICS_TOKEN`: request counts and latency histograms by route and status class, job counts and durations by type and outcome, unhandled errors by origin, and gauges read from the database on every scrape: queue depth by status and type, queue lag (age of the oldest due job), stuck jobs, dead webhook deliveries, paused endpoints, failed messages, worker heartbeat age. Alert on `referly_jobs_lag_seconds > 300`, `referly_jobs_queue{status="dead"} > 0`, `referly_jobs_stuck > 0`, and `referly_worker_heartbeat_age_seconds > 60`.
- **Health.** `GET /health` is liveness (process up, database reachable). `GET /health/ready` also requires applied migrations and a worker poll in the last 60 s; point load balancers and the compose healthcheck at it.
- **Operations panel.** Platform admins see the same queue and delivery numbers on the admin overview, with dead jobs one click away for retry.
- **Errors.** Unhandled request and job errors are logged with their ids and, when `ERROR_REPORT_URL` is set, posted there. Uncaught exceptions are reported and the process exits so the supervisor restarts it.

## Backups, retention and data requests

**Backups.** The worker takes a logical backup on a schedule (`BACKUP_EVERY_HOURS`, default daily): every table, read in one consistent snapshot through the app's own connection (no `pg_dump` needed, so it works the same on managed Postgres and on the embedded database), plus every uploaded file when `BACKUP_INCLUDE_FILES` is on. The archive is JSON lines, gzip-compressed and encrypted with AES-256-GCM under `BACKUP_KEY`, written to the file store under `private/backups/<timestamp>.rbk` (the `FILES_DIR` volume or the S3 bucket). Rotation keeps every archive for `BACKUP_KEEP_DAYS`, then one per ISO week for `BACKUP_KEEP_WEEKS`. Each run is recorded in `maintenance_runs`; the admin overview shows the last backup, its size and contents, and lets you trigger one; `/metrics` exports `referly_backup_age_seconds{status}` and `referly_backup_size_bytes` (alert on age above `1.5 × BACKUP_EVERY_HOURS` or `status!="done"`). Failures are logged, reported to `ERROR_REPORT_URL`, and retried once. Archives are assembled in memory; for databases beyond a few gigabytes, run `pg_dump` from a cron job as well.

Keep a copy of the archives somewhere the API host cannot delete: replicate the bucket, or run `npm run backup -- save <key> <file>` from another machine on a schedule. Platform admins can also download an archive from the API (`GET /admin/maintenance/backups/<run id>/download`); it stays encrypted, so the download is safe to move around and useless without the key.

```bash
npm run backup                         # take one now; prints the storage key and row counts
npm run backup -- list                 # archives in the store
npm run backup -- verify <key|file>    # decrypt and summarise without touching a database
```

**Restore drill.** Restoring is destructive and only runs from the CLI with `--yes`. Point `DATABASE_URL` at the target (an empty database is fine: migrations run first, so an archive from an older release lands in the current schema and any columns the schema no longer has are dropped with a note), then:

```bash
DATABASE_URL=postgres://.../referly_restore npm run restore -- private/backups/2026-09-09T02-00-00-000Z.rbk --yes --files
```

`--files` also writes the archive's uploaded files back into the store. The command prints per-table counts, compares them with the archive, records a `restore` maintenance run, and exits non-zero on a mismatch. CI performs this drill on every push: it backs up the smoke-test database, restores into a fresh one, and checks the counts and a login against the restored copy. Do the same against your own backups periodically; a backup that has never been restored is a hope, not a backup.

**Retention.** Operational records age out; the books do not. Every night the worker prunes each workspace under its policy: raw clicks that no attribution points at (400 days by default), sent emails and texts (365), the audit trail (730), webhook deliveries in and out (90), automation run history (180), in-app notifications (180). Owners adjust these within bounds in Settings → Data and see how many rows the next run would remove. Conversions, commissions, ledger entries and payouts are never pruned. Platform-wide housekeeping in the same run: finished jobs older than `RETENTION_JOBS_DAYS`, expired sessions and one-time tokens, expired export files, and maintenance history older than `RETENTION_MAINTENANCE_DAYS`. The backup for the day is always taken before the prune.

**Closing a workspace.** A platform admin sets a workspace to `closed` (admin → workspace → Close workspace). Everyone in it is signed out immediately, and after `TENANT_PURGE_DAYS` the nightly job deletes every row and every file of that workspace and records a `purge` run. Reopening before then cancels the purge. The last backup taken before the purge is the only remaining copy.

**Data-subject requests.**
- *Access and portability:* an owner exports the whole workspace as JSON lines from Settings → Data (every table, credentials and hashes removed), built by the worker and downloadable for 7 days.
- *Erasure:* an affiliate asks from their portal profile, which creates a task for the team. A merchant with `affiliates.write` erases them from the affiliate page (`POST /v1/affiliates/:id/erase`): name, email, phone, company, channels, payout details, consent trail, notes and tags become placeholders, the portal login is disabled and its sessions dropped, message bodies to them and audit snapshots about them are blanked. Conversions, commissions, ledger entries and payouts stay under the anonymised affiliate id (accounting basis). Erasure is refused while commissions are still owed; pay, reverse or void them first. Backups taken before the erasure still contain the data until rotation removes them, which is why rotation is bounded.

## Migrations

`packages/core/drizzle/*.sql` run automatically when the API starts (Drizzle migrator, tracked in `__drizzle_migrations`). To add one: change `packages/core/src/db/schema.ts`, then:

```bash
cd packages/core && npx drizzle-kit generate --name <change>
```

Commit the generated SQL. Never edit an applied migration.

## Platform admin and plans

For local development the API also reads `apps/api/.env` (ignored by git) at startup, so you can keep the admin credentials there.

Set `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD` before the first boot. The admin area at `/admin` lists tenants with usage, lets you change a tenant's plan (`starter`, `growth`, `pro`, `enterprise`), set custom limits, suspend or reactivate a workspace, and retry dead jobs. Plan limits live in `packages/core/src/services/plans.ts`; no prices are in code.

## First run

1. Open `WEB_URL/signup` and create the first workspace; the owner gets a verification email.
2. Settings → Integrations → create an API key for your checkout.
3. Point your checkout webhook at `POST BASE_URL/v1/conversions` with `Authorization: Bearer rk_live_...`.

## Operations

- **Backups:** scheduled, encrypted, rotated and restorable from the CLI; see "Backups, retention and data requests" above. Keep an off-host copy of `private/backups/`.
- **Logs:** the API logs every request; sent emails appear in the message log (Messages page) with delivery status.
- **Jobs:** the `jobs` table is the queue. `status = 'dead'` rows exhausted their retries and need a look.
- **CI:** `.github/workflows/ci.yml` runs typecheck, tests and the web build on every push and PR. `docker.yml` publishes both images to GitHub Container Registry on pushes to `main` and on `v*` tags; set the repository variable `NEXT_PUBLIC_API_URL` to your API origin before relying on the web image.
