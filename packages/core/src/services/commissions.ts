import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import type { DbLike, Tx } from "../db/client";
import { withTx } from "../db/client";
import {
  affiliates,
  affiliatePrograms,
  commissions,
  conversions,
  ledgerEntries,
  programOffers,
  programs,
  type AffiliateProgram,
  type Campaign,
  type Commission,
  type ProgramRateTier,
  type CommissionCalculationBasis,
  type Conversion,
  type LedgerEntry,
  type Program,
  type ProgramOffer,
} from "../db/schema";
import { newId } from "../ids";
import { notFound, validation } from "../errors";
import { type TenantContext, require as requirePerm, requireAffiliate } from "../context";
import { writeAudit } from "./audit";
import { emitEvent } from "./events";
import { COMMISSION_TRANSITIONS, assertTransition, type CommissionStatus } from "../statemachine";
import { applyBasisPoints, assertMinorUnits, type MinorUnits } from "../money";
import { resolveTier } from "./tiers";

// ---------------------------------------------------------------------------
// Calculation (COMM-01)
// ---------------------------------------------------------------------------

export interface RateResolution {
  model: "percentage" | "fixed";
  rateBps?: number;
  fixedMinor?: number;
  overrideSource: CommissionCalculationBasis["overrideSource"];
  tierId?: string;
  tierName?: string;
}

/** Precedence: live campaign > affiliate-specific override > rate tier (group, then performance) > program-offer override > program default. */
export function resolveRate(program: Program, programOffer?: ProgramOffer | null, membership?: AffiliateProgram | null, campaign?: Campaign | null, tier?: ProgramRateTier | null): RateResolution {
  if (campaign?.commissionRateBpsOverride != null) return { model: "percentage", rateBps: campaign.commissionRateBpsOverride, overrideSource: "campaign" };
  if (campaign?.commissionFixedMinorOverride != null) return { model: "fixed", fixedMinor: campaign.commissionFixedMinorOverride, overrideSource: "campaign" };
  if (membership?.customCommissionRateBps != null) return { model: "percentage", rateBps: membership.customCommissionRateBps, overrideSource: "affiliate_program" };
  if (membership?.customCommissionFixedMinor != null) return { model: "fixed", fixedMinor: membership.customCommissionFixedMinor, overrideSource: "affiliate_program" };
  if (tier?.commissionModel === "percentage" && tier.commissionRateBps != null) return { model: "percentage", rateBps: tier.commissionRateBps, overrideSource: "tier", tierId: tier.id, tierName: tier.name };
  if (tier?.commissionModel === "fixed" && tier.commissionFixedMinor != null) return { model: "fixed", fixedMinor: tier.commissionFixedMinor, overrideSource: "tier", tierId: tier.id, tierName: tier.name };
  if (programOffer?.commissionRateBpsOverride != null) return { model: "percentage", rateBps: programOffer.commissionRateBpsOverride, overrideSource: "program_offer" };
  if (programOffer?.commissionFixedMinorOverride != null) return { model: "fixed", fixedMinor: programOffer.commissionFixedMinorOverride, overrideSource: "program_offer" };
  if (program.commissionModel === "fixed") return { model: "fixed", fixedMinor: program.commissionFixedMinor, overrideSource: "program" };
  return { model: "percentage", rateBps: program.commissionRateBps, overrideSource: "program" };
}

export function basisAmount(conversion: Pick<Conversion, "amountMinor" | "netAmountMinor" | "eligibleAmountMinor">, basis: string): MinorUnits {
  switch (basis) {
    case "net":
      return conversion.netAmountMinor ?? conversion.amountMinor;
    case "eligible":
      return conversion.eligibleAmountMinor ?? conversion.netAmountMinor ?? conversion.amountMinor;
    default:
      return conversion.amountMinor;
  }
}

