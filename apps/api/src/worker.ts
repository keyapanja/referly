import { eq, sql } from "drizzle-orm";
import { schema, type Db, type DbLike, type Job, type TenantContext, type Lookup } from "@referly/core";
import { jobs, messaging, commissions, systemContext, events as eventsMod, tenants as tenantsSvc, exportsSvc, withTenantScope, withRlsBypass, campaigns as campaignsSvc, automation, integrations, webhooks, retention as retentionSvc, maintenance, privacy, backup as backupSvc, notifications as notificationsSvc } from "@referly/core";
import { runBackup, type BackupConfig } from "./backup";
import { PRIVATE_PREFIX, type FileStorage } from "./storage";
import { textStatusUrl } from "./text";
import { log as rootLog, type Logger } from "./lib/log";
import { jobDuration, jobsProcessed } from "./lib/metrics";
import type { ErrorReporter } from "./lib/report";

const { affiliates: affiliatesTable, offers: offersTable, programs: programsTable, tenants: tenantsTable } = schema;

/**
 * Background worker (PRD s21). Single process, DB-backed queue. Two job types in Phase 1:
 *  - domain_event → deterministic notification rules (AUTO-01/03 subset that s17 requires)
 *  - settle_holding_periods → moves commissions to payable per tenant
 * Every send is logged in message_logs; every job attempt is visible in the jobs table.
 */
export interface WorkerDeps {
  db: Db;
  email: messaging.EmailProvider;
  storage: FileStorage;
  webUrl: string;
  now?: () => Date;
  payoutProviders?: integrations.IntegrationDeps;
  webhookFetch?: typeof fetch;
  webhookLookup?: Lookup;
  /** Text (SMS/WhatsApp) provider construction; texts are skipped when absent. */
  text?: integrations.TextDeps;
  /** API origin, for provider status callbacks. */
  baseUrl?: string;
  reporter?: ErrorReporter;
  log?: Logger;
  /** Backup schedule and key; absent in tests that do not exercise maintenance. */
  backup?: BackupConfig;
  /** Platform-level retention knobs (finished jobs, closed-workspace purge). */
  platformRetention?: retentionSvc.PlatformRetention;
}

/**
 * Every handler is timed and logged with its job id; failures count as `retry` or `dead`
 * (the job service decides which by attempts), and dead letters go to the error reporter.
 */
function instrument(handlers: Record<string, jobs.JobHandler>, deps: WorkerDeps): Record<string, jobs.JobHandler> {
  const wlog = (deps.log ?? rootLog).child({ component: "worker" });
  const out: Record<string, jobs.JobHandler> = {};
  for (const [type, fn] of Object.entries(handlers)) {
    out[type] = async (job) => {
      const start = performance.now();
      const jlog = wlog.child({ jobId: job.id, jobType: type, tenantId: job.tenantId ?? undefined, attempt: job.attempts, maxAttempts: job.maxAttempts });
      try {
        await fn(job);
        const ms = performance.now() - start;
        jobsProcessed.inc({ type, outcome: "ok" });
        jobDuration.observe({ type }, ms / 1000);
        jlog.info("job_done", { ms: Math.round(ms) });
      } catch (err) {
        const ms = performance.now() - start;
        const dead = job.attempts >= job.maxAttempts;
        jobsProcessed.inc({ type, outcome: dead ? "dead" : "retry" });
        jobDuration.observe({ type }, ms / 1000);
        if (dead) await deps.reporter?.report(err, { origin: "worker", jobId: job.id, jobType: type, tenantId: job.tenantId ?? undefined });
        else jlog.warn("job_failed", { ms: Math.round(ms), err, willRetry: true });
        throw err;
      }
    };
  }
  return out;
}

/** Event → template mapping. Kept as data so it is inspectable (PRD "explainable automation"). */
const NOTIFICATION_RULES: Partial<Record<eventsMod.DomainEventType, messaging.TemplateKey>> = {
  "user.verify_email": "verify_email",
  "user.password_reset_requested": "password_reset",
  "affiliate.invited": "affiliate_invite",
  "affiliate.applied": "affiliate_applied",
  "affiliate.approved": "affiliate_approved",
  "affiliate.rejected": "affiliate_rejected",
  "conversion.created": "conversion_recorded",
  "commission.approved": "commission_approved",
  "commission.reversed": "commission_reversed",
  "payout.paid": "payout_paid",
  "program.updated": "policy_updated",
  "campaign.invited": "campaign_launched",
  "dispute.opened": "dispute_update",
  "dispute.commented": "dispute_update",
  "dispute.resolved": "dispute_update",
};

