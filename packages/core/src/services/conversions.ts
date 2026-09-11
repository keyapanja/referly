import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { DbLike, Tx } from "../db/client";
import { withTx } from "../db/client";
import { attributions, commissions, conversions, offers, programs, tenants, type Attribution, type Commission, type Conversion } from "../db/schema";
import { newId } from "../ids";
import { notFound, validation } from "../errors";
import { type TenantContext, require as requirePerm, requireAffiliate } from "../context";
import { writeAudit, snapshot } from "./audit";
import { emitEvent } from "./events";
import { CONVERSION_TRANSITIONS, assertTransition, type ConversionStatus } from "../statemachine";
import { resolveAttribution, type AttributionDecision } from "./attribution";
import { createCommissionForConversion, reduceCommissionRow, reverseCommissionRow } from "./commissions";
import { evaluateBonus, findLiveCampaign } from "./campaigns";
import { getMembership } from "./affiliates";
import { proportion } from "../money";
import { linkConversion, visitorClickTokens, VISITOR_ID } from "./journeys";

export const CONVERSION_SOURCES = ["webhook", "api", "manual", "stripe", "shopify", "woocommerce", "import", "form", "pixel"] as const;
export const CONVERSION_KINDS = ["sale", "lead"] as const;
export type ConversionKind = (typeof CONVERSION_KINDS)[number];

/**
 * Referly only keeps sales an affiliate can claim. Thrown for a sale with no eligible click,
 * visitor or coupon: nothing is stored, and the API answers `recorded: false`, so integrations can
 * send every order and let Referly decide. Leads are not affected.
 */
export class NoAffiliateError extends Error {
  readonly code = "no_affiliate";
  constructor() {
    super("no affiliate can claim this order, so it is not recorded");
    this.name = "NoAffiliateError";
  }
}

export const recordConversionSchema = z.object({
  source: z.enum(CONVERSION_SOURCES).default("api"),
  /** `lead` rows are created through the leads service; the API's conversion endpoint only records sales. */
  kind: z.enum(CONVERSION_KINDS).default("sale"),
  /** Order/transaction id from the source system. Idempotency key within (tenant, source). */
  externalOrderId: z.string().min(1).max(200),
  offerId: z.string().optional(),
  amountMinor: z.number().int().min(0),
  netAmountMinor: z.number().int().min(0).optional(),
  eligibleAmountMinor: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  customerRef: z.string().max(200).optional(),
  /** Hashed before storage (CONV-06). */
  customerEmail: z.string().email().optional(),
  clickToken: z.string().optional(),
  clickTokens: z.array(z.string()).optional(),
  couponCode: z.string().max(40).optional(),
  /** Visitor id from the site snippet (TRK-09): its recorded clicks join the candidates and the sale lands on the visitor's journey. */
  visitorId: z.string().regex(VISITOR_ID).optional(),
  occurredAt: z.coerce.date().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  /** Manual attribution (CONV-05/TRK-08): explicit affiliate + program; requires a reason. */
  affiliateId: z.string().optional(),
  programId: z.string().optional(),
  reason: z.string().max(1000).optional(),
});
export type RecordConversionInput = z.input<typeof recordConversionSchema>;

export interface RecordConversionResult {
  conversion: Conversion;
  attribution: Attribution | null;
  commission: Commission | null;
  duplicate: boolean;
}

/**
 * TRK-04 / TRK-07 / CONV-01: single entry point for every conversion source. Idempotent on
 * (tenant, source, externalOrderId): a repeated webhook returns the original record and
 * never creates a second commission.
 */
