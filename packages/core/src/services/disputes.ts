import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { withTx } from "../db/client";
import { affiliates, conversions, disputeComments, disputes, type Dispute, type DisputeComment } from "../db/schema";
import { newId } from "../ids";
import { conflict, forbidden, notFound, validation } from "../errors";
import { type TenantContext, require as requirePerm, requireAffiliate, systemContext } from "../context";
import { writeAudit, snapshot } from "./audit";
import { emitEvent } from "./events";
import * as conversionsSvc from "./conversions";
import { createTask } from "./automation";

/**
 * Disputes (Phase 2): a contested sale or attribution claim with a lifecycle, a conversation
 * and a concrete outcome. Opening a dispute on a linked sale holds its commission (the sale
 * moves to `disputed`, which settlement skips); resolving restores, cancels or reattributes it.
 */

export const DISPUTE_KINDS = ["attribution", "amount", "fraud", "refund", "other"] as const;
export type DisputeKind = (typeof DISPUTE_KINDS)[number];
export const DISPUTE_STATUSES = ["open", "under_review", "resolved", "withdrawn"] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
const AFFILIATE_KINDS: DisputeKind[] = ["attribution", "amount", "other"];
const MERCHANT_KINDS: DisputeKind[] = ["fraud", "refund", "amount", "other"];

export const openDisputeSchema = z.object({
  kind: z.enum(DISPUTE_KINDS),
  conversionId: z.string().optional(),
  /** Affiliate-side attribution claims reference an order the merchant can look up. */
  orderReference: z.string().max(200).optional(),
  reason: z.string().min(5).max(2000),
});
export type OpenDisputeInput = z.input<typeof openDisputeSchema>;

const OPEN_STATES: DisputeStatus[] = ["open", "under_review"];

function isOpen(d: Dispute) {
  return OPEN_STATES.includes(d.status as DisputeStatus);
}

async function holdConversion(db: DbLike, ctx: TenantContext, conversionId: string, reason: string): Promise<string> {
  const conv = await conversionsSvc.getConversion(db, ctx, conversionId);
  if (conv.status === "pending" || conv.status === "approved") {
    await conversionsSvc.disputeConversion(db, systemContext(ctx.tenantId, ctx.now), conversionId, reason);
  }
  return conv.status;
}

async function releaseConversion(db: DbLike, ctx: TenantContext, dispute: Dispute, reason: string): Promise<void> {
  if (!dispute.conversionId) return;
  const conv = await conversionsSvc.getConversion(db, ctx, dispute.conversionId);
  if (conv.status !== "disputed") return;
  const to = dispute.previousConversionStatus === "approved" ? "approved" : "pending";
  await conversionsSvc.restoreDisputedConversion(db, systemContext(ctx.tenantId, ctx.now), dispute.conversionId, to, reason);
}

