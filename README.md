# Affiliate Growth Platform (working name: Referly)

Multi-tenant affiliate marketing SaaS for expert-led businesses (coaches, consultants, course creators, workshop and event businesses). V1 is deterministic only: no generative AI anywhere in the stack.

Product contract: `Affiliate_Growth_Platform_PRD.docx`. Engineering plan and decisions: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

Operating the product end to end (setup, affiliates, tracking, sales, payouts, campaigns, and the rest) is covered in [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

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

Public endpoints are rate limited per client IP (click redirect 300/min; snippet events 600/min; join, invite and capture 30 per 10 min; auth 30 per 15 min). Limits are in-process; use one API instance or put a shared store behind `lib/ratelimit.ts`.

```bash
npm test                 # core unit/integration tests + API end-to-end tests (embedded PGlite)
npm run test:postgres    # the same suites against a real Postgres (embedded server, or TEST_DATABASE_URL)
npm run typecheck
```

## Leads (pay-per-lead)

Programs can pay a fixed amount per qualified lead alongside, or instead of, sale commissions. Leads arrive through `POST /v1/leads` (API key), the Leads page, or a per-program capture endpoint `POST /capture/<token>` that a form on your own site can post to (JSON or form fields; forward the `ref` query parameter from the landing page so the lead is attributed; add `redirect` for a thank-you page). Merchants qualify or disqualify leads on the Leads page; duplicates inside the program's dedupe window earn nothing. Affiliates see lead status and commission in the portal, never the contact details.

## Website tracking snippet

One script tag on the merchant's site records the whole affiliate journey: `GET /referly.js` keeps the `?ref=` click token in a first-party cookie, assigns a visitor id, reports page views and custom events to `POST /t/<siteKey>/events` (text/plain JSON, beacon-friendly, any origin but checked against the workspace's domain list), fills hidden inputs in lead forms, and can report orders from the thank-you page to `POST /t/<siteKey>/convert` when the workspace allows it (source `pixel`, same attribution and idempotency as every other sale). Server-side conversions may pass `visitorId` instead of a click token. Merchants see visits, outcomes and per-visitor timelines under Journeys and on each conversion. Workspaces on EU sites switch on consent mode: the snippet then stores and sends nothing until the page reports consent (Cookiebot and OneTrust recognised, or `referly('consent', 'granted')`), events during the banner are held in memory and flushed on grant or dropped on decline, and the API refuses unconsented batches.

## Notifications

Domain events reach people three ways: email (always, per the built-in rules and automation), SMS/WhatsApp (opt-in), and the in-app notification centre. The bell in the sidebar shows the unread count; the Notifications page lists them, links to the record and holds per-person category preferences. Merchant endpoints live under `/v1/notifications` (list, unread count, mark read, preferences); affiliates use `/portal/notifications`.

## Backups and data lifecycle

The worker takes an encrypted logical backup every day (database plus uploaded files) and rotates them; `npm run backup` takes one now, `npm run restore -- <key> --yes` restores it, and CI rehearses the restore on every push. Nightly retention prunes clicks, message logs, audit trail, webhook deliveries and automation history per workspace under an owner-adjustable policy; closed workspaces are purged after a grace period; affiliates can request erasure and owners can export everything as JSON lines. Details in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Deploy