export async function recordConversion(db: DbLike, ctx: TenantContext, rawInput: RecordConversionInput): Promise<RecordConversionResult> {
  requirePerm(ctx, "conversions.write");
  const input = recordConversionSchema.parse(rawInput);
  if (input.netAmountMinor != null && input.netAmountMinor > input.amountMinor) throw validation("netAmountMinor cannot exceed amountMinor");
  if (input.affiliateId && !input.reason?.trim()) throw validation("a reason is required for manual attribution");
  if (input.affiliateId && !input.programId) throw validation("programId is required for manual attribution");

  const existing = await findByExternalId(db, ctx, input.source, input.externalOrderId);
  if (existing) return await loadResult(db, existing, true);

  try {
    return await withTx(db, async (tx) => {
      const tenant = await tx.query.tenants.findFirst({ where: eq(tenants.id, ctx.tenantId) });
      if (!tenant) throw notFound("tenant", ctx.tenantId);
      if (input.offerId) {
        const offer = await tx.query.offers.findFirst({ where: and(eq(offers.id, input.offerId), eq(offers.tenantId, ctx.tenantId)) });
        if (!offer) throw notFound("offer", input.offerId);
      }
      const occurredAt = input.occurredAt ?? ctx.now();
      const clickTokens = [...(input.clickTokens ?? []), ...(input.clickToken ? [input.clickToken] : [])];
      // The snippet's visitor id stands in for a lost cookie: every click that visitor arrived through is a candidate.
      if (input.visitorId) for (const t of await visitorClickTokens(tx, ctx, input.visitorId)) if (!clickTokens.includes(t)) clickTokens.push(t);

      let decision: AttributionDecision | null;
      let manualReason: string | undefined;
      if (input.affiliateId) {
        const membership = await getMembership(tx, ctx, input.affiliateId, input.programId!);
        if (!membership) throw validation("affiliate is not a member of that program");
        const program = await tx.query.programs.findFirst({ where: and(eq(programs.id, input.programId!), eq(programs.tenantId, ctx.tenantId)) });
        if (!program) throw notFound("program", input.programId);
        decision = { affiliateId: input.affiliateId, programId: program.id, rule: "manual", source: "link", isTest: program.testMode, candidates: [] };
        manualReason = input.reason;
      } else {
        decision = (await resolveAttribution(tx, ctx, { offerId: input.offerId ?? null, occurredAt, clickTokens, couponCode: input.couponCode ?? null })).decision;
      }
      // Only sales that came through an affiliate are kept. Typed in by hand, a sale nobody can claim
      // is refused so the merchant can pick the affiliate; from an integration it is dropped quietly.
      if (!decision && input.kind === "sale") {
        if (input.source === "manual") throw validation("no affiliate matches this order: choose the affiliate, or use a coupon code that belongs to one");
        throw new NoAffiliateError();
      }

      const campaign = decision ? await findLiveCampaign(tx, ctx, { programId: decision.programId, affiliateId: decision.affiliateId, offerId: input.offerId ?? null, at: occurredAt }) : null;
      const [conversion] = await tx
        .insert(conversions)
        .values({
          id: newId("conversion"),
          tenantId: ctx.tenantId,
          source: input.source,
          kind: input.kind,
          externalOrderId: input.externalOrderId,
          offerId: input.offerId ?? null,
          customerRef: input.customerRef ?? null,
          customerEmailHash: input.customerEmail ? hashEmail(input.customerEmail) : null,
          amountMinor: input.amountMinor,
          netAmountMinor: input.netAmountMinor ?? null,
          eligibleAmountMinor: input.eligibleAmountMinor ?? null,
          currency: (input.currency ?? tenant.currency).toUpperCase(),
          status: "pending",
          affiliateId: decision?.affiliateId ?? null,
          programId: decision?.programId ?? null,
          campaignId: campaign?.id ?? null,
          attributionSource: decision ? (decision.rule === "manual" ? "manual" : decision.source) : "none",
          isTest: decision?.isTest ?? false,
          metadata: input.metadata,
          occurredAt,
          createdAt: ctx.now(),
          updatedAt: ctx.now(),
        })
        .returning();

      let attribution: Attribution | null = null;
      let commission: Commission | null = null;
      if (decision) {
        attribution = await insertAttribution(tx, ctx, conversion!, decision, manualReason);
        const program = (await tx.query.programs.findFirst({ where: eq(programs.id, decision.programId) }))!;
        commission = await createCommissionForConversion(tx, ctx, { conversion: conversion!, attributionId: attribution.id, affiliateId: decision.affiliateId, program, isTest: decision.isTest, campaign });
        if (campaign && !decision.isTest) await evaluateBonus(tx, ctx, campaign, decision.affiliateId, conversion!.currency);
      }
      await linkConversion(tx, ctx, { conversion: conversion!, visitorId: input.visitorId ?? null, clickId: decision?.clickId ?? null });
      await writeAudit(tx, ctx, { entityType: "conversion", entityId: conversion!.id, action: "created", after: snapshot(conversion!), reason: manualReason });
      await emitEvent(tx, ctx, "conversion.created", { type: "conversion", id: conversion!.id }, {
        kind: conversion!.kind,
        programId: conversion!.programId,
        affiliateId: decision?.affiliateId ?? null,
        amountMinor: conversion!.amountMinor,
        currency: conversion!.currency,
        offerId: conversion!.offerId,
        commissionId: commission?.id ?? null,
        commissionMinor: commission?.amountMinor ?? null,
      });
      return { conversion: conversion!, attribution, commission, duplicate: false };
    });
  } catch (err) {
    // Concurrent duplicate: the unique index fired. Return the winner.
    if (isUniqueViolation(err)) {
      const winner = await findByExternalId(db, ctx, input.source, input.externalOrderId);
      if (winner) return loadResult(db, winner, true);
    }
    throw err;
  }
}

