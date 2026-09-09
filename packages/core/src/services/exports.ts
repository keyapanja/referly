import { and, asc, desc, eq, gt, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { affiliates, commissions, conversions, exports, ledgerEntries, payouts, clicks, type Export } from "../db/schema";
import { newId } from "../ids";
import { notFound, validation } from "../errors";
import { type TenantContext, require as requirePerm } from "../context";
import { enqueueJob } from "./jobs";
import { writeAudit } from "./audit";

/**
 * Async CSV export (AN-07, PRD s21 "CSV export must handle large datasets asynchronously").
 * The merchant requests an export; a job builds the file page by page and stores it as a
 * private object; the merchant downloads it through an authenticated endpoint until it
 * expires. Every step is recorded on the export row so the UI can show progress.
 */

export const EXPORT_ENTITIES = ["affiliates", "conversions", "commissions", "payouts", "ledger", "clicks", "workspace"] as const;
export type ExportEntity = (typeof EXPORT_ENTITIES)[number];
/** `workspace` is the whole account as JSON lines (data portability); everything else is a CSV table. */
export const JSON_EXPORT_ENTITIES: readonly ExportEntity[] = ["workspace"];
export function exportFileMeta(entity: string): { extension: string; contentType: string } {
  return JSON_EXPORT_ENTITIES.includes(entity as ExportEntity) ? { extension: "jsonl", contentType: "application/x-ndjson; charset=utf-8" } : { extension: "csv", contentType: "text/csv; charset=utf-8" };
}
export const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const requestExportSchema = z.object({ entity: z.enum(EXPORT_ENTITIES) });

export async function requestExport(db: DbLike, ctx: TenantContext, rawInput: z.input<typeof requestExportSchema>): Promise<Export> {
  requirePerm(ctx, "read");
  const input = requestExportSchema.parse(rawInput);
  if (JSON_EXPORT_ENTITIES.includes(input.entity)) requirePerm(ctx, "tenant.manage");
  const [row] = await db
    .insert(exports)
    .values({
      id: newId("export"),
      tenantId: ctx.tenantId,
      entity: input.entity,
      status: "queued",
      requestedByUserId: ctx.actor.type === "user" ? (ctx.actor.id ?? null) : null,
      createdAt: ctx.now(),
    })
    .returning();
  await enqueueJob(db, { tenantId: ctx.tenantId, type: "export_csv", payload: { exportId: row!.id, tenantId: ctx.tenantId }, runAt: ctx.now(), maxAttempts: 3 });
  await writeAudit(db, ctx, { entityType: "export", entityId: row!.id, action: "requested", after: { entity: input.entity } });
  return row!;
}

export async function getExport(db: DbLike, ctx: TenantContext, exportId: string): Promise<Export> {
  requirePerm(ctx, "read");
  const row = await db.query.exports.findFirst({ where: and(eq(exports.id, exportId), eq(exports.tenantId, ctx.tenantId)) });
  if (!row) throw notFound("export", exportId);
  return row;
}

export async function listExports(db: DbLike, ctx: TenantContext, limit = 20): Promise<Export[]> {
  requirePerm(ctx, "read");
  return db.select().from(exports).where(eq(exports.tenantId, ctx.tenantId)).orderBy(desc(exports.createdAt)).limit(limit);
}

export async function markExportRunning(db: DbLike, ctx: TenantContext, exportId: string): Promise<void> {
  await db.update(exports).set({ status: "running", error: null }).where(and(eq(exports.id, exportId), eq(exports.tenantId, ctx.tenantId)));
}

export async function markExportDone(db: DbLike, ctx: TenantContext, exportId: string, result: { storageKey: string; rowCount: number; sizeBytes: number }): Promise<Export> {
  const [row] = await db
    .update(exports)
    .set({ status: "done", storageKey: result.storageKey, rowCount: result.rowCount, sizeBytes: result.sizeBytes, completedAt: ctx.now(), expiresAt: new Date(ctx.now().getTime() + EXPORT_TTL_MS) })
    .where(and(eq(exports.id, exportId), eq(exports.tenantId, ctx.tenantId)))
    .returning();
  return row!;
}

export async function markExportFailed(db: DbLike, ctx: TenantContext, exportId: string, error: string): Promise<void> {
  await db.update(exports).set({ status: "failed", error: error.slice(0, 1000), completedAt: ctx.now() }).where(and(eq(exports.id, exportId), eq(exports.tenantId, ctx.tenantId)));
}

/** Columns that never leave the system through an export. */
const EXCLUDED_COLUMNS = new Set(["tenantId", "passwordHash", "customerEmailHash", "applicationAnswers", "candidates", "calculationBasis", "metadata", "payoutProfileRef", "seq", "ipHash", "userAgent"]);

const TABLES = { affiliates, conversions, commissions, payouts, ledger: ledgerEntries, clicks } as const;

/**
 * Keyset-paginated rows for an entity, oldest first, scoped to the tenant. Yields plain
 * objects with sensitive columns removed and nested values JSON-encoded.
 */
export async function* iterateExportRows(db: DbLike, ctx: TenantContext, entity: ExportEntity, batchSize = 2000): AsyncGenerator<Record<string, unknown>[]> {
  requirePerm(ctx, "read");
  const picked = (TABLES as Record<string, unknown>)[entity];
  if (!picked) throw validation(`export entity ${entity} is not a CSV table`);
  // The tables share the id/tenant_id shape; one static type keeps the query builder happy.
  const table = picked as typeof conversions;
  const orderKey = entity === "clicks" ? "occurredAt" : "createdAt";
  const createdAt: AnyPgColumn = entity === "clicks" ? clicks.occurredAt : table.createdAt;
  let last: { createdAt: Date; id: string } | null = null;
  for (;;) {
    const rows: Record<string, unknown>[] = await db
      .select()
      .from(table)
      .where(and(eq(table.tenantId, ctx.tenantId), last ? or(gt(createdAt, last.createdAt), and(eq(createdAt, last.createdAt), gt(table.id, last.id))) : undefined))
      .orderBy(asc(createdAt), asc(table.id))
      .limit(batchSize);
    if (rows.length === 0) return;
    yield rows.map(shapeRow);
    const tail = rows[rows.length - 1]!;
    last = { createdAt: tail[orderKey] as Date, id: tail.id as string };
    if (rows.length < batchSize) return;
  }
}

function shapeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (EXCLUDED_COLUMNS.has(k)) continue;
    out[k] = v instanceof Date ? v.toISOString() : v !== null && typeof v === "object" ? JSON.stringify(v) : v;
  }
  return out;
}

/** RFC 4180-ish CSV encoding shared by the worker and the small synchronous export. */
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (!rows.length) return columns?.length ? columns.join(",") + "\n" : "";
  const cols = columns ?? Object.keys(rows[0]!);
  const esc = (v: unknown) => {
    let s = v == null ? "" : String(v);
    // Spreadsheets execute cells that start with = + - @ or a tab/CR; a leading apostrophe makes them text.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((k) => esc(r[k])).join(","))].join("\n") + "\n";
}
