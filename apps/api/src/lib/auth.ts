import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { auth, affiliates, tenants, tenantContext, unauthenticated, forbidden, type TenantContext, type Role } from "@referly/core";
import type { AppDeps } from "../app";
import { scopeRequest } from "./rls";

export const SESSION_COOKIE = "referly_session";

export type AppEnv = {
  Variables: {
    deps: AppDeps;
    now: () => Date;
    ctx: TenantContext;
    principal: Principal;
  };
};

export type Principal =
  | { kind: "user"; userId: string; role: Role; tenantId: string; affiliateId?: string }
  | { kind: "api_key"; apiKeyId: string; tenantId: string; scopes: string[] };

/**
 * Resolves the caller to exactly one tenant context:
 *  - `Authorization: Bearer rk_live_...` → API key (integrations)
 *  - `Authorization: Bearer <session token>` or the session cookie → user
 * Tenant is never read from the request; it comes from the credential.
 */
export function authMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { db } = c.get("deps");
    const now = c.get("now")();
    const header = c.req.header("authorization");
    const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;

    if (bearer?.startsWith("rk_live_")) {
      const key = await auth.resolveApiKey(db, bearer, now);
      if (!key) throw unauthenticated("invalid API key");
      await scopeRequest(c, key.tenantId);
      const tenant = await tenants.getTenant(db, tenantContext(key.tenantId, { type: "system", role: "owner" }, c.get("now")));
      if (tenant.status !== "active") throw forbidden(`workspace is ${tenant.status}`);
      c.set("principal", { kind: "api_key", apiKeyId: key.id, tenantId: key.tenantId, scopes: key.scopes });
      c.set("ctx", tenantContext(key.tenantId, { type: "api_key", id: key.id, scopes: key.scopes }, c.get("now")));
      return next();
    }

    const token = bearer ?? getCookie(c, SESSION_COOKIE);
    if (!token) throw unauthenticated();
    const session = await auth.resolveSession(db, token, now);
    if (!session) throw unauthenticated("session expired");

    await scopeRequest(c, session.tenantId);
    if (session.role !== "platform_admin") {
      const tenant = await tenants.getTenant(db, tenantContext(session.tenantId, { type: "system", role: "owner" }, c.get("now")));
      if (tenant.status !== "active") throw forbidden(`workspace is ${tenant.status}`);
    }
    if (session.role === "affiliate") {
      const affiliate = await affiliates.getAffiliateByUserId(db, session.tenantId, session.user.id);
      if (!affiliate) throw forbidden("no affiliate profile");
      if (affiliate.status !== "active") throw forbidden(`affiliate is ${affiliate.status}`);
      c.set("principal", { kind: "user", userId: session.user.id, role: "affiliate", tenantId: session.tenantId, affiliateId: affiliate.id });
      c.set("ctx", tenantContext(session.tenantId, { type: "affiliate", id: session.user.id, role: "affiliate", affiliateId: affiliate.id }, c.get("now")));
      return next();
    }

    c.set("principal", { kind: "user", userId: session.user.id, role: session.role, tenantId: session.tenantId });
    c.set("ctx", tenantContext(session.tenantId, { type: "user", id: session.user.id, role: session.role }, c.get("now")));
    return next();
  };
}

/** Portal routes require an affiliate principal; merchant routes require a non-affiliate. */
export function requireAffiliatePrincipal(c: Context<AppEnv>): string {
  const p = c.get("principal");
  if (p.kind !== "user" || !p.affiliateId) throw forbidden("affiliate portal access only");
  return p.affiliateId;
}

export function requireMerchantPrincipal(c: Context<AppEnv>): void {
  const p = c.get("principal");
  if (p.kind === "user" && p.role === "affiliate") throw forbidden("merchant access only");
}

export function setSessionCookie(c: Context<AppEnv>, token: string, expiresAt: Date): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: c.get("deps").config.cookieSecure,
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
