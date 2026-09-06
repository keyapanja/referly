import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { closeDb, createActiveAffiliate, createWorkspace, getDb, makeClock, type Workspace } from "./helpers";
import { affiliates, offers } from "../src/db/schema";
import { withRlsBypass, withTenantScope } from "../src/db/rls";
import * as affiliatesSvc from "../src/services/affiliates";
import * as offersSvc from "../src/services/offers";

let db: Db;
const clock = makeClock();
let a: Workspace;
let b: Workspace;

beforeAll(async () => {
  db = await getDb();
  a = await createWorkspace(db, clock);
  b = await createWorkspace(db, clock);
  await createActiveAffiliate(db, a, "Alice");
  await createActiveAffiliate(db, b, "Bob");
});
afterAll(closeDb);

describe("row-level security (database-enforced tenant isolation)", () => {
  it("a tenant-scoped transaction only sees its own rows even without a WHERE clause", async () => {
    const seenByA = await withTenantScope(db, a.tenant.id, (tx) => tx.select().from(affiliates));
    expect(seenByA.map((r) => r.tenantId)).toEqual([a.tenant.id]);
    const seenByB = await withTenantScope(db, b.tenant.id, (tx) => tx.select().from(affiliates));
    expect(seenByB.map((r) => r.name)).toEqual(["Bob"]);
    const offersSeen = await withTenantScope(db, a.tenant.id, (tx) => tx.select().from(offers));
    expect(offersSeen.every((o) => o.tenantId === a.tenant.id)).toBe(true);
  });

  it("no scope and no bypass fails closed: nothing is visible and inserts are rejected", async () => {
    await db.transaction(async (tx) => {
      // fresh transaction: session-level bypass from the test helper is overridden locally
      await tx.execute(sql`select set_config('app.rls_bypass', 'off', true)`);
      expect(await tx.select().from(affiliates)).toHaveLength(0);
      expect(await tx.select().from(offers)).toHaveLength(0);
      await expect(tx.insert(offers).values({ id: "off_rls_test", tenantId: a.tenant.id, name: "x", currency: "USD", salesUrl: "https://x.example.com" })).rejects.toThrow(/row-level security|Failed query: insert/i);
    });
  });

  it("a scoped transaction cannot write rows for another tenant, even if application code tries", async () => {
    // a rejected statement aborts its transaction, so the write attempt gets its own
    await expect(
      withTenantScope(db, a.tenant.id, (tx) => tx.insert(offers).values({ id: "off_rls_cross", tenantId: b.tenant.id, name: "smuggled", currency: "USD", salesUrl: "https://x.example.com" })),
    ).rejects.toThrow(/row-level security|Failed query: insert/i);
    await withTenantScope(db, a.tenant.id, async (tx) => {
      // services scoped to B run inside A's transaction return nothing rather than B's data
      expect(await offersSvc.listOffers(tx, b.ctx)).toHaveLength(0);
      expect(await affiliatesSvc.listAffiliates(tx, b.ctx)).toHaveLength(0);
      // and A's own service calls still work
      expect((await offersSvc.listOffers(tx, a.ctx)).length).toBeGreaterThan(0);
    });
    // the smuggled row never landed
    const all = await withRlsBypass(db, (tx) => tx.select().from(offers));
    expect(all.some((o) => o.id === "off_rls_cross")).toBe(false);
  });

  it("bypass sees everything and is transaction-local", async () => {
    const all = await withRlsBypass(db, (tx) => tx.select().from(affiliates));
    expect(new Set(all.map((r) => r.tenantId))).toEqual(new Set([a.tenant.id, b.tenant.id]));
    // after the bypass transaction ends, a scoped transaction is still scoped
    const again = await withTenantScope(db, b.tenant.id, (tx) => tx.select().from(affiliates));
    expect(again.map((r) => r.name)).toEqual(["Bob"]);
  });
});
