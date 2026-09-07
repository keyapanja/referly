import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { withTx } from "../db/client";
import { affiliatePrograms, assetPermissions, assets, programOffers, type Asset, type AssetPermission } from "../db/schema";
import { newId } from "../ids";
import { notFound } from "../errors";
import { type TenantContext, require as requirePerm, requireAffiliate } from "../context";
import { writeAudit, snapshot } from "./audit";
import { campaignAssetIdsForAffiliate } from "./campaigns";
import { groupIdsForAffiliate } from "./groups";

/**
 * Asset library (AST-01, AST-02). Assets are links to hosted files or inline copy. Visibility
 * is either `all` (every active affiliate) or `restricted`, in which case an affiliate sees
 * the asset only if a permission row matches one of their active programs, an offer in those
 * programs, or the affiliate directly.
 */

export const ASSET_TYPES = ["image", "banner", "pdf", "video", "copy", "link", "guideline"] as const;

const permissionShape = {
  programIds: z.array(z.string()).default([]),
  offerIds: z.array(z.string()).default([]),
  affiliateIds: z.array(z.string()).default([]),
  groupIds: z.array(z.string()).default([]),
};

export const createAssetSchema = z
  .object({
    type: z.enum(ASSET_TYPES),
    title: z.string().min(1).max(200),
    url: z.string().url().optional(),
    body: z.string().max(20000).optional(),
    usageInstructions: z.string().max(5000).optional(),
    visibility: z.enum(["all", "restricted"]).default("all"),
    /** Set by the upload endpoint when the file lives in platform storage. */
    storageKey: z.string().max(500).optional(),
    contentType: z.string().max(100).optional(),
    sizeBytes: z.number().int().min(0).optional(),
    ...permissionShape,
  })
  .superRefine((v, ctx) => {
    if (!v.url && !v.body) ctx.addIssue({ code: "custom", message: "provide a url or body", path: ["url"] });
    if (v.visibility === "restricted" && !v.programIds.length && !v.offerIds.length && !v.affiliateIds.length && !v.groupIds.length)
      ctx.addIssue({ code: "custom", message: "restricted assets need at least one program, offer or affiliate", path: ["visibility"] });
  });
export type CreateAssetInput = z.input<typeof createAssetSchema>;

export async function createAsset(db: DbLike, ctx: TenantContext, rawInput: CreateAssetInput): Promise<Asset> {
  requirePerm(ctx, "assets.write");
  const input = createAssetSchema.parse(rawInput);
  return withTx(db, async (tx) => {
    const [row] = await tx
      .insert(assets)
      .values({
        id: newId("asset"),
        tenantId: ctx.tenantId,
        type: input.type,
        title: input.title,
        url: input.url ?? null,
        body: input.body ?? null,
        storageKey: input.storageKey ?? null,
        contentType: input.contentType ?? null,
        sizeBytes: input.sizeBytes ?? null,
        usageInstructions: input.usageInstructions ?? null,
        status: "active",
        visibility: input.visibility,
        createdAt: ctx.now(),
      })
      .returning();
    await replacePermissions(tx, ctx, row!.id, input);
    await writeAudit(tx, ctx, { entityType: "asset", entityId: row!.id, action: "created", after: snapshot(row!) });
    return row!;
  });
}

export const updateAssetSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  url: z.string().url().nullable().optional(),
  body: z.string().max(20000).nullable().optional(),
  usageInstructions: z.string().max(5000).nullable().optional(),
  visibility: z.enum(["all", "restricted"]).optional(),
  status: z.enum(["active", "archived"]).optional(),
});

export async function updateAsset(db: DbLike, ctx: TenantContext, assetId: string, rawInput: z.input<typeof updateAssetSchema>): Promise<Asset> {
  requirePerm(ctx, "assets.write");
  const input = updateAssetSchema.parse(rawInput);
  const before = await getAsset(db, ctx, assetId);
  const [after] = await db
    .update(assets)
    .set(input)
    .where(and(eq(assets.id, assetId), eq(assets.tenantId, ctx.tenantId)))
    .returning();
  await writeAudit(db, ctx, { entityType: "asset", entityId: assetId, action: "updated", before: snapshot(before), after: snapshot(after!) });
  return after!;
}

export const permissionsSchema = z.object(permissionShape);

