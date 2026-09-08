import { createHmac, timingSafeEqual } from "node:crypto";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { assertPublicUrl, urlLooksPublic, type Lookup } from "../urls";
import type { DbLike } from "../db/client";
import { affiliates, commissions, conversions, payouts, webhookOutboundDeliveries, webhookSubscriptions, type WebhookOutboundDelivery, type WebhookSubscription } from "../db/schema";
import { newId, newSecret } from "../ids";
import { notFound, validation } from "../errors";
import { type TenantContext, require as requirePerm } from "../context";
import { decryptJson, encryptJson } from "../crypto";
import { writeAudit, snapshot } from "./audit";
import { enqueueJob } from "./jobs";
import { createTask } from "./automation";
import type { DomainEvent } from "./events";

/**
 * Outbound webhooks (PRD s14 P1 "Zapier/Make: trigger/update actions across third-party tools").
 * A merchant subscribes a URL to domain events; every matching stored event becomes a signed
 * delivery attempted by the worker with exponential backoff. Deliveries are logged so a
 * merchant can see exactly what was sent and what came back, and redeliver by hand.
 */

export const WEBHOOK_EVENTS = [
  { type: "affiliate.applied", description: "An affiliate applied to a program" },
  { type: "affiliate.approved", description: "An affiliate was approved (or accepted an invite)" },
  { type: "affiliate.rejected", description: "An application was rejected" },
  { type: "affiliate.suspended", description: "An affiliate was suspended" },
  { type: "conversion.created", description: "A sale was recorded (attributed or not)" },
  { type: "conversion.refunded", description: "A sale was refunded, fully or partially" },
  { type: "conversion.cancelled", description: "A sale was cancelled" },
  { type: "commission.created", description: "A commission was created for a sale" },
  { type: "commission.approved", description: "A commission was approved" },
  { type: "commission.payable", description: "A commission became payable" },
  { type: "commission.reversed", description: "A commission was reversed or voided" },
  { type: "payout.created", description: "A payout batch was created" },
  { type: "payout.paid", description: "A payout was paid" },
  { type: "payout.failed", description: "A payout failed" },
  { type: "campaign.started", description: "A campaign went live" },
  { type: "campaign.ended", description: "A campaign ended" },
  { type: "dispute.opened", description: "A dispute was opened" },
  { type: "dispute.resolved", description: "A dispute was resolved" },
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number]["type"];
const EVENT_TYPES = WEBHOOK_EVENTS.map((e) => e.type) as [WebhookEventType, ...WebhookEventType[]];

export const subscriptionSchema = z.object({
  url: z
    .string()
    .max(2048)
    .url()
    .refine((u) => urlLooksPublic(u).ok, "url must be a public http(s) endpoint (no private, loopback or link-local addresses)"),
  /** Event types, or ["*"] for everything. */
  events: z.array(z.union([z.enum(EVENT_TYPES), z.literal("*")])).min(1),
  description: z.string().max(200).nullable().optional(),
});

export const DISABLE_AFTER_CONSECUTIVE_FAILURES = 5;
export const MAX_ATTEMPTS = 8;

function hint(secret: string) {
  return `whsec_…${secret.slice(-4)}`;
}

export async function createSubscription(db: DbLike, ctx: TenantContext, rawInput: z.input<typeof subscriptionSchema>): Promise<{ subscription: WebhookSubscription; secret: string }> {
  requirePerm(ctx, "integrations.manage");
  const input = subscriptionSchema.parse(rawInput);
  const secret = `whsec_${newSecret()}`;
  const [row] = await db
    .insert(webhookSubscriptions)
    .values({
      id: newId("webhookSubscription"),
      tenantId: ctx.tenantId,
      url: input.url,
      secretEnc: encryptJson({ secret }),
      secretHint: hint(secret),
      events: input.events,
      description: input.description ?? null,
      status: "active",
      consecutiveFailures: 0,
      createdByUserId: ctx.actor.type === "user" ? (ctx.actor.id ?? null) : null,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    })
    .returning();
  await writeAudit(db, ctx, { entityType: "webhook_subscription", entityId: row!.id, action: "created", after: { url: input.url, events: input.events } });
  return { subscription: row!, secret };
}

export const updateSubscriptionSchema = subscriptionSchema.partial().extend({ status: z.enum(["active", "paused"]).optional() });

