import { and, count, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { attributions, auditLogs, authTokens, automationRuns, clicks, exports, jobs, messageLogs, notifications, sessions, tenants, webhookDeliveries, webhookOutboundDeliveries, type Tenant, type TenantRetention } from "../db/schema";
import { type TenantContext, require as requirePerm } from "../context";
import { writeAudit } from "./audit";
import { getTenant } from "./tenants";

/**
 * Data retention. Operational records grow without bound and most of them carry personal
 * data (IP hashes, user agents, message bodies, audit snapshots). Every category has a
 * platform default, and workspace owners can shorten or lengthen it within bounds. A daily
 * worker job deletes what has aged out, per tenant, and records the counts in the audit log.
 *
 * Financial records (conversions, commissions, ledger, payouts) are never pruned: they are
 * the books. Clicks that an attribution points at are kept for as long as the attribution.
 */
export const RETENTION_CATEGORIES = ["clicksDays", "messageLogsDays", "auditLogsDays", "webhookDeliveriesDays", "automationRunsDays", "notificationsDays"] as const;
export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];
export type RetentionPolicy = Record<RetentionCategory, number>;

export const RETENTION_DEFAULTS: RetentionPolicy = {
  clicksDays: 400,
  messageLogsDays: 365,
  auditLogsDays: 730,
  webhookDeliveriesDays: 90,
  automationRunsDays: 180,
  notificationsDays: 180,
};

/** Inclusive [min, max] in days a workspace may choose. */
export const RETENTION_BOUNDS: Record<RetentionCategory, [number, number]> = {
  clicksDays: [30, 1095],
  messageLogsDays: [30, 1095],
  auditLogsDays: [90, 3650],
  webhookDeliveriesDays: [7, 365],
  automationRunsDays: [30, 1095],
  notificationsDays: [30, 730],
};

export const RETENTION_LABELS: Record<RetentionCategory, string> = {
  clicksDays: "Raw click log (unattributed clicks)",
  messageLogsDays: "Sent emails and texts",
  auditLogsDays: "Audit trail",
  webhookDeliveriesDays: "Webhook deliveries (inbound and outbound)",
  automationRunsDays: "Automation run history",
  notificationsDays: "In-app notifications",
};

const dayField = (cat: RetentionCategory) => z.number().int().min(RETENTION_BOUNDS[cat][0]).max(RETENTION_BOUNDS[cat][1]).nullable().optional();
export const retentionSchema = z
  .object({
    clicksDays: dayField("clicksDays"),
    messageLogsDays: dayField("messageLogsDays"),
    auditLogsDays: dayField("auditLogsDays"),
    webhookDeliveriesDays: dayField("webhookDeliveriesDays"),
    automationRunsDays: dayField("automationRunsDays"),
    notificationsDays: dayField("notificationsDays"),
  })
  .strict();

/** Platform-level knobs (environment), not per tenant. */
export interface PlatformRetention {
  /** Finished jobs (done, failed, dead) older than this are deleted. */
  jobsDays: number;
  /** Closed workspaces are purged this many days after closing. */
  closedTenantPurgeDays: number;
  /** Maintenance history to keep. */
  maintenanceRunsDays: number;
}
export const PLATFORM_RETENTION_DEFAULTS: PlatformRetention = { jobsDays: 30, closedTenantPurgeDays: 30, maintenanceRunsDays: 365 };

export function platformRetentionFromEnv(env: NodeJS.ProcessEnv = process.env): PlatformRetention {
  const num = (key: string, fallback: number) => {
    const v = Number(env[key]);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  return {
    jobsDays: num("RETENTION_JOBS_DAYS", PLATFORM_RETENTION_DEFAULTS.jobsDays),
    closedTenantPurgeDays: num("TENANT_PURGE_DAYS", PLATFORM_RETENTION_DEFAULTS.closedTenantPurgeDays),
    maintenanceRunsDays: num("RETENTION_MAINTENANCE_DAYS", PLATFORM_RETENTION_DEFAULTS.maintenanceRunsDays),
  };
}

export function effectivePolicy(tenant: Pick<Tenant, "retention">, defaults: RetentionPolicy = RETENTION_DEFAULTS): RetentionPolicy {
  const out = { ...defaults };
  for (const cat of RETENTION_CATEGORIES) {
    const v = tenant.retention?.[cat];
    if (typeof v === "number") out[cat] = v;
  }
  return out;
}

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000);

