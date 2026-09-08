import { and, count, desc, eq, gte, ilike, inArray, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { affiliates, conversions, jobs, messageLogs, tenants, users, webhookOutboundDeliveries, webhookSubscriptions, type Job, type Tenant, type User } from "../db/schema";
import { newId } from "../ids";
import { notFound, validation } from "../errors";
import { tenantContext } from "../context";
import { hashPassword, verifyPassword } from "./auth";
import { writeAudit } from "./audit";
import { PLAN_IDS, getUsage, resolveLimits, getPlan } from "./plans";

/**
 * Platform admin (PRD persona "Platform Admin", s15): cross-tenant operations for the SaaS
 * operator. Callers must already hold the platform_admin role and run with RLS bypass; these
 * functions are the only place in core that reads across tenants on purpose.
 */

export const PLATFORM_TENANT_SLUG = "platform";

export interface PlatformActor {
  userId: string;
}

/** Idempotent bootstrap from environment or CLI: creates the platform tenant and the admin user if missing. */
export async function ensurePlatformAdmin(db: DbLike, input: { email: string; password: string; name?: string }, now = new Date()): Promise<User> {
  const email = input.email.trim().toLowerCase();
  let tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, PLATFORM_TENANT_SLUG) });
  if (!tenant) {
    [tenant] = await db
      .insert(tenants)
      .values({ id: newId("tenant"), name: "Platform", slug: PLATFORM_TENANT_SLUG, status: "active", planId: "enterprise", currency: "USD", timezone: "UTC", createdAt: now, updatedAt: now })
      .returning();
  }
  const existing = await db.query.users.findFirst({ where: and(eq(users.tenantId, tenant!.id), eq(users.email, email)) });
  if (existing) {
    if (!(await verifyPassword(input.password, existing.passwordHash))) console.warn(`[platform] PLATFORM_ADMIN_PASSWORD does not match the existing admin ${email}; the stored password is kept. Change it from the account, or reset it.`);
    return existing;
  }
  const [user] = await db
    .insert(users)
    .values({
      id: newId("user"),
      tenantId: tenant!.id,
      role: "platform_admin",
      name: input.name ?? "Platform admin",
      email,
      passwordHash: await hashPassword(input.password),
      status: "active",
      emailVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return user!;
}

export interface TenantRow {
  tenant: Pick<Tenant, "id" | "name" | "slug" | "status" | "planId" | "currency" | "createdAt">;
  owners: { name: string; email: string }[];
  activeAffiliates: number;
  conversions30d: number;
  revenue30dMinor: number;
}

export async function listTenants(db: DbLike, filter: { q?: string; limit?: number } = {}, now = new Date()): Promise<TenantRow[]> {
  const q = filter.q?.trim();
  const rows = await db
    .select()
    .from(tenants)
    .where(and(sql`${tenants.slug} <> ${PLATFORM_TENANT_SLUG}`, q ? or(ilike(tenants.name, `%${q}%`), ilike(tenants.slug, `%${q}%`)) : undefined))
    .orderBy(desc(tenants.createdAt))
    .limit(filter.limit ?? 100);
  if (!rows.length) return [];
  const ids = rows.map((t) => t.id);
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const [owners, affCounts, convAgg] = await Promise.all([
    db.select({ tenantId: users.tenantId, name: users.name, email: users.email }).from(users).where(and(inArray(users.tenantId, ids), eq(users.role, "owner"))),
    db.select({ tenantId: affiliates.tenantId, n: count() }).from(affiliates).where(and(inArray(affiliates.tenantId, ids), eq(affiliates.status, "active"))).groupBy(affiliates.tenantId),
    db
      .select({ tenantId: conversions.tenantId, n: count(), revenue: sql<number>`coalesce(sum(${conversions.amountMinor} - ${conversions.refundedAmountMinor}), 0)` })
      .from(conversions)
      .where(and(inArray(conversions.tenantId, ids), gte(conversions.createdAt, since), sql`${conversions.status} not in ('cancelled', 'reversed')`))
      .groupBy(conversions.tenantId),
  ]);
  return rows.map((t) => ({
    tenant: { id: t.id, name: t.name, slug: t.slug, status: t.status, planId: t.planId, currency: t.currency, createdAt: t.createdAt },
    owners: owners.filter((o) => o.tenantId === t.id).map((o) => ({ name: o.name, email: o.email })),
    activeAffiliates: affCounts.find((a) => a.tenantId === t.id)?.n ?? 0,
    conversions30d: convAgg.find((c) => c.tenantId === t.id)?.n ?? 0,
    revenue30dMinor: Number(convAgg.find((c) => c.tenantId === t.id)?.revenue ?? 0),
  }));
}

export async function getTenantDetail(db: DbLike, tenantId: string, now = new Date()) {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant || tenant.slug === PLATFORM_TENANT_SLUG) throw notFound("tenant", tenantId);
  const ctx = tenantContext(tenantId, { type: "system", role: "owner" }, () => now);
  const [team, usage] = await Promise.all([
    db.select({ id: users.id, name: users.name, email: users.email, role: users.role, status: users.status, lastLoginAt: users.lastLoginAt }).from(users).where(and(eq(users.tenantId, tenantId), sql`${users.role} <> 'affiliate'`)),
    getUsage(db, ctx),
  ]);
  return { tenant, plan: getPlan(tenant.planId), limits: resolveLimits(tenant), usage, team };
}

