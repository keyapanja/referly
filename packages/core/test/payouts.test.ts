import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { closeDb, createActiveAffiliate, createWorkspace, clickFor, getDb, makeClock, type Workspace } from "./helpers";
import * as conversions from "../src/services/conversions";
import * as commissions from "../src/services/commissions";
import * as payouts from "../src/services/payouts";
import * as tenants from "../src/services/tenants";
import { DomainError } from "../src/errors";

let db: Db;
const clock = makeClock();
let ws: Workspace;

beforeAll(async () => {
  db = await getDb();
  ws = await createWorkspace(db, clock, { programOverrides: { holdingDays: 30 } });
});
afterAll(closeDb);

async function sale(aff: { id: string }, id: string, amount: number) {
  const { token } = await clickFor(db, ws, aff as never, clock);
  return conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: id, offerId: ws.offer.id, amountMinor: amount, clickToken: token });
}

describe("commission lifecycle and payouts (PRD s12)", () => {
  it("holding period gates payability; approval alone does not pay out", async () => {
    const alice = await createActiveAffiliate(db, ws, "Alice");
    const s = await sale(alice, "hold-1", 10_000);
    await commissions.approveCommission(db, ws.ctx, s.commission!.id);
    expect((await commissions.getCommission(db, ws.ctx, s.commission!.id)).status).toBe("approved");
    expect(await commissions.settleHoldingPeriods(db, ws.ctx, clock.now())).toHaveLength(0);
    await expect(payouts.createPayoutBatch(db, ws.ctx, { affiliateId: alice.id })).rejects.toThrow(/nothing payable/);

    clock.advanceDays(30);
    const settled = await commissions.settleHoldingPeriods(db, ws.ctx, clock.now());
    expect(settled.map((c) => c.id)).toContain(s.commission!.id);
    const b = await commissions.getBalances(db, ws.ctx, alice.id);
    expect(b).toMatchObject({ pendingMinor: 0, availableMinor: 2_000, reservedMinor: 0, paidMinor: 0 });
  });

  it("disputed conversions are held back from settlement", async () => {
    const alice = await createActiveAffiliate(db, ws, "Alice");
    const s = await sale(alice, "dispute-1", 10_000);
    await conversions.disputeConversion(db, ws.ctx, s.conversion.id, "customer claims no referral");
    clock.advanceDays(31);
    const settled = await commissions.settleHoldingPeriods(db, ws.ctx, clock.now());
    expect(settled.map((c) => c.id)).not.toContain(s.commission!.id);
  });

  it("payout batch snapshots commissions, marks paid atomically and reconciles", async () => {
    const bob = await createActiveAffiliate(db, ws, "Bob");
    const s1 = await sale(bob, "pay-1", 10_000);
    const s2 = await sale(bob, "pay-2", 5_000);
    clock.advanceDays(31);
    await commissions.settleHoldingPeriods(db, ws.ctx, clock.now());
    await commissions.adjustAffiliateBalance(db, ws.ctx, { affiliateId: bob.id, amountMinor: 500, currency: "USD", reason: "bonus" });

    const payout = await payouts.createPayoutBatch(db, ws.ctx, { affiliateId: bob.id });
    expect(payout.status).toBe("draft");
    expect(payout.amountMinor).toBe(3_500);
    let b = await commissions.getBalances(db, ws.ctx, bob.id);
    expect(b.reservedMinor).toBe(3_000);
    expect(b.availableMinor).toBe(0);
    // nothing left to batch
    await expect(payouts.createPayoutBatch(db, ws.ctx, { affiliateId: bob.id })).rejects.toThrow(DomainError);

    await payouts.markPayoutProcessing(db, ws.ctx, payout.id);
    const paid = await payouts.markPayoutPaid(db, ws.ctx, payout.id, { externalReference: "WISE-42" });
    expect(paid.status).toBe("paid");
    expect(paid.externalReference).toBe("WISE-42");
    for (const c of [s1, s2]) expect((await commissions.getCommission(db, ws.ctx, c.commission!.id)).status).toBe("paid");
    b = await commissions.getBalances(db, ws.ctx, bob.id);
    expect(b).toMatchObject({ availableMinor: 0, reservedMinor: 0, paidMinor: 3_000 });

    const rec = await payouts.reconcilePayout(db, ws.ctx, payout.id);
    expect(rec).toMatchObject({ commissionCount: 2, commissionsMinor: 3_000, adjustmentsMinor: 500, reconciled: true });

    const statement = await commissions.commissionStatement(db, ws.ctx, bob.id, { from: new Date("2020-01-01"), to: clock.now() });
    expect(statement.totals).toMatchObject({ credit: 3_000, adjustment: 500, payout: -3_500 });
    expect(statement.netMinor).toBe(0);
  });

  it("cancelling a draft payout releases commissions back to the available balance", async () => {
    const carol = await createActiveAffiliate(db, ws, "Carol");
    await sale(carol, "cancel-pay-1", 10_000);
    clock.advanceDays(31);
    await commissions.settleHoldingPeriods(db, ws.ctx, clock.now());
    const payout = await payouts.createPayoutBatch(db, ws.ctx, { affiliateId: carol.id });
    await payouts.cancelPayout(db, ws.ctx, payout.id, "wrong bank details");
    const b = await commissions.getBalances(db, ws.ctx, carol.id);
    expect(b.availableMinor).toBe(2_000);
    expect(b.reservedMinor).toBe(0);
    await expect(payouts.markPayoutPaid(db, ws.ctx, payout.id)).rejects.toThrow(/cannot move/);
  });

  it("failed payouts can be retried; paid payouts are terminal", async () => {
    const dan = await createActiveAffiliate(db, ws, "Dan");
    await sale(dan, "fail-pay-1", 10_000);
    clock.advanceDays(31);
    await commissions.settleHoldingPeriods(db, ws.ctx, clock.now());
    const payout = await payouts.createPayoutBatch(db, ws.ctx, { affiliateId: dan.id });
    await payouts.markPayoutProcessing(db, ws.ctx, payout.id);
    await payouts.markPayoutFailed(db, ws.ctx, payout.id, "bank rejected");
    await payouts.markPayoutProcessing(db, ws.ctx, payout.id);
    await payouts.markPayoutPaid(db, ws.ctx, payout.id);
    await expect(payouts.cancelPayout(db, ws.ctx, payout.id, "oops")).rejects.toThrow(/cannot move/);
  });

  it("respects the tenant payout threshold and batches everyone above it", async () => {
    await tenants.updateTenant(db, ws.ctx, { defaults: { payoutThresholdMinor: 2_500 } });
    const eve = await createActiveAffiliate(db, ws, "Eve"); // 20% of 10000 = 2000 < threshold
    const fay = await createActiveAffiliate(db, ws, "Fay"); // 20% of 20000 = 4000 >= threshold
    await sale(eve, "thr-1", 10_000);
    await sale(fay, "thr-2", 20_000);
    clock.advanceDays(31);
    await commissions.settleHoldingPeriods(db, ws.ctx, clock.now());
    await expect(payouts.createPayoutBatch(db, ws.ctx, { affiliateId: eve.id })).rejects.toThrow(/threshold/);
    const created = await payouts.createPayoutBatchesForAll(db, ws.ctx);
    expect(created.map((p) => p.affiliateId)).toContain(fay.id);
    expect(created.map((p) => p.affiliateId)).not.toContain(eve.id);
    await tenants.updateTenant(db, ws.ctx, { defaults: { payoutThresholdMinor: 0 } });
  });

  it("commission state machine rejects illegal transitions", async () => {
    const gil = await createActiveAffiliate(db, ws, "Gil");
    const s = await sale(gil, "sm-1", 1000);
    await commissions.reverseCommission(db, ws.ctx, s.commission!.id, "fraud");
    await expect(commissions.approveCommission(db, ws.ctx, s.commission!.id)).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(commissions.reverseCommission(db, ws.ctx, s.commission!.id, "")).rejects.toMatchObject({ code: "validation" });
  });
});
