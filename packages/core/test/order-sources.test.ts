import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { closeDb, createActiveAffiliate, createWorkspace, clickFor, getDb, makeClock, type Workspace } from "./helpers";
import * as orderSources from "../src/services/orderSources";
import * as conversions from "../src/services/conversions";
import * as tracking from "../src/services/tracking";
import * as integrations from "../src/services/integrations";
import type { Affiliate } from "../src/db/schema";

/**
 * Order sources: Shopify and Stripe report orders through their own webhooks. Signatures,
 * how each event maps onto the shared conversion intake (attribution by cart attribute, landing
 * URL, discount or promotion code, client_reference_id or metadata), refunds and cancellations,
 * the affiliate-only rule, and the delivery log the merchant's page reads.
 */
let db: Db;
const clock = makeClock("2026-09-18T10:00:00Z");
let ws: Workspace;
let alice: Affiliate;
let shopifyOrders = 5000;

beforeAll(async () => {
  db = await getDb();
  ws = await createWorkspace(db, clock, { programOverrides: { refundPolicy: "partial" } });
  alice = await createActiveAffiliate(db, ws, "Alice");
  await tracking.createCouponCode(db, ws.ctx, { affiliateId: alice.id, programId: ws.program.id, code: "ALICE20" });
});
afterAll(closeDb);

/** A Shopify order payload with the fields the adapter reads; everything else Shopify sends is noise to it. */
function shopifyOrder(over: Record<string, unknown> = {}) {
  const id = ++shopifyOrders;
  return {
    id,
    name: `#${id - 4000}`,
    order_number: id - 4000,
    email: "buyer@example.com",
    currency: "USD",
    total_price: "129.00",
    subtotal_price: "119.00",
    financial_status: "paid",
    processed_at: clock.now().toISOString(),
    customer: { id: 77, email: "buyer@example.com" },
    discount_codes: [],
    note_attributes: [],
    landing_site: "/",
    ...over,
  };
}

const stripeEvent = (type: string, object: Record<string, unknown>, over: Record<string, unknown> = {}): orderSources.StripeEvent => ({ id: `evt_${type}_${Math.random().toString(36).slice(2, 10)}`, type, created: Math.floor(clock.now().getTime() / 1000), livemode: true, data: { object }, ...over });

