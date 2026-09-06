# Affiliate Growth Platform (working name: Referly)

Multi-tenant affiliate marketing SaaS for expert-led businesses (coaches, consultants, course creators, workshop and event businesses). V1 is deterministic only: no generative AI anywhere in the stack.

Product contract: `Affiliate_Growth_Platform_PRD.docx`. Engineering plan and decisions: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

## Layout

```
packages/core   Domain model, Postgres schema (Drizzle), services, rule engines, tests
apps/api        Hono HTTP API: merchant API, public tracking/join endpoints, affiliate portal API, job worker
apps/web        Next.js merchant app (onboarding wizard, dashboard, affiliates, offers, programs, conversions,
                commissions, payouts, analytics, messages, settings), affiliate portal, public join/invite pages
docs/           Implementation plan
```

## Run locally

Requires Node 20+. No database install needed: without `DATABASE_URL` the API uses PGlite (embedded Postgres) persisted to `apps/api/.pglite`.

```bash
npm install
npm run dev:api          # API on http://localhost:4000 (also runs the job worker)
npm run dev:web          # Web on http://localhost:3000
```

Open http://localhost:3000/signup to run the guided onboarding. Emails are printed to the API console in dev.

Set `DATABASE_URL=postgres://...` to run against a real Postgres. Migrations in `packages/core/drizzle` apply automatically on boot.

### Environment variables (API)

| Variable | Purpose |
|---|---|
| `PORT`, `BASE_URL`, `WEB_URL` | API port, public API origin (tracking links), web app origin (join/invite/verify links) |
| `DATABASE_URL` | Postgres connection; omit for embedded PGlite (`PGLITE_DIR`, default `.pglite`) |
| `EMAIL_PROVIDER` | `console` (default), `resend`, or `smtp` |
| `RESEND_API_KEY`, `EMAIL_FROM` | for `resend` |
| `SMTP_URL`, `EMAIL_FROM` | for `smtp`, e.g. `smtp://user:pass@smtp.example.com:587` |

Public endpoints are rate limited per client IP (click redirect 300/min; join and invite 30 per 10 min; auth 30 per 15 min). Limits are in-process; use one API instance or put a shared store behind `lib/ratelimit.ts`.

```bash
npm test                 # core unit/integration tests + API end-to-end tests
npm run typecheck
```

## Deploy

Docker images for the API and web app, a `docker-compose.yml` with Postgres, and GitHub Actions for CI and image publishing are included. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Core concepts

- **Tenant isolation.** Every business-owned row carries `tenant_id`. Every service takes a `TenantContext` and scopes its own queries. Public endpoints resolve the tenant from opaque tokens (tracking link, join link, invite), never from user input.
- **Money.** Integer minor units and basis-point rates. Half-to-even rounding.
- **Attribution.** Coupon code and click-token candidates are evaluated against program rules (window, membership, offer eligibility, suspension). Every candidate, eligible or not, is stored on the attribution record with the reason.
- **Commission ledger.** Append-only entries (`credit`, `reversal`, `clawback`, `adjustment`, `payout`). Commission status never regresses after `paid`; refunds after payout become clawbacks that net against the next payout.
- **Events.** Every state change emits a domain event into the job table in the same transaction (transactional outbox). The worker turns events into templated emails and logs delivery.

## API sketch

| Area | Endpoints |
|---|---|
| Auth | `POST /v1/auth/signup`, `/login`, `/logout`, `/verify-email`, `/forgot-password`, `/reset-password` |
| Tenant | `GET/PATCH /v1/tenant`, `/me`, `/me/resend-verification`, `/team`, `/api-keys`, `/audit` |
| Assets | `GET/POST /v1/assets`, `POST /v1/assets/upload` (multipart, 25 MB, images/PDF/video), `PATCH /:id`, `PUT /:id/permissions` (scope to programs, offers, affiliates) |
| Offers | `GET/POST /v1/offers`, `PATCH /v1/offers/:id`, `POST /v1/offers/:id/status` |
| Programs | `GET/POST /v1/programs`, `PATCH /:id`, `POST /:id/status`, `POST /:id/offers` |
| Affiliates | `GET/POST /v1/affiliates`, `POST /invites`, `/:id/approve|reject|suspend|reactivate`, `/:id/coupons`, `/:id/programs/:programId/override` |
| Conversions | `POST /v1/conversions` (webhook/API/manual, idempotent), `GET /:id` (timeline), `POST /:id/refund|cancel|approve|dispute|reattribute` |
| Commissions | `GET /v1/commissions`, `POST /:id/approve|reverse`, `POST /adjustments`, `POST /settle` |
| Payouts | `GET/POST /v1/payouts`, `GET /payable/:affiliateId`, `POST /batch-all`, `POST /external`, `POST /:id/processing|paid|failed|cancel` |
| Public | `GET /r/:token` (click redirect), `GET/POST /join/:token[/apply]`, `GET/POST /invite/:token[/accept]` |
| Portal | `GET /portal/me|home|offers|links|codes|assets|conversions|commissions|earnings|payouts`, `POST /portal/links`, `PATCH /portal/profile`, `PUT /portal/payout-profile` |

Integrations authenticate with `Authorization: Bearer rk_live_...` (API key). Users authenticate with a session cookie or `Authorization: Bearer <session token>`.

### Conversion webhook example

```bash
curl -X POST http://localhost:4000/v1/conversions \
  -H "Authorization: Bearer rk_live_..." -H "content-type: application/json" \
  -d '{"externalOrderId":"ORDER-1001","offerId":"off_...","amountMinor":250000,"clickToken":"<ref param from redirect>","couponCode":"SAM20"}'
```

Repeating the call with the same `externalOrderId` returns the original record with `duplicate: true`.
