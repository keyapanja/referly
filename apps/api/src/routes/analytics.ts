import { Hono } from "hono";
import { analytics, conversions, commissions, affiliates, payouts, exportsSvc, validation, campaigns, reporting } from "@referly/core";
import { requireMerchantPrincipal, type AppEnv } from "../lib/auth";

function period(c: { req: { query: (k: string) => string | undefined } }, now: Date) {
  const to = c.req.query("to") ? new Date(c.req.query("to")!) : now;
  const from = c.req.query("from") ? new Date(c.req.query("from")!) : new Date(to.getTime() - 30 * 86_400_000);
  return { from, to };
}

export function analyticsRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    requireMerchantPrincipal(c);
    await next();
  });
  r.get("/overview", async (c) => c.json(await analytics.overview(c.get("deps").db, c.get("ctx"), period(c, c.get("now")()))));
  r.get("/affiliates", async (c) => c.json({ rows: await analytics.byAffiliate(c.get("deps").db, c.get("ctx"), period(c, c.get("now")())) }));
  r.get("/offers", async (c) => c.json({ rows: await analytics.byOffer(c.get("deps").db, c.get("ctx"), period(c, c.get("now")())) }));
  r.get("/programs", async (c) => c.json({ rows: await analytics.byProgram(c.get("deps").db, c.get("ctx"), period(c, c.get("now")())) }));
  /** Phase 2 richer analytics: trends, comparison, funnel, groups. */
  r.get("/timeseries", async (c) => {
    const p = period(c, c.get("now")());
    const g = c.req.query("granularity") as reporting.Granularity | undefined;
    const granularity = g && ["day", "week", "month"].includes(g) ? g : reporting.autoGranularity(p);
    const current = await reporting.timeseries(c.get("deps").db, c.get("ctx"), p, granularity);
    const previous = c.req.query("compare") === "1" ? await reporting.timeseries(c.get("deps").db, c.get("ctx"), reporting.previousPeriod(p), granularity) : null;
    return c.json({ current, previous });
  });
  r.get("/compare", async (c) => c.json(await reporting.compare(c.get("deps").db, c.get("ctx"), period(c, c.get("now")()))));
  r.get("/funnel", async (c) => c.json(await reporting.funnel(c.get("deps").db, c.get("ctx"), period(c, c.get("now")()))));
  r.get("/groups", async (c) => c.json(await reporting.byGroup(c.get("deps").db, c.get("ctx"), period(c, c.get("now")()))));

  /** AN-05: campaign-period performance. */
  r.get("/campaigns", async (c) => c.json({ rows: await campaigns.listCampaigns(c.get("deps").db, c.get("ctx")) }));
  r.get("/sources", async (c) => c.json({ rows: await analytics.bySource(c.get("deps").db, c.get("ctx"), period(c, c.get("now")())) }));

  /** AN-07: async exports. Request → job builds the file → download while it is valid. */
  r.post("/exports", async (c) => c.json({ export: await exportsSvc.requestExport(c.get("deps").db, c.get("ctx"), await c.req.json()) }, 202));
  r.get("/exports", async (c) => c.json({ exports: await exportsSvc.listExports(c.get("deps").db, c.get("ctx")), entities: exportsSvc.EXPORT_ENTITIES }));
  r.get("/exports/:id", async (c) => c.json({ export: await exportsSvc.getExport(c.get("deps").db, c.get("ctx"), c.req.param("id")) }));
  r.get("/exports/:id/download", async (c) => {
    const record = await exportsSvc.getExport(c.get("deps").db, c.get("ctx"), c.req.param("id"));
    if (record.status !== "done" || !record.storageKey) throw validation(`export is ${record.status}`);
    if (record.expiresAt && record.expiresAt.getTime() < c.get("now")().getTime()) throw validation("export has expired; request a new one");
    const file = await c.get("deps").storage.get(record.storageKey);
    if (!file) throw validation("export file is no longer available");
    return new Response(file.data as unknown as BodyInit, {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${record.entity}-${record.createdAt.toISOString().slice(0, 10)}.csv"`, "cache-control": "private, no-store" },
    });
  });

  /** Synchronous export for small datasets (capped); the async endpoints above handle the rest. */
  r.get("/export/:entity", async (c) => {
    const { db } = c.get("deps");
    const ctx = c.get("ctx");
    const entity = c.req.param("entity");
    let rows: Record<string, unknown>[];
    switch (entity) {
      case "affiliates":
        rows = await affiliates.listAffiliates(db, ctx);
        break;
      case "conversions":
        rows = await conversions.listConversions(db, ctx, { limit: 10_000 });
        break;
      case "commissions":
        rows = await commissions.listCommissions(db, ctx, { limit: 10_000 });
        break;
      case "payouts":
        rows = await payouts.listPayouts(db, ctx, { limit: 10_000 });
        break;
      default:
        return c.json({ error: { code: "not_found", message: "unknown export" } }, 404);
    }
    const csv = exportsSvc.toCsv(rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !["passwordHash", "customerEmailHash", "applicationAnswers", "candidates", "calculationBasis", "metadata", "payoutProfileRef", "tenantId", "seq"].includes(k)).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v !== null && typeof v === "object" ? JSON.stringify(v) : v]))));
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="${entity}.csv"`);
    return c.body(csv);
  });
  return r;
}
