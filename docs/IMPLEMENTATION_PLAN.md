# Affiliate Growth Platform — Implementation Plan (V1)

Source of truth: `Affiliate_Growth_Platform_PRD.docx`. This document converts the PRD into an
engineering plan, records architecture decisions, and lists contradictions and open questions.

## 1. Stack decisions

| Area | Decision | Why |
|---|---|---|
| Language | TypeScript everywhere | One language across domain, API and web; strong typing for money and state machines |
| Repo | npm workspaces monorepo (`packages/core`, `apps/api`, `apps/web`) | Domain logic isolated from delivery layers, testable without HTTP |
| Database | PostgreSQL via Drizzle ORM. PGlite (embedded Postgres) for local dev and tests; `pg` driver for production | Real Postgres semantics locally with zero install; identical schema in prod |
| API | Hono on Node | Small, fast handlers; easy to test in-process |
| Web | Next.js (merchant app + affiliate portal), added after core and API are stable | Matches PRD build order: source-of-truth entities before dashboards |
| Validation | Zod at every boundary (HTTP, webhooks, automation rule definitions) | Explicit contracts |
| Money | Integer minor units + ISO currency code | No floating-point commission drift; deterministic rounding |
| IDs | Prefixed opaque IDs (`ten_`, `aff_`, `cnv_`) generated with nanoid | Opaque public identifiers for public pages (PRD s15) and readable logs |
| Jobs | DB-backed job table + worker loop (no Redis in V1) | PRD needs background jobs; keeps infra to one datastore |
| Email | Provider adapter interface; log adapter in dev, SMTP/API adapter in prod | PRD s14 P0 and s24 adapter guidance |
| AI | None. No AI dependency is allowed in the dependency tree for V1 | PRD hard constraint |

## 2. Tenant isolation strategy

1. Every business-owned table carries a non-null `tenant_id` column (denormalised even where a parent already scopes it) so every query filters on it directly and composite unique constraints include it.
2. All data access goes through a `TenantContext`. Service functions take the context as their first argument and add the tenant filter themselves. No unscoped query API is exposed to the delivery layer.
3. Cross-tenant access exists only for the `platform_admin` role through a separate, explicitly named `PlatformContext`.
4. Public endpoints (click redirect, application page, invite acceptance) resolve the tenant from an opaque token or domain mapping, never from a user-supplied tenant ID.
5. Postgres row-level security is planned as a second layer once the app runs on hosted Postgres; the code layer is designed so RLS can be enabled without changes.
6. The test suite includes cross-tenant access fixtures (PRD s24) that must fail closed.

## 3. Domain model (Phase 1)

All timestamps are UTC. All amounts are integer minor units.

- **Tenant**: slug unique, status, currency, timezone, plan. Owns everything below.
- **User**: belongs to a tenant with a role `owner | admin | marketing | readonly | affiliate | platform_admin`.
- **Offer**: type, price, currency, sales URL, status `draft | active | paused | archived`.
- **Program**: commission model (`percentage | fixed`), basis (`gross | net | eligible`), attribution window days, holding days, approval mode (`manual | auto | invite_only`), refund policy (`full | partial | none`), precedence (`coupon_wins | link_wins`), attribution model (`last_touch | first_touch`), terms version and text, status.
- **ProgramOffer**: join with optional commission override.
- **Affiliate**: profile, status `applied | active | suspended | rejected`, tags, payout profile reference.
- **AffiliateProgram**: membership with accepted terms version and timestamp, optional custom commission.
- **TrackingLink**: unique per affiliate + program + offer, opaque token, destination URL.
- **CouponCode**: unique per tenant, belongs to affiliate + program (+ optional offer).
- **Click**: one row per tracked click, references link, stores consent state and limited context.
- **Conversion**: unique on `(tenant_id, source, external_order_id)` for idempotency; amount, net amount, refunded amount, status `pending | approved | refunded | cancelled | reversed | disputed`.
- **Attribution**: one per conversion; records the affiliate, the rule applied, and the evidence (click id or coupon id).
- **Commission**: one per conversion; status `pending | approved | payable | paid | reversed | void`; `payable_at` computed from holding period.
- **LedgerEntry**: append-only; `credit | debit | reversal | adjustment | payout`. Every money-affecting change writes an entry.
- **Payout**: batch per affiliate, `draft | processing | paid | failed | cancelled`, links to the commissions it covers.
- **Asset**, **AssetPermission**: library plus scoping to program/offer/affiliate.
- **MessageTemplate**, **MessageLog**: templates with variables, delivery log.
- **AutomationRule**, **AutomationRun**: trigger/conditions/actions and execution log.
- **AuditLog**: actor, entity, action, before/after, reason.
- **Job**: background work queue.