export const adminUpdateTenantSchema = z.object({
  status: z.enum(["active", "suspended"]).optional(),
  planId: z.enum(PLAN_IDS).optional(),
  /** Per-tenant overrides; null clears a limit (unlimited), omit a key to keep the plan default. */
  planLimits: z.partialRecord(z.enum(["activeAffiliates", "programs", "teamMembers", "monthlyConversions"]), z.number().int().min(0).nullable()).nullable().optional(),
  reason: z.string().max(500).optional(),
});

export async function updateTenantByAdmin(db: DbLike, admin: PlatformActor, tenantId: string, rawInput: z.input<typeof adminUpdateTenantSchema>, now = new Date()): Promise<Tenant> {
  const input = adminUpdateTenantSchema.parse(rawInput);
  const before = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!before || before.slug === PLATFORM_TENANT_SLUG) throw notFound("tenant", tenantId);
  const patch: Partial<Tenant> = { updatedAt: now };
  if (input.status) patch.status = input.status;
  if (input.planId) patch.planId = input.planId;
  if (input.planLimits !== undefined) patch.planLimits = input.planLimits;
  if (Object.keys(patch).length === 1) throw validation("nothing to update");
  const [after] = await db.update(tenants).set(patch).where(eq(tenants.id, tenantId)).returning();
  const ctx = tenantContext(tenantId, { type: "user", id: admin.userId, role: "platform_admin" }, () => now);
  await writeAudit(db, ctx, {
    entityType: "tenant",
    entityId: tenantId,
    action: "admin_update",
    before: { status: before.status, planId: before.planId, planLimits: before.planLimits },
    after: { status: after!.status, planId: after!.planId, planLimits: after!.planLimits },
    reason: input.reason,
  });
  return after!;
}

export async function platformOverview(db: DbLike, now = new Date()) {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const day = new Date(now.getTime() - 86_400_000);
  const [byStatus, byPlan, [conv], [deadJobs], [failedMail], [newTenants]] = await Promise.all([
    db.select({ status: tenants.status, n: count() }).from(tenants).where(sql`${tenants.slug} <> ${PLATFORM_TENANT_SLUG}`).groupBy(tenants.status),
    db.select({ planId: tenants.planId, n: count() }).from(tenants).where(sql`${tenants.slug} <> ${PLATFORM_TENANT_SLUG}`).groupBy(tenants.planId),
    db
      .select({ n: count(), revenue: sql<number>`coalesce(sum(${conversions.amountMinor} - ${conversions.refundedAmountMinor}), 0)` })
      .from(conversions)
      .where(and(gte(conversions.createdAt, since), sql`${conversions.status} not in ('cancelled', 'reversed')`)),
    db.select({ n: count() }).from(jobs).where(eq(jobs.status, "dead")),
    db.select({ n: count() }).from(messageLogs).where(and(eq(messageLogs.status, "failed"), gte(messageLogs.createdAt, day))),
    db.select({ n: count() }).from(tenants).where(and(gte(tenants.createdAt, since), sql`${tenants.slug} <> ${PLATFORM_TENANT_SLUG}`)),
  ]);
  return {
    tenants: { total: byStatus.reduce((s, r) => s + r.n, 0), byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])), byPlan: Object.fromEntries(byPlan.map((r) => [r.planId, r.n])), new30d: newTenants!.n },
    conversions30d: conv!.n,
    revenue30dMinor: Number(conv!.revenue),
    deadJobs: deadJobs!.n,
    failedEmails24h: failedMail!.n,
  };
}

