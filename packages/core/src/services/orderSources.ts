import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { conversions, tenantIntegrations, webhookDeliveries, type Conversion, type TenantIntegration, type WebhookDelivery } from "../db/schema";
import { newId } from "../ids";
import { DomainError, notFound, validation } from "../errors";
import { type TenantContext, require as requirePerm } from "../context";
import { decryptJson, encryptJson } from "../crypto";
import { toMinorUnits } from "../money";
import { writeAudit } from "./audit";
import { NoAffiliateError, cancelConversion, findByExternalId, recordConversion, refundConversion, type RecordConversionInput } from "./conversions";
import { VISITOR_ID } from "./journeys";
import { findCouponByCode } from "./tracking";

/**
 * Order sources: shops and payment processors that tell Referly about paid orders and refunds
 * through their own webhooks, so a merchant on Shopify or Stripe Checkout needs no checkout code
 * at all. Each source is a per-workspace connection holding the webhook signing secret
 * (encrypted, like every other credential); the public hook verifies the signature, maps the
 * event onto the same conversion intake every other source uses, and answers the sender.
 *
 * Attribution evidence rides along on the order itself: the click token the tracking redirect
 * appends as `?ref=` (cart attributes the snippet sets, the landing URL Shopify records, Stripe's
 * `client_reference_id` or `metadata.referly_ref`), the snippet's visitor id, and any discount or
 * promotion code, which may be an affiliate's. A paid order nobody sent is not recorded, like
 * everywhere else.
 */

export const ORDER_SOURCE_IDS = ["shopify", "stripe"] as const;
export type OrderSourceId = (typeof ORDER_SOURCE_IDS)[number];

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const orderSourceCredentialsSchema = {
  shopify: z.object({
    webhookSecret: z.string().trim().min(16, "paste the signing secret Shopify shows under Settings, Notifications, Webhooks"),
    /** When set, events from any other store are refused. */
    shopDomain: z.preprocess(blankToUndefined, z.string().trim().toLowerCase().regex(/^[a-z0-9-]+\.myshopify\.com$/, "expected a store domain like my-store.myshopify.com").optional()),
  }),
  stripe: z.object({
    webhookSecret: z.string().trim().regex(/^whsec_[A-Za-z0-9]+$/, "expected a webhook signing secret (whsec_…)"),
    /** Optional: lets promotion codes be looked up, so an affiliate's code entered at checkout attributes the sale. */
    secretKey: z.preprocess(blankToUndefined, z.string().trim().regex(/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/, "expected a Stripe secret or restricted key").optional()),
  }),
} as const;

export type ShopifyCredentials = z.infer<typeof orderSourceCredentialsSchema.shopify>;
export type StripeCredentials = z.infer<typeof orderSourceCredentialsSchema.stripe>;
export type OrderSourceCredentials = ShopifyCredentials | StripeCredentials;

export interface OrderSourceDeps {
  /** Used for Stripe lookups (promotion codes); tests inject a stub. */
  fetch?: typeof fetch;
}

export function isOrderSource(provider: string): provider is OrderSourceId {
  return (ORDER_SOURCE_IDS as readonly string[]).includes(provider);
}

