import { Hono } from "hono";
import { z } from "zod";
import { affiliates, commissions, conversions, offers, payouts, tenants, tracking, programs as programsSvc } from "@referly/core";
import { requireAffiliatePrincipal, type AppEnv } from "../lib/auth";
import { publicTenant } from "./auth";

/** Affiliate portal (PRD s5.1, s8, s16.2). Every handler is scoped to the signed-in affiliate. */
export function portalRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/me", async (c) => {
    const { db } = c.get("deps");
    const ctx = c.get("ctx");
    const affiliateId = requireAffiliatePrincipal(c);
    const [affiliate, tenant, memberships, balances] = await Promise.all([
      affiliates.getAffiliate(db, ctx, affiliateId),
      tenants.getTenant(db, ctx),
      affiliates.listMemberships(db, ctx, affiliateId),
      commissions.getBalances(db, ctx, affiliateId),
    ]);
    return c.json({ affiliate, tenant: publicTenant(tenant), memberships, balances });
  });

  /** Home: earnings, activity and quick actions. */
  r.get("/home", async (c) => {
    const { db } = c.get("deps");
    const ctx = c.get("ctx");
    const affiliateId = requireAffiliatePrincipal(c);
    const [balances, clicks, recentConversions, links, codes, nextPayout] = await Promise.all([
      commissions.getBalances(db, ctx, affiliateId),
      tracking.listClicks(db, ctx, { affiliateId, limit: 1000 }),
      conversions.listConversions(db, ctx, { affiliateId, limit: 10 }),
      tracking.listTrackingLinks(db, ctx, affiliateId),
      tracking.listCouponCodes(db, ctx, affiliateId),
      payouts.listPayouts(db, ctx, { affiliateId, limit: 1 }),
    ]);
    const allConversions = await conversions.listConversions(db, ctx, { affiliateId, limit: 10_000 });
    const valid = allConversions.filter((x) => x.status !== "cancelled" && x.status !== "reversed");
    const revenueMinor = valid.reduce((s, x) => s + x.amountMinor - x.refundedAmountMinor, 0);
    return c.json({
      balances,
      metrics: {
        clicks: clicks.length,
        conversions: valid.length,
        revenueMinor,
        conversionRate: clicks.length ? Number((valid.length / clicks.length).toFixed(4)) : 0,
      },
      recentConversions,
      links: links.map((l) => ({ ...l, url: tracking.trackingUrl(c.get("deps").config.baseUrl, l) })),
      codes,
      lastPayout: nextPayout[0] ?? null,
    });
  });

  /** Eligible offers/programs the affiliate can promote. */
  r.get("/offers", async (c) => {
    const { db } = c.get("deps");
    const ctx = c.get("ctx");
    const affiliateId = requireAffiliatePrincipal(c);
    const memberships = (await affiliates.listMemberships(db, ctx, affiliateId)).filter((m) => m.status === "active");
    const programIds = memberships.map((m) => m.programId);
    const [rows, programRows] = await Promise.all([offers.listOffersForPrograms(db, ctx, programIds), Promise.all(programIds.map((id) => programsSvc.getProgram(db, ctx, id)))]);
    return c.json({
      programs: programRows.map((p) => ({ id: p.id, name: p.name, commissionModel: p.commissionModel, commissionPercent: p.commissionRateBps / 100, commissionFixedMinor: p.commissionFixedMinor, holdingDays: p.holdingDays, termsVersion: p.termsVersion })),
      offers: rows.map((o) => ({ id: o.id, programId: o.programId, name: o.name, shortDescription: o.shortDescription, priceMinor: o.priceMinor, currency: o.currency, imageUrl: o.imageUrl, salesUrl: o.salesUrl })),
    });
  });

  r.get("/links", async (c) => {
    const affiliateId = requireAffiliatePrincipal(c);
    const links = await tracking.listTrackingLinks(c.get("deps").db, c.get("ctx"), affiliateId);
    return c.json({ links: links.map((l) => ({ ...l, url: tracking.trackingUrl(c.get("deps").config.baseUrl, l) })) });
  });
  r.post("/links", async (c) => {
    const affiliateId = requireAffiliatePrincipal(c);
    const body = z.object({ programId: z.string(), offerId: z.string(), label: z.string().max(60).optional(), destinationUrl: z.string().url().optional() }).parse(await c.req.json());
    const link = await tracking.createTrackingLink(c.get("deps").db, c.get("ctx"), { ...body, affiliateId });
    return c.json({ link: { ...link, url: tracking.trackingUrl(c.get("deps").config.baseUrl, link) } }, 201);
  });
  r.get("/codes", async (c) => c.json({ codes: await tracking.listCouponCodes(c.get("deps").db, c.get("ctx"), requireAffiliatePrincipal(c)) }));

  r.get("/conversions", async (c) => c.json({ conversions: await conversions.listConversions(c.get("deps").db, c.get("ctx"), { affiliateId: requireAffiliatePrincipal(c) }) }));
  r.get("/commissions", async (c) => c.json({ commissions: await commissions.listCommissions(c.get("deps").db, c.get("ctx"), { affiliateId: requireAffiliatePrincipal(c) }) }));
  r.get("/earnings", async (c) => {
    const affiliateId = requireAffiliatePrincipal(c);
    const q = c.req.query();
    const from = q.from ? new Date(q.from) : new Date(0);
    const to = q.to ? new Date(q.to) : c.get("now")();
    return c.json(await commissions.commissionStatement(c.get("deps").db, c.get("ctx"), affiliateId, { from, to }));
  });
  r.get("/payouts", async (c) => c.json({ payouts: await payouts.listPayouts(c.get("deps").db, c.get("ctx"), { affiliateId: requireAffiliatePrincipal(c) }) }));

  r.patch("/profile", async (c) => c.json({ affiliate: await affiliates.updateAffiliate(c.get("deps").db, c.get("ctx"), requireAffiliatePrincipal(c), await c.req.json()) }));
  r.put("/payout-profile", async (c) => c.json({ affiliate: await affiliates.setPayoutProfile(c.get("deps").db, c.get("ctx"), requireAffiliatePrincipal(c), await c.req.json()) }));
  r.post("/programs/:programId/join", async (c) => {
    const { acceptTerms } = z.object({ acceptTerms: z.boolean() }).parse(await c.req.json());
    return c.json({ membership: await affiliates.joinProgram(c.get("deps").db, c.get("ctx"), requireAffiliatePrincipal(c), c.req.param("programId"), acceptTerms) });
  });

  return r;
}