/** Rows that would go on the next prune, per category. */
export async function previewPrune(db: DbLike, ctx: TenantContext, policy: RetentionPolicy, now = ctx.now()): Promise<Record<RetentionCategory, number>> {
  const t = ctx.tenantId;
  const n = (rows: { n: number }[]) => rows[0]?.n ?? 0;
  const [clk, msg, aud, whIn, whOut, runs, ntf] = await Promise.all([
    db.select({ n: count() }).from(clicks).where(and(eq(clicks.tenantId, t), lt(clicks.occurredAt, daysAgo(now, policy.clicksDays)), notInArray(clicks.id, db.select({ id: attributions.clickId }).from(attributions).where(and(eq(attributions.tenantId, t), sql`${attributions.clickId} is not null`))))),
    db.select({ n: count() }).from(messageLogs).where(and(eq(messageLogs.tenantId, t), lt(messageLogs.createdAt, daysAgo(now, policy.messageLogsDays)))),
    db.select({ n: count() }).from(auditLogs).where(and(eq(auditLogs.tenantId, t), lt(auditLogs.createdAt, daysAgo(now, policy.auditLogsDays)))),
    db.select({ n: count() }).from(webhookDeliveries).where(and(eq(webhookDeliveries.tenantId, t), lt(webhookDeliveries.receivedAt, daysAgo(now, policy.webhookDeliveriesDays)))),
    db.select({ n: count() }).from(webhookOutboundDeliveries).where(and(eq(webhookOutboundDeliveries.tenantId, t), lt(webhookOutboundDeliveries.createdAt, daysAgo(now, policy.webhookDeliveriesDays)), inArray(webhookOutboundDeliveries.status, ["delivered", "dead", "failed"]))),
    db.select({ n: count() }).from(automationRuns).where(and(eq(automationRuns.tenantId, t), lt(automationRuns.createdAt, daysAgo(now, policy.automationRunsDays)))),
    db.select({ n: count() }).from(notifications).where(and(eq(notifications.tenantId, t), lt(notifications.createdAt, daysAgo(now, policy.notificationsDays)))),
  ]);
  return { clicksDays: n(clk), messageLogsDays: n(msg), auditLogsDays: n(aud), webhookDeliveriesDays: n(whIn) + n(whOut), automationRunsDays: n(runs), notificationsDays: n(ntf) };
}

export interface RetentionView {
  overrides: TenantRetention;
  defaults: RetentionPolicy;
  effective: RetentionPolicy;
  bounds: Record<RetentionCategory, [number, number]>;
  labels: Record<RetentionCategory, string>;
  eligible: Record<RetentionCategory, number>;
}

export async function getRetention(db: DbLike, ctx: TenantContext, defaults: RetentionPolicy = RETENTION_DEFAULTS): Promise<RetentionView> {
  requirePerm(ctx, "read");
  const tenant = await getTenant(db, ctx);
  const effective = effectivePolicy(tenant, defaults);
  return { overrides: tenant.retention ?? {}, defaults, effective, bounds: RETENTION_BOUNDS, labels: RETENTION_LABELS, eligible: await previewPrune(db, ctx, effective) };
}

export async function updateRetention(db: DbLike, ctx: TenantContext, rawInput: z.input<typeof retentionSchema>): Promise<TenantRetention> {
  requirePerm(ctx, "tenant.manage");
  const input = retentionSchema.parse(rawInput);
  const before = await getTenant(db, ctx);
  const next: TenantRetention = { ...(before.retention ?? {}) };
  for (const cat of RETENTION_CATEGORIES) {
    if (input[cat] === undefined) continue;
    if (input[cat] === null) delete next[cat];
    else next[cat] = input[cat];
  }
  await db.update(tenants).set({ retention: next, updatedAt: ctx.now() }).where(eq(tenants.id, ctx.tenantId));
  await writeAudit(db, ctx, { entityType: "tenant", entityId: ctx.tenantId, action: "retention_updated", before: { retention: before.retention ?? {} }, after: { retention: next } });
  return next;
}

