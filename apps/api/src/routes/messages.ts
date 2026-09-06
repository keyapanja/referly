import { Hono } from "hono";
import { messaging } from "@referly/core";
import { requireMerchantPrincipal, type AppEnv } from "../lib/auth";

export function messageRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    requireMerchantPrincipal(c);
    await next();
  });
  r.get("/templates", async (c) => c.json({ templates: await messaging.listTemplates(c.get("deps").db, c.get("ctx")), variables: messaging.TEMPLATE_VARIABLES }));
  r.patch("/templates/:key", async (c) => c.json({ template: await messaging.updateTemplate(c.get("deps").db, c.get("ctx"), c.req.param("key") as messaging.TemplateKey, await c.req.json()) }));
  r.get("/log", async (c) => {
    const q = c.req.query();
    return c.json({ messages: await messaging.listMessageLogs(c.get("deps").db, c.get("ctx"), { affiliateId: q.affiliateId, limit: q.limit ? Number(q.limit) : undefined }) });
  });
  return r;
}
