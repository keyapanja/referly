import { Hono } from "hono";
import { leads } from "@referly/core";
import { requireMerchantPrincipal, type AppEnv } from "../lib/auth";

/**
 * Leads (pay-per-lead programs): intake from API keys and the app, the review queue, and
 * qualification. The public capture endpoint for merchant-site forms lives in public.ts.
 */
export function leadRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    requireMerchantPrincipal(c);
    await next();
  });

  r.get("/", async (c) => {
    const q = c.req.query();
    const [rows, summary] = await Promise.all([
      leads.listLeads(c.get("deps").db, c.get("ctx"), { programId: q.programId, affiliateId: q.affiliateId, disposition: (q.disposition || undefined) as never, limit: q.limit ? Number(q.limit) : undefined }),
      leads.leadSummary(c.get("deps").db, c.get("ctx")),
    ]);
    return c.json({ leads: rows, summary });
  });

  /** Intake. API keys default to source `webhook`; the app records `manual` leads with a reason when attributing by hand. */
  r.post("/", async (c) => {
    const body = await c.req.json();
    const principal = c.get("principal");
    const source = body.source ?? (principal.kind === "api_key" ? "webhook" : "manual");
    const result = await leads.recordLead(c.get("deps").db, c.get("ctx"), { ...body, source });
    return c.json(result, result.duplicate ? 200 : 201);
  });

  r.get("/:id", async (c) => {
    const rows = await leads.listLeads(c.get("deps").db, c.get("ctx"), { limit: 1000 });
    const row = rows.find((x) => x.lead.id === c.req.param("id"));
    if (!row) return c.json({ error: { code: "not_found", message: `lead ${c.req.param("id")} not found` } }, 404);
    return c.json(row);
  });
  r.post("/:id/qualify", async (c) => c.json({ lead: await leads.qualifyLead(c.get("deps").db, c.get("ctx"), c.req.param("id"), await c.req.json().catch(() => ({}))) }));
  r.post("/:id/disqualify", async (c) => c.json({ lead: await leads.disqualifyLead(c.get("deps").db, c.get("ctx"), c.req.param("id"), await c.req.json()) }));
  return r;
}
