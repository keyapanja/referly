import { and, desc, eq } from "drizzle-orm";
import type { DbLike } from "../db/client";
import { auditLogs } from "../db/schema";
import { newId } from "../ids";
import type { TenantContext } from "../context";
import { require as requirePerm } from "../context";

export interface AuditInput {
  entityType: string;
  entityId: string;
  action: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
}

export async function writeAudit(db: DbLike, ctx: TenantContext, input: AuditInput): Promise<void> {
  await db.insert(auditLogs).values({
    id: newId("auditLog"),
    tenantId: ctx.tenantId,
    actorUserId: ctx.actor.id ?? null,
    actorType: ctx.actor.type,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason ?? null,
    createdAt: ctx.now(),
  });
}

export async function listAudit(db: DbLike, ctx: TenantContext, filter: { entityType?: string; entityId?: string; limit?: number } = {}) {
  requirePerm(ctx, "read");
  const conds = [eq(auditLogs.tenantId, ctx.tenantId)];
  if (filter.entityType) conds.push(eq(auditLogs.entityType, filter.entityType));
  if (filter.entityId) conds.push(eq(auditLogs.entityId, filter.entityId));
  return db
    .select()
    .from(auditLogs)
    .where(and(...conds))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.seq))
    .limit(filter.limit ?? 100);
}

/** Pick a stable, JSON-safe snapshot of an entity for before/after diffs. */
export function snapshot<T extends object>(row: T | null | undefined, keys?: (keyof T)[]): Record<string, unknown> | null {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  const ks = keys ?? (Object.keys(row) as (keyof T)[]);
  for (const k of ks) {
    const v = row[k];
    out[String(k)] = v instanceof Date ? v.toISOString() : (v as unknown);
  }
  return out;
}
