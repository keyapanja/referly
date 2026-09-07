import { and, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { withTx } from "../db/client";
import { affiliateGroupMembers, affiliateGroups, affiliates, assetPermissions, programRateTiers, type Affiliate, type AffiliateGroup } from "../db/schema";
import { newId } from "../ids";
import { conflict, notFound, validation } from "../errors";
import { type TenantContext, require as requirePerm } from "../context";
import { writeAudit, snapshot } from "./audit";

/**
 * Affiliate groups (AFF-04): classify affiliates by partner type, channel, geography or a
 * negotiated rate. Groups are a target for asset permissions, campaign invitations, automation
 * conditions and commission tiers (PROG-11). An affiliate can be in many groups.
 */

export const GROUP_KINDS = ["partner_type", "channel", "geography", "rate", "custom"] as const;

export const groupSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullable().optional(),
  kind: z.enum(GROUP_KINDS).default("custom"),
});

export async function createGroup(db: DbLike, ctx: TenantContext, rawInput: z.input<typeof groupSchema>): Promise<AffiliateGroup> {
  requirePerm(ctx, "affiliates.write");
  const input = groupSchema.parse(rawInput);
  const clash = await db.query.affiliateGroups.findFirst({ where: and(eq(affiliateGroups.tenantId, ctx.tenantId), eq(affiliateGroups.name, input.name)) });
  if (clash) throw conflict(`a group named ${input.name} already exists`);
  const [row] = await db.insert(affiliateGroups).values({ id: newId("affiliateGroup"), tenantId: ctx.tenantId, name: input.name, description: input.description ?? null, kind: input.kind, createdAt: ctx.now() }).returning();
  await writeAudit(db, ctx, { entityType: "affiliate_group", entityId: row!.id, action: "created", after: snapshot(row!) });
  return row!;
}

export async function updateGroup(db: DbLike, ctx: TenantContext, groupId: string, rawInput: z.input<typeof groupSchema>): Promise<AffiliateGroup> {
  requirePerm(ctx, "affiliates.write");
  const input = groupSchema.partial().parse(rawInput);
  const before = await getGroup(db, ctx, groupId);
  const [after] = await db.update(affiliateGroups).set(input).where(and(eq(affiliateGroups.id, groupId), eq(affiliateGroups.tenantId, ctx.tenantId))).returning();
  await writeAudit(db, ctx, { entityType: "affiliate_group", entityId: groupId, action: "updated", before: snapshot(before), after: snapshot(after!) });
  return after!;
}

/** Removes the group, its memberships and asset permissions. Refused while a rate tier still targets it. */
export async function deleteGroup(db: DbLike, ctx: TenantContext, groupId: string): Promise<void> {
  requirePerm(ctx, "affiliates.write");
  const group = await getGroup(db, ctx, groupId);
  const tier = await db.query.programRateTiers.findFirst({ where: and(eq(programRateTiers.tenantId, ctx.tenantId), eq(programRateTiers.groupId, groupId)) });
  if (tier) throw conflict(`group is used by rate tier "${tier.name}"; remove the tier first`);
  await withTx(db, async (tx) => {
    await tx.delete(affiliateGroupMembers).where(and(eq(affiliateGroupMembers.tenantId, ctx.tenantId), eq(affiliateGroupMembers.groupId, groupId)));
    await tx.delete(assetPermissions).where(and(eq(assetPermissions.tenantId, ctx.tenantId), eq(assetPermissions.groupId, groupId)));
    await tx.delete(affiliateGroups).where(eq(affiliateGroups.id, groupId));
    await writeAudit(tx, ctx, { entityType: "affiliate_group", entityId: groupId, action: "deleted", before: snapshot(group) });
  });
}

export async function getGroup(db: DbLike, ctx: TenantContext, groupId: string): Promise<AffiliateGroup> {
  const row = await db.query.affiliateGroups.findFirst({ where: and(eq(affiliateGroups.id, groupId), eq(affiliateGroups.tenantId, ctx.tenantId)) });
  if (!row) throw notFound("affiliate group", groupId);
  return row;
}

export async function listGroups(db: DbLike, ctx: TenantContext): Promise<(AffiliateGroup & { memberCount: number })[]> {
  requirePerm(ctx, "read");
  const rows = await db.select().from(affiliateGroups).where(eq(affiliateGroups.tenantId, ctx.tenantId)).orderBy(desc(affiliateGroups.createdAt));
  const counts = await db.select({ groupId: affiliateGroupMembers.groupId, n: count() }).from(affiliateGroupMembers).where(eq(affiliateGroupMembers.tenantId, ctx.tenantId)).groupBy(affiliateGroupMembers.groupId);
  return rows.map((g) => ({ ...g, memberCount: counts.find((c) => c.groupId === g.id)?.n ?? 0 }));
}

