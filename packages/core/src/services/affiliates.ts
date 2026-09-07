import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { withTx } from "../db/client";
import { affiliatePrograms, affiliates, invites, programs, users, type Affiliate, type AffiliateProgram, type Invite } from "../db/schema";
import { newId, newToken } from "../ids";
import { conflict, notFound, validation } from "../errors";
import { type TenantContext, require as requirePerm, requireAffiliate } from "../context";
import { writeAudit, snapshot } from "./audit";
import { assertWithinLimit } from "./plans";
import { emitEvent } from "./events";
import { AFFILIATE_TRANSITIONS, assertTransition, type AffiliateStatus } from "../statemachine";
import { hashPassword } from "./auth";
import { getProgram } from "./programs";
import { percentToBps } from "../money";

// ---------------------------------------------------------------------------
// Application (public, via program join token) and invites
// ---------------------------------------------------------------------------

export const applySchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8),
  phone: z.string().max(40).optional(),
  company: z.string().max(200).optional(),
  channels: z.record(z.string(), z.string().max(500)).default({}),
  answers: z.record(z.string(), z.unknown()).default({}),
  acceptTerms: z.literal(true),
});
export type ApplyInput = z.input<typeof applySchema>;

/**
 * AFF-02 / journey C: prospective affiliate applies through the branded page.
 * Creates the affiliate (status depends on program approvalMode), their portal user, and
 * their pending/active program membership with the accepted terms version recorded.
 */
export async function applyToProgram(db: DbLike, ctx: TenantContext, programId: string, rawInput: ApplyInput): Promise<{ affiliate: Affiliate; membership: AffiliateProgram }> {
  const input = applySchema.parse(rawInput);
  const program = await getProgram(db, ctx, programId);
  if (program.status !== "active") throw validation("program is not accepting applications");
  if (program.approvalMode === "invite_only") throw validation("program is invite-only");

  return withTx(db, async (tx) => {
    const affiliate = await findOrCreateAffiliate(tx, ctx, {
      name: input.name,
      email: input.email,
      password: input.password,
      phone: input.phone,
      company: input.company,
      channels: input.channels,
      answers: input.answers,
      source: "application",
      initialStatus: program.approvalMode === "auto" ? "active" : "applied",
    });
    const membership = await upsertMembership(tx, ctx, affiliate, program, program.approvalMode === "auto" ? "active" : "pending");
    await emitEvent(tx, ctx, affiliate.status === "active" ? "affiliate.approved" : "affiliate.applied", { type: "affiliate", id: affiliate.id }, { programId });
    return { affiliate, membership };
  });
}

export const inviteSchema = z.object({
  programId: z.string(),
  email: z.string().email(),
  name: z.string().max(120).optional(),
  expiresInDays: z.number().int().min(1).max(90).default(30),
});

/** AFF-03: invite a specific person. Returns the invite with its opaque token for the accept URL. */
export async function inviteAffiliate(db: DbLike, ctx: TenantContext, rawInput: z.input<typeof inviteSchema>): Promise<Invite> {
  requirePerm(ctx, "affiliates.write");
  const input = inviteSchema.parse(rawInput);
  await getProgram(db, ctx, input.programId);
  const [row] = await db
    .insert(invites)
    .values({
      id: newId("invite"),
      tenantId: ctx.tenantId,
      programId: input.programId,
      email: input.email.trim().toLowerCase(),
      name: input.name ?? null,
      token: newToken(16),
      status: "sent",
      expiresAt: new Date(ctx.now().getTime() + input.expiresInDays * 86_400_000),
      createdByUserId: ctx.actor.type === "user" ? (ctx.actor.id ?? null) : null,
      createdAt: ctx.now(),
    })
    .returning();
  await emitEvent(db, ctx, "affiliate.invited", { type: "invite", id: row!.id }, { email: row!.email, programId: input.programId, token: row!.token });
  return row!;
}

export async function getInviteByToken(db: DbLike, token: string): Promise<Invite | null> {
  return (await db.query.invites.findFirst({ where: eq(invites.token, token) })) ?? null;
}