/** Where the shop or processor posts its webhooks for this workspace. */
export function orderSourceHookUrl(baseUrl: string, provider: OrderSourceId, tenantId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/hooks/${provider}/${tenantId}`;
}

function hint(provider: OrderSourceId, creds: OrderSourceCredentials): string {
  if (provider === "shopify") {
    const c = creds as ShopifyCredentials;
    return `${c.shopDomain ?? "any store"} · secret …${c.webhookSecret.slice(-4)}`;
  }
  const s = creds as StripeCredentials;
  return `whsec_…${s.webhookSecret.slice(-4)}${s.secretKey ? " · promotion codes looked up" : ""}`;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export async function connectOrderSource(db: DbLike, ctx: TenantContext, provider: OrderSourceId, rawCredentials: unknown): Promise<TenantIntegration> {
  requirePerm(ctx, "integrations.manage");
  if (!isOrderSource(provider)) throw validation(`unknown order source ${provider}`);
  const creds = orderSourceCredentialsSchema[provider].parse(rawCredentials);
  // There is nothing to call to check a signing secret; the first signed event proves it, and shows as "last event".
  const values = { tenantId: ctx.tenantId, provider, credentialsEnc: encryptJson(creds), hint: hint(provider, creds), status: "connected", lastVerifiedAt: null, updatedAt: ctx.now() };
  const existing = await db.query.tenantIntegrations.findFirst({ where: and(eq(tenantIntegrations.tenantId, ctx.tenantId), eq(tenantIntegrations.provider, provider)) });
  const [row] = existing
    ? await db.update(tenantIntegrations).set(values).where(eq(tenantIntegrations.id, existing.id)).returning()
    : await db.insert(tenantIntegrations).values({ id: newId("integration"), ...values, createdAt: ctx.now() }).returning();
  await writeAudit(db, ctx, { entityType: "integration", entityId: row!.id, action: existing ? "reconnected" : "connected", after: { provider, hint: row!.hint } });
  return row!;
}

export async function disconnectOrderSource(db: DbLike, ctx: TenantContext, provider: OrderSourceId): Promise<void> {
  requirePerm(ctx, "integrations.manage");
  const existing = await db.query.tenantIntegrations.findFirst({ where: and(eq(tenantIntegrations.tenantId, ctx.tenantId), eq(tenantIntegrations.provider, provider)) });
  if (!existing) throw notFound("integration", provider);
  await db.delete(tenantIntegrations).where(eq(tenantIntegrations.id, existing.id));
  await writeAudit(db, ctx, { entityType: "integration", entityId: existing.id, action: "disconnected", before: { provider } });
}

/** The secret for a connected source, decrypted only here; null when not connected. */
export async function orderSourceCredentials<P extends OrderSourceId>(db: DbLike, ctx: TenantContext, provider: P): Promise<(P extends "shopify" ? ShopifyCredentials : StripeCredentials) | null> {
  const row = await db.query.tenantIntegrations.findFirst({ where: and(eq(tenantIntegrations.tenantId, ctx.tenantId), eq(tenantIntegrations.provider, provider), eq(tenantIntegrations.status, "connected")) });
  return row ? decryptJson(row.credentialsEnc) : null;
}

/** A signed event arrived: the connection is proven, and the page can say when it last heard from the source. */
export async function touchOrderSource(db: DbLike, ctx: TenantContext, provider: OrderSourceId): Promise<void> {
  await db.update(tenantIntegrations).set({ lastVerifiedAt: ctx.now(), updatedAt: ctx.now() }).where(and(eq(tenantIntegrations.tenantId, ctx.tenantId), eq(tenantIntegrations.provider, provider)));
}

export interface OrderSourceView {
  provider: OrderSourceId;
  connected: boolean;
  hint: string | null;
  connectedAt: Date | null;
  /** When the last correctly signed event arrived. */
  lastEventAt: Date | null;
  /** Recent inbound events, newest first: what was seen and what Referly did with it. */
  recent: { id: string; receivedAt: Date; status: string; summary: string; action: string | null; reason: string | null; conversionId: string | null }[];
}

/** Both sources for the merchant's page, with their recent events. */
export async function orderSourcesView(db: DbLike, ctx: TenantContext): Promise<OrderSourceView[]> {
  requirePerm(ctx, "read");
  const rows = await db.select().from(tenantIntegrations).where(eq(tenantIntegrations.tenantId, ctx.tenantId));
  const out: OrderSourceView[] = [];
  for (const provider of ORDER_SOURCE_IDS) {
    const row = rows.find((r) => r.provider === provider);
    const recent = await db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.tenantId, ctx.tenantId), eq(webhookDeliveries.source, provider)))
      .orderBy(desc(webhookDeliveries.receivedAt))
      .limit(10);
    out.push({
      provider,
      connected: !!row,
      hint: row?.hint ?? null,
      connectedAt: row?.createdAt ?? null,
      lastEventAt: row?.lastVerifiedAt ?? null,
      recent: recent.map((d) => ({
        id: d.id,
        receivedAt: d.receivedAt,
        status: d.status,
        summary: String((d.payload as { summary?: unknown }).summary ?? ""),
        action: ((d.payload as { action?: unknown }).action as string | undefined) ?? null,
        reason: d.error,
        conversionId: d.resultEntityType === "conversion" ? d.resultEntityId : null,
      })),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Shopify: base64 HMAC-SHA256 of the raw body, in X-Shopify-Hmac-Sha256. */
export function signShopifyPayload(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

export function verifyShopifySignature(secret: string, rawBody: string, header: string | undefined | null): boolean {
  if (!header) return false;
  return safeEqual(signShopifyPayload(secret, rawBody), header.trim());
}

/** Stripe: `t=<unix>,v1=<hex HMAC-SHA256 of "<unix>.<body>">` in Stripe-Signature; several v1 entries while a secret rolls. */
export function signStripePayload(secret: string, rawBody: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex")}`;
}