export async function addMembers(db: DbLike, ctx: TenantContext, groupId: string, affiliateIds: string[]): Promise<string[]> {
  requirePerm(ctx, "affiliates.write");
  await getGroup(db, ctx, groupId);
  const ids = [...new Set(affiliateIds)];
  if (!ids.length) return [];
  const found = await db.select({ id: affiliates.id }).from(affiliates).where(and(eq(affiliates.tenantId, ctx.tenantId), inArray(affiliates.id, ids)));
  const missing = ids.filter((id) => !found.some((f) => f.id === id));
  if (missing.length) throw validation("unknown affiliates", { affiliateIds: missing });
  const existing = await db.select({ affiliateId: affiliateGroupMembers.affiliateId }).from(affiliateGroupMembers).where(and(eq(affiliateGroupMembers.groupId, groupId), inArray(affiliateGroupMembers.affiliateId, ids)));
  const fresh = ids.filter((id) => !existing.some((e) => e.affiliateId === id));
  if (!fresh.length) return [];
  await db.insert(affiliateGroupMembers).values(fresh.map((affiliateId) => ({ id: newId("affiliateGroupMember"), tenantId: ctx.tenantId, groupId, affiliateId, addedAt: ctx.now() })));
  await writeAudit(db, ctx, { entityType: "affiliate_group", entityId: groupId, action: "members_added", after: { affiliateIds: fresh } });
  return fresh;
}

export async function removeMember(db: DbLike, ctx: TenantContext, groupId: string, affiliateId: string): Promise<void> {
  requirePerm(ctx, "affiliates.write");
  await getGroup(db, ctx, groupId);
  await db.delete(affiliateGroupMembers).where(and(eq(affiliateGroupMembers.tenantId, ctx.tenantId), eq(affiliateGroupMembers.groupId, groupId), eq(affiliateGroupMembers.affiliateId, affiliateId)));
  await writeAudit(db, ctx, { entityType: "affiliate_group", entityId: groupId, action: "member_removed", after: { affiliateId } });
}

export async function listMembers(db: DbLike, ctx: TenantContext, groupId: string): Promise<Affiliate[]> {
  requirePerm(ctx, "read");
  await getGroup(db, ctx, groupId);
  const rows = await db
    .select({ affiliate: affiliates })
    .from(affiliateGroupMembers)
    .innerJoin(affiliates, eq(affiliates.id, affiliateGroupMembers.affiliateId))
    .where(and(eq(affiliateGroupMembers.tenantId, ctx.tenantId), eq(affiliateGroupMembers.groupId, groupId)))
    .orderBy(affiliates.name);
  return rows.map((r) => r.affiliate);
}

export async function groupIdsForAffiliate(db: DbLike, ctx: TenantContext, affiliateId: string): Promise<string[]> {
  const rows = await db.select({ groupId: affiliateGroupMembers.groupId }).from(affiliateGroupMembers).where(and(eq(affiliateGroupMembers.tenantId, ctx.tenantId), eq(affiliateGroupMembers.affiliateId, affiliateId)));
  return rows.map((r) => r.groupId);
}

export async function groupsForAffiliate(db: DbLike, ctx: TenantContext, affiliateId: string): Promise<AffiliateGroup[]> {
  const rows = await db
    .select({ group: affiliateGroups })
    .from(affiliateGroupMembers)
    .innerJoin(affiliateGroups, eq(affiliateGroups.id, affiliateGroupMembers.groupId))
    .where(and(eq(affiliateGroupMembers.tenantId, ctx.tenantId), eq(affiliateGroupMembers.affiliateId, affiliateId)));
  return rows.map((r) => r.group);
}

/** Affiliate ids that belong to any of the given groups. */
export async function memberIdsOfGroups(db: DbLike, ctx: TenantContext, groupIds: string[]): Promise<string[]> {
  if (!groupIds.length) return [];
  const rows = await db.select({ affiliateId: affiliateGroupMembers.affiliateId }).from(affiliateGroupMembers).where(and(eq(affiliateGroupMembers.tenantId, ctx.tenantId), inArray(affiliateGroupMembers.groupId, groupIds)));
  return [...new Set(rows.map((r) => r.affiliateId))];
}
