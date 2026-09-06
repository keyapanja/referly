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
3. Notifications: template rendering with safe variables, email adapter, message log, event-driven worker. **Done.** Asset library: schema only, UI/API pending.
4. Web: merchant onboarding flow, merchant app, affiliate portal, public join/invite pages. **Done.**
5. Dashboards and CSV export (synchronous, small datasets). **Done.** Remaining for Phase 1: asset library UI/API, async export for large datasets, email provider adapter for production (SMTP/API), rate limiting on public endpoints, Postgres row-level security as a second isolation layer.
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
