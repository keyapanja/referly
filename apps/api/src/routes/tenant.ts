import { Hono } from "hono";
import { z } from "zod";
import { tenants, auth, audit, MERCHANT_ROLES } from "@referly/core";
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
    const tenant = await tenants.getTenant(c.get("deps").db, c.get("ctx"));
    return c.json({ principal: p, tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, currency: tenant.currency, timezone: tenant.timezone } });
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
