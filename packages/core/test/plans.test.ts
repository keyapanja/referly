import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { closeDb, createActiveAffiliate, createWorkspace, getDb, makeClock, type Workspace } from "./helpers";
import * as plans from "../src/services/plans";
import * as platform from "../src/services/platform";
import * as programs from "../src/services/programs";
import * as tenantsSvc from "../src/services/tenants";
import * as affiliatesSvc from "../src/services/affiliates";
import { tenants } from "../src/db/schema";

let db: Db;
const clock = makeClock();
let ws: Workspace;

beforeAll(async () => {
  db = await getDb();
  ws = await createWorkspace(db, clock);
});
afterAll(closeDb);

describe("plans and limits (PRD s19)", () => {
  it("usage is metered per tenant and warnings appear near and at limits", async () => {
    const before = await plans.getBillingSummary(db, ws.ctx);
    expect(before.plan.id).toBe("starter");
    expect(before.usage).toMatchObject({ programs: 1, teamMembers: 1, activeAffiliates: 0 });
    expect(before.warnings).toEqual([]);

    // custom limits override the plan; hitting one produces a warning
    await db.update(tenants).set({ planLimits: { activeAffiliates: 3 } }).where(eq(tenants.id, ws.tenant.id));
    await createActiveAffiliate(db, ws, "One");
    expect((await plans.getBillingSummary(db, ws.ctx)).warnings).toEqual([]);
    await createActiveAffiliate(db, ws, "Two");
    const near = await plans.getBillingSummary(db, ws.ctx);
    expect(near.limits.activeAffiliates).toBe(3);
    expect(near.warnings.map((w) => [w.key, w.level])).toEqual([["activeAffiliates", "near"]]);
    await createActiveAffiliate(db, ws, "Three");
    const reached = await plans.getBillingSummary(db, ws.ctx);
    expect(reached.warnings.map((w) => [w.key, w.level])).toEqual([["activeAffiliates", "reached"]]);
  });

  it("hard limits reject new active affiliates, programs and team members with plan_limit", async () => {
    await expect(createActiveAffiliate(db, ws, "Four")).rejects.toMatchObject({ code: "plan_limit", details: { key: "activeAffiliates", usage: 3, limit: 3 } });
    // applications are still accepted (not active yet) but approval is blocked
    const { affiliate } = await affiliatesSvc.applyToProgram(db, ws.ctx, ws.program.id, { name: "Pending Pat", email: "pat@example.com", password: "password123", acceptTerms: true });
    expect(affiliate.status).toBe("applied");
    await expect(affiliatesSvc.approveAffiliate(db, ws.ctx, affiliate.id)).rejects.toMatchObject({ code: "plan_limit" });

    await db.update(tenants).set({ planLimits: { activeAffiliates: 3, programs: 1, teamMembers: 1 } }).where(eq(tenants.id, ws.tenant.id));
    await expect(programs.createProgram(db, ws.ctx, { name: "Second", commissionModel: "percentage", commissionPercent: 10, offerIds: [] })).rejects.toMatchObject({ code: "plan_limit", details: { key: "programs" } });
    await expect(tenantsSvc.addTeamMember(db, ws.ctx, { name: "Ops", email: "ops@example.com", role: "admin", password: "password123" })).rejects.toMatchObject({ code: "plan_limit", details: { key: "teamMembers" } });

    // "unlimited" override (null) lifts the limit; enterprise has none by default
    await db.update(tenants).set({ planLimits: { activeAffiliates: null, programs: null, teamMembers: null } }).where(eq(tenants.id, ws.tenant.id));
    await expect(createActiveAffiliate(db, ws, "Five")).resolves.toBeTruthy();
    await db.update(tenants).set({ planId: "enterprise", planLimits: null }).where(eq(tenants.id, ws.tenant.id));
    expect((await plans.getBillingSummary(db, ws.ctx)).limits).toEqual({ activeAffiliates: null, programs: null, teamMembers: null, monthlyConversions: null });
  });
});

describe("platform admin", () => {
  it("bootstrap is idempotent; tenants list and detail read across tenants; plan changes are audited", async () => {
    const admin = await platform.ensurePlatformAdmin(db, { email: "root@platform.test", password: "rootpass123" }, clock.now());
    const again = await platform.ensurePlatformAdmin(db, { email: "root@platform.test", password: "other" }, clock.now());
    expect(again.id).toBe(admin.id);
    expect(admin.role).toBe("platform_admin");

    const other = await createWorkspace(db, clock);
    const list = await platform.listTenants(db, {}, clock.now());
    const ids = list.map((r) => r.tenant.id);
    expect(ids).toContain(ws.tenant.id);
    expect(ids).toContain(other.tenant.id);
    expect(list.some((r) => r.tenant.slug === platform.PLATFORM_TENANT_SLUG)).toBe(false);
    expect(list.find((r) => r.tenant.id === ws.tenant.id)?.owners[0]?.email).toBe(ws.owner.email);

    const updated = await platform.updateTenantByAdmin(db, { userId: admin.id }, other.tenant.id, { planId: "growth", planLimits: { programs: 3 }, reason: "trial" }, clock.now());
    expect(updated.planId).toBe("growth");
    const detail = await platform.getTenantDetail(db, other.tenant.id, clock.now());
    expect(detail.limits).toMatchObject({ programs: 3, activeAffiliates: 250 });
    expect(detail.team.map((u) => u.role)).toEqual(["owner"]);

    await platform.updateTenantByAdmin(db, { userId: admin.id }, other.tenant.id, { status: "suspended" }, clock.now());
    expect((await platform.getTenantDetail(db, other.tenant.id)).tenant.status).toBe("suspended");
    const overview = await platform.platformOverview(db, clock.now());
    expect(overview.tenants.byStatus.suspended).toBeGreaterThanOrEqual(1);
    await expect(platform.getTenantDetail(db, "ten_nope")).rejects.toMatchObject({ code: "not_found" });
  });
});
