import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
  serial,
} from "drizzle-orm/pg-core";

/*
 * Conventions
 * - Every business-owned table has a NOT NULL tenant_id, even when a parent already scopes it.
 * - Money is bigint minor units (mode: "number"). Rates are integer basis points.
 * - Timestamps are timestamptz stored in UTC.
 * - Enumerations are text columns validated in the domain layer so migrations stay trivial.
 */

const id = (name = "id") => text(name).primaryKey();
const tenantRef = () => text("tenant_id").notNull().references(() => tenants.id);
const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
const money = (name: string) => bigint(name, { mode: "number" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
/** Monotonic insertion order; tie-breaker when timestamps collide. */
const seq = () => serial("seq").notNull();

// ---------------------------------------------------------------------------
// Tenancy, users, auth
// ---------------------------------------------------------------------------

export const tenants = pgTable("tenants", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  status: text("status").notNull().default("active"), // active | suspended | closed
  kind: text("kind").notNull().default("business"), // business | platform
  planId: text("plan_id").notNull().default("starter"),
  currency: text("currency").notNull().default("USD"),
  timezone: text("timezone").notNull().default("UTC"),
  locale: text("locale").notNull().default("en"),
  businessType: text("business_type"),
  legalName: text("legal_name"),
  website: text("website"),
  supportEmail: text("support_email"),
  description: text("description"),
  logoUrl: text("logo_url"),
  branding: jsonb("branding").$type<TenantBranding>().notNull().default({}),
  tone: text("tone").notNull().default("friendly"), // friendly | professional | concise | warm | formal
  defaults: jsonb("defaults").$type<TenantDefaults>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export interface TenantBranding {
  primaryColor?: string;
  accentColor?: string;
  faviconUrl?: string;
  emailFooter?: string;
}

export interface TenantDefaults {
  attributionWindowDays?: number;
  holdingDays?: number;
  approvalMode?: "manual" | "auto" | "invite_only";
  payoutCadence?: "manual" | "weekly" | "biweekly" | "monthly";
  payoutThresholdMinor?: number;
  requireConsentForTracking?: boolean;
}

export const users = pgTable(
  "users",
  {
    id: id(),
    tenantId: tenantRef(),
    role: text("role").notNull(), // owner | admin | marketing | readonly | affiliate | platform_admin
    name: text("name").notNull(),
    email: text("email").notNull(),
    passwordHash: text("password_hash"),
    status: text("status").notNull().default("active"), // invited | active | disabled
    emailVerifiedAt: ts("email_verified_at"),
    lastLoginAt: ts("last_login_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_tenant_email_uq").on(t.tenantId, t.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    tenantId: tenantRef(),
    userId: text("user_id").notNull().references(() => users.id),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    tenantId: tenantRef(),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    createdByUserId: text("created_by_user_id").references(() => users.id),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("api_keys_tenant_idx").on(t.tenantId)],
);

// ---------------------------------------------------------------------------
// Offers and programs
// ---------------------------------------------------------------------------

export const offers = pgTable(
  "offers",
  {
    id: id(),
    tenantId: tenantRef(),
    name: text("name").notNull(),
    shortDescription: text("short_description"),
    type: text("type").notNull().default("custom"), // coaching | course | workshop | event | membership | consulting | custom
    priceMinor: money("price_minor").notNull().default(0),
    currency: text("currency").notNull(),
    salesUrl: text("sales_url").notNull(),
    imageUrl: text("image_url"),
    status: text("status").notNull().default("draft"), // draft | active | paused | archived
    internalNotes: text("internal_notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("offers_tenant_idx").on(t.tenantId)],
);

export const programs = pgTable(
  "programs",
  {
    id: id(),
    tenantId: tenantRef(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("draft"), // draft | active | paused | archived
    commissionModel: text("commission_model").notNull().default("percentage"), // percentage | fixed
    commissionRateBps: integer("commission_rate_bps").notNull().default(0),
    commissionFixedMinor: money("commission_fixed_minor").notNull().default(0),
    commissionBasis: text("commission_basis").notNull().default("gross"), // gross | net | eligible
    attributionModel: text("attribution_model").notNull().default("last_touch"), // last_touch | first_touch
    attributionWindowDays: integer("attribution_window_days").notNull().default(30),
    precedence: text("precedence").notNull().default("coupon_wins"), // coupon_wins | link_wins
    approvalMode: text("approval_mode").notNull().default("manual"), // manual | auto | invite_only
    holdingDays: integer("holding_days").notNull().default(30),
    refundPolicy: text("refund_policy").notNull().default("full"), // full | partial | none
    termsVersion: integer("terms_version").notNull().default(1),
    termsText: text("terms_text").notNull().default(""),
    joinToken: text("join_token").notNull().unique(),
    testMode: boolean("test_mode").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("programs_tenant_idx").on(t.tenantId)],
);

export const programOffers = pgTable(
  "program_offers",
  {
    tenantId: tenantRef(),
    programId: text("program_id").notNull().references(() => programs.id),
    offerId: text("offer_id").notNull().references(() => offers.id),
    commissionRateBpsOverride: integer("commission_rate_bps_override"),
    commissionFixedMinorOverride: money("commission_fixed_minor_override"),
    eligibilityStatus: text("eligibility_status").notNull().default("eligible"), // eligible | ineligible
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.programId, t.offerId] }), index("program_offers_tenant_idx").on(t.tenantId)],
);

// ---------------------------------------------------------------------------
// Affiliates
// ---------------------------------------------------------------------------

export const affiliates = pgTable(
  "affiliates",
  {
    id: id(),
    tenantId: tenantRef(),
    userId: text("user_id").references(() => users.id),
    name: text("name").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    company: text("company"),
    channels: jsonb("channels").$type<Record<string, string>>().notNull().default({}),
    status: text("status").notNull().default("applied"), // applied | active | suspended | rejected
    source: text("source").notNull().default("application"), // application | invite | manual | import
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    notes: text("notes"),
    payoutMethod: text("payout_method"), // bank_transfer | paypal | stripe_connect | upi | other
    payoutProfileRef: text("payout_profile_ref"), // provider/token reference; never raw credentials
    payoutDetailsMasked: text("payout_details_masked"),
    applicationAnswers: jsonb("application_answers").$type<Record<string, unknown>>().notNull().default({}),
    suspendedAt: ts("suspended_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("affiliates_tenant_email_uq").on(t.tenantId, t.email), index("affiliates_tenant_status_idx").on(t.tenantId, t.status)],
);

export const affiliatePrograms = pgTable(
  "affiliate_programs",
  {
    tenantId: tenantRef(),
    affiliateId: text("affiliate_id").notNull().references(() => affiliates.id),
    programId: text("program_id").notNull().references(() => programs.id),
    status: text("status").notNull().default("pending"), // pending | active | suspended | left
    joinedAt: ts("joined_at"),
    termsVersion: integer("terms_version"),
    termsAcceptedAt: ts("terms_accepted_at"),
    customCommissionRateBps: integer("custom_commission_rate_bps"),
    customCommissionFixedMinor: money("custom_commission_fixed_minor"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.affiliateId, t.programId] }), index("affiliate_programs_tenant_idx").on(t.tenantId)],
);

export const invites = pgTable(
  "invites",
  {
    id: id(),
    tenantId: tenantRef(),
    programId: text("program_id").notNull().references(() => programs.id),
    email: text("email").notNull(),
    name: text("name"),
    token: text("token").notNull().unique(),
    status: text("status").notNull().default("sent"), // sent | accepted | expired | revoked
    expiresAt: ts("expires_at").notNull(),
    acceptedAffiliateId: text("accepted_affiliate_id").references(() => affiliates.id),
    createdByUserId: text("created_by_user_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("invites_tenant_idx").on(t.tenantId)],
);

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

export const trackingLinks = pgTable(
  "tracking_links",
  {
    id: id(),
    tenantId: tenantRef(),
    affiliateId: text("affiliate_id").notNull().references(() => affiliates.id),
    programId: text("program_id").notNull().references(() => programs.id),
    offerId: text("offer_id").notNull().references(() => offers.id),
    token: text("token").notNull().unique(),
    destinationUrl: text("destination_url").notNull(),
    label: text("label"),
    status: text("status").notNull().default("active"), // active | disabled
    clickCount: integer("click_count").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("tracking_links_unique_uq").on(t.affiliateId, t.programId, t.offerId, t.label),
    index("tracking_links_tenant_idx").on(t.tenantId),
  ],
);

export const couponCodes = pgTable(
  "coupon_codes",
  {
    id: id(),
    tenantId: tenantRef(),
    affiliateId: text("affiliate_id").notNull().references(() => affiliates.id),
    programId: text("program_id").notNull().references(() => programs.id),
    offerId: text("offer_id").references(() => offers.id),
    code: text("code").notNull(),
    codeNormalized: text("code_normalized").notNull(),
    discountRule: jsonb("discount_rule").$type<{ type: "percentage" | "fixed"; value: number } | null>(),
    status: text("status").notNull().default("active"), // active | disabled
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("coupon_codes_tenant_code_uq").on(t.tenantId, t.codeNormalized)],
);

export const clicks = pgTable(
  "clicks",
  {
    id: id(),
    tenantId: tenantRef(),
    trackingLinkId: text("tracking_link_id").notNull().references(() => trackingLinks.id),
    affiliateId: text("affiliate_id").notNull().references(() => affiliates.id),
    programId: text("program_id").notNull().references(() => programs.id),
    offerId: text("offer_id").notNull().references(() => offers.id),
    clickToken: text("click_token").notNull().unique(),
    consentState: text("consent_state").notNull().default("unknown"), // granted | denied | unknown | not_required
    referrer: text("referrer"),
    userAgent: text("user_agent"),
    ipHash: text("ip_hash"),
    country: text("country"),
    deviceType: text("device_type"),
    isTest: boolean("is_test").notNull().default(false),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
  },
  (t) => [index("clicks_tenant_affiliate_idx").on(t.tenantId, t.affiliateId, t.occurredAt)],
);

// ---------------------------------------------------------------------------
// Conversions, attribution, commissions, ledger, payouts
// ---------------------------------------------------------------------------

export const conversions = pgTable(
  "conversions",
  {
    id: id(),
    tenantId: tenantRef(),
    source: text("source").notNull(), // webhook | api | manual | stripe | shopify | import
    externalOrderId: text("external_order_id").notNull(),
    offerId: text("offer_id").references(() => offers.id),
    customerRef: text("customer_ref"),
    customerEmailHash: text("customer_email_hash"),
    amountMinor: money("amount_minor").notNull(),
    netAmountMinor: money("net_amount_minor"),
    eligibleAmountMinor: money("eligible_amount_minor"),
    refundedAmountMinor: money("refunded_amount_minor").notNull().default(0),
    currency: text("currency").notNull(),
    status: text("status").notNull().default("pending"), // pending | approved | refunded | cancelled | reversed | disputed
    affiliateId: text("affiliate_id").references(() => affiliates.id),
    programId: text("program_id").references(() => programs.id),
    attributionSource: text("attribution_source").notNull().default("none"), // link | coupon | manual | none
    isTest: boolean("is_test").notNull().default(false),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: ts("occurred_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("conversions_idempotency_uq").on(t.tenantId, t.source, t.externalOrderId),
    index("conversions_tenant_affiliate_idx").on(t.tenantId, t.affiliateId),
  ],
);

export const attributions = pgTable(
  "attributions",
  {
    id: id(),
    tenantId: tenantRef(),
    seq: seq(),
    conversionId: text("conversion_id").notNull().references(() => conversions.id),
    affiliateId: text("affiliate_id").notNull().references(() => affiliates.id),
    programId: text("program_id").notNull().references(() => programs.id),
    ruleApplied: text("rule_applied").notNull(), // coupon | last_click | first_click | manual
    clickId: text("click_id").references(() => clicks.id),
    couponCodeId: text("coupon_code_id").references(() => couponCodes.id),
    candidates: jsonb("candidates").$type<AttributionCandidateRecord[]>().notNull().default([]),
    reason: text("reason"),
    actorUserId: text("actor_user_id").references(() => users.id),
    supersededById: text("superseded_by_id"),
    attributedAt: ts("attributed_at").notNull().defaultNow(),
  },
  (t) => [index("attributions_conversion_idx").on(t.conversionId)],
);

export interface AttributionCandidateRecord {
  rule: string;
  affiliateId: string;
  programId: string;
  evidenceId: string;
  occurredAt: string;
  eligible: boolean;
  ineligibleReason?: string;
}

export const commissions = pgTable(
  "commissions",
  {
    id: id(),
    tenantId: tenantRef(),
    seq: seq(),
    conversionId: text("conversion_id").notNull().references(() => conversions.id),
    attributionId: text("attribution_id").references(() => attributions.id),
    affiliateId: text("affiliate_id").notNull().references(() => affiliates.id),
    programId: text("program_id").notNull().references(() => programs.id),
    amountMinor: money("amount_minor").notNull(),
    originalAmountMinor: money("original_amount_minor").notNull(),
    currency: text("currency").notNull(),
    status: text("status").notNull().default("pending"), // pending | approved | payable | paid | reversed | void
    calculationBasis: jsonb("calculation_basis").$type<CommissionCalculationBasis>().notNull(),
    payableAt: ts("payable_at").notNull(),
    approvedAt: ts("approved_at"),
    paidAt: ts("paid_at"),
    reversedAt: ts("reversed_at"),
    payoutId: text("payout_id"),
    isTest: boolean("is_test").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("commissions_conversion_idx").on(t.conversionId),
    index("commissions_tenant_affiliate_status_idx").on(t.tenantId, t.affiliateId, t.status),
  ],
);

export interface CommissionCalculationBasis {
  model: "percentage" | "fixed";
  basis: "gross" | "net" | "eligible";
  basisAmountMinor: number;
  rateBps?: number;
  fixedMinor?: number;
  overrideSource: "program" | "program_offer" | "affiliate_program";
}

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: id(),
    tenantId: tenantRef(),
    seq: seq(),
    affiliateId: text("affiliate_id").notNull().references(() => affiliates.id),
    commissionId: text("commission_id").references(() => commissions.id),
    payoutId: text("payout_id"),
    type: text("type").notNull(), // credit | reversal | adjustment | payout
    amountMinor: money("amount_minor").notNull(), // signed: credits positive, debits negative
    currency: text("currency").notNull(),
    reason: text("reason"),
    actorUserId: text("actor_user_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("ledger_tenant_affiliate_idx").on(t.tenantId, t.affiliateId)],
);

export const payouts = pgTable(
  "payouts",
  {
    id: id(),
    tenantId: tenantRef(),
    affiliateId: text("affiliate_id").notNull().references(() => affiliates.id),
    periodStart: ts("period_start"),
    periodEnd: ts("period_end"),
    amountMinor: money("amount_minor").notNull(),
    currency: text("currency").notNull(),
    status: text("status").notNull().default("draft"), // draft | processing | paid | failed | cancelled
    method: text("method"),
    methodRef: text("method_ref"),
    externalReference: text("external_reference"),
    failureReason: text("failure_reason"),
    paidAt: ts("paid_at"),
    createdByUserId: text("created_by_user_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("payouts_tenant_affiliate_idx").on(t.tenantId, t.affiliateId)],
);

// ---------------------------------------------------------------------------
// Assets, campaigns, messaging, automation, audit, jobs
// ---------------------------------------------------------------------------

export const assets = pgTable(
  "assets",
  {
    id: id(),
    tenantId: tenantRef(),
    type: text("type").notNull(), // image | banner | pdf | video | copy | link | guideline
    title: text("title").notNull(),
    url: text("url"),
    body: text("body"),
    usageInstructions: text("usage_instructions"),
    status: text("status").notNull().default("active"), // active | archived
    visibility: text("visibility").notNull().default("all"), // all | restricted
    createdAt: createdAt(),
  },
  (t) => [index("assets_tenant_idx").on(t.tenantId)],
);

export const assetPermissions = pgTable(
  "asset_permissions",
  {
    id: id(),
    tenantId: tenantRef(),
    assetId: text("asset_id").notNull().references(() => assets.id),
    programId: text("program_id").references(() => programs.id),
    offerId: text("offer_id").references(() => offers.id),
    affiliateId: text("affiliate_id").references(() => affiliates.id),
  },
  (t) => [index("asset_permissions_asset_idx").on(t.assetId)],
);

export const campaigns = pgTable(
  "campaigns",
  {
    id: id(),
    tenantId: tenantRef(),
    programId: text("program_id").notNull().references(() => programs.id),
    name: text("name").notNull(),
    description: text("description"),
    startAt: ts("start_at").notNull(),
    endAt: ts("end_at").notNull(),
    status: text("status").notNull().default("draft"), // draft | scheduled | active | ended | cancelled
    commissionRateBpsOverride: integer("commission_rate_bps_override"),
    commissionFixedMinorOverride: money("commission_fixed_minor_override"),
    bonusRule: jsonb("bonus_rule").$type<{ thresholdMinor: number; bonusMinor: number } | null>(),
    createdAt: createdAt(),
  },
  (t) => [index("campaigns_tenant_idx").on(t.tenantId)],
);

export const messageTemplates = pgTable(
  "message_templates",
  {
    id: id(),
    tenantId: tenantRef(),
    key: text("key").notNull(), // affiliate_invite | affiliate_approved | conversion_recorded | commission_approved | payout_paid | ...
    channel: text("channel").notNull().default("email"),
    tone: text("tone"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("message_templates_tenant_key_uq").on(t.tenantId, t.key, t.channel)],
);

export const messageLogs = pgTable(
  "message_logs",
  {
    id: id(),
    tenantId: tenantRef(),
    templateKey: text("template_key").notNull(),
    channel: text("channel").notNull(),
    recipient: text("recipient").notNull(),
    affiliateId: text("affiliate_id").references(() => affiliates.id),
    relatedEntityType: text("related_entity_type"),
    relatedEntityId: text("related_entity_id"),
    subject: text("subject"),
    body: text("body"),
    status: text("status").notNull().default("queued"), // queued | sent | failed | skipped
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    sentAt: ts("sent_at"),
    createdAt: createdAt(),
  },
  (t) => [index("message_logs_tenant_idx").on(t.tenantId, t.createdAt)],
);

export const automationRules = pgTable(
  "automation_rules",
  {
    id: id(),
    tenantId: tenantRef(),
    name: text("name").notNull(),
    trigger: text("trigger").notNull(),
    conditions: jsonb("conditions").$type<Record<string, unknown>[]>().notNull().default([]),
    actions: jsonb("actions").$type<Record<string, unknown>[]>().notNull().default([]),
    stopConditions: jsonb("stop_conditions").$type<Record<string, unknown>[]>().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("automation_rules_tenant_trigger_idx").on(t.tenantId, t.trigger)],
);

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: id(),
    tenantId: tenantRef(),
    ruleId: text("rule_id").notNull().references(() => automationRules.id),
    trigger: text("trigger").notNull(),
    eventPayload: jsonb("event_payload").$type<Record<string, unknown>>().notNull(),
    matched: boolean("matched").notNull(),
    actionsTaken: jsonb("actions_taken").$type<Record<string, unknown>[]>().notNull().default([]),
    status: text("status").notNull(), // success | skipped | failed
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("automation_runs_rule_idx").on(t.ruleId, t.createdAt)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    tenantId: tenantRef(),
    seq: seq(),
    actorUserId: text("actor_user_id"),
    actorType: text("actor_type").notNull().default("user"), // user | system | api_key | affiliate
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_tenant_entity_idx").on(t.tenantId, t.entityType, t.entityId)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    tenantId: text("tenant_id"), // nullable: platform-level jobs have no tenant
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("queued"), // queued | running | done | failed | dead
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAt: ts("run_at").notNull().defaultNow(),
    lockedAt: ts("locked_at"),
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key").unique(),
    createdAt: createdAt(),
    completedAt: ts("completed_at"),
  },
  (t) => [index("jobs_status_run_at_idx").on(t.status, t.runAt)],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: id(),
    tenantId: tenantRef(),
    source: text("source").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("received"), // received | processed | duplicate | failed
    resultEntityType: text("result_entity_type"),
    resultEntityId: text("result_entity_id"),
    error: text("error"),
    receivedAt: createdAt(),
    processedAt: ts("processed_at"),
  },
  (t) => [uniqueIndex("webhook_deliveries_uq").on(t.tenantId, t.source, t.idempotencyKey)],
);

export const schema = {
  tenants,
  users,
  sessions,
  apiKeys,
  offers,
  programs,
  programOffers,
  affiliates,
  affiliatePrograms,
  invites,
  trackingLinks,
  couponCodes,
  clicks,
  conversions,
  attributions,
  commissions,
  ledgerEntries,
  payouts,
  assets,
  assetPermissions,
  campaigns,
  messageTemplates,
  messageLogs,
  automationRules,
  automationRuns,
  auditLogs,
  jobs,
  webhookDeliveries,
};

export type Tenant = typeof tenants.$inferSelect;
export type User = typeof users.$inferSelect;
export type Offer = typeof offers.$inferSelect;
export type Program = typeof programs.$inferSelect;
export type ProgramOffer = typeof programOffers.$inferSelect;
export type Affiliate = typeof affiliates.$inferSelect;
export type AffiliateProgram = typeof affiliatePrograms.$inferSelect;
export type Invite = typeof invites.$inferSelect;
export type TrackingLink = typeof trackingLinks.$inferSelect;
export type CouponCode = typeof couponCodes.$inferSelect;
export type Click = typeof clicks.$inferSelect;
export type Conversion = typeof conversions.$inferSelect;
export type Attribution = typeof attributions.$inferSelect;
export type Commission = typeof commissions.$inferSelect;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type Payout = typeof payouts.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type MessageTemplate = typeof messageTemplates.$inferSelect;
export type MessageLog = typeof messageLogs.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type Job = typeof jobs.$inferSelect;
