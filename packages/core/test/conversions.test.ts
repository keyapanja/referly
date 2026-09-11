import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { closeDb, createActiveAffiliate, createWorkspace, clickFor, getDb, makeClock, type Workspace } from "./helpers";
import * as conversions from "../src/services/conversions";
import * as commissions from "../src/services/commissions";
import * as payouts from "../src/services/payouts";
import * as programs from "../src/services/programs";
import * as affiliates from "../src/services/affiliates";
import { listAudit } from "../src/services/audit";
import { DomainError } from "../src/errors";

let db: Db;
const clock = makeClock();
let ws: Workspace;

beforeAll(async () => {
  db = await getDb();
  ws = await createWorkspace(db, clock);
});
afterAll(closeDb);

describe("conversion intake", () => {
  it("duplicate webhooks return the original and never create a second commission (TRK-07)", async () => {
    const alice = await createActiveAffiliate(db, ws, "Alice");
    const { token } = await clickFor(db, ws, alice, clock);
    const input = { source: "webhook" as const, externalOrderId: "dup-1", offerId: ws.offer.id, amountMinor: 10_000, clickToken: token };
    const first = await conversions.recordConversion(db, ws.ctx, input);
    const second = await conversions.recordConversion(db, ws.ctx, { ...input, amountMinor: 99_999 });
    expect(second.duplicate).toBe(true);
    expect(second.conversion.id).toBe(first.conversion.id);
    expect(second.commission?.id).toBe(first.commission?.id);
    const all = await commissions.listCommissions(db, ws.ctx, { affiliateId: alice.id });
    expect(all).toHaveLength(1);
  });

  it("concurrent duplicate webhooks resolve to one conversion", async () => {
    const alice = await createActiveAffiliate(db, ws, "Alice");
    const { token } = await clickFor(db, ws, alice, clock);
    const input = { source: "webhook" as const, externalOrderId: "dup-race", offerId: ws.offer.id, amountMinor: 10_000, clickToken: token };
    const results = await Promise.all([1, 2, 3, 4].map(() => conversions.recordConversion(db, ws.ctx, input)));
    const ids = new Set(results.map((r) => r.conversion.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
  });

  it("same order id under a different source is the same sale (no second commission)", async () => {
    const seller = await createActiveAffiliate(db, ws, "Sam");
    const { token } = await clickFor(db, ws, seller, clock);
    const a = await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "shared", amountMinor: 100, clickToken: token });
    const b = await conversions.recordConversion(db, ws.ctx, { source: "manual", externalOrderId: "shared", amountMinor: 100 });
    expect(b.duplicate).toBe(true);
    expect(a.conversion.id).toBe(b.conversion.id);
  });

  it("commission basis and overrides are applied with the right precedence", async () => {
    const alice = await createActiveAffiliate(db, ws, "Alice");
    const { token } = await clickFor(db, ws, alice, clock);
    // program: 20% gross → override at program-offer 10% → affiliate override 25%
    await programs.attachOffer(db, ws.ctx, ws.program.id, ws.offer.id, { commissionPercent: 10 });
    const r1 = await conversions.recordConversion(db, ws.ctx, { source: "api", externalOrderId: "basis-1", offerId: ws.offer.id, amountMinor: 10_000, netAmountMinor: 8_000, clickToken: token });
    expect(r1.commission?.amountMinor).toBe(1_000);
    expect(r1.commission?.calculationBasis.overrideSource).toBe("program_offer");

    await affiliates.setAffiliateCommissionOverride(db, ws.ctx, alice.id, ws.program.id, { commissionPercent: 25 }, "negotiated");
    await programs.updateProgram(db, ws.ctx, ws.program.id, { commissionBasis: "net" });
    const r2 = await conversions.recordConversion(db, ws.ctx, { source: "api", externalOrderId: "basis-2", offerId: ws.offer.id, amountMinor: 10_000, netAmountMinor: 8_000, clickToken: token });
    expect(r2.commission?.amountMinor).toBe(2_000); // 25% of net 8000
    expect(r2.commission?.calculationBasis).toMatchObject({ basis: "net", basisAmountMinor: 8_000, overrideSource: "affiliate_program" });

    // rule change afterwards does not touch the existing commission (s22)
    await programs.updateProgram(db, ws.ctx, ws.program.id, { commissionPercent: 50, commissionBasis: "gross" });
    expect((await commissions.getCommission(db, ws.ctx, r2.commission!.id)).amountMinor).toBe(2_000);
    await programs.attachOffer(db, ws.ctx, ws.program.id, ws.offer.id);
    await programs.updateProgram(db, ws.ctx, ws.program.id, { commissionPercent: 20 });
  });

  it("manual attribution requires a reason and is audited", async () => {
    const alice = await createActiveAffiliate(db, ws, "Alice");
    await expect(
      conversions.recordConversion(db, ws.ctx, { source: "manual", externalOrderId: "man-0", amountMinor: 1000, affiliateId: alice.id, programId: ws.program.id }),
    ).rejects.toThrow(/reason/);
    const res = await conversions.recordConversion(db, ws.ctx, { source: "manual", externalOrderId: "man-1", offerId: ws.offer.id, amountMinor: 1000, affiliateId: alice.id, programId: ws.program.id, reason: "phone sale" });
    expect(res.attribution?.ruleApplied).toBe("manual");
    expect(res.attribution?.reason).toBe("phone sale");
    const audit = await listAudit(db, ws.ctx, { entityType: "conversion", entityId: res.conversion.id });
    expect(audit[0]?.reason).toBe("phone sale");
    expect(audit[0]?.actorUserId).toBe(ws.owner.id);
  });
});