export async function updateSubscription(db: DbLike, ctx: TenantContext, id: string, rawInput: z.input<typeof updateSubscriptionSchema>): Promise<WebhookSubscription> {
  requirePerm(ctx, "integrations.manage");
  const input = updateSubscriptionSchema.parse(rawInput);
  const before = await getSubscription(db, ctx, id);
  const patch: Partial<WebhookSubscription> = { updatedAt: ctx.now() };
  if (input.url) patch.url = input.url;
  if (input.events) patch.events = input.events;
  if (input.description !== undefined) patch.description = input.description ?? null;
  if (input.status) {
    patch.status = input.status;
    if (input.status === "active") patch.consecutiveFailures = 0; // re-enabling gives it a clean slate
  }
  const [after] = await db.update(webhookSubscriptions).set(patch).where(eq(webhookSubscriptions.id, id)).returning();
  await writeAudit(db, ctx, { entityType: "webhook_subscription", entityId: id, action: "updated", before: snapshot(before, ["url", "events", "status"]), after: snapshot(after!, ["url", "events", "status"]) });
  return after!;
}

export async function deleteSubscription(db: DbLike, ctx: TenantContext, id: string): Promise<void> {
  requirePerm(ctx, "integrations.manage");
  const before = await getSubscription(db, ctx, id);
  await db.delete(webhookOutboundDeliveries).where(and(eq(webhookOutboundDeliveries.tenantId, ctx.tenantId), eq(webhookOutboundDeliveries.subscriptionId, id)));
  await db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, id));
  await writeAudit(db, ctx, { entityType: "webhook_subscription", entityId: id, action: "deleted", before: snapshot(before, ["url", "events"]) });
}

export async function getSubscription(db: DbLike, ctx: TenantContext, id: string): Promise<WebhookSubscription> {
  const row = await db.query.webhookSubscriptions.findFirst({ where: and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.tenantId, ctx.tenantId)) });
  if (!row) throw notFound("webhook subscription", id);
  return row;
}

export function publicSubscription(s: WebhookSubscription) {
  const { secretEnc: _secret, ...rest } = s;
  return rest;
}

export async function listSubscriptions(db: DbLike, ctx: TenantContext) {
  requirePerm(ctx, "read");
  const rows = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.tenantId, ctx.tenantId)).orderBy(desc(webhookSubscriptions.createdAt));
  const stats = await db
    .select({ subscriptionId: webhookOutboundDeliveries.subscriptionId, delivered: sql<number>`sum(case when ${webhookOutboundDeliveries.status} = 'delivered' then 1 else 0 end)`, dead: sql<number>`sum(case when ${webhookOutboundDeliveries.status} = 'dead' then 1 else 0 end)`, total: count() })
    .from(webhookOutboundDeliveries)
    .where(eq(webhookOutboundDeliveries.tenantId, ctx.tenantId))
    .groupBy(webhookOutboundDeliveries.subscriptionId);
  return rows.map((s) => {
    const st = stats.find((x) => x.subscriptionId === s.id);
    return { ...publicSubscription(s), stats: { delivered: Number(st?.delivered ?? 0), dead: Number(st?.dead ?? 0), total: st?.total ?? 0 } };
  });
}

// ---------------------------------------------------------------------------
// Payloads and signing
// ---------------------------------------------------------------------------

