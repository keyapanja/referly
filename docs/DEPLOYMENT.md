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

## Migrations

`packages/core/drizzle/*.sql` run automatically when the API starts (Drizzle migrator, tracked in `__drizzle_migrations`). To add one: change `packages/core/src/db/schema.ts`, then:

```bash
cd packages/core && npx drizzle-kit generate --name <change>
```

Commit the generated SQL. Never edit an applied migration.

## First run

1. Open `WEB_URL/signup` and create the first workspace; the owner gets a verification email.
2. Settings → Integrations → create an API key for your checkout.
3. Point your checkout webhook at `POST BASE_URL/v1/conversions` with `Authorization: Bearer rk_live_...`.

## Operations

- **Backups:** back up Postgres; nothing else is stateful.
- **Logs:** the API logs every request; sent emails appear in the message log (Messages page) with delivery status.
- **Jobs:** the `jobs` table is the queue. `status = 'dead'` rows exhausted their retries and need a look.
- **CI:** `.github/workflows/ci.yml` runs typecheck, tests and the web build on every push and PR. `docker.yml` publishes both images to GitHub Container Registry on pushes to `main` and on `v*` tags; set the repository variable `NEXT_PUBLIC_API_URL` to your API origin before relying on the web image.
