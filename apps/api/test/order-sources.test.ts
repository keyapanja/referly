import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDb, messaging, orderSources, type DbHandle } from "@referly/core";
import { createApp, type App } from "../src/app";
import { resetRateLimits } from "../src/lib/ratelimit";
import { LocalStorage } from "../src/storage";
import { createLogger } from "../src/lib/log";

/**
 * Shopify and Stripe over HTTP: connecting from the tracking page, the hook addresses, signed
 * events landing as sales and refunds, what a bad signature, a wrong store, an unknown workspace
 * or a replayed event gets, and the recent-events view the merchant reads.
 */
let handle: DbHandle;
let app: App;
let clock = new Date("2026-09-18T10:00:00Z");
const now = () => new Date(clock);
const email = new messaging.MemoryEmailProvider();
const quiet = createLogger({ level: "error", write: () => {} });
const BASE = "http://api.test";
const stripeCalls: string[] = [];

beforeAll(async () => {
  handle = await createTestDb();
  const storage = new LocalStorage(await mkdtemp(path.join(tmpdir(), "referly-order-sources-")), BASE);
  const stripeFetch = (async (url: string | URL | Request) => {
    stripeCalls.push(String(url));
    if (String(url).endsWith("/v1/promotion_codes/promo_pat")) return new Response(JSON.stringify({ id: "promo_pat", code: "PAT10" }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  app = createApp({ db: handle.db, email, storage, log: quiet, orderSources: { fetch: stripeFetch }, config: { baseUrl: BASE, webUrl: "http://web.test", cookieSecure: false, now } });
  resetRateLimits();
});
afterAll(() => handle.close());

async function call<T = any>(p: string, init: RequestInit & { token?: string; json?: unknown; raw?: string } = {}): Promise<{ status: number; body: T }> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.json !== undefined || init.raw !== undefined) headers.set("content-type", "application/json");
  const res = await app.request(BASE + p, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : (init.raw ?? init.body), redirect: "manual" });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body };
}

const SHOPIFY_SECRET = "shpss_secret_for_the_acme_store_2026";
const STRIPE_SECRET = "whsec_acmeacmeacmeacme";

/** The clock is frozen; each webhook arrives one second after the previous one, as in life. */
const tick = () => void (clock = new Date(clock.getTime() + 1_000));

/** Exactly what Shopify sends: raw JSON, its HMAC over those bytes, topic and shop in headers. */
function shopifyPost(tenantId: string, topic: string, payload: unknown, over: { secret?: string; shop?: string; webhookId?: string } = {}) {
  const raw = JSON.stringify(payload);
  tick();
  return call(`/hooks/shopify/${tenantId}`, {
    method: "POST",
    raw,
    headers: {
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": over.shop ?? "acme.myshopify.com",
      "x-shopify-hmac-sha256": orderSources.signShopifyPayload(over.secret ?? SHOPIFY_SECRET, raw),
      "x-shopify-webhook-id": over.webhookId ?? `wh_${Math.random().toString(36).slice(2, 12)}`,
    },
  });
}

function stripePost(tenantId: string, event: unknown, over: { secret?: string; at?: Date } = {}) {
  const raw = JSON.stringify(event);
  tick();
  return call(`/hooks/stripe/${tenantId}`, { method: "POST", raw, headers: { "stripe-signature": orderSources.signStripePayload(over.secret ?? STRIPE_SECRET, raw, over.at ?? now()) } });
}