async function insertAttribution(tx: Tx, ctx: TenantContext, conversion: Conversion, decision: AttributionDecision, reason?: string): Promise<Attribution> {
  const [row] = await tx
    .insert(attributions)
    .values({
      id: newId("attribution"),
      tenantId: ctx.tenantId,
      conversionId: conversion.id,
      affiliateId: decision.affiliateId,
      programId: decision.programId,
      ruleApplied: decision.rule,
      clickId: decision.clickId ?? null,
      couponCodeId: decision.couponCodeId ?? null,
      candidates: decision.candidates,
      reason: reason ?? null,
      actorUserId: ctx.actor.type === "user" ? (ctx.actor.id ?? null) : null,
      attributedAt: ctx.now(),
    })
    .returning();
  return row!;
}

// ---------------------------------------------------------------------------
// Status changes
// ---------------------------------------------------------------------------

export const refundSchema = z.object({
  conversionId: z.string(),
  /** Omit for a full refund of the remaining amount. */
  amountMinor: z.number().int().positive().optional(),
  reason: z.string().min(1).max(1000),
});

/** CONV-04 / journey G: refund reduces or reverses commission according to the program's refund policy. */
export async function refundConversion(db: DbLike, ctx: TenantContext, rawInput: z.input<typeof refundSchema>): Promise<{ conversion: Conversion; commission: Commission | null }> {
  requirePerm(ctx, "conversions.write");
  const input = refundSchema.parse(rawInput);
  return withTx(db, async (tx) => {
    const before = await getConversion(tx, ctx, input.conversionId);
    const remaining = before.amountMinor - before.refundedAmountMinor;
    const refund = input.amountMinor ?? remaining;
    if (refund > remaining) throw validation(`refund ${refund} exceeds remaining amount ${remaining}`);
    assertTransition("conversion", CONVERSION_TRANSITIONS, before.status as ConversionStatus, "refunded");
    const refundedTotal = before.refundedAmountMinor + refund;
    const [conversion] = await tx
      .update(conversions)
      .set({ refundedAmountMinor: refundedTotal, status: "refunded", updatedAt: ctx.now() })
      .where(eq(conversions.id, before.id))
      .returning();
    await writeAudit(tx, ctx, { entityType: "conversion", entityId: before.id, action: "refunded", before: { status: before.status, refundedAmountMinor: before.refundedAmountMinor }, after: { status: "refunded", refundedAmountMinor: refundedTotal }, reason: input.reason });

    let commission = await currentCommission(tx, before.id);
    if (commission) {
      const program = (await tx.query.programs.findFirst({ where: eq(programs.id, commission.programId) }))!;
      const reason = `refund of ${refund} ${before.currency}: ${input.reason}`;
      if (program.refundPolicy === "full" || refundedTotal >= before.amountMinor) {
        commission = await reverseCommissionRow(tx, ctx, commission, reason);
      } else if (program.refundPolicy === "partial") {
        const newAmount = proportion(commission.originalAmountMinor, before.amountMinor - refundedTotal, before.amountMinor);
        commission = await reduceCommissionRow(tx, ctx, commission, newAmount, reason);
      }
    }
    await emitEvent(tx, ctx, "conversion.refunded", { type: "conversion", id: before.id }, { refundMinor: refund, refundedTotalMinor: refundedTotal, commissionId: commission?.id ?? null });
    return { conversion: conversion!, commission: commission ?? null };
  });
}

