import { sql } from "drizzle-orm";
import type { Db, DbLike, Tx } from "./client";

/**
 * Row-level security helpers (PRD s13, s15: "strict tenant isolation at the database layer").
 *
 * Every tenant-owned table has a policy that only matches rows whose tenant_id equals the
 * transaction-local setting `app.tenant_id`, unless `app.rls_bypass` is 'on'. Neither setting
 * is inherited by other connections because they are set with set_config(..., is_local = true),
 * which lasts for the current transaction only. With nothing set, every tenant table reads as
 * empty and every insert is rejected, so forgetting to scope fails closed.
 *
 * Bypass is for the handful of code paths that must find a tenant from an opaque token
 * (session, API key, tracking link, join and invite tokens, email login) and for the worker
 * before it scopes to a job's tenant.
 */

export async function setTenantScope(db: DbLike, tenantId: string): Promise<void> {
  await db.execute(sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.rls_bypass', 'off', true)`);
}

export async function setRlsBypass(db: DbLike): Promise<void> {
  await db.execute(sql`select set_config('app.rls_bypass', 'on', true)`);
}

/** Session-wide bypass. Only for trusted, single-connection contexts such as core unit tests and one-off scripts. */
export async function setSessionBypass(db: DbLike): Promise<void> {
  await db.execute(sql`select set_config('app.rls_bypass', 'on', false)`);
}

export async function withTenantScope<T>(db: Db | Tx, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await setTenantScope(tx as unknown as Tx, tenantId);
    return fn(tx as unknown as Tx);
  });
}

export async function withRlsBypass<T>(db: Db | Tx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await setRlsBypass(tx as unknown as Tx);
    return fn(tx as unknown as Tx);
  });
}

/** Tables that carry tenant_id and get the standard policy. `tenants` itself is keyed on id. */
export const RLS_TABLES = [
  "users",
  "sessions",
  "auth_tokens",
  "api_keys",
  "offers",
  "programs",
  "program_offers",
  "affiliates",
  "affiliate_programs",
  "invites",
  "tracking_links",
  "coupon_codes",
  "clicks",
  "conversions",
  "attributions",
  "commissions",
  "ledger_entries",
  "payouts",
  "assets",
  "asset_permissions",
  "campaigns",
  "campaign_participants",
  "campaign_assets",
  "message_templates",
  "message_logs",
  "automation_rules",
  "automation_runs",
  "audit_logs",
  "webhook_deliveries",
  "exports",
] as const;
