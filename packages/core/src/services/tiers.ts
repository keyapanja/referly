import { and, asc, count, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { affiliateGroups, conversions, programRateTiers, programs, type ProgramRateTier } from "../db/schema";
import { newId } from "../ids";
import { notFound, validation } from "../errors";
import { type TenantContext, require as requirePerm } from "../context";
import { writeAudit, snapshot } from "./audit";
import { groupIdsForAffiliate } from "./groups";

/**
 * Commission tiers (PROG-11): different rates by affiliate group or by performance. Tiers are
 * resolved when a commission is created and the chosen tier is recorded on the commission, so
 * editing tiers later never changes historical amounts.
 *
 * Precedence inside a program: group tier (highest priority wins) before performance tier.
 * Performance is measured on the affiliate's earlier conversions in the program (not counting
 * the one being paid), optionally inside a rolling window, so the result is deterministic.
 */

export const tierSchema = z
  .object({
    name: z.string().min(1).max(80),
    kind: z.enum(["group", "performance"]),
    groupId: z.string().nullable().optional(),
    metric: z.enum(["conversions", "revenue"]).nullable().optional(),
    threshold: z.number().int().positive().nullable().optional(),
    /** Rolling window for performance tiers; null means lifetime within the program. */
    windowDays: z.number().int().positive().max(3650).nullable().optional(),
    commissionModel: z.enum(["percentage", "fixed"]).default("percentage"),
    commissionPercent: z.number().min(0).max(100).optional(),
    commissionFixedMinor: z.number().int().min(0).optional(),
    priority: z.number().int().min(0).max(1000).default(0),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "group" && !v.groupId) ctx.addIssue({ code: "custom", path: ["groupId"], message: "group tiers need a group" });
    if (v.kind === "performance" && (!v.metric || !v.threshold)) ctx.addIssue({ code: "custom", path: ["threshold"], message: "performance tiers need a metric and a threshold" });
    if (v.commissionModel === "percentage" && v.commissionPercent == null) ctx.addIssue({ code: "custom", path: ["commissionPercent"], message: "percentage tiers need a percent" });
    if (v.commissionModel === "fixed" && v.commissionFixedMinor == null) ctx.addIssue({ code: "custom", path: ["commissionFixedMinor"], message: "fixed tiers need an amount" });
  });
export type TierInput = z.input<typeof tierSchema>;

export async function createTier(db: DbLike, ctx: TenantContext, programId: string, rawInput: TierInput): Promise<ProgramRateTier> {
  requirePerm(ctx, "programs.write");
  const input = tierSchema.parse(rawInput);
  const program = await db.query.programs.findFirst({ where: and(eq(programs.id, programId), eq(programs.tenantId, ctx.tenantId)) });
  if (!program) throw notFound("program", programId);
  if (input.kind === "group") {
    const group = await db.query.affiliateGroups.findFirst({ where: and(eq(affiliateGroups.id, input.groupId!), eq(affiliateGroups.tenantId, ctx.tenantId)) });
    if (!group) throw notFound("affiliate group", input.groupId!);
  }
  const [row] = await db
    .insert(programRateTiers)
    .values({
      id: newId("rateTier"),
      tenantId: ctx.tenantId,
      programId,
      name: input.name,
      kind: input.kind,
      groupId: input.kind === "group" ? input.groupId! : null,
      metric: input.kind === "performance" ? input.metric! : null,
      threshold: input.kind === "performance" ? input.threshold! : null,
      windowDays: input.kind === "performance" ? (input.windowDays ?? null) : null,
      commissionModel: input.commissionModel,
      commissionRateBps: input.commissionModel === "percentage" ? Math.round(input.commissionPercent! * 100) : null,
      commissionFixedMinor: input.commissionModel === "fixed" ? input.commissionFixedMinor! : null,
      priority: input.priority,
      createdAt: ctx.now(),
    })
    .returning();
  await writeAudit(db, ctx, { entityType: "program_rate_tier", entityId: row!.id, action: "created", after: snapshot(row!) });
  return row!;
}

