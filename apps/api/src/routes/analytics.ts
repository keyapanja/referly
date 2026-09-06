import { Hono } from "hono";
import { analytics, conversions, commissions, affiliates, payouts } from "@referly/core";
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
  r.get("/sources", async (c) => c.json({ rows: await analytics.bySource(c.get("deps").db, c.get("ctx"), period(c, c.get("now")())) }));

  /** AN-07: CSV export. Small datasets stream inline; large ones belong on the job queue (Phase 2). */
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
    const csv = toCsv(rows);
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="${entity}.csv"`);
    return c.body(csv);
  });
  return r;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]!).filter((k) => !["passwordHash", "customerEmailHash", "applicationAnswers", "candidates", "calculationBasis", "metadata"].includes(k));
  const esc = (v: unknown) => {
    const s = v == null ? "" : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((k) => esc(r[k])).join(","))].join("\n");
}
