# Affiliate Growth Platform (working name: Referly)

Multi-tenant affiliate marketing SaaS for expert-led businesses (coaches, consultants, course creators, workshop and event businesses). V1 is deterministic only: no generative AI anywhere in the stack.

Product contract: `Affiliate_Growth_Platform_PRD.docx`. Engineering plan and decisions: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

## Layout

```
packages/core   Domain model, Postgres schema (Drizzle), services, rule engines, tests
apps/api        Hono HTTP API: merchant API, public tracking/join endpoints, affiliate portal API, job worker
apps/web        (next) Next.js merchant app + affiliate portal
docs/           Implementation plan
```

## Run locally

Requires Node 20+. No database install needed: without `DATABASE_URL` the API uses PGlite (embedded Postgres) persisted to `apps/api/.pglite`.

```bash
npm install
npm run dev:api          # http://localhost:4000
```

Set `DATABASE_URL=postgres://...` to run against a real Postgres. Migrations in `packages/core/drizzle` apply automatically on boot.

```bash
npm test                 # core unit/integration tests + API end-to-end tests
npm run typecheck
```

## Core concepts

- **Tenant isolation.** Every business-owned row carries `tenant_id`. Every service takes a `TenantContext` and scopes its own queries. Public endpoints resolve the tenant from opaque tokens (tracking link, join link, invite), never from user input.
- **Money.** Integer minor units and basis-point rates. Half-to-even rounding.
- **Attribution.** Coupon code and click-token candidates are evaluated against program rules (window, membership, offer eligibility, suspension). Every candidate, eligible or not, is stored on the attribution record with the reason.
- **Commission ledger.** Append-only entries (`credit`, `reversal`, `clawback`, `adjustment`, `payout`). Commission status never regresses after `paid`; refunds after payout become clawbacks that net against the next payout.
- **Events.** Every state change emits a domain event into the job table in the same transaction (transactional outbox). The worker turns events into templated emails and logs delivery.

## API sketch

| Area | Endpoints |
|---|---|
| Auth | `POST /v1/auth/signup`, `/login`, `/logout` |
| Tenant | `GET/PATCH /v1/tenant`, `/team`, `/api-keys`, `/audit` |
| Offers | `GET/POST /v1/offers`, `PATCH /v1/offers/:id`, `POST /v1/offers/:id/status` |
| Programs | `GET/POST /v1/programs`, `PATCH /:id`, `POST /:id/status`, `POST /:id/offers` |
| Affiliates | `GET/POST /v1/affiliates`, `POST /invites`, `/:id/approve|reject|suspend|reactivate`, `/:id/coupons`, `/:id/programs/:programId/override` |
| Conversions | `POST /v1/conversions` (webhook/API/manual, idempotent), `GET /:id` (timeline), `POST /:id/refund|cancel|approve|dispute|reattribute` |
| Commissions | `GET /v1/commissions`, `POST /:id/approve|reverse`, `POST /adjustments`, `POST /settle` |
| Payouts | `GET/POST /v1/payouts`, `GET /payable/:affiliateId`, `POST /batch-all`, `POST /external`, `POST /:id/processing|paid|failed|cancel` |
| Public | `GET /r/:token` (click redirect), `GET/POST /join/:token[/apply]`, `GET/POST /invite/:token[/accept]` |
| Portal | `GET /portal/me|home|offers|links|codes|conversions|commissions|earnings|payouts`, `POST /portal/links`, `PATCH /portal/profile`, `PUT /portal/payout-profile` |

Integrations authenticate with `Authorization: Bearer rk_live_...` (API key). Users authenticate with a session cookie or `Authorization: Bearer <session token>`.

### Conversion webhook example

```bash
curl -X POST http://localhost:4000/v1/conversions \
  -H "Authorization: Bearer rk_live_..." -H "content-type: application/json" \
  -d '{"externalOrderId":"ORDER-1001","offerId":"off_...","amountMinor":250000,"clickToken":"<ref param from redirect>","couponCode":"SAM20"}'
```

Repeating the call with the same `externalOrderId` returns the original record with `duplicate: true`.
