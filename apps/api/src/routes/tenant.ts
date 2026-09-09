import { Hono } from "hono";
import { z } from "zod";
import { tenants, auth, audit, account, plans, integrations, retention, journeys, MERCHANT_ROLES, API_KEY_SCOPES, forbidden } from "@referly/core";
import { installSnippet, SNIPPET_EXAMPLES } from "../snippet";
import { getCookie } from "hono/cookie";
import { requireMerchantPrincipal, SESSION_COOKIE, type AppEnv } from "../lib/auth";
import { publicUser } from "./auth";

export function tenantRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    requireMerchantPrincipal(c);
    await next();
  });

  r.get("/", async (c) => c.json({ tenant: await tenants.getTenant(c.get("deps").db, c.get("ctx")) }));
  r.patch("/", async (c) => c.json({ tenant: await tenants.updateTenant(c.get("deps").db, c.get("ctx"), await c.req.json()) }));

  r.get("/me", async (c) => {
    const p = c.get("principal");
    const { db } = c.get("deps");
    const tenant = await tenants.getTenant(db, c.get("ctx"));
    const user = p.kind === "user" ? await auth.resolveUserById(db, p.userId) : null;
    return c.json({
      principal: p,
      user: user ? publicUser(user) : null,
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, currency: tenant.currency, timezone: tenant.timezone, logoUrl: tenant.logoUrl, branding: tenant.branding },
    });
  });

  r.post("/me/resend-verification", async (c) => {
    const p = c.get("principal");
    if (p.kind !== "user") return c.json({ ok: false }, 400);
    const user = await auth.resolveUserById(c.get("deps").db, p.userId);
    if (user) await account.requestEmailVerification(c.get("deps").db, c.get("ctx"), user);
    return c.json({ ok: true });
  });

  /** PRD s19: plan, usage against limits, and warnings. */
  r.get("/billing", async (c) => {
    const summary = await plans.getBillingSummary(c.get("deps").db, c.get("ctx"));
    return c.json({ ...summary, supportEmail: c.get("deps").config.supportEmail ?? null, plans: Object.values(plans.PLANS).map((p) => ({ id: p.id, name: p.name, description: p.description, limits: p.limits, features: p.features })) });
  });

  /** Payout providers (PRD s14): credentials are verified with the provider and stored encrypted. */
  r.get("/integrations", async (c) => c.json({ integrations: await integrations.listIntegrations(c.get("deps").db, c.get("ctx")), providers: integrations.PROVIDER_FOR_METHOD }));
  r.post("/integrations/:provider", async (c) => {
    const { credentials } = z.object({ credentials: z.record(z.string(), z.unknown()) }).parse(await c.req.json());
    const provider = c.req.param("provider");
    const row =
      provider === "twilio"
        ? await integrations.connectTextProvider(c.get("deps").db, c.get("ctx"), provider, credentials, c.get("deps").text)
        : await integrations.connectPayoutProvider(c.get("deps").db, c.get("ctx"), provider as integrations.PayoutProviderId, credentials, c.get("deps").payoutProviders);
    return c.json({ integration: integrations.publicIntegration(row) }, 201);
  });
  r.delete("/integrations/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (provider === "twilio") await integrations.disconnectTextProvider(c.get("deps").db, c.get("ctx"), provider);
    else await integrations.disconnectPayoutProvider(c.get("deps").db, c.get("ctx"), provider as integrations.PayoutProviderId);
    return c.json({ ok: true });
  });
  /** Where to point Twilio's messaging webhooks for this workspace. */
  r.get("/integrations/twilio/webhooks", async (c) => {
    const base = `${c.get("deps").config.baseUrl}/hooks/twilio/${c.get("ctx").tenantId}`;
    return c.json({ inboundUrl: `${base}/inbound`, statusUrl: `${base}/status` });
  });

  r.get("/team", async (c) => c.json({ users: (await tenants.listTeam(c.get("deps").db, c.get("ctx"))).map(publicUser) }));
  r.post("/team", async (c) => c.json({ user: publicUser(await tenants.addTeamMember(c.get("deps").db, c.get("ctx"), await c.req.json())) }, 201));
  r.patch("/team/:userId/role", async (c) => {
    const { role } = z.object({ role: z.enum(MERCHANT_ROLES) }).parse(await c.req.json());
    return c.json({ user: publicUser(await tenants.changeUserRole(c.get("deps").db, c.get("ctx"), c.req.param("userId"), role)) });
  });

  /** Merchant users change their own password; every other session is signed out. */
  r.post("/me/password", async (c) => {
    const p = c.get("principal");
    if (p.kind !== "user") throw forbidden("API keys have no password");
    const body = z.object({ currentPassword: z.string(), newPassword: z.string().min(8).max(256) }).parse(await c.req.json());
    const header = c.req.header("authorization");
    const keep = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : getCookie(c, SESSION_COOKIE);
    await auth.changePassword(c.get("deps").db, p.userId, { ...body, keepSessionToken: keep ?? undefined }, c.get("now")());
    return c.json({ ok: true });
  });

  r.get("/api-keys/scopes", (c) => c.json({ scopes: API_KEY_SCOPES, defaults: auth.DEFAULT_API_KEY_SCOPES }));
  r.post("/api-keys", async (c) => {
    const body = z.object({ name: z.string().min(1).max(100), scopes: z.array(z.enum(API_KEY_SCOPES as [string, ...string[]])).optional() }).parse(await c.req.json());
    const { apiKey, secret } = await auth.createApiKey(c.get("deps").db, c.get("ctx"), body);
    return c.json({ apiKey: { id: apiKey.id, name: apiKey.name, prefix: apiKey.prefix, scopes: apiKey.scopes, createdAt: apiKey.createdAt }, secret }, 201);
  });
  r.delete("/api-keys/:id", async (c) => {
    await auth.revokeApiKey(c.get("deps").db, c.get("ctx"), c.req.param("id"));
    return c.json({ ok: true });
  });

  r.get("/audit", async (c) => {
    const q = c.req.query();
    return c.json({ entries: await audit.listAudit(c.get("deps").db, c.get("ctx"), { entityType: q.entityType, entityId: q.entityId, limit: q.limit ? Number(q.limit) : undefined }) });
  });

  /** Website tracking (TRK-09): site key, domain list, snippet-reported orders, install snippet and recent activity. */
  async function trackingView(c: Parameters<typeof requireMerchantPrincipal>[0]) {
    const view = await journeys.getTracking(c.get("deps").db, c.get("ctx"));
    const base = c.get("deps").config.baseUrl.replace(/\/$/, "");
    return { ...view, scriptUrl: `${base}/referly.js`, install: view.siteKey ? installSnippet(base, view.siteKey) : null, examples: SNIPPET_EXAMPLES };
  }
  r.get("/tracking", async (c) => c.json(await trackingView(c)));
  r.post("/tracking/enable", async (c) => {
    await journeys.enableTracking(c.get("deps").db, c.get("ctx"));
    return c.json(await trackingView(c));
  });
  r.post("/tracking/rotate", async (c) => {
    await journeys.rotateSiteKey(c.get("deps").db, c.get("ctx"));
    return c.json(await trackingView(c));
  });
  r.patch("/tracking", async (c) => {
    await journeys.updateTracking(c.get("deps").db, c.get("ctx"), await c.req.json());
    return c.json(await trackingView(c));
  });

  /** Data retention: the workspace's policy, the platform defaults, and what the next prune would delete. */
  r.get("/retention", async (c) => c.json(await retention.getRetention(c.get("deps").db, c.get("ctx"))));
  r.patch("/retention", async (c) => {
    await retention.updateRetention(c.get("deps").db, c.get("ctx"), await c.req.json());
    return c.json(await retention.getRetention(c.get("deps").db, c.get("ctx")));
  });

  return r;
}