export interface WebhookPayload {
  id: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

/** Stable, documented shape: event data plus a snapshot of the main entity with sensitive fields removed. */
export async function buildPayload(db: DbLike, ctx: TenantContext, event: DomainEvent, deliveryId: string): Promise<WebhookPayload> {
  const data: Record<string, unknown> = { ...event.data, entity: { type: event.entityType, id: event.entityId } };
  const affiliateId = (event.data.affiliateId as string | undefined) ?? (event.entityType === "affiliate" ? event.entityId : undefined);
  if (affiliateId) {
    const a = await db.query.affiliates.findFirst({ where: and(eq(affiliates.id, affiliateId), eq(affiliates.tenantId, ctx.tenantId)) });
    if (a) data.affiliate = { id: a.id, name: a.name, email: a.email, status: a.status, tags: a.tags, company: a.company };
  }
  const conversionId = (event.data.conversionId as string | undefined) ?? (event.entityType === "conversion" ? event.entityId : undefined);
  if (conversionId) {
    const c = await db.query.conversions.findFirst({ where: and(eq(conversions.id, conversionId), eq(conversions.tenantId, ctx.tenantId)) });
    if (c) data.conversion = { id: c.id, externalOrderId: c.externalOrderId, source: c.source, amountMinor: c.amountMinor, refundedAmountMinor: c.refundedAmountMinor, currency: c.currency, status: c.status, affiliateId: c.affiliateId, programId: c.programId, offerId: c.offerId, campaignId: c.campaignId, attributionSource: c.attributionSource, occurredAt: c.occurredAt };
  }
  const commissionId = (event.data.commissionId as string | undefined) ?? (event.entityType === "commission" ? event.entityId : undefined);
  if (commissionId) {
    const c = await db.query.commissions.findFirst({ where: and(eq(commissions.id, commissionId), eq(commissions.tenantId, ctx.tenantId)) });
    if (c) data.commission = { id: c.id, amountMinor: c.amountMinor, currency: c.currency, status: c.status, affiliateId: c.affiliateId, conversionId: c.conversionId, programId: c.programId, payableAt: c.payableAt };
  }
  if (event.entityType === "payout") {
    const p = await db.query.payouts.findFirst({ where: and(eq(payouts.id, event.entityId), eq(payouts.tenantId, ctx.tenantId)) });
    if (p) data.payout = { id: p.id, amountMinor: p.amountMinor, currency: p.currency, status: p.status, affiliateId: p.affiliateId, externalReference: p.externalReference, paidAt: p.paidAt };
  }
  return { id: deliveryId, type: event.type, occurredAt: event.occurredAt, data };
}

export function sign(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** Verifies a `v1=<hex>` signature header for a raw body. Exported for merchants' reference and for tests. */
export function verifySignature(secret: string, timestamp: string, body: string, header: string, toleranceSeconds = 300, now = Date.now()): boolean {
  const provided = header.split(",").find((p) => p.startsWith("v1="))?.slice(3);
  if (!provided) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  const expected = sign(secret, timestamp, body);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Fan-out and delivery
// ---------------------------------------------------------------------------

function matches(sub: WebhookSubscription, type: string) {
  return sub.events.includes("*") || sub.events.includes(type);
}

/** Called by the worker for every stored event: one delivery per active matching subscription. */
export async function fanOut(db: DbLike, ctx: TenantContext, event: DomainEvent): Promise<WebhookOutboundDelivery[]> {
  if (!(EVENT_TYPES as readonly string[]).includes(event.type)) return [];
  const subs = await db.select().from(webhookSubscriptions).where(and(eq(webhookSubscriptions.tenantId, ctx.tenantId), eq(webhookSubscriptions.status, "active")));
  const targets = subs.filter((s) => matches(s, event.type));
  if (!targets.length) return [];
  const out: WebhookOutboundDelivery[] = [];
  for (const sub of targets) {
    const id = newId("webhookDelivery");
    const payload = await buildPayload(db, ctx, event, id);
    const [row] = await db
      .insert(webhookOutboundDeliveries)
      .values({ id, tenantId: ctx.tenantId, subscriptionId: sub.id, eventType: event.type, payload: payload as unknown as Record<string, unknown>, attempts: 0, status: "pending", createdAt: ctx.now(), updatedAt: ctx.now() })
      .returning();
    await enqueueJob(db, { tenantId: ctx.tenantId, type: "deliver_webhook", payload: { deliveryId: id, tenantId: ctx.tenantId }, runAt: ctx.now(), maxAttempts: MAX_ATTEMPTS, idempotencyKey: `whk:${id}` });
    out.push(row!);
  }
  return out;
}

export interface DeliverOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** From the job: current attempt number (1-based) and the cap, to know when to give up. */
  attempt?: number;
  maxAttempts?: number;
  /** DNS resolver used by the SSRF check (tests inject one). */
  lookup?: Lookup;
}

/** Most an endpoint's response body is read; the rest is discarded so a hostile endpoint cannot exhaust the worker. */
const MAX_RESPONSE_BYTES = 64 * 1024;

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, MAX_RESPONSE_BYTES));
}

