import { and, count, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { withTx } from "../db/client";
import {
  affiliatePrograms,
  affiliates,
  assets,
  campaignAssets,
  campaignParticipants,
  campaigns,
  commissions,
  conversions,
  ledgerEntries,
  programOffers,
  programs,
  type Asset,
  type Campaign,
  type CampaignParticipant,
  type LedgerEntry,
} from "../db/schema";
import { newId } from "../ids";
import { invalidTransition, notFound, validation } from "../errors";
import { type TenantContext, require as requirePerm, requireAffiliate } from "../context";
import { writeAudit, snapshot } from "./audit";
import { emitEvent } from "./events";
import { writeLedger } from "./commissions";
import { assertFeature } from "./plans";

/**
 * Campaigns (PRD s4 "Campaign", AST-03..05, AN-05): a time-bound promotion inside a program.
 * A live campaign can override the commission for participating affiliates and pay a fixed
 * bonus once a threshold is reached. Participation is explicit: merchants invite affiliates,
 * affiliates accept in the portal, and only active participants get the override, the bonus
 * and the campaign's assets.
 */

export const CAMPAIGN_STATUSES = ["draft", "active", "ended", "cancelled"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
const TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = { draft: ["active", "cancelled"], active: ["ended", "cancelled"], ended: [], cancelled: [] };

export const bonusRuleSchema = z.object({
  metric: z.enum(["conversions", "revenue"]),
  /** Number of conversions, or revenue in minor units, that triggers the bonus. */
  threshold: z.number().int().positive(),
  bonusMinor: z.number().int().positive(),
});
export type BonusRule = z.infer<typeof bonusRuleSchema>;

const campaignFields = {
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  commissionPercent: z.number().min(0).max(100).nullable().optional(),
  commissionFixedMinor: z.number().int().min(0).nullable().optional(),
  /** Restrict to some of the program's offers; null or empty means every offer in the program. */
  offerIds: z.array(z.string()).nullable().optional(),
  bonusRule: bonusRuleSchema.nullable().optional(),
};

export const createCampaignSchema = z
  .object({ programId: z.string(), ...campaignFields })
  .refine((v) => v.endAt.getTime() > v.startAt.getTime(), { message: "endAt must be after startAt", path: ["endAt"] })
  .refine((v) => !(v.commissionPercent != null && v.commissionFixedMinor != null), { message: "choose a percentage or a fixed override, not both", path: ["commissionPercent"] });
export type CreateCampaignInput = z.input<typeof createCampaignSchema>;

export const updateCampaignSchema = z.object({ ...campaignFields }).partial();

export function isLive(c: Pick<Campaign, "status" | "startAt" | "endAt">, now: Date): boolean {
  return c.status === "active" && c.startAt.getTime() <= now.getTime() && c.endAt.getTime() >= now.getTime();
}

async function validateOffers(db: DbLike, ctx: TenantContext, programId: string, offerIds: string[] | null | undefined): Promise<string[] | null> {
  if (!offerIds || offerIds.length === 0) return null;
  const rows = await db.select({ offerId: programOffers.offerId }).from(programOffers).where(and(eq(programOffers.tenantId, ctx.tenantId), eq(programOffers.programId, programId)));
  const allowed = new Set(rows.map((r) => r.offerId));
  const bad = offerIds.filter((id) => !allowed.has(id));
  if (bad.length) throw validation("offers must belong to the campaign's program", { offerIds: bad });
  return [...new Set(offerIds)];
}

export async function createCampaign(db: DbLike, ctx: TenantContext, rawInput: CreateCampaignInput): Promise<Campaign> {
  requirePerm(ctx, "campaigns.write");
  const input = createCampaignSchema.parse(rawInput);
  await assertFeature(db, ctx, "campaigns");
  const program = await db.query.programs.findFirst({ where: and(eq(programs.id, input.programId), eq(programs.tenantId, ctx.tenantId)) });
  if (!program) throw notFound("program", input.programId);
  const offerIds = await validateOffers(db, ctx, program.id, input.offerIds);
  const [row] = await db
    .insert(campaigns)
    .values({
      id: newId("campaign"),
      tenantId: ctx.tenantId,
      programId: program.id,
      name: input.name,
      description: input.description ?? null,
      startAt: input.startAt,
      endAt: input.endAt,
      status: "draft",
      commissionRateBpsOverride: input.commissionPercent != null ? Math.round(input.commissionPercent * 100) : null,
      commissionFixedMinorOverride: input.commissionFixedMinor ?? null,
      offerIds,
      bonusRule: input.bonusRule ?? null,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    })
    .returning();
  await writeAudit(db, ctx, { entityType: "campaign", entityId: row!.id, action: "created", after: snapshot(row!) });
  return row!;
}

export async function updateCampaign(db: DbLike, ctx: TenantContext, campaignId: string, rawInput: z.input<typeof updateCampaignSchema>): Promise<Campaign> {
  requirePerm(ctx, "campaigns.write");
  const input = updateCampaignSchema.parse(rawInput);
  const before = await getCampaign(db, ctx, campaignId);
  if (before.status === "ended" || before.status === "cancelled") throw validation(`campaign is ${before.status} and cannot be edited`);
  const startAt = input.startAt ?? before.startAt;
  const endAt = input.endAt ?? before.endAt;
  if (endAt.getTime() <= startAt.getTime()) throw validation("endAt must be after startAt");
  if (input.commissionPercent != null && input.commissionFixedMinor != null) throw validation("choose a percentage or a fixed override, not both");
  const patch: Partial<Campaign> = { updatedAt: ctx.now(), startAt, endAt };
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.commissionPercent !== undefined) {
    patch.commissionRateBpsOverride = input.commissionPercent == null ? null : Math.round(input.commissionPercent * 100);
    if (input.commissionPercent != null) patch.commissionFixedMinorOverride = null;
  }
  if (input.commissionFixedMinor !== undefined) {
    patch.commissionFixedMinorOverride = input.commissionFixedMinor;
    if (input.commissionFixedMinor != null) patch.commissionRateBpsOverride = null;
  }
  if (input.offerIds !== undefined) patch.offerIds = await validateOffers(db, ctx, before.programId, input.offerIds);
  if (input.bonusRule !== undefined) patch.bonusRule = input.bonusRule;
  const [after] = await db.update(campaigns).set(patch).where(and(eq(campaigns.id, campaignId), eq(campaigns.tenantId, ctx.tenantId))).returning();
  await writeAudit(db, ctx, { entityType: "campaign", entityId: campaignId, action: "updated", before: snapshot(before), after: snapshot(after!) });
  return after!;
}

export async function setCampaignStatus(db: DbLike, ctx: TenantContext, campaignId: string, to: CampaignStatus, reason?: string): Promise<Campaign> {
  requirePerm(ctx, "campaigns.write");
  return withTx(db, async (tx) => {
    const before = await getCampaign(tx, ctx, campaignId);
    const from = before.status as CampaignStatus;
    if (!TRANSITIONS[from].includes(to)) throw invalidTransition("campaign", from, to);
    if (to === "active" && before.endAt.getTime() < ctx.now().getTime()) throw validation("campaign end date is in the past");
    const [after] = await tx.update(campaigns).set({ status: to, updatedAt: ctx.now() }).where(eq(campaigns.id, campaignId)).returning();
    await writeAudit(tx, ctx, { entityType: "campaign", entityId: campaignId, action: `status:${to}`, before: { status: from }, after: { status: to }, reason });
    if (to === "active") {
      await emitEvent(tx, ctx, "campaign.started", { type: "campaign", id: campaignId }, { programId: before.programId, campaignName: before.name });
      const invited = await tx.select().from(campaignParticipants).where(and(eq(campaignParticipants.campaignId, campaignId), inArray(campaignParticipants.status, ["invited", "active"])));
      for (const p of invited) await emitEvent(tx, ctx, "campaign.invited", { type: "campaign", id: campaignId }, { affiliateId: p.affiliateId, programId: before.programId, campaignName: before.name });
    }
    if (to === "ended") await emitEvent(tx, ctx, "campaign.ended", { type: "campaign", id: campaignId }, { programId: before.programId, campaignName: before.name });
    return after!;
  });
}

/** Called by the scheduler: active campaigns past their end date become `ended`. */
export async function endExpiredCampaigns(db: DbLike, ctx: TenantContext, now: Date = ctx.now()): Promise<number> {
  const due = await db.select({ id: campaigns.id }).from(campaigns).where(and(eq(campaigns.tenantId, ctx.tenantId), eq(campaigns.status, "active"), lte(campaigns.endAt, now)));
  for (const { id } of due) await setCampaignStatus(db, ctx, id, "ended", "end date reached");
  return due.length;
}

// ---------------------------------------------------------------------------
// Participation (AST-05)
// ---------------------------------------------------------------------------

export const inviteParticipantsSchema = z.object({ affiliateIds: z.array(z.string()).optional(), all: z.boolean().optional() }).refine((v) => v.all || (v.affiliateIds && v.affiliateIds.length > 0), { message: "give affiliateIds or all=true" });

export async function inviteParticipants(db: DbLike, ctx: TenantContext, campaignId: string, rawInput: z.input<typeof inviteParticipantsSchema>): Promise<CampaignParticipant[]> {
  requirePerm(ctx, "campaigns.write");
  const input = inviteParticipantsSchema.parse(rawInput);
  const campaign = await getCampaign(db, ctx, campaignId);
  if (campaign.status === "ended" || campaign.status === "cancelled") throw validation(`campaign is ${campaign.status}`);
  // eligible = active affiliates with an active membership in the campaign's program
  const eligible = await db
    .select({ affiliateId: affiliatePrograms.affiliateId })
    .from(affiliatePrograms)
    .innerJoin(affiliates, eq(affiliates.id, affiliatePrograms.affiliateId))
    .where(
      and(
        eq(affiliatePrograms.tenantId, ctx.tenantId),
        eq(affiliatePrograms.programId, campaign.programId),
        eq(affiliatePrograms.status, "active"),
        eq(affiliates.status, "active"),
        input.all ? undefined : inArray(affiliatePrograms.affiliateId, input.affiliateIds ?? []),
      ),
    );
  const ids = [...new Set(eligible.map((e) => e.affiliateId))];
  if (!input.all) {
    const missing = (input.affiliateIds ?? []).filter((id) => !ids.includes(id));
    if (missing.length) throw validation("some affiliates are not active members of the campaign's program", { affiliateIds: missing });
  }
  if (!ids.length) return [];
  const existing = await db.select({ affiliateId: campaignParticipants.affiliateId }).from(campaignParticipants).where(and(eq(campaignParticipants.campaignId, campaignId), inArray(campaignParticipants.affiliateId, ids)));
  const known = new Set(existing.map((e) => e.affiliateId));
  const fresh = ids.filter((id) => !known.has(id));
  if (!fresh.length) return [];
  return withTx(db, async (tx) => {
    const rows = await tx
      .insert(campaignParticipants)
      .values(fresh.map((affiliateId) => ({ id: newId("campaignParticipant"), tenantId: ctx.tenantId, campaignId, affiliateId, status: "invited", invitedAt: ctx.now() })))
      .returning();
    await writeAudit(tx, ctx, { entityType: "campaign", entityId: campaignId, action: "participants_invited", after: { affiliateIds: fresh } });
    if (campaign.status === "active") for (const p of rows) await emitEvent(tx, ctx, "campaign.invited", { type: "campaign", id: campaignId }, { affiliateId: p.affiliateId, programId: campaign.programId, campaignName: campaign.name });
    return rows;
  });
}

/** Portal: an invited affiliate accepts and becomes an active participant. */
export async function joinCampaign(db: DbLike, ctx: TenantContext, campaignId: string, affiliateId: string): Promise<CampaignParticipant> {
  requireAffiliate(ctx, affiliateId);
  const campaign = await getCampaign(db, ctx, campaignId);
  if (campaign.status !== "active") throw validation(`campaign is ${campaign.status}`);
  if (campaign.endAt.getTime() < ctx.now().getTime()) throw validation("campaign has ended");
  const participant = await db.query.campaignParticipants.findFirst({ where: and(eq(campaignParticipants.campaignId, campaignId), eq(campaignParticipants.affiliateId, affiliateId)) });
  if (!participant) throw notFound("campaign invitation");
  if (participant.status === "active") return participant;
  const [after] = await db.update(campaignParticipants).set({ status: "active", joinedAt: ctx.now() }).where(eq(campaignParticipants.id, participant.id)).returning();
  await writeAudit(db, ctx, { entityType: "campaign", entityId: campaignId, action: "participant_joined", after: { affiliateId } });
  return after!;
}

export async function removeParticipant(db: DbLike, ctx: TenantContext, campaignId: string, affiliateId: string): Promise<void> {
  requirePerm(ctx, "campaigns.write");
  await getCampaign(db, ctx, campaignId);
  await db.delete(campaignParticipants).where(and(eq(campaignParticipants.tenantId, ctx.tenantId), eq(campaignParticipants.campaignId, campaignId), eq(campaignParticipants.affiliateId, affiliateId)));
  await writeAudit(db, ctx, { entityType: "campaign", entityId: campaignId, action: "participant_removed", after: { affiliateId } });
}

// ---------------------------------------------------------------------------
// Assets (AST-04)
// ---------------------------------------------------------------------------

export async function setCampaignAssets(db: DbLike, ctx: TenantContext, campaignId: string, assetIds: string[]): Promise<string[]> {
  requirePerm(ctx, "campaigns.write");
  await getCampaign(db, ctx, campaignId);
  const ids = [...new Set(assetIds)];
  if (ids.length) {
    const found = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.tenantId, ctx.tenantId), inArray(assets.id, ids)));
    const missing = ids.filter((id) => !found.some((f) => f.id === id));
    if (missing.length) throw validation("unknown assets", { assetIds: missing });
  }
  await withTx(db, async (tx) => {
    await tx.delete(campaignAssets).where(and(eq(campaignAssets.tenantId, ctx.tenantId), eq(campaignAssets.campaignId, campaignId)));
    if (ids.length) await tx.insert(campaignAssets).values(ids.map((assetId) => ({ id: newId("campaignAsset"), tenantId: ctx.tenantId, campaignId, assetId })));
    await writeAudit(tx, ctx, { entityType: "campaign", entityId: campaignId, action: "assets_set", after: { assetIds: ids } });
  });
  return ids;
}

