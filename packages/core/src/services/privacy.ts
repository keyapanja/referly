import { and, asc, eq, getTableName, gt, isNotNull, lt } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { withTx } from "../db/client";
import { affiliates, auditLogs, authTokens, disputeComments, invites, messageLogs, sessions, tasks, tenants, users, schema, type Affiliate, type Task } from "../db/schema";
import { newId } from "../ids";
import { conflict, notFound } from "../errors";
import { type TenantContext, require as requirePerm, requireAffiliate } from "../context";
import { writeAudit } from "./audit";
import { getBalances } from "./commissions";
import { RLS_TABLES } from "../db/rls";
import { notifyTask } from "./notifications";

/**
 * Data-subject requests (GDPR arts. 15, 17, 20 and their equivalents):
 *  - an affiliate can ask for erasure from the portal; the team gets a task and decides;
 *  - a merchant erases an affiliate's personal data: identity fields become placeholders, the
 *    portal login is disabled, message bodies and audit snapshots about them are blanked.
 *    Conversions, commissions, ledger entries and payouts stay, because they are the books
 *    (legal basis: accounting). Erasure is refused while the affiliate still has money owed;
 *  - a workspace owner can export everything the workspace holds as JSON lines (see exports).
 */

export const eraseSchema = z.object({ reason: z.string().max(500).optional() });

export const ERASED_NAME = "Erased affiliate";
export const erasedEmail = (affiliateId: string) => `erased-${affiliateId.toLowerCase()}@erased.invalid`;

export async function eraseAffiliate(db: DbLike, ctx: TenantContext, affiliateId: string, rawInput: z.input<typeof eraseSchema> = {}): Promise<Affiliate> {
  requirePerm(ctx, "affiliates.write");
  const input = eraseSchema.parse(rawInput);
  return withTx(db, async (tx) => {
    const before = await tx.query.affiliates.findFirst({ where: and(eq(affiliates.id, affiliateId), eq(affiliates.tenantId, ctx.tenantId)) });
    if (!before) throw notFound("affiliate", affiliateId);
    if (before.erasedAt) return before;
    const balances = await getBalances(tx, ctx, affiliateId);
    if (balances.pendingMinor > 0 || balances.availableMinor > 0 || balances.reservedMinor > 0) throw conflict("affiliate still has commissions owed; pay, reverse or void them before erasing");

    const now = ctx.now();
    const email = erasedEmail(affiliateId);
    const [after] = await tx
      .update(affiliates)
      .set({
        name: ERASED_NAME,
        email,
        phone: null,
        company: null,
        channels: {},
        notes: null,
        tags: [],
        payoutMethod: null,
        payoutProfileRef: null,
        payoutDetailsMasked: null,
        textChannel: null,
        textConsentAt: null,
        textOptOutAt: null,
        applicationAnswers: {},
        status: "suspended",
        suspendedAt: before.suspendedAt ?? now,
        erasedAt: now,
        updatedAt: now,
      })
      .where(eq(affiliates.id, affiliateId))
      .returning();

    if (before.userId) {
      await tx.delete(sessions).where(eq(sessions.userId, before.userId));
      await tx.delete(authTokens).where(eq(authTokens.userId, before.userId));
      await tx.update(users).set({ name: ERASED_NAME, email, passwordHash: null, status: "disabled", updatedAt: now }).where(and(eq(users.id, before.userId), eq(users.tenantId, ctx.tenantId)));
    }
    await tx.update(messageLogs).set({ recipient: "[erased]", subject: null, body: null }).where(and(eq(messageLogs.tenantId, ctx.tenantId), eq(messageLogs.affiliateId, affiliateId)));
    await tx.update(invites).set({ email, name: null }).where(and(eq(invites.tenantId, ctx.tenantId), eq(invites.acceptedAffiliateId, affiliateId)));
    await tx.update(disputeComments).set({ body: "[erased]" }).where(and(eq(disputeComments.tenantId, ctx.tenantId), eq(disputeComments.authorType, "affiliate"), eq(disputeComments.authorId, affiliateId)));
    await tx.update(auditLogs).set({ before: { erased: true }, after: { erased: true } }).where(and(eq(auditLogs.tenantId, ctx.tenantId), eq(auditLogs.entityType, "affiliate"), eq(auditLogs.entityId, affiliateId)));
    await tx.update(tasks).set({ status: "done", doneAt: now }).where(and(eq(tasks.tenantId, ctx.tenantId), eq(tasks.entityType, "erasure_request"), eq(tasks.entityId, affiliateId), eq(tasks.status, "open")));

    await writeAudit(tx, ctx, { entityType: "affiliate", entityId: affiliateId, action: "erased", before: null, after: { erased: true, status: after!.status }, reason: input.reason });
    return after!;
  });
}