export async function openDispute(db: DbLike, ctx: TenantContext, rawInput: OpenDisputeInput): Promise<Dispute> {
  const input = openDisputeSchema.parse(rawInput);
  const byAffiliate = ctx.actor.type === "affiliate";
  let affiliateId: string | null = null;
  let conversionId: string | null = null;
  let previousStatus: string | null = null;

  if (byAffiliate) {
    affiliateId = ctx.actor.affiliateId!;
    if (!AFFILIATE_KINDS.includes(input.kind)) throw validation(`affiliates can open ${AFFILIATE_KINDS.join(", ")} disputes`);
    if (input.conversionId) {
      const conv = await conversionsSvc.getConversion(db, ctx, input.conversionId);
      if (conv.affiliateId !== affiliateId) throw notFound("conversion", input.conversionId);
      conversionId = conv.id;
    } else if (input.kind !== "attribution" || !input.orderReference?.trim()) {
      throw validation("give the sale you are disputing, or an order reference for a missing attribution");
    }
  } else {
    requirePerm(ctx, "conversions.write");
    if (!MERCHANT_KINDS.includes(input.kind)) throw validation(`merchants can open ${MERCHANT_KINDS.join(", ")} disputes`);
    if (!input.conversionId) throw validation("conversionId is required");
    const conv = await conversionsSvc.getConversion(db, ctx, input.conversionId);
    if (!conv.affiliateId) throw validation("this sale is not attributed to an affiliate, so there is nothing to dispute");
    conversionId = conv.id;
    affiliateId = conv.affiliateId;
  }

  if (conversionId) {
    const existing = await db.query.disputes.findFirst({ where: and(eq(disputes.tenantId, ctx.tenantId), eq(disputes.conversionId, conversionId), inArray(disputes.status, OPEN_STATES)) });
    if (existing) throw conflict("this sale already has an open dispute", { disputeId: existing.id });
  }

  return withTx(db, async (tx) => {
    if (conversionId) previousStatus = await holdConversion(tx, ctx, conversionId, `dispute opened: ${input.reason.slice(0, 120)}`);
    const [row] = await tx
      .insert(disputes)
      .values({
        id: newId("dispute"),
        tenantId: ctx.tenantId,
        conversionId,
        affiliateId,
        raisedBy: byAffiliate ? "affiliate" : "merchant",
        raisedByUserId: ctx.actor.type === "user" ? (ctx.actor.id ?? null) : null,
        kind: input.kind,
        orderReference: input.orderReference?.trim() || null,
        reason: input.reason.trim(),
        status: "open",
        previousConversionStatus: previousStatus,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      })
      .returning();
    await writeAudit(tx, ctx, { entityType: "dispute", entityId: row!.id, action: "opened", after: snapshot(row!) });
    if (byAffiliate) await createTask(tx, ctx, { title: `Review dispute from affiliate: ${input.kind}`, note: input.reason.slice(0, 300), entityType: "dispute", entityId: row!.id, affiliateId });
    await emitEvent(tx, ctx, "dispute.opened", { type: "dispute", id: row!.id }, { affiliateId, conversionId, kind: input.kind, raisedBy: row!.raisedBy, reason: byAffiliate ? `We received your ${input.kind} dispute and will review it: ${input.reason}` : `A sale attributed to you is under review: ${input.reason}` });
    return row!;
  });
}

export async function addComment(db: DbLike, ctx: TenantContext, disputeId: string, body: string): Promise<DisputeComment> {
  const dispute = await getDispute(db, ctx, disputeId);
  if (!isOpen(dispute)) throw validation(`dispute is ${dispute.status}`);
  const byAffiliate = ctx.actor.type === "affiliate";
  if (byAffiliate) {
    if (dispute.affiliateId !== ctx.actor.affiliateId) throw notFound("dispute", disputeId);
  } else requirePerm(ctx, "conversions.write");
  const text = body.trim();
  if (!text) throw validation("comment cannot be empty");
  const [row] = await db
    .insert(disputeComments)
    .values({ id: newId("disputeComment"), tenantId: ctx.tenantId, disputeId, authorType: byAffiliate ? "affiliate" : "merchant", authorId: ctx.actor.id ?? null, body: text, createdAt: ctx.now() })
    .returning();
  await db.update(disputes).set({ updatedAt: ctx.now() }).where(eq(disputes.id, disputeId));
  if (byAffiliate) await createTask(db, ctx, { title: "Affiliate replied on a dispute", note: text.slice(0, 300), entityType: "dispute", entityId: disputeId, affiliateId: dispute.affiliateId });
  else await emitEvent(db, ctx, "dispute.commented", { type: "dispute", id: disputeId }, { affiliateId: dispute.affiliateId, conversionId: dispute.conversionId, reason: text });
  return row!;
}

export async function startReview(db: DbLike, ctx: TenantContext, disputeId: string): Promise<Dispute> {
  requirePerm(ctx, "conversions.write");
  const before = await getDispute(db, ctx, disputeId);
  if (before.status !== "open") throw validation(`dispute is ${before.status}`);
  const [after] = await db.update(disputes).set({ status: "under_review", updatedAt: ctx.now() }).where(eq(disputes.id, disputeId)).returning();
  await writeAudit(db, ctx, { entityType: "dispute", entityId: disputeId, action: "status:under_review", before: { status: before.status }, after: { status: "under_review" } });
  return after!;
}