/** Asset ids an affiliate may see because they are an active participant in a live campaign. */
export async function campaignAssetIdsForAffiliate(db: DbLike, ctx: TenantContext, affiliateId: string, now: Date = ctx.now()): Promise<string[]> {
  const rows = await db
    .select({ assetId: campaignAssets.assetId })
    .from(campaignAssets)
    .innerJoin(campaigns, eq(campaigns.id, campaignAssets.campaignId))
    .innerJoin(campaignParticipants, and(eq(campaignParticipants.campaignId, campaigns.id), eq(campaignParticipants.affiliateId, affiliateId)))
    .where(and(eq(campaignAssets.tenantId, ctx.tenantId), eq(campaigns.status, "active"), lte(campaigns.startAt, now), gte(campaigns.endAt, now), eq(campaignParticipants.status, "active")));
  return [...new Set(rows.map((r) => r.assetId))];
}

// ---------------------------------------------------------------------------
// Commission integration (called inside the conversion transaction)
// ---------------------------------------------------------------------------

/** The live campaign, if any, that applies to this affiliate/program/offer at `at`. Latest start wins. */
export async function findLiveCampaign(db: DbLike, ctx: TenantContext, args: { programId: string; affiliateId: string; offerId: string | null; at: Date }): Promise<Campaign | null> {
  const rows = await db
    .select({ campaign: campaigns })
    .from(campaigns)
    .innerJoin(campaignParticipants, and(eq(campaignParticipants.campaignId, campaigns.id), eq(campaignParticipants.affiliateId, args.affiliateId), eq(campaignParticipants.status, "active")))
    .where(and(eq(campaigns.tenantId, ctx.tenantId), eq(campaigns.programId, args.programId), eq(campaigns.status, "active"), lte(campaigns.startAt, args.at), gte(campaigns.endAt, args.at)))
    .orderBy(desc(campaigns.startAt));
  for (const { campaign } of rows) {
    const offers = campaign.offerIds;
    if (!offers || offers.length === 0 || (args.offerId && offers.includes(args.offerId))) return campaign;
  }
  return null;
}