export function verifyStripeSignature(secret: string, rawBody: string, header: string | undefined | null, now: Date, toleranceSeconds = 300): boolean {
  if (!header) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t" && v && /^\d+$/.test(v)) timestamp = Number(v);
    else if (k === "v1" && v) signatures.push(v);
  }
  if (timestamp === null || !signatures.length) return false;
  // A captured request cannot be replayed later: the signed timestamp must be recent.
  if (Math.abs(now.getTime() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return signatures.some((s) => safeEqual(expected, s));
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

export interface OrderSourceOutcome {
  action: "recorded" | "duplicate" | "skipped" | "refunded" | "cancelled" | "ignored";
  conversionId: string | null;
  /** What was seen, in the merchant's words: "orders/paid #1001", "charge.refunded ch_…". */
  summary: string;
  reason?: string;
}

type Json = Record<string, any>;
const TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const str = (v: unknown): string | undefined => (v == null || v === "" ? undefined : String(v));
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
const tokenLike = (v: unknown): string | undefined => (typeof v === "string" && TOKEN_RE.test(v) ? v : undefined);
const visitorLike = (v: unknown): string | undefined => (typeof v === "string" && VISITOR_ID.test(v) ? v : undefined);
const validEmail = (v: unknown): string | undefined => (typeof v === "string" && EMAIL_RE.test(v.trim()) && v.length <= 320 ? v.trim() : undefined);
const dateOf = (v: unknown): Date | undefined => {
  if (typeof v === "number") return new Date(v * 1000);
  if (typeof v !== "string") return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};
const ignored = (summary: string, reason: string, conversionId: string | null = null): OrderSourceOutcome => ({ action: "ignored", conversionId, summary, reason });

/** Records a mapped order through the shared intake, turning the affiliate-only rule into an outcome rather than an error. */
async function recordMapped(db: DbLike, ctx: TenantContext, summary: string, input: RecordConversionInput, backfill?: (conversion: Conversion) => Promise<void>): Promise<OrderSourceOutcome> {
  try {
    const result = await recordConversion(db, ctx, input);
    if (result.duplicate) {
      if (backfill) await backfill(result.conversion);
      return { action: "duplicate", conversionId: result.conversion.id, summary, reason: "this order was already recorded" };
    }
    return { action: "recorded", conversionId: result.conversion.id, summary };
  } catch (err) {
    if (err instanceof NoAffiliateError) return { action: "skipped", conversionId: null, summary, reason: "no affiliate click, visitor or coupon code on this order, so it is not Referly's to record" };
    if (err instanceof DomainError && err.code === "validation") return ignored(summary, err.message);
    throw err;
  }
}

/** Applies a refund to a recorded sale; a sale that cannot take one (cancelled, already refunded) is reported, not retried. */
async function refundMapped(db: DbLike, ctx: TenantContext, summary: string, conversion: Conversion, amountMinor: number, reason: string): Promise<OrderSourceOutcome> {
  const remaining = conversion.amountMinor - conversion.refundedAmountMinor;
  if (remaining <= 0) return ignored(summary, "this sale was already fully refunded", conversion.id);
  try {
    await refundConversion(db, ctx, { conversionId: conversion.id, amountMinor: Math.min(amountMinor, remaining), reason });
    return { action: "refunded", conversionId: conversion.id, summary };
  } catch (err) {
    if (err instanceof DomainError && (err.code === "invalid_transition" || err.code === "validation")) return ignored(summary, err.message, conversion.id);
    throw err;
  }
}

/** Among the codes on an order, the first one that belongs to an affiliate; a store's own discount codes are not evidence. */
async function affiliateCode(db: DbLike, ctx: TenantContext, codes: unknown[]): Promise<string | undefined> {
  for (const code of codes) {
    if (typeof code !== "string" || !code.trim() || code.length > 40) continue;
    if (await findCouponByCode(db, ctx, code)) return code;
  }
  return undefined;
}

// ----- Shopify ---------------------------------------------------------------

function shopifyAttributes(order: Json): Record<string, string> {
  const out: Record<string, string> = {};
  const attrs: unknown = order.note_attributes;
  if (Array.isArray(attrs)) for (const a of attrs) if (a && typeof a.name === "string" && typeof a.value === "string") out[a.name] = a.value;
  return out;
}

/** The click token the tracking redirect appends as `?ref=`: set on the cart by the snippet, or still on the landing URL Shopify recorded. */
function shopifyClickToken(order: Json, attrs: Record<string, string>): string | undefined {
  const fromCart = tokenLike(attrs.referly_ref);
  if (fromCart) return fromCart;
  const landing = typeof order.landing_site === "string" ? order.landing_site : "";
  const m = landing.match(/[?&]ref=([A-Za-z0-9_-]{6,64})(?=[&#]|$)/);
  if (m) return m[1];
  return tokenLike(order.landing_site_ref);
}

async function findShopifyConversion(db: DbLike, ctx: TenantContext, shopifyOrderId: string): Promise<Conversion | null> {
  const rows = await db
    .select()
    .from(conversions)
    .where(and(eq(conversions.tenantId, ctx.tenantId), sql`${conversions.metadata}->'shopify'->>'id' = ${shopifyOrderId}`))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Shopify order webhooks. `orders/paid` records the sale (`orders/create` and `orders/updated`
 * only once the order is paid), `refunds/create` refunds the money that went back, and
 * `orders/cancelled` cancels. The order number ("#1001") is the order id Referly shows, so it
 * matches what the merchant sees in Shopify and what the order status page would have reported.
 */
export async function handleShopifyEvent(db: DbLike, ctx: TenantContext, topic: string, payload: Json, opts: { shopDomain?: string | null } = {}): Promise<OrderSourceOutcome> {
  switch (topic) {
    case "orders/paid":
    case "orders/create":
    case "orders/updated":
      return recordShopifyOrder(db, ctx, topic, payload, opts);
    case "refunds/create":
      return refundShopifyOrder(db, ctx, payload);
    case "orders/cancelled":
      return cancelShopifyOrder(db, ctx, payload);
    default:
      return ignored(topic, `${topic} is not used: subscribe to Order payment, Refund create and Order cancellation`);
  }
}

async function recordShopifyOrder(db: DbLike, ctx: TenantContext, topic: string, order: Json, opts: { shopDomain?: string | null }): Promise<OrderSourceOutcome> {
  const id = str(order.id);
  const name = str(order.name);
  const summary = `${topic} ${name ?? id ?? "?"}`;
  if (!id) return ignored(summary, "the payload carries no order id");
  if (topic !== "orders/paid" && order.financial_status !== "paid") return ignored(summary, `the order is ${str(order.financial_status) ?? "not paid"}; it is recorded once paid`);
  const currency = (str(order.currency) ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return ignored(summary, "the payload carries no currency");
  const amountMinor = toMinorUnits(order.total_price ?? "0", currency);
  const subtotal = order.subtotal_price != null ? toMinorUnits(order.subtotal_price, currency) : undefined;
  const attrs = shopifyAttributes(order);
  const codes = Array.isArray(order.discount_codes) ? order.discount_codes.map((d: Json) => d?.code) : [];
  const shopify = {
    id,
    name: name ?? null,
    orderNumber: str(order.order_number) ?? null,
    financialStatus: str(order.financial_status) ?? null,
    shopDomain: opts.shopDomain ?? null,
    test: order.test === true,
  };
  const input: RecordConversionInput = {
    source: "shopify",
    kind: "sale",
    externalOrderId: name ?? id,
    amountMinor,
    netAmountMinor: subtotal != null && subtotal <= amountMinor ? subtotal : undefined,
    currency,
    customerEmail: validEmail(order.email ?? order.contact_email ?? order.customer?.email),
    customerRef: str(order.customer?.id),
    clickToken: shopifyClickToken(order, attrs),
    visitorId: visitorLike(attrs.referly_vid),
    couponCode: await affiliateCode(db, ctx, codes),
    occurredAt: dateOf(order.processed_at ?? order.created_at),
    metadata: { shopify },
  };
  // An order the status page already reported gains the Shopify id, so later refunds find it.
  return recordMapped(db, ctx, summary, input, async (existing) => {
    const meta = (existing.metadata ?? {}) as Json;
    if (meta.shopify?.id) return;
    await db.update(conversions).set({ metadata: { ...meta, shopify }, updatedAt: ctx.now() }).where(eq(conversions.id, existing.id));
  });
}

async function refundShopifyOrder(db: DbLike, ctx: TenantContext, refund: Json): Promise<OrderSourceOutcome> {
  const orderId = str(refund.order_id);
  const summary = `refunds/create for order ${orderId ?? "?"}`;
  if (!orderId) return ignored(summary, "the payload carries no order id");
  const conversion = await findShopifyConversion(db, ctx, orderId);
  if (!conversion) return ignored(summary, "this order was never recorded (no affiliate), so there is nothing to refund");
  let returned = 0;
  const transactions: Json[] = Array.isArray(refund.transactions) ? refund.transactions : [];
  for (const t of transactions) if (t?.kind === "refund" && (t.status === "success" || t.status == null)) returned += toMinorUnits(t.amount ?? "0", str(t.currency) ?? conversion.currency);
  if (returned <= 0) return ignored(summary, "no money went back to the customer (restock only)", conversion.id);
  const note = typeof refund.note === "string" && refund.note.trim() ? `: ${refund.note.trim().slice(0, 200)}` : "";
  return refundMapped(db, ctx, summary, conversion, returned, `refunded in Shopify (refund ${str(refund.id) ?? "?"})${note}`);
}

async function cancelShopifyOrder(db: DbLike, ctx: TenantContext, order: Json): Promise<OrderSourceOutcome> {
  const id = str(order.id);
  const name = str(order.name);
  const summary = `orders/cancelled ${name ?? id ?? "?"}`;
  const conversion = (id ? await findShopifyConversion(db, ctx, id) : null) ?? (name ? await findByExternalId(db, ctx, "shopify", name) : null);
  if (!conversion) return ignored(summary, "this order was never recorded (no affiliate), so there is nothing to cancel");
  if (conversion.status === "cancelled") return ignored(summary, "already cancelled", conversion.id);
  try {
    await cancelConversion(db, ctx, conversion.id, `cancelled in Shopify${str(order.cancel_reason) ? ` (${str(order.cancel_reason)})` : ""}`);
    return { action: "cancelled", conversionId: conversion.id, summary };
  } catch (err) {
    if (err instanceof DomainError && (err.code === "invalid_transition" || err.code === "validation")) return ignored(summary, err.message, conversion.id);
    throw err;
  }
}

// ----- Stripe ----------------------------------------------------------------

export interface StripeEvent {
  id: string;
  type: string;
  created?: number;
  livemode?: boolean;
  data: { object: Json };
}

async function stripeGet(f: typeof fetch, secretKey: string, path: string): Promise<Json | null> {
  try {
    const res = await f(`https://api.stripe.com${path}`, { headers: { authorization: `Bearer ${secretKey}` } });
    if (!res.ok) return null;
    return (await res.json()) as Json;
  } catch {
    return null;
  }
}

/**
 * The code the customer typed at checkout. Webhook payloads carry only ids for promotion codes
 * and coupons; with a key they are looked up, otherwise a code cannot attribute the sale.
 */
async function stripeCodes(session: Json, creds: StripeCredentials, deps: OrderSourceDeps): Promise<string[]> {
  const out: string[] = [];
  if (typeof session.metadata?.referly_coupon === "string") out.push(session.metadata.referly_coupon);
  const discounts: Json[] = Array.isArray(session.discounts) ? session.discounts : [];
  const f = deps.fetch ?? fetch;
  for (const d of discounts) {
    const promo = d?.promotion_code;
    const coupon = d?.coupon;
    let code: string | undefined;
    if (promo && typeof promo === "object" && typeof promo.code === "string") code = promo.code;
    else if (typeof promo === "string" && creds.secretKey) code = str((await stripeGet(f, creds.secretKey, `/v1/promotion_codes/${encodeURIComponent(promo)}`))?.code);
    // No promotion code (a discount applied by the merchant's own code): the coupon's name may still be an affiliate's.
    if (!code && coupon && typeof coupon === "object" && typeof coupon.name === "string") code = coupon.name;
    else if (!code && typeof coupon === "string" && creds.secretKey) code = str((await stripeGet(f, creds.secretKey, `/v1/coupons/${encodeURIComponent(coupon)}`))?.name);
    if (code) out.push(code);
  }
  return out;
}

/**
 * Stripe events. Checkout Sessions (`checkout.session.completed`, or `async_payment_succeeded`
 * for bank debits that settle later) record the sale once paid; `payment_intent.succeeded`
 * covers custom Payment Element flows that put the click token in the intent's metadata;
 * `charge.refunded` applies whatever has been refunded since. The payment intent id is the
 * order id, so refunds find the sale without any lookup.
 */
export async function handleStripeEvent(db: DbLike, ctx: TenantContext, event: StripeEvent, creds: StripeCredentials, deps: OrderSourceDeps = {}): Promise<OrderSourceOutcome> {
  const object: Json = event.data?.object ?? {};
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return recordStripeSession(db, ctx, event, object, creds, deps);
    case "payment_intent.succeeded":
      return recordStripePaymentIntent(db, ctx, event, object);
    case "charge.refunded":
      return refundStripeCharge(db, ctx, event, object);
    default:
      return ignored(event.type, `${event.type} is not used: send checkout.session.completed, checkout.session.async_payment_succeeded, payment_intent.succeeded and charge.refunded`);
  }
}

async function recordStripeSession(db: DbLike, ctx: TenantContext, event: StripeEvent, session: Json, creds: StripeCredentials, deps: OrderSourceDeps): Promise<OrderSourceOutcome> {
  const summary = `${event.type} ${str(session.id) ?? "?"}`;
  if (!str(session.id)) return ignored(summary, "the payload carries no session id");
  if (session.mode === "setup") return ignored(summary, "a setup session takes no payment");
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") return ignored(summary, `payment is ${str(session.payment_status) ?? "not complete"}; the sale is recorded once it succeeds`);
  const currency = (str(session.currency) ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return ignored(summary, "the payload carries no currency");
  const amountMinor = num(session.amount_total) ?? 0;
  const subtotal = num(session.amount_subtotal);
  const discount = num(session.total_details?.amount_discount) ?? 0;
  const net = subtotal != null ? Math.max(0, Math.min(amountMinor, subtotal - discount)) : undefined;
  const meta: Json = session.metadata ?? {};
  const paymentIntent = str(session.payment_intent);
  const input: RecordConversionInput = {
    source: "stripe",
    kind: "sale",
    externalOrderId: paymentIntent ?? String(session.id),
    amountMinor,
    netAmountMinor: net,
    currency,
    customerEmail: validEmail(session.customer_details?.email ?? session.customer_email),
    customerRef: str(session.customer),
    clickToken: tokenLike(meta.referly_ref) ?? tokenLike(session.client_reference_id),
    visitorId: visitorLike(meta.referly_vid),
    couponCode: await affiliateCode(db, ctx, await stripeCodes(session, creds, deps)),
    occurredAt: dateOf(event.created) ?? ctx.now(),
    metadata: { stripe: { sessionId: session.id, paymentIntent: paymentIntent ?? null, customer: str(session.customer) ?? null, mode: str(session.mode) ?? null, livemode: event.livemode ?? session.livemode ?? null, eventId: event.id } },
  };
  return recordMapped(db, ctx, summary, input);
}

async function recordStripePaymentIntent(db: DbLike, ctx: TenantContext, event: StripeEvent, intent: Json): Promise<OrderSourceOutcome> {
  const summary = `${event.type} ${str(intent.id) ?? "?"}`;
  if (!str(intent.id)) return ignored(summary, "the payload carries no payment intent id");
  const currency = (str(intent.currency) ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return ignored(summary, "the payload carries no currency");
  const meta: Json = intent.metadata ?? {};
  const input: RecordConversionInput = {
    source: "stripe",
    kind: "sale",
    externalOrderId: String(intent.id),
    amountMinor: num(intent.amount_received) ?? num(intent.amount) ?? 0,
    currency,
    customerEmail: validEmail(intent.receipt_email),
    customerRef: str(intent.customer),
    clickToken: tokenLike(meta.referly_ref),
    visitorId: visitorLike(meta.referly_vid),
    couponCode: await affiliateCode(db, ctx, [meta.referly_coupon]),
    occurredAt: dateOf(event.created) ?? ctx.now(),
    metadata: { stripe: { paymentIntent: intent.id, customer: str(intent.customer) ?? null, livemode: event.livemode ?? intent.livemode ?? null, eventId: event.id } },
  };
  return recordMapped(db, ctx, summary, input);
}

async function refundStripeCharge(db: DbLike, ctx: TenantContext, event: StripeEvent, charge: Json): Promise<OrderSourceOutcome> {
  const summary = `${event.type} ${str(charge.id) ?? "?"}`;
  const key = str(charge.payment_intent) ?? str(charge.id);
  if (!key) return ignored(summary, "the payload carries no payment intent");
  const conversion = await findByExternalId(db, ctx, "stripe", key);
  if (!conversion) return ignored(summary, "this payment was never recorded (no affiliate), so there is nothing to refund");
  const refundedSoFar = num(charge.amount_refunded) ?? 0;
  const delta = refundedSoFar - conversion.refundedAmountMinor;
  if (delta <= 0) return ignored(summary, "this refund is already reflected", conversion.id);
  const latest: Json | undefined = Array.isArray(charge.refunds?.data) ? charge.refunds.data[0] : undefined;
  const why = str(latest?.reason);
  return refundMapped(db, ctx, summary, conversion, delta, `refunded in Stripe${why ? ` (${why.replace(/_/g, " ")})` : ""}`);
}

// ---------------------------------------------------------------------------
// Delivery log
// ---------------------------------------------------------------------------

/**
 * Every inbound event is logged once, keyed on the sender's own event id, so a retried delivery
 * is answered without being processed twice. Returns null when the event was seen before.
 */
export async function beginOrderSourceDelivery(db: DbLike, ctx: TenantContext, provider: OrderSourceId, eventId: string, summary: string): Promise<string | null> {
  const id = newId("webhookDelivery");
  const inserted = await db
    .insert(webhookDeliveries)
    .values({ id, tenantId: ctx.tenantId, source: provider, idempotencyKey: `${provider}:${eventId}`, payload: { summary }, receivedAt: ctx.now() })
    .onConflictDoNothing()
    .returning({ id: webhookDeliveries.id });
  return inserted.length ? id : null;
}

const STATUS_FOR_ACTION: Record<OrderSourceOutcome["action"], string> = { recorded: "processed", refunded: "processed", cancelled: "processed", duplicate: "duplicate", skipped: "skipped", ignored: "ignored" };

export async function finishOrderSourceDelivery(db: DbLike, ctx: TenantContext, deliveryId: string, outcome: OrderSourceOutcome | { error: string; summary: string }): Promise<void> {
  if ("error" in outcome) {
    await db.update(webhookDeliveries).set({ status: "failed", error: outcome.error.slice(0, 1000), payload: { summary: outcome.summary }, processedAt: ctx.now() }).where(eq(webhookDeliveries.id, deliveryId));
    return;
  }
  await db
    .update(webhookDeliveries)
    .set({
      status: STATUS_FOR_ACTION[outcome.action],
      error: outcome.reason?.slice(0, 1000) ?? null,
      payload: { summary: outcome.summary, action: outcome.action },
      resultEntityType: outcome.conversionId ? "conversion" : null,
      resultEntityId: outcome.conversionId,
      processedAt: ctx.now(),
    })
    .where(eq(webhookDeliveries.id, deliveryId));
}

export type { WebhookDelivery };