export const acceptInviteSchema = z.object({
  name: z.string().min(1).max(120),
  password: z.string().min(8),
  acceptTerms: z.literal(true),
});

/** Journey B: invited affiliate accepts terms and becomes active immediately. */
export async function acceptInvite(db: DbLike, ctx: TenantContext, invite: Invite, rawInput: z.input<typeof acceptInviteSchema>) {
  const input = acceptInviteSchema.parse(rawInput);
  if (invite.tenantId !== ctx.tenantId) throw notFound("invite");
  if (invite.status !== "sent") throw validation(`invite is ${invite.status}`);
  if (invite.expiresAt.getTime() < ctx.now().getTime()) throw validation("invite has expired");
  const program = await getProgram(db, ctx, invite.programId);

  return withTx(db, async (tx) => {
    const affiliate = await findOrCreateAffiliate(tx, ctx, {
      name: input.name,
      email: invite.email,
      password: input.password,
      source: "invite",
      initialStatus: "active",
    });
    if (affiliate.status === "applied") await transition(tx, ctx, affiliate, "active", "invite accepted");
    const membership = await upsertMembership(tx, ctx, affiliate, program, "active");
    await tx.update(invites).set({ status: "accepted", acceptedAffiliateId: affiliate.id }).where(eq(invites.id, invite.id));
    await emitEvent(tx, ctx, "affiliate.approved", { type: "affiliate", id: affiliate.id }, { programId: program.id, via: "invite" });
    return { affiliate: { ...affiliate, status: "active" }, membership };
  });
}

// ---------------------------------------------------------------------------
// Merchant-side management
// ---------------------------------------------------------------------------

export const createAffiliateSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  phone: z.string().max(40).optional(),
  company: z.string().max(200).optional(),
  tags: z.array(z.string().max(40)).default([]),
  notes: z.string().max(5000).optional(),
  programIds: z.array(z.string()).default([]),
});

/** Manual creation by a merchant operator (source=manual). Affiliate is active; portal login set later. */
export async function createAffiliate(db: DbLike, ctx: TenantContext, rawInput: z.input<typeof createAffiliateSchema>): Promise<Affiliate> {
  requirePerm(ctx, "affiliates.write");
  const input = createAffiliateSchema.parse(rawInput);
  return withTx(db, async (tx) => {
    const affiliate = await findOrCreateAffiliate(tx, ctx, { ...input, source: "manual", initialStatus: "active" });
    for (const programId of input.programIds) {
      const program = await getProgram(tx, ctx, programId);
      await upsertMembership(tx, ctx, affiliate, program, "active");
    }
    return affiliate;
  });
}

export async function approveAffiliate(db: DbLike, ctx: TenantContext, affiliateId: string, reason?: string): Promise<Affiliate> {
  requirePerm(ctx, "affiliates.write");
  return withTx(db, async (tx) => {
    const before = await getAffiliate(tx, ctx, affiliateId);
    const after = await transition(tx, ctx, before, "active", reason);
    await tx
      .update(affiliatePrograms)
      .set({ status: "active", joinedAt: ctx.now() })
      .where(and(eq(affiliatePrograms.tenantId, ctx.tenantId), eq(affiliatePrograms.affiliateId, affiliateId), eq(affiliatePrograms.status, "pending")));
    await emitEvent(tx, ctx, "affiliate.approved", { type: "affiliate", id: affiliateId });
    return after;
  });
}

export async function rejectAffiliate(db: DbLike, ctx: TenantContext, affiliateId: string, reason?: string): Promise<Affiliate> {
  requirePerm(ctx, "affiliates.write");
  const before = await getAffiliate(db, ctx, affiliateId);
  const after = await transition(db, ctx, before, "rejected", reason);
  await emitEvent(db, ctx, "affiliate.rejected", { type: "affiliate", id: affiliateId }, { reason });
  return after;
}