export async function updateTier(db: DbLike, ctx: TenantContext, programId: string, tierId: string, rawInput: TierInput): Promise<ProgramRateTier> {
  requirePerm(ctx, "programs.write");
  const before = await getTier(db, ctx, programId, tierId);
  const input = tierSchema.parse(rawInput);
  const [after] = await db
    .update(programRateTiers)
    .set({
      name: input.name,
      kind: input.kind,
      groupId: input.kind === "group" ? input.groupId! : null,
      metric: input.kind === "performance" ? input.metric! : null,
      threshold: input.kind === "performance" ? input.threshold! : null,
      windowDays: input.kind === "performance" ? (input.windowDays ?? null) : null,
      commissionModel: input.commissionModel,
      commissionRateBps: input.commissionModel === "percentage" ? Math.round(input.commissionPercent! * 100) : null,
      commissionFixedMinor: input.commissionModel === "fixed" ? input.commissionFixedMinor! : null,
      priority: input.priority,
    })
    .where(eq(programRateTiers.id, tierId))
    .returning();
  await writeAudit(db, ctx, { entityType: "program_rate_tier", entityId: tierId, action: "updated", before: snapshot(before), after: snapshot(after!) });
  return after!;
}

export async function deleteTier(db: DbLike, ctx: TenantContext, programId: string, tierId: string): Promise<void> {
  requirePerm(ctx, "programs.write");
  const before = await getTier(db, ctx, programId, tierId);
  await db.delete(programRateTiers).where(eq(programRateTiers.id, tierId));
  await writeAudit(db, ctx, { entityType: "program_rate_tier", entityId: tierId, action: "deleted", before: snapshot(before) });
}

export async function getTier(db: DbLike, ctx: TenantContext, programId: string, tierId: string): Promise<ProgramRateTier> {
  const row = await db.query.programRateTiers.findFirst({ where: and(eq(programRateTiers.id, tierId), eq(programRateTiers.tenantId, ctx.tenantId), eq(programRateTiers.programId, programId)) });
  if (!row) throw notFound("rate tier", tierId);
  return row;
}

export async function listTiers(db: DbLike, ctx: TenantContext, programId: string): Promise<(ProgramRateTier & { groupName: string | null })[]> {
  const rows = await db
    .select({ tier: programRateTiers, groupName: affiliateGroups.name })
    .from(programRateTiers)
    .leftJoin(affiliateGroups, eq(affiliateGroups.id, programRateTiers.groupId))
    .where(and(eq(programRateTiers.tenantId, ctx.tenantId), eq(programRateTiers.programId, programId)))
    .orderBy(asc(programRateTiers.kind), asc(programRateTiers.threshold), asc(programRateTiers.name));
  return rows.map((r) => ({ ...r.tier, groupName: r.groupName }));
}

export interface PerformanceMetrics {
  conversions: number;
  revenueMinor: number;
}

/** Earlier, countable conversions of this affiliate in the program, optionally inside a rolling window ending at `at`. */
export async function performanceBefore(db: DbLike, ctx: TenantContext, args: { programId: string; affiliateId: string; at: Date; windowDays: number | null; excludeConversionId?: string | null }): Promise<PerformanceMetrics> {
  const since = args.windowDays ? new Date(args.at.getTime() - args.windowDays * 86_400_000) : null;
  const [agg] = await db
    .select({ n: count(), revenue: sql<number>`coalesce(sum(${conversions.amountMinor} - ${conversions.refundedAmountMinor}), 0)` })
    .from(conversions)
    .where(
      and(
        eq(conversions.tenantId, ctx.tenantId),
        eq(conversions.kind, "sale"),
        eq(conversions.programId, args.programId),
        eq(conversions.affiliateId, args.affiliateId),
        eq(conversions.isTest, false),
        lte(conversions.occurredAt, args.at),
        args.excludeConversionId ? ne(conversions.id, args.excludeConversionId) : undefined,
        since ? gte(conversions.occurredAt, since) : undefined,
        sql`${conversions.status} not in ('cancelled', 'reversed')`,
      ),
    );
  return { conversions: agg!.n, revenueMinor: Number(agg!.revenue) };
}

