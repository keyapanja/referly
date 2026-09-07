import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { clickFor, closeDb, createActiveAffiliate, createWorkspace, getDb, makeClock, type Workspace } from "./helpers";
import * as groups from "../src/services/groups";
import * as tiers from "../src/services/tiers";
import * as conversions from "../src/services/conversions";
import * as affiliatesSvc from "../src/services/affiliates";
import * as assets from "../src/services/assets";
import * as automation from "../src/services/automation";
import { tenantContext } from "../src/context";
import type { Affiliate } from "../src/db/schema";

let db: Db;
const clock = makeClock();
let ws: Workspace;
let alice: Affiliate;
let bob: Affiliate;
const affCtx = (a: Affiliate) => tenantContext(ws.tenant.id, { type: "affiliate", id: a.id, affiliateId: a.id }, clock.now);

beforeAll(async () => {
  db = await getDb();
  ws = await createWorkspace(db, clock);
  alice = await createActiveAffiliate(db, ws, "Alice");
  bob = await createActiveAffiliate(db, ws, "Bob");
});
afterAll(closeDb);

async function sale(a: Affiliate, ref: string, amountMinor: number) {
  const c = await clickFor(db, ws, a, clock);
  return conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: ref, offerId: ws.offer.id, amountMinor, clickToken: c.token });
}