describe("order sources", () => {
  it("connects with a signing secret, exposes only a hint, and disconnects", async () => {
    const row = await orderSources.connectOrderSource(db, ws.ctx, "shopify", { webhookSecret: "shpss_0123456789abcdef0123", shopDomain: "Acme.myshopify.com" });
    expect(row.hint).toBe("acme.myshopify.com · secret …0123");
    expect(row.lastVerifiedAt).toBeNull();
    const listed = await integrations.listIntegrations(db, ws.ctx);
    expect(listed.find((i) => i.provider === "shopify")).toMatchObject({ status: "connected", hint: "acme.myshopify.com · secret …0123" });
    expect(JSON.stringify(listed)).not.toContain("shpss_0123456789abcdef0123");
    expect(await orderSources.orderSourceCredentials(db, ws.ctx, "shopify")).toEqual({ webhookSecret: "shpss_0123456789abcdef0123", shopDomain: "acme.myshopify.com" });

    await expect(orderSources.connectOrderSource(db, ws.ctx, "stripe", { webhookSecret: "not-a-secret" })).rejects.toMatchObject({ name: "ZodError" });
    const stripe = await orderSources.connectOrderSource(db, ws.ctx, "stripe", { webhookSecret: "whsec_abcdefghijklmnop", secretKey: "" });
    expect(stripe.hint).toBe("whsec_…mnop");
    expect(await orderSources.orderSourceCredentials(db, ws.ctx, "stripe")).toEqual({ webhookSecret: "whsec_abcdefghijklmnop" });

    await orderSources.disconnectOrderSource(db, ws.ctx, "stripe");
    expect(await orderSources.orderSourceCredentials(db, ws.ctx, "stripe")).toBeNull();
    await expect(orderSources.disconnectOrderSource(db, ws.ctx, "stripe")).rejects.toMatchObject({ code: "not_found" });
    await orderSources.disconnectOrderSource(db, ws.ctx, "shopify");
  });

  it("verifies Shopify signatures over the raw body", () => {
    const body = JSON.stringify({ id: 1, total_price: "10.00" });
    const sig = orderSources.signShopifyPayload("secret-secret-secret", body);
    expect(orderSources.verifyShopifySignature("secret-secret-secret", body, sig)).toBe(true);
    expect(orderSources.verifyShopifySignature("secret-secret-secret", body + " ", sig)).toBe(false);
    expect(orderSources.verifyShopifySignature("other-secret-other-1", body, sig)).toBe(false);
    expect(orderSources.verifyShopifySignature("secret-secret-secret", body, undefined)).toBe(false);
    expect(orderSources.verifyShopifySignature("secret-secret-secret", body, "")).toBe(false);
  });

  it("verifies Stripe signatures, refusing old timestamps, wrong secrets and tampered bodies", () => {
    const body = JSON.stringify({ id: "evt_1", type: "charge.refunded" });
    const at = clock.now();
    const header = orderSources.signStripePayload("whsec_test", body, at);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(orderSources.verifyStripeSignature("whsec_test", body, header, at)).toBe(true);
    expect(orderSources.verifyStripeSignature("whsec_test", body, header, new Date(at.getTime() + 299_000))).toBe(true);
    expect(orderSources.verifyStripeSignature("whsec_test", body, header, new Date(at.getTime() + 301_000))).toBe(false);
    expect(orderSources.verifyStripeSignature("whsec_other", body, header, at)).toBe(false);
    expect(orderSources.verifyStripeSignature("whsec_test", body.replace("evt_1", "evt_2"), header, at)).toBe(false);
    // a rolled secret: Stripe sends both signatures for a while
    expect(orderSources.verifyStripeSignature("whsec_test", body, `${orderSources.signStripePayload("whsec_old", body, at)},v1=${header.split("v1=")[1]}`, at)).toBe(true);
    expect(orderSources.verifyStripeSignature("whsec_test", body, "t=abc,v1=zzz", at)).toBe(false);
    expect(orderSources.verifyStripeSignature("whsec_test", body, undefined, at)).toBe(false);
  });

  it("records a paid Shopify order attributed by the cart attribute the snippet set, with the net amount and a hashed email", async () => {
    const { token } = await clickFor(db, ws, alice, clock);
    const order = shopifyOrder({ note_attributes: [{ name: "referly_ref", value: token }, { name: "referly_vid", value: "vShopVisitor00000001" }] });
    const out = await orderSources.handleShopifyEvent(db, ws.ctx, "orders/paid", order, { shopDomain: "acme.myshopify.com" });
    expect(out).toMatchObject({ action: "recorded", summary: `orders/paid ${order.name}` });
    const conversion = await conversions.getConversion(db, ws.ctx, out.conversionId!);
    expect(conversion).toMatchObject({ source: "shopify", externalOrderId: order.name, amountMinor: 12_900, netAmountMinor: 11_900, currency: "USD", affiliateId: alice.id, attributionSource: "link", customerRef: "77" });
    expect(conversion.customerEmailHash).toHaveLength(64);
    expect(conversion.metadata).toMatchObject({ shopify: { id: String(order.id), name: order.name, shopDomain: "acme.myshopify.com", test: false } });
    const commission = await conversions.currentCommission(db, conversion.id);
    expect(commission).toMatchObject({ affiliateId: alice.id, amountMinor: 2_580, status: "pending" }); // 20% of the gross basis

    // the same webhook again, or Shopify's own retry, is the same sale
    expect(await orderSources.handleShopifyEvent(db, ws.ctx, "orders/paid", order)).toMatchObject({ action: "duplicate", conversionId: conversion.id });
  });

  it("attributes by the landing URL Shopify recorded, or by an affiliate's discount code; a store's own code is not evidence", async () => {
    const { token } = await clickFor(db, ws, alice, clock);
    const landed = await orderSources.handleShopifyEvent(db, ws.ctx, "orders/paid", shopifyOrder({ landing_site: `/products/course?utm_source=blog&ref=${token}&x=1` }));
    expect(landed.action).toBe("recorded");
    expect((await conversions.getConversion(db, ws.ctx, landed.conversionId!)).attributionSource).toBe("link");

    const coupon = await orderSources.handleShopifyEvent(db, ws.ctx, "orders/paid", shopifyOrder({ discount_codes: [{ code: "SUMMER", amount: "5.00" }, { code: "alice20", amount: "20.00" }] }));
    expect(coupon.action).toBe("recorded");
    expect((await conversions.getConversion(db, ws.ctx, coupon.conversionId!)).attributionSource).toBe("coupon");

    const storeCode = await orderSources.handleShopifyEvent(db, ws.ctx, "orders/paid", shopifyOrder({ discount_codes: [{ code: "SUMMER", amount: "5.00" }] }));
    expect(storeCode).toMatchObject({ action: "skipped", conversionId: null });
    expect(storeCode.reason).toContain("no affiliate");
  });

  it("skips an order nobody sent and keeps nothing; other topics and unpaid orders are ignored with a reason", async () => {
    const nobody = shopifyOrder();
    expect(await orderSources.handleShopifyEvent(db, ws.ctx, "orders/paid", nobody)).toMatchObject({ action: "skipped", conversionId: null });
    expect(await conversions.findByExternalId(db, ws.ctx, "shopify", nobody.name)).toBeNull();

    const { token } = await clickFor(db, ws, alice, clock);
    const unpaid = shopifyOrder({ financial_status: "pending", note_attributes: [{ name: "referly_ref", value: token }] });
    expect(await orderSources.handleShopifyEvent(db, ws.ctx, "orders/create", unpaid)).toMatchObject({ action: "ignored", reason: "the order is pending; it is recorded once paid" });
    expect(await orderSources.handleShopifyEvent(db, ws.ctx, "orders/updated", { ...unpaid, financial_status: "paid" })).toMatchObject({ action: "recorded" });
    expect(await orderSources.handleShopifyEvent(db, ws.ctx, "products/update", { id: 1 })).toMatchObject({ action: "ignored" });
    expect(await orderSources.handleShopifyEvent(db, ws.ctx, "orders/paid", shopifyOrder({ id: undefined }))).toMatchObject({ action: "ignored", reason: "the payload carries no order id" });
  });

  it("applies Shopify refunds to the sale they belong to, reducing the commission, and ignores restock-only refunds", async () => {
    const { token } = await clickFor(db, ws, alice, clock);
    const order = shopifyOrder({ total_price: "100.00", subtotal_price: "100.00", note_attributes: [{ name: "referly_ref", value: token }] });
    const sale = await orderSources.handleShopifyEvent(db, ws.ctx, "orders/paid", order);
    expect(sale.action).toBe("recorded");

    const partial = await orderSources.handleShopifyEvent(db, ws.ctx, "refunds/create", { id: 9001, order_id: order.id, note: "damaged sleeve", transactions: [{ kind: "refund", status: "success", amount: "25.00", currency: "USD" }] });
    expect(partial).toMatchObject({ action: "refunded", conversionId: sale.conversionId });
    let conversion = await conversions.getConversion(db, ws.ctx, sale.conversionId!);
    expect(conversion).toMatchObject({ status: "refunded", refundedAmountMinor: 2_500 });
    let commission = await conversions.currentCommission(db, conversion.id);
    expect(commission!.amountMinor).toBe(1_500); // partial policy: 20% of the 75.00 that stayed

    expect(await orderSources.handleShopifyEvent(db, ws.ctx, "refunds/create", { id: 9002, order_id: order.id, transactions: [], refund_line_items: [{ quantity: 1 }] })).toMatchObject({ action: "ignored", reason: "no money went back to the customer (restock only)" });

    const rest = await orderSources.handleShopifyEvent(db, ws.ctx, "refunds/create", { id: 9003, order_id: order.id, transactions: [{ kind: "refund", status: "success", amount: "75.00", currency: "USD" }, { kind: "sale", status: "success", amount: "1.00" }] });
    expect(rest.action).toBe("refunded");
    conversion = await conversions.getConversion(db, ws.ctx, sale.conversionId!);
    expect(conversion.refundedAmountMinor).toBe(10_000);
    commission = await conversions.currentCommission(db, conversion.id);
    expect(commission!.status).toBe("reversed");

    expect(await orderSources.handleShopifyEvent(db, ws.ctx, "refunds/create", { id: 9004, order_id: order.id, transactions: [{ kind: "refund", status: "success", amount: "5.00" }] })).toMatchObject({ action: "ignored", reason: "this sale was already fully refunded" });
    expect(await orderSources.handleShopifyEvent(db, ws.ctx, "refunds/create", { id: 9005, order_id: 1, transactions: [{ kind: "refund", status: "success", amount: "5.00" }] })).toMatchObject({ action: "ignored" });
  });

  it("cancels a Shopify order and voids its commission; a second cancellation is ignored", async () => {
    const { token } = await clickFor(db, ws, alice, clock);
    const order = shopifyOrder({ note_attributes: [{ name: "referly_ref", value: token }] });
    const sale = await orderSources.handleShopifyEvent(db, ws.ctx, "orders/paid", order);
    const cancelled = await orderSources.handleShopifyEvent(db, ws.ctx, "orders/cancelled", { ...order, cancel_reason: "customer", financial_status: "voided" });
    expect(cancelled).toMatchObject({ action: "cancelled", conversionId: sale.conversionId });
    expect((await conversions.getConversion(db, ws.ctx, sale.conversionId!)).status).toBe("cancelled");
    expect((await conversions.currentCommission(db, sale.conversionId!))!.status).toBe("void");
    expect(await orderSources.handleShopifyEvent(db, ws.ctx, "orders/cancelled", order)).toMatchObject({ action: "ignored", reason: "already cancelled" });
    expect(await orderSources.handleShopifyEvent(db, ws.ctx, "orders/cancelled", shopifyOrder())).toMatchObject({ action: "ignored" });
  });

  it("an order the status page already reported is the same sale: the webhook is a duplicate that adds the Shopify id, so a later refund still lands", async () => {
    const { token } = await clickFor(db, ws, alice, clock);
    const order = shopifyOrder();
    const fromPage = await conversions.recordConversion(db, ws.ctx, { source: "pixel", externalOrderId: order.name, amountMinor: 12_900, currency: "USD", clickToken: token });
    expect(fromPage.duplicate).toBe(false);
    const hook = await orderSources.handleShopifyEvent(db, ws.ctx, "orders/paid", order);
    expect(hook).toMatchObject({ action: "duplicate", conversionId: fromPage.conversion.id });
    expect((await conversions.getConversion(db, ws.ctx, fromPage.conversion.id)).metadata).toMatchObject({ shopify: { id: String(order.id) } });
    const refund = await orderSources.handleShopifyEvent(db, ws.ctx, "refunds/create", { id: 9100, order_id: order.id, transactions: [{ kind: "refund", status: "success", amount: "29.00", currency: "USD" }] });
    expect(refund).toMatchObject({ action: "refunded", conversionId: fromPage.conversion.id });
  });

  it("records a paid Stripe Checkout Session by client_reference_id, and applies refunds by payment intent as they grow", async () => {
    const creds = { webhookSecret: "whsec_x" };
    const { token } = await clickFor(db, ws, alice, clock);
    const session = { id: "cs_test_1", object: "checkout.session", mode: "payment", payment_status: "paid", payment_intent: "pi_1", currency: "usd", amount_total: 12_900, amount_subtotal: 13_900, total_details: { amount_discount: 1_000, amount_shipping: 0, amount_tax: 0 }, customer: "cus_1", customer_details: { email: "buyer@example.com" }, client_reference_id: token, metadata: {} };
    const out = await orderSources.handleStripeEvent(db, ws.ctx, stripeEvent("checkout.session.completed", session), creds);
    expect(out).toMatchObject({ action: "recorded", summary: "checkout.session.completed cs_test_1" });
    const conversion = await conversions.getConversion(db, ws.ctx, out.conversionId!);
    expect(conversion).toMatchObject({ source: "stripe", externalOrderId: "pi_1", amountMinor: 12_900, netAmountMinor: 12_900, currency: "USD", affiliateId: alice.id, attributionSource: "link", customerRef: "cus_1" });
    expect(conversion.metadata).toMatchObject({ stripe: { sessionId: "cs_test_1", paymentIntent: "pi_1", livemode: true } });
    expect(await orderSources.handleStripeEvent(db, ws.ctx, stripeEvent("checkout.session.completed", session), creds)).toMatchObject({ action: "duplicate", conversionId: conversion.id });

    const charge = (refunded: number) => ({ id: "ch_1", object: "charge", payment_intent: "pi_1", amount: 12_900, amount_refunded: refunded, currency: "usd", refunds: { data: [{ id: "re_1", amount: refunded, reason: "requested_by_customer" }] } });
    expect(await orderSources.handleStripeEvent(db, ws.ctx, stripeEvent("charge.refunded", charge(2_900)), creds)).toMatchObject({ action: "refunded", conversionId: conversion.id });
    expect((await conversions.getConversion(db, ws.ctx, conversion.id)).refundedAmountMinor).toBe(2_900);
    // Stripe resends the charge with the running total; nothing new means nothing done
    expect(await orderSources.handleStripeEvent(db, ws.ctx, stripeEvent("charge.refunded", charge(2_900)), creds)).toMatchObject({ action: "ignored", reason: "this refund is already reflected" });
    expect(await orderSources.handleStripeEvent(db, ws.ctx, stripeEvent("charge.refunded", charge(12_900)), creds)).toMatchObject({ action: "refunded" });
    expect((await conversions.getConversion(db, ws.ctx, conversion.id)).refundedAmountMinor).toBe(12_900);
    expect((await conversions.currentCommission(db, conversion.id))!.status).toBe("reversed");
    expect(await orderSources.handleStripeEvent(db, ws.ctx, stripeEvent("charge.refunded", { ...charge(500), payment_intent: "pi_unknown" }), creds)).toMatchObject({ action: "ignored" });
  });

  it("waits for asynchronous payments, ignores setup sessions and unknown events, and skips a payment nobody sent", async () => {
    const creds = { webhookSecret: "whsec_x" };
    const { token } = await clickFor(db, ws, alice, clock);
    const base = { id: "cs_test_async", mode: "payment", payment_intent: "pi_async", currency: "usd", amount_total: 5_000, amount_subtotal: 5_000, client_reference_id: token, metadata: {} };
    expect(await orderSources.handleStripeEvent(db, ws.ctx, stripeEvent("checkout.session.completed", { ...base, payment_status: "unpaid" }), creds)).toMatchObject({ action: "ignored", reason: "payment is unpaid; the sale is recorded once it succeeds" });
    expect(await orderSources.handleStripeEvent(db, ws.ctx, stripeEvent("checkout.session.async_payment_succeeded", { ...base, payment_status: "paid" }), creds)).toMatchObject({ action: "recorded" });
    expect(await orderSources.handleStripeEvent(db, ws.ctx, stripeEvent("checkout.session.completed", { ...base, id: "cs_setup", mode: "setup", payment_status: "no_payment_required" }), creds)).toMatchObject({ action: "ignored", reason: "a setup session takes no payment" });
    expect(await orderSources.handleStripeEvent(db, ws.ctx, stripeEvent("customer.created", { id: "cus_9" }), creds)).toMatchObject({ action: "ignored" });
    expect(await orderSources.handleStripeEvent(db, ws.ctx, stripeEvent("checkout.session.completed", { ...base, id: "cs_nobody", payment_intent: "pi_nobody", payment_status: "paid", client_reference_id: "ORDER-77" }), creds)).toMatchObject({ action: "skipped", conversionId: null });
    expect(await conversions.findByExternalId(db, ws.ctx, "stripe", "pi_nobody")).toBeNull();
  });

  it("looks up a promotion code with the restricted key, so an affiliate's code typed at checkout attributes the sale", async () => {
    const calls: string[] = [];
    const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${String(url)} ${(init?.headers as Record<string, string>)?.authorization ?? ""}`);
      if (String(url).endsWith("/v1/promotion_codes/promo_alice")) return new Response(JSON.stringify({ id: "promo_alice", code: "ALICE20" }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const session = { id: "cs_promo", mode: "payment", payment_status: "paid", payment_intent: "pi_promo", currency: "usd", amount_total: 8_000, amount_subtotal: 10_000, total_details: { amount_discount: 2_000 }, discounts: [{ coupon: "co_x", promotion_code: "promo_alice" }], metadata: {} };
    // without a key the code cannot be read, so the order is nobody's
    expect(await orderSources.handleStripeEvent(db, ws.ctx, stripeEvent("checkout.session.completed", session), { webhookSecret: "whsec_x" }, { fetch: fetchStub })).toMatchObject({ action: "skipped" });
    expect(calls).toEqual([]);
    const out = await orderSources.handleStripeEvent(db, ws.ctx, stripeEvent("checkout.session.completed", session), { webhookSecret: "whsec_x", secretKey: "rk_test_abc" }, { fetch: fetchStub });
    expect(out.action).toBe("recorded");
    expect(calls).toEqual(["https://api.stripe.com/v1/promotion_codes/promo_alice Bearer rk_test_abc"]);
    const conversion = await conversions.getConversion(db, ws.ctx, out.conversionId!);
    expect(conversion).toMatchObject({ affiliateId: alice.id, attributionSource: "coupon", netAmountMinor: 8_000 });
    // an expanded object needs no lookup at all
    const expanded = { ...session, id: "cs_promo2", payment_intent: "pi_promo2", discounts: [{ coupon: { id: "co_x", name: "Alice's launch" }, promotion_code: { id: "promo_alice", code: "ALICE20" } }] };
    expect(await orderSources.handleStripeEvent(db, ws.ctx, stripeEvent("checkout.session.completed", expanded), { webhookSecret: "whsec_x" }, { fetch: fetchStub })).toMatchObject({ action: "recorded" });
    expect(calls).toHaveLength(1);
  });

  it("records a PaymentIntent whose metadata carries the click token, with the visitor id as a second witness", async () => {
    const { token } = await clickFor(db, ws, alice, clock);
    const intent = { id: "pi_custom", object: "payment_intent", amount: 4_200, amount_received: 4_200, currency: "eur", receipt_email: "buyer@example.com", customer: null, metadata: { referly_ref: token, referly_vid: "vCustomVisitor000001" } };
    const out = await orderSources.handleStripeEvent(db, ws.ctx, stripeEvent("payment_intent.succeeded", intent), { webhookSecret: "whsec_x" });
    expect(out).toMatchObject({ action: "recorded", summary: "payment_intent.succeeded pi_custom" });
    expect(await conversions.getConversion(db, ws.ctx, out.conversionId!)).toMatchObject({ externalOrderId: "pi_custom", amountMinor: 4_200, currency: "EUR", affiliateId: alice.id });
    // the Checkout Session that created it arrives too: same payment, one sale
    const session = { id: "cs_custom", mode: "payment", payment_status: "paid", payment_intent: "pi_custom", currency: "eur", amount_total: 4_200, metadata: {} };
    expect(await orderSources.handleStripeEvent(db, ws.ctx, stripeEvent("checkout.session.completed", session), { webhookSecret: "whsec_x" })).toMatchObject({ action: "duplicate", conversionId: out.conversionId });
  });

  it("logs each event once by the sender's id and shows the outcome on the merchant's view", async () => {
    await orderSources.connectOrderSource(db, ws.ctx, "stripe", { webhookSecret: "whsec_view" });
    const first = await orderSources.beginOrderSourceDelivery(db, ws.ctx, "stripe", "evt_once", "charge.refunded");
    expect(first).toMatch(/^whd_/);
    expect(await orderSources.beginOrderSourceDelivery(db, ws.ctx, "stripe", "evt_once", "charge.refunded")).toBeNull();
    await orderSources.finishOrderSourceDelivery(db, ws.ctx, first!, { action: "ignored", conversionId: null, summary: "charge.refunded ch_9", reason: "this payment was never recorded" });
    clock.set(new Date(clock.now().getTime() + 1_000));
    const second = await orderSources.beginOrderSourceDelivery(db, ws.ctx, "stripe", "evt_two", "checkout.session.completed");
    await orderSources.finishOrderSourceDelivery(db, ws.ctx, second!, { action: "recorded", conversionId: "cnv_x", summary: "checkout.session.completed cs_9" });
    await orderSources.touchOrderSource(db, ws.ctx, "stripe");

    const view = await orderSources.orderSourcesView(db, ws.ctx);
    expect(view.map((v) => v.provider)).toEqual(["shopify", "stripe"]);
    const stripe = view.find((v) => v.provider === "stripe")!;
    expect(stripe).toMatchObject({ connected: true, hint: "whsec_…view" });
    expect(stripe.lastEventAt?.getTime()).toBe(clock.now().getTime());
    expect(stripe.recent.map((r) => [r.summary, r.status, r.action, r.conversionId, r.reason])).toEqual([
      ["checkout.session.completed cs_9", "processed", "recorded", "cnv_x", null],
      ["charge.refunded ch_9", "ignored", "ignored", null, "this payment was never recorded"],
    ]);
    expect(view.find((v) => v.provider === "shopify")).toMatchObject({ connected: false, hint: null, recent: [] });
    expect(orderSources.orderSourceHookUrl("https://api.example.com/", "stripe", ws.tenant.id)).toBe(`https://api.example.com/hooks/stripe/${ws.tenant.id}`);
  });
});