/**
 * Awards the campaign bonus once per participant when the threshold is met. Counts only
 * conversions attributed to this campaign that are not cancelled or reversed. Idempotent.
 */
export async function evaluateBonus(db: DbLike, ctx: TenantContext, campaign: Campaign, affiliateId: string, currency: string): Promise<LedgerEntry | null> {
  const rule = campaign.bonusRule;
  if (!rule) return null;
  const participant = await db.query.campaignParticipants.findFirst({ where: and(eq(campaignParticipants.campaignId, campaign.id), eq(campaignParticipants.affiliateId, affiliateId)) });
  if (!participant || participant.bonusAwardedAt) return null;
  const [agg] = await db
    .select({ n: count(), revenue: sql<number>`coalesce(sum(${conversions.amountMinor} - ${conversions.refundedAmountMinor}), 0)` })
    .from(conversions)
    .where(and(eq(conversions.tenantId, ctx.tenantId), eq(conversions.campaignId, campaign.id), eq(conversions.affiliateId, affiliateId), sql`${conversions.status} not in ('cancelled', 'reversed')`, eq(conversions.isTest, false)));
  const value = rule.metric === "conversions" ? agg!.n : Number(agg!.revenue);
  if (value < rule.threshold) return null;
  const entry = await writeLedger(db, ctx, { affiliateId, type: "adjustment", amountMinor: rule.bonusMinor, currency, reason: `campaign bonus: ${campaign.name}` });
  await db.update(campaignParticipants).set({ bonusAwardedAt: ctx.now(), bonusLedgerEntryId: entry.id }).where(eq(campaignParticipants.id, participant.id));
  await writeAudit(db, ctx, { entityType: "campaign", entityId: campaign.id, action: "bonus_awarded", after: { affiliateId, amountMinor: rule.bonusMinor, metric: rule.metric, value } });
  await emitEvent(db, ctx, "commission.adjusted", { type: "ledger_entry", id: entry.id }, { affiliateId, deltaMinor: rule.bonusMinor, currency, reason: `campaign bonus: ${campaign.name}` });
  return entry;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getCampaign(db: DbLike, ctx: TenantContext, campaignId: string): Promise<Campaign> {
  const row = await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, campaignId), eq(campaigns.tenantId, ctx.tenantId)) });
  if (!row) throw notFound("campaign", campaignId);
  return row;
}

