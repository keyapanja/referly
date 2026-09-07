import { Hono } from "hono";
import { z } from "zod";
import { disputes } from "@referly/core";
import { requireMerchantPrincipal, type AppEnv } from "../lib/auth";

/** Disputes (Phase 2): merchant side. */
export function disputeRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    requireMerchantPrincipal(c);
    await next();
  });
  r.get("/", async (c) => {
    const q = c.req.query();
    return c.json({ disputes: await disputes.listDisputes(c.get("deps").db, c.get("ctx"), { status: q.status as disputes.DisputeStatus | undefined, affiliateId: q.affiliateId }) });
  });
  r.post("/", async (c) => c.json({ dispute: await disputes.openDispute(c.get("deps").db, c.get("ctx"), await c.req.json()) }, 201));
  r.get("/:id", async (c) => c.json(await disputes.getDisputeDetail(c.get("deps").db, c.get("ctx"), c.req.param("id"))));
  r.post("/:id/comments", async (c) => {
    const { body } = z.object({ body: z.string().min(1).max(5000) }).parse(await c.req.json());
    return c.json({ comment: await disputes.addComment(c.get("deps").db, c.get("ctx"), c.req.param("id"), body) }, 201);
  });
  r.post("/:id/review", async (c) => c.json({ dispute: await disputes.startReview(c.get("deps").db, c.get("ctx"), c.req.param("id")) }));
  r.post("/:id/link", async (c) => {
    const { conversionId } = z.object({ conversionId: z.string() }).parse(await c.req.json());
    return c.json({ dispute: await disputes.linkConversion(c.get("deps").db, c.get("ctx"), c.req.param("id"), conversionId) });
  });
  r.post("/:id/resolve", async (c) => c.json({ dispute: await disputes.resolveDispute(c.get("deps").db, c.get("ctx"), c.req.param("id"), await c.req.json()) }));
  return r;
}
