import { Hono } from "hono";
import { platform, forbidden, notFound, validation, setRlsBypass, maintenance, jobs, retention, type Tx } from "@referly/core";
import type { AppEnv } from "../lib/auth";
import { listBackups } from "../backup";

/**
 * Platform admin API (PRD s15: cross-tenant operational access reserved for the SaaS operator
 * team). Requires the platform_admin role; the request transaction is switched to RLS bypass
 * because every handler here reads across tenants on purpose.
 */
export function adminRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    const p = c.get("principal");
    if (p.kind !== "user" || p.role !== "platform_admin") throw forbidden("platform admin only");
    await setRlsBypass(c.get("deps").db as Tx);
    await next();
  });

  r.get("/overview", async (c) => c.json(await platform.platformOverview(c.get("deps").db, c.get("now")())));
  r.get("/tenants", async (c) => c.json({ tenants: await platform.listTenants(c.get("deps").db, { q: c.req.query("q"), limit: Number(c.req.query("limit") ?? 100) }, c.get("now")()) }));
  r.get("/tenants/:id", async (c) => c.json(await platform.getTenantDetail(c.get("deps").db, c.req.param("id"), c.get("now")())));
  r.patch("/tenants/:id", async (c) => {
    const p = c.get("principal");
    const userId = p.kind === "user" ? p.userId : "";
    return c.json({ tenant: await platform.updateTenantByAdmin(c.get("deps").db, { userId }, c.req.param("id"), await c.req.json(), c.get("now")()) });
  });
  r.get("/ops", async (c) => c.json(await platform.opsSummary(c.get("deps").db, c.get("now")())));
  r.get("/jobs", async (c) => c.json({ jobs: await platform.listProblemJobs(c.get("deps").db) }));
  r.post("/jobs/:id/retry", async (c) => c.json({ job: await platform.retryJob(c.get("deps").db, c.req.param("id"), c.get("now")()) }));

  /** Backups and retention: history, configuration as the process sees it, and manual triggers (the worker does the work). */
  r.get("/maintenance", async (c) => {
    const { db, backup, storage, platformRetention } = c.get("deps");
    const runs = await maintenance.listRuns(db, { limit: Number(c.req.query("limit") ?? 50) });
    const backups = await listBackups(storage);
    return c.json({
      runs,
      backups: backups.map((b) => ({ key: b.key, sizeBytes: b.sizeBytes, lastModified: b.lastModified?.toISOString() ?? null })),
      config: {
        backups: backup ? { enabled: backup.everyHours > 0, everyHours: backup.everyHours, keepDays: backup.keepDays, keepWeeks: backup.keepWeeks, includeFiles: backup.includeFiles } : null,
        retention: { defaults: retention.RETENTION_DEFAULTS, platform: platformRetention ?? retention.PLATFORM_RETENTION_DEFAULTS },
        storage: storage.list ? "listable" : "write-only",
      },
    });
  });
  r.post("/maintenance/:kind", async (c) => {
    const kind = c.req.param("kind");
    const type = kind === "backup" ? "backup_run" : kind === "retention" ? "retention_prune" : null;
    if (!type) throw validation("kind must be backup or retention");
    if (type === "backup_run" && !c.get("deps").backup) throw validation("backups are not configured (BACKUP_KEY or INTEGRATION_SECRET)");
    const running = await maintenance.lastRun(c.get("deps").db, kind as maintenance.MaintenanceKind);
    if (running?.status === "running") throw validation(`a ${kind} run is already in progress`);
    const job = await jobs.enqueueJob(c.get("deps").db, { type, payload: { trigger: "manual" }, runAt: c.get("now")(), maxAttempts: 1 });
    return c.json({ job }, 202);
  });
  /** Encrypted archive download for off-site copies; the key stays in the environment. */
  r.get("/maintenance/backups/:id/download", async (c) => {
    const run = await maintenance.getRun(c.get("deps").db, c.req.param("id"));
    if (!run || run.kind !== "backup" || run.status !== "done" || !run.storageKey) throw notFound("backup", c.req.param("id"));
    const file = await c.get("deps").storage.get(run.storageKey);
    if (!file) throw notFound("backup file", run.storageKey);
    return new Response(file.data as unknown as BodyInit, {
      headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${run.storageKey.split("/").pop()}"`, "cache-control": "private, no-store" },
    });
  });
  return r;
}