type Deleted = { rowCount?: number; affectedRows?: number };
const affected = (res: unknown) => (res as Deleted).rowCount ?? (res as Deleted).affectedRows ?? 0;

/**
 * Delete aged-out rows for one tenant under its effective policy. Runs inside the tenant's
 * RLS scope (the worker opens it) so nothing outside the tenant can be touched.
 */
export async function pruneTenant(db: DbLike, ctx: TenantContext, policy: RetentionPolicy, now = ctx.now()): Promise<Record<RetentionCategory, number>> {
  const t = ctx.tenantId;
  const keptClicks = db.select({ id: attributions.clickId }).from(attributions).where(and(eq(attributions.tenantId, t), sql`${attributions.clickId} is not null`));
  const clk = affected(await db.delete(clicks).where(and(eq(clicks.tenantId, t), lt(clicks.occurredAt, daysAgo(now, policy.clicksDays)), notInArray(clicks.id, keptClicks))));
  const msg = affected(await db.delete(messageLogs).where(and(eq(messageLogs.tenantId, t), lt(messageLogs.createdAt, daysAgo(now, policy.messageLogsDays)))));
  const aud = affected(await db.delete(auditLogs).where(and(eq(auditLogs.tenantId, t), lt(auditLogs.createdAt, daysAgo(now, policy.auditLogsDays)))));
  const whIn = affected(await db.delete(webhookDeliveries).where(and(eq(webhookDeliveries.tenantId, t), lt(webhookDeliveries.receivedAt, daysAgo(now, policy.webhookDeliveriesDays)))));
  const whOut = affected(
    await db.delete(webhookOutboundDeliveries).where(and(eq(webhookOutboundDeliveries.tenantId, t), lt(webhookOutboundDeliveries.createdAt, daysAgo(now, policy.webhookDeliveriesDays)), inArray(webhookOutboundDeliveries.status, ["delivered", "dead", "failed"]))),
  );
  const runs = affected(await db.delete(automationRuns).where(and(eq(automationRuns.tenantId, t), lt(automationRuns.createdAt, daysAgo(now, policy.automationRunsDays)))));
  const ntf = affected(await db.delete(notifications).where(and(eq(notifications.tenantId, t), lt(notifications.createdAt, daysAgo(now, policy.notificationsDays)))));
  const counts = { clicksDays: clk, messageLogsDays: msg, auditLogsDays: aud, webhookDeliveriesDays: whIn + whOut, automationRunsDays: runs, notificationsDays: ntf };
  if (Object.values(counts).some((v) => v > 0)) await writeAudit(db, ctx, { entityType: "tenant", entityId: t, action: "retention_pruned", after: { deleted: counts, policy } });
  return counts;
}

export interface PlatformPruneResult {
  jobs: number;
  sessions: number;
  authTokens: number;
  /** Expired export rows removed; the caller deletes their files. */
  exports: { id: string; storageKey: string | null }[];
}

/** Platform-wide housekeeping that no tenant controls: finished jobs, expired sessions and tokens, expired exports. Needs RLS bypass. */
export async function prunePlatform(db: DbLike, now: Date, policy: PlatformRetention = PLATFORM_RETENTION_DEFAULTS): Promise<PlatformPruneResult> {
  const finishedBefore = daysAgo(now, policy.jobsDays);
  const j = affected(await db.delete(jobs).where(and(inArray(jobs.status, ["done", "failed", "dead"]), or(lt(jobs.completedAt, finishedBefore), and(isNull(jobs.completedAt), lt(jobs.runAt, finishedBefore))))));
  const s = affected(await db.delete(sessions).where(lt(sessions.expiresAt, now)));
  const tok = affected(await db.delete(authTokens).where(or(lt(authTokens.expiresAt, now), sql`${authTokens.usedAt} is not null and ${authTokens.usedAt} < ${daysAgo(now, 1)}`)));
  const expired = await db.delete(exports).where(lt(exports.expiresAt, now)).returning({ id: exports.id, storageKey: exports.storageKey });
  return { jobs: j, sessions: s, authTokens: tok, exports: expired };
}