export interface CampaignPerformance {
  participants: { invited: number; active: number };
  conversions: number;
  revenueMinor: number;
  commissionMinor: number;
  bonusesMinor: number;
}

export async function campaignPerformance(db: DbLike, ctx: TenantContext, campaignId: string): Promise<CampaignPerformance> {
  const [parts, [conv], [comm], [bonus]] = await Promise.all([
    db.select({ status: campaignParticipants.status, n: count() }).from(campaignParticipants).where(and(eq(campaignParticipants.tenantId, ctx.tenantId), eq(campaignParticipants.campaignId, campaignId))).groupBy(campaignParticipants.status),
    db
      .select({ n: count(), revenue: sql<number>`coalesce(sum(${conversions.amountMinor} - ${conversions.refundedAmountMinor}), 0)` })
      .from(conversions)
      .where(and(eq(conversions.tenantId, ctx.tenantId), eq(conversions.campaignId, campaignId), sql`${conversions.status} not in ('cancelled', 'reversed')`, eq(conversions.isTest, false))),
    db
      .select({ total: sql<number>`coalesce(sum(${commissions.amountMinor}), 0)` })
      .from(commissions)
      .where(and(eq(commissions.tenantId, ctx.tenantId), eq(commissions.campaignId, campaignId), sql`${commissions.status} not in ('reversed', 'void')`)),
    db
      .select({ total: sql<number>`coalesce(sum(${ledgerEntries.amountMinor}), 0)` })
      .from(ledgerEntries)
      .innerJoin(campaignParticipants, eq(campaignParticipants.bonusLedgerEntryId, ledgerEntries.id))
      .where(and(eq(ledgerEntries.tenantId, ctx.tenantId), eq(campaignParticipants.campaignId, campaignId))),
  ]);
  const invited = parts.find((p) => p.status === "invited")?.n ?? 0;
  const active = parts.find((p) => p.status === "active")?.n ?? 0;
  return { participants: { invited: invited + active, active }, conversions: conv!.n, revenueMinor: Number(conv!.revenue), commissionMinor: Number(comm!.total), bonusesMinor: Number(bonus!.total) };
}

