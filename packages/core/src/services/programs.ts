import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { offers, programOffers, programs, type Program, type ProgramOffer } from "../db/schema";
import { newId, newToken } from "../ids";
import { notFound, validation } from "../errors";
import { type TenantContext, require as requirePerm } from "../context";
import { writeAudit, snapshot } from "./audit";
import { emitEvent } from "./events";
import { PROGRAM_TRANSITIONS, assertTransition, type ProgramStatus } from "../statemachine";
import { percentToBps } from "../money";

const commissionShape = {
  commissionModel: z.enum(["percentage", "fixed"]).default("percentage"),
  /** Percent as a decimal number, e.g. 20 for 20%. Converted to basis points internally. */
  commissionPercent: z.number().min(0).max(100).optional(),
  commissionFixedMinor: z.number().int().min(0).optional(),
  commissionBasis: z.enum(["gross", "net", "eligible"]).default("gross"),
};

export const createProgramSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(5000).optional(),
    ...commissionShape,
    attributionModel: z.enum(["last_touch", "first_touch"]).default("last_touch"),
    attributionWindowDays: z.number().int().min(1).max(365).default(30),
    precedence: z.enum(["coupon_wins", "link_wins"]).default("coupon_wins"),
    approvalMode: z.enum(["manual", "auto", "invite_only"]).default("manual"),
    holdingDays: z.number().int().min(0).max(365).default(30),
    refundPolicy: z.enum(["full", "partial", "none"]).default("full"),
    termsText: z.string().max(20000).default(""),
    offerIds: z.array(z.string()).default([]),
    testMode: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.commissionModel === "percentage" && v.commissionPercent === undefined)
      ctx.addIssue({ code: "custom", message: "commissionPercent is required for percentage model", path: ["commissionPercent"] });
    if (v.commissionModel === "fixed" && v.commissionFixedMinor === undefined)
      ctx.addIssue({ code: "custom", message: "commissionFixedMinor is required for fixed model", path: ["commissionFixedMinor"] });
  });
export type CreateProgramInput = z.input<typeof createProgramSchema>;

export async function createProgram(db: DbLike, ctx: TenantContext, rawInput: CreateProgramInput): Promise<Program> {
  requirePerm(ctx, "programs.write");
  const input = createProgramSchema.parse(rawInput);
  const [row] = await db
    .insert(programs)
    .values({
      id: newId("program"),
      tenantId: ctx.tenantId,
      name: input.name,
      description: input.description ?? null,
      status: "draft",
      commissionModel: input.commissionModel,
      commissionRateBps: input.commissionPercent !== undefined ? percentToBps(input.commissionPercent) : 0,
      commissionFixedMinor: input.commissionFixedMinor ?? 0,
      commissionBasis: input.commissionBasis,
      attributionModel: input.attributionModel,
      attributionWindowDays: input.attributionWindowDays,
      precedence: input.precedence,
      approvalMode: input.approvalMode,
      holdingDays: input.holdingDays,
      refundPolicy: input.refundPolicy,
      termsVersion: 1,
      termsText: input.termsText,
      joinToken: newToken(12),
      testMode: input.testMode,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    })
    .returning();
  for (const offerId of input.offerIds) await attachOffer(db, ctx, row!.id, offerId);
  await writeAudit(db, ctx, { entityType: "program", entityId: row!.id, action: "created", after: snapshot(row!) });
  return row!;
}

export const updateProgramSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  commissionModel: z.enum(["percentage", "fixed"]).optional(),
  commissionPercent: z.number().min(0).max(100).optional(),
  commissionFixedMinor: z.number().int().min(0).optional(),
  commissionBasis: z.enum(["gross", "net", "eligible"]).optional(),
  attributionModel: z.enum(["last_touch", "first_touch"]).optional(),
  attributionWindowDays: z.number().int().min(1).max(365).optional(),
  precedence: z.enum(["coupon_wins", "link_wins"]).optional(),
  approvalMode: z.enum(["manual", "auto", "invite_only"]).optional(),
  holdingDays: z.number().int().min(0).max(365).optional(),
  refundPolicy: z.enum(["full", "partial", "none"]).optional(),
  /** Changing terms bumps termsVersion; affiliates must re-accept (PROG-09, AFF-05). */
  termsText: z.string().max(20000).optional(),
  testMode: z.boolean().optional(),
});

/**
 * Rule changes apply to future conversions only. Existing pending commissions keep the
 * calculation basis snapshotted at creation (PRD s22 "commission rate changes while old
 * conversions remain pending").
 */
