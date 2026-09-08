import { forbidden } from "./errors";

export const MERCHANT_ROLES = ["owner", "admin", "marketing", "readonly"] as const;
export const ALL_ROLES = [...MERCHANT_ROLES, "affiliate", "platform_admin"] as const;
export type Role = (typeof ALL_ROLES)[number];

export type ActorType = "user" | "api_key" | "system" | "affiliate" | "public";

export interface Actor {
  type: ActorType;
  /** user id, api key id, or affiliate id depending on type */
  id?: string;
  role?: Role;
  /** set when actor is an affiliate acting in the portal */
  affiliateId?: string;
  /** API keys: the permissions the key was created with. Nothing else is granted. */
  scopes?: string[];
}

/**
 * Every service call is scoped to exactly one tenant. Services add the tenant filter to
 * every query themselves; callers cannot opt out.
 */
export interface TenantContext {
  tenantId: string;
  actor: Actor;
  /** Injectable clock for deterministic tests. */
  now: () => Date;
}

export function tenantContext(tenantId: string, actor: Actor, now: () => Date = () => new Date()): TenantContext {
  return { tenantId, actor, now };
}

export function systemContext(tenantId: string, now?: () => Date): TenantContext {
  return tenantContext(tenantId, { type: "system", role: "owner" }, now);
}

/** Permission matrix. Keep this the single place that maps roles to capabilities. */
export const PERMISSIONS = {
  "tenant.manage": ["owner"],
  "billing.manage": ["owner"],
  "team.manage": ["owner"],
  "integrations.manage": ["owner", "admin"],
  "offers.write": ["owner", "admin"],
  "programs.write": ["owner", "admin"],
  "affiliates.write": ["owner", "admin"],
  "conversions.write": ["owner", "admin"],
  "commissions.write": ["owner", "admin"],
  "payouts.write": ["owner", "admin"],
  "campaigns.write": ["owner", "admin", "marketing"],
  "assets.write": ["owner", "admin", "marketing"],
  "messages.write": ["owner", "admin", "marketing"],
  "automation.write": ["owner", "admin"],
  "read": ["owner", "admin", "marketing", "readonly"],
} as const;

export type Permission = keyof typeof PERMISSIONS;

/** Permissions an API key may be scoped to. Managing the workspace, billing, team, keys and provider credentials is session-only. */
export const API_KEY_SCOPES = (Object.keys(PERMISSIONS) as Permission[]).filter((p) => !["tenant.manage", "billing.manage", "team.manage", "integrations.manage"].includes(p));

export function can(ctx: TenantContext, permission: Permission): boolean {
  const { actor } = ctx;
  if (actor.type === "system") return true;
  if (actor.type === "api_key") return (API_KEY_SCOPES as string[]).includes(permission) && (actor.scopes ?? []).includes(permission);
  if (!actor.role) return false;
  if (actor.role === "platform_admin") return true;
  return (PERMISSIONS[permission] as readonly string[]).includes(actor.role);
}

export function require(ctx: TenantContext, permission: Permission): void {
  if (!can(ctx, permission)) throw forbidden(`missing permission ${permission}`);
}

/** Affiliates may only act on their own records. */
export function requireAffiliate(ctx: TenantContext, affiliateId: string): void {
  if (ctx.actor.type === "system") return;
  if (ctx.actor.type === "affiliate") {
    if (ctx.actor.affiliateId !== affiliateId) throw forbidden("affiliate scope mismatch");
    return;
  }
  require(ctx, "read");
}
