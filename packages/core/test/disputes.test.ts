import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { clickFor, closeDb, createActiveAffiliate, createWorkspace, getDb, makeClock, type Workspace } from "./helpers";
import * as disputes from "../src/services/disputes";
import * as conversions from "../src/services/conversions";
import * as commissions from "../src/services/commissions";
import * as automation from "../src/services/automation";
import { jobs as jobsTable, type Affiliate } from "../src/db/schema";
import { tenantContext } from "../src/context";

let db: Db;
const clock = makeClock();
let ws: Workspace;
let alice: Affiliate;
let bob: Affiliate;
const affCtx = (a: Affiliate) => tenantContext(ws.tenant.id, { type: "affiliate", id: a.id, affiliateId: a.id }, clock.now);

async function sale(a: Affiliate, ref: string, amountMinor = 100_000) {
  const c = await clickFor(db, ws, a, clock);
  return conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: ref, offerId: ws.offer.id, amountMinor, clickToken: c.token });
}
async function eventsOf(type: string) {
  return (await db.select().from(jobsTable).where(eq(jobsTable.type, "domain_event"))).map((j) => j.payload as any).filter((e) => e.type === type && e.tenantId === ws.tenant.id);
}

beforeAll(async () => {
  db = await getDb();
  ws = await createWorkspace(db, clock);
  alice = await createActiveAffiliate(db, ws, "Alice");
  bob = await createActiveAffiliate(db, ws, "Bob");
});
afterAll(closeDb);