/** Attach the sale an affiliate's attribution claim is about; holds it like a merchant-raised dispute would. */
export async function linkConversion(db: DbLike, ctx: TenantContext, disputeId: string, conversionId: string): Promise<Dispute> {
  requirePerm(ctx, "conversions.write");
  const before = await getDispute(db, ctx, disputeId);
  if (!isOpen(before)) throw validation(`dispute is ${before.status}`);
  if (before.conversionId) throw validation("dispute is already linked to a sale");
  const clash = await db.query.disputes.findFirst({ where: and(eq(disputes.tenantId, ctx.tenantId), eq(disputes.conversionId, conversionId), inArray(disputes.status, OPEN_STATES)) });
  if (clash) throw conflict("that sale already has an open dispute", { disputeId: clash.id });
  return withTx(db, async (tx) => {
    const previous = await holdConversion(tx, ctx, conversionId, `linked to dispute ${disputeId}`);
    const [after] = await tx.update(disputes).set({ conversionId, previousConversionStatus: previous, updatedAt: ctx.now() }).where(eq(disputes.id, disputeId)).returning();
    await writeAudit(tx, ctx, { entityType: "dispute", entityId: disputeId, action: "linked", after: { conversionId } });
    return after!;
  });
}

export const resolveSchema = z
  .object({
    resolution: z.enum(["upheld", "rejected"]),
    outcome: z.enum(["restore", "cancel", "reattribute"]).default("restore"),
    note: z.string().min(1).max(2000),
    reattributeTo: z.object({ affiliateId: z.string(), programId: z.string() }).optional(),
  })
  .refine((v) => v.outcome !== "reattribute" || !!v.reattributeTo, { message: "reattributeTo is required", path: ["reattributeTo"] });

export async function resolveDispute(db: DbLike, ctx: TenantContext, disputeId: string, rawInput: z.input<typeof resolveSchema>): Promise<Dispute> {
  requirePerm(ctx, "conversions.write");
  const input = resolveSchema.parse(rawInput);
  const before = await getDispute(db, ctx, disputeId);
  if (!isOpen(before)) throw validation(`dispute is ${before.status}`);
  if (input.outcome !== "restore" && !before.conversionId) throw validation("link the sale before cancelling or reattributing it");
  return withTx(db, async (tx) => {
    const reason = `dispute ${disputeId} ${input.resolution}: ${input.note}`;
    if (input.outcome === "cancel") {
      // disputed → cancelled is a direct transition; releasing first would land on approved, which cannot be cancelled
      await conversionsSvc.cancelConversion(tx, ctx, before.conversionId!, reason);
    } else if (input.outcome === "reattribute") {
      await releaseConversion(tx, ctx, before, reason);
      await conversionsSvc.reattributeConversion(tx, ctx, { conversionId: before.conversionId!, affiliateId: input.reattributeTo!.affiliateId, programId: input.reattributeTo!.programId, reason });
    } else {
      await releaseConversion(tx, ctx, before, reason);
    }
    const [after] = await tx
      .update(disputes)
      .set({ status: "resolved", resolution: input.resolution, outcome: input.outcome, resolutionNote: input.note, resolvedByUserId: ctx.actor.type === "user" ? (ctx.actor.id ?? null) : null, resolvedAt: ctx.now(), updatedAt: ctx.now() })
      .where(eq(disputes.id, disputeId))
      .returning();
    await tx.insert(disputeComments).values({ id: newId("disputeComment"), tenantId: ctx.tenantId, disputeId, authorType: "system", authorId: null, body: `Resolved as ${input.resolution} (${input.outcome}). ${input.note}`, createdAt: ctx.now() });
    await writeAudit(tx, ctx, { entityType: "dispute", entityId: disputeId, action: "resolved", before: { status: before.status }, after: { status: "resolved", resolution: input.resolution, outcome: input.outcome }, reason: input.note });
    await emitEvent(tx, ctx, "dispute.resolved", { type: "dispute", id: disputeId }, { affiliateId: before.affiliateId, conversionId: before.conversionId, resolution: input.resolution, outcome: input.outcome, reason: `Your dispute was ${input.resolution}. ${input.note}` });
    return after!;
  });
}