describe("refunds and reversals (journey G)", () => {
  async function sale(id: string, amount = 10_000, overrides: Partial<programs.CreateProgramInput> = {}) {
    const w = Object.keys(overrides).length ? await createWorkspace(db, clock, { programOverrides: overrides }) : ws;
    const aff = await createActiveAffiliate(db, w, "Zed");
    const { token } = await clickFor(db, w, aff, clock);
    const res = await conversions.recordConversion(db, w.ctx, { source: "webhook", externalOrderId: id, offerId: w.offer.id, amountMinor: amount, clickToken: token });
    return { w, aff, res };
  }

  it("full refund policy reverses the whole commission on any refund", async () => {
    const { w, res } = await sale("rf-full");
    const out = await conversions.refundConversion(db, w.ctx, { conversionId: res.conversion.id, amountMinor: 1_000, reason: "customer request" });
    expect(out.conversion.status).toBe("refunded");
    expect(out.conversion.refundedAmountMinor).toBe(1_000);
    expect(out.commission?.status).toBe("reversed");
    expect(out.commission?.amountMinor).toBe(0);
    const ledger = await commissions.listLedger(db, w.ctx, out.commission!.affiliateId);
    expect(ledger.map((l) => [l.type, l.amountMinor])).toEqual([
      ["reversal", -2_000],
      ["credit", 2_000],
    ]);
  });

  it("partial refund policy reduces proportionally, then reverses when fully refunded", async () => {
    const { w, res } = await sale("rf-partial", 10_000, { refundPolicy: "partial" });
    const first = await conversions.refundConversion(db, w.ctx, { conversionId: res.conversion.id, amountMinor: 2_500, reason: "partial" });
    expect(first.commission?.status).toBe("pending");
    expect(first.commission?.amountMinor).toBe(1_500); // 20% of remaining 7500
    const second = await conversions.refundConversion(db, w.ctx, { conversionId: res.conversion.id, reason: "rest" });
    expect(second.conversion.refundedAmountMinor).toBe(10_000);
    expect(second.commission?.status).toBe("reversed");
    await expect(conversions.refundConversion(db, w.ctx, { conversionId: res.conversion.id, amountMinor: 1, reason: "too much" })).rejects.toThrow(/exceeds/);
  });

  it("refund policy none leaves commission untouched", async () => {
    const { w, res } = await sale("rf-none", 10_000, { refundPolicy: "none" });
    const out = await conversions.refundConversion(db, w.ctx, { conversionId: res.conversion.id, amountMinor: 5_000, reason: "goodwill" });
    expect(out.commission?.status).toBe("pending");
    expect(out.commission?.amountMinor).toBe(2_000);
  });

  it("refund after payout creates a clawback that reduces the next payable balance", async () => {
    const { w, aff, res } = await sale("rf-paid", 10_000, { holdingDays: 0 });
    clock.advanceDays(1);
    await commissions.settleHoldingPeriods(db, w.ctx, clock.now());
    const payout = await payouts.recordExternalPayout(db, w.ctx, { affiliateId: aff.id, externalReference: "BANK-1" });
    expect(payout.amountMinor).toBe(2_000);
    expect((await commissions.getCommission(db, w.ctx, res.commission!.id)).status).toBe("paid");

    await conversions.refundConversion(db, w.ctx, { conversionId: res.conversion.id, reason: "chargeback" });
    const c = await commissions.getCommission(db, w.ctx, res.commission!.id);
    expect(c.status).toBe("paid"); // status never regresses; money is corrected through the ledger
    const balances = await commissions.getBalances(db, w.ctx, aff.id);
    expect(balances.availableMinor).toBe(-2_000);
    expect(balances.paidMinor).toBe(2_000);

    // a new sale nets against the clawback in the next payout
    const { token } = await clickFor(db, w, aff, clock);
    await conversions.recordConversion(db, w.ctx, { source: "webhook", externalOrderId: "rf-paid-2", offerId: w.offer.id, amountMinor: 15_000, clickToken: token });
    clock.advanceDays(1);
    await commissions.settleHoldingPeriods(db, w.ctx, clock.now());
    const next = await payouts.createPayoutBatch(db, w.ctx, { affiliateId: aff.id });
    expect(next.amountMinor).toBe(1_000); // 3000 - 2000 clawback
    expect((await payouts.reconcilePayout(db, w.ctx, next.id)).reconciled).toBe(true);
  });

  it("cancelling voids the commission", async () => {
    const { w, res } = await sale("cancel-1");
    await conversions.cancelConversion(db, w.ctx, res.conversion.id, "fraud");
    expect((await commissions.getCommission(db, w.ctx, res.commission!.id)).status).toBe("void");
    await expect(conversions.approveConversion(db, w.ctx, res.conversion.id)).rejects.toThrow(DomainError);
  });

  it("reattribution voids the old commission, creates a new one and keeps the audit trail", async () => {
    const { w, res, aff } = await sale("reattr-1");
    const bob = await createActiveAffiliate(db, w, "Bob");
    const out = await conversions.reattributeConversion(db, w.ctx, { conversionId: res.conversion.id, affiliateId: bob.id, reason: "customer confirmed Bob referred them" });
    expect(out.conversion.affiliateId).toBe(bob.id);
    expect(out.commission?.affiliateId).toBe(bob.id);
    expect(out.commission?.amountMinor).toBe(2_000);
    expect((await commissions.getCommission(db, w.ctx, res.commission!.id)).status).toBe("void");
    const timeline = await conversions.getConversionTimeline(db, w.ctx, res.conversion.id);
    expect(timeline.attributions).toHaveLength(2);
    expect(timeline.attributions.find((a) => a.affiliateId === aff.id)?.supersededById).toBe(out.attribution!.id);
    expect(timeline.commission?.id).toBe(out.commission!.id);
    expect((await commissions.getBalances(db, w.ctx, aff.id)).pendingMinor).toBe(0);
    expect((await commissions.getBalances(db, w.ctx, bob.id)).pendingMinor).toBe(2_000);
  });
});
