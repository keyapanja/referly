import { Hono } from "hono";
import { z } from "zod";
import { affiliates, commissions, conversions, offers, payouts, tenants, tracking, programs as programsSvc, assets, campaigns, tiers, integrations, disputes, auth, privacy, forbidden, type Affiliate } from "@referly/core";
import { requireAffiliatePrincipal, SESSION_COOKIE, type AppEnv } from "../lib/auth";
import { getCookie } from "hono/cookie";
import { publicTenant } from "./auth";

/** Affiliate portal (PRD s5.1, s8, s16.2). Every handler is scoped to the signed-in affiliate. */
/** The affiliate's own record minus merchant-internal fields (notes, tags, provider references, application answers). */
function portalAffiliate(a: Affiliate) {
  const { notes: _n, tags: _t, payoutProfileRef: _p, applicationAnswers: _a, userId: _u, ...rest } = a;
  return rest;
}

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
    return c.json({ affiliate: portalAffiliate(affiliate), tenant: publicTenant(tenant), memberships, balances });
  });

  /** Home: earnings, activity and quick actions. */
  r.get("/home", async (c) => {
    const { db } = c.get("deps");
    const ctx = c.get("ctx");
    const affiliateId = requireAffiliatePrincipal(c);
    const [balances, clicks, recentConversions, links, codes, nextPayout, campaignRows] = await Promise.all([
      commissions.getBalances(db, ctx, affiliateId),
      tracking.listClicks(db, ctx, { affiliateId, limit: 1000 }),
      conversions.listConversions(db, ctx, { affiliateId, limit: 10 }),
      tracking.listTrackingLinks(db, ctx, affiliateId),
      tracking.listCouponCodes(db, ctx, affiliateId),
      payouts.listPayouts(db, ctx, { affiliateId, limit: 1 }),
      campaigns.listCampaignsForAffiliate(db, ctx, affiliateId),
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
      campaigns: campaignRows.map((r) => ({ id: r.campaign.id, name: r.campaign.name, live: r.campaign.live, endAt: r.campaign.endAt, participantStatus: r.participantStatus })),
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
    const programsOut = [];
    for (const p of programRows) {
      const membership = memberships.find((m) => m.programId === p.id) ?? null;
      const tier = await tiers.affiliateTierStatus(db, ctx, affiliateId, p.id);
      const rate = commissions.resolveRate(p, null, membership, null, tier.current);
      programsOut.push({
        id: p.id,
        name: p.name,
        commissionModel: p.commissionModel,
        commissionPercent: p.commissionRateBps / 100,
        commissionFixedMinor: p.commissionFixedMinor,
        holdingDays: p.holdingDays,
        termsVersion: p.termsVersion,
        /** What this affiliate actually earns today, after overrides and tiers (campaigns are shown separately). */
        effective: { model: rate.model, percent: rate.rateBps != null ? rate.rateBps / 100 : null, fixedMinor: rate.fixedMinor ?? null, source: rate.overrideSource, tierName: rate.tierName ?? null },
        tier: { current: tier.current ? { id: tier.current.id, name: tier.current.name, kind: tier.current.kind } : null, next: tier.next ? { name: tier.next.tier.name, metric: tier.next.tier.metric, remaining: tier.next.remaining, windowDays: tier.next.tier.windowDays } : null, metrics: tier.metrics },
      });
    }
    return c.json({
      programs: programsOut,
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
  r.get("/payouts", async (c) => {
    const { db } = c.get("deps");
    const ctx = c.get("ctx");
    const affiliateId = requireAffiliatePrincipal(c);
    const [rows, automated] = await Promise.all([payouts.listPayouts(db, ctx, { affiliateId }), integrations.automatedMethods(db, ctx)]);
    return c.json({ payouts: rows, automatedMethods: automated });
  });
  /** Stripe Connect Express onboarding for the affiliate's own account. */
  r.post("/payouts/connect/stripe", async (c) => {
    const { webUrl } = c.get("deps").config;
    const link = await integrations.startStripeOnboarding(c.get("deps").db, c.get("ctx"), requireAffiliatePrincipal(c), { returnUrl: `${webUrl}/portal/payouts?connected=stripe`, refreshUrl: `${webUrl}/portal/payouts?refresh=stripe` }, c.get("deps").payoutProviders);
    return c.json(link);
  });

  /** Campaigns the affiliate is invited to or active in (AST-05). */
  r.get("/campaigns", async (c) => c.json({ campaigns: await campaigns.listCampaignsForAffiliate(c.get("deps").db, c.get("ctx"), requireAffiliatePrincipal(c)) }));
  r.post("/campaigns/:id/join", async (c) => c.json({ participant: await campaigns.joinCampaign(c.get("deps").db, c.get("ctx"), c.req.param("id"), requireAffiliatePrincipal(c)) }));

  /** Disputes raised by (or about) this affiliate. */
  r.get("/disputes", async (c) => c.json({ disputes: await disputes.listDisputesForAffiliate(c.get("deps").db, c.get("ctx"), requireAffiliatePrincipal(c)) }));
  r.post("/disputes", async (c) => {
    requireAffiliatePrincipal(c);
    return c.json({ dispute: await disputes.openDispute(c.get("deps").db, c.get("ctx"), await c.req.json()) }, 201);
  });
  r.get("/disputes/:id", async (c) => c.json(await disputes.getDisputeForAffiliate(c.get("deps").db, c.get("ctx"), requireAffiliatePrincipal(c), c.req.param("id"))));
  r.post("/disputes/:id/comments", async (c) => {
    requireAffiliatePrincipal(c);
    const { body } = z.object({ body: z.string().min(1).max(5000) }).parse(await c.req.json());
    return c.json({ comment: await disputes.addComment(c.get("deps").db, c.get("ctx"), c.req.param("id"), body) }, 201);
  });
  r.post("/disputes/:id/withdraw", async (c) => {
    requireAffiliatePrincipal(c);
    return c.json({ dispute: await disputes.withdrawDispute(c.get("deps").db, c.get("ctx"), c.req.param("id")) });
  });

  /** AST-02: only assets permitted for this affiliate's programs. */
  r.get("/assets", async (c) => c.json({ assets: await assets.listAssetsForAffiliate(c.get("deps").db, c.get("ctx"), requireAffiliatePrincipal(c)) }));

  r.patch("/profile", async (c) => c.json({ affiliate: portalAffiliate(await affiliates.updateAffiliate(c.get("deps").db, c.get("ctx"), requireAffiliatePrincipal(c), await c.req.json())) }));
  r.put("/payout-profile", async (c) => c.json({ affiliate: portalAffiliate(await affiliates.setPayoutProfile(c.get("deps").db, c.get("ctx"), requireAffiliatePrincipal(c), await c.req.json())) }));
  /** Affiliates change their own password; every other session is signed out. */
  r.post("/password", async (c) => {
    const p = c.get("principal");
    if (p.kind !== "user") throw forbidden("sign in with a password to change it");
    const body = z.object({ currentPassword: z.string(), newPassword: z.string().min(8).max(256) }).parse(await c.req.json());
    const header = c.req.header("authorization");
    const keep = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : getCookie(c, SESSION_COOKIE);
    await auth.changePassword(c.get("deps").db, p.userId, { ...body, keepSessionToken: keep ?? undefined }, c.get("now")());
    return c.json({ ok: true });
  });
  /** The affiliate asks for their personal data to be deleted; the team gets a task and decides. */
  r.post("/erasure-request", async (c) => c.json({ task: await privacy.requestErasure(c.get("deps").db, c.get("ctx"), requireAffiliatePrincipal(c)) }, 202));
  r.post("/programs/:programId/join", async (c) => {
    const { acceptTerms } = z.object({ acceptTerms: z.boolean() }).parse(await c.req.json());
    return c.json({ membership: await affiliates.joinProgram(c.get("deps").db, c.get("ctx"), requireAffiliatePrincipal(c), c.req.param("programId"), acceptTerms) });
  });

  return r;
}