describe("disputes", () => {
  it("affiliate claims a missing attribution; merchant links the sale, holds it, and reattributes on upholding", async () => {
    const bobSale = await sale(bob, "dsp-1");
    await expect(disputes.openDispute(db, affCtx(alice), { kind: "attribution", reason: "short" })).rejects.toThrow();
    await expect(disputes.openDispute(db, affCtx(alice), { kind: "attribution", reason: "That order came from my newsletter" })).rejects.toMatchObject({ code: "validation" });
    await expect(disputes.openDispute(db, affCtx(alice), { kind: "amount", conversionId: bobSale.conversion.id, reason: "Not mine to see" })).rejects.toMatchObject({ code: "not_found" });
    await expect(disputes.openDispute(db, affCtx(alice), { kind: "fraud", orderReference: "x", reason: "affiliates cannot raise fraud disputes" })).rejects.toMatchObject({ code: "validation" });

    const d = await disputes.openDispute(db, affCtx(alice), { kind: "attribution", orderReference: "dsp-1", reason: "That order came from my newsletter link, please check" });
    expect(d).toMatchObject({ status: "open", raisedBy: "affiliate", affiliateId: alice.id, conversionId: null });
    expect((await automation.listTasks(db, ws.ctx, { status: "open" })).some((t) => t.entityId === d.id)).toBe(true);
    expect((await eventsOf("dispute.opened")).at(-1)?.data).toMatchObject({ affiliateId: alice.id, kind: "attribution" });
    expect((await disputes.listDisputesForAffiliate(db, affCtx(alice), alice.id)).map((x) => x.id)).toEqual([d.id]);
    expect(await disputes.listDisputesForAffiliate(db, affCtx(bob), bob.id)).toEqual([]);
    expect(await disputes.countOpenDisputes(db, ws.ctx)).toBe(1);

    // merchant reviews, links the sale (which holds it), talks to the affiliate
    await disputes.startReview(db, ws.ctx, d.id);
    await disputes.linkConversion(db, ws.ctx, d.id, bobSale.conversion.id);
    expect((await conversions.getConversion(db, ws.ctx, bobSale.conversion.id)).status).toBe("disputed");
    clock.advanceDays(40);
    expect((await commissions.settleHoldingPeriods(db, ws.ctx, clock.now())).some((c) => c.id === bobSale.commission!.id)).toBe(false); // held
    await disputes.addComment(db, ws.ctx, d.id, "Checking the newsletter click logs now.");
    await disputes.addComment(db, affCtx(alice), d.id, "Thanks, the click was on the 3rd.");
    await expect(disputes.addComment(db, affCtx(bob), d.id, "not mine")).rejects.toMatchObject({ code: "not_found" });
    expect((await eventsOf("dispute.commented")).at(-1)?.data.reason).toBe("Checking the newsletter click logs now.");
    const detail = await disputes.getDisputeDetail(db, ws.ctx, d.id);
    expect(detail.comments.map((c) => c.authorType)).toEqual(["merchant", "affiliate"]);
    expect(detail.conversion?.id).toBe(bobSale.conversion.id);

    // upheld: reattribute to Alice
    await expect(disputes.resolveDispute(db, ws.ctx, d.id, { resolution: "upheld", outcome: "reattribute", note: "Click log confirms it" })).rejects.toThrow();
    const resolved = await disputes.resolveDispute(db, ws.ctx, d.id, { resolution: "upheld", outcome: "reattribute", note: "Click log confirms it", reattributeTo: { affiliateId: alice.id, programId: ws.program.id } });
    expect(resolved).toMatchObject({ status: "resolved", resolution: "upheld", outcome: "reattribute" });
    const conv = await conversions.getConversion(db, ws.ctx, bobSale.conversion.id);
    expect(conv.affiliateId).toBe(alice.id);
    expect(conv.status).toBe("pending");
    expect((await commissions.getCommission(db, ws.ctx, bobSale.commission!.id)).status).toBe("void");
    const current = await conversions.currentCommission(db, conv.id);
    expect(current?.affiliateId).toBe(alice.id);
    expect((await eventsOf("dispute.resolved")).at(-1)?.data).toMatchObject({ resolution: "upheld", outcome: "reattribute" });
    expect((await disputes.getDisputeDetail(db, ws.ctx, d.id)).comments.at(-1)?.authorType).toBe("system");
    await expect(disputes.addComment(db, ws.ctx, d.id, "late")).rejects.toMatchObject({ code: "validation" });
  });

  it("merchant disputes a sale as fraud; rejected restores it, upheld cancels it and voids the commission", async () => {
    const s1 = await sale(alice, "dsp-2");
    await conversions.approveConversion(db, ws.ctx, s1.conversion.id);
    await expect(disputes.openDispute(db, ws.ctx, { kind: "attribution", conversionId: s1.conversion.id, reason: "merchants cannot raise attribution" })).rejects.toMatchObject({ code: "validation" });
    const d1 = await disputes.openDispute(db, ws.ctx, { kind: "fraud", conversionId: s1.conversion.id, reason: "Card was charged back by the customer" });
    expect(d1).toMatchObject({ raisedBy: "merchant", affiliateId: alice.id, previousConversionStatus: "approved" });
    expect((await conversions.getConversion(db, ws.ctx, s1.conversion.id)).status).toBe("disputed");
    await expect(disputes.openDispute(db, ws.ctx, { kind: "other", conversionId: s1.conversion.id, reason: "second dispute on the same sale" })).rejects.toMatchObject({ code: "conflict" });

    // rejected → restored to approved
    await disputes.resolveDispute(db, ws.ctx, d1.id, { resolution: "rejected", outcome: "restore", note: "Chargeback was reversed by the bank" });
    expect((await conversions.getConversion(db, ws.ctx, s1.conversion.id)).status).toBe("approved");

    // upheld + cancel
    const d2 = await disputes.openDispute(db, ws.ctx, { kind: "refund", conversionId: s1.conversion.id, reason: "Customer refunded in full outside the platform" });
    await disputes.resolveDispute(db, ws.ctx, d2.id, { resolution: "upheld", outcome: "cancel", note: "Refund confirmed" });
    expect((await conversions.getConversion(db, ws.ctx, s1.conversion.id)).status).toBe("cancelled");
    expect((await commissions.getCommission(db, ws.ctx, s1.commission!.id)).status).toBe("void");
    expect((await disputes.listDisputes(db, ws.ctx, { status: "resolved" })).map((d) => d.id)).toEqual(expect.arrayContaining([d1.id, d2.id]));
  });

  it("affiliates can withdraw their own open dispute, which releases the sale; other tenants see nothing", async () => {
    const s = await sale(alice, "dsp-3");
    const d = await disputes.openDispute(db, affCtx(alice), { kind: "amount", conversionId: s.conversion.id, reason: "Commission looks lower than my rate" });
    expect((await conversions.getConversion(db, ws.ctx, s.conversion.id)).status).toBe("disputed");
    await expect(disputes.withdrawDispute(db, affCtx(bob), d.id)).rejects.toMatchObject({ code: "forbidden" });
    const w = await disputes.withdrawDispute(db, affCtx(alice), d.id);
    expect(w.status).toBe("withdrawn");
    expect((await conversions.getConversion(db, ws.ctx, s.conversion.id)).status).toBe("pending");
    await expect(disputes.withdrawDispute(db, affCtx(alice), d.id)).rejects.toMatchObject({ code: "validation" });
    const other = await createWorkspace(db, clock);
    expect(await disputes.listDisputes(db, other.ctx)).toEqual([]);
    await expect(disputes.getDispute(db, other.ctx, d.id)).rejects.toMatchObject({ code: "not_found" });
    const list = await disputes.listDisputes(db, ws.ctx);
    expect(list[0]?.status === "open" || list[0]?.status === "under_review" || list.every((x) => x.status === "resolved" || x.status === "withdrawn")).toBe(true);
  });
});
