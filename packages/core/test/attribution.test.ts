import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { closeDb, createActiveAffiliate, createWorkspace, clickFor, getDb, makeClock, type Workspace } from "./helpers";
import * as conversions from "../src/services/conversions";
import * as affiliates from "../src/services/affiliates";
import * as tracking from "../src/services/tracking";
import * as programs from "../src/services/programs";
import * as offers from "../src/services/offers";
import { resolveAttribution } from "../src/services/attribution";

let db: Db;
const clock = makeClock();
let ws: Workspace;

beforeAll(async () => {
  db = await getDb();
  ws = await createWorkspace(db, clock);
});
afterAll(closeDb);

describe("attribution rules (PRD s11)", () => {
  it("single link click + purchase inside window attributes to that affiliate", async () => {
    const alice = await createActiveAffiliate(db, ws, "Alice");
    const { token, click } = await clickFor(db, ws, alice, clock);
    clock.advanceDays(3);
    const res = await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "ord-1", offerId: ws.offer.id, amountMinor: 100_000, clickToken: token });
    expect(res.duplicate).toBe(false);
    expect(res.conversion.affiliateId).toBe(alice.id);
    expect(res.attribution?.ruleApplied).toBe("last_click");
    expect(res.attribution?.clickId).toBe(click.id);
    expect(res.commission?.amountMinor).toBe(20_000);
    expect(res.commission?.status).toBe("pending");
  });

  it("multiple affiliate clicks: last eligible touch wins by default", async () => {
    const alice = await createActiveAffiliate(db, ws, "Alice");
    const bob = await createActiveAffiliate(db, ws, "Bob");
    const a = await clickFor(db, ws, alice, clock);
    clock.advanceDays(1);
    const b = await clickFor(db, ws, bob, clock);
    clock.advanceDays(1);
    const res = await resolveAttribution(db, ws.ctx, { offerId: ws.offer.id, occurredAt: clock.now(), clickTokens: [a.token, b.token] });
    expect(res.decision?.affiliateId).toBe(bob.id);
    expect(res.decision?.rule).toBe("last_click");
    expect(res.candidates).toHaveLength(2);
    expect(res.candidates.every((c) => c.eligible)).toBe(true);
  });

  it("first-touch programs pick the earliest eligible click", async () => {
    const ft = await createWorkspace(db, clock, { programOverrides: { attributionModel: "first_touch" } });
    const alice = await createActiveAffiliate(db, ft, "Alice");
    const bob = await createActiveAffiliate(db, ft, "Bob");
    const a = await clickFor(db, ft, alice, clock);
    clock.advanceDays(1);
    const b = await clickFor(db, ft, bob, clock);
    const res = await resolveAttribution(db, ft.ctx, { offerId: ft.offer.id, occurredAt: clock.now(), clickTokens: [a.token, b.token] });
    expect(res.decision?.affiliateId).toBe(alice.id);
    expect(res.decision?.rule).toBe("first_click");
  });

  it("coupon code wins over link by default; link wins when configured", async () => {
    const alice = await createActiveAffiliate(db, ws, "Alice");
    const bob = await createActiveAffiliate(db, ws, "Bob");
    const a = await clickFor(db, ws, alice, clock);
    const coupon = await tracking.createCouponCode(db, ws.ctx, { affiliateId: bob.id, programId: ws.program.id, code: "BOB20" });

    const res = await resolveAttribution(db, ws.ctx, { offerId: ws.offer.id, occurredAt: clock.now(), clickTokens: [a.token], couponCode: "bob20" });
    expect(res.decision?.affiliateId).toBe(bob.id);
    expect(res.decision?.rule).toBe("coupon");
    expect(res.decision?.couponCodeId).toBe(coupon.id);

    await programs.updateProgram(db, ws.ctx, ws.program.id, { precedence: "link_wins" });
    const res2 = await resolveAttribution(db, ws.ctx, { offerId: ws.offer.id, occurredAt: clock.now(), clickTokens: [a.token], couponCode: "BOB20" });
    expect(res2.decision?.affiliateId).toBe(alice.id);
    expect(res2.decision?.rule).toBe("last_click");
    await programs.updateProgram(db, ws.ctx, ws.program.id, { precedence: "coupon_wins" });
  });

  it("coupon without any click still attributes", async () => {
    const carol = await createActiveAffiliate(db, ws, "Carol");
    await tracking.createCouponCode(db, ws.ctx, { affiliateId: carol.id, programId: ws.program.id, code: "CAROL" });
    const res = await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "ord-coupon-only", offerId: ws.offer.id, amountMinor: 50_000, couponCode: "carol" });
    expect(res.conversion.affiliateId).toBe(carol.id);
    expect(res.conversion.attributionSource).toBe("coupon");
    expect(res.commission?.amountMinor).toBe(10_000);
  });

  it("expired attribution window yields no commission", async () => {
    const alice = await createActiveAffiliate(db, ws, "Alice");
    const { token } = await clickFor(db, ws, alice, clock);
    clock.advanceDays(31);
    const res = await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "ord-expired", offerId: ws.offer.id, amountMinor: 100_000, clickToken: token });
    expect(res.conversion.affiliateId).toBeNull();
    expect(res.conversion.attributionSource).toBe("none");
    expect(res.commission).toBeNull();
  });

  it("expired click is skipped but a valid coupon still attributes", async () => {
    const alice = await createActiveAffiliate(db, ws, "Alice");
    const dave = await createActiveAffiliate(db, ws, "Dave");
    const { token } = await clickFor(db, ws, alice, clock);
    await tracking.createCouponCode(db, ws.ctx, { affiliateId: dave.id, programId: ws.program.id, code: "DAVE" });
    clock.advanceDays(40);
    const res = await resolveAttribution(db, ws.ctx, { offerId: ws.offer.id, occurredAt: clock.now(), clickTokens: [token], couponCode: "DAVE" });
    expect(res.decision?.affiliateId).toBe(dave.id);
    expect(res.candidates.find((c) => c.rule === "click")?.ineligibleReason).toBe("window_expired");
  });

  it("suspended affiliate gets no new attribution", async () => {
    const alice = await createActiveAffiliate(db, ws, "Alice");
    const { token } = await clickFor(db, ws, alice, clock);
    await affiliates.suspendAffiliate(db, ws.ctx, alice.id, "policy violation");
    const res = await resolveAttribution(db, ws.ctx, { offerId: ws.offer.id, occurredAt: clock.now(), clickTokens: [token] });
    expect(res.decision).toBeNull();
    expect(res.candidates[0]?.ineligibleReason).toBe("affiliate_suspended");
    // suspended affiliate's links also stop tracking
    const link = (await tracking.listTrackingLinks(db, ws.ctx, alice.id))[0]!;
    const click = await tracking.recordClick(db, link.token, {}, clock.now());
    expect(click?.tracked).toBe(false);
    expect(click?.reason).toBe("affiliate_inactive");
    expect(click?.destinationUrl).toBe(ws.offer.salesUrl); // visitor is still redirected
  });

  it("offer outside the program is ineligible; unknown coupon is reported", async () => {
    const alice = await createActiveAffiliate(db, ws, "Alice");
    const other = await offers.createOffer(db, ws.ctx, { name: "Other", salesUrl: "https://acme.example.com/other" }, "USD");
    const { token } = await clickFor(db, ws, alice, clock);
    const res = await resolveAttribution(db, ws.ctx, { offerId: other.id, occurredAt: clock.now(), clickTokens: [token], couponCode: "NOPE" });
    expect(res.decision).toBeNull();
    expect(res.candidates.map((c) => c.ineligibleReason).sort()).toEqual(["code_unknown", "offer_not_in_program"]);
  });

  it("test-mode programs never create payable commissions", async () => {
    const tm = await createWorkspace(db, clock, { programOverrides: { testMode: true, holdingDays: 0 } });
    const alice = await createActiveAffiliate(db, tm, "Alice");
    const { token } = await clickFor(db, tm, alice, clock);
    const res = await conversions.recordConversion(db, tm.ctx, { source: "webhook", externalOrderId: "t-1", offerId: tm.offer.id, amountMinor: 1000, clickToken: token });
    expect(res.commission?.isTest).toBe(true);
    const { settleHoldingPeriods, getBalances } = await import("../src/services/commissions");
    clock.advanceDays(1);
    expect(await settleHoldingPeriods(db, tm.ctx, clock.now())).toHaveLength(0);
    expect((await getBalances(db, tm.ctx, alice.id)).availableMinor).toBe(0);
  });
});