export function computeCommission(
  conversion: Pick<Conversion, "amountMinor" | "netAmountMinor" | "eligibleAmountMinor">,
  program: Pick<Program, "commissionBasis">,
  rate: RateResolution,
): { amountMinor: MinorUnits; basis: CommissionCalculationBasis } {
  const base = basisAmount(conversion, program.commissionBasis);
  assertMinorUnits(base, "basis amount");
  const amountMinor = rate.model === "fixed" ? (rate.fixedMinor ?? 0) : applyBasisPoints(base, rate.rateBps ?? 0);
  return {
    amountMinor,
    basis: {
      model: rate.model,
      basis: program.commissionBasis as CommissionCalculationBasis["basis"],
      basisAmountMinor: base,
      rateBps: rate.rateBps,
      fixedMinor: rate.fixedMinor,
      overrideSource: rate.overrideSource,
      ...(rate.tierId ? { tierId: rate.tierId, tierName: rate.tierName } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Ledger (COMM-04): append-only
// ---------------------------------------------------------------------------

export type LedgerType = "credit" | "reversal" | "clawback" | "adjustment" | "payout";

export async function writeLedger(
  db: DbLike,
  ctx: TenantContext,
  entry: { affiliateId: string; commissionId?: string | null; payoutId?: string | null; type: LedgerType; amountMinor: number; currency: string; reason?: string | null },
): Promise<LedgerEntry> {
  assertMinorUnits(entry.amountMinor, "ledger amount");
  const [row] = await db
    .insert(ledgerEntries)
    .values({
      id: newId("ledgerEntry"),
      tenantId: ctx.tenantId,
      affiliateId: entry.affiliateId,
      commissionId: entry.commissionId ?? null,
      payoutId: entry.payoutId ?? null,
      type: entry.type,
      amountMinor: entry.amountMinor,
      currency: entry.currency,
      reason: entry.reason ?? null,
      actorUserId: ctx.actor.type === "user" ? (ctx.actor.id ?? null) : null,
      createdAt: ctx.now(),
    })
    .returning();
  return row!;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface CreateCommissionArgs {
  conversion: Conversion;
  attributionId: string | null;
  affiliateId: string;
  program: Program;
  isTest: boolean;
  /** Live campaign the affiliate is an active participant in, if any. */
  campaign?: Campaign | null;
}

/** Called inside the conversion transaction. Snapshots the rate so later rule edits do not change it. */
export async function createCommissionForConversion(tx: Tx, ctx: TenantContext, args: CreateCommissionArgs): Promise<Commission> {
  const [programOffer, membership] = await Promise.all([
    args.conversion.offerId
      ? tx.query.programOffers.findFirst({ where: and(eq(programOffers.programId, args.program.id), eq(programOffers.offerId, args.conversion.offerId)) })
      : Promise.resolve(null),
    tx.query.affiliatePrograms.findFirst({ where: and(eq(affiliatePrograms.affiliateId, args.affiliateId), eq(affiliatePrograms.programId, args.program.id)) }),
  ]);
  // Leads earn the program's fixed lead amount; tiers, overrides and campaigns are sale terms.
  const isLead = args.conversion.kind === "lead";
  const tier = isLead ? null : await resolveTier(tx, ctx, { programId: args.program.id, affiliateId: args.affiliateId, at: args.conversion.occurredAt, excludeConversionId: args.conversion.id });
  const rate = isLead ? ({ model: "fixed", rateBps: null, fixedMinor: args.program.leadsEnabled ? args.program.leadCommissionMinor : 0, overrideSource: "lead" } as unknown as RateResolution) : resolveRate(args.program, programOffer, membership, args.campaign, tier);
  const { amountMinor, basis } = computeCommission(args.conversion, args.program, rate);
  const payableAt = new Date(args.conversion.occurredAt.getTime() + args.program.holdingDays * 86_400_000);
  const [row] = await tx
    .insert(commissions)
    .values({
      id: newId("commission"),
      tenantId: ctx.tenantId,
      conversionId: args.conversion.id,
      attributionId: args.attributionId,
      affiliateId: args.affiliateId,
      programId: args.program.id,
      campaignId: args.campaign?.id ?? null,
      amountMinor,
      originalAmountMinor: amountMinor,
      currency: args.conversion.currency,
      status: "pending",
      calculationBasis: basis,
      payableAt,
      isTest: args.isTest,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    })
    .returning();
  await writeLedger(tx, ctx, { affiliateId: args.affiliateId, commissionId: row!.id, type: "credit", amountMinor, currency: row!.currency, reason: "commission created" });
  await emitEvent(tx, ctx, "commission.created", { type: "commission", id: row!.id }, { affiliateId: args.affiliateId, amountMinor, currency: row!.currency, conversionId: args.conversion.id });
  return row!;
}

export async function getCommission(db: DbLike, ctx: TenantContext, commissionId: string): Promise<Commission> {
  const row = await db.query.commissions.findFirst({ where: and(eq(commissions.id, commissionId), eq(commissions.tenantId, ctx.tenantId)) });
  if (!row) throw notFound("commission", commissionId);
  requireAffiliate(ctx, row.affiliateId);
  return row;
}

async function setStatus(db: DbLike, ctx: TenantContext, before: Commission, to: CommissionStatus, extra: Partial<Commission> = {}, reason?: string): Promise<Commission> {
  assertTransition("commission", COMMISSION_TRANSITIONS, before.status as CommissionStatus, to);
  const [after] = await db
    .update(commissions)
    .set({ status: to, updatedAt: ctx.now(), ...extra })
    .where(and(eq(commissions.id, before.id), eq(commissions.tenantId, ctx.tenantId)))
    .returning();
  await writeAudit(db, ctx, { entityType: "commission", entityId: before.id, action: `status:${to}`, before: { status: before.status, amountMinor: before.amountMinor }, after: { status: to, amountMinor: after!.amountMinor }, reason });
  return after!;
}

export async function approveCommission(db: DbLike, ctx: TenantContext, commissionId: string, reason?: string): Promise<Commission> {
  requirePerm(ctx, "commissions.write");
  const before = await getCommission(db, ctx, commissionId);
  const after = await setStatus(db, ctx, before, "approved", { approvedAt: ctx.now() }, reason);
  await emitEvent(db, ctx, "commission.approved", { type: "commission", id: commissionId }, { affiliateId: after.affiliateId, amountMinor: after.amountMinor, currency: after.currency });
  return after;
}

/**
 * "Pay this one now": ends the holding period for a single commission so it can go into a payout
 * today. Same destination as the scheduled settlement below, reached by hand.
 */
export async function releaseCommission(db: DbLike, ctx: TenantContext, commissionId: string, reason?: string): Promise<Commission> {
  requirePerm(ctx, "commissions.write");
  const before = await getCommission(db, ctx, commissionId);
  if (before.status === "payable") return before; // already released
  if (before.isTest) throw validation("test commissions are never paid out");
  const conversion = await db.query.conversions.findFirst({ where: and(eq(conversions.id, before.conversionId), eq(conversions.tenantId, ctx.tenantId)) });
  if (conversion?.status === "disputed") throw validation("this sale is disputed: resolve the dispute before releasing its commission");
  const now = ctx.now();
  const after = await setStatus(db, ctx, before, "payable", { approvedAt: before.approvedAt ?? now, payableAt: now }, reason ?? "holding period ended by hand");
  await emitEvent(db, ctx, "commission.payable", { type: "commission", id: commissionId }, { affiliateId: after.affiliateId, amountMinor: after.amountMinor, currency: after.currency, released: true });
  return after;
}

/**
 * COMM-03 / journey F: once the holding period has elapsed, pending and approved commissions
 * become payable. Disputed conversions and test-mode commissions are held back. Idempotent;
 * run from the job worker.
 */
export async function settleHoldingPeriods(db: DbLike, ctx: TenantContext, now: Date = ctx.now()): Promise<Commission[]> {
  requirePerm(ctx, "commissions.write");
  const due = await db
    .select({ commission: commissions, conversionStatus: conversions.status })
    .from(commissions)
    .innerJoin(conversions, eq(commissions.conversionId, conversions.id))
    .where(and(eq(commissions.tenantId, ctx.tenantId), inArray(commissions.status, ["pending", "approved"]), lte(commissions.payableAt, now), eq(commissions.isTest, false)));
  const settled: Commission[] = [];
  for (const { commission, conversionStatus } of due) {
    if (conversionStatus === "disputed") continue;
    const after = await setStatus(db, ctx, commission, "payable", { approvedAt: commission.approvedAt ?? now }, "holding period elapsed");
    await emitEvent(db, ctx, "commission.payable", { type: "commission", id: after.id }, { affiliateId: after.affiliateId, amountMinor: after.amountMinor, currency: after.currency });
    settled.push(after);
  }
  return settled;
}

/** Full reversal of an unpaid commission. Paid commissions are clawed back through the ledger instead. */
export async function reverseCommission(db: DbLike, ctx: TenantContext, commissionId: string, reason: string, opts: { asVoid?: boolean } = {}): Promise<Commission> {
  requirePerm(ctx, "commissions.write");
  if (!reason?.trim()) throw validation("a reason is required to reverse a commission");
  return withTx(db, async (tx) => {
    const before = await getCommission(tx, ctx, commissionId);
    return reverseCommissionRow(tx, ctx, before, reason, opts);
  });
}

export async function reverseCommissionRow(tx: Tx, ctx: TenantContext, before: Commission, reason: string, opts: { asVoid?: boolean } = {}): Promise<Commission> {
  if (before.status === "reversed" || before.status === "void") return before;
  if (before.status === "paid") {
    await writeLedger(tx, ctx, { affiliateId: before.affiliateId, commissionId: before.id, type: "clawback", amountMinor: -before.amountMinor, currency: before.currency, reason });
    await writeAudit(tx, ctx, { entityType: "commission", entityId: before.id, action: "clawback", before: { amountMinor: before.amountMinor }, after: { clawbackMinor: -before.amountMinor }, reason });
    await emitEvent(tx, ctx, "commission.reversed", { type: "commission", id: before.id }, { affiliateId: before.affiliateId, amountMinor: before.amountMinor, currency: before.currency, reason, clawback: true });
    return before;
  }
  const to: CommissionStatus = opts.asVoid ? "void" : "reversed";
  if (before.amountMinor !== 0)
    await writeLedger(tx, ctx, { affiliateId: before.affiliateId, commissionId: before.id, type: "reversal", amountMinor: -before.amountMinor, currency: before.currency, reason });
  const after = await setStatus(tx, ctx, before, to, { reversedAt: ctx.now(), amountMinor: 0 }, reason);
  await emitEvent(tx, ctx, "commission.reversed", { type: "commission", id: before.id }, { affiliateId: before.affiliateId, amountMinor: before.amountMinor, currency: before.currency, reason });
  return after;
}

/** Partial reduction (partial refunds). Keeps status; reverses fully if the new amount is zero. */
export async function reduceCommissionRow(tx: Tx, ctx: TenantContext, before: Commission, newAmountMinor: number, reason: string): Promise<Commission> {
  assertMinorUnits(newAmountMinor, "new amount");
  if (before.status === "reversed" || before.status === "void") return before;
  if (newAmountMinor >= before.amountMinor) return before;
  if (newAmountMinor <= 0) return reverseCommissionRow(tx, ctx, before, reason);
  const delta = newAmountMinor - before.amountMinor; // negative
  if (before.status === "paid") {
    await writeLedger(tx, ctx, { affiliateId: before.affiliateId, commissionId: before.id, type: "clawback", amountMinor: delta, currency: before.currency, reason });
    await writeAudit(tx, ctx, { entityType: "commission", entityId: before.id, action: "clawback", before: { amountMinor: before.amountMinor }, after: { clawbackMinor: delta }, reason });
    return before;
  }
  await writeLedger(tx, ctx, { affiliateId: before.affiliateId, commissionId: before.id, type: "reversal", amountMinor: delta, currency: before.currency, reason });
  const [after] = await tx
    .update(commissions)
    .set({ amountMinor: newAmountMinor, updatedAt: ctx.now() })
    .where(eq(commissions.id, before.id))
    .returning();
  await writeAudit(tx, ctx, { entityType: "commission", entityId: before.id, action: "reduced", before: { amountMinor: before.amountMinor }, after: { amountMinor: newAmountMinor }, reason });
  await emitEvent(tx, ctx, "commission.adjusted", { type: "commission", id: before.id }, { affiliateId: before.affiliateId, deltaMinor: delta, currency: before.currency, reason });
  return after!;
}

/** COMM-05: manual credit/debit against an affiliate balance. Signed amount; reason mandatory. */
export async function adjustAffiliateBalance(
  db: DbLike,
  ctx: TenantContext,
  input: { affiliateId: string; amountMinor: number; currency: string; reason: string; commissionId?: string },
): Promise<LedgerEntry> {
  requirePerm(ctx, "commissions.write");
  if (!input.reason?.trim()) throw validation("a reason is required for a manual adjustment");
  const owner = await db.query.affiliates.findFirst({ where: and(eq(affiliates.id, input.affiliateId), eq(affiliates.tenantId, ctx.tenantId)) });
  if (!owner) throw notFound("affiliate", input.affiliateId);
  if (input.amountMinor === 0) throw validation("adjustment amount cannot be zero");
  const entry = await writeLedger(db, ctx, { ...input, type: "adjustment" });
  await writeAudit(db, ctx, { entityType: "ledger_entry", entityId: entry.id, action: "manual_adjustment", after: { affiliateId: input.affiliateId, amountMinor: input.amountMinor }, reason: input.reason });
  await emitEvent(db, ctx, "commission.adjusted", { type: "ledger_entry", id: entry.id }, { affiliateId: input.affiliateId, deltaMinor: input.amountMinor, currency: input.currency, reason: input.reason });
  return entry;
}

// ---------------------------------------------------------------------------
// Balances and statements (COMM-06, s12)
// ---------------------------------------------------------------------------

export interface Balances {
  currency: string | null;
  /** commissions still inside holding/approval */
  pendingMinor: number;
  /** payable commissions not yet in a payout batch + unapplied adjustments/clawbacks */
  availableMinor: number;
  /** amounts snapshotted into draft/processing payouts */
  reservedMinor: number;
  paidMinor: number;
}

const sumNum = (col: unknown) => sql<number>`coalesce(sum(${col}), 0)`.mapWith(Number);

export async function getBalances(db: DbLike, ctx: TenantContext, affiliateId: string): Promise<Balances> {
  requireAffiliate(ctx, affiliateId);
  const scope = and(eq(commissions.tenantId, ctx.tenantId), eq(commissions.affiliateId, affiliateId), eq(commissions.isTest, false));
  const [pending] = await db.select({ v: sumNum(commissions.amountMinor) }).from(commissions).where(and(scope, inArray(commissions.status, ["pending", "approved"])));
  const [available] = await db.select({ v: sumNum(commissions.amountMinor) }).from(commissions).where(and(scope, eq(commissions.status, "payable"), isNull(commissions.payoutId)));
  const [reserved] = await db.select({ v: sumNum(commissions.amountMinor) }).from(commissions).where(and(scope, eq(commissions.status, "payable"), sql`${commissions.payoutId} is not null`));
  const [paid] = await db.select({ v: sumNum(commissions.amountMinor) }).from(commissions).where(and(scope, eq(commissions.status, "paid")));
  const [unapplied] = await db
    .select({ v: sumNum(ledgerEntries.amountMinor) })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.tenantId, ctx.tenantId), eq(ledgerEntries.affiliateId, affiliateId), inArray(ledgerEntries.type, ["adjustment", "clawback"]), isNull(ledgerEntries.payoutId)));
  const [cur] = await db.select({ c: commissions.currency }).from(commissions).where(scope).limit(1);
  return {
    currency: cur?.c ?? null,
    pendingMinor: pending!.v,
    availableMinor: available!.v + unapplied!.v,
    reservedMinor: reserved!.v,
    paidMinor: paid!.v,
  };
}

export async function listCommissions(
  db: DbLike,
  ctx: TenantContext,
  filter: { affiliateId?: string; status?: CommissionStatus; programId?: string; limit?: number } = {},
): Promise<Commission[]> {
  if (filter.affiliateId) requireAffiliate(ctx, filter.affiliateId);
  else requirePerm(ctx, "read");
  return db
    .select()
    .from(commissions)
    .where(
      and(
        eq(commissions.tenantId, ctx.tenantId),
        filter.affiliateId ? eq(commissions.affiliateId, filter.affiliateId) : undefined,
        filter.status ? eq(commissions.status, filter.status) : undefined,
        filter.programId ? eq(commissions.programId, filter.programId) : undefined,
      ),
    )
    .orderBy(desc(commissions.createdAt), desc(commissions.seq))
    .limit(filter.limit ?? 200);
}

export async function listLedger(db: DbLike, ctx: TenantContext, affiliateId: string, period?: { from: Date; to: Date }): Promise<LedgerEntry[]> {
  requireAffiliate(ctx, affiliateId);
  return db
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.tenantId, ctx.tenantId),
        eq(ledgerEntries.affiliateId, affiliateId),
        period ? gte(ledgerEntries.createdAt, period.from) : undefined,
        period ? lte(ledgerEntries.createdAt, period.to) : undefined,
      ),
    )
    .orderBy(desc(ledgerEntries.createdAt), desc(ledgerEntries.seq));
}

/** Period statement: opening/closing are derived from the ledger so they always reconcile. */
export async function commissionStatement(db: DbLike, ctx: TenantContext, affiliateId: string, period: { from: Date; to: Date }) {
  const entries = await listLedger(db, ctx, affiliateId, period);
  const totals: Record<LedgerType, number> = { credit: 0, reversal: 0, clawback: 0, adjustment: 0, payout: 0 };
  for (const e of entries) totals[e.type as LedgerType] += e.amountMinor;
  const netMinor = Object.values(totals).reduce((a, b) => a + b, 0);
  return { affiliateId, period, entries, totals, netMinor, balances: await getBalances(db, ctx, affiliateId) };
}

export async function listProgramsForCommissions(db: DbLike, ctx: TenantContext, programIds: string[]): Promise<Program[]> {
  if (!programIds.length) return [];
  return db.select().from(programs).where(and(eq(programs.tenantId, ctx.tenantId), inArray(programs.id, programIds)));
}