async function post(sub: WebhookSubscription, payload: WebhookPayload, opts: DeliverOptions, now: Date): Promise<{ ok: boolean; status: number | null; body: string; error?: string }> {
  const { secret } = decryptJson<{ secret: string }>(sub.secretEnc);
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    // SSRF guard at send time: the name is resolved now, so a record changed after save is caught too.
    await assertPublicUrl(sub.url, opts.lookup);
    const res = await (opts.fetchImpl ?? fetch)(sub.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Referly-Webhooks/1.0",
        "x-referly-event": payload.type,
        "x-referly-delivery": payload.id,
        "x-referly-timestamp": timestamp,
        "x-referly-signature": `v1=${sign(secret, timestamp, body)}`,
      },
      body,
      signal: controller.signal,
      redirect: "manual",
    });
    const text = (await readCapped(res).catch(() => "")).slice(0, 500);
    if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, body: text, error: `endpoint redirected (${res.status}); webhooks must respond directly` };
    return { ok: res.ok, status: res.status, body: text, error: res.ok ? undefined : `endpoint responded ${res.status}` };
  } catch (err) {
    return { ok: false, status: null, body: "", error: err instanceof Error ? (err.name === "AbortError" ? "timed out" : err.message) : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Worker: attempt a delivery. Throws on failure so the job retries with backoff; on the final
 * attempt the delivery is marked dead and the subscription's failure streak is counted.
 */
export async function deliver(db: DbLike, ctx: TenantContext, deliveryId: string, opts: DeliverOptions = {}): Promise<WebhookOutboundDelivery> {
  const delivery = await db.query.webhookOutboundDeliveries.findFirst({ where: and(eq(webhookOutboundDeliveries.id, deliveryId), eq(webhookOutboundDeliveries.tenantId, ctx.tenantId)) });
  if (!delivery) throw notFound("webhook delivery", deliveryId);
  if (delivery.status === "delivered" || delivery.status === "dead") return delivery;
  const sub = await getSubscription(db, ctx, delivery.subscriptionId);
  if (sub.status !== "active") {
    const [row] = await db.update(webhookOutboundDeliveries).set({ status: "dead", error: `subscription is ${sub.status}`, updatedAt: ctx.now() }).where(eq(webhookOutboundDeliveries.id, deliveryId)).returning();
    return row!;
  }
  const result = await post(sub, delivery.payload as unknown as WebhookPayload, opts, ctx.now());
  const attempts = delivery.attempts + 1;
  const final = (opts.attempt ?? attempts) >= (opts.maxAttempts ?? MAX_ATTEMPTS);
  if (result.ok) {
    const [row] = await db
      .update(webhookOutboundDeliveries)
      .set({ attempts, status: "delivered", responseStatus: result.status, responseBody: result.body, error: null, deliveredAt: ctx.now(), updatedAt: ctx.now() })
      .where(eq(webhookOutboundDeliveries.id, deliveryId))
      .returning();
    await db.update(webhookSubscriptions).set({ consecutiveFailures: 0, lastDeliveryAt: ctx.now(), lastStatus: "delivered", updatedAt: ctx.now() }).where(eq(webhookSubscriptions.id, sub.id));
    return row!;
  }
  const [row] = await db
    .update(webhookOutboundDeliveries)
    .set({ attempts, status: final ? "dead" : "failed", responseStatus: result.status, responseBody: result.body, error: result.error ?? "delivery failed", updatedAt: ctx.now() })
    .where(eq(webhookOutboundDeliveries.id, deliveryId))
    .returning();
  await db.update(webhookSubscriptions).set({ lastDeliveryAt: ctx.now(), lastStatus: final ? "dead" : "failed", updatedAt: ctx.now() }).where(eq(webhookSubscriptions.id, sub.id));
  if (final) {
    const streak = sub.consecutiveFailures + 1;
    const disable = streak >= DISABLE_AFTER_CONSECUTIVE_FAILURES;
    await db.update(webhookSubscriptions).set({ consecutiveFailures: streak, status: disable ? "disabled" : sub.status, updatedAt: ctx.now() }).where(eq(webhookSubscriptions.id, sub.id));
    if (disable) {
      await writeAudit(db, ctx, { entityType: "webhook_subscription", entityId: sub.id, action: "auto_disabled", after: { consecutiveFailures: streak } });
      await createTask(db, ctx, { title: `Webhook disabled after ${streak} failed deliveries`, note: `${sub.url} · last error: ${result.error ?? "unknown"}`, entityType: "webhook_subscription", entityId: sub.id });
    }
    return row!;
  }
  throw new Error(result.error ?? "delivery failed");
}

/** Clone a delivery for another try (manual redelivery from the log). */
export async function redeliver(db: DbLike, ctx: TenantContext, deliveryId: string): Promise<WebhookOutboundDelivery> {
  requirePerm(ctx, "integrations.manage");
  const original = await db.query.webhookOutboundDeliveries.findFirst({ where: and(eq(webhookOutboundDeliveries.id, deliveryId), eq(webhookOutboundDeliveries.tenantId, ctx.tenantId)) });
  if (!original) throw notFound("webhook delivery", deliveryId);
  const id = newId("webhookDelivery");
  const payload = { ...(original.payload as unknown as WebhookPayload), id, redeliveryOf: original.id };
  const [row] = await db
    .insert(webhookOutboundDeliveries)
    .values({ id, tenantId: ctx.tenantId, subscriptionId: original.subscriptionId, eventType: original.eventType, payload: payload as unknown as Record<string, unknown>, attempts: 0, status: "pending", createdAt: ctx.now(), updatedAt: ctx.now() })
    .returning();
  await enqueueJob(db, { tenantId: ctx.tenantId, type: "deliver_webhook", payload: { deliveryId: id, tenantId: ctx.tenantId }, runAt: ctx.now(), maxAttempts: MAX_ATTEMPTS, idempotencyKey: `whk:${id}` });
  return row!;
}

/** Synchronous ping so a merchant can check their endpoint from the UI. Logged like any delivery. */
export async function testSubscription(db: DbLike, ctx: TenantContext, id: string, opts: DeliverOptions = {}): Promise<{ ok: boolean; status: number | null; error?: string; delivery: WebhookOutboundDelivery }> {
  requirePerm(ctx, "integrations.manage");
  const sub = await getSubscription(db, ctx, id);
  const deliveryId = newId("webhookDelivery");
  const payload: WebhookPayload = { id: deliveryId, type: "ping", occurredAt: ctx.now().toISOString(), data: { message: "Hello from your affiliate platform", subscriptionId: sub.id } };
  const result = await post(sub, payload, opts, ctx.now());
  const [row] = await db
    .insert(webhookOutboundDeliveries)
    .values({ id: deliveryId, tenantId: ctx.tenantId, subscriptionId: sub.id, eventType: "ping", payload: payload as unknown as Record<string, unknown>, attempts: 1, status: result.ok ? "delivered" : "dead", responseStatus: result.status, responseBody: result.body, error: result.error ?? null, deliveredAt: result.ok ? ctx.now() : null, createdAt: ctx.now(), updatedAt: ctx.now() })
    .returning();
  return { ok: result.ok, status: result.status, error: result.error, delivery: row! };
}

export async function listDeliveries(db: DbLike, ctx: TenantContext, subscriptionId: string, limit = 50): Promise<WebhookOutboundDelivery[]> {
  requirePerm(ctx, "read");
  await getSubscription(db, ctx, subscriptionId);
  return db.select().from(webhookOutboundDeliveries).where(and(eq(webhookOutboundDeliveries.tenantId, ctx.tenantId), eq(webhookOutboundDeliveries.subscriptionId, subscriptionId))).orderBy(desc(webhookOutboundDeliveries.createdAt)).limit(limit);
}

/** Rotate the signing secret; returned once. */
export async function rotateSecret(db: DbLike, ctx: TenantContext, id: string): Promise<{ subscription: WebhookSubscription; secret: string }> {
  requirePerm(ctx, "integrations.manage");
  await getSubscription(db, ctx, id);
  const secret = `whsec_${newSecret()}`;
  const [row] = await db.update(webhookSubscriptions).set({ secretEnc: encryptJson({ secret }), secretHint: hint(secret), updatedAt: ctx.now() }).where(eq(webhookSubscriptions.id, id)).returning();
  await writeAudit(db, ctx, { entityType: "webhook_subscription", entityId: id, action: "secret_rotated" });
  if (!row) throw validation("subscription vanished");
  return { subscription: row, secret };
}
