import { and, desc, eq, lt } from "drizzle-orm";
import type { DbLike } from "../db/client";
import { maintenanceRuns, type MaintenanceRun } from "../db/schema";
import { newId } from "../ids";

/**
 * History of platform maintenance (backups, retention pruning, workspace purges, restores).
 * Read by the admin operations panel and /metrics; written by the worker and the CLI.
 * Not tenant-scoped: callers run with RLS bypassed.
 */
export type MaintenanceKind = "backup" | "retention" | "purge" | "restore";
export type MaintenanceTrigger = "scheduled" | "manual" | "cli";

export async function startRun(db: DbLike, kind: MaintenanceKind, trigger: MaintenanceTrigger, now = new Date()): Promise<MaintenanceRun> {
  const [row] = await db.insert(maintenanceRuns).values({ id: newId("maintenanceRun"), kind, trigger, status: "running", startedAt: now }).returning();
  return row!;
}

export async function finishRun(db: DbLike, id: string, result: { storageKey?: string | null; sizeBytes?: number | null; summary?: Record<string, unknown> }, now = new Date()): Promise<MaintenanceRun> {
  const [row] = await db
    .update(maintenanceRuns)
    .set({ status: "done", storageKey: result.storageKey ?? null, sizeBytes: result.sizeBytes ?? null, summary: result.summary ?? {}, completedAt: now })
    .where(eq(maintenanceRuns.id, id))
    .returning();
  return row!;
}

export async function failRun(db: DbLike, id: string, error: unknown, summary: Record<string, unknown> = {}, now = new Date()): Promise<void> {
  await db
    .update(maintenanceRuns)
    .set({ status: "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 2000), summary, completedAt: now })
    .where(eq(maintenanceRuns.id, id));
}

export async function listRuns(db: DbLike, filter: { kind?: MaintenanceKind; limit?: number } = {}): Promise<MaintenanceRun[]> {
  return db
    .select()
    .from(maintenanceRuns)
    .where(filter.kind ? eq(maintenanceRuns.kind, filter.kind) : undefined)
    .orderBy(desc(maintenanceRuns.startedAt))
    .limit(filter.limit ?? 50);
}

export async function getRun(db: DbLike, id: string): Promise<MaintenanceRun | null> {
  return (await db.query.maintenanceRuns.findFirst({ where: eq(maintenanceRuns.id, id) })) ?? null;
}

/** Most recent successful run of a kind; the scheduler uses it to decide whether one is due. */
export async function lastSuccessful(db: DbLike, kind: MaintenanceKind): Promise<MaintenanceRun | null> {
  const [row] = await db.select().from(maintenanceRuns).where(and(eq(maintenanceRuns.kind, kind), eq(maintenanceRuns.status, "done"))).orderBy(desc(maintenanceRuns.completedAt)).limit(1);
  return row ?? null;
}

export async function lastRun(db: DbLike, kind: MaintenanceKind): Promise<MaintenanceRun | null> {
  const [row] = await db.select().from(maintenanceRuns).where(eq(maintenanceRuns.kind, kind)).orderBy(desc(maintenanceRuns.startedAt)).limit(1);
  return row ?? null;
}

/** A run that started too long ago and never finished (crashed process) is marked failed so the next one can go. */
export async function failStaleRuns(db: DbLike, olderThan: Date): Promise<number> {
  const rows = await db.update(maintenanceRuns).set({ status: "failed", error: "did not finish (process restarted?)", completedAt: olderThan }).where(and(eq(maintenanceRuns.status, "running"), lt(maintenanceRuns.startedAt, olderThan))).returning({ id: maintenanceRuns.id });
  return rows.length;
}

export async function pruneRuns(db: DbLike, olderThan: Date): Promise<number> {
  const rows = await db.delete(maintenanceRuns).where(lt(maintenanceRuns.startedAt, olderThan)).returning({ id: maintenanceRuns.id });
  return rows.length;
}
