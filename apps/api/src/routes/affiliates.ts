import { Hono } from "hono";
import { z } from "zod";
import { affiliates, tracking, commissions, groups } from "@referly/core";
import { requireMerchantPrincipal, type AppEnv } from "../lib/auth";

export function affiliateRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    requireMerchantPrincipal(c);
    await next();
  });

  r.get("/", async (c) => c.json({ affiliates: await affiliates.listAffiliates(c.get("deps").db, c.get("ctx"), { status: c.req.query("status") as never }) }));
  r.post("/", async (c) => c.json({ affiliate: await affiliates.createAffiliate(c.get("deps").db, c.get("ctx"), await c.req.json()) }, 201));

  r.post("/invites", async (c) => {
    const invite = await affiliates.inviteAffiliate(c.get("deps").db, c.get("ctx"), await c.req.json());
    return c.json({ invite, acceptUrl: `${c.get("deps").config.webUrl}/invite/${invite.token}` }, 201);
  });

  /** AFF-06: profile + performance in one call. */
  r.get("/:id", async (c) => {
    const { db } = c.get("deps");
    const ctx = c.get("ctx");
    const id = c.req.param("id");
    const [affiliate, memberships, links, codes, balances, groupRows] = await Promise.all([
      affiliates.getAffiliate(db, ctx, id),
      affiliates.listMemberships(db, ctx, id),
      tracking.listTrackingLinks(db, ctx, id),
      tracking.listCouponCodes(db, ctx, id),
      commissions.getBalances(db, ctx, id),
      groups.groupsForAffiliate(db, ctx, id),
    ]);
    return c.json({ affiliate, memberships, links, codes, balances, groups: groupRows });
  });
  r.patch("/:id", async (c) => c.json({ affiliate: await affiliates.updateAffiliate(c.get("deps").db, c.get("ctx"), c.req.param("id"), await c.req.json()) }));

  const reasonBody = z.object({ reason: z.string().optional() });
  r.post("/:id/approve", async (c) => c.json({ affiliate: await affiliates.approveAffiliate(c.get("deps").db, c.get("ctx"), c.req.param("id"), reasonBody.parse(await c.req.json().catch(() => ({}))).reason) }));
  r.post("/:id/reject", async (c) => c.json({ affiliate: await affiliates.rejectAffiliate(c.get("deps").db, c.get("ctx"), c.req.param("id"), reasonBody.parse(await c.req.json().catch(() => ({}))).reason) }));
  r.post("/:id/suspend", async (c) => {
    const { reason } = z.object({ reason: z.string().min(1) }).parse(await c.req.json());
    return c.json({ affiliate: await affiliates.suspendAffiliate(c.get("deps").db, c.get("ctx"), c.req.param("id"), reason) });
  });
  r.post("/:id/reactivate", async (c) => c.json({ affiliate: await affiliates.reactivateAffiliate(c.get("deps").db, c.get("ctx"), c.req.param("id"), reasonBody.parse(await c.req.json().catch(() => ({}))).reason) }));

  r.post("/:id/coupons", async (c) => {
    const body = await c.req.json();
    return c.json({ coupon: await tracking.createCouponCode(c.get("deps").db, c.get("ctx"), { ...body, affiliateId: c.req.param("id") }) }, 201);
  });
  r.post("/:id/programs/:programId/override", async (c) => {
    const body = z.object({ commissionPercent: z.number().nullable().optional(), commissionFixedMinor: z.number().int().nullable().optional(), reason: z.string().min(1) }).parse(await c.req.json());
    return c.json({ membership: await affiliates.setAffiliateCommissionOverride(c.get("deps").db, c.get("ctx"), c.req.param("id"), c.req.param("programId"), body, body.reason) });
  });
  r.get("/:id/ledger", async (c) => c.json({ entries: await commissions.listLedger(c.get("deps").db, c.get("ctx"), c.req.param("id")) }));
  return r;
}
