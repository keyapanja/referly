import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbLike, Tx } from "../db/client";
import { withTx } from "../db/client";
import { affiliates, commissions, ledgerEntries, payouts, tenants, type Commission, type LedgerEntry, type Payout } from "../db/schema";
import { newId } from "../ids";
import { notFound, validation } from "../errors";
import { type TenantContext, require as requirePerm, requireAffiliate } from "../context";
import { writeAudit } from "./audit";
import { emitEvent } from "./events";
import { PAYOUT_TRANSITIONS, assertTransition, type PayoutStatus } from "../statemachine";
import { formatMinorUnits } from "../money";
import { writeLedger } from "./commissions";

/**
 * Payout batches (PAY-04..07). A batch snapshots the exact payable commissions and unapplied
 * ledger adjustments it covers, so the amount is always reconcilable to underlying records.
 */

export interface PayableSummary {
  affiliateId: string;
  currency: string | null;
  commissions: Commission[];
  adjustments: LedgerEntry[];
  totalMinor: number;
  /** Earned but still inside the holding period, so no batch can carry it yet. */
  heldMinor: number;
  heldCount: number;
  /** When the earliest held commission becomes payable. */
  nextPayableAt: Date | null;
}

export async function getPayableSummary(db: DbLike, ctx: TenantContext, affiliateId: string): Promise<PayableSummary> {
  requireAffiliate(ctx, affiliateId);
  const scope = and(eq(commissions.tenantId, ctx.tenantId), eq(commissions.affiliateId, affiliateId), eq(commissions.isTest, false));
  const rows = await db.select().from(commissions).where(and(scope, eq(commissions.status, "payable"), isNull(commissions.payoutId)));
  const heldRows = await db.select().from(commissions).where(and(scope, inArray(commissions.status, ["pending", "approved"])));
  const adjustments = await db
    .select()
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.tenantId, ctx.tenantId), eq(ledgerEntries.affiliateId, affiliateId), inArray(ledgerEntries.type, ["adjustment", "clawback"]), isNull(ledgerEntries.payoutId)));
  const currency = rows[0]?.currency ?? adjustments[0]?.currency ?? heldRows[0]?.currency ?? null;
  const scopedCommissions = rows.filter((c) => c.currency === currency);
  const scopedAdjustments = adjustments.filter((a) => a.currency === currency);
  const scopedHeld = heldRows.filter((c) => c.currency === currency);
  const totalMinor = scopedCommissions.reduce((s, c) => s + c.amountMinor, 0) + scopedAdjustments.reduce((s, a) => s + a.amountMinor, 0);
  return {
    affiliateId,
    currency,
    commissions: scopedCommissions,
    adjustments: scopedAdjustments,
    totalMinor,
    heldMinor: scopedHeld.reduce((s, c) => s + c.amountMinor, 0),
    heldCount: scopedHeld.length,
    nextPayableAt: scopedHeld.reduce<Date | null>((soonest, c) => (!soonest || c.payableAt < soonest ? c.payableAt : soonest), null),
  };
}

export interface AffiliatePayable {
  affiliateId: string;
  currency: string;
  /** What a batch would carry today. */
  payableMinor: number;
  /** Still inside the holding period. */
  heldMinor: number;
  heldCount: number;
  nextPayableAt: Date | null;
}

