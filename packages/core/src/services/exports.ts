import { and, asc, desc, eq, gt, gte, lte, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { affiliates, commissions, conversions, exports, ledgerEntries, payouts, clicks, type Export } from "../db/schema";
import { newId } from "../ids";
import { notFound, validation } from "../errors";
import { type TenantContext, require as requirePerm } from "../context";
import { enqueueJob } from "./jobs";
import { writeAudit } from "./audit";
import { byAffiliate } from "./analytics";

/**
 * Async CSV export (AN-07, PRD s21 "CSV export must handle large datasets asynchronously").
 * The merchant requests an export; a job builds the file page by page and stores it as a
 * private object; the merchant downloads it through an authenticated endpoint until it
 * expires. Every step is recorded on the export row so the UI can show progress.
 */

export const EXPORT_ENTITIES = ["performance", "affiliates", "conversions", "commissions", "payouts", "ledger", "clicks", "workspace"] as const;
export type ExportEntity = (typeof EXPORT_ENTITIES)[number];

/** What a merchant can export, in their words: the page builds its choices from this, so it never offers what the API does not have. */
export interface ExportDataset {
  id: ExportEntity;
  label: string;
  description: string;
  format: "csv" | "json";
  /** `required`: a report for a period; `optional`: a period narrows it, none means every record; `none`: always everything. */
  period: "required" | "optional" | "none";
  /** Which date a period is measured on, for the page to say. */
  datedBy: string | null;
  ownerOnly: boolean;
}

export const EXPORT_DATASETS: readonly ExportDataset[] = [
  { id: "performance", label: "Affiliate performance report", description: "One row per affiliate for the period: clicks, sales, revenue and commission. The Affiliates table on this page, as a file.", format: "csv", period: "required", datedBy: null, ownerOnly: false },
  { id: "conversions", label: "Sales and leads", description: "Every recorded sale and lead, with its affiliate, amount, status and where it came from.", format: "csv", period: "optional", datedBy: "the date of the sale", ownerOnly: false },
  { id: "commissions", label: "Commissions", description: "What each sale earned, its status, and when it becomes payable.", format: "csv", period: "optional", datedBy: "the date the commission was created", ownerOnly: false },
  { id: "payouts", label: "Payouts", description: "Payout batches with amounts, methods and payment references.", format: "csv", period: "optional", datedBy: "the date the batch was created", ownerOnly: false },
  { id: "ledger", label: "Ledger", description: "Every credit, reversal, adjustment and payout line, as on affiliates' statements.", format: "csv", period: "optional", datedBy: "the date of the entry", ownerOnly: false },
  { id: "affiliates", label: "Affiliates", description: "Everyone in your programs, with status, contact details and payout method.", format: "csv", period: "optional", datedBy: "the date they joined", ownerOnly: false },
  { id: "clicks", label: "Clicks", description: "Every tracked click, with its link, affiliate and time.", format: "csv", period: "optional", datedBy: "the date of the click", ownerOnly: false },
  { id: "workspace", label: "Full workspace backup", description: "Everything in this workspace as one JSON file, for your records or to move elsewhere. Owners only.", format: "json", period: "none", datedBy: null, ownerOnly: true },
];
const datasetOf = (entity: string): ExportDataset | undefined => EXPORT_DATASETS.find((d) => d.id === entity);
/** `workspace` is the whole account as JSON lines (data portability); everything else is a CSV table. */
export const JSON_EXPORT_ENTITIES: readonly ExportEntity[] = ["workspace"];
export function exportFileMeta(entity: string): { extension: string; contentType: string } {
  return JSON_EXPORT_ENTITIES.includes(entity as ExportEntity) ? { extension: "jsonl", contentType: "application/x-ndjson; charset=utf-8" } : { extension: "csv", contentType: "text/csv; charset=utf-8" };
}
export const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const requestExportSchema = z
  .object({
    entity: z.enum(EXPORT_ENTITIES),
    /** The period to cover. Both or neither; neither means every record. */
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine((v) => (v.from == null) === (v.to == null), { message: "give both ends of the period, or neither" })
  .refine((v) => !v.from || !v.to || v.from.getTime() < v.to.getTime(), { message: "the period must start before it ends" });

export async function requestExport(db: DbLike, ctx: TenantContext, rawInput: z.input<typeof requestExportSchema>): Promise<Export> {
  requirePerm(ctx, "read");
  const input = requestExportSchema.parse(rawInput);
  if (JSON_EXPORT_ENTITIES.includes(input.entity)) requirePerm(ctx, "tenant.manage");
  const dataset = datasetOf(input.entity)!;
  if (dataset.period === "required" && !input.from) throw validation(`choose a period for the ${dataset.label.toLowerCase()}`);
  // A backup of the workspace is always all of it.
  const period = dataset.period === "none" ? { from: null, to: null } : { from: input.from ?? null, to: input.to ?? null };
  const [row] = await db
    .insert(exports)
    .values({
      id: newId("export"),
      tenantId: ctx.tenantId,
      entity: input.entity,
      status: "queued",
      requestedByUserId: ctx.actor.type === "user" ? (ctx.actor.id ?? null) : null,
      periodFrom: period.from,
      periodTo: period.to,
      createdAt: ctx.now(),
    })
    .returning();
  await enqueueJob(db, { tenantId: ctx.tenantId, type: "export_csv", payload: { exportId: row!.id, tenantId: ctx.tenantId }, runAt: ctx.now(), maxAttempts: 3 });
  await writeAudit(db, ctx, { entityType: "export", entityId: row!.id, action: "requested", after: { entity: input.entity, from: period.from, to: period.to } });
  return row!;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The name the file downloads under: what it is and what it covers. */
export function exportFileName(record: Pick<Export, "entity" | "periodFrom" | "periodTo" | "createdAt">): string {
  const covers = record.periodFrom && record.periodTo ? `${isoDay(record.periodFrom)}-to-${isoDay(record.periodTo)}` : `all-${isoDay(record.createdAt)}`;
  return `${record.entity}-${covers}.${exportFileMeta(record.entity).extension}`;
}

/** An export as the page shows it: the row, what it is called, and the file name it downloads under. */
export function publicExport(record: Export) {
  return { ...record, label: datasetOf(record.entity)?.label ?? record.entity, fileName: exportFileName(record) };
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
/** The date a period is measured on: when the sale or click happened, otherwise when the record was created. */
const PERIOD_COLUMNS: Record<keyof typeof TABLES, AnyPgColumn> = { affiliates: affiliates.createdAt, conversions: conversions.occurredAt, commissions: commissions.createdAt, payouts: payouts.createdAt, ledger: ledgerEntries.createdAt, clicks: clicks.occurredAt };

export interface ExportRowOptions {
  batchSize?: number;
  /** Only records inside this period. */
  from?: Date | null;
  to?: Date | null;
}

/**
 * Keyset-paginated rows for an entity, oldest first, scoped to the tenant. Yields plain
 * objects with sensitive columns removed and nested values JSON-encoded.
 */
export async function* iterateExportRows(db: DbLike, ctx: TenantContext, entity: ExportEntity, opts: ExportRowOptions = {}): AsyncGenerator<Record<string, unknown>[]> {
  requirePerm(ctx, "read");
  const batchSize = opts.batchSize ?? 2000;
  const picked = (TABLES as Record<string, unknown>)[entity];
  if (!picked) throw validation(`export entity ${entity} is not a CSV table`);
  // The tables share the id/tenant_id shape; one static type keeps the query builder happy.
  const table = picked as typeof conversions;
  const orderKey = entity === "clicks" ? "occurredAt" : "createdAt";
  const createdAt: AnyPgColumn = entity === "clicks" ? clicks.occurredAt : table.createdAt;
  const dated = PERIOD_COLUMNS[entity as keyof typeof TABLES];
  const inPeriod = opts.from && opts.to ? and(gte(dated, opts.from), lte(dated, opts.to)) : undefined;
  let last: { createdAt: Date; id: string } | null = null;
  for (;;) {
    const rows: Record<string, unknown>[] = await db
      .select()
      .from(table)
      .where(and(eq(table.tenantId, ctx.tenantId), inPeriod, last ? or(gt(createdAt, last.createdAt), and(eq(createdAt, last.createdAt), gt(table.id, last.id))) : undefined))
      .orderBy(asc(createdAt), asc(table.id))
      .limit(batchSize);
    if (rows.length === 0) return;
    yield rows.map(shapeRow);
    const tail = rows[rows.length - 1]!;
    last = { createdAt: tail[orderKey] as Date, id: tail.id as string };
    if (rows.length < batchSize) return;
  }
}

/** The affiliate performance report: the Analytics page's Affiliates table for a period, every affiliate, amounts in major units. */
export async function performanceReportRows(db: DbLike, ctx: TenantContext, period: { from: Date; to: Date }, currency: string): Promise<Record<string, unknown>[]> {
  const rows = await byAffiliate(db, ctx, period, 100_000);
  const major = (minor: number) => (minor / 100).toFixed(2);
  return rows.map((r) => ({
    affiliate: r.name,
    email: r.email,
    status: r.status,
    clicks: r.clicks,
    sales: r.conversions,
    conversionRate: r.clicks > 0 ? `${((r.conversions / r.clicks) * 100).toFixed(1)}%` : "",
    revenue: major(r.revenueMinor),
    commission: major(r.commissionMinor),
    currency,
    periodFrom: isoDay(period.from),
    periodTo: isoDay(period.to),
  }));
}
export const PERFORMANCE_COLUMNS = ["affiliate", "email", "status", "clicks", "sales", "conversionRate", "revenue", "commission", "currency", "periodFrom", "periodTo"];

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
