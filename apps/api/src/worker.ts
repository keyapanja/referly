import { eq } from "drizzle-orm";
import { schema, type Db, type Job } from "@referly/core";
import { jobs, messaging, commissions, systemContext, events as eventsMod, tenants as tenantsSvc } from "@referly/core";

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
  webUrl: string;
  now?: () => Date;
}

/** Event → template mapping. Kept as data so it is inspectable (PRD "explainable automation"). */
const NOTIFICATION_RULES: Partial<Record<eventsMod.DomainEventType, messaging.TemplateKey>> = {
  "affiliate.invited": "affiliate_invite",
  "affiliate.applied": "affiliate_applied",
  "affiliate.approved": "affiliate_approved",
  "affiliate.rejected": "affiliate_rejected",
  "conversion.created": "conversion_recorded",
  "commission.approved": "commission_approved",
  "commission.reversed": "commission_reversed",
  "payout.paid": "payout_paid",
  "program.updated": "policy_updated",
};

export function createHandlers(deps: WorkerDeps): Record<string, jobs.JobHandler> {
  const now = deps.now ?? (() => new Date());
  return {
    domain_event: async (job: Job) => {
      const event = job.payload as unknown as eventsMod.DomainEvent;
      const templateKey = NOTIFICATION_RULES[event.type];
      if (!templateKey) return;
      const ctx = systemContext(event.tenantId, now);
      const tenant = await tenantsSvc.getTenant(deps.db, ctx);
      const affiliateId = (event.data.affiliateId as string | undefined) ?? (event.entityType === "affiliate" ? event.entityId : undefined);
      const affiliate = affiliateId ? await deps.db.query.affiliates.findFirst({ where: eq(affiliatesTable.id, affiliateId) }) : null;

      // Invites go to the invitee, who has no affiliate record yet.
      const recipient = event.type === "affiliate.invited" ? (event.data.email as string) : affiliate?.email;
      if (!recipient) return;
      if (event.type === "conversion.created" && !event.data.commissionId) return; // unattributed sale: nobody to notify

      const programId = (event.data.programId as string | undefined) ?? undefined;
      const program = programId ? await deps.db.query.programs.findFirst({ where: eq(programsTable.id, programId) }) : null;
      const offerId = event.data.offerId as string | undefined;
      const offer = offerId ? await deps.db.query.offers.findFirst({ where: eq(offersTable.id, offerId) }) : null;
      const amountMinor = event.data.amountMinor as number | undefined;

      await messaging.sendTemplated(deps.db, ctx, deps.email, {
        key: templateKey,
        to: recipient,
        affiliateId: affiliate?.id ?? null,
        related: { type: event.entityType, id: event.entityId },
        vars: {
          affiliate_name: affiliate?.name ?? (event.data.name as string | undefined) ?? recipient,
          business_name: tenant.name,
          program_name: program?.name ?? "",
          offer_name: offer?.name ?? "",
          amount: amountMinor !== undefined ? formatMinor(amountMinor) : "",
          currency: (event.data.currency as string | undefined) ?? tenant.currency,
          link: event.type === "affiliate.invited" ? `${deps.webUrl}/invite/${event.data.token as string}` : `${deps.webUrl}/portal`,
          portal_url: `${deps.webUrl}/portal`,
          payout_date: (event.data.paidAt as string | undefined)?.slice(0, 10) ?? "",
          reason: (event.data.reason as string | undefined) ?? "",
        },
      });
    },

    settle_holding_periods: async () => {
      const all = await deps.db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.status, "active"));
      for (const { id } of all) await commissions.settleHoldingPeriods(deps.db, systemContext(id, now), now());
    },
  };
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
