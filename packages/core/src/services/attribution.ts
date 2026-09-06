import { and, eq, inArray } from "drizzle-orm";
import type { DbLike } from "../db/client";
import {
  affiliatePrograms,
  affiliates,
  clicks,
  couponCodes,
  programOffers,
  programs,
  type AttributionCandidateRecord,
  type Click,
  type CouponCode,
  type Program,
} from "../db/schema";
import type { TenantContext } from "../context";
import { normalizeCode } from "./tracking";

/**
 * Attribution engine (PRD s11). Pure decision logic over stored facts: given the evidence that
 * arrived with a conversion (click tokens from the visitor's cookie, a coupon code from the
 * order), decide which affiliate earns it and record every candidate considered, eligible or
 * not, so the merchant can inspect why.
 *
 * Rules, in order:
 *  1. Coupon candidate: code resolves to an active coupon whose affiliate, membership and
 *     program are active and whose program includes the purchased offer.
 *  2. Click candidates: each token resolves to a click inside the program's attribution
 *     window from an active affiliate/membership/program that includes the offer.
 *     Among eligible clicks, the program's attribution model picks last (default) or first.
 *  3. If both a coupon and a click candidate are eligible, the coupon's program precedence
 *     decides (`coupon_wins` by default).
 *  4. Nothing eligible → unattributed.
 */

export type AttributionRule = "coupon" | "last_click" | "first_click" | "manual";

export interface AttributionInput {
  offerId: string | null;
  occurredAt: Date;
  clickTokens?: string[];
  couponCode?: string | null;
}

export interface AttributionDecision {
  affiliateId: string;
  programId: string;
  rule: AttributionRule;
  source: "link" | "coupon";
  clickId?: string;
  couponCodeId?: string;
  isTest: boolean;
  candidates: AttributionCandidateRecord[];
}

export interface AttributionResult {
  decision: AttributionDecision | null;
  candidates: AttributionCandidateRecord[];
}

interface Eligibility {
  eligible: boolean;
  reason?: string;
}

export async function resolveAttribution(db: DbLike, ctx: TenantContext, input: AttributionInput): Promise<AttributionResult> {
  const candidates: AttributionCandidateRecord[] = [];

  // --- coupon -------------------------------------------------------------
  let coupon: { row: CouponCode; program: Program } | null = null;
  if (input.couponCode?.trim()) {
    const row = await db.query.couponCodes.findFirst({
      where: and(eq(couponCodes.tenantId, ctx.tenantId), eq(couponCodes.codeNormalized, normalizeCode(input.couponCode))),
    });
    if (row) {
      const program = await db.query.programs.findFirst({ where: eq(programs.id, row.programId) });
      const elig = program ? await couponEligibility(db, ctx, row, program, input.offerId) : { eligible: false, reason: "program_missing" };
      candidates.push({
        rule: "coupon",
        affiliateId: row.affiliateId,
        programId: row.programId,
        evidenceId: row.id,
        occurredAt: input.occurredAt.toISOString(),
        eligible: elig.eligible,
        ineligibleReason: elig.reason,
      });
      if (elig.eligible && program) coupon = { row, program };
    } else {
      candidates.push({
        rule: "coupon",
        affiliateId: "",
        programId: "",
        evidenceId: `code:${normalizeCode(input.couponCode)}`,
        occurredAt: input.occurredAt.toISOString(),
        eligible: false,
        ineligibleReason: "code_unknown",
      });
    }
  }

  // --- clicks -------------------------------------------------------------
  const tokens = (input.clickTokens ?? []).filter(Boolean);
  const eligibleClicks: { click: Click; program: Program }[] = [];
  if (tokens.length) {
    const rows = await db
      .select()
      .from(clicks)
      .where(and(eq(clicks.tenantId, ctx.tenantId), inArray(clicks.clickToken, tokens)));
    for (const click of rows) {
      const program = await db.query.programs.findFirst({ where: eq(programs.id, click.programId) });
      const elig = program ? await clickEligibility(db, ctx, click, program, input) : { eligible: false, reason: "program_missing" };
      candidates.push({
        rule: "click",
        affiliateId: click.affiliateId,
        programId: click.programId,
        evidenceId: click.id,
        occurredAt: click.occurredAt.toISOString(),
        eligible: elig.eligible,
        ineligibleReason: elig.reason,
      });
      if (elig.eligible && program) eligibleClicks.push({ click, program });
    }
  }

  let chosenClick: { click: Click; program: Program; rule: "last_click" | "first_click" } | null = null;
  if (eligibleClicks.length) {
    eligibleClicks.sort((a, b) => a.click.occurredAt.getTime() - b.click.occurredAt.getTime());
    const latest = eligibleClicks[eligibleClicks.length - 1]!;
    // The model of the program that received the latest touch governs the choice.
    if (latest.program.attributionModel === "first_touch") chosenClick = { ...eligibleClicks[0]!, rule: "first_click" };
    else chosenClick = { ...latest, rule: "last_click" };
  }

  // --- precedence ---------------------------------------------------------
  let decision: AttributionDecision | null = null;
  if (coupon && chosenClick) {
    const couponWins = coupon.program.precedence !== "link_wins";
    decision = couponWins ? fromCoupon(coupon, candidates) : fromClick(chosenClick, candidates);
  } else if (coupon) decision = fromCoupon(coupon, candidates);
  else if (chosenClick) decision = fromClick(chosenClick, candidates);

  return { decision, candidates };
}

