import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { httpUrl } from "../urls";
import type { DbLike } from "../db/client";
import { withTx } from "../db/client";
import { affiliatePrograms, affiliates, assetPermissions, assets, programOffers, programs, tenants, type Asset, type AssetPermission } from "../db/schema";
import { listOffersForPrograms } from "./offers";
import { createTrackingLink, listCouponCodes, listTrackingLinks, trackingUrl } from "./tracking";
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

/**
 * Merge fields for copy and guideline assets. Merchants write `{{link}}` once; every affiliate
 * sees the text with their own tracking link, coupon and name filled in, ready to paste.
 */
export const COPY_VARIABLES = [
  { key: "link", label: "Affiliate's tracking link", description: "Their unique link for this asset's offer (or their first link). Created on first view if they have none." },
  { key: "coupon_code", label: "Affiliate's coupon code", description: "Their active coupon code, if they have one." },
  { key: "affiliate_name", label: "Affiliate's name", description: "As they signed up." },
  { key: "business_name", label: "Your business name", description: "From Settings." },
  { key: "offer_name", label: "Offer name", description: "The asset's offer, or the first offer they can promote." },
  { key: "offer_url", label: "Offer page (untracked)", description: "The offer's public sales URL without tracking." },
  { key: "commission", label: "Their commission", description: "For example 20% or 15.00 USD, from the program they promote." },
  { key: "portal_url", label: "Portal link", description: "Where they sign in." },
] as const;
export type CopyVariable = (typeof COPY_VARIABLES)[number]["key"];
const COPY_VARIABLE_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Replace known `{{variables}}`; unknown ones are left in place so a typo is visible rather than silently blank. */
export function renderCopy(text: string, vars: Partial<Record<CopyVariable, string | null | undefined>>): string {
  return text.replace(COPY_VARIABLE_RE, (m, name: string) => {
    if (!COPY_VARIABLES.some((v) => v.key === name)) return m;
    const v = vars[name as CopyVariable];
    return v == null ? "" : String(v);
  });
}

export function copyVariablesUsed(text: string): CopyVariable[] {
  const out = new Set<CopyVariable>();
  for (const m of text.matchAll(COPY_VARIABLE_RE)) if (COPY_VARIABLES.some((v) => v.key === m[1])) out.add(m[1] as CopyVariable);
  return [...out];
}

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
    url: httpUrl.optional(),
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
  url: httpUrl.nullable().optional(),
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
export interface PersonaliseOptions {
  baseUrl: string;
  webUrl: string;
}

/**
 * Fill the merge fields of every text asset for one affiliate. Looks up their links, coupons
 * and programs once; creates a tracking link for their first eligible offer when they have
 * none yet, so `{{link}}` is never empty for an active affiliate.
 */
export async function personaliseAssets(db: DbLike, ctx: TenantContext, affiliateId: string, rows: Asset[], opts: PersonaliseOptions): Promise<(Asset & { renderedBody: string | null; variablesUsed: CopyVariable[] })[]> {
  requireAffiliate(ctx, affiliateId);
  const textAssets = rows.filter((a) => a.body && copyVariablesUsed(a.body).length > 0);
  if (textAssets.length === 0) return rows.map((a) => ({ ...a, renderedBody: a.body, variablesUsed: [] }));

  const [affiliate, tenant, memberships] = await Promise.all([
    db.query.affiliates.findFirst({ where: and(eq(affiliates.id, affiliateId), eq(affiliates.tenantId, ctx.tenantId)) }),
    db.query.tenants.findFirst({ where: eq(tenants.id, ctx.tenantId) }),
    db.select({ programId: affiliatePrograms.programId }).from(affiliatePrograms).where(and(eq(affiliatePrograms.tenantId, ctx.tenantId), eq(affiliatePrograms.affiliateId, affiliateId), eq(affiliatePrograms.status, "active"))),
  ]);
  if (!affiliate || !tenant) return rows.map((a) => ({ ...a, renderedBody: a.body, variablesUsed: [] }));
  const programIds = memberships.map((m) => m.programId);
  const programRows = programIds.length ? await db.select().from(programs).where(and(eq(programs.tenantId, ctx.tenantId), inArray(programs.id, programIds))) : [];
  const offerRows = programIds.length ? await listOffersForPrograms(db, ctx, programIds) : [];
  let links = await listTrackingLinks(db, ctx, affiliateId);
  const coupons = (await listCouponCodes(db, ctx, affiliateId)).filter((c) => c.status === "active");
  const perms = textAssets.some((a) => a.visibility === "restricted") ? await db.select().from(assetPermissions).where(inArray(assetPermissions.assetId, textAssets.map((a) => a.id))) : [];

  // A link for the first eligible offer, created once if the affiliate has none at all.
  if (links.length === 0 && offerRows[0]) {
    const first = offerRows[0];
    links = [await createTrackingLink(db, ctx, { affiliateId, programId: first.programId, offerId: first.id })];
  }
  const commissionOf = (programId: string | null | undefined) => {
    const p = programRows.find((x) => x.id === programId) ?? programRows[0];
    if (!p) return "";
    return p.commissionModel === "percentage" ? `${p.commissionRateBps / 100}%` : `${(p.commissionFixedMinor / 100).toFixed(2)} ${tenant.currency}`;
  };

  return rows.map((a) => {
    if (!a.body || !textAssets.includes(a)) return { ...a, renderedBody: a.body, variablesUsed: [] };
    const scopedOffer = perms.find((p) => p.assetId === a.id && p.offerId)?.offerId ?? null;
    const link = (scopedOffer ? links.find((l) => l.offerId === scopedOffer) : null) ?? links[0] ?? null;
    const offer = offerRows.find((o) => o.id === (scopedOffer ?? link?.offerId)) ?? offerRows[0] ?? null;
    const vars: Partial<Record<CopyVariable, string | null>> = {
      link: link ? trackingUrl(opts.baseUrl, link) : null,
      coupon_code: coupons[0]?.code ?? null,
      affiliate_name: affiliate.name,
      business_name: tenant.name,
      offer_name: offer?.name ?? null,
      offer_url: offer?.salesUrl ?? null,
      commission: commissionOf(link?.programId ?? offer?.programId),
      portal_url: `${opts.webUrl.replace(/\/$/, "")}/portal`,
    };
    return { ...a, renderedBody: renderCopy(a.body, vars), variablesUsed: copyVariablesUsed(a.body) };
  });
}

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
