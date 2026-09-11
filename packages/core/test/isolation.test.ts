import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { closeDb, createActiveAffiliate, createWorkspace, clickFor, getDb, makeClock, type Workspace } from "./helpers";
import * as conversions from "../src/services/conversions";
import * as commissions from "../src/services/commissions";
import * as payouts from "../src/services/payouts";
import * as offersSvc from "../src/services/offers";
import * as programsSvc from "../src/services/programs";
import * as affiliatesSvc from "../src/services/affiliates";
import * as tracking from "../src/services/tracking";
import * as auth from "../src/services/auth";
import { tenantContext } from "../src/context";
import { resolveAttribution } from "../src/services/attribution";

let db: Db;
const clock = makeClock();
let a: Workspace;
let b: Workspace;

beforeAll(async () => {
  db = await getDb();
  a = await createWorkspace(db, clock);
  b = await createWorkspace(db, clock);
});
afterAll(closeDb);

describe("tenant isolation (PRD s15, s17)", () => {
  it("reads by id fail closed across tenants", async () => {
    const aliceA = await createActiveAffiliate(db, a, "Alice");
    const saleA = await conversions.recordConversion(db, a.ctx, { source: "api", externalOrderId: "iso-1", offerId: a.offer.id, amountMinor: 1000, affiliateId: aliceA.id, programId: a.program.id, reason: "x" });
    await expect(offersSvc.getOffer(db, b.ctx, a.offer.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(programsSvc.getProgram(db, b.ctx, a.program.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(affiliatesSvc.getAffiliate(db, b.ctx, aliceA.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(conversions.getConversion(db, b.ctx, saleA.conversion.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(commissions.getCommission(db, b.ctx, saleA.commission!.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await conversions.listConversions(db, b.ctx)).toHaveLength(0);
    expect(await commissions.listCommissions(db, b.ctx)).toHaveLength(0);
    expect(await affiliatesSvc.listAffiliates(db, b.ctx)).toHaveLength(0);
  });

  it("writes cannot target another tenant's records", async () => {
    const aliceA = await createActiveAffiliate(db, a, "Alice");
    const saleA = await conversions.recordConversion(db, a.ctx, { source: "api", externalOrderId: "iso-2", offerId: a.offer.id, amountMinor: 1000, affiliateId: aliceA.id, programId: a.program.id, reason: "x" });
    await expect(offersSvc.setOfferStatus(db, b.ctx, a.offer.id, "paused")).rejects.toMatchObject({ code: "not_found" });
    await expect(conversions.refundConversion(db, b.ctx, { conversionId: saleA.conversion.id, reason: "steal" })).rejects.toMatchObject({ code: "not_found" });
    await expect(commissions.reverseCommission(db, b.ctx, saleA.commission!.id, "steal")).rejects.toMatchObject({ code: "not_found" });
    await expect(payouts.createPayoutBatch(db, b.ctx, { affiliateId: aliceA.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(programsSvc.attachOffer(db, b.ctx, b.program.id, a.offer.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(affiliatesSvc.suspendAffiliate(db, b.ctx, aliceA.id, "x")).rejects.toMatchObject({ code: "not_found" });
  });

  it("click tokens and coupons from tenant A never attribute tenant B conversions", async () => {
    const aliceA = await createActiveAffiliate(db, a, "Alice");
    const { token } = await clickFor(db, a, aliceA, clock);
    await tracking.createCouponCode(db, a.ctx, { affiliateId: aliceA.id, programId: a.program.id, code: "CROSS" });
    const res = await resolveAttribution(db, b.ctx, { offerId: b.offer.id, occurredAt: clock.now(), clickTokens: [token], couponCode: "CROSS" });
    expect(res.decision).toBeNull();
    // tenant A's evidence gives nobody in tenant B a claim, so tenant B keeps no record at all
    await expect(conversions.recordConversion(db, b.ctx, { source: "api", externalOrderId: "iso-3", offerId: b.offer.id, amountMinor: 1000, clickToken: token, couponCode: "CROSS" })).rejects.toBeInstanceOf(conversions.NoAffiliateError);
  });

  it("idempotency keys are scoped per tenant", async () => {
    const clickA = await clickFor(db, a, await createActiveAffiliate(db, a, "Ann"), clock);
    const clickB = await clickFor(db, b, await createActiveAffiliate(db, b, "Ben"), clock);
    const x = await conversions.recordConversion(db, a.ctx, { source: "webhook", externalOrderId: "same-id", amountMinor: 100, clickToken: clickA.token });
    const y = await conversions.recordConversion(db, b.ctx, { source: "webhook", externalOrderId: "same-id", amountMinor: 100, clickToken: clickB.token });
    expect(x.conversion.id).not.toBe(y.conversion.id);
    expect(y.duplicate).toBe(false);
  });

  it("sessions and API keys resolve only to their own tenant", async () => {
    const login = await auth.loginWithPassword(db, { email: a.owner.email, password: "password123" }, clock.now());
    const resolved = await auth.resolveSession(db, login.token, clock.now());
    expect(resolved?.tenantId).toBe(a.tenant.id);
    const { secret } = await auth.createApiKey(db, a.ctx, { name: "checkout" });
    expect((await auth.resolveApiKey(db, secret))?.tenantId).toBe(a.tenant.id);
    expect(await auth.resolveApiKey(db, "rk_live_nope")).toBeNull();
    await expect(auth.loginWithPassword(db, { email: a.owner.email, password: "wrong-password" })).rejects.toMatchObject({ code: "unauthenticated" });
  });
});

describe("role permissions", () => {
  it("readonly users cannot write; affiliates only see their own data", async () => {
    const readonly = tenantContext(a.tenant.id, { type: "user", id: "usr_ro", role: "readonly" }, clock.now);
    await expect(offersSvc.createOffer(db, readonly, { name: "x", salesUrl: "https://a.example.com" }, "USD")).rejects.toMatchObject({ code: "forbidden" });
    await expect(conversions.recordConversion(db, readonly, { source: "api", externalOrderId: "ro", amountMinor: 1 })).rejects.toMatchObject({ code: "forbidden" });
    expect(await offersSvc.listOffers(db, readonly)).not.toHaveLength(0);

    const alice = await createActiveAffiliate(db, a, "Alice");
    const bob = await createActiveAffiliate(db, a, "Bob");
    const aliceCtx = tenantContext(a.tenant.id, { type: "affiliate", id: alice.userId ?? alice.id, affiliateId: alice.id }, clock.now);
    await expect(commissions.getBalances(db, aliceCtx, bob.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(tracking.createTrackingLink(db, aliceCtx, { affiliateId: bob.id, programId: a.program.id, offerId: a.offer.id })).rejects.toMatchObject({ code: "forbidden" });
    const own = await tracking.createTrackingLink(db, aliceCtx, { affiliateId: alice.id, programId: a.program.id, offerId: a.offer.id });
    expect(own.affiliateId).toBe(alice.id);
    await expect(affiliatesSvc.listAffiliates(db, aliceCtx)).rejects.toMatchObject({ code: "forbidden" });
  });
});
