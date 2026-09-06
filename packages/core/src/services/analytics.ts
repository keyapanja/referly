import { and, eq, gte, lte, sql, inArray, count } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { DbLike } from "../db/client";
import { affiliates, clicks, commissions, conversions, offers, payouts, programs } from "../db/schema";
import { type TenantContext, require as requirePerm } from "../context";

/**
 * Merchant analytics (AN-01..AN-06). Aggregations are computed in SQL over source-of-truth
 * tables; nothing is pre-aggregated in V1. Test-mode data is excluded everywhere.
 */

export interface Period {
  from: Date;
  to: Date;
}

const num = (expr: unknown) => sql<number>`coalesce(${expr}, 0)`.mapWith(Number);
const VALID_CONVERSION = ["pending", "approved", "refunded"] as const;

export async function overview(db: DbLike, ctx: TenantContext, period: Period) {
  requirePerm(ctx, "read");
  const t = ctx.tenantId;
  const inPeriod = (col: AnyPgColumn) => and(gte(col, period.from), lte(col, period.to));

  const [conv] = await db
    .select({
      conversions: count(),
      revenueMinor: num(sql`sum(${conversions.amountMinor} - ${conversions.refundedAmountMinor})`),
      attributed: num(sql`sum(case when ${conversions.affiliateId} is not null then 1 else 0 end)`),
      attributedRevenueMinor: num(sql`sum(case when ${conversions.affiliateId} is not null then ${conversions.amountMinor} - ${conversions.refundedAmountMinor} else 0 end)`),
    })
    .from(conversions)
    .where(and(eq(conversions.tenantId, t), eq(conversions.isTest, false), inArray(conversions.status, VALID_CONVERSION), inPeriod(conversions.occurredAt)));

  const [clk] = await db
    .select({ clicks: count() })
    .from(clicks)
    .where(and(eq(clicks.tenantId, t), eq(clicks.isTest, false), inPeriod(clicks.occurredAt)));

  const commissionRows = await db
    .select({ status: commissions.status, total: num(sql`sum(${commissions.amountMinor})`), n: count() })
    .from(commissions)
    .where(and(eq(commissions.tenantId, t), eq(commissions.isTest, false), inPeriod(commissions.createdAt)))
    .groupBy(commissions.status);
  const commissionByStatus: Record<string, { totalMinor: number; count: number }> = {};
  for (const r of commissionRows) commissionByStatus[r.status] = { totalMinor: r.total, count: r.n };

  const [aff] = await db.select({ active: count() }).from(affiliates).where(and(eq(affiliates.tenantId, t), eq(affiliates.status, "active")));
  const [pendingApps] = await db.select({ n: count() }).from(affiliates).where(and(eq(affiliates.tenantId, t), eq(affiliates.status, "applied")));
  const payoutRows = await db
    .select({ status: payouts.status, total: num(sql`sum(${payouts.amountMinor})`), n: count() })
    .from(payouts)
    .where(eq(payouts.tenantId, t))
    .groupBy(payouts.status);
  const payoutsByStatus: Record<string, { totalMinor: number; count: number }> = {};
  for (const r of payoutRows) payoutsByStatus[r.status] = { totalMinor: r.total, count: r.n };
  const [disputes] = await db.select({ n: count() }).from(conversions).where(and(eq(conversions.tenantId, t), eq(conversions.status, "disputed")));

  const attributed = conv!.attributed;
  return {
    period,
    clicks: clk!.clicks,
    conversions: conv!.conversions,
    attributedConversions: attributed,
    revenueMinor: conv!.revenueMinor,
    attributedRevenueMinor: conv!.attributedRevenueMinor,
    conversionRate: clk!.clicks ? Number((attributed / clk!.clicks).toFixed(4)) : 0,
    activeAffiliates: aff!.active,
    commissionByStatus,
    payoutsByStatus,
    needsAttention: {
      pendingApplications: pendingApps!.n,
      failedPayouts: payoutsByStatus.failed?.count ?? 0,
      disputes: disputes!.n,
      draftPayouts: payoutsByStatus.draft?.count ?? 0,
    },
    topAffiliates: await byAffiliate(db, ctx, period, 5),
    topOffers: await byOffer(db, ctx, period, 5),
  };
}