export async function listProblemJobs(db: DbLike, limit = 100): Promise<Job[]> {
  return db
    .select()
    .from(jobs)
    .where(or(eq(jobs.status, "dead"), and(eq(jobs.status, "queued"), sql`${jobs.lastError} is not null`)))
    .orderBy(desc(jobs.runAt))
    .limit(limit);
}

export async function retryJob(db: DbLike, jobId: string, now = new Date()): Promise<Job> {
  const job = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
  if (!job) throw notFound("job", jobId);
  const [after] = await db.update(jobs).set({ status: "queued", attempts: 0, runAt: now, lockedAt: null }).where(eq(jobs.id, jobId)).returning();
  return after!;
}

/** How long a job may sit in `running` before it counts as stuck (a crashed worker never unlocks it). */
export const STUCK_JOB_MS = 10 * 60 * 1000;

/**
 * Operational state of the whole platform: queue depth, lag, dead letters, stuck jobs, failing
 * webhooks and mail. Read by the platform admin Operations panel and by /metrics on every scrape,
 * so it is a handful of indexed counts and nothing heavier.
 */
export async function opsSummary(db: DbLike, now = new Date()) {
  const hour = new Date(now.getTime() - 3_600_000);
  const day = new Date(now.getTime() - 86_400_000);
  const stuckBefore = new Date(now.getTime() - STUCK_JOB_MS);
  const [byStatus, [retrying], [oldest], [stuck], [doneHour], [deadHour], byType, [deadDeliveries], [pausedSubs], [failedMail]] = await Promise.all([
    db.select({ status: jobs.status, n: count() }).from(jobs).groupBy(jobs.status),
    db.select({ n: count() }).from(jobs).where(and(eq(jobs.status, "queued"), sql`${jobs.lastError} is not null`)),
    db.select({ runAt: sql<string | null>`min(${jobs.runAt})` }).from(jobs).where(and(eq(jobs.status, "queued"), lte(jobs.runAt, now))),
    db.select({ n: count() }).from(jobs).where(and(eq(jobs.status, "running"), lt(jobs.lockedAt, stuckBefore))),
    db.select({ n: count() }).from(jobs).where(and(eq(jobs.status, "done"), gte(jobs.completedAt, hour))),
    db.select({ n: count() }).from(jobs).where(and(eq(jobs.status, "dead"), gte(jobs.runAt, hour))),
    db.select({ type: jobs.type, status: jobs.status, n: count() }).from(jobs).where(sql`${jobs.status} in ('queued', 'running', 'dead')`).groupBy(jobs.type, jobs.status),
    db.select({ n: count() }).from(webhookOutboundDeliveries).where(and(eq(webhookOutboundDeliveries.status, "dead"), gte(webhookOutboundDeliveries.createdAt, day))),
    db.select({ n: count() }).from(webhookSubscriptions).where(eq(webhookSubscriptions.status, "paused")),
    db.select({ n: count() }).from(messageLogs).where(and(eq(messageLogs.status, "failed"), gte(messageLogs.createdAt, day))),
  ]);
  const status = Object.fromEntries(byStatus.map((r) => [r.status, r.n])) as Record<string, number>;
  const oldestRunAt = oldest?.runAt ? new Date(oldest.runAt) : null;
  return {
    at: now.toISOString(),
    queue: {
      queued: status.queued ?? 0,
      running: status.running ?? 0,
      retrying: retrying!.n,
      dead: status.dead ?? 0,
      doneLastHour: doneHour!.n,
      deadLastHour: deadHour!.n,
      /** Seconds the oldest due job has been waiting; 0 when the queue is drained. */
      lagSeconds: oldestRunAt ? Math.max(0, Math.round((now.getTime() - oldestRunAt.getTime()) / 1000)) : 0,
      stuck: stuck!.n,
      byType: byType.map((r) => ({ type: r.type, status: r.status, n: r.n })),
    },
    webhooks: { deadDeliveries24h: deadDeliveries!.n, pausedSubscriptions: pausedSubs!.n },
    messages: { failed24h: failedMail!.n },
  };
}
