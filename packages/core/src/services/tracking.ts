import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { DbLike } from "../db/client";
import { affiliates, clicks, couponCodes, offers, programs, trackingLinks, type Click, type CouponCode, type TrackingLink } from "../db/schema";
import { newId, newToken } from "../ids";
import { conflict, notFound, validation } from "../errors";
import { type TenantContext, require as requirePerm, requireAffiliate } from "../context";
import { writeAudit } from "./audit";
import { getMembership } from "./affiliates";
import { getProgram, listProgramOffers } from "./programs";

// ---------------------------------------------------------------------------
// Tracking links (TRK-01)
// ---------------------------------------------------------------------------

export const createLinkSchema = z.object({
  affiliateId: z.string(),
  programId: z.string(),
  offerId: z.string(),
  label: z.string().max(60).optional(),
  /** Optional override; defaults to the offer's sales URL. Must stay on the same host. */
  destinationUrl: z.string().url().optional(),
});

export async function createTrackingLink(db: DbLike, ctx: TenantContext, rawInput: z.input<typeof createLinkSchema>): Promise<TrackingLink> {
  const input = createLinkSchema.parse(rawInput);
  requireAffiliate(ctx, input.affiliateId);
  const [affiliate, program, offer] = await Promise.all([
    db.query.affiliates.findFirst({ where: and(eq(affiliates.id, input.affiliateId), eq(affiliates.tenantId, ctx.tenantId)) }),
    getProgram(db, ctx, input.programId),
    db.query.offers.findFirst({ where: and(eq(offers.id, input.offerId), eq(offers.tenantId, ctx.tenantId)) }),
  ]);
  if (!affiliate) throw notFound("affiliate", input.affiliateId);
  if (!offer) throw notFound("offer", input.offerId);
  if (affiliate.status !== "active") throw validation("affiliate is not active");
  const membership = await getMembership(db, ctx, affiliate.id, program.id);
  if (!membership || membership.status !== "active") throw validation("affiliate is not an active member of this program");
  const eligible = (await listProgramOffers(db, ctx, program.id)).some((po) => po.offerId === offer.id);
  if (!eligible) throw validation("offer is not part of this program");

  const destination = input.destinationUrl ?? offer.salesUrl;
  if (input.destinationUrl && new URL(input.destinationUrl).host !== new URL(offer.salesUrl).host)
    throw validation("destination must stay on the offer's sales domain");

  const existing = await db.query.trackingLinks.findFirst({
    where: and(
      eq(trackingLinks.affiliateId, affiliate.id),
      eq(trackingLinks.programId, program.id),
      eq(trackingLinks.offerId, offer.id),
      input.label ? eq(trackingLinks.label, input.label) : sql`${trackingLinks.label} is null`,
    ),
  });
  if (existing) return existing;

  const [row] = await db
    .insert(trackingLinks)
    .values({
      id: newId("trackingLink"),
      tenantId: ctx.tenantId,
      affiliateId: affiliate.id,
      programId: program.id,
      offerId: offer.id,
      token: newToken(10),
      destinationUrl: destination,
      label: input.label ?? null,
      status: "active",
      createdAt: ctx.now(),
    })
    .returning();
  return row!;
}

export async function listTrackingLinks(db: DbLike, ctx: TenantContext, affiliateId: string): Promise<TrackingLink[]> {
  requireAffiliate(ctx, affiliateId);
  return db
    .select()
    .from(trackingLinks)
    .where(and(eq(trackingLinks.tenantId, ctx.tenantId), eq(trackingLinks.affiliateId, affiliateId)))
    .orderBy(desc(trackingLinks.createdAt));
}

/** Build the public URL for a link. `baseUrl` is the tracking host, e.g. https://go.example.com */
export function trackingUrl(baseUrl: string, link: Pick<TrackingLink, "token">): string {
  return `${baseUrl.replace(/\/$/, "")}/r/${link.token}`;
}

// ---------------------------------------------------------------------------
// Click capture (TRK-02, TRK-03)
// ---------------------------------------------------------------------------

export interface ClickContext {
  referrer?: string | null;
  userAgent?: string | null;
  ip?: string | null;
  country?: string | null;
  consentState?: "granted" | "denied" | "unknown" | "not_required";
}

export interface ClickResult {
  click: Click | null;
  link: TrackingLink;
  destinationUrl: string;
  /** Cookie TTL derived from the program's attribution window. */
  cookieMaxAgeSeconds: number;
  tracked: boolean;
  reason?: string;
}

/**
 * Public endpoint logic: resolve a link token, record the click, return where to redirect and
 * what token to store client-side. Tenant is derived from the link, never from the request.
 * The redirect always happens even when tracking is declined, so the visitor is never blocked.
 */