/** AFF-08: suspend. Stops new attribution and portal access; keeps history. */
export async function suspendAffiliate(db: DbLike, ctx: TenantContext, affiliateId: string, reason: string): Promise<Affiliate> {
  requirePerm(ctx, "affiliates.write");
  if (!reason?.trim()) throw validation("a reason is required to suspend an affiliate");
  const before = await getAffiliate(db, ctx, affiliateId);
  const after = await transition(db, ctx, before, "suspended", reason);
  await emitEvent(db, ctx, "affiliate.suspended", { type: "affiliate", id: affiliateId }, { reason });
  return after;
}

export async function reactivateAffiliate(db: DbLike, ctx: TenantContext, affiliateId: string, reason?: string): Promise<Affiliate> {
  requirePerm(ctx, "affiliates.write");
  const before = await getAffiliate(db, ctx, affiliateId);
  const after = await transition(db, ctx, before, "active", reason);
  await emitEvent(db, ctx, "affiliate.reactivated", { type: "affiliate", id: affiliateId });
  return after;
}

export const updateAffiliateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  phone: z.string().max(40).nullable().optional(),
  company: z.string().max(200).nullable().optional(),
  channels: z.record(z.string(), z.string().max(500)).optional(),
  tags: z.array(z.string().max(40)).optional(),
  notes: z.string().max(5000).nullable().optional(),
});

export async function updateAffiliate(db: DbLike, ctx: TenantContext, affiliateId: string, rawInput: z.input<typeof updateAffiliateSchema>): Promise<Affiliate> {
  requireAffiliate(ctx, affiliateId);
  const input = updateAffiliateSchema.parse(rawInput);
  if (ctx.actor.type === "affiliate") {
    // affiliates may edit their own profile but not merchant-owned fields
    delete (input as { tags?: unknown }).tags;
    delete (input as { notes?: unknown }).notes;
  } else requirePerm(ctx, "affiliates.write");
  const before = await getAffiliate(db, ctx, affiliateId);
  const [after] = await db
    .update(affiliates)
    .set({ ...input, updatedAt: ctx.now() })
    .where(and(eq(affiliates.id, affiliateId), eq(affiliates.tenantId, ctx.tenantId)))
    .returning();
  await writeAudit(db, ctx, { entityType: "affiliate", entityId: affiliateId, action: "updated", before: snapshot(before), after: snapshot(after!) });
  return after!;
}

export const payoutProfileSchema = z.object({
  method: z.enum(["bank_transfer", "paypal", "stripe_connect", "upi", "other"]),
  /** Reference issued by a payment provider or vault. Raw account numbers are rejected. */
  profileRef: z.string().min(1).max(200),
  masked: z.string().max(60),
});

/** PAY-01: store a payout method reference, never raw financial credentials. */
export async function setPayoutProfile(db: DbLike, ctx: TenantContext, affiliateId: string, rawInput: z.input<typeof payoutProfileSchema>): Promise<Affiliate> {
  requireAffiliate(ctx, affiliateId);
  const input = payoutProfileSchema.parse(rawInput);
  if (/^\d{9,}$/.test(input.profileRef)) throw validation("profileRef must be a provider reference, not an account number");
  const before = await getAffiliate(db, ctx, affiliateId);
  const [after] = await db
    .update(affiliates)
    .set({ payoutMethod: input.method, payoutProfileRef: input.profileRef, payoutDetailsMasked: input.masked, updatedAt: ctx.now() })
    .where(and(eq(affiliates.id, affiliateId), eq(affiliates.tenantId, ctx.tenantId)))
    .returning();
  await writeAudit(db, ctx, {
    entityType: "affiliate",
    entityId: affiliateId,
    action: "payout_profile_updated",
    before: { method: before.payoutMethod, masked: before.payoutDetailsMasked },
    after: { method: input.method, masked: input.masked },
  });
  return after!;
}

