import { Hono } from "hono";
import { webhooks } from "@referly/core";
import { requireMerchantPrincipal, type AppEnv } from "../lib/auth";

/** Outbound webhooks for Zapier, Make and custom integrations. */
export function webhookRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    requireMerchantPrincipal(c);
    await next();
  });
  r.get("/events", (c) => c.json({ events: webhooks.WEBHOOK_EVENTS }));
  r.get("/", async (c) => c.json({ subscriptions: await webhooks.listSubscriptions(c.get("deps").db, c.get("ctx")) }));
  r.post("/", async (c) => {
    const { subscription, secret } = await webhooks.createSubscription(c.get("deps").db, c.get("ctx"), await c.req.json());
    return c.json({ subscription: webhooks.publicSubscription(subscription), secret }, 201);
  });
  r.patch("/:id", async (c) => c.json({ subscription: webhooks.publicSubscription(await webhooks.updateSubscription(c.get("deps").db, c.get("ctx"), c.req.param("id"), await c.req.json())) }));
  r.delete("/:id", async (c) => {
    await webhooks.deleteSubscription(c.get("deps").db, c.get("ctx"), c.req.param("id"));
    return c.json({ ok: true });
  });
  r.post("/:id/rotate-secret", async (c) => {
    const { subscription, secret } = await webhooks.rotateSecret(c.get("deps").db, c.get("ctx"), c.req.param("id"));
    return c.json({ subscription: webhooks.publicSubscription(subscription), secret });
  });
  r.post("/:id/test", async (c) => {
    const { delivery, ...result } = await webhooks.testSubscription(c.get("deps").db, c.get("ctx"), c.req.param("id"), { fetchImpl: c.get("deps").webhookFetch });
    return c.json({ ...result, deliveryId: delivery.id });
  });
  r.get("/:id/deliveries", async (c) => c.json({ deliveries: await webhooks.listDeliveries(c.get("deps").db, c.get("ctx"), c.req.param("id"), Number(c.req.query("limit") ?? 50)) }));
  r.post("/deliveries/:deliveryId/redeliver", async (c) => c.json({ delivery: await webhooks.redeliver(c.get("deps").db, c.get("ctx"), c.req.param("deliveryId")) }));
  return r;
}