export async function recordClick(db: DbLike, token: string, context: ClickContext = {}, now = new Date()): Promise<ClickResult | null> {
  const link = await db.query.trackingLinks.findFirst({ where: eq(trackingLinks.token, token) });
  if (!link) return null;
  const [affiliate, program] = await Promise.all([
    db.query.affiliates.findFirst({ where: eq(affiliates.id, link.affiliateId) }),
    db.query.programs.findFirst({ where: eq(programs.id, link.programId) }),
  ]);
  if (!affiliate || !program) return null;
  const cookieMaxAgeSeconds = program.attributionWindowDays * 86_400;
  const base = { link, destinationUrl: link.destinationUrl, cookieMaxAgeSeconds };

  if (link.status !== "active") return { ...base, click: null, tracked: false, reason: "link_disabled" };
  if (affiliate.status !== "active") return { ...base, click: null, tracked: false, reason: "affiliate_inactive" };
  if (program.status !== "active") return { ...base, click: null, tracked: false, reason: "program_inactive" };
  if (context.consentState === "denied") return { ...base, click: null, tracked: false, reason: "consent_denied" };

  const [click] = await db
    .insert(clicks)
    .values({
      id: newId("click"),
      tenantId: link.tenantId,
      trackingLinkId: link.id,
      affiliateId: link.affiliateId,
      programId: link.programId,
      offerId: link.offerId,
      clickToken: newToken(16),
      consentState: context.consentState ?? "unknown",
      referrer: context.referrer?.slice(0, 2000) ?? null,
      userAgent: context.userAgent?.slice(0, 500) ?? null,
      ipHash: context.ip ? hashIp(context.ip, link.tenantId) : null,
      country: context.country ?? null,
      deviceType: detectDevice(context.userAgent),
      isTest: program.testMode,
      occurredAt: now,
    })
    .returning();
  await db.update(trackingLinks).set({ clickCount: sql`${trackingLinks.clickCount} + 1` }).where(eq(trackingLinks.id, link.id));
  return { ...base, click: click!, tracked: true };
}

/** IPs are stored only as a salted hash for duplicate/fraud analysis (CONV-06, s13). */
function hashIp(ip: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

function detectDevice(ua?: string | null): string | null {
  if (!ua) return null;
  if (/mobile|iphone|android.*mobile/i.test(ua)) return "mobile";
  if (/ipad|tablet|android/i.test(ua)) return "tablet";
  return "desktop";
}

export async function listClicks(db: DbLike, ctx: TenantContext, filter: { affiliateId?: string; limit?: number } = {}): Promise<Click[]> {
  if (filter.affiliateId) requireAffiliate(ctx, filter.affiliateId);
  else requirePerm(ctx, "read");
  return db
    .select()
    .from(clicks)
    .where(and(eq(clicks.tenantId, ctx.tenantId), filter.affiliateId ? eq(clicks.affiliateId, filter.affiliateId) : undefined))
    .orderBy(desc(clicks.occurredAt))
    .limit(filter.limit ?? 100);
}

// ---------------------------------------------------------------------------
// Coupon codes (TRK-05)
// ---------------------------------------------------------------------------

export const createCouponSchema = z.object({
  affiliateId: z.string(),
  programId: z.string(),
  offerId: z.string().optional(),
  code: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[A-Za-z0-9_-]+$/, "code may contain letters, numbers, - and _"),
  discount: z.object({ type: z.enum(["percentage", "fixed"]), value: z.number().min(0) }).optional(),
});

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

export async function createCouponCode(db: DbLike, ctx: TenantContext, rawInput: z.input<typeof createCouponSchema>): Promise<CouponCode> {
  requirePerm(ctx, "affiliates.write");
  const input = createCouponSchema.parse(rawInput);
  const program = await getProgram(db, ctx, input.programId);
  const membership = await getMembership(db, ctx, input.affiliateId, program.id);
  if (!membership) throw validation("affiliate is not a member of this program");
  const normalized = normalizeCode(input.code);
  const clash = await db.query.couponCodes.findFirst({ where: and(eq(couponCodes.tenantId, ctx.tenantId), eq(couponCodes.codeNormalized, normalized)) });
  if (clash) throw conflict(`code ${normalized} is already in use`);
  const [row] = await db
    .insert(couponCodes)
    .values({
      id: newId("couponCode"),
      tenantId: ctx.tenantId,
      affiliateId: input.affiliateId,
      programId: program.id,
      offerId: input.offerId ?? null,
      code: input.code,
      codeNormalized: normalized,
      discountRule: input.discount ?? null,
      status: "active",
      createdAt: ctx.now(),
    })
    .returning();
  await writeAudit(db, ctx, { entityType: "coupon_code", entityId: row!.id, action: "created", after: { code: normalized, affiliateId: input.affiliateId, programId: program.id } });
  return row!;
}

export async function findCouponByCode(db: DbLike, ctx: TenantContext, code: string): Promise<CouponCode | null> {
  return (
    (await db.query.couponCodes.findFirst({ where: and(eq(couponCodes.tenantId, ctx.tenantId), eq(couponCodes.codeNormalized, normalizeCode(code))) })) ?? null
  );
}

export async function listCouponCodes(db: DbLike, ctx: TenantContext, affiliateId: string): Promise<CouponCode[]> {
  requireAffiliate(ctx, affiliateId);
  return db.select().from(couponCodes).where(and(eq(couponCodes.tenantId, ctx.tenantId), eq(couponCodes.affiliateId, affiliateId)));
}

export async function setCouponStatus(db: DbLike, ctx: TenantContext, couponId: string, status: "active" | "disabled"): Promise<void> {
  requirePerm(ctx, "affiliates.write");
  await db.update(couponCodes).set({ status }).where(and(eq(couponCodes.id, couponId), eq(couponCodes.tenantId, ctx.tenantId)));
}