Docker images for the API and web app, a `docker-compose.yml` with Postgres, and GitHub Actions for CI and image publishing are included. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the general picture, or [docs/COOLIFY.md](docs/COOLIFY.md) for a step-by-step Coolify install on a single VPS.

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
| Tenant | `GET/PATCH /v1/tenant`, `/me`, `/me/resend-verification`, `POST /me/password`, `/team`, `GET /api-keys/scopes`, `POST /api-keys` (scoped), `/audit` |
| Assets | `GET/POST /v1/assets`, `POST /v1/assets/upload` (multipart, 25 MB, images/PDF/video), `PATCH /:id`, `PUT /:id/permissions` (scope to programs, offers, affiliates) |
| Offers | `GET/POST /v1/offers`, `PATCH /v1/offers/:id`, `POST /v1/offers/:id/status` |
| Programs | `GET/POST /v1/programs`, `PATCH /:id`, `POST /:id/status`, `POST /:id/offers` |
| Affiliates | `GET/POST /v1/affiliates`, `POST /invites`, `/:id/approve|reject|suspend|reactivate`, `/:id/coupons`, `/:id/programs/:programId/override` |
| Conversions | `POST /v1/conversions` (webhook/API/manual, idempotent), `GET /:id` (timeline), `POST /:id/refund|cancel|approve|dispute|reattribute` |
| Commissions | `GET /v1/commissions`, `POST /:id/approve|reverse`, `POST /adjustments`, `POST /settle` |
| Payout providers | `GET /v1/tenant/integrations`, `POST/DELETE /v1/tenant/integrations/:provider` (stripe_connect, paypal); `POST /v1/payouts/:id/send`, `POST /v1/payouts/send-all`; portal `POST /portal/payouts/connect/stripe` |
| SMS / WhatsApp | `POST/DELETE /v1/tenant/integrations/twilio` (account SID, auth token, SMS and/or WhatsApp sender), `GET /v1/tenant/integrations/twilio/webhooks`; templates `GET /v1/messages/templates` (email + text channels), `PATCH /v1/messages/templates/:key?channel=text`; log `GET /v1/messages/log?channel=sms|whatsapp`; portal opt-in `PATCH /portal/profile` with `textChannel`, `textConsent`; Twilio callbacks `POST /hooks/twilio/:tenantId/status|inbound` (signature-checked) |
| Webhooks (outbound) | `GET /v1/webhooks/events`, `GET/POST /v1/webhooks`, `PATCH/DELETE /:id`, `POST /:id/test`, `POST /:id/rotate-secret`, `GET /:id/deliveries`, `POST /deliveries/:id/redeliver` |
| Disputes | `GET/POST /v1/disputes`, `GET /:id`, `POST /:id/comments`, `/:id/review`, `/:id/link`, `/:id/resolve`; portal `GET/POST /portal/disputes`, `GET /:id`, `POST /:id/comments`, `POST /:id/withdraw` |
| Groups | `GET/POST /v1/groups`, `PATCH/DELETE /:id`, `GET/POST /:id/members`, `DELETE /:id/members/:affiliateId` |
| Rate tiers | `GET/POST /v1/programs/:id/tiers`, `PATCH/DELETE /:id/tiers/:tierId` |
| Automation | `GET /v1/automation/catalog`, `GET/POST /v1/automation/rules`, `GET/PATCH /rules/:id`, `POST /rules/:id/enabled`, `GET /rules/:id/runs`; tasks `GET /v1/automation/tasks?status=open`, `POST /tasks/:id/done` |
| Campaigns | `GET/POST /v1/campaigns`, `GET/PATCH /:id`, `POST /:id/status`, `POST /:id/participants`, `DELETE /:id/participants/:affiliateId`, `PUT /:id/assets`; portal `GET /portal/campaigns`, `POST /portal/campaigns/:id/join`; `GET /v1/analytics/campaigns` |
| Billing | `GET /v1/tenant/billing` (plan, usage, limits, warnings) |
| Operations | `GET /health` (liveness), `GET /health/ready` (db, migrations, worker heartbeat), `GET /metrics` (Prometheus; `METRICS_TOKEN`), `GET /admin/ops` |
| Platform admin | `GET /admin/overview`, `GET /admin/tenants`, `GET/PATCH /admin/tenants/:id` (plan, custom limits, status), `GET /admin/jobs`, `POST /admin/jobs/:id/retry` |
| Reporting | `GET /v1/analytics/timeseries?from&to&granularity=day|week|month&compare=1`, `/compare`, `/funnel`, `/groups` (all accept `from`/`to`) |
| Exports | `POST /v1/analytics/exports` (async CSV: affiliates, conversions, commissions, payouts, ledger, clicks), `GET /v1/analytics/exports`, `GET /:id`, `GET /:id/download` |
| Payouts | `GET/POST /v1/payouts`, `GET /payable/:affiliateId`, `POST /batch-all`, `POST /external`, `POST /:id/processing|paid|failed|cancel` |
| Public | `GET /r/:token` (click redirect), `GET/POST /join/:token[/apply]`, `GET/POST /invite/:token[/accept]` |
| Portal | `GET /portal/me|home|offers|links|codes|assets|conversions|commissions|earnings|payouts`, `POST /portal/links`, `PATCH /portal/profile`, `PUT /portal/payout-profile`, `POST /portal/password` |

Integrations authenticate with `Authorization: Bearer rk_live_...` (API key). Users authenticate with a session cookie or `Authorization: Bearer <session token>`.

### Conversion webhook example

```bash
curl -X POST http://localhost:4000/v1/conversions \
  -H "Authorization: Bearer rk_live_..." -H "content-type: application/json" \
  -d '{"externalOrderId":"ORDER-1001","offerId":"off_...","amountMinor":250000,"clickToken":"<ref param from redirect>","couponCode":"SAM20"}'
```

Repeating the call with the same `externalOrderId` returns the original record with `duplicate: true`.