/** AFF-07: per-affiliate commission override on a program. */
export async function setAffiliateCommissionOverride(
  db: DbLike,
  ctx: TenantContext,
  affiliateId: string,
  programId: string,
  override: { commissionPercent?: number | null; commissionFixedMinor?: number | null },
  reason: string,
): Promise<AffiliateProgram> {
  requirePerm(ctx, "affiliates.write");
  if (!reason?.trim()) throw validation("a reason is required for a commission override");
  const [row] = await db
    .update(affiliatePrograms)
    .set({
      customCommissionRateBps: override.commissionPercent == null ? null : percentToBps(override.commissionPercent),
      customCommissionFixedMinor: override.commissionFixedMinor ?? null,
    })
    .where(and(eq(affiliatePrograms.tenantId, ctx.tenantId), eq(affiliatePrograms.affiliateId, affiliateId), eq(affiliatePrograms.programId, programId)))
    .returning();
  if (!row) throw notFound("affiliate program membership");
  await writeAudit(db, ctx, { entityType: "affiliate_program", entityId: `${affiliateId}:${programId}`, action: "commission_override", after: override, reason });
  return row;
}

/** Affiliate joins an additional program from the portal (PROG-09: must accept current terms). */
export async function joinProgram(db: DbLike, ctx: TenantContext, affiliateId: string, programId: string, acceptTerms: boolean): Promise<AffiliateProgram> {
  requireAffiliate(ctx, affiliateId);
  if (!acceptTerms) throw validation("program terms must be accepted");
  const affiliate = await getAffiliate(db, ctx, affiliateId);
  if (affiliate.status !== "active") throw validation("affiliate is not active");
  const program = await getProgram(db, ctx, programId);
  if (program.status !== "active") throw validation("program is not active");
  if (program.approvalMode === "invite_only") throw validation("program is invite-only");
  const membership = await upsertMembership(db, ctx, affiliate, program, program.approvalMode === "auto" ? "active" : "pending");
  await emitEvent(db, ctx, "affiliate.joined_program", { type: "affiliate", id: affiliateId }, { programId, status: membership.status });
  return membership;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getAffiliate(db: DbLike, ctx: TenantContext, affiliateId: string): Promise<Affiliate> {
  const row = await db.query.affiliates.findFirst({ where: and(eq(affiliates.id, affiliateId), eq(affiliates.tenantId, ctx.tenantId)) });
  if (!row) throw notFound("affiliate", affiliateId);
  return row;
}

export async function getAffiliateByUserId(db: DbLike, tenantId: string, userId: string): Promise<Affiliate | null> {
  return (await db.query.affiliates.findFirst({ where: and(eq(affiliates.userId, userId), eq(affiliates.tenantId, tenantId)) })) ?? null;
}

export async function listAffiliates(db: DbLike, ctx: TenantContext, filter: { status?: AffiliateStatus } = {}): Promise<Affiliate[]> {
  requirePerm(ctx, "read");
  return db
    .select()
    .from(affiliates)
    .where(and(eq(affiliates.tenantId, ctx.tenantId), filter.status ? eq(affiliates.status, filter.status) : undefined))
    .orderBy(desc(affiliates.createdAt));
}

export async function listMemberships(db: DbLike, ctx: TenantContext, affiliateId: string): Promise<AffiliateProgram[]> {
  requireAffiliate(ctx, affiliateId);
  return db.select().from(affiliatePrograms).where(and(eq(affiliatePrograms.tenantId, ctx.tenantId), eq(affiliatePrograms.affiliateId, affiliateId)));
}

export async function getMembership(db: DbLike, ctx: TenantContext, affiliateId: string, programId: string): Promise<AffiliateProgram | null> {
  return (
    (await db.query.affiliatePrograms.findFirst({
      where: and(eq(affiliatePrograms.tenantId, ctx.tenantId), eq(affiliatePrograms.affiliateId, affiliateId), eq(affiliatePrograms.programId, programId)),
    })) ?? null
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function transition(db: DbLike, ctx: TenantContext, before: Affiliate, to: AffiliateStatus, reason?: string): Promise<Affiliate> {
  assertTransition("affiliate", AFFILIATE_TRANSITIONS, before.status as AffiliateStatus, to);
  if (to === "active" && before.status !== "active") await assertWithinLimit(db, ctx, "activeAffiliates");
  const [after] = await db
    .update(affiliates)
    .set({ status: to, suspendedAt: to === "suspended" ? ctx.now() : null, updatedAt: ctx.now() })
    .where(and(eq(affiliates.id, before.id), eq(affiliates.tenantId, ctx.tenantId)))
    .returning();
  if (before.userId) await db.update(users).set({ status: to === "suspended" || to === "rejected" ? "disabled" : "active" }).where(eq(users.id, before.userId));
  await writeAudit(db, ctx, { entityType: "affiliate", entityId: before.id, action: `status:${to}`, before: { status: before.status }, after: { status: to }, reason });
  return after!;
}

interface FindOrCreateInput {
  name: string;
  email: string;
  password?: string;
  phone?: string;
  company?: string;
  channels?: Record<string, string>;
  answers?: Record<string, unknown>;
  tags?: string[];
  notes?: string;
  source: "application" | "invite" | "manual" | "import";
  initialStatus: AffiliateStatus;
}

async function findOrCreateAffiliate(db: DbLike, ctx: TenantContext, input: FindOrCreateInput): Promise<Affiliate> {
  const email = input.email.trim().toLowerCase();
  const existing = await db.query.affiliates.findFirst({ where: and(eq(affiliates.tenantId, ctx.tenantId), eq(affiliates.email, email)) });
  if (existing) {
    if (existing.status === "suspended") throw conflict("this affiliate account is suspended");
    return existing;
  }
  if (input.initialStatus === "active") await assertWithinLimit(db, ctx, "activeAffiliates");

  let userId: string | null = null;
  if (input.password) {
    const existingUser = await db.query.users.findFirst({ where: and(eq(users.tenantId, ctx.tenantId), eq(users.email, email)) });
    if (existingUser && existingUser.role !== "affiliate") throw conflict("this email belongs to a team member of this workspace");
    if (existingUser) userId = existingUser.id;
    else {
      const [user] = await db
        .insert(users)
        .values({
          id: newId("user"),
          tenantId: ctx.tenantId,
          role: "affiliate",
          name: input.name,
          email,
          passwordHash: await hashPassword(input.password),
          status: input.initialStatus === "active" || input.initialStatus === "applied" ? "active" : "disabled",
          createdAt: ctx.now(),
          updatedAt: ctx.now(),
        })
        .returning();
      userId = user!.id;
    }
  }

  const [affiliate] = await db
    .insert(affiliates)
    .values({
      id: newId("affiliate"),
      tenantId: ctx.tenantId,
      userId,
      name: input.name,
      email,
      phone: input.phone ?? null,
      company: input.company ?? null,
      channels: input.channels ?? {},
      status: input.initialStatus,
      source: input.source,
      tags: input.tags ?? [],
      notes: input.notes ?? null,
      applicationAnswers: input.answers ?? {},
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    })
    .returning();
  await writeAudit(db, ctx, { entityType: "affiliate", entityId: affiliate!.id, action: "created", after: snapshot(affiliate!, ["id", "email", "status", "source"]) });
  return affiliate!;
}

async function upsertMembership(db: DbLike, ctx: TenantContext, affiliate: Affiliate, program: typeof programs.$inferSelect, status: "pending" | "active"): Promise<AffiliateProgram> {
  const [row] = await db
    .insert(affiliatePrograms)
    .values({
      tenantId: ctx.tenantId,
      affiliateId: affiliate.id,
      programId: program.id,
      status,
      joinedAt: status === "active" ? ctx.now() : null,
      termsVersion: program.termsVersion,
      termsAcceptedAt: ctx.now(),
      createdAt: ctx.now(),
    })
    .onConflictDoUpdate({
      target: [affiliatePrograms.affiliateId, affiliatePrograms.programId],
      set: { termsVersion: program.termsVersion, termsAcceptedAt: ctx.now(), status, joinedAt: status === "active" ? ctx.now() : null },
    })
    .returning();
  await writeAudit(db, ctx, {
    entityType: "affiliate_program",
    entityId: `${affiliate.id}:${program.id}`,
    action: "terms_accepted",
    after: { termsVersion: program.termsVersion, status },
  });
  return row!;
}
