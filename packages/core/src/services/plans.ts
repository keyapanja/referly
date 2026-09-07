import { and, count, eq, gte, ne, sql } from "drizzle-orm";
import type { DbLike } from "../db/client";
import { affiliates, conversions, programs, tenants, users, type Tenant } from "../db/schema";
import { DomainError, notFound } from "../errors";
import type { TenantContext } from "../context";

/**
 * Plans, usage metering and limit enforcement (PRD s19). Prices are deliberately not in code:
 * the PRD asks for them to be validated first. Limits are the illustrative tier shape from the
 * PRD and can be overridden per tenant by a platform admin (`tenants.plan_limits`) for custom
 * or enterprise deals.
 *
 * Enforcement is deterministic and never loses money data: hard limits apply to things a
 * merchant chooses to add (active affiliates, programs, team members); tracked conversions are
 * a soft limit that is reported as an overage, never rejected.
 */

export const PLAN_IDS = ["starter", "growth", "pro", "enterprise"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanLimits {
  activeAffiliates: number | null;
  programs: number | null;
  teamMembers: number | null;
  monthlyConversions: number | null;
}
export type LimitKey = keyof PlanLimits;
export type HardLimitKey = Exclude<LimitKey, "monthlyConversions">;

export interface Plan {
  id: PlanId;
  name: string;
  description: string;
  limits: PlanLimits;
  features: { customBranding: boolean; customDomain: boolean; campaigns: boolean; automation: boolean; prioritySupport: boolean };
}

export const PLANS: Record<PlanId, Plan> = {
  starter: {
    id: "starter",
    name: "Starter",
    description: "Solo coach or creator: core tracking, portal and payouts.",
    limits: { activeAffiliates: 25, programs: 3, teamMembers: 2, monthlyConversions: 200 },
    features: { customBranding: false, customDomain: false, campaigns: false, automation: false, prioritySupport: false },
  },
  growth: {
    id: "growth",
    name: "Growth",
    description: "Growing business: larger affiliate base, campaigns, automation, custom branding.",
    limits: { activeAffiliates: 250, programs: 5, teamMembers: 5, monthlyConversions: 2000 },
    features: { customBranding: true, customDomain: false, campaigns: true, automation: true, prioritySupport: false },
  },
  pro: {
    id: "pro",
    name: "Pro",
    description: "High volume: advanced roles, integrations, custom domain, priority support.",
    limits: { activeAffiliates: 2500, programs: 25, teamMembers: 15, monthlyConversions: 20000 },
    features: { customBranding: true, customDomain: true, campaigns: true, automation: true, prioritySupport: true },
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    description: "Agencies and multi-brand operators: custom limits, integrations and support.",
    limits: { activeAffiliates: null, programs: null, teamMembers: null, monthlyConversions: null },
    features: { customBranding: true, customDomain: true, campaigns: true, automation: true, prioritySupport: true },
  },
};

export const LIMIT_LABELS: Record<LimitKey, string> = {
  activeAffiliates: "Active affiliates",
  programs: "Programs",
  teamMembers: "Team members",
  monthlyConversions: "Tracked conversions this month",
};

export function getPlan(planId: string | null | undefined): Plan {
  return PLANS[(planId ?? "starter") as PlanId] ?? PLANS.starter;
}

/** Plan limits with any per-tenant overrides applied. */
export function resolveLimits(tenant: Pick<Tenant, "planId" | "planLimits">): PlanLimits {
  const base = getPlan(tenant.planId).limits;
  const overrides = (tenant.planLimits ?? {}) as Partial<PlanLimits>;
  return { ...base, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v === null || typeof v === "number")) } as PlanLimits;
}

export async function getUsage(db: DbLike, ctx: TenantContext): Promise<Record<LimitKey, number>> {
  const now = ctx.now();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [[aff], [prog], [team], [conv]] = await Promise.all([
    db.select({ n: count() }).from(affiliates).where(and(eq(affiliates.tenantId, ctx.tenantId), eq(affiliates.status, "active"))),
    db.select({ n: count() }).from(programs).where(and(eq(programs.tenantId, ctx.tenantId), ne(programs.status, "archived"))),
    db.select({ n: count() }).from(users).where(and(eq(users.tenantId, ctx.tenantId), ne(users.role, "affiliate"), ne(users.status, "disabled"))),
    db.select({ n: count() }).from(conversions).where(and(eq(conversions.tenantId, ctx.tenantId), gte(conversions.createdAt, monthStart))),
  ]);
  return { activeAffiliates: aff!.n, programs: prog!.n, teamMembers: team!.n, monthlyConversions: conv!.n };
}

export interface BillingSummary {
  plan: Pick<Plan, "id" | "name" | "description" | "features">;
  limits: PlanLimits;
  usage: Record<LimitKey, number>;
  /** Limits that are reached or within 10% of being reached. */
  warnings: { key: LimitKey; label: string; usage: number; limit: number; level: "reached" | "near" }[];
}

export async function getBillingSummary(db: DbLike, ctx: TenantContext): Promise<BillingSummary> {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, ctx.tenantId) });
  if (!tenant) throw notFound("tenant");
  const plan = getPlan(tenant.planId);
  const limits = resolveLimits(tenant);
  const usage = await getUsage(db, ctx);
  const warnings: BillingSummary["warnings"] = [];
  for (const key of Object.keys(limits) as LimitKey[]) {
    const limit = limits[key];
    if (limit === null) continue;
    const used = usage[key];
    // "near" = inside the last 10%, or the last remaining slot. Limits under 3 only ever report "reached".
    const nearAt = limit >= 3 ? Math.min(limit - 1, Math.ceil(limit * 0.9)) : limit;
    if (used >= limit) warnings.push({ key, label: LIMIT_LABELS[key], usage: used, limit, level: "reached" });
    else if (used >= nearAt) warnings.push({ key, label: LIMIT_LABELS[key], usage: used, limit, level: "near" });
  }
  return { plan: { id: plan.id, name: plan.name, description: plan.description, features: plan.features }, limits, usage, warnings };
}

/** Throws `plan_limit` (HTTP 402) when adding `adding` more would exceed the tenant's hard limit. */
export async function assertWithinLimit(db: DbLike, ctx: TenantContext, key: HardLimitKey, adding = 1): Promise<void> {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, ctx.tenantId) });
  if (!tenant) throw notFound("tenant");
  const limit = resolveLimits(tenant)[key];
  if (limit === null) return;
  const usage = await getUsage(db, ctx);
  if (usage[key] + adding > limit) {
    throw new DomainError("plan_limit", `${LIMIT_LABELS[key]} limit reached for the ${getPlan(tenant.planId).name} plan (${usage[key]}/${limit}). Upgrade to add more.`, {
      key,
      usage: usage[key],
      limit,
      planId: tenant.planId,
    });
  }
}

/** Throws `plan_limit` (HTTP 402) when the tenant's plan does not include a feature. */
export async function assertFeature(db: DbLike, ctx: TenantContext, feature: keyof Plan["features"]): Promise<void> {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, ctx.tenantId) });
  if (!tenant) throw notFound("tenant");
  const plan = getPlan(tenant.planId);
  if (!plan.features[feature]) {
    const label = { customBranding: "Custom branding", customDomain: "Custom domains", campaigns: "Campaigns", automation: "Automation rules", prioritySupport: "Priority support" }[feature];
    throw new DomainError("plan_limit", `${label} are not included in the ${plan.name} plan. Upgrade to use them.`, { feature, planId: tenant.planId });
  }
}

/** Convenience for SQL callers that already have the numbers. */
export const usageSql = sql;