describe("affiliate groups (AFF-04)", () => {
  it("groups have unique names, members, and are visible from the affiliate side", async () => {
    const agencies = await groups.createGroup(db, ws.ctx, { name: "Agencies", kind: "partner_type" });
    await expect(groups.createGroup(db, ws.ctx, { name: "Agencies" })).rejects.toMatchObject({ code: "conflict" });
    expect(await groups.addMembers(db, ws.ctx, agencies.id, [alice.id])).toEqual([alice.id]);
    expect(await groups.addMembers(db, ws.ctx, agencies.id, [alice.id])).toEqual([]);
    await expect(groups.addMembers(db, ws.ctx, agencies.id, ["aff_nope"])).rejects.toMatchObject({ code: "validation" });
    expect((await groups.listGroups(db, ws.ctx)).find((g) => g.id === agencies.id)?.memberCount).toBe(1);
    expect((await groups.listMembers(db, ws.ctx, agencies.id)).map((m) => m.id)).toEqual([alice.id]);
    expect(await groups.groupIdsForAffiliate(db, ws.ctx, alice.id)).toEqual([agencies.id]);
    expect(await groups.groupIdsForAffiliate(db, ws.ctx, bob.id)).toEqual([]);
    // other tenants see nothing
    const other = await createWorkspace(db, clock);
    expect(await groups.listGroups(db, other.ctx)).toEqual([]);
    await expect(groups.getGroup(db, other.ctx, agencies.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("groups scope assets and automation conditions", async () => {
    const [agencies] = await groups.listGroups(db, ws.ctx);
    const brief = await assets.createAsset(db, ws.ctx, { type: "guideline", title: "Agency brief", body: "For agencies only", visibility: "restricted", groupIds: [agencies!.id] });
    expect((await assets.listAssetsForAffiliate(db, affCtx(alice), alice.id)).map((a) => a.id)).toContain(brief.id);
    expect((await assets.listAssetsForAffiliate(db, affCtx(bob), bob.id)).map((a) => a.id)).not.toContain(brief.id);

    const facts = await automation.buildFacts(db, ws.ctx, { type: "affiliate.approved", tenantId: ws.tenant.id, occurredAt: clock.now().toISOString(), actor: { type: "system" }, entityType: "affiliate", entityId: alice.id, data: {} });
    expect(facts.affiliateGroups).toEqual([agencies!.id]);
    expect(automation.conditionMatches({ field: "affiliateGroup", op: "eq", value: agencies!.id }, facts)).toBe(true);
    expect(automation.conditionMatches({ field: "affiliateGroup", op: "neq", value: agencies!.id }, facts)).toBe(false);
  });
});

describe("rate tiers (PROG-11)", () => {
  it("group tiers apply to members and are recorded on the commission; program rate applies to others", async () => {
    const [agencies] = await groups.listGroups(db, ws.ctx);
    await expect(tiers.createTier(db, ws.ctx, ws.program.id, { name: "Bad", kind: "group", commissionPercent: 10 })).rejects.toThrow();
    await expect(tiers.createTier(db, ws.ctx, ws.program.id, { name: "Bad", kind: "performance", metric: "conversions", commissionPercent: 10 })).rejects.toThrow();
    const agencyTier = await tiers.createTier(db, ws.ctx, ws.program.id, { name: "Agency rate", kind: "group", groupId: agencies!.id, commissionPercent: 25 });
    await expect(groups.deleteGroup(db, ws.ctx, agencies!.id)).rejects.toMatchObject({ code: "conflict" });

    const a1 = await sale(alice, "tier-a1", 100_000);
    expect(a1.commission).toMatchObject({ amountMinor: 25_000 });
    expect(a1.commission?.calculationBasis).toMatchObject({ overrideSource: "tier", tierId: agencyTier.id, tierName: "Agency rate", rateBps: 2500 });
    const b1 = await sale(bob, "tier-b1", 100_000);
    expect(b1.commission?.calculationBasis.overrideSource).toBe("program");

    // an affiliate-specific override still beats the tier
    await affiliatesSvc.setAffiliateCommissionOverride(db, ws.ctx, alice.id, ws.program.id, { commissionPercent: 40 }, "negotiated");
    const a2 = await sale(alice, "tier-a2", 100_000);
    expect(a2.commission?.calculationBasis).toMatchObject({ overrideSource: "affiliate_program", rateBps: 4000 });
    await affiliatesSvc.setAffiliateCommissionOverride(db, ws.ctx, alice.id, ws.program.id, { commissionPercent: null }, "reset");
  });

  it("performance tiers use earlier conversions only, honour windows, and report progress", async () => {
    const silver = await tiers.createTier(db, ws.ctx, ws.program.id, { name: "Silver", kind: "performance", metric: "conversions", threshold: 2, commissionPercent: 22 });
    const gold = await tiers.createTier(db, ws.ctx, ws.program.id, { name: "Gold", kind: "performance", metric: "revenue", threshold: 500_000, commissionPercent: 30 });
    // Bob has 1 earlier sale: not yet Silver
    let status = await tiers.affiliateTierStatus(db, affCtx(bob), bob.id, ws.program.id);
    expect(status.current).toBeNull();
    expect(status.metrics.conversions).toBe(1);
    expect(status.next).toMatchObject({ tier: { id: silver.id }, remaining: 1 });

    const b2 = await sale(bob, "tier-b2", 100_000); // this sale is the 2nd: earlier count is 1 → still program rate
    expect(b2.commission?.calculationBasis.overrideSource).toBe("program");
    const b3 = await sale(bob, "tier-b3", 100_000); // now 2 earlier sales → Silver
    expect(b3.commission?.calculationBasis).toMatchObject({ overrideSource: "tier", tierName: "Silver", rateBps: 2200 });
    status = await tiers.affiliateTierStatus(db, affCtx(bob), bob.id, ws.program.id);
    expect(status.current?.id).toBe(silver.id);
    expect(status.next).toMatchObject({ tier: { id: gold.id }, remaining: 200_000 });

    const b4 = await sale(bob, "tier-b4", 300_000); // earlier revenue 300k < 500k → Silver still
    expect(b4.commission?.calculationBasis.tierName).toBe("Silver");
    const b5 = await sale(bob, "tier-b5", 10_000); // earlier revenue 600k → Gold (highest threshold wins)
    expect(b5.commission?.calculationBasis).toMatchObject({ tierName: "Gold", rateBps: 3000 });
    expect((await tiers.affiliateTierStatus(db, affCtx(bob), bob.id, ws.program.id)).next).toBeNull();

    // a windowed tier ignores old sales
    await tiers.updateTier(db, ws.ctx, ws.program.id, gold.id, { name: "Gold", kind: "performance", metric: "revenue", threshold: 500_000, windowDays: 7, commissionPercent: 30 });
    clock.advanceDays(30);
    const b6 = await sale(bob, "tier-b6", 10_000); // revenue in last 7 days: 0 → Gold no longer; Silver (lifetime) still applies
    expect(b6.commission?.calculationBasis.tierName).toBe("Silver");
    // Alice (group member) keeps the group tier regardless of performance
    const a3 = await sale(alice, "tier-a3", 10_000);
    expect(a3.commission?.calculationBasis.tierName).toBe("Agency rate");
    expect((await tiers.listTiers(db, ws.ctx, ws.program.id)).map((t) => t.name).sort()).toEqual(["Agency rate", "Gold", "Silver"]);
    await tiers.deleteTier(db, ws.ctx, ws.program.id, gold.id);
    await expect(tiers.getTier(db, ws.ctx, ws.program.id, gold.id)).rejects.toMatchObject({ code: "not_found" });
  });
});