/** One row per affiliate and currency: what can be paid today, and what is still waiting. */
export async function listPayableBalances(db: DbLike, ctx: TenantContext): Promise<AffiliatePayable[]> {
  requirePerm(ctx, "read");
  const held = sql`${commissions.status} in ('pending', 'approved')`;
  const rows = await db
    .select({
      affiliateId: commissions.affiliateId,
      currency: commissions.currency,
      payableMinor: sql<number>`coalesce(sum(case when ${commissions.status} = 'payable' then ${commissions.amountMinor} else 0 end), 0)`.mapWith(Number),
      heldMinor: sql<number>`coalesce(sum(case when ${held} then ${commissions.amountMinor} else 0 end), 0)`.mapWith(Number),
      heldCount: sql<number>`count(case when ${held} then 1 end)`.mapWith(Number),
      nextPayableAt: sql<string | Date | null>`min(case when ${held} then ${commissions.payableAt} end)`,
    })
    .from(commissions)
    .where(and(eq(commissions.tenantId, ctx.tenantId), inArray(commissions.status, ["pending", "approved", "payable"]), isNull(commissions.payoutId), eq(commissions.isTest, false)))
    .groupBy(commissions.affiliateId, commissions.currency);
  const adjustments = await db
    .select({ affiliateId: ledgerEntries.affiliateId, currency: ledgerEntries.currency, amountMinor: sql<number>`coalesce(sum(${ledgerEntries.amountMinor}), 0)`.mapWith(Number) })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.tenantId, ctx.tenantId), inArray(ledgerEntries.type, ["adjustment", "clawback"]), isNull(ledgerEntries.payoutId)))
    .groupBy(ledgerEntries.affiliateId, ledgerEntries.currency);

  const byKey = new Map<string, AffiliatePayable>();
  for (const r of rows)
    byKey.set(`${r.affiliateId}:${r.currency}`, {
      affiliateId: r.affiliateId,
      currency: r.currency,
      payableMinor: r.payableMinor,
      heldMinor: r.heldMinor,
      heldCount: r.heldCount,
      nextPayableAt: r.nextPayableAt ? new Date(r.nextPayableAt as string | Date) : null,
    });
  for (const a of adjustments) {
    const key = `${a.affiliateId}:${a.currency}`;
    const row = byKey.get(key) ?? { affiliateId: a.affiliateId, currency: a.currency, payableMinor: 0, heldMinor: 0, heldCount: 0, nextPayableAt: null };
    row.payableMinor += a.amountMinor;
    byKey.set(key, row);
  }
  return [...byKey.values()].filter((r) => r.payableMinor !== 0 || r.heldMinor !== 0).sort((a, b) => b.payableMinor - a.payableMinor || b.heldMinor - a.heldMinor);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

/** Why a batch would be empty, in the merchant's terms rather than the schema's. */
function nothingToPay(summary: PayableSummary, now: Date): string {
  if (summary.heldMinor <= 0) return "nothing to pay: this affiliate has no unpaid commissions";
  const amount = formatMinorUnits(summary.heldMinor, summary.currency);
  if (summary.nextPayableAt && summary.nextPayableAt > now) return `nothing payable yet: ${amount} is inside the holding period until ${day(summary.nextPayableAt)}`;
  return `nothing payable yet: ${amount} has finished its holding period but has not been released — use "Settle holding periods" on the Commissions page`;
}

export const createPayoutSchema = z.object({
  affiliateId: z.string(),
  method: z.string().max(40).optional(),
  periodStart: z.coerce.date().optional(),
  periodEnd: z.coerce.date().optional(),
  /** Skip the tenant's minimum payout threshold (e.g. final settlement). */
  ignoreThreshold: z.boolean().default(false),
});

export async function createPayoutBatch(db: DbLike, ctx: TenantContext, rawInput: z.input<typeof createPayoutSchema>): Promise<Payout> {
  requirePerm(ctx, "payouts.write");
  const input = createPayoutSchema.parse(rawInput);
  return withTx(db, async (tx) => {
    const affiliate = await tx.query.affiliates.findFirst({ where: and(eq(affiliates.id, input.affiliateId), eq(affiliates.tenantId, ctx.tenantId)) });
    if (!affiliate) throw notFound("affiliate", input.affiliateId);
    const tenant = (await tx.query.tenants.findFirst({ where: eq(tenants.id, ctx.tenantId) }))!;
    const summary = await getPayableSummary(tx, ctx, input.affiliateId);
    if (summary.totalMinor <= 0)
      throw validation(nothingToPay(summary, ctx.now()), {
        totalMinor: summary.totalMinor,
        heldMinor: summary.heldMinor,
        heldCount: summary.heldCount,
        nextPayableAt: summary.nextPayableAt?.toISOString() ?? null,
        currency: summary.currency,
      });
    const threshold = tenant.defaults.payoutThresholdMinor ?? 0;
    if (!input.ignoreThreshold && summary.totalMinor < threshold)
      throw validation(`${formatMinorUnits(summary.totalMinor, summary.currency)} is below this workspace's payout threshold of ${formatMinorUnits(threshold, summary.currency)}`, {
        totalMinor: summary.totalMinor,
        thresholdMinor: threshold,
        currency: summary.currency,
      });

    const [payout] = await tx
      .insert(payouts)
      .values({
        id: newId("payout"),
        tenantId: ctx.tenantId,
        affiliateId: input.affiliateId,
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        amountMinor: summary.totalMinor,
        currency: summary.currency!,
        status: "draft",
        method: input.method ?? affiliate.payoutMethod ?? null,
        methodRef: affiliate.payoutProfileRef ?? null,
        createdByUserId: ctx.actor.type === "user" ? (ctx.actor.id ?? null) : null,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      })
      .returning();
    if (summary.commissions.length)
      await tx.update(commissions).set({ payoutId: payout!.id, updatedAt: ctx.now() }).where(inArray(commissions.id, summary.commissions.map((c) => c.id)));
    if (summary.adjustments.length) await tx.update(ledgerEntries).set({ payoutId: payout!.id }).where(inArray(ledgerEntries.id, summary.adjustments.map((a) => a.id)));
    await writeAudit(tx, ctx, {
      entityType: "payout",
      entityId: payout!.id,
      action: "created",
      after: { affiliateId: input.affiliateId, amountMinor: summary.totalMinor, commissionIds: summary.commissions.map((c) => c.id), adjustmentIds: summary.adjustments.map((a) => a.id) },
    });
    await emitEvent(tx, ctx, "payout.created", { type: "payout", id: payout!.id }, { affiliateId: input.affiliateId, amountMinor: summary.totalMinor, currency: summary.currency });
    return payout!;
  });
}