/** AN-02 */
export async function byAffiliate(db: DbLike, ctx: TenantContext, period: Period, limit = 50) {
  requirePerm(ctx, "read");
  const t = ctx.tenantId;
  const rows = await db
    .select({
      affiliateId: affiliates.id,
      name: affiliates.name,
      email: affiliates.email,
      status: affiliates.status,
      conversions: num(sql`count(distinct case when ${conversions.status} in ('pending','approved','refunded') and ${conversions.occurredAt} between ${period.from} and ${period.to} then ${conversions.id} end)`),
      revenueMinor: num(sql`sum(case when ${conversions.status} in ('pending','approved','refunded') and ${conversions.occurredAt} between ${period.from} and ${period.to} then ${conversions.amountMinor} - ${conversions.refundedAmountMinor} else 0 end)`),
      commissionMinor: num(sql`sum(case when ${commissions.status} in ('pending','approved','payable','paid') and ${commissions.createdAt} between ${period.from} and ${period.to} then ${commissions.amountMinor} else 0 end)`),
    })
    .from(affiliates)
    .leftJoin(conversions, and(eq(conversions.affiliateId, affiliates.id), eq(conversions.isTest, false)))
    .leftJoin(commissions, and(eq(commissions.conversionId, conversions.id), eq(commissions.affiliateId, affiliates.id)))
    .where(eq(affiliates.tenantId, t))
    .groupBy(affiliates.id)
    .orderBy(sql`3 desc`)
    .limit(limit);
  const clickRows = await db
    .select({ affiliateId: clicks.affiliateId, n: count() })
    .from(clicks)
    .where(and(eq(clicks.tenantId, t), eq(clicks.isTest, false), gte(clicks.occurredAt, period.from), lte(clicks.occurredAt, period.to)))
    .groupBy(clicks.affiliateId);
  const clickMap = new Map(clickRows.map((r) => [r.affiliateId, r.n]));
  return rows
    .map((r) => ({ ...r, clicks: clickMap.get(r.affiliateId) ?? 0 }))
    .sort((a, b) => b.revenueMinor - a.revenueMinor);
}

/** AN-04 */
export async function byOffer(db: DbLike, ctx: TenantContext, period: Period, limit = 50) {
  requirePerm(ctx, "read");
  const t = ctx.tenantId;
  return db
    .select({
      offerId: offers.id,
      name: offers.name,
      conversions: num(sql`count(distinct case when ${conversions.affiliateId} is not null then ${conversions.id} end)`),
      revenueMinor: num(sql`sum(case when ${conversions.affiliateId} is not null then ${conversions.amountMinor} - ${conversions.refundedAmountMinor} else 0 end)`),
      commissionMinor: num(sql`sum(case when ${commissions.status} in ('pending','approved','payable','paid') then ${commissions.amountMinor} else 0 end)`),
    })
    .from(offers)
    .leftJoin(
      conversions,
      and(eq(conversions.offerId, offers.id), eq(conversions.isTest, false), inArray(conversions.status, VALID_CONVERSION), gte(conversions.occurredAt, period.from), lte(conversions.occurredAt, period.to)),
    )
    .leftJoin(commissions, eq(commissions.conversionId, conversions.id))
    .where(eq(offers.tenantId, t))
    .groupBy(offers.id)
    .orderBy(sql`4 desc`)
    .limit(limit);
}

/** AN-03 */
export async function byProgram(db: DbLike, ctx: TenantContext, period: Period) {
  requirePerm(ctx, "read");
  const t = ctx.tenantId;
  const rows = await db
    .select({
      programId: programs.id,
      name: programs.name,
      status: programs.status,
      conversions: num(sql`count(distinct ${conversions.id})`),
      revenueMinor: num(sql`sum(${conversions.amountMinor} - ${conversions.refundedAmountMinor})`),
      commissionMinor: num(sql`sum(case when ${commissions.status} in ('pending','approved','payable','paid') then ${commissions.amountMinor} else 0 end)`),
    })
    .from(programs)
    .leftJoin(
      conversions,
      and(eq(conversions.programId, programs.id), eq(conversions.isTest, false), inArray(conversions.status, VALID_CONVERSION), gte(conversions.occurredAt, period.from), lte(conversions.occurredAt, period.to)),
    )
    .leftJoin(commissions, eq(commissions.conversionId, conversions.id))
    .where(eq(programs.tenantId, t))
    .groupBy(programs.id);
  const active = await db
    .select({ programId: sql<string>`program_id`, n: count() })
    .from(sql`affiliate_programs`)
    .where(sql`tenant_id = ${t} and status = 'active'`)
    .groupBy(sql`program_id`);
  const map = new Map(active.map((a) => [a.programId, a.n]));
  return rows.map((r) => ({ ...r, activeAffiliates: map.get(r.programId) ?? 0 }));
}

/** AN-06 */
export async function bySource(db: DbLike, ctx: TenantContext, period: Period) {
  requirePerm(ctx, "read");
  return db
    .select({ source: conversions.attributionSource, conversions: count(), revenueMinor: num(sql`sum(${conversions.amountMinor} - ${conversions.refundedAmountMinor})`) })
    .from(conversions)
    .where(and(eq(conversions.tenantId, ctx.tenantId), eq(conversions.isTest, false), inArray(conversions.status, VALID_CONVERSION), gte(conversions.occurredAt, period.from), lte(conversions.occurredAt, period.to)))
    .groupBy(conversions.attributionSource);
}
