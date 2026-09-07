import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { clickFor, closeDb, createActiveAffiliate, createWorkspace, getDb, makeClock, type Workspace } from "./helpers";
import * as webhooks from "../src/services/webhooks";
import * as conversions from "../src/services/conversions";
import * as automation from "../src/services/automation";
import type { DomainEvent } from "../src/services/events";
import { jobs as jobsTable, webhookSubscriptions, type Affiliate } from "../src/db/schema";

let db: Db;
const clock = makeClock();
let ws: Workspace;
let alice: Affiliate;

type Captured = { url: string; headers: Record<string, string>; body: string };
function stubFetch(status: number | (() => number), bodyText = "ok") {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) h[k.toLowerCase()] = v;
    calls.push({ url: String(url), headers: h, body: String(init?.body ?? "") });
    const s = typeof status === "function" ? status() : status;
    return new Response(bodyText, { status: s });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function lastEvent(type: string): Promise<DomainEvent> {
  const rows = await db.select().from(jobsTable).where(eq(jobsTable.type, "domain_event"));
  const ev = rows.map((r) => r.payload as unknown as DomainEvent).filter((e) => e.type === type && e.tenantId === ws.tenant.id).pop();
  if (!ev) throw new Error(`no ${type}`);
  return ev;
}

beforeAll(async () => {
  db = await getDb();
  ws = await createWorkspace(db, clock);
  alice = await createActiveAffiliate(db, ws, "Alice");
});
afterAll(closeDb);

