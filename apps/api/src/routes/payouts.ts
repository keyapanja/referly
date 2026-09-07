import { Hono } from "hono";
import { z } from "zod";
import { payouts, integrations, affiliates as affiliatesSvc } from "@referly/core";
import { requireMerchantPrincipal, type AppEnv } from "../lib/auth";

export function payoutRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    requireMerchantPrincipal(c);
    await next();
  });

  r.get("/", async (c) => {
    const q = c.req.query();
    const { db } = c.get("deps");
    const ctx = c.get("ctx");
    const [rows, connected] = await Promise.all([payouts.listPayouts(db, ctx, { affiliateId: q.affiliateId, status: q.status as never }), integrations.connectedProviders(db, ctx)]);
    const affiliateIds = [...new Set(rows.map((p) => p.affiliateId))];
    const affs = await Promise.all(affiliateIds.map((id) => affiliatesSvc.getAffiliate(db, ctx, id)));
    const byId = new Map(affs.map((a) => [a.id, a]));
    return c.json({
      connectedProviders: connected,
      payouts: rows.map((p) => {
        const a = byId.get(p.affiliateId);
        const provider = a?.payoutMethod ? integrations.PROVIDER_FOR_METHOD[a.payoutMethod] : undefined;
        return { ...p, affiliateName: a?.name ?? null, payoutMethod: a?.payoutMethod ?? null, canSend: p.status === "draft" && !!provider && connected.includes(provider) && !!a?.payoutProfileRef, providerId: provider ?? null };
      }),
    });
  });
  /** Provider-driven payouts: queue one draft, or every draft that can be automated. */
  r.post("/send-all", async (c) => c.json(await integrations.queueAllDraftPayouts(c.get("deps").db, c.get("ctx"))));
  r.post("/:id/send", async (c) => c.json({ payout: await integrations.queueProviderPayout(c.get("deps").db, c.get("ctx"), c.req.param("id")) }));
  r.get("/payable/:affiliateId", async (c) => c.json(await payouts.getPayableSummary(c.get("deps").db, c.get("ctx"), c.req.param("affiliateId"))));
  r.post("/", async (c) => c.json({ payout: await payouts.createPayoutBatch(c.get("deps").db, c.get("ctx"), await c.req.json()) }, 201));
  r.post("/batch-all", async (c) => c.json({ payouts: await payouts.createPayoutBatchesForAll(c.get("deps").db, c.get("ctx")) }, 201));
  r.post("/external", async (c) => {
    const body = z.object({ affiliateId: z.string(), externalReference: z.string().min(1), method: z.string().optional(), paidAt: z.coerce.date().optional() }).parse(await c.req.json());
    return c.json({ payout: await payouts.recordExternalPayout(c.get("deps").db, c.get("ctx"), body) }, 201);
  });
  r.get("/:id", async (c) => c.json(await payouts.reconcilePayout(c.get("deps").db, c.get("ctx"), c.req.param("id"))));
  r.post("/:id/processing", async (c) => c.json({ payout: await payouts.markPayoutProcessing(c.get("deps").db, c.get("ctx"), c.req.param("id")) }));
  r.post("/:id/paid", async (c) => {
    const body = z.object({ externalReference: z.string().optional(), paidAt: z.coerce.date().optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json({ payout: await payouts.markPayoutPaid(c.get("deps").db, c.get("ctx"), c.req.param("id"), body) });
  });
  r.post("/:id/failed", async (c) => {
    const { reason } = z.object({ reason: z.string().min(1) }).parse(await c.req.json());
    return c.json({ payout: await payouts.markPayoutFailed(c.get("deps").db, c.get("ctx"), c.req.param("id"), reason) });
  });
  r.post("/:id/cancel", async (c) => {
    const { reason } = z.object({ reason: z.string().min(1) }).parse(await c.req.json());
    return c.json({ payout: await payouts.cancelPayout(c.get("deps").db, c.get("ctx"), c.req.param("id"), reason) });
  });
  return r;
}