export async function cancelConversion(db: DbLike, ctx: TenantContext, conversionId: string, reason: string): Promise<Conversion> {
  requirePerm(ctx, "conversions.write");
  if (!reason?.trim()) throw validation("a reason is required");
  return withTx(db, async (tx) => {
    const before = await getConversion(tx, ctx, conversionId);
    const after = await setStatus(tx, ctx, before, "cancelled", reason);
    const commission = await currentCommission(tx, before.id);
    if (commission) await reverseCommissionRow(tx, ctx, commission, `conversion cancelled: ${reason}`, { asVoid: true });
    await emitEvent(tx, ctx, "conversion.cancelled", { type: "conversion", id: before.id }, { reason });
    return after;
  });
}

export async function approveConversion(db: DbLike, ctx: TenantContext, conversionId: string): Promise<Conversion> {
  requirePerm(ctx, "conversions.write");
  const before = await getConversion(db, ctx, conversionId);
  return setStatus(db, ctx, before, "approved");
}

export async function disputeConversion(db: DbLike, ctx: TenantContext, conversionId: string, reason: string): Promise<Conversion> {
  requirePerm(ctx, "conversions.write");
  const before = await getConversion(db, ctx, conversionId);
  return setStatus(db, ctx, before, "disputed", reason);
}

async function setStatus(db: DbLike, ctx: TenantContext, before: Conversion, to: ConversionStatus, reason?: string): Promise<Conversion> {
  assertTransition("conversion", CONVERSION_TRANSITIONS, before.status as ConversionStatus, to);
  const [after] = await db.update(conversions).set({ status: to, updatedAt: ctx.now() }).where(eq(conversions.id, before.id)).returning();
  await writeAudit(db, ctx, { entityType: "conversion", entityId: before.id, action: `status:${to}`, before: { status: before.status }, after: { status: to }, reason });
  return after!;
}

/** Used by the disputes workflow to put a held sale back where it was. */
export async function restoreDisputedConversion(db: DbLike, ctx: TenantContext, conversionId: string, to: "pending" | "approved", reason: string): Promise<Conversion> {
  requirePerm(ctx, "conversions.write");
  const before = await getConversion(db, ctx, conversionId);
  if (before.status !== "disputed") return before;
  return setStatus(db, ctx, before, to, reason);
}

export const reattributeSchema = z.object({
  conversionId: z.string(),
  /** null removes attribution entirely */
  affiliateId: z.string().nullable(),
  programId: z.string().optional(),
  reason: z.string().min(1).max(1000),
});

