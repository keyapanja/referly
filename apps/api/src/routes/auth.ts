import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { auth, tenants, affiliates, account } from "@referly/core";
import { SESSION_COOKIE, clearSessionCookie, setSessionCookie, type AppEnv } from "../lib/auth";

export function authRoutes() {
  const r = new Hono<AppEnv>();

  /** Journey A step 1: self-serve workspace creation. */
  r.post("/signup", async (c) => {
    const { db } = c.get("deps");
    const body = await c.req.json();
    const { tenant, owner } = await tenants.createTenant(db, body, c.get("now")());
    const session = await auth.createSession(db, owner, c.get("now")());
    setSessionCookie(c, session.token, session.expiresAt);
    return c.json({ tenant: publicTenant(tenant), user: publicUser(owner), token: session.token }, 201);
  });

  r.post("/login", async (c) => {
    const { db } = c.get("deps");
    const body = z.object({ email: z.string().email(), password: z.string(), tenantSlug: z.string().optional() }).parse(await c.req.json());
    const result = await auth.loginWithPassword(db, body, c.get("now")());
    setSessionCookie(c, result.token, result.expiresAt);
    const affiliate = result.user.role === "affiliate" ? await affiliates.getAffiliateByUserId(db, result.tenant.id, result.user.id) : null;
    return c.json({ tenant: publicTenant(result.tenant), user: publicUser(result.user), affiliateId: affiliate?.id ?? null, token: result.token });
  });

  r.post("/verify-email", async (c) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(await c.req.json());
    const user = await account.verifyEmail(c.get("deps").db, token, c.get("now")());
    return c.json({ user: publicUser(user) });
  });

  r.post("/forgot-password", async (c) => {
    await account.requestPasswordReset(c.get("deps").db, await c.req.json(), c.get("now")());
    return c.json({ ok: true }); // never reveals whether the email exists
  });

  r.post("/reset-password", async (c) => {
    const user = await account.resetPassword(c.get("deps").db, await c.req.json(), c.get("now")());
    return c.json({ user: publicUser(user) });
  });

  r.post("/logout", async (c) => {
    const { db } = c.get("deps");
    const token = getCookie(c, SESSION_COOKIE) ?? c.req.header("authorization")?.slice(7);
    if (token) await auth.revokeSession(db, token);
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  return r;
}

export function publicTenant(t: { id: string; name: string; slug: string; currency: string; timezone: string; logoUrl: string | null; branding: unknown; tone: string }) {
  return { id: t.id, name: t.name, slug: t.slug, currency: t.currency, timezone: t.timezone, logoUrl: t.logoUrl, branding: t.branding, tone: t.tone };
}

export function publicUser(u: { id: string; name: string; email: string; role: string; emailVerifiedAt?: Date | null }) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, emailVerified: !!u.emailVerifiedAt };
}