export function createHandlers(deps: WorkerDeps): Record<string, jobs.JobHandler> {
  const now = deps.now ?? (() => new Date());

  /** Hard-coded system notifications (the AUTO-01/03 subset that s17 requires). */
  async function transportsFor(db: DbLike, ctx: TenantContext): Promise<messaging.Transports> {
    const text = deps.text ? await integrations.textProviderFor(db, ctx, deps.text) : null;
    return { email: deps.email, text, textStatusUrl: deps.baseUrl ? textStatusUrl(deps.baseUrl, ctx.tenantId) : undefined };
  }

  async function sendBuiltInNotification(db: DbLike, ctx: TenantContext, event: eventsMod.DomainEvent, transports: messaging.Transports): Promise<void> {
      const templateKey = event.type === "conversion.created" && event.data.kind === "lead" ? "lead_recorded" : NOTIFICATION_RULES[event.type];
      if (!templateKey) return;
      const tenant = await tenantsSvc.getTenant(db, ctx);
      const affiliateId = (event.data.affiliateId as string | undefined) ?? (event.entityType === "affiliate" ? event.entityId : undefined);
      const affiliate = affiliateId ? await db.query.affiliates.findFirst({ where: eq(affiliatesTable.id, affiliateId) }) : null;

      // Invites and account emails carry their recipient; everything else goes to the affiliate.
      const recipient = (event.data.email as string | undefined) ?? affiliate?.email;
      if (!recipient) return;
      if (event.type === "conversion.created" && !event.data.commissionId) return; // unattributed sale: nobody to notify
      // Affiliates switch categories off in the portal; account and security emails have no category and always go.
      const emailCategory = notificationsSvc.EMAIL_CATEGORY[event.type];
      if (affiliate && emailCategory && !notificationsSvc.wants(affiliate.notificationPrefs, emailCategory, "email")) return;

      const programId = (event.data.programId as string | undefined) ?? undefined;
      const program = programId ? await db.query.programs.findFirst({ where: eq(programsTable.id, programId) }) : null;
      const offerId = event.data.offerId as string | undefined;
      const offer = offerId ? await db.query.offers.findFirst({ where: eq(offersTable.id, offerId) }) : null;
      const amountMinor = (event.data.kind === "lead" ? event.data.commissionMinor : event.data.amountMinor) as number | undefined;

      await messaging.sendNotification(db, ctx, transports, {
        key: templateKey,
        to: recipient,
        affiliate,
        affiliateId: affiliate?.id ?? null,
        related: { type: event.entityType, id: event.entityId },
        vars: {
          affiliate_name: affiliate?.name ?? (event.data.name as string | undefined) ?? recipient,
          business_name: tenant.name,
          program_name: program?.name ?? "",
          campaign_name: (event.data.campaignName as string | undefined) ?? "",
          offer_name: offer?.name ?? "",
          amount: amountMinor !== undefined ? formatMinor(amountMinor) : "",
          currency: (event.data.currency as string | undefined) ?? tenant.currency,
          link: linkFor(event, deps.webUrl),
          portal_url: `${deps.webUrl}/portal`,
          payout_date: (event.data.paidAt as string | undefined)?.slice(0, 10) ?? "",
          reason: (event.data.reason as string | undefined) ?? "",
        },
      });
  }

  return {
    domain_event: async (job: Job) => {
      const event = job.payload as unknown as eventsMod.DomainEvent;
      await withTenantScope(deps.db, event.tenantId, async (db) => {
        const ctx = systemContext(event.tenantId, now);
        // Built-in notification first, then the tenant's own rules (AUTO-01..05).
        const transports = await transportsFor(db, ctx);
        await sendBuiltInNotification(db, ctx, event, transports);
        await notificationsSvc.fanOutForEvent(db, ctx, event);
        await automation.runRulesForEvent(db, ctx, event, { email: deps.email, webUrl: deps.webUrl, text: transports.text, textStatusUrl: transports.textStatusUrl });
        await webhooks.fanOut(db, ctx, event);
      });
    },

    /** Outbound webhook delivery; throws on failure so the job retries with backoff. */
    deliver_webhook: async (job: Job) => {
      const { deliveryId, tenantId } = job.payload as { deliveryId: string; tenantId: string };
      await withTenantScope(deps.db, tenantId, (db) => webhooks.deliver(db, systemContext(tenantId, now), deliveryId, { fetchImpl: deps.webhookFetch, lookup: deps.webhookLookup, attempt: job.attempts, maxAttempts: job.maxAttempts }));
    },

    /** AN-07: build a CSV page by page and store it privately; the API streams it back to authorised users. The `workspace` entity is the whole account as JSON lines. */
    export_csv: async (job: Job) => {
      const { exportId, tenantId } = job.payload as { exportId: string; tenantId: string };
      const ctx = systemContext(tenantId, now);
      await withTenantScope(deps.db, tenantId, async (db) => {
      const record = await exportsSvc.getExport(db, ctx, exportId);
      await exportsSvc.markExportRunning(db, ctx, exportId);
      try {
        const chunks: string[] = [];
        let rowCount = 0;
        const meta = exportsSvc.exportFileMeta(record.entity);
        if (record.entity === "workspace") {
          chunks.push(JSON.stringify({ type: "header", tenantId, exportedAt: now().toISOString(), format: "referly-workspace-1" }) + "\n");
          for await (const page of privacy.iterateWorkspaceRows(db, ctx)) {
            for (const row of page.rows) chunks.push(JSON.stringify({ table: page.table, row }) + "\n");
            rowCount += page.rows.length;
          }
        } else {
          let columns: string[] | null = null;
          for await (const page of exportsSvc.iterateExportRows(db, ctx, record.entity as exportsSvc.ExportEntity)) {
            if (!columns) {
              columns = Object.keys(page[0]!);
              chunks.push(exportsSvc.toCsv(page, columns));
            } else {
              chunks.push(exportsSvc.toCsv(page, columns).split("\n").slice(1).join("\n"));
            }
            rowCount += page.length;
          }
        }
        const body = chunks.join("") || `${record.entity}\n`;
        const data = new TextEncoder().encode(body);
        const key = `${PRIVATE_PREFIX}tenants/${tenantId}/exports/${exportId}.${meta.extension}`;
        await deps.storage.put(key, data, meta.contentType, { private: true });
        await exportsSvc.markExportDone(db, ctx, exportId, { storageKey: key, rowCount, sizeBytes: data.byteLength });
      } catch (err) {
        // record the failure in its own transaction so the rollback of this one does not erase it
        await withTenantScope(deps.db, tenantId, (fresh) => exportsSvc.markExportFailed(fresh, ctx, exportId, err instanceof Error ? err.message : String(err)));
        throw err;
      }
      });
    },

    /** Provider-driven payout: one HTTP call per payout, idempotent by payout id. */
    send_payout: async (job: Job) => {
      const { payoutId, tenantId } = job.payload as { payoutId: string; tenantId: string };
      await withTenantScope(deps.db, tenantId, (db) => integrations.executeProviderPayout(db, systemContext(tenantId, now), payoutId, deps.payoutProviders));
    },

    settle_holding_periods: async () => {
      const all = await withRlsBypass(deps.db, (db) => db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.status, "active")));
      for (const { id } of all)
        await withTenantScope(deps.db, id, async (db) => {
          await commissions.settleHoldingPeriods(db, systemContext(id, now), now());
          await campaignsSvc.endExpiredCampaigns(db, systemContext(id, now), now());
          await integrations.pollProviderPayouts(db, systemContext(id, now), deps.payoutProviders);
        });
    },

    /**
     * Maintenance scheduler tick: decides what is due from the maintenance history and enqueues
     * it, backup first so the day's prune is always covered by a backup. Idempotent per day.
     */
    maintenance: async () => {
      const t = now();
      const day = t.toISOString().slice(0, 10);
      const cfg = deps.backup;
      await withRlsBypass(deps.db, async (db) => {
        await maintenance.failStaleRuns(db, new Date(t.getTime() - 6 * 3_600_000));
        const due = async (kind: maintenance.MaintenanceKind, hours: number) => {
          if (hours <= 0) return false;
          const last = await maintenance.lastSuccessful(db, kind);
          const running = await maintenance.lastRun(db, kind);
          if (running?.status === "running") return false;
          return !last || t.getTime() - (last.completedAt ?? last.startedAt).getTime() >= hours * 3_600_000 - 60_000;
        };
        if (cfg && (await due("backup", cfg.everyHours))) await jobs.enqueueJob(db, { type: "backup_run", payload: { trigger: "scheduled" }, runAt: t, idempotencyKey: `backup:${day}`, maxAttempts: 2 });
        if (await due("retention", cfg?.retentionEveryHours ?? 24)) await jobs.enqueueJob(db, { type: "retention_prune", payload: { trigger: "scheduled" }, runAt: new Date(t.getTime() + 60_000), idempotencyKey: `retention:${day}`, maxAttempts: 2 });
      });
    },

    /** Full logical backup to the file store (see backup.ts). */
    backup_run: async (job: Job) => {
      if (!deps.backup) throw new Error("backups are not configured in this process");
      const trigger = ((job.payload as { trigger?: string }).trigger ?? "scheduled") as maintenance.MaintenanceTrigger;
      await runBackup({ db: deps.db, storage: deps.storage, config: deps.backup, trigger, now, log: deps.log });
    },

    /** Retention: per-tenant prune under each workspace's policy, platform housekeeping, and purge of closed workspaces past their grace period. */
    retention_prune: async (job: Job) => {
      const t = now();
      const trigger = ((job.payload as { trigger?: string }).trigger ?? "scheduled") as maintenance.MaintenanceTrigger;
      const platformPolicy = deps.platformRetention ?? retentionSvc.PLATFORM_RETENTION_DEFAULTS;
      const wlog = (deps.log ?? rootLog).child({ component: "retention" });
      const run = await withRlsBypass(deps.db, (db) => maintenance.startRun(db, "retention", trigger, t));
      const summary: Record<string, unknown> = { tenants: 0, deleted: {} as Record<string, number>, platform: {}, purged: [] as string[] };
      try {
        const all = await withRlsBypass(deps.db, (db) => db.select({ id: tenantsTable.id, retention: tenantsTable.retention, status: tenantsTable.status }).from(tenantsTable).where(sql`${tenantsTable.status} <> 'closed'`));
        const totals: Record<string, number> = {};
        for (const tenant of all) {
          const counts = await withTenantScope(deps.db, tenant.id, (db) => retentionSvc.pruneTenant(db, systemContext(tenant.id, now), retentionSvc.effectivePolicy(tenant), t));
          for (const [k, v] of Object.entries(counts)) totals[k] = (totals[k] ?? 0) + v;
        }
        summary.tenants = all.length;
        summary.deleted = totals;
        const platformResult = await withRlsBypass(deps.db, (db) => retentionSvc.prunePlatform(db, t, platformPolicy));
        for (const e of platformResult.exports) if (e.storageKey && deps.storage.delete) await deps.storage.delete(e.storageKey).catch((err) => wlog.warn("export_file_delete_failed", { key: e.storageKey, err }));
        await withRlsBypass(deps.db, (db) => maintenance.pruneRuns(db, new Date(t.getTime() - platformPolicy.maintenanceRunsDays * 86_400_000)));
        summary.platform = { jobs: platformResult.jobs, sessions: platformResult.sessions, authTokens: platformResult.authTokens, exports: platformResult.exports.length };

        // Closed workspaces past the grace period: rows, then files.
        const closed = await withRlsBypass(deps.db, (db) => privacy.closedTenantsBefore(db, new Date(t.getTime() - platformPolicy.closedTenantPurgeDays * 86_400_000)));
        const purged: string[] = [];
        for (const tenant of closed) {
          const purgeRun = await withRlsBypass(deps.db, (db) => maintenance.startRun(db, "purge", trigger, now()));
          try {
            const deleted = await backupSvc.purgeTenantRows(deps.db, tenant.id);
            let files = 0;
            if (deps.storage.list && deps.storage.delete) {
              for (const prefix of [`tenants/${tenant.id}/`, `${PRIVATE_PREFIX}tenants/${tenant.id}/`]) {
                for (const obj of await deps.storage.list(prefix)) {
                  await deps.storage.delete(obj.key);
                  files++;
                }
              }
            }
            await withRlsBypass(deps.db, (db) => maintenance.finishRun(db, purgeRun.id, { summary: { tenantId: tenant.id, slug: tenant.slug, closedAt: tenant.closedAt.toISOString(), deleted, files } }, now()));
            purged.push(tenant.slug);
            wlog.info("tenant_purged", { tenantId: tenant.id, slug: tenant.slug, files, rows: Object.values(deleted).reduce((a, b) => a + b, 0) });
          } catch (err) {
            await withRlsBypass(deps.db, (db) => maintenance.failRun(db, purgeRun.id, err, { tenantId: tenant.id, slug: tenant.slug }, now()));
            throw err;
          }
        }
        summary.purged = purged;
        await withRlsBypass(deps.db, (db) => maintenance.finishRun(db, run.id, { summary }, now()));
        wlog.info("retention_done", summary);
      } catch (err) {
        await withRlsBypass(deps.db, (db) => maintenance.failRun(db, run.id, err, summary, now()));
        throw err;
      }
    },
  };
}

