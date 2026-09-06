import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { withTx } from "../db/client";
import { tenants, users, type Tenant, type User } from "../db/schema";
import { newId } from "../ids";
import { conflict, notFound, validation } from "../errors";
import { hashPassword } from "./auth";
import { type TenantContext, require as requirePerm, tenantContext, MERCHANT_ROLES } from "../context";
import { writeAudit, snapshot } from "./audit";
import { seedDefaultTemplates } from "./messaging";

export const createTenantSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(3)
    .max(50)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "slug must be lowercase letters, numbers and hyphens"),
  currency: z.string().length(3).default("USD"),
  timezone: z.string().default("UTC"),
  businessType: z.string().optional(),
  owner: z.object({ name: z.string().min(1), email: z.string().email(), password: z.string().min(8) }),
});
export type CreateTenantInput = z.input<typeof createTenantSchema>;

const RESERVED_SLUGS = new Set(["admin", "api", "app", "www", "platform", "r", "join", "invite", "static"]);

/** BIZ-01: create an isolated workspace with its owner. Public self-serve entry point. */
export async function createTenant(db: DbLike, rawInput: CreateTenantInput, now = new Date()): Promise<{ tenant: Tenant; owner: User }> {
  const input = createTenantSchema.parse(rawInput);
  if (RESERVED_SLUGS.has(input.slug)) throw validation(`slug ${input.slug} is reserved`);
  const passwordHash = await hashPassword(input.owner.password);

  return withTx(db, async (tx) => {
    const existing = await tx.query.tenants.findFirst({ where: eq(tenants.slug, input.slug) });
    if (existing) throw conflict(`slug ${input.slug} is already taken`);

    const [tenant] = await tx
      .insert(tenants)
      .values({
        id: newId("tenant"),
        name: input.name,
        slug: input.slug,
        currency: input.currency.toUpperCase(),
        timezone: input.timezone,
        businessType: input.businessType ?? null,
        defaults: { attributionWindowDays: 30, holdingDays: 30, approvalMode: "manual", payoutCadence: "manual", payoutThresholdMinor: 0 },
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const [owner] = await tx
      .insert(users)
      .values({
        id: newId("user"),
        tenantId: tenant!.id,
        role: "owner",
        name: input.owner.name,
        email: input.owner.email.trim().toLowerCase(),
        passwordHash,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const ctx = tenantContext(tenant!.id, { type: "user", id: owner!.id, role: "owner" }, () => now);
    await seedDefaultTemplates(tx, ctx);
    await writeAudit(tx, ctx, { entityType: "tenant", entityId: tenant!.id, action: "created", after: snapshot(tenant!) });
    return { tenant: tenant!, owner: owner! };
  });
}

export async function getTenant(db: DbLike, ctx: TenantContext): Promise<Tenant> {
  const row = await db.query.tenants.findFirst({ where: eq(tenants.id, ctx.tenantId) });
  if (!row) throw notFound("tenant", ctx.tenantId);
  return row;
}

export async function getTenantBySlug(db: DbLike, slug: string): Promise<Tenant | null> {
  return (await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) })) ?? null;
}

export const updateTenantSchema = z
  .object({
    name: z.string().min(1).max(120),
    legalName: z.string().max(200).nullable(),
    website: z.string().url().nullable(),
    supportEmail: z.string().email().nullable(),
    description: z.string().max(2000).nullable(),
    logoUrl: z.string().url().nullable(),
    businessType: z.string().nullable(),
    currency: z.string().length(3),
    timezone: z.string(),
    locale: z.string(),
    tone: z.enum(["friendly", "professional", "concise", "warm", "formal"]),
    branding: z
      .object({
        primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        faviconUrl: z.string().url().optional(),
        emailFooter: z.string().max(500).optional(),
      })
      .partial(),
    defaults: z
      .object({
        attributionWindowDays: z.number().int().min(1).max(365),
        holdingDays: z.number().int().min(0).max(365),
        approvalMode: z.enum(["manual", "auto", "invite_only"]),
        payoutCadence: z.enum(["manual", "weekly", "biweekly", "monthly"]),
        payoutThresholdMinor: z.number().int().min(0),
        requireConsentForTracking: z.boolean(),
      })
      .partial(),
  })
  .partial();

export async function updateTenant(db: DbLike, ctx: TenantContext, rawInput: z.input<typeof updateTenantSchema>): Promise<Tenant> {
  requirePerm(ctx, "tenant.manage");
  const input = updateTenantSchema.parse(rawInput);
  const before = await getTenant(db, ctx);
  const patch: Partial<Tenant> = { ...input, updatedAt: ctx.now() } as Partial<Tenant>;
  if (input.currency) patch.currency = input.currency.toUpperCase();
  if (input.branding) patch.branding = { ...before.branding, ...input.branding };
  if (input.defaults) patch.defaults = { ...before.defaults, ...input.defaults };
  const [after] = await db.update(tenants).set(patch).where(eq(tenants.id, ctx.tenantId)).returning();
  await writeAudit(db, ctx, { entityType: "tenant", entityId: ctx.tenantId, action: "updated", before: snapshot(before), after: snapshot(after!) });
  return after!;
}

// ---------------------------------------------------------------------------
// Team members
// ---------------------------------------------------------------------------

export const inviteTeamMemberSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: z.enum(MERCHANT_ROLES),
  password: z.string().min(8),
});

export async function addTeamMember(db: DbLike, ctx: TenantContext, rawInput: z.input<typeof inviteTeamMemberSchema>): Promise<User> {
  requirePerm(ctx, "team.manage");
  const input = inviteTeamMemberSchema.parse(rawInput);
  const email = input.email.trim().toLowerCase();
  const existing = await db.query.users.findFirst({ where: and(eq(users.tenantId, ctx.tenantId), eq(users.email, email)) });
  if (existing) throw conflict(`user ${email} already exists in this workspace`);
  const [user] = await db
    .insert(users)
    .values({
      id: newId("user"),
      tenantId: ctx.tenantId,
      role: input.role,
      name: input.name,
      email,
      passwordHash: await hashPassword(input.password),
      status: "active",
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    })
    .returning();
  await writeAudit(db, ctx, { entityType: "user", entityId: user!.id, action: "created", after: snapshot(user!, ["id", "role", "email", "name"]) });
  return user!;
}

export async function changeUserRole(db: DbLike, ctx: TenantContext, userId: string, role: (typeof MERCHANT_ROLES)[number]): Promise<User> {
  requirePerm(ctx, "team.manage");
  const before = await db.query.users.findFirst({ where: and(eq(users.id, userId), eq(users.tenantId, ctx.tenantId)) });
  if (!before) throw notFound("user", userId);
  if (before.role === "owner" && role !== "owner") {
    const owners = await db.select({ id: users.id }).from(users).where(and(eq(users.tenantId, ctx.tenantId), eq(users.role, "owner"), eq(users.status, "active")));
    if (owners.length <= 1) throw validation("a workspace must keep at least one owner");
  }
  const [after] = await db.update(users).set({ role, updatedAt: ctx.now() }).where(eq(users.id, userId)).returning();
  await writeAudit(db, ctx, {
    entityType: "user",
    entityId: userId,
    action: "role_changed",
    before: { role: before.role },
    after: { role: after!.role },
  });
  return after!;
}

export async function listTeam(db: DbLike, ctx: TenantContext): Promise<User[]> {
  requirePerm(ctx, "read");
  return db.select().from(users).where(and(eq(users.tenantId, ctx.tenantId)));
}
