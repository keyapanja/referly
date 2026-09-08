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
| `EMAIL_PROVIDER` | api | `console`, `resend` or `smtp`. |
| `EMAIL_FROM` | api | Sender for resend/smtp. |
| `RESEND_API_KEY` | api | With `resend`. |
| `SMTP_URL` | api | With `smtp`, e.g. `smtp://user:pass@host:587`. |
| `NEXT_PUBLIC_API_URL` | web (build) | API origin the browser calls. Equal to `BASE_URL`. |
| `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD`, `PLATFORM_ADMIN_NAME` | api | Creates the platform admin account on boot if it does not exist (idempotent). Sign in at `WEB_URL/login`; admins land on `/admin`. |
| `PLATFORM_SUPPORT_EMAIL` | api | Shown to merchants on the Plan and usage card for plan changes. |
| `INTEGRATION_SECRET` | api | Key for encrypting merchants' payout-provider and Twilio credentials at rest (AES-256-GCM). Required in production; rotate by re-connecting providers. |
| `TEXT_FALLBACK` | api | What to do for workspaces with no Twilio account of their own: `console` (default outside production; prints texts to stdout), `none` (default in production; texts are skipped and logged as such) or `twilio` (a platform-wide account via `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_SMS`, `TWILIO_FROM_WHATSAPP`). |
| `STORAGE_PROVIDER` | api | `local` (default; files under `FILES_DIR`, served at `BASE_URL/files/...`) or `s3`. |
| `FILES_DIR` | api | Local storage directory. The Docker image uses `/app/data/files`; mount `/app/data`. |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_URL`, `S3_FORCE_PATH_STYLE` | api | With `s3`. Works with AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces. Objects are written public-read; `S3_PUBLIC_URL` is the origin (or CDN) they are served from. |

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

- **Backups:** back up Postgres, plus `FILES_DIR` (or the bucket) if merchants upload assets.
- **Logs:** the API logs every request; sent emails appear in the message log (Messages page) with delivery status.
- **Jobs:** the `jobs` table is the queue. `status = 'dead'` rows exhausted their retries and need a look.
- **CI:** `.github/workflows/ci.yml` runs typecheck, tests and the web build on every push and PR. `docker.yml` publishes both images to GitHub Container Registry on pushes to `main` and on `v*` tags; set the repository variable `NEXT_PUBLIC_API_URL` to your API origin before relying on the web image.
