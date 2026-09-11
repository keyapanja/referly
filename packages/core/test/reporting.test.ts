import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { clickFor, closeDb, createActiveAffiliate, createWorkspace, getDb, makeClock, type Workspace } from "./helpers";
import * as reporting from "../src/services/reporting";
import * as conversions from "../src/services/conversions";
import * as groups from "../src/services/groups";
import type { Affiliate } from "../src/db/schema";

let db: Db;
const clock = makeClock("2026-03-01T12:00:00Z");
let ws: Workspace;
let alice: Affiliate;
let bob: Affiliate;

beforeAll(async () => {
  db = await getDb();
  ws = await createWorkspace(db, clock);
  alice = await createActiveAffiliate(db, ws, "Alice");
  bob = await createActiveAffiliate(db, ws, "Bob");
  // week 1 (previous period): 1 sale by Alice; week 2 (current): 2 sales; an order no affiliate can claim is not recorded
  clock.set("2026-03-02T10:00:00Z");
  let c = await clickFor(db, ws, alice, clock);
  await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "r-1", offerId: ws.offer.id, amountMinor: 10_000, clickToken: c.token });
  clock.set("2026-03-09T10:00:00Z");
  c = await clickFor(db, ws, alice, clock);
  await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "r-2", offerId: ws.offer.id, amountMinor: 20_000, clickToken: c.token });
  clock.set("2026-03-11T10:00:00Z");
  c = await clickFor(db, ws, bob, clock);
  await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "r-3", offerId: ws.offer.id, amountMinor: 30_000, clickToken: c.token });
  await clickFor(db, ws, bob, clock); // a click with no sale
  await expect(conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "r-4", offerId: ws.offer.id, amountMinor: 5_000 })).rejects.toBeInstanceOf(conversions.NoAffiliateError);
});
afterAll(closeDb);

const current = { from: new Date("2026-03-08T00:00:00Z"), to: new Date("2026-03-14T23:59:59Z") };

describe("richer analytics", () => {
  it("time series fills every bucket and separates attributed from total", async () => {
    const ts = await reporting.timeseries(db, ws.ctx, current, "day");
    expect(ts.granularity).toBe("day");
    expect(ts.buckets.map((b) => b.date)).toEqual(["2026-03-08", "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13", "2026-03-14"]);
    const mar9 = ts.buckets.find((b) => b.date === "2026-03-09")!;
    expect(mar9).toMatchObject({ clicks: 1, conversions: 1, attributedConversions: 1, revenueMinor: 20_000, attributedRevenueMinor: 20_000, commissionMinor: 4_000 });
    const mar11 = ts.buckets.find((b) => b.date === "2026-03-11")!;
    expect(mar11).toMatchObject({ clicks: 2, conversions: 1, attributedConversions: 1, revenueMinor: 30_000, attributedRevenueMinor: 30_000 });
    expect(ts.buckets.find((b) => b.date === "2026-03-13")).toMatchObject({ clicks: 0, conversions: 0, revenueMinor: 0 });
    const weekly = await reporting.timeseries(db, ws.ctx, { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-03-14T23:59:59Z") }, "week");
    expect(weekly.buckets.map((b) => [b.date, b.attributedConversions])).toEqual([["2026-02-23", 0], ["2026-03-02", 1], ["2026-03-09", 2]]);
    expect(reporting.autoGranularity({ from: new Date("2026-01-01"), to: new Date("2026-12-31") })).toBe("week");
    expect(reporting.autoGranularity({ from: new Date("2020-01-01"), to: new Date("2026-12-31") })).toBe("month");
  });

  it("compares against the previous period of equal length with deltas", async () => {
    const cmp = await reporting.compare(db, ws.ctx, current);
    expect(cmp.previous.from.toISOString().slice(0, 10)).toBe("2026-03-01");
    expect(cmp.current).toMatchObject({ clicks: 3, conversions: 2, attributedConversions: 2, attributedRevenueMinor: 50_000, revenueMinor: 50_000, conversionRate: 0.6667 });
    expect(cmp.before).toMatchObject({ clicks: 1, attributedConversions: 1, attributedRevenueMinor: 10_000, newAffiliates: 2 });
    expect(cmp.deltas.attributedRevenueMinor).toEqual({ abs: 40_000, pct: 4 });
    expect(cmp.deltas.clicks).toEqual({ abs: 2, pct: 2 });
    expect(cmp.deltas.newAffiliates).toEqual({ abs: -2, pct: -1 });
    expect(cmp.deltas.commissionMinor.pct).not.toBeNull();
  });

  it("funnel and group breakdown", async () => {
    const f = await reporting.funnel(db, ws.ctx, current);
    expect(f.stages.map((s) => [s.key, s.value])).toEqual([["clicks", 3], ["attributed", 2], ["approved", 0]]);
    expect(f.stages[1]!.rateFromPrevious).toBe(0.6667);
    expect(f).toMatchObject({ activeAffiliatesWithClicks: 2, unattributedSales: 0, bySource: { link: 2, coupon: 0, manual: 0 } });

    const g = await groups.createGroup(db, ws.ctx, { name: "Creators", kind: "partner_type" });
    await groups.addMembers(db, ws.ctx, g.id, [alice.id]);
    const byGroup = await reporting.byGroup(db, ws.ctx, current);
    expect(byGroup.rows).toEqual([expect.objectContaining({ name: "Creators", affiliates: 1, clicks: 1, conversions: 1, revenueMinor: 20_000, commissionMinor: 4_000 })]);
    const other = await createWorkspace(db, clock);
    expect((await reporting.timeseries(db, other.ctx, current, "day")).buckets.every((b) => b.conversions === 0)).toBe(true);
  });
});
