import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { httpUrl } from "../urls";
import type { DbLike } from "../db/client";
import { offers, programOffers, type Offer } from "../db/schema";
import { newId } from "../ids";
import { notFound } from "../errors";
import { type TenantContext, require as requirePerm } from "../context";
import { writeAudit, snapshot } from "./audit";
import { OFFER_TRANSITIONS, assertTransition, type OfferStatus } from "../statemachine";

export const OFFER_TYPES = ["coaching", "course", "workshop", "event", "membership", "consulting", "custom"] as const;

export const createOfferSchema = z.object({
  name: z.string().min(1).max(200),
  shortDescription: z.string().max(1000).optional(),
  type: z.enum(OFFER_TYPES).default("custom"),
  priceMinor: z.number().int().min(0).default(0),
  currency: z.string().length(3).optional(),
  salesUrl: httpUrl,
  imageUrl: httpUrl.optional(),
  internalNotes: z.string().max(5000).optional(),
});
export type CreateOfferInput = z.input<typeof createOfferSchema>;

export async function createOffer(db: DbLike, ctx: TenantContext, rawInput: CreateOfferInput, tenantCurrency: string): Promise<Offer> {
  requirePerm(ctx, "offers.write");
  const input = createOfferSchema.parse(rawInput);
  const [row] = await db
    .insert(offers)
    .values({
      id: newId("offer"),
      tenantId: ctx.tenantId,
      name: input.name,
      shortDescription: input.shortDescription ?? null,
      type: input.type,
      priceMinor: input.priceMinor,
      currency: (input.currency ?? tenantCurrency).toUpperCase(),
      salesUrl: input.salesUrl,
      imageUrl: input.imageUrl ?? null,
      internalNotes: input.internalNotes ?? null,
      status: "draft",
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    })
    .returning();
  await writeAudit(db, ctx, { entityType: "offer", entityId: row!.id, action: "created", after: snapshot(row!) });
  return row!;
}

export const updateOfferSchema = createOfferSchema.partial();

export async function updateOffer(db: DbLike, ctx: TenantContext, offerId: string, rawInput: z.input<typeof updateOfferSchema>): Promise<Offer> {
  requirePerm(ctx, "offers.write");
  const input = updateOfferSchema.parse(rawInput);
  const before = await getOffer(db, ctx, offerId);
  const [after] = await db
    .update(offers)
    .set({ ...input, currency: input.currency?.toUpperCase(), updatedAt: ctx.now() })
    .where(and(eq(offers.id, offerId), eq(offers.tenantId, ctx.tenantId)))
    .returning();
  await writeAudit(db, ctx, { entityType: "offer", entityId: offerId, action: "updated", before: snapshot(before), after: snapshot(after!) });
  return after!;
}

export async function setOfferStatus(db: DbLike, ctx: TenantContext, offerId: string, status: OfferStatus): Promise<Offer> {
  requirePerm(ctx, "offers.write");
  const before = await getOffer(db, ctx, offerId);
  assertTransition("offer", OFFER_TRANSITIONS, before.status as OfferStatus, status);
  const [after] = await db
    .update(offers)
    .set({ status, updatedAt: ctx.now() })
    .where(and(eq(offers.id, offerId), eq(offers.tenantId, ctx.tenantId)))
    .returning();
  await writeAudit(db, ctx, { entityType: "offer", entityId: offerId, action: `status:${status}`, before: { status: before.status }, after: { status } });
  return after!;
}

export async function getOffer(db: DbLike, ctx: TenantContext, offerId: string): Promise<Offer> {
  const row = await db.query.offers.findFirst({ where: and(eq(offers.id, offerId), eq(offers.tenantId, ctx.tenantId)) });
  if (!row) throw notFound("offer", offerId);
  return row;
}

export async function listOffers(db: DbLike, ctx: TenantContext, filter: { status?: OfferStatus } = {}): Promise<Offer[]> {
  return db
    .select()
    .from(offers)
    .where(and(eq(offers.tenantId, ctx.tenantId), filter.status ? eq(offers.status, filter.status) : undefined))
    .orderBy(desc(offers.createdAt));
}

/** Offers an affiliate can promote through a given set of programs (OFF-04). */
export async function listOffersForPrograms(db: DbLike, ctx: TenantContext, programIds: string[]): Promise<(Offer & { programId: string })[]> {
  if (programIds.length === 0) return [];
  const rows = await db
    .select({ offer: offers, programId: programOffers.programId })
    .from(programOffers)
    .innerJoin(offers, eq(programOffers.offerId, offers.id))
    .where(
      and(
        eq(programOffers.tenantId, ctx.tenantId),
        inArray(programOffers.programId, programIds),
        eq(programOffers.eligibilityStatus, "eligible"),
        eq(offers.status, "active"),
      ),
    );
  return rows.map((r) => ({ ...r.offer, programId: r.programId }));
}