export async function withdrawDispute(db: DbLike, ctx: TenantContext, disputeId: string): Promise<Dispute> {
  const before = await getDispute(db, ctx, disputeId);
  if (ctx.actor.type === "affiliate") {
    if (before.affiliateId !== ctx.actor.affiliateId || before.raisedBy !== "affiliate") throw forbidden("only the affiliate who raised a dispute can withdraw it");
  } else requirePerm(ctx, "conversions.write");
  if (!isOpen(before)) throw validation(`dispute is ${before.status}`);
  return withTx(db, async (tx) => {
    await releaseConversion(tx, ctx, before, `dispute ${disputeId} withdrawn`);
    const [after] = await tx.update(disputes).set({ status: "withdrawn", resolvedAt: ctx.now(), updatedAt: ctx.now() }).where(eq(disputes.id, disputeId)).returning();
    await writeAudit(tx, ctx, { entityType: "dispute", entityId: disputeId, action: "withdrawn", before: { status: before.status }, after: { status: "withdrawn" } });
    await emitEvent(tx, ctx, "dispute.withdrawn", { type: "dispute", id: disputeId }, { affiliateId: before.affiliateId, conversionId: before.conversionId });
    return after!;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getDispute(db: DbLike, ctx: TenantContext, disputeId: string): Promise<Dispute> {
  const row = await db.query.disputes.findFirst({ where: and(eq(disputes.id, disputeId), eq(disputes.tenantId, ctx.tenantId)) });
  if (!row) throw notFound("dispute", disputeId);
  return row;
}

const openFirst = sql`case when ${disputes.status} in ('open', 'under_review') then 0 else 1 end`;

export async function listDisputes(db: DbLike, ctx: TenantContext, filter: { status?: DisputeStatus; affiliateId?: string; limit?: number } = {}) {
  requirePerm(ctx, "read");
  const rows = await db
    .select({ dispute: disputes, affiliateName: affiliates.name, conversion: { id: conversions.id, externalOrderId: conversions.externalOrderId, amountMinor: conversions.amountMinor, currency: conversions.currency, status: conversions.status } })
    .from(disputes)
    .leftJoin(affiliates, eq(affiliates.id, disputes.affiliateId))
    .leftJoin(conversions, eq(conversions.id, disputes.conversionId))
    .where(and(eq(disputes.tenantId, ctx.tenantId), filter.status ? eq(disputes.status, filter.status) : undefined, filter.affiliateId ? eq(disputes.affiliateId, filter.affiliateId) : undefined))
    .orderBy(asc(openFirst), desc(disputes.createdAt))
    .limit(filter.limit ?? 200);
  return rows.map((r) => ({ ...r.dispute, affiliateName: r.affiliateName, conversion: r.conversion?.id ? r.conversion : null }));
}

export async function getDisputeDetail(db: DbLike, ctx: TenantContext, disputeId: string) {
  requirePerm(ctx, "read");
  const dispute = await getDispute(db, ctx, disputeId);
  const [affiliate, conversion, comments] = await Promise.all([
    dispute.affiliateId ? db.query.affiliates.findFirst({ where: eq(affiliates.id, dispute.affiliateId) }) : null,
    dispute.conversionId ? conversionsSvc.getConversion(db, ctx, dispute.conversionId) : null,
    db.select().from(disputeComments).where(eq(disputeComments.disputeId, disputeId)).orderBy(asc(disputeComments.createdAt)),
  ]);
  const commission = conversion ? await conversionsSvc.currentCommission(db, conversion.id) : null;
  return { dispute, affiliate: affiliate ? { id: affiliate.id, name: affiliate.name, email: affiliate.email } : null, conversion, commission, comments };
}

export async function countOpenDisputes(db: DbLike, ctx: TenantContext): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(disputes).where(and(eq(disputes.tenantId, ctx.tenantId), inArray(disputes.status, OPEN_STATES)));
  return row!.n;
}

/** Portal: the affiliate's own disputes. */
export async function listDisputesForAffiliate(db: DbLike, ctx: TenantContext, affiliateId: string) {
  requireAffiliate(ctx, affiliateId);
  const rows = await db
    .select({ dispute: disputes, conversion: { id: conversions.id, externalOrderId: conversions.externalOrderId, amountMinor: conversions.amountMinor, currency: conversions.currency, status: conversions.status } })
    .from(disputes)
    .leftJoin(conversions, eq(conversions.id, disputes.conversionId))
    .where(and(eq(disputes.tenantId, ctx.tenantId), eq(disputes.affiliateId, affiliateId)))
    .orderBy(asc(openFirst), desc(disputes.createdAt));
  return rows.map((r) => ({ ...r.dispute, conversion: r.conversion?.id ? r.conversion : null }));
}

export async function getDisputeForAffiliate(db: DbLike, ctx: TenantContext, affiliateId: string, disputeId: string) {
  requireAffiliate(ctx, affiliateId);
  const dispute = await getDispute(db, ctx, disputeId);
  if (dispute.affiliateId !== affiliateId) throw notFound("dispute", disputeId);
  const comments = await db.select().from(disputeComments).where(eq(disputeComments.disputeId, disputeId)).orderBy(asc(disputeComments.createdAt));
  return { dispute, comments };
}