function metricValue(m: PerformanceMetrics, metric: string | null): number {
  return metric === "revenue" ? m.revenueMinor : m.conversions;
}

/** The tier that applies to this affiliate in this program at `at`, or null. */
export async function resolveTier(db: DbLike, ctx: TenantContext, args: { programId: string; affiliateId: string; at: Date; excludeConversionId?: string | null }): Promise<ProgramRateTier | null> {
  const tiers = await db.select().from(programRateTiers).where(and(eq(programRateTiers.tenantId, ctx.tenantId), eq(programRateTiers.programId, args.programId)));
  if (!tiers.length) return null;
  const groupTiers = tiers.filter((t) => t.kind === "group");
  if (groupTiers.length) {
    const memberOf = new Set(await groupIdsForAffiliate(db, ctx, args.affiliateId));
    const eligible = groupTiers.filter((t) => t.groupId && memberOf.has(t.groupId)).sort((a, b) => b.priority - a.priority || (b.commissionRateBps ?? 0) - (a.commissionRateBps ?? 0));
    if (eligible[0]) return eligible[0];
  }
  const perfTiers = tiers.filter((t) => t.kind === "performance");
  if (!perfTiers.length) return null;
  // one metrics query per distinct window keeps this cheap
  const byWindow = new Map<string, PerformanceMetrics>();
  const qualifying: ProgramRateTier[] = [];
  for (const t of perfTiers) {
    const key = String(t.windowDays ?? "lifetime");
    if (!byWindow.has(key)) byWindow.set(key, await performanceBefore(db, ctx, { ...args, windowDays: t.windowDays }));
    if (metricValue(byWindow.get(key)!, t.metric) >= (t.threshold ?? 0)) qualifying.push(t);
  }
  qualifying.sort((a, b) => (b.threshold ?? 0) - (a.threshold ?? 0) || b.priority - a.priority);
  return qualifying[0] ?? null;
}

export interface TierStatus {
  current: (ProgramRateTier & { groupName: string | null }) | null;
  metrics: PerformanceMetrics;
  next: { tier: ProgramRateTier; remaining: number } | null;
}

/** Portal view: which tier applies now and what it takes to reach the next performance tier. */
export async function affiliateTierStatus(db: DbLike, ctx: TenantContext, affiliateId: string, programId: string, at: Date = ctx.now()): Promise<TierStatus> {
  const tiers = await listTiers(db, ctx, programId);
  const current = await resolveTier(db, ctx, { programId, affiliateId, at });
  const perf = tiers.filter((t) => t.kind === "performance");
  const metrics = await performanceBefore(db, ctx, { programId, affiliateId, at, windowDays: perf[0]?.windowDays ?? null });
  let next: TierStatus["next"] = null;
  if (current?.kind !== "group") {
    const above = perf.filter((t) => (t.threshold ?? 0) > metricValue(metrics, t.metric)).sort((a, b) => (a.threshold ?? 0) - (b.threshold ?? 0));
    if (above[0]) next = { tier: above[0], remaining: (above[0].threshold ?? 0) - metricValue(metrics, above[0].metric) };
  }
  return { current: current ? (tiers.find((t) => t.id === current.id) ?? { ...current, groupName: null }) : null, metrics, next };
}

/** Tiers referencing these groups, for listings. */
export async function tiersForGroups(db: DbLike, ctx: TenantContext, groupIds: string[]): Promise<ProgramRateTier[]> {
  if (!groupIds.length) return [];
  return db.select().from(programRateTiers).where(and(eq(programRateTiers.tenantId, ctx.tenantId), inArray(programRateTiers.groupId, groupIds)));
}