function linkFor(event: eventsMod.DomainEvent, webUrl: string): string {
  const token = event.data.token as string | undefined;
  switch (event.type) {
    case "affiliate.invited":
      return `${webUrl}/invite/${token}`;
    case "user.verify_email":
      return `${webUrl}/verify-email?token=${token}`;
    case "user.password_reset_requested":
      return `${webUrl}/reset-password?token=${token}`;
    default:
      return `${webUrl}/portal`;
  }
}

function formatMinor(minor: number): string {
  return (minor / 100).toFixed(2);
}

/** Drain everything due right now. Used by tests and the interval loop. */
export async function runOnce(deps: WorkerDeps): Promise<number> {
  return jobs.runDueJobs(deps.db, instrument(createHandlers(deps), deps), (deps.now ?? (() => new Date()))());
}

export function startWorker(deps: WorkerDeps, opts: { pollMs?: number; settleEveryMs?: number; maintenanceEveryMs?: number } = {}) {
  const pollMs = opts.pollMs ?? 2000;
  const settleEveryMs = opts.settleEveryMs ?? 15 * 60 * 1000;
  const maintenanceEveryMs = opts.maintenanceEveryMs ?? 15 * 60 * 1000;
  const wlog = (deps.log ?? rootLog).child({ component: "worker" });
  const handlers = instrument(createHandlers(deps), deps);
  let running = false;
  let lastTickAt: Date | null = null;
  const poll = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const n = await jobs.runDueJobs(deps.db, handlers, (deps.now ?? (() => new Date()))());
      lastTickAt = new Date();
      if (n) wlog.debug("worker_tick", { processed: n });
    } catch (err) {
      await deps.reporter?.report(err, { origin: "worker" });
    } finally {
      running = false;
    }
  }, pollMs);
  const settle = setInterval(() => {
    const key = `settle:${Math.floor(Date.now() / settleEveryMs)}`;
    jobs.enqueueJob(deps.db, { type: "settle_holding_periods", idempotencyKey: key }).catch((err) => wlog.error("enqueue_settle_failed", { err }));
  }, settleEveryMs);
  jobs.enqueueJob(deps.db, { type: "settle_holding_periods", idempotencyKey: `settle:boot:${Date.now()}` }).catch(() => {});
  const maint = setInterval(() => {
    const key = `maintenance:${Math.floor(Date.now() / maintenanceEveryMs)}`;
    jobs.enqueueJob(deps.db, { type: "maintenance", idempotencyKey: key }).catch((err) => wlog.error("enqueue_maintenance_failed", { err }));
  }, maintenanceEveryMs);
  jobs.enqueueJob(deps.db, { type: "maintenance", idempotencyKey: `maintenance:boot:${Date.now()}`, runAt: new Date(Date.now() + 30_000) }).catch(() => {});
  wlog.info("worker_started", { pollMs, settleEveryMs, maintenanceEveryMs, backups: deps.backup ? (deps.backup.everyHours > 0 ? `every ${deps.backup.everyHours}h` : "manual only") : "off", handlers: Object.keys(handlers) });
  return {
    stop() {
      clearInterval(poll);
      clearInterval(settle);
      clearInterval(maint);
      wlog.info("worker_stopped");
    },
    /** Last successful poll; readiness reports the worker stale when this stops moving. */
    lastTickAt: () => lastTickAt,
  };
}
