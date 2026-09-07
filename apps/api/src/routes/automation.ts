import { Hono } from "hono";
import { z } from "zod";
import { automation } from "@referly/core";
import { requireMerchantPrincipal, type AppEnv } from "../lib/auth";

/** Rules & automation (AUTO-01..06) and the tasks rules can create. */
export function automationRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    requireMerchantPrincipal(c);
    await next();
  });
  r.get("/catalog", (c) => c.json(automation.CATALOG));
  r.get("/rules", async (c) => c.json({ rules: await automation.listRules(c.get("deps").db, c.get("ctx")) }));
  r.post("/rules", async (c) => c.json({ rule: await automation.createRule(c.get("deps").db, c.get("ctx"), await c.req.json()) }, 201));
  r.get("/rules/:id", async (c) => {
    const rule = await automation.getRule(c.get("deps").db, c.get("ctx"), c.req.param("id"));
    return c.json({ rule: { ...rule, stop: rule.stopConditions[0] ?? {} } });
  });
  r.patch("/rules/:id", async (c) => c.json({ rule: await automation.updateRule(c.get("deps").db, c.get("ctx"), c.req.param("id"), await c.req.json()) }));
  r.post("/rules/:id/enabled", async (c) => {
    const { enabled, reason } = z.object({ enabled: z.boolean(), reason: z.string().optional() }).parse(await c.req.json());
    return c.json({ rule: await automation.setRuleEnabled(c.get("deps").db, c.get("ctx"), c.req.param("id"), enabled, reason) });
  });
  r.get("/rules/:id/runs", async (c) => c.json({ runs: await automation.listRuns(c.get("deps").db, c.get("ctx"), c.req.param("id"), Number(c.req.query("limit") ?? 100)) }));

  r.get("/tasks", async (c) => c.json({ tasks: await automation.listTasks(c.get("deps").db, c.get("ctx"), { status: c.req.query("status") as "open" | "done" | undefined }) }));
  r.post("/tasks/:id/done", async (c) => c.json({ task: await automation.completeTask(c.get("deps").db, c.get("ctx"), c.req.param("id")) }));
  return r;
}
