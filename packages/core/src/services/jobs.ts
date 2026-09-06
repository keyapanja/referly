import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { DbLike } from "../db/client";
import { jobs, type Job } from "../db/schema";
import { newId } from "../ids";

export interface EnqueueInput {
  tenantId?: string | null;
  type: string;
  payload?: Record<string, unknown>;
  runAt?: Date;
  maxAttempts?: number;
  idempotencyKey?: string;
}

export async function enqueueJob(db: DbLike, input: EnqueueInput): Promise<Job> {
  const [row] = await db
    .insert(jobs)
    .values({
      id: newId("job"),
      tenantId: input.tenantId ?? null,
      type: input.type,
      payload: input.payload ?? {},
      runAt: input.runAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? 5,
      idempotencyKey: input.idempotencyKey ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    const existing = await db.query.jobs.findFirst({ where: eq(jobs.idempotencyKey, input.idempotencyKey!) });
    return existing!;
  }
  return row;
}

/**
 * Claim the next runnable job. Uses an atomic UPDATE ... WHERE status='queued' so concurrent
 * workers never claim the same job. Returns null when nothing is due.
 */
export async function claimNextJob(db: DbLike, now: Date = new Date(), types?: string[]): Promise<Job | null> {
  const candidate = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.status, "queued"), lte(jobs.runAt, now), types?.length ? sql`${jobs.type} = any(${types})` : undefined))
    .orderBy(asc(jobs.runAt), asc(jobs.createdAt))
    .limit(1);
  const id = candidate[0]?.id;
  if (!id) return null;
  const [claimed] = await db
    .update(jobs)
    .set({ status: "running", lockedAt: now, attempts: sql`${jobs.attempts} + 1` })
    .where(and(eq(jobs.id, id), eq(jobs.status, "queued")))
    .returning();
  return claimed ?? null; // another worker won the race; caller loops
}

export async function completeJob(db: DbLike, jobId: string, now: Date = new Date()): Promise<void> {
  await db.update(jobs).set({ status: "done", completedAt: now, lockedAt: null }).where(eq(jobs.id, jobId));
}

/** Exponential backoff: 30s, 60s, 120s ... capped at 1h. Moves to `dead` after maxAttempts. */
export async function failJob(db: DbLike, job: Job, error: unknown, now: Date = new Date()): Promise<void> {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (job.attempts >= job.maxAttempts) {
    await db.update(jobs).set({ status: "dead", lastError: message, lockedAt: null }).where(eq(jobs.id, job.id));
    return;
  }
  const delayMs = Math.min(3_600_000, 30_000 * 2 ** (job.attempts - 1));
  await db
    .update(jobs)
    .set({ status: "queued", lastError: message, lockedAt: null, runAt: new Date(now.getTime() + delayMs) })
    .where(eq(jobs.id, job.id));
}

export type JobHandler = (job: Job) => Promise<void>;

/** Drain all currently-due jobs. Used by tests and by the worker loop. */
export async function runDueJobs(db: DbLike, handlers: Record<string, JobHandler>, now: Date = new Date(), limit = 100): Promise<number> {
  let processed = 0;
  while (processed < limit) {
    const job = await claimNextJob(db, now, Object.keys(handlers));
    if (!job) break;
    const handler = handlers[job.type];
    try {
      if (!handler) throw new Error(`no handler for job type ${job.type}`);
      await handler(job);
      await completeJob(db, job.id, now);
    } catch (err) {
      await failJob(db, job, err, now);
    }
    processed++;
  }
  return processed;
}
