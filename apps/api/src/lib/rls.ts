import type { MiddlewareHandler } from "hono";
import { setRlsBypass, setTenantScope, type Db, type Tx } from "@referly/core";
import type { AppEnv } from "./auth";

/**
 * One transaction per request, so Postgres row-level security can be scoped with
 * transaction-local settings. The request starts in bypass mode (credentials and public
 * tokens must be looked up before the tenant is known); `scopeRequest` narrows it to one
 * tenant as soon as it is. Any error rolls the whole request back.
 */
export function rlsTransaction(db: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await db.transaction(async (tx) => {
      await setRlsBypass(tx as unknown as Tx);
      c.set("deps", { ...c.get("deps"), db: tx as unknown as Tx });
      await next();
      if (c.error) throw c.error;
    });
  };
}

/** Narrow the current request's transaction to a single tenant. Idempotent. */
export async function scopeRequest(c: { get: (k: "deps") => { db: unknown } }, tenantId: string): Promise<void> {
  await setTenantScope(c.get("deps").db as Tx, tenantId);
}
