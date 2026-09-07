import { and, count, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { DbLike } from "../db/client";
import { affiliateGroupMembers, affiliateGroups, affiliates, clicks, commissions, conversions } from "../db/schema";
import { type TenantContext, require as requirePerm } from "../context";
import type { Period } from "./analytics";

/**
 * Richer analytics (PRD s18 Phase 2 "richer analytics / improved reporting"): trends over time,
 * comparison against the previous period of equal length, a click → sale funnel, and a
 * breakdown by affiliate group. Everything is computed in SQL over the source tables and
 * excludes test-mode data.
 */

export type Granularity = "day" | "week" | "month";
const VALID = ["pending", "approved", "refunded"] as const;
const num = (expr: unknown) => sql<number>`coalesce(${expr}, 0)`.mapWith(Number);

export interface Bucket {
  /** ISO date (UTC) of the bucket start. */
  date: string;
  clicks: number;
  conversions: number;
  attributedConversions: number;
  revenueMinor: number;
  attributedRevenueMinor: number;
  commissionMinor: number;
  newAffiliates: number;
}

function startOfBucket(d: Date, g: Granularity): Date {
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (g === "day") return u;
  if (g === "month") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const dow = (u.getUTCDay() + 6) % 7; // Monday-based weeks, matching Postgres
  return new Date(u.getTime() - dow * 86_400_000);
}

function nextBucket(d: Date, g: Granularity): Date {
  if (g === "day") return new Date(d.getTime() + 86_400_000);
  if (g === "week") return new Date(d.getTime() + 7 * 86_400_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

export function bucketsFor(period: Period, g: Granularity, cap = 400): string[] {
  const out: string[] = [];
  for (let d = startOfBucket(period.from, g); d.getTime() <= period.to.getTime() && out.length < cap; d = nextBucket(d, g)) out.push(d.toISOString().slice(0, 10));
  return out;
}

/** Suggested granularity for a range: days up to ~3 months, weeks up to ~2 years, else months. */
export function autoGranularity(period: Period): Granularity {
  const days = (period.to.getTime() - period.from.getTime()) / 86_400_000;
  return days <= 95 ? "day" : days <= 730 ? "week" : "month";
}

export async function timeseries(db: DbLike, ctx: TenantContext, period: Period, granularity: Granularity = autoGranularity(period)): Promise<{ granularity: Granularity; buckets: Bucket[] }> {
  requirePerm(ctx, "read");
  const t = ctx.tenantId;
  // Literal (validated above) rather than a bind parameter: Postgres must see the identical
  // expression in SELECT and GROUP BY, and two placeholders are not "identical".
  const unit = sql.raw(`'${granularity === "week" ? "week" : granularity === "month" ? "month" : "day"}'`);
  const bucket = (col: unknown) => sql<string>`to_char(date_trunc(${unit}, ${col} at time zone 'UTC'), 'YYYY-MM-DD')`;
  const [clickRows, convRows, commRows, affRows] = await Promise.all([
    db
      .select({ b: bucket(clicks.occurredAt), n: count() })
      .from(clicks)
      .where(and(eq(clicks.tenantId, t), eq(clicks.isTest, false), gte(clicks.occurredAt, period.from), lte(clicks.occurredAt, period.to)))
      .groupBy(bucket(clicks.occurredAt)),
    db
      .select({
        b: bucket(conversions.occurredAt),
        n: count(),
        attributed: num(sql`sum(case when ${conversions.affiliateId} is not null then 1 else 0 end)`),
        revenue: num(sql`sum(${conversions.amountMinor} - ${conversions.refundedAmountMinor})`),
        attributedRevenue: num(sql`sum(case when ${conversions.affiliateId} is not null then ${conversions.amountMinor} - ${conversions.refundedAmountMinor} else 0 end)`),
      })
      .from(conversions)
      .where(and(eq(conversions.tenantId, t), eq(conversions.isTest, false), inArray(conversions.status, VALID), gte(conversions.occurredAt, period.from), lte(conversions.occurredAt, period.to)))
      .groupBy(bucket(conversions.occurredAt)),
    db
      .select({ b: bucket(commissions.createdAt), total: num(sql`sum(${commissions.amountMinor})`) })
      .from(commissions)
      .where(and(eq(commissions.tenantId, t), eq(commissions.isTest, false), sql`${commissions.status} not in ('reversed', 'void')`, gte(commissions.createdAt, period.from), lte(commissions.createdAt, period.to)))
      .groupBy(bucket(commissions.createdAt)),
    db
      .select({ b: bucket(affiliates.createdAt), n: count() })
      .from(affiliates)
      .where(and(eq(affiliates.tenantId, t), gte(affiliates.createdAt, period.from), lte(affiliates.createdAt, period.to)))
      .groupBy(bucket(affiliates.createdAt)),
  ]);
  const byDate = new Map<string, Bucket>();
  for (const date of bucketsFor(period, granularity)) byDate.set(date, { date, clicks: 0, conversions: 0, attributedConversions: 0, revenueMinor: 0, attributedRevenueMinor: 0, commissionMinor: 0, newAffiliates: 0 });
  const get = (b: string) => byDate.get(b) ?? (byDate.set(b, { date: b, clicks: 0, conversions: 0, attributedConversions: 0, revenueMinor: 0, attributedRevenueMinor: 0, commissionMinor: 0, newAffiliates: 0 }), byDate.get(b)!);
  for (const r of clickRows) get(r.b).clicks = r.n;
  for (const r of convRows) {
    const x = get(r.b);
    x.conversions = r.n;
    x.attributedConversions = r.attributed;
    x.revenueMinor = r.revenue;
    x.attributedRevenueMinor = r.attributedRevenue;
  }
  for (const r of commRows) get(r.b).commissionMinor = r.total;
  for (const r of affRows) get(r.b).newAffiliates = r.n;
  return { granularity, buckets: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

export interface PeriodMetrics {
  clicks: number;
  conversions: number;
  attributedConversions: number;
  revenueMinor: number;
  attributedRevenueMinor: number;
  commissionMinor: number;
  newAffiliates: number;
  conversionRate: number;
  averageOrderMinor: number;
}

export async function periodMetrics(db: DbLike, ctx: TenantContext, period: Period): Promise<PeriodMetrics> {
  const t = ctx.tenantId;
  const [[clk], [conv], [comm], [aff]] = await Promise.all([
    db.select({ n: count() }).from(clicks).where(and(eq(clicks.tenantId, t), eq(clicks.isTest, false), gte(clicks.occurredAt, period.from), lte(clicks.occurredAt, period.to))),
    db
      .select({
        n: count(),
        attributed: num(sql`sum(case when ${conversions.affiliateId} is not null then 1 else 0 end)`),
        revenue: num(sql`sum(${conversions.amountMinor} - ${conversions.refundedAmountMinor})`),
        attributedRevenue: num(sql`sum(case when ${conversions.affiliateId} is not null then ${conversions.amountMinor} - ${conversions.refundedAmountMinor} else 0 end)`),
      })
      .from(conversions)
      .where(and(eq(conversions.tenantId, t), eq(conversions.isTest, false), inArray(conversions.status, VALID), gte(conversions.occurredAt, period.from), lte(conversions.occurredAt, period.to))),
    db.select({ total: num(sql`sum(${commissions.amountMinor})`) }).from(commissions).where(and(eq(commissions.tenantId, t), eq(commissions.isTest, false), sql`${commissions.status} not in ('reversed', 'void')`, gte(commissions.createdAt, period.from), lte(commissions.createdAt, period.to))),
    db.select({ n: count() }).from(affiliates).where(and(eq(affiliates.tenantId, t), gte(affiliates.createdAt, period.from), lte(affiliates.createdAt, period.to))),
  ]);
  return {
    clicks: clk!.n,
    conversions: conv!.n,
    attributedConversions: conv!.attributed,
    revenueMinor: conv!.revenue,
    attributedRevenueMinor: conv!.attributedRevenue,
    commissionMinor: comm!.total,
    newAffiliates: aff!.n,
    conversionRate: clk!.n ? Number((conv!.attributed / clk!.n).toFixed(4)) : 0,
    averageOrderMinor: conv!.n ? Math.round(conv!.revenue / conv!.n) : 0,
  };
}

export interface Delta {
  abs: number;
  /** Fraction (0.25 = +25%); null when the previous value was zero. */
  pct: number | null;
}

export function previousPeriod(period: Period): Period {
  const len = period.to.getTime() - period.from.getTime();
  return { from: new Date(period.from.getTime() - len - 1), to: new Date(period.from.getTime() - 1) };
}

export async function compare(db: DbLike, ctx: TenantContext, period: Period): Promise<{ period: Period; previous: Period; current: PeriodMetrics; before: PeriodMetrics; deltas: Record<keyof PeriodMetrics, Delta> }> {
  requirePerm(ctx, "read");
  const previous = previousPeriod(period);
  const [current, before] = await Promise.all([periodMetrics(db, ctx, period), periodMetrics(db, ctx, previous)]);
  const deltas = {} as Record<keyof PeriodMetrics, Delta>;
  for (const key of Object.keys(current) as (keyof PeriodMetrics)[]) {
    const a = current[key];
    const b = before[key];
    deltas[key] = { abs: a - b, pct: b === 0 ? null : Number(((a - b) / b).toFixed(4)) };
  }
  return { period, previous, current, before, deltas };
}

/** Click → attributed sale funnel, with unattributed sales shown alongside so the gap is visible. */
export async function funnel(db: DbLike, ctx: TenantContext, period: Period) {
  requirePerm(ctx, "read");
  const t = ctx.tenantId;
  const [[clk], [conv], [byLink], [byCoupon]] = await Promise.all([
    db.select({ n: count(), affiliates: sql<number>`count(distinct ${clicks.affiliateId})`.mapWith(Number) }).from(clicks).where(and(eq(clicks.tenantId, t), eq(clicks.isTest, false), gte(clicks.occurredAt, period.from), lte(clicks.occurredAt, period.to))),
    db
      .select({ n: count(), attributed: num(sql`sum(case when ${conversions.affiliateId} is not null then 1 else 0 end)`), approved: num(sql`sum(case when ${conversions.status} = 'approved' then 1 else 0 end)`), refunded: num(sql`sum(case when ${conversions.status} = 'refunded' then 1 else 0 end)`) })
      .from(conversions)
      .where(and(eq(conversions.tenantId, t), eq(conversions.isTest, false), inArray(conversions.status, VALID), gte(conversions.occurredAt, period.from), lte(conversions.occurredAt, period.to))),
    db.select({ n: count() }).from(conversions).where(and(eq(conversions.tenantId, t), eq(conversions.isTest, false), inArray(conversions.status, VALID), eq(conversions.attributionSource, "link"), gte(conversions.occurredAt, period.from), lte(conversions.occurredAt, period.to))),
    db.select({ n: count() }).from(conversions).where(and(eq(conversions.tenantId, t), eq(conversions.isTest, false), inArray(conversions.status, VALID), eq(conversions.attributionSource, "coupon"), gte(conversions.occurredAt, period.from), lte(conversions.occurredAt, period.to))),
  ]);
  const stages = [
    { key: "clicks", label: "Affiliate clicks", value: clk!.n },
    { key: "attributed", label: "Attributed sales", value: conv!.attributed },
    { key: "approved", label: "Approved sales", value: conv!.approved },
  ];
  return {
    stages: stages.map((s, i) => ({ ...s, rateFromPrevious: i === 0 ? null : stages[i - 1]!.value ? Number((s.value / stages[i - 1]!.value).toFixed(4)) : null, rateFromTop: i === 0 ? null : stages[0]!.value ? Number((s.value / stages[0]!.value).toFixed(4)) : null })),
    activeAffiliatesWithClicks: clk!.affiliates,
    unattributedSales: conv!.n - conv!.attributed,
    refundedSales: conv!.refunded,
    bySource: { link: byLink!.n, coupon: byCoupon!.n, manual: conv!.attributed - byLink!.n - byCoupon!.n },
  };
}

/** Performance by affiliate group (affiliates in several groups count in each). */
export async function byGroup(db: DbLike, ctx: TenantContext, period: Period) {
  requirePerm(ctx, "read");
  const t = ctx.tenantId;
  const groups = await db.select().from(affiliateGroups).where(eq(affiliateGroups.tenantId, t));
  if (!groups.length) return { rows: [] };
  const members = await db.select({ groupId: affiliateGroupMembers.groupId, affiliateId: affiliateGroupMembers.affiliateId }).from(affiliateGroupMembers).where(eq(affiliateGroupMembers.tenantId, t));
  const affiliateIds = [...new Set(members.map((m) => m.affiliateId))];
  if (!affiliateIds.length) return { rows: groups.map((g) => ({ groupId: g.id, name: g.name, kind: g.kind, affiliates: 0, clicks: 0, conversions: 0, revenueMinor: 0, commissionMinor: 0 })) };
  const [clickRows, convRows, commRows] = await Promise.all([
    db.select({ affiliateId: clicks.affiliateId, n: count() }).from(clicks).where(and(eq(clicks.tenantId, t), eq(clicks.isTest, false), inArray(clicks.affiliateId, affiliateIds), gte(clicks.occurredAt, period.from), lte(clicks.occurredAt, period.to))).groupBy(clicks.affiliateId),
    db
      .select({ affiliateId: conversions.affiliateId, n: count(), revenue: num(sql`sum(${conversions.amountMinor} - ${conversions.refundedAmountMinor})`) })
      .from(conversions)
      .where(and(eq(conversions.tenantId, t), eq(conversions.isTest, false), inArray(conversions.status, VALID), inArray(conversions.affiliateId, affiliateIds), gte(conversions.occurredAt, period.from), lte(conversions.occurredAt, period.to)))
      .groupBy(conversions.affiliateId),
    db
      .select({ affiliateId: commissions.affiliateId, total: num(sql`sum(${commissions.amountMinor})`) })
      .from(commissions)
      .where(and(eq(commissions.tenantId, t), eq(commissions.isTest, false), sql`${commissions.status} not in ('reversed', 'void')`, inArray(commissions.affiliateId, affiliateIds), gte(commissions.createdAt, period.from), lte(commissions.createdAt, period.to)))
      .groupBy(commissions.affiliateId),
  ]);
  const rows = groups.map((g) => {
    const ids = members.filter((m) => m.groupId === g.id).map((m) => m.affiliateId);
    const sum = <T extends { affiliateId: string | null }>(list: T[], pick: (r: T) => number) => list.filter((r) => r.affiliateId && ids.includes(r.affiliateId)).reduce((s, r) => s + pick(r), 0);
    return {
      groupId: g.id,
      name: g.name,
      kind: g.kind,
      affiliates: ids.length,
      clicks: sum(clickRows, (r) => r.n),
      conversions: sum(convRows, (r) => r.n),
      revenueMinor: sum(convRows, (r) => r.revenue),
      commissionMinor: sum(commRows, (r) => r.total),
    };
  });
  return { rows: rows.sort((a, b) => b.revenueMinor - a.revenueMinor) };
}