describe("order sources over HTTP", () => {
  let ownerToken: string;
  let tenantId: string;
  let affiliateId: string;
  let clickToken: string;
  let programId: string;
  let offerId: string;

  it("a merchant connects Shopify and Stripe from the tracking page; the view shows hook addresses, hints and no secrets", async () => {
    const signup = await call("/v1/auth/signup", { method: "POST", json: { name: "Acme Store", slug: "acme-store", currency: "USD", owner: { name: "Ann", email: "ann@acme.test", password: "supersecret1" } } });
    ownerToken = signup.body.token;
    tenantId = signup.body.tenant.id;
    const offer = await call("/v1/offers", { method: "POST", token: ownerToken, json: { name: "Course", priceMinor: 12_900, salesUrl: "https://acme.myshopify.com/products/course" } });
    offerId = offer.body.offer.id;
    await call(`/v1/offers/${offerId}/status`, { method: "POST", token: ownerToken, json: { status: "active" } });
    const program = await call("/v1/programs", { method: "POST", token: ownerToken, json: { name: "Partners", commissionModel: "percentage", commissionPercent: 10, holdingDays: 0, attributionWindowDays: 30, refundPolicy: "partial", offerIds: [offerId], approvalMode: "auto", termsText: "Be nice." } });
    programId = program.body.program.id;
    await call(`/v1/programs/${programId}/status`, { method: "POST", token: ownerToken, json: { status: "active" } });
    const invite = await call("/v1/affiliates/invites", { method: "POST", token: ownerToken, json: { programId, email: "pat@partner.io", name: "Pat" } });
    const accept = await call(`/invite/${invite.body.invite.token}/accept`, { method: "POST", json: { name: "Pat Partner", password: "partnerpass1", acceptTerms: true } });
    affiliateId = accept.body.affiliate.id;
    const link = await call("/portal/links", { method: "POST", token: accept.body.token, json: { programId, offerId } });
    const redirect = await app.request(`${BASE}/r/${link.body.link.token}`, { redirect: "manual" });
    clickToken = new URL(redirect.headers.get("location")!).searchParams.get("ref")!;
    expect((await call(`/v1/affiliates/${affiliateId}/coupons`, { method: "POST", token: ownerToken, json: { programId, code: "PAT10" } })).status).toBe(201);

    // nothing is connected yet: the hooks answer 404 like an unknown workspace would
    expect((await shopifyPost(tenantId, "orders/paid", { id: 1 })).status).toBe(404);
    expect((await stripePost(tenantId, { id: "evt_0", type: "charge.refunded", data: { object: {} } })).status).toBe(404);

    const before = await call("/v1/tenant/integrations/order-sources", { token: ownerToken });
    expect(before.status).toBe(200);
    expect(before.body.sources.map((s: any) => [s.provider, s.connected, s.hookUrl])).toEqual([
      ["shopify", false, `${BASE}/hooks/shopify/${tenantId}`],
      ["stripe", false, `${BASE}/hooks/stripe/${tenantId}`],
    ]);

    const shopify = await call("/v1/tenant/integrations/shopify", { method: "POST", token: ownerToken, json: { credentials: { webhookSecret: SHOPIFY_SECRET, shopDomain: "acme.myshopify.com" } } });
    expect(shopify.status).toBe(201);
    expect(shopify.body.integration).toMatchObject({ provider: "shopify", status: "connected", hint: "acme.myshopify.com · secret …2026" });
    const stripe = await call("/v1/tenant/integrations/stripe", { method: "POST", token: ownerToken, json: { credentials: { webhookSecret: STRIPE_SECRET, secretKey: "rk_test_readonly1234" } } });
    expect(stripe.status).toBe(201);
    expect(stripe.body.integration.hint).toBe("whsec_…acme · promotion codes looked up");
    expect((await call("/v1/tenant/integrations/stripe", { method: "POST", token: ownerToken, json: { credentials: { webhookSecret: "sk_live_notasecret" } } })).status).toBe(400);

    const after = await call("/v1/tenant/integrations/order-sources", { token: ownerToken });
    expect(after.body.sources.map((s: any) => [s.provider, s.connected, s.lastEventAt, s.recent])).toEqual([
      ["shopify", true, null, []],
      ["stripe", true, null, []],
    ]);
    expect(JSON.stringify(after.body)).not.toContain(SHOPIFY_SECRET);
    expect(JSON.stringify(after.body)).not.toContain("rk_test_readonly1234");
    // the settings page's list carries them too, hint only
    const all = await call("/v1/tenant/integrations", { token: ownerToken });
    expect(all.body.integrations.map((i: any) => i.provider).sort()).toEqual(["shopify", "stripe"]);
  });

  it("a signed Shopify order lands as a sale with a commission; a bad signature, another store or an unknown workspace gets nothing", async () => {
    const order = { id: 7001, name: "#1001", order_number: 1001, email: "buyer@example.com", currency: "USD", total_price: "129.00", subtotal_price: "119.00", financial_status: "paid", processed_at: now().toISOString(), note_attributes: [{ name: "referly_ref", value: clickToken }], discount_codes: [], customer: { id: 5 } };
    const bad = await shopifyPost(tenantId, "orders/paid", order, { secret: "shpss_wrong_secret_wrong_secret" });
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toContain("signature");
    const otherStore = await shopifyPost(tenantId, "orders/paid", order, { shop: "someone-else.myshopify.com" });
    expect(otherStore.status).toBe(401);
    expect(otherStore.body.error.message).toContain("acme.myshopify.com");
    expect((await shopifyPost("ten_000000000000000000000", "orders/paid", order)).status).toBe(404);
    expect((await call(`/hooks/shopify/${tenantId}`, { method: "POST", raw: "not json", headers: { "x-shopify-hmac-sha256": orderSources.signShopifyPayload(SHOPIFY_SECRET, "not json"), "x-shopify-shop-domain": "acme.myshopify.com", "x-shopify-topic": "orders/paid" } })).status).toBe(400);

    const ok = await shopifyPost(tenantId, "orders/paid", order, { webhookId: "wh_order_1001" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, action: "recorded", summary: "orders/paid #1001" });
    const sale = await call(`/v1/conversions/${ok.body.conversionId}`, { token: ownerToken });
    expect(sale.body.conversion).toMatchObject({ source: "shopify", externalOrderId: "#1001", amountMinor: 12_900, netAmountMinor: 11_900, affiliateId, attributionSource: "link" });
    expect(sale.body.commission).toMatchObject({ amountMinor: 1_290, status: "pending" });

    // Shopify retries the same delivery: answered, not reprocessed
    const replay = await shopifyPost(tenantId, "orders/paid", order, { webhookId: "wh_order_1001" });
    expect(replay.body).toMatchObject({ ok: true, action: "duplicate" });
    // a new delivery of the same order is the same sale
    expect((await shopifyPost(tenantId, "orders/paid", order)).body).toMatchObject({ action: "duplicate", conversionId: ok.body.conversionId });

    const refund = await shopifyPost(tenantId, "refunds/create", { id: 8001, order_id: 7001, note: "one item returned", transactions: [{ kind: "refund", status: "success", amount: "29.00", currency: "USD" }] });
    expect(refund.body).toMatchObject({ action: "refunded", conversionId: ok.body.conversionId });
    const refunded = await call(`/v1/conversions/${ok.body.conversionId}`, { token: ownerToken });
    expect(refunded.body.conversion).toMatchObject({ status: "refunded", refundedAmountMinor: 2_900 });
    expect(refunded.body.commission.amountMinor).toBe(1_000); // 10% of the 100.00 that stayed

    const nobody = await shopifyPost(tenantId, "orders/paid", { ...order, id: 7002, name: "#1002", note_attributes: [], landing_site: "/" });
    expect(nobody.status).toBe(200);
    expect(nobody.body).toMatchObject({ action: "skipped", conversionId: null });
    expect((await call("/v1/conversions", { token: ownerToken })).body.conversions.map((c: any) => c.externalOrderId)).toEqual(["#1001"]);

    const view = await call("/v1/tenant/integrations/order-sources", { token: ownerToken });
    const shopify = view.body.sources.find((s: any) => s.provider === "shopify");
    expect(shopify.lastEventAt).toBe(now().toISOString());
    expect(shopify.recent.map((r: any) => [r.summary, r.action, r.status])).toEqual([
      ["orders/paid #1002", "skipped", "skipped"],
      ["refunds/create for order 7001", "refunded", "processed"],
      ["orders/paid #1001", "duplicate", "duplicate"],
      ["orders/paid #1001", "recorded", "processed"],
    ]);
    expect(shopify.recent[0].reason).toContain("no affiliate");
    expect(shopify.recent[3].conversionId).toBe(ok.body.conversionId);
  });

  it("a signed Stripe event lands as a sale, promotion codes are looked up with the restricted key, old or forged signatures are refused, and refunds follow", async () => {
    const session = { id: "cs_live_1", object: "checkout.session", mode: "payment", payment_status: "paid", payment_intent: "pi_live_1", currency: "usd", amount_total: 9_000, amount_subtotal: 10_000, total_details: { amount_discount: 1_000 }, customer_details: { email: "buyer@example.com" }, discounts: [{ coupon: "co_1", promotion_code: "promo_pat" }], metadata: {} };
    const event = { id: "evt_session_1", type: "checkout.session.completed", created: Math.floor(now().getTime() / 1000), livemode: true, data: { object: session } };
    expect((await stripePost(tenantId, event, { secret: "whsec_wrong" })).status).toBe(401);
    expect((await stripePost(tenantId, event, { at: new Date(now().getTime() - 10 * 60_000) })).status).toBe(401);
    expect((await call(`/hooks/stripe/${tenantId}`, { method: "POST", raw: JSON.stringify(event) })).status).toBe(401);
    expect((await stripePost("ten_000000000000000000000", event)).status).toBe(404);
    expect((await stripePost(tenantId, { hello: "world" })).status).toBe(400);

    const ok = await stripePost(tenantId, event);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, action: "recorded", summary: "checkout.session.completed cs_live_1" });
    expect(stripeCalls).toEqual(["https://api.stripe.com/v1/promotion_codes/promo_pat"]);
    const sale = await call(`/v1/conversions/${ok.body.conversionId}`, { token: ownerToken });
    expect(sale.body.conversion).toMatchObject({ source: "stripe", externalOrderId: "pi_live_1", amountMinor: 9_000, netAmountMinor: 9_000, affiliateId, attributionSource: "coupon" });
    expect((await stripePost(tenantId, event)).body).toMatchObject({ ok: true, action: "duplicate" });

    const refund = await stripePost(tenantId, { id: "evt_refund_1", type: "charge.refunded", created: Math.floor(now().getTime() / 1000), data: { object: { id: "ch_1", payment_intent: "pi_live_1", amount: 9_000, amount_refunded: 9_000, currency: "usd", refunds: { data: [{ id: "re_1", amount: 9_000, reason: "fraudulent" }] } } } });
    expect(refund.body).toMatchObject({ action: "refunded", conversionId: ok.body.conversionId });
    const after = await call(`/v1/conversions/${ok.body.conversionId}`, { token: ownerToken });
    expect(after.body.conversion.refundedAmountMinor).toBe(9_000);
    expect(after.body.commission.status).toBe("reversed");

    const view = await call("/v1/tenant/integrations/order-sources", { token: ownerToken });
    const stripe = view.body.sources.find((s: any) => s.provider === "stripe");
    expect(stripe.recent.map((r: any) => r.action)).toEqual(["refunded", "recorded"]);
  });

  it("disconnecting stops the hook; only owners and admins may connect", async () => {
    const member = await call("/v1/tenant/team", { method: "POST", token: ownerToken, json: { name: "Mia", email: "mia@acme.test", password: "supersecret1", role: "marketing" } });
    expect(member.status).toBe(201);
    const marketing = (await call("/v1/auth/login", { method: "POST", json: { email: "mia@acme.test", password: "supersecret1" } })).body.token;
    expect((await call("/v1/tenant/integrations/shopify", { method: "POST", token: marketing, json: { credentials: { webhookSecret: SHOPIFY_SECRET } } })).status).toBe(403);
    expect((await call("/v1/tenant/integrations/shopify", { method: "DELETE", token: marketing })).status).toBe(403);

    expect((await call("/v1/tenant/integrations/shopify", { method: "DELETE", token: ownerToken })).status).toBe(200);
    expect((await shopifyPost(tenantId, "orders/paid", { id: 1 })).status).toBe(404);
    const view = await call("/v1/tenant/integrations/order-sources", { token: ownerToken });
    expect(view.body.sources.find((s: any) => s.provider === "shopify")).toMatchObject({ connected: false, hint: null });
    // the log of what came in stays for the merchant to read
    expect(view.body.sources.find((s: any) => s.provider === "shopify").recent).toHaveLength(4);
  });
});