describe("outbound webhooks", () => {
  let salesHook: string;
  let allHook: string;
  let secret: string;

  it("subscriptions are validated, secrets are returned once and stored encrypted", async () => {
    await expect(webhooks.createSubscription(db, ws.ctx, { url: "ftp://nope", events: ["*"] })).rejects.toThrow();
    await expect(webhooks.createSubscription(db, ws.ctx, { url: "https://hooks.example.com/a", events: ["not.an.event" as never] })).rejects.toThrow();
    const a = await webhooks.createSubscription(db, ws.ctx, { url: "https://hooks.example.com/sales", events: ["conversion.created"], description: "Sales sheet" });
    salesHook = a.subscription.id;
    secret = a.secret;
    expect(secret).toMatch(/^whsec_/);
    expect(a.subscription.secretHint).toBe(`whsec_…${secret.slice(-4)}`);
    expect(a.subscription.secretEnc).not.toContain(secret.slice(6, 20));
    const b = await webhooks.createSubscription(db, ws.ctx, { url: "https://hooks.example.com/all", events: ["*"] });
    allHook = b.subscription.id;
    const paused = await webhooks.createSubscription(db, ws.ctx, { url: "https://hooks.example.com/paused", events: ["*"] });
    await webhooks.updateSubscription(db, ws.ctx, paused.subscription.id, { status: "paused" });
    const list = await webhooks.listSubscriptions(db, ws.ctx);
    expect(list.map((s) => s.status).sort()).toEqual(["active", "active", "paused"]);
    expect(JSON.stringify(list)).not.toContain("secretEnc");
    const other = await createWorkspace(db, clock);
    expect(await webhooks.listSubscriptions(db, other.ctx)).toEqual([]);
    await expect(webhooks.getSubscription(db, other.ctx, salesHook)).rejects.toMatchObject({ code: "not_found" });
  });

  it("fan-out creates one delivery per active matching subscription, delivered with a valid signature", async () => {
    const click = await clickFor(db, ws, alice, clock);
    const sale = await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "hook-1", offerId: ws.offer.id, amountMinor: 42_000, clickToken: click.token });
    const event = await lastEvent("conversion.created");
    const deliveries = await webhooks.fanOut(db, ws.ctx, event);
    expect(deliveries.map((d) => d.subscriptionId).sort()).toEqual([salesHook, allHook].sort());
    expect(await webhooks.fanOut(db, ws.ctx, { ...event, type: "click.recorded" } as DomainEvent)).toEqual([]); // not an exposed event
    const jobs = await db.select().from(jobsTable).where(eq(jobsTable.type, "deliver_webhook"));
    expect(jobs.length).toBeGreaterThanOrEqual(2);

    const { fetchImpl, calls } = stubFetch(200);
    const d = deliveries.find((x) => x.subscriptionId === salesHook)!;
    const done = await webhooks.deliver(db, ws.ctx, d.id, { fetchImpl, attempt: 1, maxAttempts: 8 });
    expect(done).toMatchObject({ status: "delivered", attempts: 1, responseStatus: 200 });
    const call = calls[0]!;
    expect(call.url).toBe("https://hooks.example.com/sales");
    expect(call.headers["x-referly-event"]).toBe("conversion.created");
    expect(call.headers["x-referly-delivery"]).toBe(d.id);
    const body = JSON.parse(call.body);
    expect(body).toMatchObject({ id: d.id, type: "conversion.created" });
    expect(body.data.conversion).toMatchObject({ externalOrderId: "hook-1", amountMinor: 42_000, affiliateId: alice.id });
    expect(body.data.affiliate).toMatchObject({ id: alice.id, name: "Alice" });
    expect(body.data.commission?.id).toBe(sale.commission!.id);
    expect(JSON.stringify(body)).not.toContain("passwordHash");
    expect(webhooks.verifySignature(secret, call.headers["x-referly-timestamp"]!, call.body, call.headers["x-referly-signature"]!, 300, clock.now().getTime())).toBe(true);
    expect(webhooks.verifySignature("whsec_wrong", call.headers["x-referly-timestamp"]!, call.body, call.headers["x-referly-signature"]!, 300, clock.now().getTime())).toBe(false);
    // idempotent: delivering again does nothing
    expect((await webhooks.deliver(db, ws.ctx, d.id, { fetchImpl })).status).toBe("delivered");
    expect(calls).toHaveLength(1);
    expect((await webhooks.listSubscriptions(db, ws.ctx)).find((s) => s.id === salesHook)).toMatchObject({ lastStatus: "delivered", consecutiveFailures: 0, stats: { delivered: 1, dead: 0 } });
  });

  it("failures retry, die on the final attempt, and disable the endpoint after a streak; redelivery and ping work", async () => {
    const event = await lastEvent("conversion.created");
    const failing = stubFetch(503, "busy");
    // first attempt of a fresh delivery: throws so the job retries
    let [d] = await webhooks.fanOut(db, ws.ctx, { ...event, occurredAt: new Date().toISOString() });
    await expect(webhooks.deliver(db, ws.ctx, d!.id, { fetchImpl: failing.fetchImpl, attempt: 1, maxAttempts: 8 })).rejects.toThrow(/503/);
    let row = (await webhooks.listDeliveries(db, ws.ctx, salesHook)).find((x) => x.id === d!.id)!;
    expect(row).toMatchObject({ status: "failed", attempts: 1, responseStatus: 503, responseBody: "busy" });
    // final attempt: dead, streak 1
    row = await webhooks.deliver(db, ws.ctx, d!.id, { fetchImpl: failing.fetchImpl, attempt: 8, maxAttempts: 8 });
    expect(row.status).toBe("dead");
    expect((await webhooks.getSubscription(db, ws.ctx, salesHook)).consecutiveFailures).toBe(1);

    // four more dead deliveries → auto-disabled with a task
    for (let i = 0; i < 4; i++) {
      const [x] = await webhooks.fanOut(db, ws.ctx, { ...event, occurredAt: new Date(Date.now() + i).toISOString() });
      await webhooks.deliver(db, ws.ctx, x!.id, { fetchImpl: failing.fetchImpl, attempt: 8, maxAttempts: 8 });
    }
    const sub = await webhooks.getSubscription(db, ws.ctx, salesHook);
    expect(sub).toMatchObject({ status: "disabled", consecutiveFailures: 5 });
    expect((await automation.listTasks(db, ws.ctx, { status: "open" })).some((t) => t.entityId === salesHook)).toBe(true);
    // disabled endpoints get no new deliveries, and pending ones die quietly
    expect((await webhooks.fanOut(db, ws.ctx, event)).map((x) => x.subscriptionId)).toEqual([allHook]);

    // resuming clears the streak; redelivery of a dead delivery succeeds
    await webhooks.updateSubscription(db, ws.ctx, salesHook, { status: "active" });
    expect((await webhooks.getSubscription(db, ws.ctx, salesHook)).consecutiveFailures).toBe(0);
    const ok = stubFetch(200);
    const again = await webhooks.redeliver(db, ws.ctx, d!.id);
    expect(again.status).toBe("pending");
    expect((await webhooks.deliver(db, ws.ctx, again.id, { fetchImpl: ok.fetchImpl, attempt: 1 })).status).toBe("delivered");
    expect((JSON.parse(ok.calls[0]!.body) as { redeliveryOf?: string }).redeliveryOf).toBe(d!.id);

    // ping
    const ping = await webhooks.testSubscription(db, ws.ctx, salesHook, { fetchImpl: ok.fetchImpl });
    expect(ping.ok).toBe(true);
    expect(JSON.parse(ok.calls[1]!.body).type).toBe("ping");
    const timeout = stubFetch(() => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const failedPing = await webhooks.testSubscription(db, ws.ctx, salesHook, { fetchImpl: timeout.fetchImpl });
    expect(failedPing).toMatchObject({ ok: false, error: "timed out" });

    // rotate + delete
    const rotated = await webhooks.rotateSecret(db, ws.ctx, salesHook);
    expect(rotated.secret).not.toBe(secret);
    await webhooks.deleteSubscription(db, ws.ctx, salesHook);
    expect(await db.query.webhookSubscriptions.findFirst({ where: eq(webhookSubscriptions.id, salesHook) })).toBeUndefined();
  });
});