/** TRK-08: manual attribution correction. Old attribution is superseded, old commission voided, new one created. */
export async function reattributeConversion(db: DbLike, ctx: TenantContext, rawInput: z.input<typeof reattributeSchema>): Promise<RecordConversionResult> {
  requirePerm(ctx, "conversions.write");
  const input = reattributeSchema.parse(rawInput);
  return withTx(db, async (tx) => {
    const before = await getConversion(tx, ctx, input.conversionId);
    const oldCommission = await currentCommission(tx, before.id);
    if (oldCommission?.status === "paid") throw validation("cannot reattribute a conversion whose commission is already paid; use a manual adjustment");
    if (oldCommission) await reverseCommissionRow(tx, ctx, oldCommission, `reattributed: ${input.reason}`, { asVoid: true });
    const oldAttr = await tx.query.attributions.findFirst({ where: and(eq(attributions.conversionId, before.id), isNull(attributions.supersededById)) });

    let attribution: Attribution | null = null;
    let commission: Commission | null = null;
    if (input.affiliateId) {
      const programId = input.programId ?? before.programId;
      if (!programId) throw validation("programId is required");
      const membership = await getMembership(tx, ctx, input.affiliateId, programId);
      if (!membership) throw validation("affiliate is not a member of that program");
      const program = (await tx.query.programs.findFirst({ where: and(eq(programs.id, programId), eq(programs.tenantId, ctx.tenantId)) }))!;
      const decision: AttributionDecision = { affiliateId: input.affiliateId, programId, rule: "manual", source: "link", isTest: program.testMode, candidates: [] };
      attribution = await insertAttribution(tx, ctx, before, decision, input.reason);
      commission = await createCommissionForConversion(tx, ctx, { conversion: before, attributionId: attribution.id, affiliateId: input.affiliateId, program, isTest: program.testMode });
    }
    if (oldAttr) await tx.update(attributions).set({ supersededById: attribution?.id ?? "removed" }).where(eq(attributions.id, oldAttr.id));
    const [conversion] = await tx
      .update(conversions)
      .set({ affiliateId: input.affiliateId, programId: attribution?.programId ?? null, attributionSource: input.affiliateId ? "manual" : "none", updatedAt: ctx.now() })
      .where(eq(conversions.id, before.id))
      .returning();
    await writeAudit(tx, ctx, {
      entityType: "conversion",
      entityId: before.id,
      action: "reattributed",
      before: { affiliateId: before.affiliateId, programId: before.programId, commissionId: oldCommission?.id ?? null },
      after: { affiliateId: input.affiliateId, programId: attribution?.programId ?? null, commissionId: commission?.id ?? null },
      reason: input.reason,
    });
    await emitEvent(tx, ctx, "conversion.reattributed", { type: "conversion", id: before.id }, { from: before.affiliateId, to: input.affiliateId, reason: input.reason });
    return { conversion: conversion!, attribution, commission, duplicate: false };
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getConversion(db: DbLike, ctx: TenantContext, conversionId: string): Promise<Conversion> {
  const row = await db.query.conversions.findFirst({ where: and(eq(conversions.id, conversionId), eq(conversions.tenantId, ctx.tenantId)) });
  if (!row) throw notFound("conversion", conversionId);
  if (ctx.actor.type === "affiliate" && row.affiliateId !== ctx.actor.affiliateId) throw notFound("conversion", conversionId);
  return row;
}

/** Same order id from any source is the same sale: a webhook and an API post for one order must not pay twice. */
export async function findByExternalId(db: DbLike, ctx: TenantContext, _source: string, externalOrderId: string): Promise<Conversion | null> {
  return (
    (await db.query.conversions.findFirst({
      where: and(eq(conversions.tenantId, ctx.tenantId), eq(conversions.externalOrderId, externalOrderId)),
      orderBy: (c, { asc }) => [asc(c.createdAt)],
    })) ?? null
  );
}

export async function listConversions(
  db: DbLike,
  ctx: TenantContext,
  filter: { affiliateId?: string; status?: ConversionStatus; offerId?: string; programId?: string; limit?: number; kind?: ConversionKind | "all" } = {},
): Promise<Conversion[]> {
  if (filter.affiliateId) requireAffiliate(ctx, filter.affiliateId);
  else requirePerm(ctx, "read");
  return db
    .select()
    .from(conversions)
    .where(
      and(
        eq(conversions.tenantId, ctx.tenantId),
        filter.kind === "all" ? undefined : eq(conversions.kind, filter.kind ?? "sale"),
        filter.affiliateId ? eq(conversions.affiliateId, filter.affiliateId) : undefined,
        filter.status ? eq(conversions.status, filter.status) : undefined,
        filter.offerId ? eq(conversions.offerId, filter.offerId) : undefined,
        filter.programId ? eq(conversions.programId, filter.programId) : undefined,
      ),
    )
    .orderBy(desc(conversions.occurredAt))
    .limit(filter.limit ?? 200);
}

/** CONV-03: attribution history + commission for a conversion. */
export async function getConversionTimeline(db: DbLike, ctx: TenantContext, conversionId: string) {
  const conversion = await getConversion(db, ctx, conversionId);
  const attrs = await db.select().from(attributions).where(eq(attributions.conversionId, conversionId)).orderBy(desc(attributions.attributedAt), desc(attributions.seq));
  const history = await db.select().from(commissions).where(eq(commissions.conversionId, conversionId)).orderBy(desc(commissions.createdAt), desc(commissions.seq));
  return { conversion, attributions: attrs, commission: history[0] ?? null, commissionHistory: history };
}

async function loadResult(db: DbLike, conversion: Conversion, duplicate: boolean): Promise<RecordConversionResult> {
  const attribution = await db.query.attributions.findFirst({ where: and(eq(attributions.conversionId, conversion.id)) });
  const commission = await currentCommission(db, conversion.id);
  return { conversion, attribution: attribution ?? null, commission, duplicate };
}

/** The live commission for a conversion is the most recent one; earlier ones were voided by reattribution. */
export async function currentCommission(db: DbLike, conversionId: string): Promise<Commission | null> {
  const rows = await db.select().from(commissions).where(eq(commissions.conversionId, conversionId)).orderBy(desc(commissions.createdAt), desc(commissions.seq)).limit(1);
  return rows[0] ?? null;
}

export function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: string };
  return e?.code === "23505" || e?.cause?.code === "23505" || /duplicate key value/i.test(e?.message ?? "");
}