export async function listCampaigns(db: DbLike, ctx: TenantContext, filter: { programId?: string; status?: CampaignStatus } = {}) {
  requirePerm(ctx, "read");
  const rows = await db
    .select({ campaign: campaigns, programName: programs.name })
    .from(campaigns)
    .innerJoin(programs, eq(programs.id, campaigns.programId))
    .where(and(eq(campaigns.tenantId, ctx.tenantId), filter.programId ? eq(campaigns.programId, filter.programId) : undefined, filter.status ? eq(campaigns.status, filter.status) : undefined))
    .orderBy(desc(campaigns.startAt));
  const out = [];
  for (const r of rows) out.push({ ...r.campaign, programName: r.programName, live: isLive(r.campaign, ctx.now()), performance: await campaignPerformance(db, ctx, r.campaign.id) });
  return out;
}

export async function getCampaignDetail(db: DbLike, ctx: TenantContext, campaignId: string) {
  requirePerm(ctx, "read");
  const campaign = await getCampaign(db, ctx, campaignId);
  const [program, participants, assetRows, performance] = await Promise.all([
    db.query.programs.findFirst({ where: eq(programs.id, campaign.programId) }),
    db
      .select({ participant: campaignParticipants, name: affiliates.name, email: affiliates.email })
      .from(campaignParticipants)
      .innerJoin(affiliates, eq(affiliates.id, campaignParticipants.affiliateId))
      .where(and(eq(campaignParticipants.tenantId, ctx.tenantId), eq(campaignParticipants.campaignId, campaignId)))
      .orderBy(desc(campaignParticipants.invitedAt)),
    db.select({ asset: assets }).from(campaignAssets).innerJoin(assets, eq(assets.id, campaignAssets.assetId)).where(and(eq(campaignAssets.tenantId, ctx.tenantId), eq(campaignAssets.campaignId, campaignId))),
    campaignPerformance(db, ctx, campaignId),
  ]);
  return {
    campaign: { ...campaign, live: isLive(campaign, ctx.now()) },
    program: program ? { id: program.id, name: program.name, commissionModel: program.commissionModel, commissionPercent: program.commissionRateBps / 100, commissionFixedMinor: program.commissionFixedMinor } : null,
    participants: participants.map((p) => ({ ...p.participant, name: p.name, email: p.email })),
    assets: assetRows.map((a) => a.asset),
    performance,
  };
}