/** Replaces the whole permission set for an asset (AST-02). */
export async function setAssetPermissions(db: DbLike, ctx: TenantContext, assetId: string, rawInput: z.input<typeof permissionsSchema>): Promise<AssetPermission[]> {
  requirePerm(ctx, "assets.write");
  const input = permissionsSchema.parse(rawInput);
  await getAsset(db, ctx, assetId);
  return withTx(db, async (tx) => {
    const rows = await replacePermissions(tx, ctx, assetId, input);
    const restricted = rows.length > 0;
    await tx.update(assets).set({ visibility: restricted ? "restricted" : "all" }).where(eq(assets.id, assetId));
    await writeAudit(tx, ctx, { entityType: "asset", entityId: assetId, action: "permissions_set", after: input });
    return rows;
  });
}

async function replacePermissions(db: DbLike, ctx: TenantContext, assetId: string, input: { programIds: string[]; offerIds: string[]; affiliateIds: string[]; groupIds: string[] }): Promise<AssetPermission[]> {
  await db.delete(assetPermissions).where(and(eq(assetPermissions.assetId, assetId), eq(assetPermissions.tenantId, ctx.tenantId)));
  const values = [
    ...input.programIds.map((programId) => ({ programId })),
    ...input.offerIds.map((offerId) => ({ offerId })),
    ...input.affiliateIds.map((affiliateId) => ({ affiliateId })),
    ...input.groupIds.map((groupId) => ({ groupId })),
  ].map((v) => ({ id: newId("assetPermission"), tenantId: ctx.tenantId, assetId, ...v }));
  if (!values.length) return [];
  return db.insert(assetPermissions).values(values).returning();
}

export async function getAsset(db: DbLike, ctx: TenantContext, assetId: string): Promise<Asset> {
  const row = await db.query.assets.findFirst({ where: and(eq(assets.id, assetId), eq(assets.tenantId, ctx.tenantId)) });
  if (!row) throw notFound("asset", assetId);
  return row;
}

export async function listAssets(db: DbLike, ctx: TenantContext, filter: { includeArchived?: boolean } = {}): Promise<(Asset & { permissions: AssetPermission[] })[]> {
  requirePerm(ctx, "read");
  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.tenantId, ctx.tenantId), filter.includeArchived ? undefined : eq(assets.status, "active")))
    .orderBy(desc(assets.createdAt));
  const perms = rows.length ? await db.select().from(assetPermissions).where(inArray(assetPermissions.assetId, rows.map((r) => r.id))) : [];
  return rows.map((a) => ({ ...a, permissions: perms.filter((p) => p.assetId === a.id) }));
}

/** Portal view: only what this affiliate is allowed to see. */
export async function listAssetsForAffiliate(db: DbLike, ctx: TenantContext, affiliateId: string): Promise<Asset[]> {
  requireAffiliate(ctx, affiliateId);
  const memberships = await db
    .select({ programId: affiliatePrograms.programId })
    .from(affiliatePrograms)
    .where(and(eq(affiliatePrograms.tenantId, ctx.tenantId), eq(affiliatePrograms.affiliateId, affiliateId), eq(affiliatePrograms.status, "active")));
  const programIds = memberships.map((m) => m.programId);
  const offerRows = programIds.length
    ? await db
        .select({ offerId: programOffers.offerId })
        .from(programOffers)
        .where(and(eq(programOffers.tenantId, ctx.tenantId), inArray(programOffers.programId, programIds), eq(programOffers.eligibilityStatus, "eligible")))
    : [];
  const offerIds = new Set(offerRows.map((o) => o.offerId));
  const programSet = new Set(programIds);
  const groupSet = new Set(await groupIdsForAffiliate(db, ctx, affiliateId));

  const all = await db
    .select()
    .from(assets)
    .where(and(eq(assets.tenantId, ctx.tenantId), eq(assets.status, "active")))
    .orderBy(desc(assets.createdAt));
  if (programIds.length === 0) return all.filter((a) => a.visibility === "all" && false); // no active program: nothing to promote yet
  const restricted = all.filter((a) => a.visibility === "restricted");
  const perms = restricted.length ? await db.select().from(assetPermissions).where(inArray(assetPermissions.assetId, restricted.map((a) => a.id))) : [];
  const allowed = new Set(
    perms
      .filter((p) => (p.programId && programSet.has(p.programId)) || (p.offerId && offerIds.has(p.offerId)) || p.affiliateId === affiliateId || (p.groupId && groupSet.has(p.groupId)))
      .map((p) => p.assetId),
  );
  // AST-04: assets attached to a live campaign the affiliate has joined.
  for (const id of await campaignAssetIdsForAffiliate(db, ctx, affiliateId)) allowed.add(id);
  return all.filter((a) => a.visibility === "all" || allowed.has(a.id));
}