## 4. Core rule engines

### Attribution (PRD s11)
Input: conversion candidate (tenant, offer, occurred_at, optional click token, optional coupon code).
1. If a coupon code resolves to an active affiliate and a program eligible for the offer, that is candidate A (rule `coupon`).
2. If a click token is present, find the latest click within the program's attribution window from an active affiliate whose program includes the offer. That is candidate B (rule `last_click`). Suspended affiliates are excluded.
3. If both exist, program precedence decides (`coupon_wins` by default).
4. The result is stored on the Attribution row with `rule_applied` and evidence IDs so operators can see why.
5. No candidate means the conversion is recorded as unattributed with no commission.

### Commission (PRD s12)
- amount = round_half_even(basis_amount x rate) or a fixed amount. Basis is gross, net, or a merchant-supplied eligible amount. Per-affiliate and per-program-offer overrides take precedence over program defaults.
- Created as `pending` with `payable_at = occurred_at + holding_days`.
- Transitions are enforced by a state table; illegal transitions throw.
- Refund policy `full` reverses entirely; `partial` reduces proportionally with a reversal ledger entry; `none` leaves it.
- Refund after `paid` creates a negative ledger adjustment that reduces the next payable balance (PRD s22).

### Payouts
Payable balance = sum of payable commissions + approved adjustments - paid - reversals. A batch snapshots the commissions it covers; marking it paid moves those commissions to `paid` in one transaction.

## 5. Build order (mirrors PRD s24)

1. Core package: schema, tenant context, state machines, attribution + commission + ledger services, job queue. Tests for multi-affiliate attribution, refunds, duplicate webhooks, cross-tenant access. **Done.**
2. API: auth (email + password, sessions, API keys), onboarding, offers, programs, affiliates, invitations, links, click redirect, conversions webhook with idempotency, commissions, payouts, audit. **Done.**
3. Notifications: template rendering with safe variables, email adapter (console/Resend/SMTP), message log, event-driven worker. **Done.** Asset library with program/offer/affiliate scoping, merchant and portal UI. **Done.**
4. Web: merchant onboarding flow, merchant app, affiliate portal, public join/invite pages. **Done.**
5. Dashboards and CSV export (synchronous, small datasets). **Done.** Email verification, password reset, per-IP rate limiting on public endpoints. **Done.** Asset file uploads (local or S3-compatible storage) and async CSV exports built by the worker and stored privately. **Done.** Postgres row-level security with per-request transactions and per-job scoping. **Done.** Platform admin surface (tenants, plans, custom limits, suspension, dead-job retry) and plan limits with usage metering. **Done.** Phase 1 is complete; payment collection (Stripe Billing) is deliberately deferred until pricing is validated (PRD s19).

### Phase 2 progress

