import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { clickFor, closeDb, createActiveAffiliate, createWorkspace, getDb, makeClock, type Workspace } from "./helpers";
import * as campaigns from "../src/services/campaigns";
import * as conversions from "../src/services/conversions";
import * as commissions from "../src/services/commissions";
import * as offers from "../src/services/offers";
import * as programs from "../src/services/programs";
import * as assets from "../src/services/assets";
import { tenants, jobs as jobsTable } from "../src/db/schema";
import { tenantContext } from "../src/context";
import type { Affiliate } from "../src/db/schema";

let db: Db;
const clock = makeClock();
let ws: Workspace;
let alice: Affiliate;
let bob: Affiliate;

beforeAll(async () => {
  db = await getDb();
  ws = await createWorkspace(db, clock);
  alice = await createActiveAffiliate(db, ws, "Alice");
  bob = await createActiveAffiliate(db, ws, "Bob");
});
afterAll(closeDb);

const affCtx = (a: Affiliate) => tenantContext(ws.tenant.id, { type: "affiliate", id: a.id, affiliateId: a.id }, clock.now);
const day = 86_400_000;

describe("campaigns (AST-03..05, AN-05)", () => {
  let campaignId: string;

  it("is gated by plan, then creates a draft with validated offers", async () => {
    const input = { programId: ws.program.id, name: "Spring launch", startAt: clock.now(), endAt: new Date(clock.now().getTime() + 10 * day), commissionPercent: 30, bonusRule: { metric: "conversions" as const, threshold: 2, bonusMinor: 500 } };
    await expect(campaigns.createCampaign(db, ws.ctx, input)).rejects.toMatchObject({ code: "plan_limit", details: { feature: "campaigns" } });
    await db.update(tenants).set({ planId: "growth" }).where(eq(tenants.id, ws.tenant.id));
    await expect(campaigns.createCampaign(db, ws.ctx, { ...input, endAt: input.startAt })).rejects.toThrow();
    await expect(campaigns.createCampaign(db, ws.ctx, { ...input, offerIds: ["off_nope"] })).rejects.toMatchObject({ code: "validation" });
    const c = await campaigns.createCampaign(db, ws.ctx, input);
    expect(c.status).toBe("draft");
    expect(c.commissionRateBpsOverride).toBe(3000);
    campaignId = c.id;
  });

  it("participation: invite active members, affiliates join in the portal, notifications go out on activation", async () => {
    await expect(campaigns.inviteParticipants(db, ws.ctx, campaignId, { affiliateIds: ["aff_nope"] })).rejects.toMatchObject({ code: "validation" });
    const invited = await campaigns.inviteParticipants(db, ws.ctx, campaignId, { affiliateIds: [alice.id] });
    expect(invited.map((p) => p.status)).toEqual(["invited"]);
    expect(await campaigns.inviteParticipants(db, ws.ctx, campaignId, { affiliateIds: [alice.id] })).toEqual([]); // idempotent

    // cannot join a draft; activation emits an invite event per participant
    await expect(campaigns.joinCampaign(db, affCtx(alice), campaignId, alice.id)).rejects.toMatchObject({ code: "validation" });
    await campaigns.setCampaignStatus(db, ws.ctx, campaignId, "active");
    const events = (await db.select().from(jobsTable).where(eq(jobsTable.type, "domain_event"))).map((j) => j.payload as any);
    expect(events.filter((e) => e.type === "campaign.invited" && e.data.affiliateId === alice.id && e.data.campaignName === "Spring launch")).toHaveLength(1);
    expect(events.some((e) => e.type === "campaign.started")).toBe(true);

    // no invitation for Bob; Alice joins
    await expect(campaigns.joinCampaign(db, affCtx(bob), campaignId, bob.id)).rejects.toMatchObject({ code: "not_found" });
    const joined = await campaigns.joinCampaign(db, affCtx(alice), campaignId, alice.id);
    expect(joined.status).toBe("active");
    expect((await campaigns.listCampaignsForAffiliate(db, affCtx(alice), alice.id)).map((r) => r.participantStatus)).toEqual(["active"]);
    expect(await campaigns.listCampaignsForAffiliate(db, affCtx(bob), bob.id)).toEqual([]);
  });

  it("a live campaign overrides the commission for participants and pays the bonus once", async () => {
    const c = await campaigns.getCampaign(db, ws.ctx, campaignId);
    // Bob is not a participant: program rate applies
    const bobClick = await clickFor(db, ws, bob, clock);
    const bobConv = await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "camp-bob-1", offerId: ws.offer.id, amountMinor: 100_000, clickToken: bobClick.token });
    expect(bobConv.conversion.campaignId).toBeNull();
    expect(bobConv.commission?.calculationBasis.overrideSource).toBe("program");

    // Alice: 30% campaign rate, campaign recorded on conversion and commission
    const c1 = await clickFor(db, ws, alice, clock);
    const conv1 = await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "camp-alice-1", offerId: ws.offer.id, amountMinor: 100_000, clickToken: c1.token });
    expect(conv1.conversion.campaignId).toBe(c.id);
    expect(conv1.commission).toMatchObject({ campaignId: c.id, amountMinor: 30_000 });
    expect(conv1.commission?.calculationBasis).toMatchObject({ overrideSource: "campaign", rateBps: 3000 });
    let ledger = await commissions.listLedger(db, ws.ctx, alice.id);
    expect(ledger.filter((l) => l.type === "adjustment")).toHaveLength(0);

    // second conversion reaches the threshold: one bonus of 500
    const c2 = await clickFor(db, ws, alice, clock);
    await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "camp-alice-2", offerId: ws.offer.id, amountMinor: 50_000, clickToken: c2.token });
    ledger = await commissions.listLedger(db, ws.ctx, alice.id);
    const bonuses = ledger.filter((l) => l.type === "adjustment");
    expect(bonuses).toHaveLength(1);
    expect(bonuses[0]).toMatchObject({ amountMinor: 500, reason: "campaign bonus: Spring launch" });

    // third conversion: no second bonus
    const c3 = await clickFor(db, ws, alice, clock);
    await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "camp-alice-3", offerId: ws.offer.id, amountMinor: 10_000, clickToken: c3.token });
    expect((await commissions.listLedger(db, ws.ctx, alice.id)).filter((l) => l.type === "adjustment")).toHaveLength(1);

    const perf = await campaigns.campaignPerformance(db, ws.ctx, c.id);
    expect(perf).toEqual({ participants: { invited: 1, active: 1 }, conversions: 3, revenueMinor: 160_000, commissionMinor: 48_000, bonusesMinor: 500 });
    const portal = await campaigns.listCampaignsForAffiliate(db, affCtx(alice), alice.id);
    expect(portal[0]?.progress).toMatchObject({ metric: "conversions", value: 3, threshold: 2, awarded: true });
  });

  it("offer restrictions and the time window are respected; the scheduler ends campaigns", async () => {
    const other = await offers.createOffer(db, ws.ctx, { name: "Other", salesUrl: "https://acme.example.com/other" }, "USD");
    await programs.attachOffer(db, ws.ctx, ws.program.id, other.id);
    const restricted = await campaigns.createCampaign(db, ws.ctx, { programId: ws.program.id, name: "Other only", startAt: clock.now(), endAt: new Date(clock.now().getTime() + 2 * day), commissionPercent: 50, offerIds: [other.id] });
    await campaigns.inviteParticipants(db, ws.ctx, restricted.id, { all: true });
    await campaigns.setCampaignStatus(db, ws.ctx, restricted.id, "active");
    await campaigns.joinCampaign(db, affCtx(bob), restricted.id, bob.id);

    // main offer: not covered by the restricted campaign
    const k1 = await clickFor(db, ws, bob, clock);
    const notCovered = await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "restr-1", offerId: ws.offer.id, amountMinor: 10_000, clickToken: k1.token });
    expect(notCovered.conversion.campaignId).toBeNull();
    // the other offer is covered
    const k2 = await clickFor(db, ws, bob, clock, other.id);
    const covered = await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "restr-2", offerId: other.id, amountMinor: 10_000, clickToken: k2.token });
    expect(covered.conversion.campaignId).toBe(restricted.id);
    expect(covered.commission?.amountMinor).toBe(5_000);

    // after the end date the scheduler ends it and it no longer applies
    clock.advanceDays(3);
    expect(await campaigns.endExpiredCampaigns(db, ws.ctx)).toBe(1);
    expect((await campaigns.getCampaign(db, ws.ctx, restricted.id)).status).toBe("ended");
    const k3 = await clickFor(db, ws, bob, clock, other.id);
    const late = await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "restr-3", offerId: other.id, amountMinor: 10_000, clickToken: k3.token });
    expect(late.conversion.campaignId).toBeNull();
    await expect(campaigns.setCampaignStatus(db, ws.ctx, restricted.id, "active")).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(campaigns.updateCampaign(db, ws.ctx, restricted.id, { name: "x" })).rejects.toMatchObject({ code: "validation" });
  });

  it("campaign assets are visible to active participants of a live campaign only", async () => {
    const secret = await assets.createAsset(db, ws.ctx, { type: "banner", title: "Launch banner", url: "https://cdn.example.com/launch.png", visibility: "restricted", affiliateIds: [bob.id] });
    await campaigns.setCampaignAssets(db, ws.ctx, campaignId, [secret.id]);
    await expect(campaigns.setCampaignAssets(db, ws.ctx, campaignId, ["ast_nope"])).rejects.toMatchObject({ code: "validation" });
    const aliceSees = (await assets.listAssetsForAffiliate(db, affCtx(alice), alice.id)).map((a) => a.id);
    expect(aliceSees).toContain(secret.id);
    const detail = await campaigns.getCampaignDetail(db, ws.ctx, campaignId);
    expect(detail.assets.map((a) => a.id)).toEqual([secret.id]);
    expect((await campaigns.listCampaignsForAffiliate(db, affCtx(alice), alice.id))[0]?.assets.map((a) => a.id)).toEqual([secret.id]);
    // ending the campaign removes campaign-granted access
    await campaigns.setCampaignStatus(db, ws.ctx, campaignId, "ended");
    expect((await assets.listAssetsForAffiliate(db, affCtx(alice), alice.id)).map((a) => a.id)).not.toContain(secret.id);
    const list = await campaigns.listCampaigns(db, ws.ctx);
    expect(list.map((c) => c.status).sort()).toEqual(["ended", "ended"]);
  });
});