/** PAY-03 helper: create draft batches for every affiliate at or above the threshold. */
export async function createPayoutBatchesForAll(db: DbLike, ctx: TenantContext): Promise<Payout[]> {
  requirePerm(ctx, "payouts.write");
  const candidates = await db
    .selectDistinct({ affiliateId: commissions.affiliateId })
    .from(commissions)
    .where(and(eq(commissions.tenantId, ctx.tenantId), eq(commissions.status, "payable"), isNull(commissions.payoutId), eq(commissions.isTest, false)));
  const created: Payout[] = [];
  for (const { affiliateId } of candidates) {
    try {
      created.push(await createPayoutBatch(db, ctx, { affiliateId }));
    } catch (err) {
      if ((err as { code?: string }).code === "validation") continue; // below threshold or nothing payable
      throw err;
    }
  }
  return created;
}

export async function markPayoutProcessing(db: DbLike, ctx: TenantContext, payoutId: string): Promise<Payout> {
  requirePerm(ctx, "payouts.write");
  const before = await getPayout(db, ctx, payoutId);
  return setStatus(db, ctx, before, "processing");
}

/** Marks paid: commissions become `paid` and a payout ledger entry is written, atomically. */
export async function markPayoutPaid(db: DbLike, ctx: TenantContext, payoutId: string, input: { externalReference?: string; paidAt?: Date } = {}): Promise<Payout> {
  requirePerm(ctx, "payouts.write");
  return withTx(db, async (tx) => {
    const before = await getPayout(tx, ctx, payoutId);
    const paidAt = input.paidAt ?? ctx.now();
    const after = await setStatus(tx, ctx, before, "paid", { externalReference: input.externalReference ?? before.externalReference, paidAt });
    await tx.update(commissions).set({ status: "paid", paidAt, updatedAt: ctx.now() }).where(and(eq(commissions.payoutId, payoutId), eq(commissions.status, "payable")));
    await writeLedger(tx, ctx, { affiliateId: before.affiliateId, payoutId, type: "payout", amountMinor: -before.amountMinor, currency: before.currency, reason: input.externalReference ? `paid ref ${input.externalReference}` : "paid" });
    await emitEvent(tx, ctx, "payout.paid", { type: "payout", id: payoutId }, { affiliateId: before.affiliateId, amountMinor: before.amountMinor, currency: before.currency, paidAt: paidAt.toISOString() });
    return after;
  });
}

export async function markPayoutFailed(db: DbLike, ctx: TenantContext, payoutId: string, reason: string): Promise<Payout> {
  requirePerm(ctx, "payouts.write");
  const before = await getPayout(db, ctx, payoutId);
  const after = await setStatus(db, ctx, before, "failed", { failureReason: reason });
  await emitEvent(db, ctx, "payout.failed", { type: "payout", id: payoutId }, { affiliateId: before.affiliateId, reason });
  return after;
}