/** Portal: the affiliate asks to be erased. Creates one open task for the team; repeat requests return it. */
export async function requestErasure(db: DbLike, ctx: TenantContext, affiliateId: string): Promise<Task> {
  requireAffiliate(ctx, affiliateId);
  const affiliate = await db.query.affiliates.findFirst({ where: and(eq(affiliates.id, affiliateId), eq(affiliates.tenantId, ctx.tenantId)) });
  if (!affiliate) throw notFound("affiliate", affiliateId);
  const existing = await db.query.tasks.findFirst({ where: and(eq(tasks.tenantId, ctx.tenantId), eq(tasks.entityType, "erasure_request"), eq(tasks.entityId, affiliateId), eq(tasks.status, "open")) });
  if (existing) return existing;
  const [task] = await db
    .insert(tasks)
    .values({
      id: newId("task"),
      tenantId: ctx.tenantId,
      title: `Data erasure requested by ${affiliate.name}`,
      note: `${affiliate.name} <${affiliate.email}> asked for their personal data to be deleted. Settle anything owed, then use "Erase personal data" on their profile. Financial records are kept.`,
      status: "open",
      entityType: "erasure_request",
      entityId: affiliateId,
      affiliateId,
      createdAt: ctx.now(),
    })
    .returning();
  await notifyTask(db, ctx, task!);
  await writeAudit(db, ctx, { entityType: "affiliate", entityId: affiliateId, action: "erasure_requested", after: { taskId: task!.id } });
  return task!;
}

/** Columns that never leave through a workspace export: credentials, token hashes, hashed identifiers. */
const WORKSPACE_EXCLUDED_COLUMNS = new Set(["passwordHash", "tokenHash", "keyHash", "secretEnc", "credentialsEnc", "ipHash", "customerEmailHash"]);
/** Tables that are pure credentials or one-time secrets. */
const WORKSPACE_EXCLUDED_TABLES = new Set(["sessions", "auth_tokens", "invites"]);

/** Everything a workspace holds, table by table, oldest first, with secrets removed. Scoped by RLS to the tenant. */
export async function* iterateWorkspaceRows(db: DbLike, ctx: TenantContext, batchSize = 1000): AsyncGenerator<{ table: string; rows: Record<string, unknown>[] }> {
  requirePerm(ctx, "tenant.manage");
  const tenant = await db.select().from(tenants).where(eq(tenants.id, ctx.tenantId));
  yield { table: "tenants", rows: tenant.map(shape) };
  const tables = Object.values(schema).filter((t) => (RLS_TABLES as readonly string[]).includes(getTableName(t)));
  for (const table of tables) {
    const name = getTableName(table);
    if (WORKSPACE_EXCLUDED_TABLES.has(name)) continue;
    const t = table as unknown as typeof affiliates;
    const orderCol = "id" in t ? t.id : null;
    if (!orderCol) {
      const rows: Record<string, unknown>[] = await db.select().from(t).where(eq(t.tenantId, ctx.tenantId));
      yield { table: name, rows: rows.map(shape) };
      continue;
    }
    let lastId: string | null = null;
    for (;;) {
      const rows: Record<string, unknown>[] = await db
        .select()
        .from(t)
        .where(and(eq(t.tenantId, ctx.tenantId), lastId ? gt(t.id, lastId) : undefined))
        .orderBy(asc(t.id))
        .limit(batchSize);
      if (rows.length === 0) break;
      yield { table: name, rows: rows.map(shape) };
      lastId = rows[rows.length - 1]!.id as string;
      if (rows.length < batchSize) break;
    }
  }
}

function shape(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (WORKSPACE_EXCLUDED_COLUMNS.has(k)) continue;
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

/** Tenant ids whose workspace was closed before `before`, ready to purge. */
export async function closedTenantsBefore(db: DbLike, before: Date): Promise<{ id: string; slug: string; closedAt: Date }[]> {
  const rows = await db.select({ id: tenants.id, slug: tenants.slug, closedAt: tenants.closedAt }).from(tenants).where(and(eq(tenants.status, "closed"), isNotNull(tenants.closedAt), lt(tenants.closedAt, before)));
  return rows.map((r) => ({ id: r.id, slug: r.slug, closedAt: r.closedAt! }));
}
