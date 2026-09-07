import { eq } from "drizzle-orm";
import { schema, type Db, type Job } from "@referly/core";
import { jobs, messaging, commissions, systemContext, events as eventsMod, tenants as tenantsSvc, exportsSvc, withTenantScope, withRlsBypass, campaigns as campaignsSvc } from "@referly/core";
import { PRIVATE_PREFIX, type FileStorage } from "./storage";

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
};

export function createHandlers(deps: WorkerDeps): Record<string, jobs.JobHandler> {
  const now = deps.now ?? (() => new Date());
  return {
    domain_event: async (job: Job) => {
      const event = job.payload as unknown as eventsMod.DomainEvent;
      const templateKey = NOTIFICATION_RULES[event.type];
      if (!templateKey) return;
      await withTenantScope(deps.db, event.tenantId, async (db) => {
      const ctx = systemContext(event.tenantId, now);
      const tenant = await tenantsSvc.getTenant(db, ctx);
      const affiliateId = (event.data.affiliateId as string | undefined) ?? (event.entityType === "affiliate" ? event.entityId : undefined);
      const affiliate = affiliateId ? await db.query.affiliates.findFirst({ where: eq(affiliatesTable.id, affiliateId) }) : null;

      // Invites and account emails carry their recipient; everything else goes to the affiliate.
      const recipient = (event.data.email as string | undefined) ?? affiliate?.email;
      if (!recipient) return;
      if (event.type === "conversion.created" && !event.data.commissionId) return; // unattributed sale: nobody to notify

      const programId = (event.data.programId as string | undefined) ?? undefined;
      const program = programId ? await db.query.programs.findFirst({ where: eq(programsTable.id, programId) }) : null;
      const offerId = event.data.offerId as string | undefined;
      const offer = offerId ? await db.query.offers.findFirst({ where: eq(offersTable.id, offerId) }) : null;
      const amountMinor = event.data.amountMinor as number | undefined;

      await messaging.sendTemplated(db, ctx, deps.email, {
        key: templateKey,
        to: recipient,
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
      });
    },

    /** AN-07: build a CSV page by page and store it privately; the API streams it back to authorised users. */
    export_csv: async (job: Job) => {
      const { exportId, tenantId } = job.payload as { exportId: string; tenantId: string };
      const ctx = systemContext(tenantId, now);
      await withTenantScope(deps.db, tenantId, async (db) => {
      const record = await exportsSvc.getExport(db, ctx, exportId);
      await exportsSvc.markExportRunning(db, ctx, exportId);
      try {
        const chunks: string[] = [];
        let columns: string[] | null = null;
        let rowCount = 0;
        for await (const page of exportsSvc.iterateExportRows(db, ctx, record.entity as exportsSvc.ExportEntity)) {
          if (!columns) {
            columns = Object.keys(page[0]!);
            chunks.push(exportsSvc.toCsv(page, columns));
          } else {
            chunks.push(exportsSvc.toCsv(page, columns).split("\n").slice(1).join("\n"));
          }
          rowCount += page.length;
        }
        const csv = chunks.join("") || `${record.entity}\n`;
        const data = new TextEncoder().encode(csv);
        const key = `${PRIVATE_PREFIX}tenants/${tenantId}/exports/${exportId}.csv`;
        await deps.storage.put(key, data, "text/csv; charset=utf-8", { private: true });
        await exportsSvc.markExportDone(db, ctx, exportId, { storageKey: key, rowCount, sizeBytes: data.byteLength });
      } catch (err) {
        // record the failure in its own transaction so the rollback of this one does not erase it
        await withTenantScope(deps.db, tenantId, (fresh) => exportsSvc.markExportFailed(fresh, ctx, exportId, err instanceof Error ? err.message : String(err)));
        throw err;
      }
      });
    },

    settle_holding_periods: async () => {
      const all = await withRlsBypass(deps.db, (db) => db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.status, "active")));
      for (const { id } of all)
        await withTenantScope(deps.db, id, async (db) => {
          await commissions.settleHoldingPeriods(db, systemContext(id, now), now());
          await campaignsSvc.endExpiredCampaigns(db, systemContext(id, now), now());
        });
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
  return jobs.runDueJobs(deps.db, createHandlers(deps), (deps.now ?? (() => new Date()))());
}

export function startWorker(deps: WorkerDeps, opts: { pollMs?: number; settleEveryMs?: number } = {}) {
  const pollMs = opts.pollMs ?? 2000;
  const settleEveryMs = opts.settleEveryMs ?? 15 * 60 * 1000;
  let running = false;
  const poll = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runOnce(deps);
    } catch (err) {
      console.error("[worker] poll failed", err);
    } finally {
      running = false;
    }
  }, pollMs);
  const settle = setInterval(() => {
    const key = `settle:${Math.floor(Date.now() / settleEveryMs)}`;
    jobs.enqueueJob(deps.db, { type: "settle_holding_periods", idempotencyKey: key }).catch((err) => console.error("[worker] enqueue settle failed", err));
  }, settleEveryMs);
  jobs.enqueueJob(deps.db, { type: "settle_holding_periods", idempotencyKey: `settle:boot:${Date.now()}` }).catch(() => {});
  return {
    stop() {
      clearInterval(poll);
      clearInterval(settle);
    },
  };
}