/** Cancelling releases the snapshotted commissions/adjustments back to the available balance. */
export async function cancelPayout(db: DbLike, ctx: TenantContext, payoutId: string, reason: string): Promise<Payout> {
  requirePerm(ctx, "payouts.write");
  return withTx(db, async (tx) => {
    const before = await getPayout(tx, ctx, payoutId);
    const after = await setStatus(tx, ctx, before, "cancelled", { failureReason: reason });
    await tx.update(commissions).set({ payoutId: null, updatedAt: ctx.now() }).where(eq(commissions.payoutId, payoutId));
    await tx.update(ledgerEntries).set({ payoutId: null }).where(and(eq(ledgerEntries.payoutId, payoutId), inArray(ledgerEntries.type, ["adjustment", "clawback"])));
    return after;
  });
}

/** PAY-07: merchant paid outside the platform; create and settle in one step. */
export async function recordExternalPayout(db: DbLike, ctx: TenantContext, input: { affiliateId: string; externalReference: string; method?: string; paidAt?: Date }): Promise<Payout> {
  requirePerm(ctx, "payouts.write");
  return withTx(db, async (tx) => {
    const payout = await createPayoutBatch(tx, ctx, { affiliateId: input.affiliateId, method: input.method, ignoreThreshold: true });
    return markPayoutPaid(tx, ctx, payout.id, { externalReference: input.externalReference, paidAt: input.paidAt });
  });
}

/** PAY-06: the batch amount must equal the sum of what it covers. */
export async function reconcilePayout(db: DbLike, ctx: TenantContext, payoutId: string) {
  const payout = await getPayout(db, ctx, payoutId);
  const [c] = await db.select({ v: sql<number>`coalesce(sum(${commissions.amountMinor}),0)`.mapWith(Number), n: sql<number>`count(*)`.mapWith(Number) }).from(commissions).where(eq(commissions.payoutId, payoutId));
  const [a] = await db
    .select({ v: sql<number>`coalesce(sum(${ledgerEntries.amountMinor}),0)`.mapWith(Number), n: sql<number>`count(*)`.mapWith(Number) })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.payoutId, payoutId), inArray(ledgerEntries.type, ["adjustment", "clawback"])));
  const expected = c!.v + a!.v;
  return { payout, commissionCount: c!.n, commissionsMinor: c!.v, adjustmentCount: a!.n, adjustmentsMinor: a!.v, expectedMinor: expected, reconciled: expected === payout.amountMinor };
}

async function setStatus(db: DbLike | Tx, ctx: TenantContext, before: Payout, to: PayoutStatus, extra: Partial<Payout> = {}): Promise<Payout> {
  assertTransition("payout", PAYOUT_TRANSITIONS, before.status as PayoutStatus, to);
  const [after] = await db
    .update(payouts)
    .set({ status: to, updatedAt: ctx.now(), ...extra })
    .where(and(eq(payouts.id, before.id), eq(payouts.tenantId, ctx.tenantId)))
    .returning();
  await writeAudit(db, ctx, { entityType: "payout", entityId: before.id, action: `status:${to}`, before: { status: before.status }, after: { status: to, ...extra } });
  return after!;
}

export async function getPayout(db: DbLike, ctx: TenantContext, payoutId: string): Promise<Payout> {
  const row = await db.query.payouts.findFirst({ where: and(eq(payouts.id, payoutId), eq(payouts.tenantId, ctx.tenantId)) });
  if (!row) throw notFound("payout", payoutId);
  requireAffiliate(ctx, row.affiliateId);
  return row;
}

export async function listPayouts(db: DbLike, ctx: TenantContext, filter: { affiliateId?: string; status?: PayoutStatus; limit?: number } = {}): Promise<Payout[]> {
  if (filter.affiliateId) requireAffiliate(ctx, filter.affiliateId);
  else requirePerm(ctx, "read");
  return db
    .select()
    .from(payouts)
    .where(and(eq(payouts.tenantId, ctx.tenantId), filter.affiliateId ? eq(payouts.affiliateId, filter.affiliateId) : undefined, filter.status ? eq(payouts.status, filter.status) : undefined))
    .orderBy(desc(payouts.createdAt))
    .limit(filter.limit ?? 100);
}
