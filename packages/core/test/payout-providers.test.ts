import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { clickFor, closeDb, createActiveAffiliate, createWorkspace, getDb, makeClock, type Workspace } from "./helpers";
import { MemoryPayoutProvider, PayPalPayoutsProvider, StripeConnectProvider, type PayoutProviderFactory } from "../src/services/payoutProviders";
import * as integrations from "../src/services/integrations";
import * as payoutsSvc from "../src/services/payouts";
import * as commissions from "../src/services/commissions";
import * as conversions from "../src/services/conversions";
import * as affiliatesSvc from "../src/services/affiliates";
import { decryptJson, encryptJson } from "../src/crypto";
import { tenantIntegrations, jobs as jobsTable, type Affiliate } from "../src/db/schema";
import { tenantContext } from "../src/context";

type Call = { url: string; init: RequestInit };
function stubFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const res = handler(u, init ?? {});
    return new Response(JSON.stringify(res.body), { status: res.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("payout provider adapters", () => {
  it("Stripe Connect: transfers with an idempotency key; failures are reported, not thrown", async () => {
    const { fetchImpl, calls } = stubFetch((url) => {
      if (url.endsWith("/v1/balance")) return { body: { available: [] } };
      if (url.endsWith("/v1/transfers")) return { body: { id: "tr_123", object: "transfer" } };
      if (url.endsWith("/v1/accounts")) return { body: { id: "acct_new" } };
      if (url.endsWith("/v1/account_links")) return { body: { url: "https://connect.stripe.com/setup/x" } };
      return { status: 404, body: { error: { message: "no such route" } } };
    });
    const stripe = new StripeConnectProvider({ secretKey: "sk_test_abc" }, { fetchImpl });
    expect(await stripe.verifyCredentials()).toEqual({ ok: true });
    const res = await stripe.send({ payoutId: "pay_1", affiliateId: "aff_1", amountMinor: 12_345, currency: "USD", destinationRef: "acct_777", idempotencyKey: "payout:pay_1", description: "Affiliate payout" });
    expect(res).toMatchObject({ status: "paid", providerRef: "tr_123" });
    const transfer = calls.find((c) => c.url.endsWith("/v1/transfers"))!;
    expect((transfer.init.headers as Record<string, string>)["idempotency-key"]).toBe("payout:pay_1");
    expect((transfer.init.headers as Record<string, string>).authorization).toBe("Bearer sk_test_abc");
    expect(String(transfer.init.body)).toContain("amount=12345");
    expect(String(transfer.init.body)).toContain("currency=usd");
    expect(String(transfer.init.body)).toContain("destination=acct_777");
    const onboarding = await stripe.createOnboardingLink({ affiliateId: "aff_1", email: "a@x.test", name: "A", returnUrl: "https://web/return", refreshUrl: "https://web/refresh" });
    expect(onboarding).toEqual({ url: "https://connect.stripe.com/setup/x", accountId: "acct_new" });

    const failing = new StripeConnectProvider({ secretKey: "sk_test_abc" }, { fetchImpl: stubFetch(() => ({ status: 402, body: { error: { message: "insufficient funds" } } })).fetchImpl });
    expect(await failing.send({ payoutId: "p", affiliateId: "a", amountMinor: 1, currency: "USD", destinationRef: "acct", idempotencyKey: "k", description: "d" })).toEqual({ status: "failed", error: "insufficient funds" });
    expect((await failing.verifyCredentials()).ok).toBe(false);
  });

  it("PayPal Payouts: authenticates, sends an asynchronous batch, and polls it to completion", async () => {
    let batchStatus = "PENDING";
    const { fetchImpl, calls } = stubFetch((url, init) => {
      if (url.endsWith("/v1/oauth2/token")) return { body: { access_token: "tok", expires_in: 3600 } };
      if (url.endsWith("/v1/payments/payouts") && init.method === "POST") return { status: 201, body: { batch_header: { payout_batch_id: "BATCH1", batch_status: "PENDING" } } };
      if (url.includes("/v1/payments/payouts/BATCH1")) return { body: { batch_header: { batch_status: batchStatus }, items: [{ transaction_status: batchStatus === "SUCCESS" ? "SUCCESS" : "PENDING" }] } };
      return { status: 404, body: { name: "NOT_FOUND" } };
    });
    const paypal = new PayPalPayoutsProvider({ clientId: "client-id-123", clientSecret: "secret-456", sandbox: true }, { fetchImpl });
    expect(await paypal.verifyCredentials()).toEqual({ ok: true });
    expect(calls[0]!.url).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    const res = await paypal.send({ payoutId: "pay_2", affiliateId: "aff_2", amountMinor: 5_000, currency: "usd", destinationRef: "sam@example.com", idempotencyKey: "payout:pay_2", description: "Thanks" });
    expect(res).toMatchObject({ status: "processing", providerRef: "BATCH1" });
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith("/v1/payments/payouts"))!.init.body));
    expect(body.sender_batch_header.sender_batch_id).toBe("payout:pay_2");
    expect(body.items[0]).toMatchObject({ recipient_type: "EMAIL", receiver: "sam@example.com", amount: { value: "50.00", currency: "USD" } });
    expect(await paypal.poll("BATCH1")).toMatchObject({ status: "processing" });
    batchStatus = "SUCCESS";
    expect(await paypal.poll("BATCH1")).toMatchObject({ status: "paid", providerRef: "BATCH1" });
    // token is reused, not fetched per call
    expect(calls.filter((c) => c.url.endsWith("/v1/oauth2/token"))).toHaveLength(1);
  });

  it("credentials round-trip through authenticated encryption", () => {
    const enc = encryptJson({ secretKey: "sk_live_secret" });
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc).not.toContain("sk_live");
    expect(decryptJson(enc)).toEqual({ secretKey: "sk_live_secret" });
    expect(() => decryptJson(enc.slice(0, -4) + "AAAA")).toThrow();
  });
});