- **Campaigns (AST-03..05, AN-05). Done.** Time-bound promotions per program with an optional commission override (highest precedence while live), a once-per-affiliate bonus on a conversions or revenue threshold, campaign assets, explicit participation (invite in the merchant app, join in the portal), notifications on invite, automatic ending by the scheduler, and campaign performance in Analytics. Gated to plans with the campaigns feature.
- **Automation rule builder (AUTO-01..06). Done.** Rules = trigger event + conditions (program, offer, campaign, affiliate, tag, status, amount, source) + actions (template or custom email, approve commission/conversion, add/remove tag, balance adjustment, create task, suspend affiliate) + stop conditions (once per entity, once per affiliate, skip by affiliate status, active window). Rules run in the worker after the stored event; every evaluation writes a run record (matched, actions taken, outcome). Actions run under an automation actor whose events never re-trigger rules. Pause/resume keeps history. Tasks surface on the merchant home. Gated to plans with the automation feature.
- **Affiliate groups and tiers (AFF-04, PROG-11). Done.** Groups by partner type, channel, geography or negotiated rate; membership managed from Groups and from each affiliate. Groups target asset permissions, campaign invitations and automation conditions. Rate tiers per program: by group (priority-ordered) or by performance (sales or revenue over a lifetime or rolling window, measured on earlier conversions). Precedence: live campaign > affiliate override > tier > program-offer override > program. The tier used is recorded on each commission; affiliates see their effective rate and progress to the next tier in the portal.
- **Payout integrations (PRD s14 P2, PAY-01/05). Done.** Provider adapters over plain HTTPS with an injectable fetch: Stripe Connect (transfers to Express connected accounts, affiliate onboarding links) and PayPal Payouts (asynchronous batches, polled by the scheduler). Per-tenant credentials are verified on connect and stored AES-256-GCM encrypted; only a hint is ever returned. Merchants send a draft payout (or all drafts) through the provider; the worker performs the call with a per-payout idempotency key and settles commissions on success or marks the payout failed with the provider's reason. Manual payouts are unchanged. Not built: provider webhooks (polling covers PayPal; Stripe transfers settle synchronously) and Wise/UPI providers.
- **Disputes workflow. Done.** Dispute records raised by merchants (fraud, refund, amount, other on an attributed sale) or affiliates (missing attribution with an order reference, amount, other on their own sale). Opening or linking a sale holds it (`disputed`, skipped by settlement). Lifecycle open → under review → resolved (upheld/rejected) or withdrawn, with a comment thread, tasks for the team when affiliates write, notifications to affiliates, and a concrete outcome on resolution: restore the sale, cancel it and void the commission, or reattribute it. Automation can trigger on dispute opened/resolved. Home shows open disputes.
- **Zapier/Make outbound webhooks (PRD s14 P1). Done.** Subscriptions per tenant with an encrypted signing secret (shown once, rotatable), event filters, signed deliveries (HMAC-SHA256 over timestamp.body) attempted by the worker with exponential backoff, a delivery log with responses and manual redelivery, auto-pause after 5 exhausted deliveries with a team task, a test ping, and payloads that snapshot the affiliate, conversion, commission or payout involved.
- **Richer analytics and reporting. Done.** Time series (clicks, sales, attributed revenue, commission, new affiliates) by day, week or month with every bucket filled; comparison against the previous period of equal length with signed deltas on every headline metric; a click → attributed → approved funnel with attribution-source split and unattributed sales; breakdown by affiliate group; presets plus a custom date range and granularity control. Charts are dependency-free SVG small multiples (one axis each, hover crosshair and tooltip, previous period de-emphasised, validated palette, dark-mode tokens).
- **WhatsApp/SMS messaging. Done.** Twilio adapter behind the message pipeline (SMS and WhatsApp, injectable fetch, per-tenant encrypted credentials with a platform fallback); a second template channel seeded per tone and editable on the Messages page; affiliate opt-in with E.164 phone, channel choice and timestamped consent from the portal (merchants cannot consent on their behalf); email always, text in addition; every text logged with provider id, skip reasons and delivery status; signed Twilio webhooks for status callbacks and STOP/START keywords; `send_text` automation action.
- **Security pass. Done (2026-09-08).** Five-area review (auth, public surface, authorisation, secrets/SSRF/uploads, web client). Fixed: account takeover through the public join form; API key scopes never enforced and keys able to mint keys or manage providers; SSRF through webhook URLs; one-time reset/verify/invite links readable in the message log; SVG uploads executing on the API origin; rate limits keyed on a spoofable header; insecure default encryption key in production; commission reversal and task completion reachable with read; merchant notes and provider references leaking to the portal; CSV formula injection; no body limits or security headers; session token kept in localStorage. Added password change, scrypt cost upgrade, per-account login limits, Twilio replay protection. See docs/DEPLOYMENT.md "Security model".
- **Observability. Done (2026-09-08).** Request ids on every response, error body and log line; structured JSON logs with redaction (pretty in dev); timed and logged jobs with retry/dead outcomes; `/metrics` in Prometheus format (HTTP and job counters and histograms, queue depth by status and type, lag, stuck jobs, dead webhook deliveries, failed messages, worker heartbeat); `/health/ready` with migrations and worker heartbeat; optional error-report webhook with throttling; process-level handlers; Operations panel on the admin overview.
- **Backups and retention. Done (2026-09-09).** Logical backups without `pg_dump` (every table in one consistent snapshot through the app connection, JSON lines, gzip, AES-256-GCM under `BACKUP_KEY`, uploaded files bundled with local storage), scheduled by the worker with daily-then-weekly rotation in the file store, recorded as maintenance runs, triggerable and downloadable by platform admins, exposed on `/metrics`; CLI `backup`/`restore`/`verify`; restore into a migrated database via `json_populate_recordset` with foreign-key ordering, self-reference second pass and sequence reset; CI restore drill after the Postgres boot smoke. Retention: per-workspace policy (clicks, messages, audit, webhook deliveries, automation runs) within bounds, nightly prune that keeps attributed clicks and all financial records, platform housekeeping (finished jobs, expired sessions/tokens/exports, maintenance history); closed workspaces purged after `TENANT_PURGE_DAYS` with their files. Data requests: workspace export as JSON lines (secrets removed, owner only), affiliate erasure request from the portal (task) and merchant-side erasure that anonymises identity, disables the login and blanks messages and audit snapshots while keeping the ledger; refused while money is owed. Settings → Data card, admin Maintenance panel, close/reopen on the admin workspace page.
- **In-app notification centre (MSG-06). Done (2026-09-09).** Every domain event someone should see becomes a per-recipient row, fanned out by the worker next to the built-in emails: affiliates get account, earnings, payout, campaign, dispute and program-update notices; team members get applications, sales, disputes from affiliates, failed payouts and new tasks (automation, disputes, webhooks, data requests), by role. A bell in the sidebar polls the unread count; the Notifications page (merchant and portal) lists unread or all, opens the linked page and marks read, and holds per-recipient category preferences (in-app for everyone, email as well for affiliates, which also silences the matching built-in email; account and security emails always go). Endpoints under `/v1/notifications` and `/portal/notifications`; API keys have no inbox. Notifications are RLS-scoped, included in backups and the workspace export, and pruned by retention (`notificationsDays`, 180 by default).
- **Custom domains: on hold** at the user's request.
6. Phase 2 candidates: campaigns, affiliate groups/tiers, automation rule builder UI, Stripe/Shopify adapters, custom domains, disputes workflow.

