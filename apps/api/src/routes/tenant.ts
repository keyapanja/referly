import { Hono } from "hono";
import { z } from "zod";
import { tenants, auth, audit, account, plans, integrations, MERCHANT_ROLES } from "@referly/core";
import { requireMerchantPrincipal, type AppEnv } from "../lib/auth";
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

  r.post("/api-keys", async (c) => {
    const body = z.object({ name: z.string().min(1), scopes: z.array(z.string()).optional() }).parse(await c.req.json());
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

  return r;
}