/** Portal view: campaigns the affiliate is invited to or active in, that have not ended. */
export async function listCampaignsForAffiliate(db: DbLike, ctx: TenantContext, affiliateId: string, now: Date = ctx.now()) {
  requireAffiliate(ctx, affiliateId);
  const rows = await db
    .select({ campaign: campaigns, participant: campaignParticipants, programName: programs.name })
    .from(campaignParticipants)
    .innerJoin(campaigns, eq(campaigns.id, campaignParticipants.campaignId))
    .innerJoin(programs, eq(programs.id, campaigns.programId))
    .where(and(eq(campaignParticipants.tenantId, ctx.tenantId), eq(campaignParticipants.affiliateId, affiliateId), eq(campaigns.status, "active"), gte(campaigns.endAt, now)))
    .orderBy(desc(campaigns.startAt));
  const out = [];
  for (const r of rows) {
    const assetRows: Asset[] = r.participant.status === "active" ? (await db.select({ asset: assets }).from(campaignAssets).innerJoin(assets, eq(assets.id, campaignAssets.assetId)).where(and(eq(campaignAssets.campaignId, r.campaign.id), eq(assets.status, "active")))).map((a) => a.asset) : [];
    let progress: { metric: BonusRule["metric"]; value: number; threshold: number; bonusMinor: number; awarded: boolean } | null = null;
    if (r.campaign.bonusRule) {
      const [agg] = await db
        .select({ n: count(), revenue: sql<number>`coalesce(sum(${conversions.amountMinor} - ${conversions.refundedAmountMinor}), 0)` })
        .from(conversions)
        .where(and(eq(conversions.tenantId, ctx.tenantId), eq(conversions.campaignId, r.campaign.id), eq(conversions.affiliateId, affiliateId), sql`${conversions.status} not in ('cancelled', 'reversed')`, eq(conversions.isTest, false)));
      progress = { metric: r.campaign.bonusRule.metric, value: r.campaign.bonusRule.metric === "conversions" ? agg!.n : Number(agg!.revenue), threshold: r.campaign.bonusRule.threshold, bonusMinor: r.campaign.bonusRule.bonusMinor, awarded: !!r.participant.bonusAwardedAt };
    }
    out.push({
      campaign: {
        id: r.campaign.id,
        name: r.campaign.name,
        description: r.campaign.description,
        startAt: r.campaign.startAt,
        endAt: r.campaign.endAt,
        live: isLive(r.campaign, now),
        commissionPercent: r.campaign.commissionRateBpsOverride != null ? r.campaign.commissionRateBpsOverride / 100 : null,
        commissionFixedMinor: r.campaign.commissionFixedMinorOverride,
        offerIds: r.campaign.offerIds,
      },
      program: { id: r.campaign.programId, name: r.programName },
      participantStatus: r.participant.status,
      assets: assetRows,
      progress,
    });
  }
  return out;
}