function fromCoupon(c: { row: CouponCode; program: Program }, candidates: AttributionCandidateRecord[]): AttributionDecision {
  return {
    affiliateId: c.row.affiliateId,
    programId: c.row.programId,
    rule: "coupon",
    source: "coupon",
    couponCodeId: c.row.id,
    isTest: c.program.testMode,
    candidates,
  };
}

function fromClick(c: { click: Click; program: Program; rule: "last_click" | "first_click" }, candidates: AttributionCandidateRecord[]): AttributionDecision {
  return {
    affiliateId: c.click.affiliateId,
    programId: c.click.programId,
    rule: c.rule,
    source: "link",
    clickId: c.click.id,
    isTest: c.click.isTest || c.program.testMode,
    candidates,
  };
}

async function couponEligibility(db: DbLike, ctx: TenantContext, coupon: CouponCode, program: Program, offerId: string | null): Promise<Eligibility> {
  if (coupon.status !== "active") return { eligible: false, reason: "coupon_disabled" };
  if (coupon.offerId && offerId && coupon.offerId !== offerId) return { eligible: false, reason: "coupon_offer_mismatch" };
  return commonEligibility(db, ctx, coupon.affiliateId, program, offerId);
}

async function clickEligibility(db: DbLike, ctx: TenantContext, click: Click, program: Program, input: AttributionInput): Promise<Eligibility> {
  const ageMs = input.occurredAt.getTime() - click.occurredAt.getTime();
  if (ageMs < 0) return { eligible: false, reason: "click_after_conversion" };
  if (ageMs > program.attributionWindowDays * 86_400_000) return { eligible: false, reason: "window_expired" };
  if (click.consentState === "denied") return { eligible: false, reason: "consent_denied" };
  return commonEligibility(db, ctx, click.affiliateId, program, input.offerId);
}

async function commonEligibility(db: DbLike, ctx: TenantContext, affiliateId: string, program: Program, offerId: string | null): Promise<Eligibility> {
  if (program.tenantId !== ctx.tenantId) return { eligible: false, reason: "tenant_mismatch" };
  if (program.status !== "active") return { eligible: false, reason: "program_inactive" };
  const affiliate = await db.query.affiliates.findFirst({ where: and(eq(affiliates.id, affiliateId), eq(affiliates.tenantId, ctx.tenantId)) });
  if (!affiliate) return { eligible: false, reason: "affiliate_missing" };
  if (affiliate.status !== "active") return { eligible: false, reason: `affiliate_${affiliate.status}` };
  const membership = await db.query.affiliatePrograms.findFirst({
    where: and(eq(affiliatePrograms.affiliateId, affiliateId), eq(affiliatePrograms.programId, program.id)),
  });
  if (!membership || membership.status !== "active") return { eligible: false, reason: "membership_inactive" };
  if (offerId) {
    const po = await db.query.programOffers.findFirst({ where: and(eq(programOffers.programId, program.id), eq(programOffers.offerId, offerId)) });
    if (!po || po.eligibilityStatus !== "eligible") return { eligible: false, reason: "offer_not_in_program" };
  }
  return { eligible: true };
}