describe("provider-driven payouts", () => {
  let db: Db;
  const clock = makeClock();
  let ws: Workspace;
  let alice: Affiliate;
  const memory = new MemoryPayoutProvider("stripe_connect");
  const paypalMem = new MemoryPayoutProvider("paypal");
  const factory: PayoutProviderFactory = (id) => (id === "paypal" ? paypalMem : memory);
  const deps = { factory };

  beforeAll(async () => {
    db = await getDb();
    ws = await createWorkspace(db, clock);
    alice = await createActiveAffiliate(db, ws, "Alice");
  });
  afterAll(closeDb);

  async function payableFor(a: Affiliate, ref: string, amountMinor: number) {
    const c = await clickFor(db, ws, a, clock);
    const res = await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: ref, offerId: ws.offer.id, amountMinor, clickToken: c.token });
    await commissions.approveCommission(db, ws.ctx, res.commission!.id);
    clock.advanceDays(31);
    await commissions.settleHoldingPeriods(db, ws.ctx, clock.now());
    return res;
  }

  it("connecting stores encrypted credentials, exposes only a hint, and validates with the provider", async () => {
    await expect(integrations.connectPayoutProvider(db, ws.ctx, "stripe_connect", { secretKey: "not-a-key" }, deps)).rejects.toThrow();
    const row = await integrations.connectPayoutProvider(db, ws.ctx, "stripe_connect", { secretKey: "sk_test_abcdef123456" }, deps);
    expect(row.hint).toBe("sk_test_…3456");
    expect(row.credentialsEnc).not.toContain("sk_test");
    const stored = await db.query.tenantIntegrations.findFirst({ where: eq(tenantIntegrations.id, row.id) });
    expect(decryptJson(stored!.credentialsEnc)).toEqual({ secretKey: "sk_test_abcdef123456" });
    const listed = await integrations.listIntegrations(db, ws.ctx);
    expect(listed).toEqual([expect.objectContaining({ provider: "stripe_connect", status: "connected", hint: "sk_test_…3456" })]);
    expect(JSON.stringify(listed)).not.toContain("sk_test_abcdef");
    expect(await integrations.automatedMethods(db, ws.ctx)).toEqual(["stripe_connect"]);
    // other tenants cannot see or use it
    const other = await createWorkspace(db, clock);
    expect(await integrations.listIntegrations(db, other.ctx)).toEqual([]);
    expect(await integrations.providerFor(db, other.ctx, "stripe_connect", deps)).toBeNull();
  });

  it("affiliate onboarding stores the connected account as the payout profile", async () => {
    const affCtx = tenantContext(ws.tenant.id, { type: "affiliate", id: alice.id, affiliateId: alice.id }, clock.now);
    const link = await integrations.startStripeOnboarding(db, affCtx, alice.id, { returnUrl: "https://web/return", refreshUrl: "https://web/refresh" }, deps);
    expect(link.url).toContain("onboard");
    const a = await affiliatesSvc.getAffiliate(db, ws.ctx, alice.id);
    expect(a.payoutMethod).toBe("stripe_connect");
    expect(a.payoutProfileRef).toBe(link.accountId);
    // second call reuses the account
    const again = await integrations.startStripeOnboarding(db, affCtx, alice.id, { returnUrl: "https://web/return", refreshUrl: "https://web/refresh" }, deps);
    expect(again.accountId).toBe(link.accountId);
    expect(memory.onboarded[1]?.existingAccountId).toBe(link.accountId);
  });

  it("queue → worker send → paid, with commissions settled and an idempotent provider call", async () => {
    await payableFor(alice, "prov-1", 100_000);
    const draft = await payoutsSvc.createPayoutBatch(db, ws.ctx, { affiliateId: alice.id });
    expect(draft.status).toBe("draft");
    const queued = await integrations.queueProviderPayout(db, ws.ctx, draft.id);
    expect(queued).toMatchObject({ status: "processing", provider: "stripe_connect", idempotencyKey: `payout:${draft.id}` });
    await expect(integrations.queueProviderPayout(db, ws.ctx, draft.id)).rejects.toMatchObject({ code: "validation" });
    const job = (await db.select().from(jobsTable).where(eq(jobsTable.type, "send_payout"))).find((j) => (j.payload as any).payoutId === draft.id);
    expect(job).toBeTruthy();

    memory.mode = "paid";
    const paid = await integrations.executeProviderPayout(db, ws.ctx, draft.id, deps);
    expect(paid).toMatchObject({ status: "paid", externalReference: memory.sent[0]!.idempotencyKey ? "tr_mem_1" : "" });
    expect(memory.sent[0]).toMatchObject({ payoutId: draft.id, amountMinor: draft.amountMinor, destinationRef: (await affiliatesSvc.getAffiliate(db, ws.ctx, alice.id)).payoutProfileRef, idempotencyKey: `payout:${draft.id}` });
    const balances = await commissions.getBalances(db, ws.ctx, alice.id);
    expect(balances.paidMinor).toBe(draft.amountMinor);
    // re-running the job is a no-op
    expect((await integrations.executeProviderPayout(db, ws.ctx, draft.id, deps)).status).toBe("paid");
    expect(memory.sent).toHaveLength(1);
  });

  it("asynchronous providers stay processing until polled; failures release nothing silently", async () => {
    await integrations.connectPayoutProvider(db, ws.ctx, "paypal", { clientId: "client-id-123", clientSecret: "secret-456", sandbox: true }, deps);
    await affiliatesSvc.setPayoutProfile(db, ws.ctx, alice.id, { method: "paypal", profileRef: "alice@example.com", masked: "a***@example.com" });
    await payableFor(alice, "prov-2", 50_000);
    const draft = await payoutsSvc.createPayoutBatch(db, ws.ctx, { affiliateId: alice.id });
    await integrations.queueProviderPayout(db, ws.ctx, draft.id);
    paypalMem.mode = "processing";
    const sent = await integrations.executeProviderPayout(db, ws.ctx, draft.id, deps);
    expect(sent).toMatchObject({ status: "processing", provider: "paypal", providerRef: "PB_mem_1" });
    paypalMem.pollMode = "processing";
    expect(await integrations.pollProviderPayouts(db, ws.ctx, deps)).toBe(0);
    paypalMem.pollMode = "paid";
    expect(await integrations.pollProviderPayouts(db, ws.ctx, deps)).toBe(1);
    expect((await payoutsSvc.getPayout(db, ws.ctx, draft.id))).toMatchObject({ status: "paid", externalReference: "PB_mem_1" });

    // a failed send marks the payout failed with the provider's reason
    await payableFor(alice, "prov-3", 20_000);
    const d2 = await payoutsSvc.createPayoutBatch(db, ws.ctx, { affiliateId: alice.id });
    await integrations.queueProviderPayout(db, ws.ctx, d2.id);
    paypalMem.mode = "failed";
    const failed = await integrations.executeProviderPayout(db, ws.ctx, d2.id, deps);
    expect(failed).toMatchObject({ status: "failed", failureReason: "declined by test provider" });
    // disconnect is refused while a payout is processing, allowed afterwards
    await payableFor(alice, "prov-4", 1_000);
    const d3 = await payoutsSvc.createPayoutBatch(db, ws.ctx, { affiliateId: alice.id });
    await integrations.queueProviderPayout(db, ws.ctx, d3.id);
    await expect(integrations.disconnectPayoutProvider(db, ws.ctx, "paypal")).rejects.toMatchObject({ code: "conflict" });
    // a processing payout cannot be cancelled by hand (PAY-05 state machine); once the provider settles it, disconnect is allowed
    await expect(payoutsSvc.cancelPayout(db, ws.ctx, d3.id, "test")).rejects.toMatchObject({ code: "invalid_transition" });
    await integrations.executeProviderPayout(db, ws.ctx, d3.id, deps);
    expect((await payoutsSvc.getPayout(db, ws.ctx, d3.id)).status).toBe("failed");
    await integrations.disconnectPayoutProvider(db, ws.ctx, "paypal");
    expect(await integrations.automatedMethods(db, ws.ctx)).toEqual(["stripe_connect"]);
  });
});