export async function updateProgram(db: DbLike, ctx: TenantContext, programId: string, rawInput: z.input<typeof updateProgramSchema>, reason?: string): Promise<Program> {
  requirePerm(ctx, "programs.write");
  const input = updateProgramSchema.parse(rawInput);
  const before = await getProgram(db, ctx, programId);
  const { commissionPercent, termsText, ...rest } = input;
  const patch: Partial<Program> = { ...rest, updatedAt: ctx.now() };
  if (commissionPercent !== undefined) patch.commissionRateBps = percentToBps(commissionPercent);
  if (termsText !== undefined && termsText !== before.termsText) {
    patch.termsText = termsText;
    patch.termsVersion = before.termsVersion + 1;
  }
  const [after] = await db
    .update(programs)
    .set(patch)
    .where(and(eq(programs.id, programId), eq(programs.tenantId, ctx.tenantId)))
    .returning();
  await writeAudit(db, ctx, { entityType: "program", entityId: programId, action: "rules_updated", before: snapshot(before), after: snapshot(after!), reason });
  await emitEvent(db, ctx, "program.updated", { type: "program", id: programId }, { termsVersion: after!.termsVersion });
  return after!;
}

export async function setProgramStatus(db: DbLike, ctx: TenantContext, programId: string, status: ProgramStatus): Promise<Program> {
  requirePerm(ctx, "programs.write");
  const before = await getProgram(db, ctx, programId);
  assertTransition("program", PROGRAM_TRANSITIONS, before.status as ProgramStatus, status);
  if (status === "active") {
    const attached = await listProgramOffers(db, ctx, programId);
    if (attached.length === 0) throw validation("attach at least one offer before activating a program");
  }
  const [after] = await db
    .update(programs)
    .set({ status, updatedAt: ctx.now() })
    .where(and(eq(programs.id, programId), eq(programs.tenantId, ctx.tenantId)))
    .returning();
  await writeAudit(db, ctx, { entityType: "program", entityId: programId, action: `status:${status}`, before: { status: before.status }, after: { status } });
  if (status === "active") await emitEvent(db, ctx, "program.activated", { type: "program", id: programId });
  return after!;
}

export async function attachOffer(
  db: DbLike,
  ctx: TenantContext,
  programId: string,
  offerId: string,
  override: { commissionPercent?: number; commissionFixedMinor?: number } = {},
): Promise<ProgramOffer> {
  requirePerm(ctx, "programs.write");
  await getProgram(db, ctx, programId);
  const offer = await db.query.offers.findFirst({ where: and(eq(offers.id, offerId), eq(offers.tenantId, ctx.tenantId)) });
  if (!offer) throw notFound("offer", offerId);
  const [row] = await db
    .insert(programOffers)
    .values({
      tenantId: ctx.tenantId,
      programId,
      offerId,
      commissionRateBpsOverride: override.commissionPercent !== undefined ? percentToBps(override.commissionPercent) : null,
      commissionFixedMinorOverride: override.commissionFixedMinor ?? null,
      eligibilityStatus: "eligible",
      createdAt: ctx.now(),
    })
    .onConflictDoUpdate({
      target: [programOffers.programId, programOffers.offerId],
      set: {
        eligibilityStatus: "eligible",
        commissionRateBpsOverride: override.commissionPercent !== undefined ? percentToBps(override.commissionPercent) : null,
        commissionFixedMinorOverride: override.commissionFixedMinor ?? null,
      },
    })
    .returning();
  await writeAudit(db, ctx, { entityType: "program", entityId: programId, action: "offer_attached", after: { offerId, ...override } });
  return row!;
}

export async function detachOffer(db: DbLike, ctx: TenantContext, programId: string, offerId: string): Promise<void> {
  requirePerm(ctx, "programs.write");
  await db
    .update(programOffers)
    .set({ eligibilityStatus: "ineligible" })
    .where(and(eq(programOffers.tenantId, ctx.tenantId), eq(programOffers.programId, programId), eq(programOffers.offerId, offerId)));
  await writeAudit(db, ctx, { entityType: "program", entityId: programId, action: "offer_detached", after: { offerId } });
}

export async function listProgramOffers(db: DbLike, ctx: TenantContext, programId: string): Promise<ProgramOffer[]> {
  return db
    .select()
    .from(programOffers)
    .where(and(eq(programOffers.tenantId, ctx.tenantId), eq(programOffers.programId, programId), eq(programOffers.eligibilityStatus, "eligible")));
}

export async function getProgram(db: DbLike, ctx: TenantContext, programId: string): Promise<Program> {
  const row = await db.query.programs.findFirst({ where: and(eq(programs.id, programId), eq(programs.tenantId, ctx.tenantId)) });
  if (!row) throw notFound("program", programId);
  return row;
}

/** Public join page resolution: token is opaque and globally unique, so it also identifies the tenant. */
export async function getProgramByJoinToken(db: DbLike, token: string): Promise<Program | null> {
  return (await db.query.programs.findFirst({ where: eq(programs.joinToken, token) })) ?? null;
}

export async function listPrograms(db: DbLike, ctx: TenantContext, filter: { status?: ProgramStatus } = {}): Promise<Program[]> {
  return db
    .select()
    .from(programs)
    .where(and(eq(programs.tenantId, ctx.tenantId), filter.status ? eq(programs.status, filter.status) : undefined))
    .orderBy(desc(programs.createdAt));
}