## 6. Contradictions and clarifications found in the PRD

| # | Issue | Resolution taken |
|---|---|---|
| 1 | Campaigns (AST-03 to 05) and the automation engine (AUTO-01 to 06) are marked Must, but the Phase 1 roadmap (s18) excludes campaigns and lists a richer automation builder in Phase 2. | Schema includes both so data shapes are stable. Campaign and rule-builder UI/API come after the MVP acceptance criteria (s17) pass. Event-driven notifications (a subset of AUTO-01/03) ship in Phase 1 because s17 requires them. |
| 2 | The commission state table (s12) omits `void`, which COMM-02 lists. | State machine: pending to approved/reversed/void; approved to payable/reversed/void; payable to paid/reversed; paid to reversed only via manual adjustment writing a ledger debit. |
| 3 | PROG-08 says "cookie/token precedence" while s11 recommends "coupon wins". | Program field `precedence` with values `coupon_wins` or `link_wins`, default `coupon_wins`. |
| 4 | Dashboard examples use rupees but no market is stated. | Currency is a tenant setting; nothing is hard-coded to INR. |
| 5 | s4 says affiliates can join multiple programs, while s26 lists it as an open question. | One Affiliate per tenant per person with many AffiliateProgram memberships. |
| 6 | Custom domains (BIZ-06, Should) sit in Phase 2. | Tenant resolution is abstracted behind a resolver so domain mapping is a later add. |

## 7. Product decisions that are not blocking (defaults chosen, all editable)

Last-touch attribution; coupon wins over link; 30-day window; 30-day holding; manual approval; manual payouts; payout threshold default 0; commission rounding half-to-even in minor units.

## 8. Genuinely open questions (do not block Phase 1)

- First conversion integration beyond generic webhooks: Stripe vs Shopify/WooCommerce.
- Payout methods for the first market (bank transfer, Stripe Connect, PayPal, UPI provider).
- Plan-limit metric (active affiliates vs tracked conversions vs attributed revenue).
