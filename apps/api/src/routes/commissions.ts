import { Hono } from "hono";
import { z } from "zod";
import { commissions } from "@referly/core";
import { requireMerchantPrincipal, type AppEnv } from "../lib/auth";

export function commissionRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    requireMerchantPrincipal(c);
    await next();
  });

  r.get("/", async (c) => {
    const q = c.req.query();
    return c.json({ commissions: await commissions.listCommissions(c.get("deps").db, c.get("ctx"), { affiliateId: q.affiliateId, status: q.status as never, programId: q.programId, limit: q.limit ? Number(q.limit) : undefined }) });
  });
  r.get("/:id", async (c) => c.json({ commission: await commissions.getCommission(c.get("deps").db, c.get("ctx"), c.req.param("id")) }));
  r.post("/:id/approve", async (c) => {
    const body = z.object({ reason: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json({ commission: await commissions.approveCommission(c.get("deps").db, c.get("ctx"), c.req.param("id"), body.reason) });
  });
  r.post("/:id/reverse", async (c) => {
    const { reason } = z.object({ reason: z.string().min(1) }).parse(await c.req.json());
    return c.json({ commission: await commissions.reverseCommission(c.get("deps").db, c.get("ctx"), c.req.param("id"), reason) });
  });
  /** COMM-05 */
  r.post("/adjustments", async (c) => {
    const body = z.object({ affiliateId: z.string(), amountMinor: z.number().int(), currency: z.string().length(3), reason: z.string().min(1), commissionId: z.string().optional() }).parse(await c.req.json());
    return c.json({ entry: await commissions.adjustAffiliateBalance(c.get("deps").db, c.get("ctx"), body) }, 201);
  });
  /** Manual trigger for the holding-period settlement the worker also runs on a schedule. */
  r.post("/settle", async (c) => c.json({ settled: await commissions.settleHoldingPeriods(c.get("deps").db, c.get("ctx"), c.get("now")()) }));
  r.get("/affiliates/:affiliateId/balances", async (c) => c.json({ balances: await commissions.getBalances(c.get("deps").db, c.get("ctx"), c.req.param("affiliateId")) }));
  return r;
}
